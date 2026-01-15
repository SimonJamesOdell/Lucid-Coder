import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import os from 'os';
import path from 'path';

describe('Projects files-diff resolved-path safety', () => {
  let app;
  let getProject;
  let runGitCommand;
  let originalResolve;
  let originalProjectsDir;
  let managedProjectsDir;

  beforeAll(async () => {
    vi.resetModules();

    originalProjectsDir = process.env.PROJECTS_DIR;
    managedProjectsDir = path.join(os.tmpdir(), `lucidcoder-managed-projects-${Date.now()}`);
    process.env.PROJECTS_DIR = managedProjectsDir;

    getProject = vi.fn();
    vi.doMock('../database.js', () => ({
      createProject: vi.fn(),
      getAllProjects: vi.fn(),
      getProject,
      getProjectByName: vi.fn(),
      updateProject: vi.fn(),
      deleteProject: vi.fn(),
      getGitSettings: vi.fn(),
      getPortSettings: vi.fn(),
      saveProjectGitSettings: vi.fn(),
      getProjectGitSettings: vi.fn(),
      deleteProjectGitSettings: vi.fn(),
      updateProjectPorts: vi.fn()
    }));

    runGitCommand = vi.fn();
    vi.doMock('../utils/git.js', async () => {
      const actual = await vi.importActual('../utils/git.js');
      return {
        ...actual,
        runGitCommand
      };
    });

    const projectRoutes = (await import('../routes/projects.js')).default;
    app = express();
    app.use(express.json());
    app.use('/api/projects', projectRoutes);
  });

  afterAll(() => {
    process.env.PROJECTS_DIR = originalProjectsDir;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalResolve) {
      path.resolve = originalResolve;
      originalResolve = undefined;
    }
  });

  test('rejects when resolved path escapes project directory', async () => {
    getProject.mockResolvedValue({ id: 123, path: path.join(managedProjectsDir, 'project-root') });

    // Override at runtime (projects.js uses `path.resolve(...)` directly), so we
    // can deterministically trigger the containment guard on Windows.
    originalResolve = path.resolve;
    path.resolve = (value) => {
      if (typeof value === 'string' && value.includes('force-outside.txt')) {
        return originalResolve('C:\\outside');
      }
      return originalResolve(value);
    };

    // If the guard fails to trigger for some reason, avoid a noisy TypeError.
    runGitCommand.mockResolvedValue({ code: 0, stdout: '', stderr: '' });

    const response = await request(app)
      .get('/api/projects/123/files-diff/force-outside.txt')
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Invalid file path');
    expect(runGitCommand).not.toHaveBeenCalled();

    const responseContent = await request(app)
      .get('/api/projects/123/files-diff-content/force-outside.txt')
      .expect(400);

    expect(responseContent.body.success).toBe(false);
    expect(responseContent.body.error).toBe('Invalid file path');
    expect(runGitCommand).not.toHaveBeenCalled();

  });
});
