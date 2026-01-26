import db, { getGitSettings, getProjectGitSettings } from '../../database.js';
import * as git from '../../utils/git.js';
import { isWithinManagedProjectsRoot } from '../../routes/projects/cleanup.js';
import { parseStagedFiles, withStatusCode } from './formatting.js';

const gitReadyTestOverrides = new Map();
let testModeOverride = null;
const isTestEnvironment = process.env.NODE_ENV === 'test';

export const setTestModeOverride = (value) => {
  testModeOverride = value;
};

export const setGitContextOverride = (projectId, projectPath) => {
  if (!projectId) {
    return;
  }
  if (projectPath) {
    gitReadyTestOverrides.set(projectId, projectPath);
  } else {
    gitReadyTestOverrides.delete(projectId);
  }
};

export const isTestMode = () => (
  testModeOverride === null ? isTestEnvironment : Boolean(testModeOverride)
);

export const run = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function callback(err) {
    if (err) {
      reject(err);
    } else {
      resolve({ lastID: this.lastID, changes: this.changes });
    }
  });
});

export const get = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => {
    if (err) {
      reject(err);
    } else {
      resolve(row || null);
    }
  });
});

export const all = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => {
    if (err) {
      reject(err);
    } else {
      resolve(rows || []);
    }
  });
});

export const ensureProjectExists = async (projectId) => {
  const project = await get('SELECT id, name, path FROM projects WHERE id = ?', [projectId]);
  if (!project) {
    throw withStatusCode(new Error('Project not found'), 404);
  }
  return project;
};

export const resolveProjectGitSettings = async (projectId) => {
  const projectSettings = await getProjectGitSettings(projectId).catch(() => null);
  if (projectSettings) {
    return projectSettings;
  }
  return getGitSettings();
};

export const getProjectContext = async (projectId) => {
  const project = await ensureProjectExists(projectId);
  const context = {
    project,
    projectPath: project.path || null,
    gitReady: false
  };

  const forcedPath = gitReadyTestOverrides.get(projectId);
  if (forcedPath) {
    context.projectPath = forcedPath;
    context.gitReady = true;
    return context;
  }

  if ((isTestMode() && !forcedPath) || !context.projectPath) {
    return context;
  }

  if (!isWithinManagedProjectsRoot(context.projectPath)) {
    console.warn(
      `[BranchWorkflow] Project ${projectId} path is outside managed root: ${context.projectPath}`
    );
  }

  try {
    await git.ensureGitRepository(context.projectPath, { defaultBranch: 'main' });
    context.gitReady = true;
  } catch (error) {
    console.warn(`[BranchWorkflow] Git unavailable for project ${projectId}: ${error.message}`);
  }

  return context;
};

export const runProjectGit = (context, args, options) => {
  if (!context?.gitReady) {
    return Promise.resolve(null);
  }
  return git.runGitCommand(context.projectPath, args, options);
};

export const listBranchChangedPaths = async (context, { baseRef = 'main', branchRef } = {}) => {
  if (!context?.gitReady) {
    return [];
  }

  const base = typeof baseRef === 'string' ? baseRef.trim() : '';
  const branch = typeof branchRef === 'string' ? branchRef.trim() : '';

  if (!base || !branch) {
    return [];
  }

  const { stdout } = await runProjectGit(context, ['diff', '--name-only', `${base}..${branch}`]);

  return (stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
};

export const isCssOnlyBranchDiff = async (context, branchName) => {
  if (!context?.gitReady) {
    return false;
  }

  const changedPaths = await listBranchChangedPaths(context, { branchRef: branchName });
  if (!changedPaths.length) {
    return false;
  }

  return changedPaths.every((value) => value.toLowerCase().endsWith('.css'));
};

export const listGitStagedPaths = async (context) => {
  const result = await runProjectGit(context, ['diff', '--cached', '--name-only']).catch(() => null);
  const stdout = result?.stdout || '';
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
};

export const listGitStagedStatusMap = async (context) => {
  const result = await runProjectGit(context, ['diff', '--cached', '--name-status']).catch(() => null);
  const stdout = result?.stdout || '';
  const map = new Map();

  stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const parts = line.split(/\t+/).filter(Boolean);
      if (parts.length < 2) {
        return;
      }

      const status = parts[0][0];

      if ((status === 'R' || status === 'C') && parts.length >= 3) {
        // Rename/copy reports both old and new paths.
        map.set(parts[1], status);
        map.set(parts[2], status);
        return;
      }

      map.set(parts[1], status);
    });

  return map;
};

export const parseGitLsFilesStageBlob = (stdout = '') => {
  const first = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)[0];

  if (!first) {
    return null;
  }

  // Format: <mode> <blob> <stage>\t<path>
  const tokens = first.split(/\s+/);
  if (tokens.length < 2) {
    return null;
  }

  const blob = tokens[1];
  return blob;
};

export const listGitStagedEntries = async (context) => {
  const [stagedPaths, statusMap] = await Promise.all([
    listGitStagedPaths(context),
    listGitStagedStatusMap(context)
  ]);

  const entries = [];
  for (const filePath of stagedPaths) {
    const status = statusMap.get(filePath);
    if (status === 'D') {
      entries.push({ path: filePath, gitToken: 'D' });
      continue;
    }

    const lsResult = await runProjectGit(context, ['ls-files', '--stage', '--', filePath]).catch(() => null);
    const blob = parseGitLsFilesStageBlob(lsResult?.stdout || '');
    entries.push({ path: filePath, gitToken: blob || '' });
  }

  return entries;
};

export const buildStagedFilesSnapshot = (existingEntries, stagedEntries) => {
  const stagedMap = new Map(
    stagedEntries
      .filter((entry) => entry?.path)
      .map((entry) => [entry.path, entry.gitToken || ''])
  );

  const preserved = existingEntries
    .filter((entry) => entry?.path && stagedMap.has(entry.path))
    .map((entry) => ({
      ...entry,
      gitToken: stagedMap.get(entry.path) || entry.gitToken || ''
    }));

  const preservedPaths = new Set(preserved.map((entry) => entry.path));

  const additions = stagedEntries
    .filter((entry) => entry?.path && !preservedPaths.has(entry.path))
    .map((entry) => ({
      path: entry.path,
      source: 'editor',
      timestamp: null,
      gitToken: entry.gitToken || ''
    }));

  return [...preserved, ...additions];
};

export const syncCurrentBranchStagedFilesFromGit = async (projectId, context) => {
  if (!context?.gitReady || !context.projectPath) {
    return;
  }

  const gitBranchName = await git.getCurrentBranch(context.projectPath).catch(() => null);
  if (!gitBranchName) {
    return;
  }

  const stagedEntries = await listGitStagedEntries(context);

  const branchRow = await get(
    'SELECT id, staged_files, status FROM branches WHERE project_id = ? AND LOWER(name) = LOWER(?) LIMIT 1',
    [projectId, gitBranchName]
  );
  if (!branchRow) {
    return;
  }

  const existingFiles = parseStagedFiles(branchRow.staged_files);
  const nextFiles = buildStagedFilesSnapshot(existingFiles, stagedEntries);

  const signatureFor = (files = []) => files
    .map((entry) => {
      const pathValue = entry?.path || '';
      const token = typeof entry?.gitToken === 'string' ? entry.gitToken : '';
      return `${pathValue}\0${token}`;
    })
    .filter(Boolean)
    .join('\n');

  const existingSignature = signatureFor(existingFiles);
  const nextSignature = signatureFor(nextFiles);

  const stagedPathsChanged = existingSignature !== nextSignature;
  const shouldInvalidateReadyBranch =
    branchRow.status === 'ready-for-merge' && stagedPathsChanged && nextFiles.length > 0;
  const nextStatus = shouldInvalidateReadyBranch ? 'active' : branchRow.status;
  const isCssOnlyStaged = nextFiles.length > 0
    && nextFiles.every((entry) => String(entry?.path || '').trim().toLowerCase().endsWith('.css'));
  const shouldInvalidateTestRun = stagedPathsChanged && nextFiles.length > 0 && !isCssOnlyStaged;

  if (existingSignature === nextSignature && !shouldInvalidateReadyBranch) {
    return;
  }

  await run(
    `UPDATE branches
     SET staged_files = ?,
         status = ?,
         last_test_run_id = CASE WHEN ? = 1 THEN NULL ELSE last_test_run_id END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [JSON.stringify(nextFiles), nextStatus, shouldInvalidateTestRun ? 1 : 0, branchRow.id]
  );
};

export const ensureGitBranchExists = async (context, branchName, baseBranch = 'main') => {
  if (!context.gitReady || !branchName) {
    return;
  }

  try {
    await runProjectGit(context, ['show-ref', '--verify', `refs/heads/${branchName}`]);
  } catch (error) {
    if (error.code === 1 || /not a valid ref/i.test(error.message || '')) {
      await runProjectGit(context, ['checkout', baseBranch]);
      await runProjectGit(context, ['checkout', '-b', branchName]);
      return;
    }
    throw error;
  }
};

export const checkoutGitBranch = async (context, branchName) => {
  if (!context.gitReady || !branchName) {
    return;
  }

  const current = await git.getCurrentBranch(context.projectPath).catch(() => null);
  if (current === branchName) {
    await git.popBranchStash(context.projectPath, branchName).catch(() => null);
    return;
  }

  if (current) {
    await git.stashWorkingTree(context.projectPath, current).catch(() => null);
  }

  await runProjectGit(context, ['checkout', branchName]);
  await git.popBranchStash(context.projectPath, branchName).catch(() => null);
};
