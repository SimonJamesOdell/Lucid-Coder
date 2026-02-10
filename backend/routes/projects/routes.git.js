import fs from 'fs/promises';
import path from 'path';
import {
  deleteProjectGitSettings,
  getGitSettings,
  getProject,
  getProjectGitSettings,
  getGitSettingsToken,
  saveProjectGitSettings
} from '../../database.js';
import { validateGitSettingsPayload } from '../settings.js';
import { createRemoteRepository, RemoteRepoCreationError } from '../../services/remoteRepoService.js';
import { initializeAndPushRepository } from '../../services/projectScaffolding/git.js';
import {
  ensureGitRepository,
  discardWorkingTree,
  fetchRemote,
  getAheadBehind,
  getCurrentBranch,
  getRemoteUrl,
  hasWorkingTreeChanges,
  popBranchStash,
  runGitCommand,
  stashWorkingTree
} from '../../utils/git.js';
import { requireDestructiveConfirmation } from './internals.js';

const SUPPORTED_REMOTE_PROVIDERS = ['github', 'gitlab'];

const IGNORE_RULES = [
  {
    pattern: 'node_modules/',
    matches: (candidate) => candidate === 'node_modules'
      || candidate.startsWith('node_modules/')
      || candidate.includes('/node_modules/')
  },
  {
    pattern: 'venv/',
    matches: (candidate) => candidate === 'venv'
      || candidate.startsWith('venv/')
      || candidate.includes('/venv/')
  },
  {
    pattern: '.venv/',
    matches: (candidate) => candidate === '.venv'
      || candidate.startsWith('.venv/')
      || candidate.includes('/.venv/')
  },
  {
    pattern: '__pycache__/',
    matches: (candidate) => candidate === '__pycache__'
      || candidate.startsWith('__pycache__/')
      || candidate.includes('/__pycache__/')
  },
  {
    pattern: 'dist/',
    matches: (candidate) => candidate === 'dist'
      || candidate.startsWith('dist/')
      || candidate.includes('/dist/')
  },
  {
    pattern: 'build/',
    matches: (candidate) => candidate === 'build'
      || candidate.startsWith('build/')
      || candidate.includes('/build/')
  }
];

const getRepoRoot = async (projectPath) => {
  const result = await runGitCommand(projectPath, ['rev-parse', '--show-toplevel']);
  const root = typeof result?.stdout === 'string' ? result.stdout.trim() : '';
  return root || projectPath;
};

const normalizeGitIgnoreLine = (line) => {
  const trimmed = typeof line === 'string' ? line.trim() : '';
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }
  return trimmed;
};

const loadGitIgnore = async (repoRoot) => {
  const gitignorePath = path.join(repoRoot, '.gitignore');
  try {
    const content = await fs.readFile(gitignorePath, 'utf8');
    const entries = content
      .split(/\r?\n/)
      .map(normalizeGitIgnoreLine)
      .filter(Boolean);
    return { gitignorePath, content, entries };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { gitignorePath, content: '', entries: [] };
    }
    throw error;
  }
};

const buildGitIgnoreSuggestion = async (projectPath) => {
  const { stdout } = await runGitCommand(projectPath, ['status', '--porcelain']);
  const lines = typeof stdout === 'string' ? stdout.split(/\r?\n/) : [];
  const untracked = lines
    .filter((line) => line.startsWith('?? '))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);

  if (untracked.length === 0) {
    return { needed: false, entries: [], detected: [], samplePaths: [] };
  }

  const repoRoot = await getRepoRoot(projectPath);
  const gitignore = await loadGitIgnore(repoRoot);
  const existing = new Set(gitignore.entries);

  const detected = [];
  const entries = [];
  for (const rule of IGNORE_RULES) {
    if (!untracked.some((candidate) => rule.matches(candidate))) {
      continue;
    }
    detected.push(rule.pattern);
    if (!existing.has(rule.pattern)) {
      entries.push(rule.pattern);
    }
  }

  return {
    needed: entries.length > 0,
    entries,
    detected,
    samplePaths: untracked.slice(0, 6)
  };
};

const applyGitIgnoreEntries = async (projectPath, entries) => {
  const repoRoot = await getRepoRoot(projectPath);
  const gitignore = await loadGitIgnore(repoRoot);
  const existing = new Set(gitignore.entries);
  const nextEntries = entries
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry && !/[\r\n\0]/.test(entry));

  const additions = nextEntries.filter((entry) => !existing.has(entry));
  if (additions.length === 0) {
    return { applied: false, gitignorePath: gitignore.gitignorePath, additions: [] };
  }

  const prefix = gitignore.content && !gitignore.content.endsWith('\n') ? '\n' : '';
  const updated = `${gitignore.content}${prefix}${additions.join('\n')}\n`;
  await fs.writeFile(gitignore.gitignorePath, updated, 'utf8');

  return { applied: true, gitignorePath: gitignore.gitignorePath, additions };
};

const commitGitIgnoreChanges = async (projectPath, message) => {
  const repoRoot = await getRepoRoot(projectPath);
  await runGitCommand(repoRoot, ['add', '.gitignore']);
  try {
    await runGitCommand(repoRoot, ['commit', '-m', message]);
    return true;
  } catch (error) {
    if (/nothing to commit/i.test(error?.message || '')) {
      return false;
    }
    throw error;
  }
};

export const __gitRoutesTesting = {
  applyGitIgnoreEntries,
  commitGitIgnoreChanges,
  loadGitIgnore,
  getRepoRoot,
  normalizeGitIgnoreLine,
  buildGitIgnoreSuggestion
};

export function registerProjectGitRoutes(router) {
  const resolveEffectiveSettings = async (projectId) => {
    const projectSettings = await getProjectGitSettings(projectId).catch(() => null);
    if (projectSettings) {
      return projectSettings;
    }
    return getGitSettings();
  };

  const normalizeRemoteUrl = (value) => (typeof value === 'string' ? value.trim() : '');

  const ensureRemoteOrigin = async (projectPath, settings) => {
    const configuredRemote = normalizeRemoteUrl(settings?.remoteUrl);
    const existing = await getRemoteUrl(projectPath, 'origin');
    if (existing) {
      return existing;
    }
    if (!configuredRemote || settings?.workflow !== 'cloud') {
      return null;
    }

    try {
      await runGitCommand(projectPath, ['remote', 'add', 'origin', configuredRemote]);
      return configuredRemote;
    } catch (error) {
      try {
        await runGitCommand(projectPath, ['remote', 'set-url', 'origin', configuredRemote]);
        return configuredRemote;
      } catch {
        throw error;
      }
    }
  };

  const buildGitStatus = async ({ project, branchName, settings }) => {
    if (!project?.path) {
      return {
        branch: branchName,
        currentBranch: null,
        ahead: 0,
        behind: 0,
        dirty: false,
        hasRemote: false,
        remoteUrl: null,
        error: 'Project path is not configured.'
      };
    }

    await ensureGitRepository(project.path, { defaultBranch: branchName });

    const [currentBranch, remoteInfo, dirty] = await Promise.all([
      getCurrentBranch(project.path).catch(() => null),
      (async () => {
        try {
          const remoteUrl = await ensureRemoteOrigin(project.path, settings);
          return { remoteUrl, error: null };
        } catch (error) {
          return { remoteUrl: null, error: error?.message || 'Failed to configure remote origin.' };
        }
      })(),
      hasWorkingTreeChanges(project.path).catch(() => false)
    ]);

    const remoteUrl = remoteInfo?.remoteUrl || null;
    const remoteError = remoteInfo?.error || null;

    if (!remoteUrl) {
      return {
        branch: branchName,
        currentBranch,
        ahead: 0,
        behind: 0,
        dirty,
        hasRemote: false,
        remoteUrl: null,
        error: remoteError
      };
    }

    const { ahead, behind, error } = await getAheadBehind(project.path, branchName, 'origin');

    return {
      branch: branchName,
      currentBranch,
      ahead,
      behind,
      dirty,
      hasRemote: true,
      remoteUrl,
      error: error || null
    };
  };

  router.get('/:projectId/git/status', async (req, res) => {
    try {
      const { projectId } = req.params;
      const project = await getProject(projectId);

      if (!project) {
        return res.status(404).json({ success: false, error: 'Project not found' });
      }

      const settings = await resolveEffectiveSettings(projectId);
      const branchName = settings?.defaultBranch || 'main';
      const status = await buildGitStatus({ project, branchName, settings });

      res.json({ success: true, status });
    } catch (error) {
      console.error('Error fetching git status:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch git status' });
    }
  });

  router.get('/:projectId/git/ignore-suggestions', async (req, res) => {
    try {
      const { projectId } = req.params;
      const project = await getProject(projectId);

      if (!project) {
        return res.status(404).json({ success: false, error: 'Project not found' });
      }

      if (!project.path) {
        return res.status(400).json({ success: false, error: 'Project path is not configured.' });
      }

      const settings = await resolveEffectiveSettings(projectId);
      const branchName = settings?.defaultBranch || 'main';
      await ensureGitRepository(project.path, { defaultBranch: branchName });

      const suggestion = await buildGitIgnoreSuggestion(project.path);
      res.json({ success: true, suggestion });
    } catch (error) {
      console.error('Error building gitignore suggestions:', error);
      res.status(500).json({ success: false, error: 'Failed to build gitignore suggestions' });
    }
  });

  router.post('/:projectId/git/ignore-fix', async (req, res) => {
    try {
      const { projectId } = req.params;
      const project = await getProject(projectId);

      if (!project) {
        return res.status(404).json({ success: false, error: 'Project not found' });
      }

      if (!project.path) {
        return res.status(400).json({ success: false, error: 'Project path is not configured.' });
      }

      const settings = await resolveEffectiveSettings(projectId);
      const branchName = settings?.defaultBranch || 'main';
      await ensureGitRepository(project.path, { defaultBranch: branchName });

      const requestedEntries = Array.isArray(req.body?.entries) ? req.body.entries : [];
      const commit = req.body?.commit !== false;
      const entries = requestedEntries.filter((entry) => typeof entry === 'string' && entry.trim());

      if (entries.length === 0) {
        const suggestion = await buildGitIgnoreSuggestion(project.path);
        entries.push(...suggestion.entries);
      }

      if (entries.length === 0) {
        return res.json({ success: true, applied: false, committed: false, entries: [] });
      }

      const result = await applyGitIgnoreEntries(project.path, entries);
      let committed = false;

      if (commit && result.applied) {
        committed = await commitGitIgnoreChanges(project.path, 'chore: update .gitignore for local setup');
      }

      res.json({
        success: true,
        applied: result.applied,
        committed,
        entries: result.additions
      });
    } catch (error) {
      console.error('Error applying gitignore updates:', error);
      res.status(500).json({ success: false, error: error?.message || 'Failed to apply gitignore updates' });
    }
  });

  router.post('/:projectId/git/fetch', async (req, res) => {
    try {
      const { projectId } = req.params;
      const project = await getProject(projectId);
      if (!project) {
        return res.status(404).json({ success: false, error: 'Project not found' });
      }

      const settings = await resolveEffectiveSettings(projectId);
      const branchName = settings?.defaultBranch || 'main';
      if (!project.path) {
        return res.status(400).json({ success: false, error: 'Project path is not configured.' });
      }

      await ensureGitRepository(project.path, { defaultBranch: branchName });
      let remoteUrl = null;
      try {
        remoteUrl = await ensureRemoteOrigin(project.path, settings);
      } catch (error) {
        return res.status(400).json({ success: false, error: error?.message || 'Failed to configure remote origin.' });
      }
      if (!remoteUrl) {
        return res.status(400).json({ success: false, error: 'Remote origin is not configured.' });
      }

      await fetchRemote(project.path, 'origin');
      const status = await buildGitStatus({ project, branchName, settings });
      res.json({ success: true, status });
    } catch (error) {
      console.error('Error fetching git remote:', error);
      res.status(500).json({ success: false, error: error?.message || 'Failed to fetch git remote' });
    }
  });

  router.post('/:projectId/git/pull', async (req, res) => {
    try {
      const { projectId } = req.params;
      const project = await getProject(projectId);
      if (!project) {
        return res.status(404).json({ success: false, error: 'Project not found' });
      }

      const settings = await resolveEffectiveSettings(projectId);
      const branchName = settings?.defaultBranch || 'main';
      if (!project.path) {
        return res.status(400).json({ success: false, error: 'Project path is not configured.' });
      }

      await ensureGitRepository(project.path, { defaultBranch: branchName });
      let remoteUrl = null;
      try {
        remoteUrl = await ensureRemoteOrigin(project.path, settings);
      } catch (error) {
        return res.status(400).json({ success: false, error: error?.message || 'Failed to configure remote origin.' });
      }
      if (!remoteUrl) {
        return res.status(400).json({ success: false, error: 'Remote origin is not configured.' });
      }

      const currentBranch = await getCurrentBranch(project.path).catch(() => branchName);
      if (currentBranch && currentBranch !== branchName) {
        return res.status(400).json({ success: false, error: `Checkout ${branchName} before pulling.` });
      }

      const mode = typeof req.body?.mode === 'string' ? req.body.mode.trim().toLowerCase() : '';
      const shouldStash = mode === 'stash';
      const shouldDiscard = mode === 'discard';
      let stashCreated = false;
      let stashRestored = false;
      let stashError = null;

      const dirty = await hasWorkingTreeChanges(project.path).catch(() => false);
      if (dirty) {
        if (shouldStash) {
          const stashLabel = await stashWorkingTree(project.path, currentBranch || branchName).catch(() => null);
          stashCreated = Boolean(stashLabel);
        } else if (shouldDiscard) {
          if (requireDestructiveConfirmation(req, res, { errorMessage: 'Confirmation required to discard local changes.' })) {
            return;
          }
          await discardWorkingTree(project.path);
        } else {
          return res.status(400).json({
            success: false,
            error: 'Working tree has uncommitted changes. Use Stash & Pull or Discard & Pull in the Git tab before pulling.'
          });
        }
      }

      await fetchRemote(project.path, 'origin');
      const compare = await getAheadBehind(project.path, branchName, 'origin');
      if (compare.error) {
        return res.status(400).json({ success: false, error: compare.error });
      }

      let strategy = 'noop';
      if (compare.behind > 0 && compare.ahead === 0) {
        await runGitCommand(project.path, ['merge', '--ff-only', `origin/${branchName}`]);
        strategy = 'ff-only';
      } else if (compare.behind > 0 && compare.ahead > 0) {
        await runGitCommand(project.path, ['rebase', `origin/${branchName}`]);
        strategy = 'rebase';
      }

      if (stashCreated) {
        try {
          stashRestored = await popBranchStash(project.path, currentBranch || branchName);
        } catch (error) {
          stashError = error?.message || 'Failed to re-apply stashed changes.';
        }
      }

      const status = await buildGitStatus({ project, branchName, settings });
      res.json({
        success: true,
        status,
        strategy,
        stash: stashCreated ? { created: true, restored: stashRestored, error: stashError } : null
      });
    } catch (error) {
      console.error('Error pulling git remote:', error);
      res.status(500).json({ success: false, error: error?.message || 'Failed to pull from remote' });
    }
  });

  router.post('/:projectId/git/stash', async (req, res) => {
    try {
      const { projectId } = req.params;
      const project = await getProject(projectId);
      if (!project) {
        return res.status(404).json({ success: false, error: 'Project not found' });
      }

      const settings = await resolveEffectiveSettings(projectId);
      const branchName = settings?.defaultBranch || 'main';
      if (!project.path) {
        return res.status(400).json({ success: false, error: 'Project path is not configured.' });
      }

      await ensureGitRepository(project.path, { defaultBranch: branchName });
      const currentBranch = await getCurrentBranch(project.path).catch(() => branchName);
      const stashLabel = await stashWorkingTree(project.path, currentBranch || branchName).catch(() => null);
      const status = await buildGitStatus({ project, branchName, settings });

      res.json({
        success: true,
        stashed: Boolean(stashLabel),
        label: stashLabel || null,
        status
      });
    } catch (error) {
      console.error('Error stashing git changes:', error);
      res.status(500).json({ success: false, error: error?.message || 'Failed to stash changes' });
    }
  });

  router.post('/:projectId/git/discard', async (req, res) => {
    try {
      const { projectId } = req.params;
      const project = await getProject(projectId);
      if (!project) {
        return res.status(404).json({ success: false, error: 'Project not found' });
      }

      const settings = await resolveEffectiveSettings(projectId);
      const branchName = settings?.defaultBranch || 'main';
      if (!project.path) {
        return res.status(400).json({ success: false, error: 'Project path is not configured.' });
      }

      await ensureGitRepository(project.path, { defaultBranch: branchName });
      const dirty = await hasWorkingTreeChanges(project.path).catch(() => false);
      if (dirty) {
        if (requireDestructiveConfirmation(req, res, { errorMessage: 'Confirmation required to discard local changes.' })) {
          return;
        }
        await discardWorkingTree(project.path);
      }

      const status = await buildGitStatus({ project, branchName, settings });
      res.json({ success: true, discarded: dirty, status });
    } catch (error) {
      console.error('Error discarding git changes:', error);
      res.status(500).json({ success: false, error: error?.message || 'Failed to discard changes' });
    }
  });
  router.get('/:projectId/git-settings', async (req, res) => {
    try {
      const { projectId } = req.params;
      const project = await getProject(projectId);

      if (!project) {
        return res.status(404).json({ success: false, error: 'Project not found' });
      }

      const [projectSettings, globalSettings] = await Promise.all([
        getProjectGitSettings(projectId),
        getGitSettings()
      ]);
      const normalizeRemoteUrl = (value) => (typeof value === 'string' ? value.trim() : '');

      let projectSettingsSnapshot = projectSettings;
      let inheritsFromGlobal = !projectSettingsSnapshot;
      let effectiveSettings = projectSettingsSnapshot || globalSettings;

      const shouldRecoverRemote = globalSettings?.workflow === 'cloud'
        && (!projectSettingsSnapshot || projectSettingsSnapshot.workflow === 'cloud')
        && !normalizeRemoteUrl(projectSettingsSnapshot?.remoteUrl);

      if (shouldRecoverRemote && project?.path) {
        let recoveredRemote = null;
        try {
          await ensureGitRepository(project.path, { defaultBranch: effectiveSettings?.defaultBranch || 'main' });
          recoveredRemote = await getRemoteUrl(project.path, 'origin');
        } catch {
          recoveredRemote = null;
        }

        if (recoveredRemote) {
          const saved = await saveProjectGitSettings(projectId, {
            workflow: 'cloud',
            provider: projectSettingsSnapshot?.provider || globalSettings?.provider || 'github',
            remoteUrl: recoveredRemote,
            username: projectSettingsSnapshot?.username || globalSettings?.username || '',
            defaultBranch: projectSettingsSnapshot?.defaultBranch || globalSettings?.defaultBranch || 'main',
            autoPush: projectSettingsSnapshot?.autoPush ?? false,
            useCommitTemplate: projectSettingsSnapshot?.useCommitTemplate ?? false,
            commitTemplate: projectSettingsSnapshot?.commitTemplate ?? ''
          });
          projectSettingsSnapshot = saved;
          effectiveSettings = saved;
          inheritsFromGlobal = false;
        }
      }

      res.json({
        success: true,
        inheritsFromGlobal,
        settings: effectiveSettings,
        effectiveSettings,
        projectSettings: projectSettingsSnapshot || null,
        globalSettings
      });
    } catch (error) {
      console.error('Error fetching project git settings:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch project git settings' });
    }
  });

  router.put('/:projectId/git-settings', async (req, res) => {
    const { projectId } = req.params;
    const project = await getProject(projectId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const { errors, nextSettings } = validateGitSettingsPayload(req.body || {});
    if (errors.length > 0) {
      return res.status(400).json({ success: false, error: errors.join(', ') });
    }

    try {
      const saved = await saveProjectGitSettings(projectId, nextSettings);
      res.json({
        success: true,
        inheritsFromGlobal: false,
        settings: saved,
        effectiveSettings: saved,
        projectSettings: saved
      });
    } catch (error) {
      console.error('Error saving project git settings:', error);
      res.status(500).json({ success: false, error: 'Failed to save project git settings' });
    }
  });

  router.delete('/:projectId/git-settings', async (req, res) => {
    const { projectId } = req.params;
    const project = await getProject(projectId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    if (requireDestructiveConfirmation(req, res)) {
      return;
    }

    try {
      await deleteProjectGitSettings(projectId);
      const globalSettings = await getGitSettings();
      res.json({
        success: true,
        inheritsFromGlobal: true,
        settings: globalSettings,
        effectiveSettings: globalSettings,
        projectSettings: null,
        globalSettings
      });
    } catch (error) {
      console.error('Error clearing project git settings:', error);
      res.status(500).json({ success: false, error: 'Failed to clear project git settings' });
    }
  });

  router.post('/:projectId/git/remotes', async (req, res) => {
    const { projectId } = req.params;
    const project = await getProject(projectId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const payload = req.body || {};
    const provider = (payload.provider || 'github').toLowerCase();
    if (!SUPPORTED_REMOTE_PROVIDERS.includes(provider)) {
      return res.status(400).json({ success: false, error: 'Unsupported git provider' });
    }

    const repoName = (payload.name || project.name || '').trim();
    if (!repoName) {
      return res.status(400).json({ success: false, error: 'Repository name is required' });
    }

    const tokenFromPayload = typeof payload.token === 'string' ? payload.token.trim() : '';
    let token = tokenFromPayload;
    if (!token) {
      token = (await getGitSettingsToken()) || '';
    }
    if (!token) {
      return res.status(400).json({ success: false, error: 'A personal access token is required to create the repository' });
    }

    const visibility = payload.visibility === 'public' ? 'public' : 'private';
    const description = typeof payload.description === 'string'
      ? payload.description.slice(0, 500)
      : '';
    const owner = typeof payload.owner === 'string' ? payload.owner.trim() : '';
    const defaultBranch = typeof payload.defaultBranch === 'string' ? payload.defaultBranch.trim() : '';
    const applySettings = payload.applySettings !== false;

    try {
      const repository = await createRemoteRepository({
        provider,
        token,
        name: repoName,
        visibility,
        description,
        owner,
        projectName: project.name
      });

      let savedSettings = null;
      if (applySettings) {
        const branchName = repository.defaultBranch || defaultBranch || 'main';
        const settingsPayload = {
          workflow: 'cloud',
          provider,
          remoteUrl: repository.remoteUrl,
          defaultBranch: branchName
        };
        if (tokenFromPayload) {
          settingsPayload.token = tokenFromPayload;
        }
        if (payload.username) {
          settingsPayload.username = String(payload.username).trim();
        }
        savedSettings = await saveProjectGitSettings(projectId, settingsPayload);
      }

      let initialization = null;
      if (applySettings) {
        const branchName = repository.defaultBranch || defaultBranch || 'main';
        if (!project.path) {
          initialization = { success: false, error: 'Project path is not configured.' };
        } else {
          try {
            const initResult = await initializeAndPushRepository(project.path, {
              remoteUrl: repository.remoteUrl,
              defaultBranch: branchName,
              username: payload.username
            });
            initialization = { success: true, ...initResult };
          } catch (initError) {
            initialization = {
              success: false,
              error: initError?.message || 'Failed to initialize and push repository.'
            };
          }
        }
      }

      let projectSettingsSnapshot = savedSettings;
      let inheritsFromGlobal = false;
      if (!projectSettingsSnapshot) {
        projectSettingsSnapshot = await getProjectGitSettings(projectId);
        if (!projectSettingsSnapshot) {
          projectSettingsSnapshot = await getGitSettings();
          inheritsFromGlobal = true;
        }
      }

      res.json({
        success: true,
        message: 'Remote repository created successfully',
        repository,
        appliedSettings: applySettings,
        inheritsFromGlobal,
        initialization,
        settings: projectSettingsSnapshot,
        effectiveSettings: projectSettingsSnapshot,
        projectSettings: savedSettings || (inheritsFromGlobal ? null : projectSettingsSnapshot)
      });
    } catch (error) {
      if (error instanceof RemoteRepoCreationError) {
        return res.status(error.statusCode || 400).json({
          success: false,
          error: error.message,
          provider: error.provider,
          details: error.details || null
        });
      }
      console.error('Error creating remote repository:', error);
      res.status(500).json({ success: false, error: 'Failed to create remote repository' });
    }
  });
}
