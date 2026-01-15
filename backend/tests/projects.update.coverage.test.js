import { describe, test, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import path from 'path';

vi.mock('../routes/projects/routes.files.js', () => ({
  registerProjectFileRoutes: () => {}
}));

vi.mock('../routes/projects/routes.git.js', () => ({
  registerProjectGitRoutes: () => {}
}));

vi.mock('../routes/projects/routes.processes.js', () => ({
  registerProjectProcessRoutes: () => {}
}));

vi.mock('../services/projectScaffolding.js', () => ({
  createProjectWithFiles: vi.fn()
}));

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

describe('Projects routes coverage: update path branches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('allows project path updates within managed root', async () => {
    const db = await import('../database.js');
    db.getProject.mockResolvedValue({ id: 1, name: 'demo', path: '/existing' });
    db.updateProject.mockImplementation(async (_id, updates) => ({
      id: 1,
      name: updates.name,
      description: updates.description,
      language: updates.language,
      framework: updates.framework,
      path: updates.path
    }));

    const originalEnv = { ...process.env };
    process.env.PROJECTS_DIR = path.join(process.cwd(), 'managed-root-test');

    try {
      const projectRoutes = (await import('../routes/projects.js')).default;

      const app = express();
      app.use(express.json());
      app.use('/api/projects', projectRoutes);

      const allowedPath = path.join(process.env.PROJECTS_DIR, 'demo');
      const ok = await request(app)
        .put('/api/projects/1')
        .send({ name: 'demo', path: allowedPath });

      expect(ok.status).toBe(200);
      expect(db.updateProject).toHaveBeenCalledWith(
        '1',
        expect.objectContaining({ path: allowedPath })
      );
    } finally {
      process.env = originalEnv;
    }
  });

  test('rejects project path updates outside managed root', async () => {
    const db = await import('../database.js');
    db.getProject.mockResolvedValue({ id: 1, name: 'demo', path: '/existing' });
    db.updateProject.mockResolvedValue({ id: 1, name: 'demo', path: '/existing' });

    const originalEnv = { ...process.env };
    process.env.PROJECTS_DIR = path.join(process.cwd(), 'managed-root-test');

    try {
      const projectRoutes = (await import('../routes/projects.js')).default;

      const app = express();
      app.use(express.json());
      app.use('/api/projects', projectRoutes);

      const outsidePath = path.join(process.cwd(), '..', 'outside-managed-root');
      const response = await request(app)
        .put('/api/projects/1')
        .send({ name: 'demo', path: outsidePath });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        success: false,
        error: 'Invalid project path'
      });
      expect(db.updateProject).not.toHaveBeenCalled();
    } finally {
      process.env = originalEnv;
    }
  });

  test('treats blank string path as null', async () => {
    const db = await import('../database.js');
    db.getProject.mockResolvedValue({ id: 1, name: 'demo', path: '/existing' });
    db.updateProject.mockImplementation(async (_id, updates) => ({
      id: 1,
      name: updates.name,
      description: updates.description,
      language: updates.language,
      framework: updates.framework,
      path: updates.path
    }));

    const projectRoutes = (await import('../routes/projects.js')).default;

    const app = express();
    app.use(express.json());
    app.use('/api/projects', projectRoutes);

    const response = await request(app)
      .put('/api/projects/1')
      .send({ name: 'demo', path: '   ' });

    expect(response.status).toBe(200);
    expect(db.updateProject).toHaveBeenCalledWith(
      '1',
      expect.objectContaining({ path: null })
    );
    expect(response.body.success).toBe(true);
    expect(response.body.project.path).toBe(null);
  });

  test('treats explicit null path as null', async () => {
    const db = await import('../database.js');
    db.getProject.mockResolvedValue({ id: 1, name: 'demo', path: '/existing' });
    db.updateProject.mockImplementation(async (_id, updates) => ({
      id: 1,
      name: updates.name,
      description: updates.description,
      language: updates.language,
      framework: updates.framework,
      path: updates.path
    }));

    const projectRoutes = (await import('../routes/projects.js')).default;

    const app = express();
    app.use(express.json());
    app.use('/api/projects', projectRoutes);

    const response = await request(app)
      .put('/api/projects/1')
      .send({ name: 'demo', path: null });

    expect(response.status).toBe(200);
    expect(db.updateProject).toHaveBeenCalledWith(
      '1',
      expect.objectContaining({ path: null })
    );
    expect(response.body.success).toBe(true);
    expect(response.body.project.path).toBe(null);
  });

  test('returns 404 when updateProject reports missing row', async () => {
    const db = await import('../database.js');
    db.getProject.mockResolvedValue({ id: 1, name: 'demo', path: '/existing' });
    db.updateProject.mockResolvedValue(null);

    const projectRoutes = (await import('../routes/projects.js')).default;

    const app = express();
    app.use(express.json());
    app.use('/api/projects', projectRoutes);

    const response = await request(app)
      .put('/api/projects/1')
      .send({ name: 'demo' });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      success: false,
      error: 'Project not found'
    });
  });
});
