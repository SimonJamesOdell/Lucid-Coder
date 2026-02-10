import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import path from 'path';
import fs from 'fs/promises';

const tmpRoot = path.join(process.cwd(), 'test-runtime-projects.coverage-100');

const ensureEmptyDir = async (dirPath) => {
  await fs.rm(dirPath, { recursive: true, force: true });
  await fs.mkdir(dirPath, { recursive: true });
};

const createAppWithRoutes = (routes) => {
  const app = express();
  app.use(express.json());
  app.use('/api/projects', routes);
  return app;
};

const loadProjectsRoutes = async (options = {}) => {
  vi.resetModules();

  const dbMock = {
    createProject: vi.fn().mockResolvedValue({ id: 1, name: 'test', path: '/tmp/test' }),
    getAllProjects: vi.fn(),
    getProject: vi.fn(),
    getProjectByName: vi.fn().mockResolvedValue(null),
    updateProject: vi.fn(),
    deleteProject: vi.fn(),
    getGitSettings: vi.fn().mockResolvedValue({ provider: 'github', defaultBranch: 'main', username: 'octo' }),
    getPortSettings: vi.fn().mockResolvedValue({}),
    updateProjectPorts: vi.fn().mockResolvedValue(undefined),
    saveProjectGitSettings: vi.fn().mockResolvedValue(undefined)
  };

  const scaffoldingMock = {
    createProjectWithFiles: vi.fn().mockResolvedValue({
      processes: {
        frontend: { pid: 11, port: 5173 },
        backend: { pid: 12, port: 3000 }
      },
      progress: null
    }),
    cloneProjectFromRemote: vi.fn().mockResolvedValue({
      processes: {
        frontend: { pid: 21, port: 5173 },
        backend: { pid: 22, port: 3000 }
      },
      progress: null,
      branch: 'main',
      remote: 'https://github.com/octo/repo.git'
    }),
    installDependencies: vi.fn().mockResolvedValue(undefined),
    startProject: vi.fn().mockResolvedValue({
      success: true,
      processes: {
        frontend: { pid: 31, port: 5173 },
        backend: { pid: 32, port: 3000 }
      }
    })
  };

  const progressMock = {
    initProgress: vi.fn(),
    updateProgress: vi.fn(),
    completeProgress: vi.fn(),
    failProgress: vi.fn(),
    attachProgressStream: vi.fn(),
    getProgressSnapshot: vi.fn()
  };

  const processManagerMock = {
    extractProcessPorts: vi.fn(() => ({ frontendPort: 5173, backendPort: 3000 })),
    storeRunningProcesses: vi.fn(),
    findProjectByIdentifier: vi.fn(),
    terminateRunningProcesses: vi.fn(),
    killProcessesOnPort: vi.fn(),
    killProcessTree: vi.fn(),
    findPidsByPort: vi.fn(),
    isProtectedPid: vi.fn(),
    ensurePortsFreed: vi.fn(),
    setExecCommandOverride: vi.fn(),
    resetExecCommandOverride: vi.fn(),
    getExecCommandImpl: vi.fn()
  };

  const cleanupMock = {
    buildCleanupTargets: vi.fn().mockReturnValue([]),
    cleanupDirectoryExecutor: vi.fn().mockResolvedValue(undefined),
    hasUnsafeCommandCharacters: vi.fn(() => false),
    isWithinManagedProjectsRoot: vi.fn(() => true)
  };

  vi.doMock('../database.js', () => dbMock);
  vi.doMock('../services/projectScaffolding.js', () => scaffoldingMock);
  vi.doMock('../services/progressTracker.js', () => progressMock);
  vi.doMock('../routes/projects/routes.files.js', () => ({ registerProjectFileRoutes: vi.fn() }));
  vi.doMock('../routes/projects/routes.git.js', () => ({ registerProjectGitRoutes: vi.fn() }));
  vi.doMock('../routes/projects/routes.processes.js', () => ({ registerProjectProcessRoutes: vi.fn() }));
  vi.doMock('../routes/projects/processManager.js', async () => {
    const actual = await vi.importActual('../routes/projects/processManager.js');
    return {
      ...actual,
      ...processManagerMock
    };
  });
  vi.doMock('../routes/projects/cleanup.js', async () => {
    const actual = await vi.importActual('../routes/projects/cleanup.js');
    return {
      ...actual,
      ...cleanupMock
    };
  });
  const internalsMock = {
    getFsModule: options?.internals?.getFsModule || vi.fn(async () => ({}))
  };

  vi.doMock('../routes/projects/internals.js', async () => {
    const actual = await vi.importActual('../routes/projects/internals.js');
    return { ...actual, ...internalsMock };
  });

  const { default: projectRoutes } = await import('../routes/projects.js');
  return {
    projectRoutes,
    dbMock,
    scaffoldingMock,
    progressMock,
    processManagerMock,
    cleanupMock,
    internalsMock
  };
};

const loadGitRoutes = async () => {
  vi.resetModules();
  vi.doMock('../routes/projects/routes.git.js', async () => await vi.importActual('../routes/projects/routes.git.js'));

  const dbMock = {
    deleteProjectGitSettings: vi.fn().mockResolvedValue(undefined),
    getGitSettings: vi.fn().mockResolvedValue({ provider: 'github', defaultBranch: 'main', workflow: 'local' }),
    getGitSettingsToken: vi.fn().mockResolvedValue(null),
    getProject: vi.fn(),
    getProjectGitSettings: vi.fn().mockResolvedValue(null),
    saveProjectGitSettings: vi.fn().mockResolvedValue(undefined)
  };

  const gitMock = {
    discardWorkingTree: vi.fn().mockResolvedValue(undefined),
    ensureGitRepository: vi.fn().mockResolvedValue(undefined),
    fetchRemote: vi.fn().mockResolvedValue(undefined),
    getAheadBehind: vi.fn().mockResolvedValue({ ahead: 0, behind: 0 }),
    getCurrentBranch: vi.fn().mockResolvedValue('main'),
    getRemoteUrl: vi.fn().mockResolvedValue(null),
    hasWorkingTreeChanges: vi.fn().mockResolvedValue(false),
    popBranchStash: vi.fn().mockResolvedValue(true),
    runGitCommand: vi.fn(),
    stashWorkingTree: vi.fn().mockResolvedValue('stash@{0}')
  };

  vi.doMock('../database.js', () => dbMock);
  vi.doMock('../utils/git.js', () => ({ __esModule: true, ...gitMock }));

  const { registerProjectGitRoutes } = await import('../routes/projects/routes.git.js');
  const router = express.Router();
  registerProjectGitRoutes(router);

  return { app: createAppWithRoutes(router), dbMock, gitMock };
};

describe('Projects routes coverage gaps', () => {
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    await ensureEmptyDir(tmpRoot);
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await fs.rm(tmpRoot, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  test('returns 409 when project path exists as a file', async () => {
    const projectsDir = path.join(tmpRoot, 'projects-file');
    await ensureEmptyDir(projectsDir);
    process.env.PROJECTS_DIR = projectsDir;

    const targetPath = path.join(projectsDir, 'file-project');
    await fs.writeFile(targetPath, 'not a dir');

    const { projectRoutes } = await loadProjectsRoutes();
    const app = createAppWithRoutes(projectRoutes);

    const response = await request(app)
      .post('/api/projects')
      .send({
        name: 'file-project',
        frontend: { language: 'javascript', framework: 'react' },
        backend: { language: 'javascript', framework: 'express' }
      });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/not a directory/i);
  });

  test('returns 409 with empty directory message', async () => {
    const projectsDir = path.join(tmpRoot, 'projects-empty');
    await ensureEmptyDir(projectsDir);
    process.env.PROJECTS_DIR = projectsDir;

    const targetPath = path.join(projectsDir, 'empty-project');
    await fs.mkdir(targetPath, { recursive: true });

    const { projectRoutes } = await loadProjectsRoutes();
    const app = createAppWithRoutes(projectRoutes);

    const response = await request(app)
      .post('/api/projects')
      .send({
        name: 'empty-project',
        frontend: { language: 'javascript', framework: 'react' },
        backend: { language: 'javascript', framework: 'express' }
      });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/already exists\. Delete it or choose a different name/i);
  });

  test('returns 409 with non-empty directory message', async () => {
    const projectsDir = path.join(tmpRoot, 'projects-nonempty');
    await ensureEmptyDir(projectsDir);
    process.env.PROJECTS_DIR = projectsDir;

    const targetPath = path.join(projectsDir, 'nonempty-project');
    await fs.mkdir(targetPath, { recursive: true });
    await fs.writeFile(path.join(targetPath, 'README.md'), '# hello');

    const { projectRoutes } = await loadProjectsRoutes();
    const app = createAppWithRoutes(projectRoutes);

    const response = await request(app)
      .post('/api/projects')
      .send({
        name: 'nonempty-project',
        frontend: { language: 'javascript', framework: 'react' },
        backend: { language: 'javascript', framework: 'express' }
      });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/not empty/i);
  });

  test('fails progress when project path exists with progress key', async () => {
    const projectsDir = path.join(tmpRoot, 'projects-progress');
    await ensureEmptyDir(projectsDir);
    process.env.PROJECTS_DIR = projectsDir;

    const targetPath = path.join(projectsDir, 'file-project');
    await fs.writeFile(targetPath, 'not a dir');

    const { projectRoutes, progressMock } = await loadProjectsRoutes();
    const app = createAppWithRoutes(projectRoutes);

    const response = await request(app)
      .post('/api/projects')
      .send({
        name: 'file-project',
        frontend: { language: 'javascript', framework: 'react' },
        backend: { language: 'javascript', framework: 'express' },
        progressKey: 'progress-1'
      });

    expect(response.status).toBe(409);
    expect(progressMock.failProgress).toHaveBeenCalledWith(
      'progress-1',
      expect.stringMatching(/not a directory/i)
    );
  });

  test('returns setupRequired payload and updates progress when awaiting gitignore approval', async () => {
    const projectsDir = path.join(tmpRoot, 'projects-awaiting');
    await ensureEmptyDir(projectsDir);
    process.env.PROJECTS_DIR = projectsDir;

    const { projectRoutes, scaffoldingMock, progressMock, dbMock, processManagerMock } = await loadProjectsRoutes();
    dbMock.createProject.mockResolvedValue({ id: 10, name: 'clone-project', path: path.join(projectsDir, 'clone-project') });

    scaffoldingMock.cloneProjectFromRemote.mockResolvedValue({
      processes: null,
      progress: { status: 'awaiting-user' },
      setupRequired: true,
      gitIgnoreSuggestion: { needed: true, entries: ['node_modules/'] },
      branch: 'main',
      remote: 'https://github.com/octo/repo.git'
    });

    const app = createAppWithRoutes(projectRoutes);

    const response = await request(app)
      .post('/api/projects')
      .send({
        name: 'clone-project',
        gitCloudMode: 'connect',
        gitRemoteUrl: 'https://github.com/octo/repo.git',
        frontend: { language: 'javascript', framework: 'react' },
        backend: { language: 'javascript', framework: 'express' },
        progressKey: 'pk-1'
      });

    expect(response.status).toBe(201);
    expect(response.body.setupRequired).toBe(true);
    expect(response.body.message).toMatch(/waiting for \.gitignore approval/i);
    expect(progressMock.updateProgress).toHaveBeenCalledWith('pk-1', { status: 'awaiting-user' });
    expect(processManagerMock.storeRunningProcesses).not.toHaveBeenCalled();
  });

  test('stores running processes when setup is not required', async () => {
    const projectsDir = path.join(tmpRoot, 'projects-processes');
    await ensureEmptyDir(projectsDir);
    process.env.PROJECTS_DIR = projectsDir;

    const { projectRoutes, processManagerMock, dbMock } = await loadProjectsRoutes();
    dbMock.createProject.mockResolvedValue({ id: 42, name: 'scaffold', path: path.join(projectsDir, 'scaffold') });

    const app = createAppWithRoutes(projectRoutes);

    const response = await request(app)
      .post('/api/projects')
      .send({
        name: 'scaffold',
        frontend: { language: 'javascript', framework: 'react' },
        backend: { language: 'javascript', framework: 'express' }
      });

    expect(response.status).toBe(201);
    expect(processManagerMock.storeRunningProcesses).toHaveBeenCalled();
  });

  test('returns 409 for clone target not empty errors', async () => {
    const projectsDir = path.join(tmpRoot, 'projects-clone-error');
    await ensureEmptyDir(projectsDir);
    process.env.PROJECTS_DIR = projectsDir;

    const { projectRoutes, scaffoldingMock } = await loadProjectsRoutes();
    const cloneError = new Error('fatal: already exists and is not an empty directory');
    cloneError.stderr = 'already exists and is not an empty directory';
    scaffoldingMock.cloneProjectFromRemote.mockRejectedValue(cloneError);

    const app = createAppWithRoutes(projectRoutes);

    const response = await request(app)
      .post('/api/projects')
      .send({
        name: 'clone-error',
        gitCloudMode: 'connect',
        gitRemoteUrl: 'https://github.com/octo/repo.git',
        frontend: { language: 'javascript', framework: 'react' },
        backend: { language: 'javascript', framework: 'express' }
      });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/not empty/i);
  });

  test('returns 500 when git is missing', async () => {
    const projectsDir = path.join(tmpRoot, 'projects-git-missing');
    await ensureEmptyDir(projectsDir);
    process.env.PROJECTS_DIR = projectsDir;

    const { projectRoutes, scaffoldingMock } = await loadProjectsRoutes();
    const error = new Error('git missing');
    error.code = 'GIT_MISSING';
    scaffoldingMock.createProjectWithFiles.mockRejectedValue(error);

    const app = createAppWithRoutes(projectRoutes);

    const response = await request(app)
      .post('/api/projects')
      .send({
        name: 'git-missing',
        frontend: { language: 'javascript', framework: 'react' },
        backend: { language: 'javascript', framework: 'express' }
      });

    expect(response.status).toBe(500);
    expect(response.body.error).toMatch(/git missing/i);
  });

  test('returns custom status codes from thrown errors', async () => {
    const projectsDir = path.join(tmpRoot, 'projects-statuscode');
    await ensureEmptyDir(projectsDir);
    process.env.PROJECTS_DIR = projectsDir;

    const { projectRoutes, scaffoldingMock } = await loadProjectsRoutes();
    const error = new Error('teapot');
    error.statusCode = 418;
    scaffoldingMock.createProjectWithFiles.mockRejectedValue(error);

    const app = createAppWithRoutes(projectRoutes);

    const response = await request(app)
      .post('/api/projects')
      .send({
        name: 'statuscode',
        frontend: { language: 'javascript', framework: 'react' },
        backend: { language: 'javascript', framework: 'express' }
      });

    expect(response.status).toBe(418);
    expect(response.body.error).toBe('teapot');
  });

  test('maps unique constraint errors to 400', async () => {
    const projectsDir = path.join(tmpRoot, 'projects-unique');
    await ensureEmptyDir(projectsDir);
    process.env.PROJECTS_DIR = projectsDir;

    const { projectRoutes, scaffoldingMock } = await loadProjectsRoutes();
    scaffoldingMock.createProjectWithFiles.mockRejectedValue(new Error('UNIQUE constraint failed: projects.name'));

    const app = createAppWithRoutes(projectRoutes);

    const response = await request(app)
      .post('/api/projects')
      .send({
        name: 'unique-error',
        frontend: { language: 'javascript', framework: 'react' },
        backend: { language: 'javascript', framework: 'express' }
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/already exists/i);
  });

  test('adds test error details for unhandled errors', async () => {
    const projectsDir = path.join(tmpRoot, 'projects-error-details');
    await ensureEmptyDir(projectsDir);
    process.env.PROJECTS_DIR = projectsDir;

    const { projectRoutes, scaffoldingMock } = await loadProjectsRoutes();
    scaffoldingMock.createProjectWithFiles.mockRejectedValue(new Error('boom'));

    const app = createAppWithRoutes(projectRoutes);

    const response = await request(app)
      .post('/api/projects')
      .send({
        name: 'details-error',
        frontend: { language: 'javascript', framework: 'react' },
        backend: { language: 'javascript', framework: 'express' }
      });

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Failed to create project');
    expect(response.body.details).toMatch(/boom/i);
  });

  test('setup route returns 404 when project missing', async () => {
    const { projectRoutes, dbMock } = await loadProjectsRoutes();
    dbMock.getProject.mockResolvedValue(null);

    const app = createAppWithRoutes(projectRoutes);

    const response = await request(app)
      .post('/api/projects/999/setup');

    expect(response.status).toBe(404);
    expect(response.body.error).toMatch(/not found/i);
  });

  test('setup route returns 400 when project path is missing', async () => {
    const { projectRoutes, dbMock } = await loadProjectsRoutes();
    dbMock.getProject.mockResolvedValue({ id: 1, path: null });

    const app = createAppWithRoutes(projectRoutes);

    const response = await request(app)
      .post('/api/projects/1/setup');

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/path is not configured/i);
  });

  test('setup route updates ports and stores processes', async () => {
    const projectsDir = path.join(tmpRoot, 'projects-setup');
    await ensureEmptyDir(projectsDir);

    const projectPath = path.join(projectsDir, 'setup-project');
    await fs.mkdir(projectPath, { recursive: true });

    const { projectRoutes, dbMock, scaffoldingMock, processManagerMock } = await loadProjectsRoutes();
    dbMock.getProject.mockResolvedValue({ id: 5, path: projectPath });
    scaffoldingMock.startProject.mockResolvedValue({
      success: true,
      processes: {
        frontend: { pid: 44, port: 5100 },
        backend: { pid: 45, port: 3200 }
      }
    });
    processManagerMock.extractProcessPorts.mockReturnValue({ frontendPort: 5100, backendPort: 3200 });

    const app = createAppWithRoutes(projectRoutes);

    const response = await request(app)
      .post('/api/projects/5/setup');

    expect(response.status).toBe(200);
    expect(dbMock.updateProjectPorts).toHaveBeenCalledWith(5, { frontendPort: 5100, backendPort: 3200 });
    expect(processManagerMock.storeRunningProcesses).toHaveBeenCalled();
  });

  test('setup route skips process storage when start result is incomplete', async () => {
    const projectsDir = path.join(tmpRoot, 'projects-setup-incomplete');
    await ensureEmptyDir(projectsDir);

    const projectPath = path.join(projectsDir, 'setup-incomplete');
    await fs.mkdir(projectPath, { recursive: true });

    const { projectRoutes, dbMock, scaffoldingMock, processManagerMock } = await loadProjectsRoutes();
    dbMock.getProject.mockResolvedValue({ id: 12, path: projectPath });
    scaffoldingMock.startProject.mockResolvedValue({ success: false, processes: null });

    const app = createAppWithRoutes(projectRoutes);

    const response = await request(app)
      .post('/api/projects/12/setup');

    expect(response.status).toBe(200);
    expect(dbMock.updateProjectPorts).not.toHaveBeenCalled();
    expect(processManagerMock.storeRunningProcesses).not.toHaveBeenCalled();
  });

  test('setup route returns 500 on install errors', async () => {
    const projectsDir = path.join(tmpRoot, 'projects-setup-error');
    await ensureEmptyDir(projectsDir);

    const projectPath = path.join(projectsDir, 'setup-error');
    await fs.mkdir(projectPath, { recursive: true });

    const { projectRoutes, dbMock, scaffoldingMock } = await loadProjectsRoutes();
    dbMock.getProject.mockResolvedValue({ id: 6, path: projectPath });
    scaffoldingMock.installDependencies.mockRejectedValue(new Error('install failed'));

    const app = createAppWithRoutes(projectRoutes);

    const response = await request(app)
      .post('/api/projects/6/setup');

    expect(response.status).toBe(500);
    expect(response.body.error).toMatch(/install failed/i);
  });

  test('setup route uses default error when install error lacks message', async () => {
    const projectsDir = path.join(tmpRoot, 'projects-setup-error-default');
    await ensureEmptyDir(projectsDir);

    const projectPath = path.join(projectsDir, 'setup-error-default');
    await fs.mkdir(projectPath, { recursive: true });

    const { projectRoutes, dbMock, scaffoldingMock } = await loadProjectsRoutes();
    dbMock.getProject.mockResolvedValue({ id: 13, path: projectPath });
    scaffoldingMock.installDependencies.mockRejectedValue({});

    const app = createAppWithRoutes(projectRoutes);

    const response = await request(app)
      .post('/api/projects/13/setup');

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Failed to complete project setup');
  });

  test('delete route reports cleanup failures when fs module throws without message', async () => {
    const projectsDir = path.join(tmpRoot, 'projects-delete-cleanup');
    await ensureEmptyDir(projectsDir);
    process.env.PROJECTS_DIR = projectsDir;

    const { projectRoutes, processManagerMock, dbMock } = await loadProjectsRoutes({
      internals: {
        getFsModule: vi.fn(async () => { throw {}; })
      }
    });

    processManagerMock.findProjectByIdentifier.mockResolvedValue({ id: 14, name: 'cleanup', path: projectsDir });
    dbMock.deleteProject.mockResolvedValue(true);

    const app = createAppWithRoutes(projectRoutes);

    const response = await request(app)
      .delete('/api/projects/14')
      .set('x-confirm-destructive', 'true');

    expect(response.status).toBe(200);
    expect(response.body.cleanup.failures[0].message).toBe('cleanup failed');
  });

  test('cleanup route returns 404 when project missing', async () => {
    const { projectRoutes, processManagerMock } = await loadProjectsRoutes();
    processManagerMock.findProjectByIdentifier.mockResolvedValue(null);

    const app = createAppWithRoutes(projectRoutes);

    const response = await request(app)
      .post('/api/projects/404/cleanup')
      .set('x-confirm-destructive', 'true');

    expect(response.status).toBe(404);
    expect(response.body.error).toMatch(/not found/i);
  });

  test('cleanup route requires confirmation', async () => {
    const { projectRoutes, processManagerMock } = await loadProjectsRoutes();
    processManagerMock.findProjectByIdentifier.mockResolvedValue({ id: 7, name: 'cleanup', path: '/tmp/cleanup' });

    const app = createAppWithRoutes(projectRoutes);

    const response = await request(app)
      .post('/api/projects/7/cleanup');

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/confirmation required/i);
  });

  test('cleanup route succeeds when executor succeeds', async () => {
    const { projectRoutes, processManagerMock, cleanupMock } = await loadProjectsRoutes();
    processManagerMock.findProjectByIdentifier.mockResolvedValue({ id: 8, name: 'cleanup', path: '/tmp/cleanup' });
    cleanupMock.buildCleanupTargets.mockReturnValue(['/tmp/cleanup', '/tmp/cleanup/frontend']);

    const app = createAppWithRoutes(projectRoutes);

    const response = await request(app)
      .post('/api/projects/8/cleanup')
      .set('x-confirm-destructive', 'true');

    expect(response.status).toBe(200);
    expect(response.body.cleanup.success).toBe(true);
    expect(response.body.message).toMatch(/completed successfully/i);
  });

  test('cleanup route reports failures when executor throws', async () => {
    const { projectRoutes, processManagerMock, cleanupMock } = await loadProjectsRoutes();
    processManagerMock.findProjectByIdentifier.mockResolvedValue({ id: 9, name: 'cleanup', path: '/tmp/cleanup' });
    cleanupMock.buildCleanupTargets.mockReturnValue(['/tmp/cleanup', '/tmp/cleanup/frontend']);
    cleanupMock.cleanupDirectoryExecutor.mockRejectedValueOnce(new Error('cleanup failed'));

    const app = createAppWithRoutes(projectRoutes);

    const response = await request(app)
      .post('/api/projects/9/cleanup')
      .set('x-confirm-destructive', 'true');

    expect(response.status).toBe(200);
    expect(response.body.cleanup.success).toBe(false);
    expect(response.body.cleanup.failures.length).toBe(1);
    expect(response.body.message).toMatch(/cleanup failed/i);
  });

  test('cleanup route falls back when executor error lacks message', async () => {
    const { projectRoutes, processManagerMock, cleanupMock } = await loadProjectsRoutes();
    processManagerMock.findProjectByIdentifier.mockResolvedValue({ id: 11, name: 'cleanup', path: '/tmp/cleanup' });
    cleanupMock.buildCleanupTargets.mockReturnValue(['/tmp/cleanup']);
    cleanupMock.cleanupDirectoryExecutor.mockRejectedValueOnce({});

    const app = createAppWithRoutes(projectRoutes);

    const response = await request(app)
      .post('/api/projects/11/cleanup')
      .set('x-confirm-destructive', 'true');

    expect(response.status).toBe(200);
    expect(response.body.cleanup.failures[0].message).toBe('cleanup failed');
  });

  test('cleanup route returns 500 when cleanup target building throws', async () => {
    const { projectRoutes, processManagerMock, cleanupMock } = await loadProjectsRoutes();
    processManagerMock.findProjectByIdentifier.mockResolvedValue({ id: 10, name: 'cleanup', path: '/tmp/cleanup' });
    cleanupMock.buildCleanupTargets.mockImplementation(() => {
      throw new Error('cleanup targets failed');
    });

    const app = createAppWithRoutes(projectRoutes);

    const response = await request(app)
      .post('/api/projects/10/cleanup')
      .set('x-confirm-destructive', 'true');

    expect(response.status).toBe(500);
    expect(response.body.error).toMatch(/cleanup targets failed/i);
  });

  test('cleanup route uses default error when cleanup throws without message', async () => {
    const { projectRoutes, processManagerMock, cleanupMock } = await loadProjectsRoutes();
    processManagerMock.findProjectByIdentifier.mockResolvedValue({ id: 12, name: 'cleanup', path: '/tmp/cleanup' });
    cleanupMock.buildCleanupTargets.mockImplementation(() => {
      throw {};
    });

    const app = createAppWithRoutes(projectRoutes);

    const response = await request(app)
      .post('/api/projects/12/cleanup')
      .set('x-confirm-destructive', 'true');

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Failed to retry cleanup');
  });
});

describe('Git routes coverage gaps', () => {
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    await ensureEmptyDir(tmpRoot);
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await fs.rm(tmpRoot, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  test('git ignore suggestions return empty when no untracked files', async () => {
    const projectPath = path.join(tmpRoot, 'git-suggest-empty');
    await fs.mkdir(projectPath, { recursive: true });

    const { app, dbMock, gitMock } = await loadGitRoutes();
    dbMock.getProject.mockResolvedValue({ id: 1, path: projectPath });

    gitMock.runGitCommand.mockImplementation(async (_cwd, args) => {
      if (args[0] === 'status') {
        return { stdout: '' };
      }
      if (args[0] === 'rev-parse') {
        return { stdout: projectPath };
      }
      return { stdout: '' };
    });

    const response = await request(app)
      .get('/api/projects/1/git/ignore-suggestions');

    expect(response.status).toBe(200);
    expect(response.body.suggestion).toMatchObject({ needed: false, entries: [] });
  });

  test('git ignore suggestions detect missing patterns and filter comments', async () => {
    const projectPath = path.join(tmpRoot, 'git-suggest');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(path.join(projectPath, '.gitignore'), 'node_modules/\n# comment\n\n');

    const { app, dbMock, gitMock } = await loadGitRoutes();
    dbMock.getProject.mockResolvedValue({ id: 2, path: projectPath });

    gitMock.runGitCommand.mockImplementation(async (_cwd, args) => {
      if (args[0] === 'status') {
        return { stdout: '?? dist/\n?? venv/\n?? node_modules/\n' };
      }
      if (args[0] === 'rev-parse') {
        return { stdout: projectPath };
      }
      return { stdout: '' };
    });

    const response = await request(app)
      .get('/api/projects/2/git/ignore-suggestions');

    expect(response.status).toBe(200);
    expect(response.body.suggestion.entries).toEqual(expect.arrayContaining(['dist/', 'venv/']));
    expect(response.body.suggestion.samplePaths.length).toBeGreaterThan(0);
  });

  test('git ignore suggestions return 404 when project is missing', async () => {
    const { app, dbMock } = await loadGitRoutes();
    dbMock.getProject.mockResolvedValue(null);

    const response = await request(app)
      .get('/api/projects/404/git/ignore-suggestions');

    expect(response.status).toBe(404);
    expect(response.body.error).toMatch(/not found/i);
  });

  test('git ignore suggestions return 400 when project path is missing', async () => {
    const { app, dbMock } = await loadGitRoutes();
    dbMock.getProject.mockResolvedValue({ id: 11, path: null });

    const response = await request(app)
      .get('/api/projects/11/git/ignore-suggestions');

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/path is not configured/i);
  });

  test('git ignore suggestions handle missing gitignore file', async () => {
    const projectPath = path.join(tmpRoot, 'git-suggest-missing-ignore');
    await fs.mkdir(projectPath, { recursive: true });

    const { app, dbMock, gitMock } = await loadGitRoutes();
    dbMock.getProject.mockResolvedValue({ id: 12, path: projectPath });

    gitMock.runGitCommand.mockImplementation(async (_cwd, args) => {
      if (args[0] === 'status') {
        return { stdout: '?? node_modules/\n' };
      }
      if (args[0] === 'rev-parse') {
        return { stdout: projectPath };
      }
      return { stdout: '' };
    });

    const response = await request(app)
      .get('/api/projects/12/git/ignore-suggestions');

    expect(response.status).toBe(200);
    expect(response.body.suggestion.entries).toContain('node_modules/');
  });

  test('git ignore suggestions handle non-string gitignore entries', async () => {
    const projectPath = path.join(tmpRoot, 'git-suggest-nonstring');
    await fs.mkdir(projectPath, { recursive: true });

    const readFileSpy = vi.spyOn(fs, 'readFile').mockResolvedValue({
      split: () => [null]
    });

    try {
      const { app, dbMock, gitMock } = await loadGitRoutes();
      dbMock.getProject.mockResolvedValue({ id: 17, path: projectPath });

      gitMock.runGitCommand.mockImplementation(async (_cwd, args) => {
        if (args[0] === 'status') {
          return { stdout: '?? build/\n' };
        }
        if (args[0] === 'rev-parse') {
          return { stdout: projectPath };
        }
        return { stdout: '' };
      });

      const response = await request(app)
        .get('/api/projects/17/git/ignore-suggestions');

      expect(response.status).toBe(200);
      expect(response.body.suggestion.entries).toContain('build/');
    } finally {
      readFileSpy.mockRestore();
    }
  });

  test('git ignore suggestions treat non-string status output as empty', async () => {
    const projectPath = path.join(tmpRoot, 'git-suggest-nonstring-status');
    await fs.mkdir(projectPath, { recursive: true });

    const { app, dbMock, gitMock } = await loadGitRoutes();
    dbMock.getProject.mockResolvedValue({ id: 18, path: projectPath });

    gitMock.runGitCommand.mockImplementation(async (_cwd, args) => {
      if (args[0] === 'status') {
        return { stdout: null };
      }
      if (args[0] === 'rev-parse') {
        return { stdout: projectPath };
      }
      return { stdout: '' };
    });

    const response = await request(app)
      .get('/api/projects/18/git/ignore-suggestions');

    expect(response.status).toBe(200);
    expect(response.body.suggestion.needed).toBe(false);
  });

  test('git ignore suggestions use default branch when settings omit it', async () => {
    const projectPath = path.join(tmpRoot, 'git-suggest-default-branch');
    await fs.mkdir(projectPath, { recursive: true });

    const { app, dbMock, gitMock } = await loadGitRoutes();
    dbMock.getProject.mockResolvedValue({ id: 22, path: projectPath });
    dbMock.getGitSettings.mockResolvedValue({});

    gitMock.runGitCommand.mockImplementation(async (_cwd, args) => {
      if (args[0] === 'status') {
        return { stdout: '' };
      }
      if (args[0] === 'rev-parse') {
        return { stdout: projectPath };
      }
      return { stdout: '' };
    });

    const response = await request(app)
      .get('/api/projects/22/git/ignore-suggestions');

    expect(response.status).toBe(200);
    expect(gitMock.ensureGitRepository).toHaveBeenCalledWith(
      projectPath,
      expect.objectContaining({ defaultBranch: 'main' })
    );
  });

  test('git ignore suggestions return 500 when gitignore read fails', async () => {
    const projectPath = path.join(tmpRoot, 'git-suggest-bad-ignore');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(path.join(projectPath, '.gitignore'));

    const { app, dbMock, gitMock } = await loadGitRoutes();
    dbMock.getProject.mockResolvedValue({ id: 13, path: projectPath });

    gitMock.runGitCommand.mockImplementation(async (_cwd, args) => {
      if (args[0] === 'status') {
        return { stdout: '?? node_modules/\n' };
      }
      if (args[0] === 'rev-parse') {
        return { stdout: projectPath };
      }
      return { stdout: '' };
    });

    const response = await request(app)
      .get('/api/projects/13/git/ignore-suggestions');

    expect(response.status).toBe(500);
    expect(response.body.error).toMatch(/failed to build gitignore suggestions/i);
  });

  test('git ignore fix returns no-op when nothing to add', async () => {
    const projectPath = path.join(tmpRoot, 'git-fix-noop');
    await fs.mkdir(projectPath, { recursive: true });

    const { app, dbMock, gitMock } = await loadGitRoutes();
    dbMock.getProject.mockResolvedValue({ id: 3, path: projectPath });

    gitMock.runGitCommand.mockImplementation(async (_cwd, args) => {
      if (args[0] === 'status') {
        return { stdout: '' };
      }
      if (args[0] === 'rev-parse') {
        return { stdout: projectPath };
      }
      return { stdout: '' };
    });

    const response = await request(app)
      .post('/api/projects/3/git/ignore-fix')
      .send({});

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ applied: false, committed: false, entries: [] });
  });

  test('git ignore fix returns 404 when project is missing', async () => {
    const { app, dbMock } = await loadGitRoutes();
    dbMock.getProject.mockResolvedValue(null);

    const response = await request(app)
      .post('/api/projects/404/git/ignore-fix')
      .send({ entries: ['dist/'] });

    expect(response.status).toBe(404);
    expect(response.body.error).toMatch(/not found/i);
  });

  test('git ignore fix returns 400 when project path is missing', async () => {
    const { app, dbMock } = await loadGitRoutes();
    dbMock.getProject.mockResolvedValue({ id: 14, path: null });

    const response = await request(app)
      .post('/api/projects/14/git/ignore-fix')
      .send({ entries: ['dist/'] });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/path is not configured/i);
  });

  test('git ignore fix returns no-op when entries already exist', async () => {
    const projectPath = path.join(tmpRoot, 'git-fix-existing');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(path.join(projectPath, '.gitignore'), 'node_modules/\n');

    const { app, dbMock, gitMock } = await loadGitRoutes();
    dbMock.getProject.mockResolvedValue({ id: 15, path: projectPath });

    gitMock.runGitCommand.mockImplementation(async (_cwd, args) => {
      if (args[0] === 'rev-parse') {
        return { stdout: projectPath };
      }
      return { stdout: '' };
    });

    const response = await request(app)
      .post('/api/projects/15/git/ignore-fix')
      .send({ entries: ['node_modules/'], commit: false });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ applied: false, committed: false, entries: [] });
  });

  test('git ignore fix ignores non-string entries', async () => {
    const projectPath = path.join(tmpRoot, 'git-fix-nonstring');
    await fs.mkdir(projectPath, { recursive: true });

    const { app, dbMock, gitMock } = await loadGitRoutes();
    dbMock.getProject.mockResolvedValue({ id: 19, path: projectPath });

    gitMock.runGitCommand.mockImplementation(async (_cwd, args) => {
      if (args[0] === 'rev-parse') {
        return { stdout: projectPath };
      }
      return { stdout: '' };
    });

    const response = await request(app)
      .post('/api/projects/19/git/ignore-fix')
      .send({ entries: [null, 'dist/'], commit: false });

    expect(response.status).toBe(200);
    expect(response.body.applied).toBe(true);
    expect(response.body.entries).toEqual(['dist/']);
  });

  test('applyGitIgnoreEntries drops non-string values', async () => {
    const projectPath = path.join(tmpRoot, 'git-apply-nonstring');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(path.join(projectPath, '.gitignore'), '');
    await fs.mkdir(path.join(tmpRoot, 'git-fix-nonstring'), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, 'git-fix-nonstring', '.gitignore'), '');

    vi.resetModules();
    vi.doMock('../utils/git.js', () => ({
      runGitCommand: vi.fn().mockResolvedValue({ stdout: projectPath }),
      ensureGitRepository: vi.fn(),
      discardWorkingTree: vi.fn(),
      fetchRemote: vi.fn(),
      getAheadBehind: vi.fn(),
      getCurrentBranch: vi.fn(),
      getRemoteUrl: vi.fn(),
      hasWorkingTreeChanges: vi.fn(),
      popBranchStash: vi.fn(),
      stashWorkingTree: vi.fn()
    }));

    const { __gitRoutesTesting } = await import('../routes/projects/routes.git.js');
    const result = await __gitRoutesTesting.applyGitIgnoreEntries(projectPath, [null, 'dist/']);

    expect(result.additions).toEqual(['dist/']);
  });

  test('git ignore fix uses project path when rev-parse output is empty', async () => {
    const projectPath = path.join(tmpRoot, 'git-fix-rev-parse-empty');
    await fs.mkdir(projectPath, { recursive: true });

    const { app, dbMock, gitMock } = await loadGitRoutes();
    dbMock.getProject.mockResolvedValue({ id: 20, path: projectPath });

    gitMock.runGitCommand.mockImplementation(async (_cwd, args) => {
      if (args[0] === 'rev-parse') {
        return { stdout: null };
      }
      return { stdout: '' };
    });

    const response = await request(app)
      .post('/api/projects/20/git/ignore-fix')
      .send({ entries: ['dist/'], commit: false });

    expect(response.status).toBe(200);
    expect(response.body.entries).toEqual(['dist/']);
  });

  test('git ignore fix uses default branch when settings omit it', async () => {
    const projectPath = path.join(tmpRoot, 'git-fix-default-branch');
    await fs.mkdir(projectPath, { recursive: true });

    const { app, dbMock, gitMock } = await loadGitRoutes();
    dbMock.getProject.mockResolvedValue({ id: 23, path: projectPath });
    dbMock.getGitSettings.mockResolvedValue({});

    gitMock.runGitCommand.mockImplementation(async (_cwd, args) => {
      if (args[0] === 'rev-parse') {
        return { stdout: projectPath };
      }
      return { stdout: '' };
    });

    const response = await request(app)
      .post('/api/projects/23/git/ignore-fix')
      .send({ entries: ['dist/'], commit: false });

    expect(response.status).toBe(200);
    expect(gitMock.ensureGitRepository).toHaveBeenCalledWith(
      projectPath,
      expect.objectContaining({ defaultBranch: 'main' })
    );
  });

  test('git ignore fix uses default error when write failure lacks message', async () => {
    const projectPath = path.join(tmpRoot, 'git-fix-write-error');
    await fs.mkdir(projectPath, { recursive: true });

    const writeFileSpy = vi.spyOn(fs, 'writeFile').mockRejectedValueOnce({});

    try {
      const { app, dbMock, gitMock } = await loadGitRoutes();
      dbMock.getProject.mockResolvedValue({ id: 21, path: projectPath });

      gitMock.runGitCommand.mockImplementation(async (_cwd, args) => {
        if (args[0] === 'rev-parse') {
          return { stdout: projectPath };
        }
        return { stdout: '' };
      });

      const response = await request(app)
        .post('/api/projects/21/git/ignore-fix')
        .send({ entries: ['dist/'] });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Failed to apply gitignore updates');
    } finally {
      writeFileSpy.mockRestore();
    }
  });

  test('git ignore fix applies filtered entries without committing', async () => {
    const projectPath = path.join(tmpRoot, 'git-fix-apply');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(path.join(projectPath, '.gitignore'), 'node_modules/');

    const { app, dbMock, gitMock } = await loadGitRoutes();
    dbMock.getProject.mockResolvedValue({ id: 4, path: projectPath });

    gitMock.runGitCommand.mockImplementation(async (_cwd, args) => {
      if (args[0] === 'rev-parse') {
        return { stdout: projectPath };
      }
      return { stdout: '' };
    });

    const response = await request(app)
      .post('/api/projects/4/git/ignore-fix')
      .send({ entries: [' dist/ ', 'bad\nline', '', 'node_modules/'], commit: false });

    expect(response.status).toBe(200);
    expect(response.body.applied).toBe(true);
    expect(response.body.committed).toBe(false);

    const updated = await fs.readFile(path.join(projectPath, '.gitignore'), 'utf8');
    expect(updated).toMatch(/node_modules\/[\s\S]*dist\//);
  });

  test('git ignore fix records commit as false when nothing to commit', async () => {
    const projectPath = path.join(tmpRoot, 'git-fix-commit');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(path.join(projectPath, '.gitignore'), 'node_modules/\n');

    const { app, dbMock, gitMock } = await loadGitRoutes();
    dbMock.getProject.mockResolvedValue({ id: 5, path: projectPath });

    gitMock.runGitCommand.mockImplementation(async (_cwd, args) => {
      if (args[0] === 'rev-parse') {
        return { stdout: projectPath };
      }
      if (args[0] === 'commit') {
        throw new Error('nothing to commit');
      }
      return { stdout: '' };
    });

    const response = await request(app)
      .post('/api/projects/5/git/ignore-fix')
      .send({ entries: ['dist/'] });

    expect(response.status).toBe(200);
    expect(response.body.applied).toBe(true);
    expect(response.body.committed).toBe(false);
  });

  test('git ignore fix surfaces commit errors', async () => {
    const projectPath = path.join(tmpRoot, 'git-fix-commit-error');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(path.join(projectPath, '.gitignore'), '');

    const { app, dbMock, gitMock } = await loadGitRoutes();
    dbMock.getProject.mockResolvedValue({ id: 16, path: projectPath });

    gitMock.runGitCommand.mockImplementation(async (_cwd, args) => {
      if (args[0] === 'rev-parse') {
        return { stdout: projectPath };
      }
      if (args[0] === 'commit') {
        throw new Error('commit failed');
      }
      return { stdout: '' };
    });

    const response = await request(app)
      .post('/api/projects/16/git/ignore-fix')
      .send({ entries: ['dist/'] });

    expect(response.status).toBe(500);
    expect(response.body.error).toMatch(/commit failed/i);
  });

  test('git ignore fix uses default error when commit error lacks message', async () => {
    const projectPath = path.join(tmpRoot, 'git-fix-commit-error-default');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(path.join(projectPath, '.gitignore'), '');

    const { app, dbMock, gitMock } = await loadGitRoutes();
    dbMock.getProject.mockResolvedValue({ id: 24, path: projectPath });

    gitMock.runGitCommand.mockImplementation(async (_cwd, args) => {
      if (args[0] === 'rev-parse') {
        return { stdout: projectPath };
      }
      if (args[0] === 'commit') {
        throw {};
      }
      return { stdout: '' };
    });

    const response = await request(app)
      .post('/api/projects/24/git/ignore-fix')
      .send({ entries: ['dist/'] });

    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Failed to apply gitignore updates');
  });
});

describe('Project scaffolding gitignore coverage', () => {
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    await ensureEmptyDir(tmpRoot);
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await fs.rm(tmpRoot, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  test('cloneProjectFromRemote returns setupRequired with gitignore suggestion', async () => {
    vi.resetModules();
    vi.doMock('../services/projectScaffolding.js', async () => await vi.importActual('../services/projectScaffolding.js'));
    process.env.NODE_ENV = 'development';
    process.env.LUCIDCODER_FORCE_REAL_START = 'true';

    const projectPath = path.join(tmpRoot, 'clone-suggest');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(path.join(projectPath, 'package.json'), '{}');
    await fs.writeFile(path.join(projectPath, '.gitignore'), '# comment\n');

    const runGitCommand = vi.fn(async (_cwd, args) => {
      if (args[0] === 'rev-parse') {
        return { stdout: projectPath };
      }
      if (args[0] === 'ls-files') {
        return { stdout: 'package-lock.json\n' };
      }
      return { stdout: '' };
    });

    vi.doMock('../utils/git.js', () => ({
      runGitCommand,
      getCurrentBranch: vi.fn().mockResolvedValue('main'),
      configureGitUser: vi.fn().mockResolvedValue(undefined)
    }));

    const { cloneProjectFromRemote } = await import('../services/projectScaffolding.js');

    const result = await cloneProjectFromRemote(
      {
        name: 'clone-suggest',
        path: projectPath,
        frontend: { language: 'javascript', framework: 'react' },
        backend: { language: 'javascript', framework: 'express' }
      },
      {
        cloneOptions: {
          remoteUrl: 'https://github.com/octo/repo.git',
          provider: 'github',
          defaultBranch: 'main',
          username: 'octo'
        },
        portSettings: {},
        requireGitIgnoreApproval: true,
        gitIgnoreApproved: false
      }
    );

    expect(result.setupRequired).toBe(true);
    expect(result.gitIgnoreSuggestion.entries).toContain('node_modules/');
    expect(result.gitIgnoreSuggestion.trackedFiles).toContain('package-lock.json');
  });

  test('cloneProjectFromRemote handles missing gitignore and rev-parse failure', async () => {
    vi.resetModules();
    vi.doMock('../services/projectScaffolding.js', async () => await vi.importActual('../services/projectScaffolding.js'));
    process.env.NODE_ENV = 'development';
    process.env.LUCIDCODER_FORCE_REAL_START = 'true';

    const projectPath = path.join(tmpRoot, 'clone-no-gitignore');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(path.join(projectPath, 'package.json'), '{}');

    const runGitCommand = vi.fn(async (_cwd, args) => {
      if (args[0] === 'rev-parse') {
        throw new Error('rev-parse failed');
      }
      if (args[0] === 'ls-files') {
        return { stdout: '' };
      }
      return { stdout: '' };
    });

    vi.doMock('../utils/git.js', () => ({
      runGitCommand,
      getCurrentBranch: vi.fn().mockImplementation(() => { throw new Error('no branch'); }),
      configureGitUser: vi.fn().mockResolvedValue(undefined)
    }));

    const { cloneProjectFromRemote } = await import('../services/projectScaffolding.js');

    const result = await cloneProjectFromRemote(
      {
        name: 'clone-no-gitignore',
        path: projectPath,
        frontend: { language: 'javascript', framework: 'react' },
        backend: { language: 'javascript', framework: 'express' }
      },
      {
        cloneOptions: {
          remoteUrl: 'https://github.com/octo/repo.git',
          provider: 'github',
          defaultBranch: 'main',
          username: 'octo'
        },
        portSettings: {},
        requireGitIgnoreApproval: true,
        gitIgnoreApproved: false
      }
    );

    expect(result.setupRequired).toBe(true);
    expect(result.gitIgnoreSuggestion.entries).toContain('node_modules/');
  });

  test('cloneProjectFromRemote keeps tracked files when gitignore already has entries', async () => {
    vi.resetModules();
    vi.doMock('../services/projectScaffolding.js', async () => await vi.importActual('../services/projectScaffolding.js'));
    process.env.NODE_ENV = 'development';
    process.env.LUCIDCODER_FORCE_REAL_START = 'true';

    const projectPath = path.join(tmpRoot, 'clone-gitignore-existing');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(path.join(projectPath, 'package.json'), '{}');
    await fs.writeFile(path.join(projectPath, '.gitignore'), 'node_modules/\n');

    const runGitCommand = vi.fn(async (_cwd, args) => {
      if (args[0] === 'rev-parse') {
        return { stdout: projectPath };
      }
      if (args[0] === 'ls-files') {
        return { stdout: 'package-lock.json\n' };
      }
      return { stdout: '' };
    });

    vi.doMock('../utils/git.js', () => ({
      runGitCommand,
      getCurrentBranch: vi.fn().mockResolvedValue('main'),
      configureGitUser: vi.fn().mockResolvedValue(undefined)
    }));

    const { cloneProjectFromRemote } = await import('../services/projectScaffolding.js');

    const result = await cloneProjectFromRemote(
      {
        name: 'clone-gitignore-existing',
        path: projectPath,
        frontend: { language: 'javascript', framework: 'react' },
        backend: { language: 'javascript', framework: 'express' }
      },
      {
        cloneOptions: {
          remoteUrl: 'https://github.com/octo/repo.git',
          provider: 'github',
          defaultBranch: 'main',
          username: 'octo'
        },
        portSettings: {},
        requireGitIgnoreApproval: true,
        gitIgnoreApproved: false
      }
    );

    expect(result.setupRequired).toBe(true);
    expect(result.gitIgnoreSuggestion.entries).toEqual([]);
    expect(result.gitIgnoreSuggestion.trackedFiles).toContain('package-lock.json');
  });

  test('cloneProjectFromRemote keeps missing entries when git ls-files fails', async () => {
    vi.resetModules();
    vi.doMock('../services/projectScaffolding.js', async () => await vi.importActual('../services/projectScaffolding.js'));
    process.env.NODE_ENV = 'development';
    process.env.LUCIDCODER_FORCE_REAL_START = 'true';

    const projectPath = path.join(tmpRoot, 'clone-gitignore-lsfiles-error');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(path.join(projectPath, 'package.json'), '{}');

    const runGitCommand = vi.fn(async (_cwd, args) => {
      if (args[0] === 'rev-parse') {
        return { stdout: projectPath };
      }
      if (args[0] === 'ls-files') {
        throw new Error('ls-files failed');
      }
      return { stdout: '' };
    });

    vi.doMock('../utils/git.js', () => ({
      runGitCommand,
      getCurrentBranch: vi.fn().mockResolvedValue('main'),
      configureGitUser: vi.fn().mockResolvedValue(undefined)
    }));

    const { cloneProjectFromRemote } = await import('../services/projectScaffolding.js');

    const result = await cloneProjectFromRemote(
      {
        name: 'clone-gitignore-lsfiles-error',
        path: projectPath,
        frontend: { language: 'javascript', framework: 'react' },
        backend: { language: 'javascript', framework: 'express' }
      },
      {
        cloneOptions: {
          remoteUrl: 'https://github.com/octo/repo.git',
          provider: 'github',
          defaultBranch: 'main',
          username: 'octo'
        },
        portSettings: {},
        requireGitIgnoreApproval: true,
        gitIgnoreApproved: false
      }
    );

    expect(result.setupRequired).toBe(true);
    expect(result.gitIgnoreSuggestion.entries).toContain('node_modules/');
    expect(result.gitIgnoreSuggestion.trackedFiles).toEqual([]);
  });

  test('cloneProjectFromRemote handles non-string gitignore entries and rev-parse output', async () => {
    vi.resetModules();
    vi.doMock('../services/projectScaffolding.js', async () => await vi.importActual('../services/projectScaffolding.js'));
    process.env.NODE_ENV = 'development';
    process.env.LUCIDCODER_FORCE_REAL_START = 'true';

    const projectPath = path.join(tmpRoot, 'clone-nonstring-gitignore');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(path.join(projectPath, 'package.json'), '{}');

    const readFileSpy = vi.spyOn(fs, 'readFile').mockResolvedValue({
      split: () => [null]
    });

    try {
      const runGitCommand = vi.fn(async (_cwd, args) => {
        if (args[0] === 'rev-parse') {
          return { stdout: null };
        }
        if (args[0] === 'ls-files') {
          return { stdout: null };
        }
        return { stdout: '' };
      });

      vi.doMock('../utils/git.js', () => ({
        runGitCommand,
        getCurrentBranch: vi.fn().mockResolvedValue('main'),
        configureGitUser: vi.fn().mockResolvedValue(undefined)
      }));

      const { cloneProjectFromRemote } = await import('../services/projectScaffolding.js');

      const result = await cloneProjectFromRemote(
        {
          name: 'clone-nonstring-gitignore',
          path: projectPath,
          frontend: { language: 'javascript', framework: 'react' },
          backend: { language: 'javascript', framework: 'express' }
        },
        {
          cloneOptions: {
            remoteUrl: 'https://github.com/octo/repo.git',
            provider: 'github',
            defaultBranch: 'main',
            username: 'octo'
          },
          portSettings: {},
          requireGitIgnoreApproval: true,
          gitIgnoreApproved: false
        }
      );

      expect(result.setupRequired).toBe(true);
      expect(result.gitIgnoreSuggestion.repoRoot).toBe(projectPath);
      expect(result.gitIgnoreSuggestion.trackedFiles).toEqual([]);
    } finally {
      readFileSpy.mockRestore();
    }
  });

  test('cloneProjectFromRemote includes python gitignore entries when needed', async () => {
    vi.resetModules();
    vi.doMock('../services/projectScaffolding.js', async () => await vi.importActual('../services/projectScaffolding.js'));
    process.env.NODE_ENV = 'development';
    process.env.LUCIDCODER_FORCE_REAL_START = 'true';

    const projectPath = path.join(tmpRoot, 'clone-python-ignore');
    await fs.mkdir(path.join(projectPath, 'backend'), { recursive: true });
    await fs.writeFile(path.join(projectPath, 'backend', 'requirements.txt'), 'fastapi');

    const runGitCommand = vi.fn(async (_cwd, args) => {
      if (args[0] === 'rev-parse') {
        return { stdout: projectPath };
      }
      if (args[0] === 'ls-files') {
        return { stdout: '' };
      }
      return { stdout: '' };
    });

    vi.doMock('../utils/git.js', () => ({
      runGitCommand,
      getCurrentBranch: vi.fn().mockResolvedValue('main'),
      configureGitUser: vi.fn().mockResolvedValue(undefined)
    }));

    const { cloneProjectFromRemote } = await import('../services/projectScaffolding.js');

    const result = await cloneProjectFromRemote(
      {
        name: 'clone-python-ignore',
        path: projectPath,
        frontend: { language: 'javascript', framework: 'react' },
        backend: { language: 'python', framework: 'fastapi' }
      },
      {
        cloneOptions: {
          remoteUrl: 'https://github.com/octo/repo.git',
          provider: 'github',
          defaultBranch: 'main',
          username: 'octo'
        },
        portSettings: {},
        requireGitIgnoreApproval: true,
        gitIgnoreApproved: false
      }
    );

    expect(result.setupRequired).toBe(true);
    expect(result.gitIgnoreSuggestion.entries).toEqual(expect.arrayContaining(['venv/', '.venv/', '__pycache__/']));
  });

  test('cloneProjectFromRemote skips gitignore approval when already approved', async () => {
    vi.resetModules();
    vi.doMock('../services/projectScaffolding/exec.js', async () => {
      const actual = await vi.importActual('../services/projectScaffolding/exec.js');
      return {
        ...actual,
        execWithRetry: vi.fn().mockRejectedValue(new Error('install fail'))
      };
    });
    vi.doMock('../services/projectScaffolding.js', async () => await vi.importActual('../services/projectScaffolding.js'));
    process.env.NODE_ENV = 'development';
    process.env.LUCIDCODER_FORCE_REAL_START = 'true';

    const projectPath = path.join(tmpRoot, 'clone-approved-ignore');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(path.join(projectPath, 'package.json'), '{}');

    const runGitCommand = vi.fn(async (_cwd, args) => {
      if (args[0] === 'rev-parse') {
        return { stdout: projectPath };
      }
      if (args[0] === 'ls-files') {
        return { stdout: '' };
      }
      return { stdout: '' };
    });

    vi.doMock('../utils/git.js', () => ({
      runGitCommand,
      getCurrentBranch: vi.fn().mockResolvedValue('main'),
      configureGitUser: vi.fn().mockResolvedValue(undefined)
    }));

    const { cloneProjectFromRemote } = await import('../services/projectScaffolding.js');

    await expect(cloneProjectFromRemote(
      {
        name: 'clone-approved-ignore',
        path: projectPath,
        frontend: { language: 'javascript', framework: 'react' },
        backend: { language: 'javascript', framework: 'express' }
      },
      {
        cloneOptions: {
          remoteUrl: 'https://github.com/octo/repo.git',
          provider: 'github',
          defaultBranch: 'main',
          username: 'octo'
        },
        portSettings: {},
        requireGitIgnoreApproval: true,
        gitIgnoreApproved: true
      }
    )).rejects.toThrow(/install fail/i);
  });

  test('cloneProjectFromRemote surfaces gitignore read errors', async () => {
    vi.resetModules();
    vi.doMock('../services/projectScaffolding.js', async () => await vi.importActual('../services/projectScaffolding.js'));
    process.env.NODE_ENV = 'development';
    process.env.LUCIDCODER_FORCE_REAL_START = 'true';

    const projectPath = path.join(tmpRoot, 'clone-gitignore-read-error');
    await fs.mkdir(projectPath, { recursive: true });
    await fs.writeFile(path.join(projectPath, 'package.json'), '{}');
    await fs.mkdir(path.join(projectPath, '.gitignore'));

    const runGitCommand = vi.fn(async (_cwd, args) => {
      if (args[0] === 'rev-parse') {
        return { stdout: projectPath };
      }
      if (args[0] === 'ls-files') {
        return { stdout: '' };
      }
      return { stdout: '' };
    });

    vi.doMock('../utils/git.js', () => ({
      runGitCommand,
      getCurrentBranch: vi.fn().mockResolvedValue('main'),
      configureGitUser: vi.fn().mockResolvedValue(undefined)
    }));

    const { cloneProjectFromRemote } = await import('../services/projectScaffolding.js');

    await expect(cloneProjectFromRemote(
      {
        name: 'clone-gitignore-read-error',
        path: projectPath,
        frontend: { language: 'javascript', framework: 'react' },
        backend: { language: 'javascript', framework: 'express' }
      },
      {
        cloneOptions: {
          remoteUrl: 'https://github.com/octo/repo.git',
          provider: 'github',
          defaultBranch: 'main',
          username: 'octo'
        },
        portSettings: {},
        requireGitIgnoreApproval: true,
        gitIgnoreApproved: false
      }
    )).rejects.toThrow();
  });
});
