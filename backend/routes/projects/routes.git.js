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
  fetchRemote,
  getAheadBehind,
  getCurrentBranch,
  getRemoteUrl,
  hasWorkingTreeChanges,
  runGitCommand
} from '../../utils/git.js';
import { requireDestructiveConfirmation } from './internals.js';

const SUPPORTED_REMOTE_PROVIDERS = ['github', 'gitlab'];

export function registerProjectGitRoutes(router) {
  const resolveEffectiveSettings = async (projectId) => {
    const projectSettings = await getProjectGitSettings(projectId).catch(() => null);
    if (projectSettings) {
      return projectSettings;
    }
    return getGitSettings();
  };

  const buildGitStatus = async ({ project, branchName }) => {
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

    const [currentBranch, remoteUrl, dirty] = await Promise.all([
      getCurrentBranch(project.path).catch(() => null),
      getRemoteUrl(project.path, 'origin'),
      hasWorkingTreeChanges(project.path).catch(() => false)
    ]);

    if (!remoteUrl) {
      return {
        branch: branchName,
        currentBranch,
        ahead: 0,
        behind: 0,
        dirty,
        hasRemote: false,
        remoteUrl: null
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
      const status = await buildGitStatus({ project, branchName });

      res.json({ success: true, status });
    } catch (error) {
      console.error('Error fetching git status:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch git status' });
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
      const remoteUrl = await getRemoteUrl(project.path, 'origin');
      if (!remoteUrl) {
        return res.status(400).json({ success: false, error: 'Remote origin is not configured.' });
      }

      await fetchRemote(project.path, 'origin');
      const status = await buildGitStatus({ project, branchName });
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
      const remoteUrl = await getRemoteUrl(project.path, 'origin');
      if (!remoteUrl) {
        return res.status(400).json({ success: false, error: 'Remote origin is not configured.' });
      }

      const dirty = await hasWorkingTreeChanges(project.path).catch(() => false);
      if (dirty) {
        return res.status(400).json({ success: false, error: 'Working tree has uncommitted changes. Commit or stash before pulling.' });
      }

      const currentBranch = await getCurrentBranch(project.path).catch(() => branchName);
      if (currentBranch && currentBranch !== branchName) {
        return res.status(400).json({ success: false, error: `Checkout ${branchName} before pulling.` });
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

      const status = await buildGitStatus({ project, branchName });
      res.json({ success: true, status, strategy });
    } catch (error) {
      console.error('Error pulling git remote:', error);
      res.status(500).json({ success: false, error: error?.message || 'Failed to pull from remote' });
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
      const inheritsFromGlobal = !projectSettings;
      const effectiveSettings = projectSettings || globalSettings;

      res.json({
        success: true,
        inheritsFromGlobal,
        settings: effectiveSettings,
        effectiveSettings,
        projectSettings: projectSettings || null,
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

    let token = (payload.token || '').trim();
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
          defaultBranch: branchName,
          token
        };
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
