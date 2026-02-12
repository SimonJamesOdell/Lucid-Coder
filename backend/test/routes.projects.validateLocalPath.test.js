import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const dbMocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  getAllProjects: vi.fn(),
  getProject: vi.fn(),
  getProjectByName: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  getGitSettings: vi.fn(),
  getPortSettings: vi.fn(),
  updateProjectPorts: vi.fn(),
  saveProjectGitSettings: vi.fn()
}));

vi.mock('../database.js', () => ({
  __esModule: true,
  ...dbMocks
}));

vi.mock('../services/projectScaffolding.js', () => ({
  __esModule: true,
  createProjectWithFiles: vi.fn(),
  cloneProjectFromRemote: vi.fn(),
  installDependencies: vi.fn(),
  startProject: vi.fn()
}));

vi.mock('../services/projectScaffolding/ports.js', () => ({
  __esModule: true,
  buildPortOverrideOptions: vi.fn()
}));

vi.mock('../utils/projectPaths.js', () => ({
  __esModule: true,
  resolveProjectPath: vi.fn(),
  getProjectsDir: vi.fn()
}));

vi.mock('../utils/gitUrl.js', () => ({
  __esModule: true,
  buildCloneUrl: vi.fn(),
  stripGitCredentials: vi.fn()
}));

vi.mock('../utils/git.js', () => ({
  __esModule: true,
  runGitCommand: vi.fn(),
  getCurrentBranch: vi.fn(),
  ensureGitRepository: vi.fn(),
  configureGitUser: vi.fn(),
  ensureInitialCommit: vi.fn()
}));

vi.mock('../services/jobRunner.js', () => ({
  __esModule: true,
  startJob: vi.fn()
}));

vi.mock('../services/importCompatibility.js', () => ({
  __esModule: true,
  applyCompatibility: vi.fn(),
  applyProjectStructure: vi.fn()
}));

vi.mock('../services/progressTracker.js', () => ({
  __esModule: true,
  initProgress: vi.fn(),
  updateProgress: vi.fn(),
  completeProgress: vi.fn(),
  failProgress: vi.fn(),
  attachProgressStream: vi.fn(),
  getProgressSnapshot: vi.fn()
}));

const cleanupMocks = vi.hoisted(() => ({
  addCleanupTarget: vi.fn(),
  buildCleanupTargets: vi.fn(),
  cleanupDirectoryExecutor: vi.fn(),
  hasUnsafeCommandCharacters: vi.fn(() => false),
  isWithinManagedProjectsRoot: vi.fn()
}));

vi.mock('../routes/projects/cleanup.js', () => ({
  __esModule: true,
  ...cleanupMocks
}));

vi.mock('../routes/projects/processManager.js', () => ({
  __esModule: true,
  extractProcessPorts: vi.fn(),
  findProjectByIdentifier: vi.fn(),
  killProcessesOnPort: vi.fn(),
  killProcessTree: vi.fn(),
  findPidsByPort: vi.fn(),
  isProtectedPid: vi.fn(),
  storeRunningProcesses: vi.fn(),
  terminateRunningProcesses: vi.fn()
}));

vi.mock('../routes/projects/internals.js', () => ({
  __esModule: true,
  getFsModule: vi.fn(),
  attachTestErrorDetails: vi.fn(),
  buildProjectUpdatePayload: vi.fn(),
  requireDestructiveConfirmation: vi.fn()
}));

vi.mock('../routes/projects/routes.files.js', () => ({
  __esModule: true,
  registerProjectFileRoutes: vi.fn()
}));

vi.mock('../routes/projects/routes.git.js', () => ({
  __esModule: true,
  registerProjectGitRoutes: vi.fn()
}));

vi.mock('../routes/projects/routes.processes.js', () => ({
  __esModule: true,
  registerProjectProcessRoutes: vi.fn()
}));

vi.mock('../routes/projects/testingExports.js', () => ({
  __esModule: true,
  killProcessesOnPort: vi.fn(),
  killProcessTree: vi.fn(),
  findPidsByPort: vi.fn(),
  isProtectedPid: vi.fn(),
  cleanupDirectoryWithRetry: vi.fn(),
  __processManager: {},
  __projectRoutesInternals: {}
}));

const buildApp = async () => {
  const projectsRouter = (await import('../routes/projects.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/projects', projectsRouter);
  return app;
};

const getImportHandler = async () => {
  const projectsRouter = (await import('../routes/projects.js')).default;
  const layer = projectsRouter.stack.find(
    (entry) => entry.route?.path === '/import' && entry.route?.methods?.post
  );
  return layer.route.stack[0].handle;
};

describe('routes/projects validate-local-path', () => {
  let app;
  let tempDir;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    cleanupMocks.isWithinManagedProjectsRoot.mockReturnValue(true);
    app = await buildApp();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'projects-validate-path-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('rejects empty payloads with a 400', async () => {
    const res = await request(app)
      .post('/api/projects/validate-local-path')
      .send({})
      .expect(400);

    expect(res.body).toEqual({ success: false, error: 'Project path is required' });
  });

  it('rejects requests without a JSON body', async () => {
    const res = await request(app)
      .post('/api/projects/validate-local-path')
      .expect(400);

    expect(res.body).toEqual({ success: false, error: 'Project path is required' });
  });

  it('rejects requests without a body parser', async () => {
    const projectsRouter = (await import('../routes/projects.js')).default;
    const localApp = express();
    localApp.use('/api/projects', projectsRouter);

    const res = await request(localApp)
      .post('/api/projects/validate-local-path')
      .expect(400);

    expect(res.body).toEqual({ success: false, error: 'Project path is required' });
  });

  it('rejects non-directory paths with a 400', async () => {
    const filePath = path.join(tempDir, 'not-a-dir.txt');
    await fs.writeFile(filePath, 'file');

    const res = await request(app)
      .post('/api/projects/validate-local-path')
      .send({ path: filePath })
      .expect(400);

    expect(res.body).toEqual({ success: false, error: 'Project path must be a directory' });
  });

  it('rejects linked paths outside the managed root', async () => {
    cleanupMocks.isWithinManagedProjectsRoot.mockReturnValue(false);

    const res = await request(app)
      .post('/api/projects/validate-local-path')
      .send({ path: tempDir, importMode: 'link' })
      .expect(400);

    expect(res.body).toEqual({
      success: false,
      error: 'Linked projects must be inside the managed projects folder. Use copy instead.'
    });
  });

  it('returns success when the local path is valid', async () => {
    const res = await request(app)
      .post('/api/projects/validate-local-path')
      .send({ path: tempDir, importMode: 'copy' })
      .expect(200);

    expect(res.body).toEqual({ success: true, valid: true });
  });

  it('accepts the localPath payload field', async () => {
    const res = await request(app)
      .post('/api/projects/validate-local-path')
      .send({ localPath: tempDir, importMode: 'copy' })
      .expect(200);

    expect(res.body).toEqual({ success: true, valid: true });
  });

  it('uses a fallback error message when validation errors omit details', async () => {
    const statSpy = vi.spyOn(fs, 'stat').mockRejectedValueOnce({ statusCode: 418 });

    const res = await request(app)
      .post('/api/projects/validate-local-path')
      .send({ path: tempDir })
      .expect(418);

    expect(res.body).toEqual({ success: false, error: 'Invalid project path' });
    statSpy.mockRestore();
  });

  it('falls back to a 500 when the path lookup fails unexpectedly', async () => {
    const missingPath = path.join(tempDir, 'missing');

    const res = await request(app)
      .post('/api/projects/validate-local-path')
      .send({ path: missingPath })
      .expect(500);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('ENOENT');
  });

  it('rejects import requests without a JSON body', async () => {
    const res = await request(app)
      .post('/api/projects/import')
      .expect(400);

    expect(res.body).toEqual({ success: false, error: 'Project name is required' });
  });

  it('falls back to an empty payload when req.body is missing', async () => {
    const handler = await getImportHandler();
    const res = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      }
    };

    await handler({ body: undefined }, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'Project name is required' });
  });
});
