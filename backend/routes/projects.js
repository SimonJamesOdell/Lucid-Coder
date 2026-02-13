import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import {
  createProject,
  getAllProjects,
  getProject,
  getProjectByName,
  updateProject,
  deleteProject,
  getGitSettings,
  getPortSettings,
  updateProjectPorts,
  saveProjectGitSettings
} from '../database.js';
import {
  createProjectWithFiles,
  cloneProjectFromRemote,
  installDependencies,
  startProject
} from '../services/projectScaffolding.js';
import { buildPortOverrideOptions } from '../services/projectScaffolding/ports.js';
import { resolveProjectPath, getProjectsDir } from '../utils/projectPaths.js';
import { buildCloneUrl, stripGitCredentials } from '../utils/gitUrl.js';
import {
  runGitCommand,
  getCurrentBranch,
  ensureGitRepository,
  configureGitUser,
  ensureInitialCommit
} from '../utils/git.js';
import { startJob } from '../services/jobRunner.js';
import { applyCompatibility, applyProjectStructure } from '../services/importCompatibility.js';
import {
  initProgress,
  updateProgress,
  completeProgress,
  failProgress,
  attachProgressStream,
  getProgressSnapshot
} from '../services/progressTracker.js';
import {
  addCleanupTarget,
  buildCleanupTargets,
  cleanupDirectoryExecutor
} from './projects/cleanup.js';
import { hasUnsafeCommandCharacters } from './projects/cleanup.js';
import { isWithinManagedProjectsRoot } from './projects/cleanup.js';
import {
  extractProcessPorts,
  findProjectByIdentifier,
  storeRunningProcesses,
  terminateRunningProcesses
} from './projects/processManager.js';
import { getFsModule, attachTestErrorDetails, buildProjectUpdatePayload, requireDestructiveConfirmation } from './projects/internals.js';
import { registerProjectFileRoutes } from './projects/routes.files.js';
import { registerProjectGitRoutes } from './projects/routes.git.js';
import { registerProjectProcessRoutes } from './projects/routes.processes.js';
import { registerProjectTestingRoutes } from './projects/routes.testing.js';

const router = express.Router();

const normalizeImportMethod = (value) => (value === 'git' ? 'git' : 'local');
const normalizeImportMode = (value) => (value === 'link' ? 'link' : 'copy');
const normalizeGitConnectionMode = (value) => {
  const normalized = safeTrim(value).toLowerCase();
  if (normalized === 'global' || normalized === 'custom') {
    return normalized;
  }
  return 'local';
};
const safeTrim = (value) => (typeof value === 'string' ? value.trim() : '');

const extractRepoName = (value) => {
  const raw = safeTrim(value);
  if (!raw) {
    return '';
  }

  const cleaned = raw.replace(/[?#].*$/, '');
  const parts = cleaned.split('/').filter(Boolean);
  let candidate = parts[parts.length - 1] || '';

  if (candidate.includes(':')) {
    candidate = candidate.split(':').pop() || candidate;
  }

  return candidate.replace(/\.git$/i, '');
};

// buildCloneUrl and stripGitCredentials imported from ../utils/gitUrl.js

const assertDirectoryExists = async (targetPath) => {
  const stats = await fs.stat(targetPath);
  if (!stats.isDirectory()) {
    const error = new Error('Project path must be a directory');
    error.statusCode = 400;
    throw error;
  }
};

const assertProjectPathAvailable = async (targetPath) => {
  try {
    await fs.stat(targetPath);
    const error = new Error('Project path already exists');
    error.statusCode = 409;
    throw error;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return;
    }
    throw error;
  }
};

const pathExists = async (targetPath) => {
  try {
    await fs.stat(targetPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

const dirExists = async (targetPath) => {
  try {
    const stats = await fs.stat(targetPath);
    return stats.isDirectory();
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

const fileExists = async (targetPath) => {
  try {
    const stats = await fs.stat(targetPath);
    return stats.isFile();
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

const isCloneTargetNotEmptyError = (error) => {
  const message = `${error?.stderr || ''} ${error?.message || ''}`.toLowerCase();
  return message.includes('already exists and is not an empty directory');
};

const resolveImportGitSettings = ({
  payload,
  globalSettings,
  gitRemoteUrl,
  gitDefaultBranch,
  fallbackProvider
}) => {
  const connectionMode = normalizeGitConnectionMode(payload?.gitConnectionMode);
  const requestedRemote = safeTrim(payload?.gitRemoteUrl);
  const resolvedRemote = requestedRemote || safeTrim(gitRemoteUrl);
  const requestedProvider = safeTrim(payload?.gitConnectionProvider)
    || safeTrim(payload?.gitProvider)
    || fallbackProvider;
  const requestedBranch = safeTrim(payload?.gitDefaultBranch)
    || safeTrim(gitDefaultBranch)
    || safeTrim(globalSettings?.defaultBranch)
    || 'main';

  if (connectionMode === 'local' || !resolvedRemote) {
    return {
      workflow: 'local',
      provider: requestedProvider,
      remoteUrl: '',
      username: '',
      defaultBranch: requestedBranch
    };
  }

  const globalProvider = safeTrim(globalSettings?.provider);
  const globalUsername = safeTrim(globalSettings?.username);
  const provider = connectionMode === 'global' && globalProvider
    ? globalProvider
    : requestedProvider;
  const username = connectionMode === 'global' && globalUsername
    ? globalUsername
    : safeTrim(payload?.gitUsername);

  return {
    workflow: 'cloud',
    provider,
    remoteUrl: resolvedRemote,
    username,
    defaultBranch: requestedBranch
  };
};

const normalizeProjectDates = (project = {}) => {
  const createdAt = project.createdAt ?? project.created_at ?? null;
  const updatedAt = project.updatedAt ?? project.updated_at ?? createdAt;
  return {
    ...project,
    createdAt,
    updatedAt
  };
};

const serializeJob = (job) => {
  if (!job) {
    return null;
  }
  return {
    id: job.id,
    projectId: job.projectId ?? job.project_id ?? null,
    type: job.type,
    displayName: job.displayName,
    status: job.status,
    command: job.command,
    args: job.args,
    cwd: job.cwd,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    exitCode: job.exitCode,
    signal: job.signal,
    logs: job.logs
  };
};

const enqueueInstallJobs = async ({ projectId, projectPath }) => {
  if (!projectId || !projectPath) {
    return [];
  }

  const jobs = [];
  const frontendPath = path.join(projectPath, 'frontend');
  const backendPath = path.join(projectPath, 'backend');
  const hasFrontendDir = await dirExists(frontendPath);
  const hasBackendDir = await dirExists(backendPath);
  const backendBase = hasBackendDir ? backendPath : projectPath;

  const frontendPackage = hasFrontendDir && await fileExists(path.join(frontendPath, 'package.json'));
  if (frontendPackage) {
    try {
      jobs.push(startJob({
        projectId,
        type: 'frontend:install',
        displayName: 'Install frontend dependencies',
        command: 'npm',
        args: ['install'],
        cwd: frontendPath
      }));
    } catch (error) {
      console.warn('Failed to start frontend install job:', error?.message || error);
    }
  }

  const backendPackage = await fileExists(path.join(backendBase, 'package.json'));
  const backendRequirements = await fileExists(path.join(backendBase, 'requirements.txt'));
  const backendPyProject = await fileExists(path.join(backendBase, 'pyproject.toml'));
  const backendPom = await fileExists(path.join(backendBase, 'pom.xml'));
  const backendGradle = await fileExists(path.join(backendBase, 'build.gradle')) || await fileExists(path.join(backendBase, 'build.gradle.kts'));
  const backendGradleWrapper = await fileExists(path.join(backendBase, 'gradlew')) || await fileExists(path.join(backendBase, 'gradlew.bat'));
  const backendGoMod = await fileExists(path.join(backendBase, 'go.mod'));
  const backendCargo = await fileExists(path.join(backendBase, 'Cargo.toml'));
  const backendComposer = await fileExists(path.join(backendBase, 'composer.json'));
  const backendGemfile = await fileExists(path.join(backendBase, 'Gemfile'));
  const backendSwift = await fileExists(path.join(backendBase, 'Package.swift'));

  let backendCommand = null;
  let backendArgs = null;

  if (backendPackage) {
    backendCommand = 'npm';
    backendArgs = ['install'];
  } else if (backendRequirements) {
    backendCommand = 'python';
    backendArgs = ['-m', 'pip', 'install', '-r', 'requirements.txt'];
  } else if (backendPyProject) {
    backendCommand = 'python';
    backendArgs = ['-m', 'pip', 'install', '-e', '.'];
  } else if (backendPom) {
    backendCommand = 'mvn';
    backendArgs = ['-q', '-DskipTests', 'package'];
  } else if (backendGradle) {
    backendCommand = backendGradleWrapper
      ? (await fileExists(path.join(backendBase, 'gradlew.bat')) ? path.join(backendBase, 'gradlew.bat') : path.join(backendBase, 'gradlew'))
      : 'gradle';
    backendArgs = ['build', '-x', 'test'];
  } else if (backendGoMod) {
    backendCommand = 'go';
    backendArgs = ['mod', 'download'];
  } else if (backendCargo) {
    backendCommand = 'cargo';
    backendArgs = ['fetch'];
  } else if (backendComposer) {
    backendCommand = 'composer';
    backendArgs = ['install'];
  } else if (backendGemfile) {
    backendCommand = 'bundle';
    backendArgs = ['install'];
  } else if (backendSwift) {
    backendCommand = 'swift';
    backendArgs = ['package', 'resolve'];
  }

  if (backendCommand && backendArgs) {
    try {
      jobs.push(startJob({
        projectId,
        type: 'backend:install',
        displayName: 'Install backend dependencies',
        command: backendCommand,
        args: backendArgs,
        cwd: backendBase
      }));
    } catch (error) {
      console.warn('Failed to start backend install job:', error?.message || error);
    }
  }

  return jobs;
};

const DEFAULT_COPY_IGNORE_DIRS = new Set(['node_modules', '.git']);

const copyDirectoryRecursive = async (sourceDir, targetDir, { onFileError, ignoreDirs = DEFAULT_COPY_IGNORE_DIRS } = {}) => {
  await fs.mkdir(targetDir, { recursive: true });

  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && ignoreDirs.has(entry.name)) {
      continue;
    }
    const srcPath = path.join(sourceDir, entry.name);
    const destPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await copyDirectoryRecursive(srcPath, destPath, { onFileError });
      continue;
    }

    if (entry.isSymbolicLink()) {
      try {
        const linkTarget = await fs.readlink(srcPath);
        await fs.symlink(linkTarget, destPath);
      } catch (error) {
        if (typeof onFileError === 'function') {
          onFileError(error, srcPath, destPath);
        }
        throw error;
      }
      continue;
    }

    try {
      await fs.copyFile(srcPath, destPath);
    } catch (error) {
      if (typeof onFileError === 'function') {
        onFileError(error, srcPath, destPath);
      }
      throw error;
    }
  }
};

const cleanupExistingImportTarget = async (targetPath) => {
  if (!targetPath || !isWithinManagedProjectsRoot(targetPath)) {
    return false;
  }

  try {
    await fs.rm(targetPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    return false;
  }
};

registerProjectProcessRoutes(router);
registerProjectFileRoutes(router);
registerProjectGitRoutes(router);
registerProjectTestingRoutes(router);

// POST /api/projects/validate-local-path - Validate local import path
router.post('/validate-local-path', async (req, res) => {
  try {
    /* c8 ignore next */
    const payload = req.body || {};
    const localPath = safeTrim(payload.path || payload.localPath);
    const importMode = normalizeImportMode(payload.importMode);

    if (!localPath) {
      return res.status(400).json({ success: false, error: 'Project path is required' });
    }

    await assertDirectoryExists(localPath);

    if (importMode === 'link' && !isWithinManagedProjectsRoot(localPath)) {
      return res.status(400).json({
        success: false,
        error: 'Linked projects must be inside the managed projects folder. Use copy instead.'
      });
    }

    return res.json({ success: true, valid: true });
  } catch (error) {
    const status = error?.statusCode || 500;
    const message = error?.message || 'Invalid project path';
    return res.status(status).json({ success: false, error: message });
  }
});

// GET /api/projects - Get all projects
router.get('/', async (req, res) => {
  try {
    const projects = await getAllProjects();
    res.json({
      success: true,
      projects: (projects || []).map(normalizeProjectDates)
    });
  } catch (error) {
    console.error('Error fetching projects:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch projects'
    });
  }
});

// POST /api/projects/import - Import existing project (local or git)
router.post('/import', async (req, res) => {
  let createdProjectPath = null;
  try {
    const payload = req.body || {};
    const importMethod = normalizeImportMethod(payload.importMethod);
    const importMode = normalizeImportMode(payload.importMode);
    const applyCompatibilityChanges = Boolean(payload.applyCompatibility);
    const applyStructureFix = Boolean(payload.applyStructureFix);

    let projectName = safeTrim(payload.name);
    if (!projectName) {
      if (importMethod === 'git') {
        projectName = extractRepoName(payload.gitUrl);
      } else {
        projectName = extractRepoName(payload.localPath || payload.path);
      }
    }

    if (!projectName) {
      return res.status(400).json({ success: false, error: 'Project name is required' });
    }

    const existingProject = await getProjectByName(projectName);
    if (existingProject) {
      return res.status(409).json({
        success: false,
        error: `A project with the name "${projectName}" already exists. Please choose a different name.`
      });
    }

    const frontend = payload.frontend || {};
    const backend = payload.backend || {};

    const frontendConfig = {
      language: safeTrim(frontend.language) || 'javascript',
      framework: safeTrim(frontend.framework) || 'react'
    };

    const backendConfig = {
      language: safeTrim(backend.language) || 'javascript',
      framework: safeTrim(backend.framework) || 'express'
    };

    const description = safeTrim(payload.description);
    let projectPath = null;
    let gitRemoteUrl = null;
    let gitDefaultBranch = null;
    let gitProvider = safeTrim(payload.gitProvider) || 'github';
    let globalGitSettings = null;

    try {
      globalGitSettings = await getGitSettings();
    } catch (error) {
      console.warn('Failed to load global git settings for import:', error?.message || error);
      globalGitSettings = null;
    }

    if (importMethod === 'local') {
      const localPath = safeTrim(payload.localPath || payload.path);
      if (!localPath) {
        return res.status(400).json({ success: false, error: 'Project path is required' });
      }

      await assertDirectoryExists(localPath);

      if (importMode === 'link') {
        if (!isWithinManagedProjectsRoot(localPath)) {
          return res.status(400).json({
            success: false,
            error: 'Linked projects must be inside the managed projects folder. Use copy instead.'
          });
        }
        projectPath = localPath;
      } else {
        const targetPath = resolveProjectPath(projectName);
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        if (await pathExists(targetPath)) {
          const cleaned = await cleanupExistingImportTarget(targetPath);
          if (!cleaned) {
            return res.status(409).json({
              success: false,
              error: 'Project path already exists'
            });
          }
        }
        try {
          await fs.cp(localPath, targetPath, {
            recursive: true,
            filter: (src) => {
              const normalized = src.replace(/\\/g, '/');
              return !normalized.includes('/node_modules/') && !normalized.endsWith('/node_modules');
            }
          });
        } catch (copyError) {
          let failedPath = null;
          let failure = copyError;

          try {
            await copyDirectoryRecursive(localPath, targetPath, {
              onFileError: (error, srcPath) => {
                failedPath = srcPath;
                failure = error;
              }
            });
          } catch (recursiveError) {
            failure = recursiveError;
          }

          const code = failure?.code || copyError?.code || 'UNKNOWN';
          const suffix = failedPath ? ` at ${failedPath}` : '';
          const message = `Failed to copy project files (${code})${suffix}. Try linking instead.`;
          const error = new Error(message);
          error.statusCode = 400;
          error.code = code;
          error.failedPath = failedPath;
          throw error;
        }
        createdProjectPath = targetPath;
        projectPath = targetPath;
      }
    } else {
      const gitUrl = safeTrim(payload.gitUrl);
      if (!gitUrl) {
        return res.status(400).json({ success: false, error: 'Git repository URL is required' });
      }

      const targetPath = resolveProjectPath(projectName);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      if (await pathExists(targetPath)) {
        const cleaned = await cleanupExistingImportTarget(targetPath);
        if (!cleaned) {
          return res.status(409).json({
            success: false,
            error: 'Project path already exists'
          });
        }
      }

      const authMethod = safeTrim(payload.gitAuthMethod).toLowerCase() === 'ssh' ? 'ssh' : 'pat';
      const { cloneUrl, safeUrl } = buildCloneUrl({
        url: gitUrl,
        authMethod,
        token: payload.gitToken,
        username: payload.gitUsername,
        provider: gitProvider
      });

      const cloneBaseDir = getProjectsDir();
      await fs.mkdir(cloneBaseDir, { recursive: true });
      await runGitCommand(cloneBaseDir, ['clone', cloneUrl, targetPath]);
      createdProjectPath = targetPath;

      const sanitizedRemoteUrl = safeUrl;
      await runGitCommand(targetPath, ['remote', 'set-url', 'origin', sanitizedRemoteUrl], { allowFailure: true });
      gitRemoteUrl = sanitizedRemoteUrl;

      try {
        gitDefaultBranch = await getCurrentBranch(targetPath);
      } catch {
        gitDefaultBranch = null;
      }

      projectPath = targetPath;
    }

    if (importMethod === 'local' && projectPath) {
      const defaultBranch = safeTrim(payload.gitDefaultBranch)
        || safeTrim(globalGitSettings?.defaultBranch)
        || 'main';
      const gitDirPath = path.join(projectPath, '.git');
      const hasGitDir = await dirExists(gitDirPath);
      if (!hasGitDir) {
        await ensureGitRepository(projectPath, { defaultBranch });
        await configureGitUser(projectPath, {
          name: globalGitSettings?.username,
          email: globalGitSettings?.email
        });
        await ensureInitialCommit(projectPath, 'Initial commit');
      }
    }

    let structureResult = null;
    let compatibilityResult = null;
    if (applyStructureFix) {
      try {
        structureResult = await applyProjectStructure(projectPath);
      } catch (error) {
        const structureError = new Error(error?.message || 'Failed to apply project structure updates');
        structureError.statusCode = 400;
        throw structureError;
      }
    }
    if (applyCompatibilityChanges) {
      try {
        compatibilityResult = await applyCompatibility(projectPath);
      } catch (error) {
        const compatError = new Error(error?.message || 'Failed to apply compatibility changes');
        compatError.statusCode = 400;
        throw compatError;
      }
    }

    const dbProjectData = {
      name: projectName,
      description,
      language: `${frontendConfig.language},${backendConfig.language}`,
      framework: `${frontendConfig.framework},${backendConfig.framework}`,
      path: projectPath,
      frontendPort: null,
      backendPort: null
    };

    const project = await createProject(dbProjectData);

    if (project?.id) {
      const importGitSettings = resolveImportGitSettings({
        payload,
        globalSettings: globalGitSettings,
        gitRemoteUrl,
        gitDefaultBranch,
        fallbackProvider: gitProvider
      });

      await saveProjectGitSettings(project.id, importGitSettings);

      if (importGitSettings.workflow === 'cloud' && importGitSettings.remoteUrl) {
        const { stdout, code } = await runGitCommand(projectPath, ['remote', 'get-url', 'origin'], { allowFailure: true });
        const existingRemote = typeof stdout === 'string' ? stdout.trim() : '';
        if (code === 0 && existingRemote) {
          if (existingRemote !== importGitSettings.remoteUrl) {
            await runGitCommand(projectPath, ['remote', 'set-url', 'origin', importGitSettings.remoteUrl]);
          }
        } else {
          await runGitCommand(projectPath, ['remote', 'add', 'origin', importGitSettings.remoteUrl]);
        }
      }
    }

    let setupJobs = [];
    try {
      setupJobs = await enqueueInstallJobs({ projectId: project.id, projectPath });
    } catch (error) {
      console.warn('Failed to enqueue setup jobs:', error?.message || error);
    }

    const enhancedProject = {
      ...project,
      frontend: frontendConfig,
      backend: backendConfig,
      path: projectPath
    };

    return res.status(201).json({
      success: true,
      project: enhancedProject,
      jobs: setupJobs.map(serializeJob),
      structure: structureResult,
      compatibility: compatibilityResult,
      message: 'Project imported successfully'
    });
  } catch (error) {
    console.error('Error importing project:', error);
    if (createdProjectPath && isWithinManagedProjectsRoot(createdProjectPath)) {
      try {
        await fs.rm(createdProjectPath, { recursive: true, force: true });
      } catch (cleanupError) {
        console.warn('Failed to clean up imported project folder:', cleanupError?.message || cleanupError);
      }
    }
    const rawMessage = typeof error?.message === 'string' ? error.message : '';
    let statusCode = error?.statusCode || 500;
    if (rawMessage.includes('UNIQUE constraint failed')) {
      statusCode = 409;
    }
    const errorMessage = statusCode === 500 ? (rawMessage || 'Failed to import project') : error.message;
    const errorResponse = {
      success: false,
      error: errorMessage
    };

    if (process.env.NODE_ENV === 'development') {
      errorResponse.details = {
        code: error?.code || null,
        name: error?.name || null,
        failedPath: error?.failedPath || null
      };
    }

    attachTestErrorDetails(error, errorResponse);

    return res.status(statusCode).json(errorResponse);
  }
});

// SSE progress stream for project creation
router.get('/progress/:progressKey/stream', async (req, res) => {
  const { progressKey } = req.params;

  if (!progressKey) {
    return res.status(400).json({ success: false, error: 'Progress key is required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }
  res.write('retry: 1000\n\n');

  attachProgressStream(progressKey, res);
});

router.get('/progress/:progressKey', (req, res) => {
  const { progressKey } = req.params;
  if (!progressKey) {
    return res.status(400).json({ success: false, error: 'Progress key is required' });
  }

  const snapshot = getProgressSnapshot(progressKey);
  if (!snapshot) {
    return res.status(404).json({ success: false, error: 'Progress not found' });
  }

  res.json({ success: true, progress: snapshot });
});

// GET /api/projects/:id - Get specific project
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const project = await getProject(id);
    
    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }
    
    res.json({
      success: true,
      project: normalizeProjectDates(project)
    });
  } catch (error) {
    console.error('Error fetching project:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch project'
    });
  }
});

// POST /api/projects - Create new project with full scaffolding
router.post('/', async (req, res) => {
  let progressKey = null;
  try {
    const { name, description, frontend, backend, progressKey: rawProgressKey } = req.body;
    progressKey = typeof rawProgressKey === 'string' && rawProgressKey.trim().length > 0
      ? rawProgressKey.trim()
      : null;
    
    // Validation
    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Project name is required'
      });
    }
    
    // Check for duplicate project names (case insensitive)
    const existingProject = await getProjectByName(name);
    if (existingProject) {
      return res.status(400).json({
        success: false,
        error: `A project with the name "${name.trim()}" already exists. Please choose a different name.`
      });
    }
    
    if (!frontend || !frontend.language || !frontend.framework) {
      return res.status(400).json({
        success: false,
        error: 'Frontend configuration is required'
      });
    }
    
    if (!backend || !backend.language || !backend.framework) {
      return res.status(400).json({
        success: false,
        error: 'Backend configuration is required'
      });
    }
    
    if (progressKey) {
      initProgress(progressKey, {
        status: 'pending',
        statusMessage: 'Preparing to create project',
        completion: 0
      });
    }

    // Create project directory path
    const projectPath = resolveProjectPath(name);

    if (await pathExists(projectPath)) {
      const isDirectory = await dirExists(projectPath);
      let errorMessage = 'Project path already exists. Choose a different name.';

      if (isDirectory) {
        const entries = await fs.readdir(projectPath);
        errorMessage = entries.length
          ? 'Project folder already exists and is not empty. Delete it or choose a different name.'
          : 'Project folder already exists. Delete it or choose a different name.';
      } else {
        errorMessage = 'Project path already exists and is not a directory.';
      }

      if (progressKey) {
        failProgress(progressKey, errorMessage);
      }

      return res.status(409).json({ success: false, error: errorMessage });
    }
    
    const projectConfig = {
      name: name.trim(),
      description: description?.trim() || '',
      frontend,
      backend,
      path: projectPath
    };
    
    const gitSettings = await getGitSettings();
    const portSettings = await getPortSettings();

    // Determine if this is a "connect existing repo" flow
    const gitCloudMode = safeTrim(req.body.gitCloudMode);
    const gitRemoteUrl = safeTrim(req.body.gitRemoteUrl);
    const isCloneFlow = gitCloudMode === 'connect' && Boolean(gitRemoteUrl);
    const requireGitIgnoreApproval = req.body?.requireGitIgnoreApproval !== false;
    const gitIgnoreApproved = req.body?.gitIgnoreApproved === true;

    const skipScaffolding =
      (process.env.E2E_SKIP_SCAFFOLDING === 'true' || process.env.E2E_SKIP_SCAFFOLDING === '1') &&
      process.env.NODE_ENV !== 'production';

    if (skipScaffolding) {
      await fs.mkdir(projectPath, { recursive: true });

      const dbProjectData = {
        name: name.trim(),
        description: description?.trim() || '',
        language: `${frontend.language},${backend.language}`,
        framework: `${frontend.framework},${backend.framework}`,
        path: projectPath,
        frontendPort: null,
        backendPort: null
      };

      const project = await createProject(dbProjectData);

      if (isCloneFlow && project?.id) {
        const gitProvider = safeTrim(req.body.gitProvider) || safeTrim(gitSettings?.provider) || 'github';
        const gitDefaultBranch = safeTrim(req.body.gitDefaultBranch) || safeTrim(gitSettings?.defaultBranch) || 'main';
        const gitUsername = safeTrim(req.body.gitUsername) || safeTrim(gitSettings?.username) || '';
        const gitToken = safeTrim(req.body.gitToken) || '';
        await saveProjectGitSettings(project.id, {
          workflow: 'cloud',
          provider: gitProvider,
          remoteUrl: stripGitCredentials(gitRemoteUrl),
          defaultBranch: gitDefaultBranch,
          ...(gitUsername ? { username: gitUsername } : {}),
          ...(gitToken ? { token: gitToken } : {})
        });
      }

      const enhancedProject = {
        ...project,
        frontend,
        backend,
        path: projectPath
      };

      res.status(201).json({
        success: true,
        project: enhancedProject,
        processes: null,
        progress: null,
        message: 'Project created successfully'
      });

      if (progressKey) {
        completeProgress(progressKey, 'Project created successfully');
      }

      return;
    }

    let result;

    if (isCloneFlow) {
      // Clone existing remote repository instead of scaffolding
      const gitProvider = safeTrim(req.body.gitProvider) || safeTrim(gitSettings?.provider) || 'github';
      const gitDefaultBranch = safeTrim(req.body.gitDefaultBranch) || safeTrim(gitSettings?.defaultBranch) || 'main';
      const gitUsername = safeTrim(req.body.gitUsername) || safeTrim(gitSettings?.username) || '';
      const gitToken = safeTrim(req.body.gitToken) || '';

      const cloneOptions = {
        remoteUrl: gitRemoteUrl,
        provider: gitProvider,
        defaultBranch: gitDefaultBranch,
        username: gitUsername,
        token: gitToken,
        authMethod: 'pat'
      };

      if (progressKey) {
        result = await cloneProjectFromRemote(projectConfig, {
          cloneOptions,
          portSettings,
          onProgress: (payload) => updateProgress(progressKey, payload),
          requireGitIgnoreApproval,
          gitIgnoreApproved
        });
      } else {
        result = await cloneProjectFromRemote(projectConfig, {
          cloneOptions,
          portSettings,
          requireGitIgnoreApproval,
          gitIgnoreApproved
        });
      }
    } else {
      // Generate a new project with scaffolding
      if (progressKey) {
        result = await createProjectWithFiles(projectConfig, {
          gitSettings,
          portSettings,
          onProgress: (payload) => updateProgress(progressKey, payload)
        });
      } else {
        result = await createProjectWithFiles(projectConfig, { gitSettings, portSettings });
      }
    }

    const awaitingSetup = Boolean(result?.setupRequired);
    const processPorts = extractProcessPorts(result.processes);
    
    // Save to database with enhanced data
    const dbProjectData = {
      name: name.trim(),
      description: description?.trim() || '',
      language: `${frontend.language},${backend.language}`,
      framework: `${frontend.framework},${backend.framework}`,
      path: projectPath,
      frontendPort: processPorts.frontendPort,
      backendPort: processPorts.backendPort
    };
    
    const project = await createProject(dbProjectData);

    // Save project git settings when cloning from a remote
    if (isCloneFlow && project?.id) {
      const gitProvider = safeTrim(req.body.gitProvider) || safeTrim(gitSettings?.provider) || 'github';
      const gitDefaultBranch = result.branch || safeTrim(req.body.gitDefaultBranch) || safeTrim(gitSettings?.defaultBranch) || 'main';
      const gitUsername = safeTrim(req.body.gitUsername) || safeTrim(gitSettings?.username) || '';
      const gitToken = safeTrim(req.body.gitToken) || '';
      await saveProjectGitSettings(project.id, {
        workflow: 'cloud',
        provider: gitProvider,
        remoteUrl: result.remote || stripGitCredentials(gitRemoteUrl),
        defaultBranch: gitDefaultBranch,
        ...(gitUsername ? { username: gitUsername } : {}),
        ...(gitToken ? { token: gitToken } : {})
      });
    }
    
    // Store process information
    if (result.processes && !awaitingSetup) {
      storeRunningProcesses(project.id, result.processes, 'running', { launchType: 'auto' });
    }
    
    // Enhance project data with scaffolding info
    const enhancedProject = {
      ...project,
      frontend,
      backend,
      path: projectPath
    };
    
    res.status(201).json({
      success: true,
      project: enhancedProject,
      processes: result.processes,
      progress: result.progress,
      message: awaitingSetup
        ? 'Project cloned. Waiting for .gitignore approval before installing dependencies.'
        : (isCloneFlow ? 'Project cloned and started successfully' : 'Project created and started successfully'),
      setupRequired: awaitingSetup,
      gitIgnoreSuggestion: result?.gitIgnoreSuggestion || null
    });

    if (progressKey) {
      if (awaitingSetup && result?.progress) {
        updateProgress(progressKey, result.progress);
      } else {
        completeProgress(progressKey, 'Project created successfully');
      }
    }
  } catch (error) {
    console.error('Error creating project:', error);
    const errorMessage = error.message || 'Failed to create project';
    if (progressKey) {
      failProgress(progressKey, errorMessage);
    }

    if (isCloneTargetNotEmptyError(error)) {
      return res.status(409).json({
        success: false,
        error: 'Project folder already exists and is not empty. Delete it or choose a different name.'
      });
    }

    if (error.code === 'GIT_MISSING') {
      return res.status(500).json({
        success: false,
        error: errorMessage
      });
    }

    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        error: errorMessage
      });
    }
    
    // Handle unique constraint errors
    if (error.message && error.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({
        success: false,
        error: 'Project name already exists'
      });
    }

    const errorResponse = {
      success: false,
      error: 'Failed to create project'
    };

    attachTestErrorDetails(error, errorResponse);
    
    res.status(500).json(errorResponse);
  }
});

// POST /api/projects/:id/setup - Install dependencies and start after clone
router.post('/:id/setup', async (req, res) => {
  try {
    const { id } = req.params;
    const project = await getProject(id);

    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    if (!project.path) {
      return res.status(400).json({
        success: false,
        error: 'Project path is not configured.'
      });
    }

    await installDependencies(project.path);

    const portSettings = await getPortSettings();
    const portOverrides = buildPortOverrideOptions(portSettings);
    const startResult = await startProject(project.path, portOverrides);

    if (startResult.success && startResult.processes) {
      storeRunningProcesses(project.id, startResult.processes, 'running', { launchType: 'auto' });
      await updateProjectPorts(project.id, extractProcessPorts(startResult.processes));
    }

    res.json({
      success: true,
      processes: startResult.processes,
      message: 'Project setup completed successfully'
    });
  } catch (error) {
    console.error('Error completing project setup:', error);
    res.status(500).json({
      success: false,
      error: error?.message || 'Failed to complete project setup'
    });
  }
});

// PUT /api/projects/:id - Update project
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, language, framework, path: projectPath } = req.body;
    
    // Validation
    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Project name is required'
      });
    }

    const existingProject = await getProject(id);
    if (!existingProject) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    const requestIncludesPath = Boolean(req.body && Object.prototype.hasOwnProperty.call(req.body, 'path'));
    let nextProjectPath = existingProject.path;

    if (requestIncludesPath) {
      if (projectPath === null || projectPath === undefined) {
        nextProjectPath = null;
      } else if (typeof projectPath === 'string') {
        const trimmed = projectPath.trim();

        if (!trimmed) {
          nextProjectPath = null;
        } else if (hasUnsafeCommandCharacters(trimmed)) {
          return res.status(400).json({
            success: false,
            error: 'Invalid project path'
          });
        } else if (!isWithinManagedProjectsRoot(trimmed)) {
          return res.status(400).json({
            success: false,
            error: 'Invalid project path'
          });
        } else {
          nextProjectPath = trimmed;
        }
      } else {
        return res.status(400).json({
          success: false,
          error: 'Invalid project path'
        });
      }
    }
    
    const updates = buildProjectUpdatePayload({
      name,
      description,
      language,
      framework,
      path: nextProjectPath
    });
    
    const project = await updateProject(id, updates);
    
    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }
    
    res.json({
      success: true,
      project,
      message: 'Project updated successfully'
    });
  } catch (error) {
    console.error('Error updating project:', error);
    
    if (error.message && error.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({
        success: false,
        error: 'Project name already exists'
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to update project'
    });
  }
});

// Project runtime/process, file, and git routes live in ./projects/routes.*.js

// DELETE /api/projects/:id - Delete project
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Resolve project by numeric id, name, or slug before deletion
    const project = await findProjectByIdentifier(id);
    
    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    if (requireDestructiveConfirmation(req, res)) {
      return;
    }

    const projectId = project.id;

    // Stop project first if running to free ports and file handles
    await terminateRunningProcesses(projectId, {
      project,
      waitForRelease: true,
      releaseDelay: process.env.NODE_ENV === 'test' ? 50 : 2000,
      dropEntry: true,
      forcePorts: true
    });
    
    // Delete from database
    const success = await deleteProject(project.id);
    
    if (!success) {
      return res.status(500).json({
        success: false,
        error: 'Failed to delete project from database'
      });
    }
    
    // Clean up filesystem with retry logic for Windows
    const cleanupTargets = buildCleanupTargets(project);
    const waitForCleanupParam = safeTrim(req.query?.waitForCleanup).toLowerCase();
    const waitForCleanup = waitForCleanupParam !== 'false' && waitForCleanupParam !== '0';

    const runCleanup = async () => {
      const result = { success: true, failures: [] };
      try {
        const fs = await getFsModule();

        const cleanupFailures = [];
        for (const target of cleanupTargets) {
          try {
            await cleanupDirectoryExecutor(fs, target);
            console.log(`✅ Project directory cleaned up: ${target}`);
          } catch (targetError) {
            cleanupFailures.push({ target, error: targetError });
          }
        }

        if (cleanupFailures.length > 0) {
          const firstError = cleanupFailures[0]?.error;
          const message = firstError?.message || 'cleanup failed';
          console.warn('⚠️ Warning: Could not clean up project directories:', cleanupTargets, message);
          result.success = false;
          result.failures = cleanupFailures.map((failure) => ({
            target: failure.target,
            code: failure.error?.code || null,
            message: failure.error?.message || 'cleanup failed'
          }));
        }
      } catch (fsError) {
        console.warn('⚠️ Warning: Could not clean up project directories:', cleanupTargets, fsError.message);
        // Don't fail the entire operation if filesystem cleanup fails
        // The project is already deleted from database
        result.success = false;
        result.failures = [{
          target: null,
          code: fsError?.code || null,
          message: fsError?.message || 'cleanup failed'
        }];
      }

      return result;
    };

    const shouldWaitForCleanup = process.env.NODE_ENV === 'test' || waitForCleanup;
    let cleanupResult = null;

    if (shouldWaitForCleanup) {
      cleanupResult = await runCleanup();
    } else {
      setImmediate(() => {
        void runCleanup();
      });
    }

    const responsePayload = {
      success: true,
      message: 'Project deleted successfully'
    };

    if (cleanupResult) {
      responsePayload.cleanup = cleanupResult;
      if (!cleanupResult.success) {
        responsePayload.message = 'Project deleted, but cleanup failed. See cleanup details.';
      }
    }

    res.json(responsePayload);
  } catch (error) {
    console.error('Error deleting project:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete project'
    });
  }
});

// POST /api/projects/:id/cleanup - Retry filesystem cleanup
router.post('/:id/cleanup', async (req, res) => {
  try {
    const { id } = req.params;
    const project = await findProjectByIdentifier(id);
    const requestedTargets = Array.isArray(req.body?.targets) ? req.body.targets : [];
    const manualTargets = new Set();
    for (const target of requestedTargets) {
      addCleanupTarget(manualTargets, target);
    }
    const hasManualTargets = manualTargets.size > 0;

    if (!project && !hasManualTargets) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    if (requireDestructiveConfirmation(req, res)) {
      return;
    }

    const cleanupTargets = hasManualTargets
      ? [...manualTargets].sort((a, b) => b.length - a.length)
      : buildCleanupTargets(project);
    if (!cleanupTargets.length) {
      return res.status(400).json({
        success: false,
        error: 'No cleanup targets available'
      });
    }
    const fs = await getFsModule();
    const cleanupFailures = [];

    for (const target of cleanupTargets) {
      try {
        await cleanupDirectoryExecutor(fs, target);
      } catch (targetError) {
        cleanupFailures.push({
          target,
          code: targetError?.code || null,
          message: targetError?.message || 'cleanup failed'
        });
      }
    }

    const cleanup = {
      success: cleanupFailures.length === 0,
      failures: cleanupFailures
    };

    res.json({
      success: true,
      cleanup,
      message: cleanup.success
        ? 'Cleanup completed successfully'
        : 'Cleanup failed. See cleanup details.'
    });
  } catch (error) {
    console.error('Error retrying cleanup:', error);
    res.status(500).json({
      success: false,
      error: error?.message || 'Failed to retry cleanup'
    });
  }
});

export {
  killProcessesOnPort,
  killProcessTree,
  findPidsByPort,
  isProtectedPid,
  cleanupDirectoryWithRetry,
  __processManager,
  __projectRoutesInternals
} from './projects/testingExports.js';

export {
  buildCloneUrl,
  enqueueInstallJobs,
  stripGitCredentials,
  extractRepoName,
  assertProjectPathAvailable,
  pathExists,
  dirExists,
  fileExists,
  serializeJob,
  copyDirectoryRecursive
};

export default router;