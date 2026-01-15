import { describe, test, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// This file intentionally imports ../routes/projects.js at runtime (inside the test)
// so top-level route registration lines are captured by V8 coverage.

vi.mock('../database.js', () => ({
  createProject: vi.fn(),
  getAllProjects: vi.fn(),
  getProject: vi.fn().mockResolvedValue(null),
  getProjectByName: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  getGitSettings: vi.fn(),
  getPortSettings: vi.fn()
}));

vi.mock('../services/projectScaffolding.js', () => ({
  createProjectWithFiles: vi.fn(),
  startProject: vi.fn()
}));

vi.mock('../utils/projectPaths.js', () => ({
  resolveProjectPath: vi.fn((name) => `/tmp/${String(name || '').trim()}`)
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

describe('Projects routes import-time coverage (projects.js)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('captures top-level registration and 404 in GET /api/projects/:id', async () => {
    const { default: projectRoutes } = await import('../routes/projects.js');

    const app = express();
    app.use(express.json());
    app.use('/api/projects', projectRoutes);

    const response = await request(app).get('/api/projects/999999');

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ success: false, error: 'Project not found' });
  });
});
