import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

vi.mock('../database.js', () => ({
  getProject: vi.fn(),
  getPortSettings: vi.fn(),
  updateProjectPorts: vi.fn()
}));

vi.mock('../services/projectScaffolding.js', () => ({
  startProject: vi.fn()
}));

vi.mock('../services/projectScaffolding/generate.js', () => ({
  generateBackendFiles: vi.fn()
}));

vi.mock('../services/jobRunner.js', () => ({
  startJob: vi.fn()
}));

vi.mock('../routes/projects/cleanup.js', () => ({
  hasUnsafeCommandCharacters: vi.fn(() => false),
  isWithinManagedProjectsRoot: vi.fn(() => true)
}));

const runningProcessesMock = new Map();

vi.mock('../routes/projects/processManager.js', () => {
  const defaultPorts = { frontend: 5173, backend: 3000 };
  return {
    buildLogEntries: vi.fn(() => []),
    buildPortOverrideOptions: vi.fn(() => ({})),
    ensurePortsFreed: vi.fn(),
    extractProcessPorts: vi.fn(() => ({ frontendPort: null, backendPort: null })),
    getProjectPortHints: vi.fn(() => defaultPorts),
    getPlatformImpl: vi.fn(() => 'linux'),
    getRunningProcessEntry: vi.fn(() => ({
      processes: null,
      state: 'idle',
      snapshotVisible: false,
      launchType: 'manual'
    })),
    getStoredProjectPorts: vi.fn(() => defaultPorts),
    hasLiveProcess: vi.fn(() => true),
    parseSinceParam: vi.fn(() => null),
    resolveActivityState: vi.fn(() => 'idle'),
    resolveLastKnownPort: vi.fn((...ports) => ports.find((port) => port != null) ?? null),
    runningProcesses: runningProcessesMock,
    sanitizeProcessSnapshot: vi.fn((value) => value),
    storeRunningProcesses: vi.fn(),
    terminateRunningProcesses: vi.fn()
  };
});

const buildApp = async () => {
  const router = express.Router();
  const { registerProjectProcessRoutes } = await import('../routes/projects/routes.processes.js');
  registerProjectProcessRoutes(router);
  const app = express();
  app.use(express.json());
  app.use('/api/projects', router);
  return app;
};

describe('routes/processes', () => {
  let app;
  let db;
  let processManager;
  let tempDir;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = await import('../database.js');
    processManager = await import('../routes/projects/processManager.js');
    db.getProject.mockResolvedValue({ id: '123', name: 'Test Project' });
    app = await buildApp();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'processes-route-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('hides stale process snapshots when both child processes already exited', async () => {
    const snapshot = {
      frontend: { pid: 11, port: 6001 },
      backend: { pid: 22, port: 6002 }
    };

    processManager.getRunningProcessEntry.mockReturnValue({
      processes: snapshot,
      state: 'running',
      snapshotVisible: true,
      launchType: 'manual'
    });
    processManager.hasLiveProcess.mockReturnValue(false);

    const res = await request(app).get('/api/projects/123/processes').expect(200);

    expect(processManager.storeRunningProcesses).toHaveBeenCalledWith(
      '123',
      snapshot,
      'stopped',
      { exposeSnapshot: false }
    );
    expect(processManager.resolveActivityState).toHaveBeenCalledWith('stopped', false);
    expect(res.body.running).toBe(false);
    expect(res.body.isRunning).toBe(false);
    expect(res.body.processes).toEqual({ frontend: null, backend: null });
  });

  it('includes backend capability when entrypoint exists', async () => {
    const backendDir = path.join(tempDir, 'backend');
    await fs.mkdir(backendDir, { recursive: true });
    await fs.writeFile(path.join(backendDir, 'package.json'), JSON.stringify({ name: 'backend' }));

    db.getProject.mockResolvedValue({
      id: '123',
      name: 'Process Status',
      path: tempDir
    });

    const res = await request(app)
      .get('/api/projects/123/processes')
      .expect(200);

    expect(res.body.capabilities?.backend?.exists).toBe(true);
  });

  it('marks backend capability false when project path is missing', async () => {
    db.getProject.mockResolvedValue({
      id: '123',
      name: 'No Path',
      path: null
    });

    const res = await request(app)
      .get('/api/projects/123/processes')
      .expect(200);

    expect(res.body.capabilities?.backend?.exists).toBe(false);
  });

  it('returns 500 when backend entrypoint detection throws', async () => {
    const originalStat = fs.stat;
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (candidate) => {
      if (String(candidate).includes(path.join('backend', 'package.json'))) {
        const err = new Error('denied');
        err.code = 'EACCES';
        throw err;
      }
      return originalStat(candidate);
    });

    db.getProject.mockResolvedValue({
      id: '123',
      name: 'Process Error',
      path: tempDir
    });

    const res = await request(app)
      .get('/api/projects/123/processes')
      .expect(500);

    expect(res.body).toMatchObject({ success: false, error: 'Failed to load process status' });
    statSpy.mockRestore();
  });

  it('returns 409 when backend already exists', async () => {
    const backendDir = path.join(tempDir, 'backend');
    await fs.mkdir(backendDir, { recursive: true });
    await fs.writeFile(path.join(backendDir, 'package.json'), JSON.stringify({ name: 'backend' }));

    db.getProject.mockResolvedValue({
      id: '123',
      name: 'Backend Exists',
      path: tempDir,
      language: 'javascript,javascript',
      framework: 'react,express'
    });

    const res = await request(app)
      .post('/api/projects/123/backend/create')
      .expect(409);

    expect(res.body).toMatchObject({ success: false, error: 'Backend already exists' });
  });

  it('creates backend when missing and returns success without job', async () => {
    const generate = (await import('../services/projectScaffolding/generate.js')).generateBackendFiles;

    db.getProject.mockResolvedValue({
      id: '123',
      name: 'Backend Create',
      path: tempDir,
      language: 'javascript,python',
      framework: 'react,flask'
    });

    const res = await request(app)
      .post('/api/projects/123/backend/create')
      .expect(200);

    expect(generate).toHaveBeenCalledWith(
      path.join(tempDir, 'backend'),
      expect.objectContaining({ language: 'python', framework: 'flask' })
    );
    expect(res.body).toMatchObject({ success: true, job: null });
  });

  it('defaults backend metadata when language or framework is missing', async () => {
    const generate = (await import('../services/projectScaffolding/generate.js')).generateBackendFiles;

    db.getProject.mockResolvedValue({
      id: '123',
      name: '',
      path: tempDir,
      language: null,
      framework: 42
    });

    const res = await request(app)
      .post('/api/projects/123/backend/create')
      .expect(200);

    expect(generate).toHaveBeenCalledWith(
      path.join(tempDir, 'backend'),
      expect.objectContaining({
        name: 'backend',
        language: 'javascript',
        framework: 'express'
      })
    );
    expect(res.body).toMatchObject({ success: true });
  });

  it('returns 500 when backend entrypoint checks throw unexpected errors', async () => {
    const statSpy = vi.spyOn(fs, 'stat')
      .mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));

    db.getProject.mockResolvedValue({
      id: '123',
      name: 'Backend Error',
      path: tempDir,
      language: 'javascript,javascript',
      framework: 'react,express'
    });

    const res = await request(app)
      .post('/api/projects/123/backend/create')
      .expect(500);

    expect(res.body).toMatchObject({ success: false, error: 'Failed to create backend' });
    statSpy.mockRestore();
  });

  it('returns 404 when project is missing for backend creation', async () => {
    db.getProject.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/projects/123/backend/create')
      .expect(404);

    expect(res.body).toMatchObject({ success: false, error: 'Project not found' });
  });

  it('returns 400 when project path is missing for backend creation', async () => {
    db.getProject.mockResolvedValue({ id: '123', name: 'Missing Path', path: null });

    const res = await request(app)
      .post('/api/projects/123/backend/create')
      .expect(400);

    expect(res.body).toMatchObject({
      success: false,
      error: 'Project path not found. Please re-import or recreate the project.'
    });
  });

  it('returns 400 when project path is outside managed root', async () => {
    const cleanup = await import('../routes/projects/cleanup.js');
    cleanup.isWithinManagedProjectsRoot.mockReturnValue(false);

    db.getProject.mockResolvedValue({ id: '123', name: 'Unsafe', path: tempDir });

    const res = await request(app)
      .post('/api/projects/123/backend/create')
      .expect(400);

    expect(res.body).toMatchObject({ success: false, error: 'Invalid project path' });
    cleanup.isWithinManagedProjectsRoot.mockReturnValue(true);
  });

  it('returns install job payload when backend package exists', async () => {
    const { startJob } = await import('../services/jobRunner.js');
    const backendDir = path.join(tempDir, 'backend');
    const generate = (await import('../services/projectScaffolding/generate.js')).generateBackendFiles;
    generate.mockImplementation(async (targetPath) => {
      await fs.mkdir(targetPath, { recursive: true });
      await fs.writeFile(path.join(targetPath, 'package.json'), JSON.stringify({ name: 'backend' }));
    });

    startJob.mockResolvedValue({
      id: 'job-1',
      type: 'backend:install',
      displayName: 'Install backend dependencies',
      status: 'queued',
      command: 'npm',
      args: ['install'],
      cwd: backendDir,
      createdAt: new Date().toISOString()
    });

    db.getProject.mockResolvedValue({
      id: '123',
      name: 'Backend Job',
      path: tempDir,
      language: 'javascript,javascript',
      framework: 'react,express'
    });

    const res = await request(app)
      .post('/api/projects/123/backend/create')
      .expect(200);

    expect(res.body.job).toMatchObject({ id: 'job-1', type: 'backend:install' });
  });

  it('skips job details when backend install job fails to start', async () => {
    const { startJob } = await import('../services/jobRunner.js');
    const backendDir = path.join(tempDir, 'backend');
    const generate = (await import('../services/projectScaffolding/generate.js')).generateBackendFiles;
    generate.mockImplementation(async (targetPath) => {
      await fs.mkdir(targetPath, { recursive: true });
      await fs.writeFile(path.join(targetPath, 'package.json'), JSON.stringify({ name: 'backend' }));
    });

    startJob.mockRejectedValue(new Error('job failed'));

    db.getProject.mockResolvedValue({
      id: '123',
      name: 'Backend Job Fail',
      path: tempDir,
      language: 'javascript,javascript',
      framework: 'react,express'
    });

    const res = await request(app)
      .post('/api/projects/123/backend/create')
      .expect(200);

    expect(res.body.job).toBeNull();
  });

  it('logs a warning when backend install job fails to start', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { startJob } = await import('../services/jobRunner.js');
    const generate = (await import('../services/projectScaffolding/generate.js')).generateBackendFiles;
    generate.mockImplementation(async (targetPath) => {
      await fs.mkdir(targetPath, { recursive: true });
      await fs.writeFile(path.join(targetPath, 'package.json'), JSON.stringify({ name: 'backend' }));
    });

    startJob.mockRejectedValue(new Error('job failed'));

    db.getProject.mockResolvedValue({
      id: '123',
      name: 'Backend Job Fail',
      path: tempDir,
      language: 'javascript,javascript',
      framework: 'react,express'
    });

    await request(app)
      .post('/api/projects/123/backend/create')
      .expect(200);

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('logs a warning when backend install job fails without a message', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { startJob } = await import('../services/jobRunner.js');
    const generate = (await import('../services/projectScaffolding/generate.js')).generateBackendFiles;
    generate.mockImplementation(async (targetPath) => {
      await fs.mkdir(targetPath, { recursive: true });
      await fs.writeFile(path.join(targetPath, 'package.json'), JSON.stringify({ name: 'backend' }));
    });

    startJob.mockRejectedValue({ code: 'NO_JOB' });

    db.getProject.mockResolvedValue({
      id: '123',
      name: 'Backend Job Fail Silent',
      path: tempDir,
      language: 'javascript,javascript',
      framework: 'react,express'
    });

    await request(app)
      .post('/api/projects/123/backend/create')
      .expect(200);

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('returns 400 with details when start fails due to missing frontend package.json', async () => {
    const originalSkip = process.env.E2E_SKIP_SCAFFOLDING;
    delete process.env.E2E_SKIP_SCAFFOLDING;
    const { startProject } = await import('../services/projectScaffolding.js');
    startProject.mockRejectedValueOnce(new Error('No frontend package.json found in frontend/ or project root'));
    processManager.getRunningProcessEntry.mockReturnValue({
      processes: null,
      state: 'idle',
      snapshotVisible: false,
      launchType: 'manual'
    });

    db.getProject.mockResolvedValue({
      id: '123',
      name: 'Start Error',
      path: tempDir
    });

    const res = await request(app)
      .post('/api/projects/123/start')
      .expect(400);

    expect(res.body).toMatchObject({
      success: false,
      error: 'No frontend package.json found in frontend/ or project root'
    });
    expect(res.body.details).toBeTruthy();
    if (originalSkip === undefined) {
      delete process.env.E2E_SKIP_SCAFFOLDING;
    } else {
      process.env.E2E_SKIP_SCAFFOLDING = originalSkip;
    }
  });

  it('returns fallback error details when start fails without message', async () => {
    const { startProject } = await import('../services/projectScaffolding.js');
    const err = new Error('');
    err.name = '';
    err.stack = '';
    startProject.mockRejectedValueOnce(err);

    db.getProject.mockResolvedValue({
      id: '123',
      name: 'Start Error Missing Message',
      path: tempDir
    });

    const res = await request(app)
      .post('/api/projects/123/start')
      .expect(500);

    expect(res.body).toMatchObject({
      success: false,
      error: 'Failed to start project'
    });
    expect(res.body.details?.name).toBeNull();
    expect(res.body.details?.stack).toBeNull();
  });

  it('omits error details when start fails in production', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const { startProject } = await import('../services/projectScaffolding.js');
    startProject.mockRejectedValueOnce(new Error('boom'));

    db.getProject.mockResolvedValue({
      id: '123',
      name: 'Start Error Production',
      path: tempDir
    });

    const res = await request(app)
      .post('/api/projects/123/start')
      .expect(500);

    expect(res.body.details).toBeUndefined();
    process.env.NODE_ENV = originalEnv;
  });

  it('returns 400 with details when restart fails due to missing frontend package.json', async () => {
    const { startProject } = await import('../services/projectScaffolding.js');
    startProject.mockRejectedValueOnce(new Error('No frontend package.json found in frontend/ or project root'));

    db.getProject.mockResolvedValue({
      id: '123',
      name: 'Restart Error',
      path: tempDir
    });

    const res = await request(app)
      .post('/api/projects/123/restart')
      .expect(400);

    expect(res.body).toMatchObject({
      success: false,
      error: 'No frontend package.json found in frontend/ or project root'
    });
    expect(res.body.details).toBeTruthy();
  });

  it('returns 500 with details when restart fails for unexpected errors', async () => {
    const { startProject } = await import('../services/projectScaffolding.js');
    startProject.mockRejectedValueOnce(new Error('boom'));

    db.getProject.mockResolvedValue({
      id: '123',
      name: 'Restart Error',
      path: tempDir
    });

    const res = await request(app)
      .post('/api/projects/123/restart')
      .expect(500);

    expect(res.body).toMatchObject({
      success: false,
      error: 'Failed to restart project'
    });
    expect(res.body.details?.message).toBe('boom');
  });

  it('includes error name and stack when restart fails outside production', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    const { startProject } = await import('../services/projectScaffolding.js');
    const err = new Error('restart failed');
    err.name = 'RestartError';
    startProject.mockRejectedValueOnce(err);

    db.getProject.mockResolvedValue({
      id: '123',
      name: 'Restart Details',
      path: tempDir
    });

    const res = await request(app)
      .post('/api/projects/123/restart')
      .expect(500);

    expect(res.body.details?.message).toBe('restart failed');
    expect(res.body.details?.name).toBe('RestartError');
    expect(res.body.details?.stack).toBeTruthy();

    process.env.NODE_ENV = originalEnv;
  });

  it('uses null name and stack when restart error omits them', async () => {
    const { startProject } = await import('../services/projectScaffolding.js');
    const err = new Error('');
    err.name = '';
    err.stack = '';
    startProject.mockRejectedValueOnce(err);

    db.getProject.mockResolvedValue({
      id: '123',
      name: 'Restart Missing Details',
      path: tempDir
    });

    const res = await request(app)
      .post('/api/projects/123/restart')
      .expect(500);

    expect(res.body).toMatchObject({ success: false, error: 'Failed to restart project' });
    expect(res.body.details?.name).toBeNull();
    expect(res.body.details?.stack).toBeNull();
  });

  it('omits error details when restart fails in production', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const { startProject } = await import('../services/projectScaffolding.js');
    startProject.mockRejectedValueOnce(new Error('boom'));

    db.getProject.mockResolvedValue({
      id: '123',
      name: 'Restart Error Production',
      path: tempDir
    });

    const res = await request(app)
      .post('/api/projects/123/restart')
      .expect(500);

    expect(res.body.details).toBeUndefined();
    process.env.NODE_ENV = originalEnv;
  });

  it('returns 500 with fallback message when restart error is empty', async () => {
    const { startProject } = await import('../services/projectScaffolding.js');
    const err = new Error('');
    err.message = '';
    startProject.mockRejectedValueOnce(err);

    db.getProject.mockResolvedValue({
      id: '123',
      name: 'Restart Error',
      path: tempDir
    });

    const res = await request(app)
      .post('/api/projects/123/restart')
      .expect(500);

    expect(res.body).toMatchObject({
      success: false,
      error: 'Failed to restart project'
    });
    expect(res.body.details?.message).toBe('Failed to restart project');
  });

  it('logs a warning when windows backend restart triggers frontend recovery that throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { startProject } = await import('../services/projectScaffolding.js');

    processManager.getPlatformImpl.mockReturnValue('win32');
    processManager.hasLiveProcess.mockImplementation((processInfo) => Boolean(processInfo?.pid));

    processManager.getRunningProcessEntry
      .mockReturnValueOnce({
        processes: { frontend: { pid: 111, port: 5173 }, backend: { pid: 222, port: 3000 } },
        state: 'running',
        snapshotVisible: true,
        launchType: 'manual'
      })
      .mockReturnValueOnce({
        processes: { frontend: null, backend: null },
        state: 'running',
        snapshotVisible: true,
        launchType: 'manual'
      });

    startProject
      .mockResolvedValueOnce({ success: true, processes: { backend: { pid: 333, port: 6002 } } })
      .mockRejectedValueOnce(new Error('frontend recovery boom'));

    db.getProject.mockResolvedValue({ id: '123', name: 'Restart Warn', path: tempDir });

    await request(app)
      .post('/api/projects/123/restart?target=backend')
      .expect(200);

    expect(startProject).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('logs windows frontend recovery warning with error object fallback when message is blank (coverage)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { startProject } = await import('../services/projectScaffolding.js');

    processManager.getPlatformImpl.mockReturnValue('win32');
    processManager.hasLiveProcess.mockImplementation((processInfo) => Boolean(processInfo?.pid));

    processManager.getRunningProcessEntry
      .mockReturnValueOnce({
        processes: { frontend: { pid: 111, port: 5173 }, backend: { pid: 222, port: 3000 } },
        state: 'running',
        snapshotVisible: true,
        launchType: 'manual'
      })
      .mockReturnValueOnce({
        processes: { frontend: null, backend: null },
        state: 'running',
        snapshotVisible: true,
        launchType: 'manual'
      });

    const recoveryError = new Error('');
    recoveryError.message = '';

    startProject
      .mockResolvedValueOnce({ success: true, processes: { backend: { pid: 333, port: 6002 } } })
      .mockRejectedValueOnce(recoveryError);

    db.getProject.mockResolvedValue({ id: '123', name: 'Restart Warn Blank Message', path: tempDir });

    await request(app)
      .post('/api/projects/123/restart?target=backend')
      .expect(200);

    expect(warnSpy).toHaveBeenCalledWith('[restart] frontend recovery failed', recoveryError);

    warnSpy.mockRestore();
  });

  it('updates frontend port when restarting target=frontend succeeds', async () => {
    const { startProject } = await import('../services/projectScaffolding.js');

    startProject.mockResolvedValueOnce({
      success: true,
      processes: {
        frontend: { pid: 111, port: 6123 }
      }
    });

    db.getProject.mockResolvedValue({ id: '123', name: 'Restart Frontend', path: tempDir });

    await request(app)
      .post('/api/projects/123/restart?target=frontend')
      .expect(200);

    expect(db.updateProjectPorts).toHaveBeenCalledWith('123', { frontendPort: 6123 });
  });

  it('does not update frontend port when restarting target=frontend returns no port', async () => {
    const { startProject } = await import('../services/projectScaffolding.js');

    startProject.mockResolvedValueOnce({
      success: true,
      processes: {
        frontend: { pid: 111, port: null }
      }
    });

    db.getProject.mockResolvedValue({ id: '123', name: 'Restart Frontend Missing Port', path: tempDir });

    await request(app)
      .post('/api/projects/123/restart?target=frontend')
      .expect(200);

    expect(db.updateProjectPorts).toHaveBeenCalledWith('123', {});
  });

  it('records recovered frontend port when windows backend restart recovers frontend successfully', async () => {
    const { startProject } = await import('../services/projectScaffolding.js');

    processManager.getPlatformImpl.mockReturnValue('win32');
    processManager.hasLiveProcess.mockImplementation((processInfo) => Boolean(processInfo?.pid));

    processManager.getRunningProcessEntry
      .mockReturnValueOnce({
        processes: { frontend: { pid: 111, port: 5173 }, backend: { pid: 222, port: 3000 } },
        state: 'running',
        snapshotVisible: true,
        launchType: 'manual'
      })
      .mockReturnValueOnce({
        processes: { frontend: null, backend: null },
        state: 'running',
        snapshotVisible: true,
        launchType: 'manual'
      });

    startProject
      .mockResolvedValueOnce({ success: true, processes: { backend: { pid: 333, port: 6002 } } })
      .mockResolvedValueOnce({ success: true, processes: { frontend: { pid: 444, port: 6001 } } });

    db.getProject.mockResolvedValue({ id: '123', name: 'Restart Backend', path: tempDir });

    await request(app)
      .post('/api/projects/123/restart?target=backend')
      .expect(200);

    expect(db.updateProjectPorts).toHaveBeenCalledWith('123', { backendPort: 6002, frontendPort: 6001 });
  });

  it('passes null port hints to windows frontend recovery when port base overrides force reassignment (coverage)', async () => {
    const { startProject } = await import('../services/projectScaffolding.js');

    processManager.getPlatformImpl.mockReturnValue('win32');
    processManager.hasLiveProcess.mockImplementation((processInfo) => Boolean(processInfo?.pid));
    processManager.buildPortOverrideOptions.mockReturnValue({
      frontendPortBase: 9999,
      backendPortBase: 9998
    });

    processManager.getRunningProcessEntry
      .mockReturnValueOnce({
        processes: { frontend: { pid: 111, port: 5173 }, backend: { pid: 222, port: 3000 } },
        state: 'running',
        snapshotVisible: true,
        launchType: 'manual'
      })
      .mockReturnValueOnce({
        processes: { frontend: null, backend: null },
        state: 'running',
        snapshotVisible: true,
        launchType: 'manual'
      });

    startProject
      .mockResolvedValueOnce({ success: true, processes: { backend: { pid: 333, port: 6002 } } })
      .mockResolvedValueOnce({ success: true, processes: { frontend: { pid: 444, port: 6001 } } });

    db.getProject.mockResolvedValue({ id: '123', name: 'Restart Backend Overrides', path: tempDir });

    await request(app)
      .post('/api/projects/123/restart?target=backend')
      .expect(200);

    expect(startProject).toHaveBeenCalledTimes(2);
    expect(startProject.mock.calls[1][1]).toEqual(expect.objectContaining({
      target: 'frontend',
      frontendPort: null,
      backendPort: null,
      frontendPortBase: 9999,
      backendPortBase: 9998
    }));
    expect(db.updateProjectPorts).toHaveBeenCalledWith('123', { backendPort: 6002, frontendPort: 6001 });
  });

  it('skips windows frontend recovery when startProject resolves to null (coverage)', async () => {
    const { startProject } = await import('../services/projectScaffolding.js');

    processManager.getPlatformImpl.mockReturnValue('win32');
    processManager.hasLiveProcess.mockImplementation((processInfo) => Boolean(processInfo?.pid));

    processManager.getRunningProcessEntry
      .mockReturnValueOnce({
        processes: { frontend: { pid: 111, port: 5173 }, backend: { pid: 222, port: 3000 } },
        state: 'running',
        snapshotVisible: true,
        launchType: 'manual'
      })
      .mockReturnValueOnce({
        processes: { frontend: null, backend: null },
        state: 'running',
        snapshotVisible: true,
        launchType: 'manual'
      });

    startProject
      .mockResolvedValueOnce({ success: true, processes: { backend: { pid: 333, port: 6002 } } })
      .mockResolvedValueOnce(null);

    db.getProject.mockResolvedValue({ id: '123', name: 'Restart Backend Null Recovery', path: tempDir });

    await request(app)
      .post('/api/projects/123/restart?target=backend')
      .expect(200);

    expect(startProject).toHaveBeenCalledTimes(2);
    expect(db.updateProjectPorts).toHaveBeenCalledWith('123', { backendPort: 6002 });
  });

  it('treats successful windows frontend recovery without a frontend snapshot as null (coverage)', async () => {
    const { startProject } = await import('../services/projectScaffolding.js');

    processManager.getPlatformImpl.mockReturnValue('win32');
    processManager.hasLiveProcess.mockImplementation((processInfo) => Boolean(processInfo?.pid));

    processManager.getRunningProcessEntry
      .mockReturnValueOnce({
        processes: { frontend: { pid: 111, port: 5173 }, backend: { pid: 222, port: 3000 } },
        state: 'running',
        snapshotVisible: true,
        launchType: 'manual'
      })
      .mockReturnValueOnce({
        processes: { frontend: null, backend: null },
        state: 'running',
        snapshotVisible: true,
        launchType: 'manual'
      });

    startProject
      .mockResolvedValueOnce({ success: true, processes: { backend: { pid: 333, port: 6002 } } })
      .mockResolvedValueOnce({ success: true, processes: {} });

    db.getProject.mockResolvedValue({ id: '123', name: 'Restart Backend Missing Recovery Snapshot', path: tempDir });

    await request(app)
      .post('/api/projects/123/restart?target=backend')
      .expect(200);

    expect(startProject).toHaveBeenCalledTimes(2);
    expect(db.updateProjectPorts).toHaveBeenCalledWith('123', { backendPort: 6002 });
  });

  it('skips recovered frontend port update when recovery succeeds without a port', async () => {
    const { startProject } = await import('../services/projectScaffolding.js');

    processManager.getPlatformImpl.mockReturnValue('win32');
    processManager.hasLiveProcess.mockImplementation((processInfo) => Boolean(processInfo?.pid));

    processManager.getRunningProcessEntry
      .mockReturnValueOnce({
        processes: { frontend: { pid: 111, port: 5173 }, backend: { pid: 222, port: 3000 } },
        state: 'running',
        snapshotVisible: true,
        launchType: 'manual'
      })
      .mockReturnValueOnce({
        processes: { frontend: null, backend: null },
        state: 'running',
        snapshotVisible: true,
        launchType: 'manual'
      });

    startProject
      .mockResolvedValueOnce({ success: true, processes: { backend: { pid: 333, port: 6002 } } })
      .mockResolvedValueOnce({ success: true, processes: { frontend: { pid: 444, port: null } } });

    db.getProject.mockResolvedValue({ id: '123', name: 'Restart Backend Missing Frontend Port', path: tempDir });

    await request(app)
      .post('/api/projects/123/restart?target=backend')
      .expect(200);

    expect(db.updateProjectPorts).toHaveBeenCalledWith('123', { backendPort: 6002 });
  });
});
