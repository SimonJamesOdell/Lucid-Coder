import fs from 'fs/promises';
import path from 'path';

export const safeTrim = (value) => (typeof value === 'string' ? value.trim() : '');

export const normalizeImportMethod = (value) => (safeTrim(value).toLowerCase() === 'git' ? 'git' : 'local');

export const normalizeImportMode = (value) => {
  const mode = safeTrim(value).toLowerCase();
  return mode === 'link' ? 'link' : 'copy';
};

export const extractRepoName = (repoUrl = '') => {
  const trimmed = safeTrim(repoUrl);
  if (!trimmed) {
    return '';
  }

  const normalized = trimmed
    .replace(/\\/g, '/')
    .replace(/\.git$/i, '')
    .replace(/\/$/, '');

  const sshMatch = normalized.match(/:([^/]+\/[^/]+)$/);
  if (sshMatch?.[1]) {
    const parts = sshMatch[1].split('/');
    return safeTrim(parts[parts.length - 1]);
  }

  const parts = normalized.split('/').filter(Boolean);
  return safeTrim(parts[parts.length - 1] || '');
};

export const normalizeProjectDates = (project = {}) => {
  if (!project || typeof project !== 'object') {
    return project;
  }

  const createdAt = project.createdAt ?? project.created_at ?? null;
  const updatedAt = project.updatedAt ?? project.updated_at ?? createdAt ?? null;

  return {
    ...project,
    createdAt,
    updatedAt
  };
};

export const serializeJob = (job) => {
  if (!job || typeof job !== 'object') {
    return null;
  }

  return {
    ...job,
    projectId: job.projectId ?? job.project_id ?? null,
    createdAt: job.createdAt ?? job.created_at ?? null,
    startedAt: job.startedAt ?? job.started_at ?? null,
    completedAt: job.completedAt ?? job.completed_at ?? null,
    exitCode: job.exitCode ?? job.exit_code ?? null
  };
};

export const pathExists = async (targetPath) => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

export const dirExists = async (targetPath) => {
  try {
    const stats = await fs.stat(targetPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
};

export const fileExists = async (targetPath) => {
  try {
    const stats = await fs.stat(targetPath);
    return stats.isFile();
  } catch {
    return false;
  }
};

export const assertDirectoryExists = async (targetPath, { statFn = fs.stat } = {}) => {
  const stats = await statFn(targetPath);
  if (!stats?.isDirectory?.()) {
    const error = new Error('Project path must be a directory');
    error.statusCode = 400;
    throw error;
  }
};

export const assertProjectPathAvailable = async (targetPath, { pathExistsFn = pathExists } = {}) => {
  const exists = await pathExistsFn(targetPath);
  if (exists) {
    const error = new Error('A project with this path already exists');
    error.statusCode = 409;
    throw error;
  }
};

export const resolveImportProjectName = ({ importMethod, payload = {} } = {}) => {
  const explicit = safeTrim(payload.name);
  if (explicit) {
    return explicit;
  }

  if (importMethod === 'git') {
    return extractRepoName(payload.gitUrl);
  }

  const localPath = safeTrim(payload.localPath || payload.path);
  if (!localPath) {
    return '';
  }

  return path.basename(localPath);
};

export const resolveImportPayloadConfig = (payload = {}) => {
  const frontend = payload.frontend || {};
  const backend = payload.backend || {};

  return {
    frontendConfig: {
      language: safeTrim(frontend.language) || 'javascript',
      framework: safeTrim(frontend.framework) || 'react'
    },
    backendConfig: {
      language: safeTrim(backend.language) || 'javascript',
      framework: safeTrim(backend.framework) || 'express'
    },
    description: safeTrim(payload.description),
    gitProvider: safeTrim(payload.gitProvider).toLowerCase() || 'github'
  };
};

export const isCloneTargetNotEmptyError = (error) => {
  const message = safeTrim(error?.message).toLowerCase();
  return message.includes('already exists and is not an empty directory');
};

export const ensureLocalImportGitRepository = async ({
  importMethod,
  projectPath,
  payload = {},
  globalGitSettings = {},
  dirExistsFn = dirExists,
  ensureGitRepositoryFn,
  configureGitUserFn,
  ensureInitialCommitFn
} = {}) => {
  if (normalizeImportMethod(importMethod) !== 'local') {
    return;
  }

  const hasGitDir = await dirExistsFn(path.join(projectPath, '.git'));
  if (hasGitDir) {
    return;
  }

  const defaultBranch = safeTrim(payload.gitDefaultBranch) || undefined;
  await ensureGitRepositoryFn(projectPath, { defaultBranch });

  const name = safeTrim(globalGitSettings?.username);
  const email = safeTrim(globalGitSettings?.email);
  if (name || email) {
    await configureGitUserFn(projectPath, { name, email });
  }

  await ensureInitialCommitFn(projectPath, 'Initial commit');
};

export const importProjectFromGit = async ({
  payload = {},
  projectName,
  gitProvider,
  resolveProjectPathFn,
  prepareTargetPathFn,
  buildCloneUrlFn,
  getProjectsDirFn,
  mkdirFn,
  runGitCommandFn,
  getCurrentBranchFn
} = {}) => {
  const gitUrl = safeTrim(payload.gitUrl);
  if (!gitUrl) {
    const error = new Error('Git repository URL is required');
    error.statusCode = 400;
    throw error;
  }

  const projectPath = resolveProjectPathFn(projectName);
  const created = await prepareTargetPathFn(projectPath);
  if (!created) {
    const error = new Error('A project with this name already exists');
    error.statusCode = 409;
    throw error;
  }

  const projectsDir = getProjectsDirFn();
  await mkdirFn(projectsDir, { recursive: true });

  const cloneResult = buildCloneUrlFn({
    gitUrl,
    provider: safeTrim(gitProvider).toLowerCase() || 'github',
    username: safeTrim(payload.gitUsername),
    token: safeTrim(payload.gitToken),
    authMethod: safeTrim(payload.gitAuthMethod)
  });

  const cloneUrl = cloneResult?.cloneUrl || gitUrl;
  const safeUrl = cloneResult?.safeUrl || gitUrl;

  try {
    await runGitCommandFn(projectsDir, ['clone', cloneUrl, projectPath]);
  } catch (error) {
    if (isCloneTargetNotEmptyError(error)) {
      error.statusCode = 409;
    }
    throw error;
  }

  const gitDefaultBranch = await getCurrentBranchFn(projectPath);

  return {
    projectPath,
    createdProjectPath: projectPath,
    gitRemoteUrl: safeUrl,
    gitDefaultBranch: safeTrim(gitDefaultBranch)
  };
};

export const importProjectFromLocal = async ({
  payload = {},
  importMode,
  projectName,
  assertDirectoryExistsFn = assertDirectoryExists,
  isWithinManagedProjectsRootFn,
  resolveProjectPathFn,
  prepareTargetPathFn,
  copyProjectFilesWithFallbackFn
} = {}) => {
  const localPath = safeTrim(payload.localPath || payload.path);
  if (!localPath) {
    const error = new Error('Project path is required');
    error.statusCode = 400;
    throw error;
  }

  await assertDirectoryExistsFn(localPath);

  if (normalizeImportMode(importMode) === 'link') {
    if (!isWithinManagedProjectsRootFn(localPath)) {
      const error = new Error('Linked projects must be inside the managed projects folder. Use copy instead.');
      error.statusCode = 400;
      throw error;
    }

    return {
      projectPath: localPath,
      createdProjectPath: null
    };
  }

  const projectPath = resolveProjectPathFn(projectName);
  const prepared = await prepareTargetPathFn(projectPath);
  if (!prepared) {
    const error = new Error('A project with this name already exists');
    error.statusCode = 409;
    throw error;
  }

  await copyProjectFilesWithFallbackFn(localPath, projectPath);

  return {
    projectPath,
    createdProjectPath: projectPath
  };
};

export const applyImportPostProcessing = async ({
  projectPath,
  applyStructureFix,
  applyCompatibilityChanges,
  applyProjectStructureFn,
  applyCompatibilityFn
} = {}) => {
  let structureResult = null;
  let compatibilityResult = null;

  if (applyStructureFix) {
    try {
      structureResult = await applyProjectStructureFn(projectPath);
    } catch (error) {
      const wrapped = new Error(error?.message || 'Failed to apply project structure changes');
      wrapped.statusCode = 400;
      throw wrapped;
    }
  }

  if (applyCompatibilityChanges) {
    try {
      compatibilityResult = await applyCompatibilityFn(projectPath);
    } catch (error) {
      const wrapped = new Error(error?.message || 'Failed to apply compatibility changes');
      wrapped.statusCode = 400;
      throw wrapped;
    }
  }

  return {
    structureResult,
    compatibilityResult
  };
};

export const resolveImportGitSettings = ({
  payload = {},
  globalSettings = {},
  gitRemoteUrl = '',
  gitDefaultBranch = '',
  fallbackProvider = 'github'
} = {}) => {
  const mode = safeTrim(payload.gitConnectionMode).toLowerCase();
  const providerFallback = safeTrim(fallbackProvider).toLowerCase() || 'github';

  if (mode === 'local') {
    return {
      workflow: 'local',
      provider: safeTrim(payload.gitProvider).toLowerCase() || providerFallback,
      remoteUrl: '',
      username: '',
      token: '',
      defaultBranch: safeTrim(payload.gitDefaultBranch || gitDefaultBranch || globalSettings.defaultBranch || 'main') || 'main',
      autoPush: false,
      useCommitTemplate: false,
      commitTemplate: ''
    };
  }

  if (mode === 'custom') {
    return {
      workflow: 'cloud',
      provider: safeTrim(payload.gitConnectionProvider || payload.gitProvider).toLowerCase() || providerFallback,
      remoteUrl: safeTrim(payload.gitRemoteUrl || gitRemoteUrl),
      username: safeTrim(payload.gitUsername),
      token: safeTrim(payload.gitToken),
      defaultBranch: safeTrim(payload.gitDefaultBranch || gitDefaultBranch || globalSettings.defaultBranch || 'main') || 'main',
      autoPush: Boolean(payload.gitAutoPush),
      useCommitTemplate: Boolean(payload.gitUseCommitTemplate),
      commitTemplate: safeTrim(payload.gitCommitTemplate)
    };
  }

  return {
    workflow: 'cloud',
    provider: safeTrim(globalSettings.provider).toLowerCase() || providerFallback,
    remoteUrl: safeTrim(gitRemoteUrl || globalSettings.remoteUrl),
    username: safeTrim(globalSettings.username),
    token: '',
    defaultBranch: safeTrim(gitDefaultBranch || globalSettings.defaultBranch || 'main') || 'main',
    autoPush: Boolean(globalSettings.autoPush),
    useCommitTemplate: Boolean(globalSettings.useCommitTemplate),
    commitTemplate: safeTrim(globalSettings.commitTemplate)
  };
};
