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
import { enqueueInstallJobs } from './projects/installJobs.js';
import {
  copyDirectoryRecursive,
  cleanupExistingImportTarget,
  prepareImportTargetPath,
  copyProjectFilesWithFallback
} from './projects/fileOps.js';
import {
  normalizeImportMethod,
  normalizeImportMode,
  safeTrim,
  extractRepoName,
  assertDirectoryExists,
  assertProjectPathAvailable,
  pathExists,
  dirExists,
  fileExists,
  isCloneTargetNotEmptyError,
  resolveImportProjectName,
  resolveImportPayloadConfig,
  ensureLocalImportGitRepository,
  importProjectFromGit,
  importProjectFromLocal,
  applyImportPostProcessing,
  resolveImportGitSettings,
  normalizeProjectDates,
  serializeJob
} from './projects/helpers.js';

const router = express.Router();

// buildCloneUrl and stripGitCredentials imported from ../utils/gitUrl.js

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

    const projectName = resolveImportProjectName({ payload, importMethod });

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

    const {
      frontendConfig,
      backendConfig,
      description,
      gitProvider
    } = resolveImportPayloadConfig(payload);
    let projectPath = null;
    let gitRemoteUrl = null;
    let gitDefaultBranch = null;
    let globalGitSettings = null;

    try {
      globalGitSettings = await getGitSettings();
    } catch (error) {
      console.warn('Failed to load global git settings for import:', error?.message || error);
      globalGitSettings = null;
    }

    if (importMethod === 'local') {
      const localImport = await importProjectFromLocal({
        payload,
        importMode,
        projectName,
        assertDirectoryExistsFn: assertDirectoryExists,
        isWithinManagedProjectsRootFn: isWithinManagedProjectsRoot,
        resolveProjectPathFn: resolveProjectPath,
        prepareTargetPathFn: async (targetPath) => prepareImportTargetPath(targetPath, {
          pathExistsFn: pathExists,
          cleanupExistingImportTargetFn: cleanupExistingImportTarget
        }),
        copyProjectFilesWithFallbackFn: (localPath, targetPath) => copyProjectFilesWithFallback(localPath, targetPath, {
          cpFn: fs.cp,
          copyDirectoryRecursiveFn: copyDirectoryRecursive
        })
      });

      createdProjectPath = localImport.createdProjectPath;
      projectPath = localImport.projectPath;
    } else {
      const gitImport = await importProjectFromGit({
        payload,
        projectName,
        gitProvider,
        resolveProjectPathFn: resolveProjectPath,
        prepareTargetPathFn: async (targetPath) => prepareImportTargetPath(targetPath, {
          pathExistsFn: pathExists,
          cleanupExistingImportTargetFn: cleanupExistingImportTarget
        }),
        buildCloneUrlFn: buildCloneUrl,
        getProjectsDirFn: getProjectsDir,
        mkdirFn: fs.mkdir,
        runGitCommandFn: runGitCommand,
        getCurrentBranchFn: getCurrentBranch
      });

      createdProjectPath = gitImport.createdProjectPath;
      gitRemoteUrl = gitImport.gitRemoteUrl;
      gitDefaultBranch = gitImport.gitDefaultBranch;
      projectPath = gitImport.projectPath;
    }

    await ensureLocalImportGitRepository({
      importMethod,
      projectPath,
      payload,
      globalGitSettings,
      dirExistsFn: dirExists,
      ensureGitRepositoryFn: ensureGitRepository,
      configureGitUserFn: configureGitUser,
      ensureInitialCommitFn: ensureInitialCommit
    });

    const {
      structureResult,
      compatibilityResult
    } = await applyImportPostProcessing({
      projectPath,
      applyStructureFix,
      applyCompatibilityChanges,
      applyProjectStructureFn: applyProjectStructure,
      applyCompatibilityFn: applyCompatibility
    });

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
        importMethod,
        payload,
        globalSettings: globalGitSettings,
        gitRemoteUrl,
        gitDefaultBranch,
        fallbackProvider: gitProvider
      });

      await saveProjectGitSettings(project.id, importGitSettings);

      if (importGitSettings.workflow === 'cloud' && importGitSettings.remoteUrl) {
        const remoteLookupResult = await runGitCommand(projectPath, ['remote', 'get-url', 'origin'], { allowFailure: true });
        const stdout = typeof remoteLookupResult?.stdout === 'string' ? remoteLookupResult.stdout : '';
        const code = Number.isInteger(remoteLookupResult?.code) ? remoteLookupResult.code : 1;
        const existingRemote = stdout.trim();
        if (!(code === 0 && existingRemote === importGitSettings.remoteUrl)) {
          if (importMethod === 'local' && (code !== 0 || !existingRemote)) {
            await runGitCommand(projectPath, ['remote', 'add', 'origin', importGitSettings.remoteUrl]);
          } else {
            try {
              const setUrlResult = await runGitCommand(projectPath, ['remote', 'set-url', 'origin', importGitSettings.remoteUrl], {});
              const setUrlCode = Number.isInteger(setUrlResult?.code) ? setUrlResult.code : null;
              if (setUrlCode !== null && setUrlCode !== 0) {
                await runGitCommand(projectPath, ['remote', 'add', 'origin', importGitSettings.remoteUrl]);
              }
            } catch {
              await runGitCommand(projectPath, ['remote', 'add', 'origin', importGitSettings.remoteUrl]);
            }
          }
        } else {
          // no-op
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
  resolveImportProjectName,
  assertProjectPathAvailable,
  pathExists,
  dirExists,
  fileExists,
  serializeJob,
  copyDirectoryRecursive
};

export default router;