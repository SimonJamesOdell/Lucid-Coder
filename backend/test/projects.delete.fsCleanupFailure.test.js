import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../database.js', () => ({
  createProject: vi.fn(),
  getAllProjects: vi.fn(),
  getProject: vi.fn(),
  getProjectByName: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  getGitSettings: vi.fn(),
  getPortSettings: vi.fn()
}));

vi.mock('../services/projectScaffolding.js', () => ({
  createProjectWithFiles: vi.fn()
}));

vi.mock('../utils/projectPaths.js', () => ({
  resolveProjectPath: vi.fn((value) => value)
}));

vi.mock('../services/progressTracker.js', () => ({
  initProgress: vi.fn(),
  updateProgress: vi.fn(),
  completeProgress: vi.fn(),
  failProgress: vi.fn(),
  attachProgressStream: vi.fn(),
  getProgressSnapshot: vi.fn()
}));

vi.mock('../routes/projects/routes.files.js', () => ({
  registerProjectFileRoutes: vi.fn()
}));

vi.mock('../routes/projects/routes.git.js', () => ({
  registerProjectGitRoutes: vi.fn()
}));

vi.mock('../routes/projects/routes.processes.js', () => ({
  registerProjectProcessRoutes: vi.fn()
}));

vi.mock('../routes/projects/processManager.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    extractProcessPorts: vi.fn(),
    findProjectByIdentifier: vi.fn(),
    storeRunningProcesses: vi.fn(),
    terminateRunningProcesses: vi.fn().mockResolvedValue()
  };
});

vi.mock('../routes/projects/cleanup.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    buildCleanupTargets: vi.fn(() => ['C:/tmp/project-cleanup-target']),
    hasUnsafeCommandCharacters: vi.fn(() => false),
    isWithinManagedProjectsRoot: vi.fn(() => true)
  };
});

describe('DELETE /api/projects/:id cleanup fs acquisition failures', () => {
  let app;
  let projectsModule;

  beforeEach(async () => {
    vi.restoreAllMocks();

    // Import after mocks are registered.
    projectsModule = await import('../routes/projects.js');

    app = express();
    app.use(express.json());
    app.use('/api/projects', projectsModule.default);
  });

  afterEach(() => {
    try {
      projectsModule?.__projectRoutesInternals?.resetFsModuleOverride?.();
    } catch {
      // best-effort
    }
    vi.restoreAllMocks();
  });

  it('still deletes the project and logs a warning when getFsModule rejects', async () => {
    const { deleteProject } = await import('../database.js');
    const processManager = await import('../routes/projects/processManager.js');

    const project = {
      id: 123,
      name: 'Test Project',
      description: 'Test',
      frontend: true,
      backend: true,
      path: 'C:/tmp/test-project',
      createdAt: new Date().toISOString()
    };

    processManager.findProjectByIdentifier.mockResolvedValue(project);

    deleteProject.mockResolvedValue(true);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    projectsModule.__projectRoutesInternals.setFsModuleOverride({
      then: (_resolve, reject) => reject(new Error('fs module unavailable'))
    });

    const response = await request(app)
      .delete('/api/projects/123?confirm=true')
      .expect(200);

    expect(response.body).toEqual({
      success: true,
      message: 'Project deleted, but cleanup failed. See cleanup details.',
      cleanup: {
        success: false,
        failures: [
          {
            target: null,
            code: null,
            message: 'fs module unavailable'
          }
        ]
      }
    });

    expect(warnSpy).toHaveBeenCalledWith(
      '⚠️ Warning: Could not clean up project directories:',
      ['C:/tmp/project-cleanup-target'],
      'fs module unavailable'
    );
  });

  it('uses cleanup failed fallback message when fs acquisition rejection has no message', async () => {
    const { deleteProject } = await import('../database.js');
    const processManager = await import('../routes/projects/processManager.js');

    processManager.findProjectByIdentifier.mockResolvedValue({
      id: 456,
      name: 'No Message Cleanup Error',
      path: 'C:/tmp/test-project-2'
    });
    deleteProject.mockResolvedValue(true);

    projectsModule.__projectRoutesInternals.setFsModuleOverride({
      then: (_resolve, reject) => reject({})
    });

    const response = await request(app)
      .delete('/api/projects/456?confirm=true')
      .expect(200);

    expect(response.body.cleanup.failures[0]).toEqual({
      target: null,
      code: null,
      message: 'cleanup failed'
    });
  });

  it('uses production delete release delay when NODE_ENV is not test', async () => {
    const { deleteProject } = await import('../database.js');
    const processManager = await import('../routes/projects/processManager.js');
    const originalNodeEnv = process.env.NODE_ENV;

    process.env.NODE_ENV = 'production';
    processManager.findProjectByIdentifier.mockResolvedValue({
      id: 789,
      name: 'Production Delay Project',
      path: 'C:/tmp/test-project-3'
    });
    deleteProject.mockResolvedValue(true);

    try {
      await request(app)
        .delete('/api/projects/789?confirm=true')
        .expect(200);

      expect(processManager.terminateRunningProcesses).toHaveBeenCalledWith(
        789,
        expect.objectContaining({
          waitForRelease: true,
          releaseDelay: 2000
        })
      );
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('skips Windows settle delay branch on non-win32 platforms', async () => {
    const { deleteProject } = await import('../database.js');
    const processManager = await import('../routes/projects/processManager.js');
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

    processManager.findProjectByIdentifier.mockResolvedValue({
      id: 790,
      name: 'Non Windows Delay Project',
      path: 'C:/tmp/test-project-4'
    });
    deleteProject.mockResolvedValue(true);

    try {
      await request(app)
        .delete('/api/projects/790?confirm=true')
        .expect(200);

      expect(processManager.terminateRunningProcesses).toHaveBeenCalledWith(
        790,
        expect.objectContaining({
          waitForRelease: true
        })
      );
    } finally {
      platformSpy.mockRestore();
    }
  });
});
