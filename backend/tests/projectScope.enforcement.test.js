import { describe, test, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import path from 'path';

vi.mock('../services/projectScaffolding.js', () => ({
  startProject: vi.fn()
}));

vi.mock('../database.js', () => ({
  createProject: vi.fn(),
  getAllProjects: vi.fn(),
  getProject: vi.fn(),
  getProjectByName: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  getGitSettings: vi.fn(),
  getPortSettings: vi.fn(),
  updateProjectPorts: vi.fn(),
  deleteProjectGitSettings: vi.fn(),
  getProjectGitSettings: vi.fn(),
  saveProjectGitSettings: vi.fn()
}));

vi.mock('../services/remoteRepoService.js', () => ({
  createRemoteRepository: vi.fn(),
  RemoteRepoCreationError: class RemoteRepoCreationError extends Error {}
}));

describe('Project scope enforcement (managed root)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const withManagedRootEnv = async (fn) => {
    const originalProjectsDir = process.env.PROJECTS_DIR;
    process.env.PROJECTS_DIR = path.join(process.cwd(), 'managed-root-scope');
    try {
      await fn();
    } finally {
      process.env.PROJECTS_DIR = originalProjectsDir;
    }
  };

  const buildOutOfScopeProject = () => ({
    id: 1,
    name: 'demo',
    path: path.join(process.cwd(), '..', 'outside-managed-root')
  });

  test('rejects file tree requests when project.path is outside managed root', async () => {
    const db = await import('../database.js');

    await withManagedRootEnv(async () => {
      db.getProject.mockResolvedValue(buildOutOfScopeProject());

      const projectRoutes = (await import('../routes/projects.js')).default;

      const app = express();
      app.use(express.json());
      app.use('/api/projects', projectRoutes);

      const response = await request(app)
        .get('/api/projects/1/files')
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'Invalid project path'
      });
    });
  });

  test('rejects start requests when project.path is outside managed root', async () => {
    const db = await import('../database.js');
    const scaffolding = await import('../services/projectScaffolding.js');

    await withManagedRootEnv(async () => {
      db.getProject.mockResolvedValue(buildOutOfScopeProject());

      const projectRoutes = (await import('../routes/projects.js')).default;

      const app = express();
      app.use(express.json());
      app.use('/api/projects', projectRoutes);

      const response = await request(app)
        .post('/api/projects/1/start')
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'Invalid project path'
      });
      expect(scaffolding.startProject).not.toHaveBeenCalled();
    });
  });

  test('rejects other file endpoints when project.path is outside managed root', async () => {
    const db = await import('../database.js');

    await withManagedRootEnv(async () => {
      db.getProject.mockResolvedValue(buildOutOfScopeProject());

      const projectRoutes = (await import('../routes/projects.js')).default;

      const app = express();
      app.use(express.json());
      app.use('/api/projects', projectRoutes);

      await request(app)
        .get('/api/projects/1/files-diff/src/App.jsx')
        .expect(400)
        .then((response) => {
          expect(response.body).toEqual({ success: false, error: 'Invalid project path' });
        });

      await request(app)
        .get('/api/projects/1/files-diff-content/src/App.jsx')
        .expect(400)
        .then((response) => {
          expect(response.body).toEqual({ success: false, error: 'Invalid project path' });
        });

      await request(app)
        .get('/api/projects/1/files/src/App.jsx')
        .expect(400)
        .then((response) => {
          expect(response.body).toEqual({ success: false, error: 'Invalid project path' });
        });

      await request(app)
        .put('/api/projects/1/files/src/App.jsx')
        .send({ content: 'test' })
        .expect(400)
        .then((response) => {
          expect(response.body).toEqual({ success: false, error: 'Invalid project path' });
        });
    });
  });

  test('rejects file-ops endpoints when project.path is outside managed root', async () => {
    const db = await import('../database.js');

    await withManagedRootEnv(async () => {
      db.getProject.mockResolvedValue(buildOutOfScopeProject());

      const projectRoutes = (await import('../routes/projects.js')).default;

      const app = express();
      app.use(express.json());
      app.use('/api/projects', projectRoutes);

      await request(app)
        .post('/api/projects/1/files-ops/mkdir')
        .send({ folderPath: 'src/new-folder' })
        .expect(400)
        .then((response) => {
          expect(response.body).toEqual({ success: false, error: 'Invalid project path' });
        });

      await request(app)
        .post('/api/projects/1/files-ops/create-file')
        .send({ filePath: 'src/new-file.txt', content: 'hello' })
        .expect(400)
        .then((response) => {
          expect(response.body).toEqual({ success: false, error: 'Invalid project path' });
        });

      await request(app)
        .post('/api/projects/1/files-ops/rename')
        .send({ fromPath: 'src/a.txt', toPath: 'src/b.txt' })
        .expect(400)
        .then((response) => {
          expect(response.body).toEqual({ success: false, error: 'Invalid project path' });
        });

      await request(app)
        .post('/api/projects/1/files-ops/delete')
        .send({ targetPath: 'src/tmp', recursive: true })
        .expect(400)
        .then((response) => {
          expect(response.body).toEqual({ success: false, error: 'Invalid project path' });
        });

      await request(app)
        .post('/api/projects/1/files-ops/duplicate')
        .send({ sourcePath: 'src/a.txt', destinationPath: 'src/a.copy.txt' })
        .expect(400)
        .then((response) => {
          expect(response.body).toEqual({ success: false, error: 'Invalid project path' });
        });
    });
  });

  test('rejects restart requests when project.path is outside managed root', async () => {
    const db = await import('../database.js');
    const scaffolding = await import('../services/projectScaffolding.js');

    await withManagedRootEnv(async () => {
      db.getProject.mockResolvedValue(buildOutOfScopeProject());

      const projectRoutes = (await import('../routes/projects.js')).default;

      const app = express();
      app.use(express.json());
      app.use('/api/projects', projectRoutes);

      const response = await request(app)
        .post('/api/projects/1/restart')
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'Invalid project path'
      });
      expect(scaffolding.startProject).not.toHaveBeenCalled();
    });
  });
});
