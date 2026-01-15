import { describe, it, beforeEach, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../database.js', () => ({
  getProject: vi.fn(),
  getPortSettings: vi.fn(),
  updateProjectPorts: vi.fn()
}));

vi.mock('../services/projectScaffolding.js', () => ({
  startProject: vi.fn()
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

  beforeEach(async () => {
    vi.clearAllMocks();
    db = await import('../database.js');
    processManager = await import('../routes/projects/processManager.js');
    db.getProject.mockResolvedValue({ id: '123', name: 'Test Project' });
    app = await buildApp();
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
});
