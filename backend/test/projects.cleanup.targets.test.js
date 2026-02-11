import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const loadProjectsRoute = async ({ project = null, cleanupTargets = [] } = {}) => {
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
      findProjectByIdentifier: vi.fn().mockResolvedValue(project),
      storeRunningProcesses: vi.fn(),
      terminateRunningProcesses: vi.fn().mockResolvedValue()
    };
  });

  const cleanupExecutor = vi.fn().mockResolvedValue();

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
      buildCleanupTargets: vi.fn(() => cleanupTargets),
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

  return { app, cleanupExecutor };
};

describe('POST /api/projects/:id/cleanup manual targets', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 404 when no project and no manual targets', async () => {
    const { app } = await loadProjectsRoute();

    const response = await request(app)
      .post('/api/projects/123/cleanup')
      .send({})
      .expect(404);

    expect(response.body).toEqual({
      success: false,
      error: 'Project not found'
    });
  });

  it('returns 400 when cleanup targets resolve to empty', async () => {
    const { app } = await loadProjectsRoute({
      project: { id: 1, name: 'Project One', path: 'C:/projects/project-one' },
      cleanupTargets: []
    });

    const response = await request(app)
      .post('/api/projects/1/cleanup')
      .send({})
      .expect(400);

    expect(response.body).toEqual({
      success: false,
      error: 'No cleanup targets available'
    });
  });

  it('accepts manual targets when project is missing', async () => {
    const { app, cleanupExecutor } = await loadProjectsRoute();

    const response = await request(app)
      .post('/api/projects/777/cleanup')
      .send({ targets: ['C:/projects/project-one'] })
      .expect(200);

    expect(cleanupExecutor).toHaveBeenCalledTimes(1);
    expect(cleanupExecutor.mock.calls[0][1]).toBe('C:/projects/project-one');
    expect(response.body.success).toBe(true);
    expect(response.body.cleanup).toEqual({
      success: true,
      failures: []
    });
  });
});
