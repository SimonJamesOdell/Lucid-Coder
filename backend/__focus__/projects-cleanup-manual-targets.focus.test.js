import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const loadProjectsRoute = async () => {
  vi.resetModules();

  vi.doMock('../database.js', () => ({
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

  vi.doMock('../routes/projects/processManager.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
      ...actual,
      extractProcessPorts: vi.fn(),
      findProjectByIdentifier: vi.fn().mockResolvedValue(null),
      storeRunningProcesses: vi.fn(),
      terminateRunningProcesses: vi.fn().mockResolvedValue()
    };
  });

  const cleanupExecutor = vi.fn().mockResolvedValue();
  const buildCleanupTargets = vi.fn(() => []);

  vi.doMock('../routes/projects/cleanup.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
      ...actual,
      addCleanupTarget: (collection, candidate) => {
        if (!candidate) {
          return false;
        }
        collection.add(candidate);
        return true;
      },
      buildCleanupTargets,
      cleanupDirectoryExecutor: cleanupExecutor,
      hasUnsafeCommandCharacters: vi.fn(() => false),
      isWithinManagedProjectsRoot: vi.fn(() => true)
    };
  });

  vi.doMock('../routes/projects/internals.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
      ...actual,
      getFsModule: vi.fn().mockResolvedValue({}),
      requireDestructiveConfirmation: vi.fn(() => false)
    };
  });

  vi.doMock('../routes/projects/routes.files.js', () => ({
    registerProjectFileRoutes: vi.fn()
  }));

  vi.doMock('../routes/projects/routes.git.js', () => ({
    registerProjectGitRoutes: vi.fn()
  }));

  vi.doMock('../routes/projects/routes.processes.js', () => ({
    registerProjectProcessRoutes: vi.fn()
  }));

  const module = await import('../routes/projects.js');
  const app = express();
  app.use(express.json());
  app.use('/api/projects', module.default);

  return { app, buildCleanupTargets, cleanupExecutor };
};

describe('projects cleanup manual targets focus', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sorts manual targets by length and skips buildCleanupTargets', async () => {
    const { app, buildCleanupTargets, cleanupExecutor } = await loadProjectsRoute();

    const response = await request(app)
      .post('/api/projects/555/cleanup')
      .send({ targets: ['C:/projects/project-one', 'C:/projects/longer-project-two'] })
      .expect(200);

    expect(buildCleanupTargets).not.toHaveBeenCalled();
    expect(cleanupExecutor).toHaveBeenCalledTimes(2);
    expect(cleanupExecutor).toHaveBeenNthCalledWith(1, expect.any(Object), 'C:/projects/longer-project-two');
    expect(cleanupExecutor).toHaveBeenNthCalledWith(2, expect.any(Object), 'C:/projects/project-one');
    expect(response.body.success).toBe(true);
  });
});
