import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

import { initializeDatabase, closeDatabase, createProject } from '../database.js';

describe('Projects /files routes unexpected resolver errors (coverage)', () => {
  let originalProjectsDir;
  let managedProjectsDir;
  let projectPath;

  beforeAll(async () => {
    originalProjectsDir = process.env.PROJECTS_DIR;
    managedProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-managed-projects-files-unexpected-'));
    process.env.PROJECTS_DIR = managedProjectsDir;
    await initializeDatabase();
  });

  afterAll(async () => {
    await closeDatabase();
    process.env.PROJECTS_DIR = originalProjectsDir;
    if (managedProjectsDir) {
      await fs.rm(managedProjectsDir, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    vi.resetModules();
    projectPath = await fs.mkdtemp(path.join(managedProjectsDir, 'lucidcoder-project-files-unexpected-'));
  });

  afterEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    if (projectPath) {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  test('GET /files returns 500 when resolveProjectRelativePath throws non-400 errors', async () => {
    vi.doMock('../routes/projects/internals.js', async () => {
      const actual = await vi.importActual('../routes/projects/internals.js');
      return {
        ...actual,
        resolveProjectRelativePath: () => {
          throw new Error('boom');
        }
      };
    });

    const { default: projectRoutes } = await import('../routes/projects.js');
    const app = express();
    app.use(express.json());
    app.use('/api/projects', projectRoutes);

    const project = await createProject({
      name: `files-unexpected-${Date.now()}`,
      description: 'Unexpected resolver error coverage',
      language: 'javascript',
      framework: 'react',
      path: projectPath
    });

    const response = await request(app)
      .get(`/api/projects/${project.id}/files/src/hello.txt`)
      .expect(500);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Failed to read file');
  });

  test('PUT /files returns 500 when resolveProjectRelativePath throws non-400 errors', async () => {
    vi.doMock('../routes/projects/internals.js', async () => {
      const actual = await vi.importActual('../routes/projects/internals.js');
      return {
        ...actual,
        resolveProjectRelativePath: () => {
          throw new Error('boom');
        }
      };
    });

    const { default: projectRoutes } = await import('../routes/projects.js');
    const app = express();
    app.use(express.json());
    app.use('/api/projects', projectRoutes);

    const project = await createProject({
      name: `files-unexpected-put-${Date.now()}`,
      description: 'Unexpected resolver error coverage',
      language: 'javascript',
      framework: 'react',
      path: projectPath
    });

    const response = await request(app)
      .put(`/api/projects/${project.id}/files/src/hello.txt`)
      .send({ content: 'anything' })
      .expect(500);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Failed to save file');
  });
});
