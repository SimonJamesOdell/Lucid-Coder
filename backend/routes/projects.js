import express from 'express';
import path from 'path';
import {
  createProject,
  getAllProjects,
  getProject,
  getProjectByName,
  updateProject,
  deleteProject,
  getGitSettings,
  getPortSettings
} from '../database.js';
import { createProjectWithFiles } from '../services/projectScaffolding.js';
import { resolveProjectPath } from '../utils/projectPaths.js';
import {
  initProgress,
  updateProgress,
  completeProgress,
  failProgress,
  attachProgressStream,
  getProgressSnapshot
} from '../services/progressTracker.js';
import {
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

const router = express.Router();

registerProjectProcessRoutes(router);
registerProjectFileRoutes(router);
registerProjectGitRoutes(router);

// GET /api/projects - Get all projects
router.get('/', async (req, res) => {
  try {
    const projects = await getAllProjects();
    res.json({
      success: true,
      projects: projects || []
    });
  } catch (error) {
    console.error('Error fetching projects:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch projects'
    });
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
      project
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
    
    const projectConfig = {
      name: name.trim(),
      description: description?.trim() || '',
      frontend,
      backend,
      path: projectPath
    };
    
    const gitSettings = await getGitSettings();
    const portSettings = await getPortSettings();

    // Create project with full scaffolding
    let scaffoldResult;
    if (progressKey) {
      scaffoldResult = await createProjectWithFiles(projectConfig, {
        gitSettings,
        portSettings,
        onProgress: (payload) => updateProgress(progressKey, payload)
      });
    } else {
      scaffoldResult = await createProjectWithFiles(projectConfig, { gitSettings, portSettings });
    }

    const processPorts = extractProcessPorts(scaffoldResult.processes);
    
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
    
    // Store process information
    if (scaffoldResult.processes) {
      storeRunningProcesses(project.id, scaffoldResult.processes, 'running', { launchType: 'auto' });
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
      processes: scaffoldResult.processes,
      progress: scaffoldResult.progress,
      message: 'Project created and started successfully'
    });

    if (progressKey) {
      completeProgress(progressKey, 'Project created successfully');
    }
  } catch (error) {
    console.error('Error creating project:', error);
    if (progressKey) {
      failProgress(progressKey, error.message || 'Failed to create project');
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
      dropEntry: true
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
      }
    } catch (fsError) {
      console.warn('⚠️ Warning: Could not clean up project directories:', cleanupTargets, fsError.message);
      // Don't fail the entire operation if filesystem cleanup fails
      // The project is already deleted from database
    }
    
    res.json({
      success: true,
      message: 'Project deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting project:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete project'
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

export default router;