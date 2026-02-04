import fs from 'fs/promises';
import path from 'path';
import {
  getPortSettings,
  getProject,
  updateProjectPorts
} from '../../database.js';
import { startProject } from '../../services/projectScaffolding.js';
import { generateBackendFiles } from '../../services/projectScaffolding/generate.js';
import { sanitizeProjectName } from '../../services/projectScaffolding/files.js';
import { startJob } from '../../services/jobRunner.js';
import { hasUnsafeCommandCharacters } from './cleanup.js';
import { isWithinManagedProjectsRoot } from './cleanup.js';
import {
  buildLogEntries,
  buildPortOverrideOptions,
  ensurePortsFreed,
  extractProcessPorts,
  getProjectPortHints,
  getPlatformImpl,
  getRunningProcessEntry,
  getStoredProjectPorts,
  hasLiveProcess,
  parseSinceParam,
  resolveActivityState,
  resolveLastKnownPort,
  runningProcesses,
  sanitizeProcessSnapshot,
  storeRunningProcesses,
  terminateRunningProcesses
} from './processManager.js';

const DEFAULT_FRONTEND_PORT_BASE = Number(process.env.LUCIDCODER_PROJECT_FRONTEND_PORT_BASE) || 5100;
const DEFAULT_BACKEND_PORT_BASE = Number(process.env.LUCIDCODER_PROJECT_BACKEND_PORT_BASE) || 5500;

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

const backendEntrypointExists = async (projectPath) => {
  if (!projectPath) {
    return false;
  }
  const backendPath = path.join(projectPath, 'backend');
  const candidates = [
    'package.json',
    'app.py',
    'requirements.txt',
    'pyproject.toml',
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'go.mod',
    'Cargo.toml',
    'composer.json',
    'Gemfile',
    'Package.swift'
  ];

  for (const candidate of candidates) {
    if (await fileExists(path.join(backendPath, candidate))) {
      return true;
    }
  }
  return false;
};

export function registerProjectProcessRoutes(router) {
  if (process.env.NODE_ENV === 'test') {
    router.get('/__debug/running-processes', (req, res) => {
      res.json({
        entries: [...runningProcesses.entries()]
      });
    });
  }

  router.get('/:id/processes', async (req, res) => {
    try {
      const { id } = req.params;
      const project = await getProject(id);

      if (!project) {
        return res.status(404).json({ success: false, error: 'Project not found' });
      }

      const { processes, state: processState, snapshotVisible, launchType } = getRunningProcessEntry(id);
      let effectiveState = processState;
      let exposeSnapshot = snapshotVisible;

      if (processes && processState === 'running') {
        const hasLiveChildren = hasLiveProcess(processes.frontend) || hasLiveProcess(processes.backend);
        if (!hasLiveChildren) {
          storeRunningProcesses(id, processes, 'stopped', { exposeSnapshot: false });
          effectiveState = 'stopped';
          exposeSnapshot = false;
        }
      }

      const fullSnapshot = {
        frontend: sanitizeProcessSnapshot(processes?.frontend),
        backend: sanitizeProcessSnapshot(processes?.backend)
      };
      const shouldExposeSnapshot = effectiveState === 'running' || exposeSnapshot === true;
      const exposedSnapshot = shouldExposeSnapshot
        ? fullSnapshot
        : { frontend: null, backend: null };
      const hasExposedProcesses = Boolean(exposedSnapshot.frontend || exposedSnapshot.backend);
      const activityState = resolveActivityState(effectiveState, hasExposedProcesses);
      const running = effectiveState === 'running' || (effectiveState === 'stopped' && exposeSnapshot === true);
      const isRunning = effectiveState === 'running';
      const storedPorts = getStoredProjectPorts(project);
      const portHints = getProjectPortHints(project);
      const lastKnownPorts = {
        frontend: resolveLastKnownPort(fullSnapshot.frontend?.port, storedPorts.frontend, portHints.frontend),
        backend: resolveLastKnownPort(fullSnapshot.backend?.port, storedPorts.backend, portHints.backend)
      };
      const activePorts = {
        frontend: exposedSnapshot.frontend?.port ?? lastKnownPorts.frontend,
        backend: exposedSnapshot.backend?.port ?? lastKnownPorts.backend
      };
      const hasBackend = await backendEntrypointExists(project.path);

      console.log('[process-status]', id, {
        isRunning,
        frontend: exposedSnapshot.frontend,
        backend: exposedSnapshot.backend,
        snapshotVisible: exposeSnapshot,
        state: effectiveState
      });

      res.json({
        success: true,
        projectId: project.id,
        isRunning,
        running,
        activity: activityState,
        processes: exposedSnapshot,
        ports: {
          active: activePorts,
          stored: storedPorts,
          preferred: portHints
        },
        lastKnownPorts,
        capabilities: {
          backend: {
            exists: hasBackend
          }
        }
      });
    } catch (error) {
      console.error('Error fetching process status:', error);
      res.status(500).json({ success: false, error: 'Failed to load process status' });
    }
  });

  router.get('/:id/status', async (req, res) => {
    try {
      const { id } = req.params;
      const project = await getProject(id);

      if (!project) {
        return res.status(404).json({
          success: false,
          error: 'Project not found'
        });
      }

      const { processes } = getRunningProcessEntry(id);

      res.json({
        success: true,
        status: {
          project,
          processes: processes || null,
          running: !!processes
        }
      });
    } catch (error) {
      console.error('Error fetching project status:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch project status'
      });
    }
  });

  router.get('/:id/processes/logs', async (req, res) => {
    try {
      const { id } = req.params;
      const { type, since } = req.query;
      const project = await getProject(id);

      if (!project) {
        return res.status(404).json({
          success: false,
          error: 'Project not found'
        });
      }

      if (type && type !== 'frontend' && type !== 'backend') {
        return res.status(400).json({
          success: false,
          error: 'type must be one of frontend, backend'
        });
      }

      const sinceTimestamp = parseSinceParam(since);
      if (since && !sinceTimestamp) {
        return res.status(400).json({
          success: false,
          error: 'since must be a valid timestamp'
        });
      }

      const { processes } = getRunningProcessEntry(id);

      const buildResponse = (key) => buildLogEntries(processes?.[key], sinceTimestamp);

      const logsPayload = {};
      if (!type || type === 'frontend') {
        logsPayload.frontend = buildResponse('frontend');
      }
      if (!type || type === 'backend') {
        logsPayload.backend = buildResponse('backend');
      }

      res.json({
        success: true,
        project: {
          id: project.id,
          name: project.name
        },
        logs: logsPayload
      });
    } catch (error) {
      console.error('Error fetching process logs:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch process logs'
      });
    }
  });

  // POST /api/projects/:id/start - Start project development servers
  router.post('/:id/start', async (req, res) => {
    try {
      const { id } = req.params;
      const project = await getProject(id);

      if (!project) {
        return res.status(404).json({
          success: false,
          error: 'Project not found'
        });
      }

      // Check if project has a valid path
      if (!project.path) {
        return res.status(400).json({
          success: false,
          error: 'Project path not found. This project may have been created before path tracking was implemented. Please re-import or recreate the project.'
        });
      }

      if (!isWithinManagedProjectsRoot(project.path)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid project path'
        });
      }

      const skipScaffolding =
        (process.env.E2E_SKIP_SCAFFOLDING === 'true' || process.env.E2E_SKIP_SCAFFOLDING === '1') &&
        process.env.NODE_ENV !== 'production';

      if (skipScaffolding && !project.frontendPort && !project.backendPort) {
        return res.json({
          success: true,
          message: 'Project selected (E2E skip scaffolding)',
          processes: null
        });
      }

      // Check if already running
      const { processes: existingProcesses, state: existingState, launchType: existingLaunchType } = getRunningProcessEntry(id);
      const isExplicitlyRunning = existingProcesses && existingState === 'running' && existingLaunchType !== 'auto';
      if (isExplicitlyRunning) {
        return res.json({
          success: true,
          message: 'Project is already running',
          processes: existingProcesses
        });
      }

      // Start the project
      const portHints = getProjectPortHints(project);
      const portSettings = await getPortSettings();
      const portOverrides = buildPortOverrideOptions(portSettings);
      const resolvedFrontendBase = Number.isInteger(portOverrides.frontendPortBase)
        ? portOverrides.frontendPortBase
        : DEFAULT_FRONTEND_PORT_BASE;
      const resolvedBackendBase = Number.isInteger(portOverrides.backendPortBase)
        ? portOverrides.backendPortBase
        : DEFAULT_BACKEND_PORT_BASE;
      const forceFrontendReassignment = resolvedFrontendBase !== DEFAULT_FRONTEND_PORT_BASE;
      const forceBackendReassignment = resolvedBackendBase !== DEFAULT_BACKEND_PORT_BASE;
      const startResult = await startProject(project.path, {
        frontendPort: forceFrontendReassignment ? null : portHints.frontend,
        backendPort: forceBackendReassignment ? null : portHints.backend,
        ...portOverrides
      });

      if (startResult.success) {
        storeRunningProcesses(id, startResult.processes, 'running', { launchType: 'manual' });
        await updateProjectPorts(project.id, extractProcessPorts(startResult.processes));
      }

      res.json({
        success: true,
        processes: startResult.processes,
        message: 'Project started successfully'
      });
    } catch (error) {
      const message = error?.message || 'Failed to start project';
      console.error('Error starting project:', error);
      const status = message.includes('No frontend package.json') ? 400 : 500;
      const payload = {
        success: false,
        error: status === 500 ? 'Failed to start project' : message
      };
      if (process.env.NODE_ENV !== 'production') {
        payload.details = {
          message,
          name: error?.name || null,
          stack: error?.stack || null
        };
      }
      res.status(status).json(payload);
    }
  });

  // POST /api/projects/:id/stop - Stop project development servers
  router.post('/:id/stop', async (req, res) => {
    try {
      const { id } = req.params;
      const rawTarget = (req.query?.target ?? req.body?.target ?? null);
      const target = rawTarget === 'frontend' || rawTarget === 'backend' ? rawTarget : null;
      if (rawTarget && !target) {
        return res.status(400).json({
          success: false,
          error: 'Invalid stop target'
        });
      }

      // Check if project exists
      const project = await getProject(id);

      if (!project) {
        return res.status(404).json({
          success: false,
          error: 'Project not found'
        });
      }

      const stopResult = await terminateRunningProcesses(id, { project, target });

      if (!stopResult.wasRunning) {
        return res.json({
          success: true,
          message: target ? `${target} is not running` : 'Project is not running'
        });
      }

      res.json({
        success: true,
        message: target ? `${target} stopped successfully` : 'Project stopped successfully'
      });
    } catch (error) {
      console.error('Error stopping project:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to stop project'
      });
    }
  });

  // POST /api/projects/:id/backend/create - Scaffold a backend for an existing project
  router.post('/:id/backend/create', async (req, res) => {
    try {
      const { id } = req.params;
      const project = await getProject(id);

      if (!project) {
        return res.status(404).json({ success: false, error: 'Project not found' });
      }

      if (!project.path) {
        return res.status(400).json({
          success: false,
          error: 'Project path not found. Please re-import or recreate the project.'
        });
      }

      if (!isWithinManagedProjectsRoot(project.path)) {
        return res.status(400).json({ success: false, error: 'Invalid project path' });
      }

      if (await backendEntrypointExists(project.path)) {
        return res.status(409).json({ success: false, error: 'Backend already exists' });
      }

      const backendPath = path.join(project.path, 'backend');
      await fs.mkdir(backendPath, { recursive: true });

      const rawLanguages = typeof project.language === 'string' ? project.language : '';
      const rawFrameworks = typeof project.framework === 'string' ? project.framework : '';
      const [, backendLanguageRaw = ''] = rawLanguages.split(',');
      const [, backendFrameworkRaw = ''] = rawFrameworks.split(',');
      const backendLanguage = backendLanguageRaw.trim().toLowerCase() || 'javascript';
      const backendFramework = backendFrameworkRaw.trim().toLowerCase() || 'express';

      await generateBackendFiles(backendPath, {
        name: sanitizeProjectName(project.name || 'backend'),
        language: backendLanguage,
        framework: backendFramework
      });

      let installJob = null;
      try {
        if (await fileExists(path.join(backendPath, 'package.json'))) {
          installJob = await startJob({
            projectId: project.id,
            type: 'backend:install',
            displayName: 'Install backend dependencies',
            command: 'npm',
            args: ['install'],
            cwd: backendPath
          });
        }
      } catch (jobError) {
        console.warn('Failed to start backend install job:', jobError?.message || jobError);
      }

      return res.json({
        success: true,
        message: installJob
          ? 'Backend created. Installing dependencies.'
          : 'Backend created successfully',
        job: installJob
          ? {
              id: installJob.id,
              type: installJob.type,
              displayName: installJob.displayName,
              status: installJob.status,
              command: installJob.command,
              args: installJob.args,
              cwd: installJob.cwd,
              createdAt: installJob.createdAt
            }
          : null
      });
    } catch (error) {
      console.error('Error creating backend:', error);
      return res.status(500).json({ success: false, error: 'Failed to create backend' });
    }
  });

  // POST /api/projects/:id/restart - Restart project development servers
  router.post('/:id/restart', async (req, res) => {
    try {
      const { id } = req.params;
      const rawTarget = (req.query?.target ?? req.body?.target ?? null);
      const target = rawTarget === 'frontend' || rawTarget === 'backend' ? rawTarget : null;
      if (rawTarget && !target) {
        return res.status(400).json({
          success: false,
          error: 'Invalid restart target'
        });
      }
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
          error: 'Project path not found. Please re-import or recreate the project.'
        });
      }

      if (!isWithinManagedProjectsRoot(project.path)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid project path'
        });
      }

      const isWindows = getPlatformImpl() === 'win32';
      const shouldRecoverFrontendOnWindows = isWindows && target === 'backend';
      const { processes: preRestartProcesses } = getRunningProcessEntry(id);
      const frontendWasLiveBeforeRestart =
        shouldRecoverFrontendOnWindows && hasLiveProcess(preRestartProcesses?.frontend);

      if (target) {
        await terminateRunningProcesses(id, { project, target, waitForRelease: true });
      } else {
        await terminateRunningProcesses(id, { project });
      }

      const portHints = getProjectPortHints(project);
      const portSettings = await getPortSettings();
      const portOverrides = buildPortOverrideOptions(portSettings);
      const resolvedFrontendBase = Number.isInteger(portOverrides.frontendPortBase)
        ? portOverrides.frontendPortBase
        : DEFAULT_FRONTEND_PORT_BASE;
      const resolvedBackendBase = Number.isInteger(portOverrides.backendPortBase)
        ? portOverrides.backendPortBase
        : DEFAULT_BACKEND_PORT_BASE;
      const forceFrontendReassignment = resolvedFrontendBase !== DEFAULT_FRONTEND_PORT_BASE;
      const forceBackendReassignment = resolvedBackendBase !== DEFAULT_BACKEND_PORT_BASE;
      const startResult = await startProject(project.path, {
        frontendPort: forceFrontendReassignment ? null : portHints.frontend,
        backendPort: forceBackendReassignment ? null : portHints.backend,
        ...(target ? { target } : {}),
        ...portOverrides
      });

      if (startResult.success) {
        if (target) {
          const { processes: existingProcesses } = getRunningProcessEntry(id);
          const nextProcesses = {
            frontend: existingProcesses?.frontend || null,
            backend: existingProcesses?.backend || null
          };
          nextProcesses[target] = startResult.processes?.[target] || null;

          if (frontendWasLiveBeforeRestart && !hasLiveProcess(nextProcesses.frontend)) {
            try {
              const frontendRecovery = await startProject(project.path, {
                frontendPort: forceFrontendReassignment ? null : portHints.frontend,
                backendPort: forceBackendReassignment ? null : portHints.backend,
                target: 'frontend',
                ...portOverrides
              });

              if (frontendRecovery?.success) {
                nextProcesses.frontend = frontendRecovery.processes?.frontend || null;
              }
            } catch (recoveryError) {
              // Best-effort recovery only.
              console.warn('[restart] frontend recovery failed', recoveryError?.message || recoveryError);
            }
          }

          const hasAnyLive = hasLiveProcess(nextProcesses.frontend) || hasLiveProcess(nextProcesses.backend);
          storeRunningProcesses(id, nextProcesses, hasAnyLive ? 'running' : 'stopped', { launchType: 'manual' });

          const nextPorts = {};
          const startedPort = startResult.processes?.[target]?.port;
          if (Number.isInteger(startedPort) && startedPort > 0) {
            if (target === 'frontend') {
              nextPorts.frontendPort = startedPort;
            } else {
              nextPorts.backendPort = startedPort;
            }
          }

          const recoveredFrontendPort = nextProcesses.frontend?.port;
          if (frontendWasLiveBeforeRestart && Number.isInteger(recoveredFrontendPort) && recoveredFrontendPort > 0) {
            nextPorts.frontendPort = recoveredFrontendPort;
          }
          await updateProjectPorts(project.id, nextPorts);

          return res.json({
            success: true,
            message: `${target} restarted successfully`,
            processes: nextProcesses
          });
        }

        storeRunningProcesses(id, startResult.processes, 'running', { launchType: 'manual' });
        await updateProjectPorts(project.id, extractProcessPorts(startResult.processes));
      }

      res.json({
        success: true,
        message: 'Project restarted successfully',
        processes: startResult.processes || null
      });
    } catch (error) {
      const message = error?.message || 'Failed to restart project';
      console.error('Error restarting project:', error);
      const status = message.includes('No frontend package.json') ? 400 : 500;
      const payload = {
        success: false,
        error: status === 500 ? 'Failed to restart project' : message
      };
      if (process.env.NODE_ENV !== 'production') {
        payload.details = {
          message,
          name: error?.name || null,
          stack: error?.stack || null
        };
      }
      res.status(status).json(payload);
    }
  });

  // ensure imported symbols are referenced (keeps module stable)
  void ensurePortsFreed;
  void hasUnsafeCommandCharacters;
}
