import { describe, test, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import path from 'path';
import fs from 'node:fs/promises';
import db, { initializeDatabase, closeDatabase } from '../database.js';
import { app } from '../server.js';

const runStatement = (sql) =>
  new Promise((resolve, reject) => {
    db.run(sql, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });

const getRow = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row);
      }
    });
  });

const resetDatabase = async () => {
  await runStatement('DELETE FROM api_logs');
  await runStatement('DELETE FROM llm_config');
  await runStatement('DELETE FROM projects');
  await runStatement('DELETE FROM git_settings');
  await runStatement('DELETE FROM project_git_settings');
  await runStatement('DELETE FROM port_settings');
};

describe('Projects routes - E2E_SKIP_SCAFFOLDING coverage', () => {
  const originalEnv = { ...process.env };
  const testProjectsDir = path.join(process.cwd(), 'test-runtime-projects.skipScaffolding', String(Date.now()));

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.PROJECTS_DIR = testProjectsDir;
    await fs.mkdir(testProjectsDir, { recursive: true });
    await initializeDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
    process.env.E2E_SKIP_SCAFFOLDING = '1';
  });

  afterAll(async () => {
    try {
      await resetDatabase();
    } finally {
      try {
        await closeDatabase();
      } catch {
        // ignore
      }

      process.env = originalEnv;
      await fs.rm(testProjectsDir, { recursive: true, force: true });
    }
  });

  test('POST /api/projects uses skip scaffolding fast-path', async () => {
    const projectName = `skip-scaffolding-${Date.now()}`;

    const response = await request(app)
      .post('/api/projects')
      .send({
        name: projectName,
        // Intentionally omit description to cover the `description?.trim() || ''` fallback.
        frontend: { language: 'javascript', framework: 'react' },
        backend: { language: 'javascript', framework: 'express' }
      })
      .expect(201);

    expect(response.body).toHaveProperty('success', true);
    expect(response.body).toHaveProperty('processes', null);
    expect(response.body).toHaveProperty('progress', null);
    expect(response.body.project).toMatchObject({
      name: projectName,
      frontend: { language: 'javascript', framework: 'react' },
      backend: { language: 'javascript', framework: 'express' }
    });
    expect(typeof response.body.project.path).toBe('string');

    await expect(fs.stat(response.body.project.path)).resolves.toBeTruthy();

    const dbRow = await getRow('SELECT frontend_port, backend_port FROM projects WHERE id = ?', [response.body.project.id]);
    expect(dbRow.frontend_port).toBeNull();
    expect(dbRow.backend_port).toBeNull();
  });

  test('POST /api/projects recognizes E2E_SKIP_SCAFFOLDING="true" (branch coverage)', async () => {
    process.env.E2E_SKIP_SCAFFOLDING = 'true';
    const projectName = `skip-scaffolding-true-${Date.now()}`;

    const response = await request(app)
      .post('/api/projects')
      .send({
        name: projectName,
        description: 'Skip scaffolding create (true)',
        frontend: { language: 'javascript', framework: 'react' },
        backend: { language: 'javascript', framework: 'express' }
      })
      .expect(201);

    expect(response.body).toHaveProperty('success', true);
    expect(response.body).toHaveProperty('processes', null);
    expect(response.body).toHaveProperty('progress', null);
  });

  test('POST /api/projects uses scaffolding when E2E_SKIP_SCAFFOLDING is disabled (branch coverage)', async () => {
    const previousSkip = process.env.E2E_SKIP_SCAFFOLDING;
    process.env.E2E_SKIP_SCAFFOLDING = '0';

    const scaffoldingService = await import('../services/projectScaffolding.js');
    const scaffoldSpy = vi
      .spyOn(scaffoldingService, 'createProjectWithFiles')
      .mockResolvedValueOnce({
        success: true,
        project: {
          id: 2,
          name: 'disabled-skip-scaffold',
          description: 'Skip disabled branch test',
          frontend: { language: 'javascript', framework: 'react' },
          backend: { language: 'javascript', framework: 'express' },
          path: path.join(testProjectsDir, 'disabled-skip-scaffold'),
          createdAt: new Date().toISOString()
        },
        processes: {
          frontend: { pid: 2234, port: 5173 },
          backend: { pid: 2235, port: 3000 }
        },
        progress: null
      });

    try {
      const response = await request(app)
        .post('/api/projects')
        .send({
          name: `disabled-skip-scaffold-${Date.now()}`,
          description: 'Should use scaffolding path (skip disabled)',
          frontend: { language: 'javascript', framework: 'react' },
          backend: { language: 'javascript', framework: 'express' }
        })
        .expect(201);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body.processes).not.toBeNull();
      expect(scaffoldSpy).toHaveBeenCalled();
    } finally {
      if (previousSkip === undefined) {
        delete process.env.E2E_SKIP_SCAFFOLDING;
      } else {
        process.env.E2E_SKIP_SCAFFOLDING = previousSkip;
      }
      scaffoldSpy.mockRestore();
    }
  });

  test('POST /api/projects does NOT skip scaffolding when NODE_ENV=production (branch coverage)', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousSkip = process.env.E2E_SKIP_SCAFFOLDING;
    process.env.E2E_SKIP_SCAFFOLDING = '1';
    process.env.NODE_ENV = 'production';

    const scaffoldingService = await import('../services/projectScaffolding.js');
    const scaffoldSpy = vi
      .spyOn(scaffoldingService, 'createProjectWithFiles')
      .mockResolvedValueOnce({
        success: true,
        project: {
          id: 1,
          name: 'production-scaffold',
          description: 'Production branch test',
          frontend: { language: 'javascript', framework: 'react' },
          backend: { language: 'javascript', framework: 'express' },
          path: path.join(testProjectsDir, 'production-scaffold'),
          createdAt: new Date().toISOString()
        },
        processes: {
          frontend: { pid: 1234, port: 5173 },
          backend: { pid: 1235, port: 3000 }
        },
        progress: null
      });

    try {
      const response = await request(app)
        .post('/api/projects')
        .send({
          name: `production-scaffold-${Date.now()}`,
          description: 'Should use scaffolding path (skip disabled in production)',
          frontend: { language: 'javascript', framework: 'react' },
          backend: { language: 'javascript', framework: 'express' }
        })
        .expect(201);

      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('processes');
      expect(response.body.processes).not.toBeNull();
      expect(scaffoldSpy).toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      if (previousSkip === undefined) {
        delete process.env.E2E_SKIP_SCAFFOLDING;
      } else {
        process.env.E2E_SKIP_SCAFFOLDING = previousSkip;
      }
      scaffoldSpy.mockRestore();
    }
  });

  test('POST /api/projects/:id/start returns E2E selection when skipping scaffolding and ports are unset', async () => {
    const database = await import('../database.js');
    const projectId = 12345;
    const fakePath = path.join(testProjectsDir, `skip-start-${Date.now()}`);

    await fs.mkdir(fakePath, { recursive: true });

    const getProjectSpy = vi.spyOn(database, 'getProject').mockResolvedValueOnce({
      id: projectId,
      path: fakePath,
      frontendPort: null,
      backendPort: null
    });

    try {
      const startResponse = await request(app)
        .post(`/api/projects/${projectId}/start`)
        .expect(200);

      expect(startResponse.body).toEqual({
        success: true,
        message: 'Project selected (E2E skip scaffolding)',
        processes: null
      });
    } finally {
      getProjectSpy.mockRestore();
    }
  });

  test('POST /api/projects completes progress when progressKey is provided (skip scaffolding)', async () => {
    const progressKey = `skip-progress-${Date.now()}`;
    const projectName = `skip-progress-${Date.now()}`;

    const progressTracker = await import('../services/progressTracker.js');
    const completeSpy = vi.spyOn(progressTracker, 'completeProgress').mockResolvedValue();

    await request(app)
      .post('/api/projects')
      .send({
        name: projectName,
        description: 'Skip scaffolding progress',
        frontend: { language: 'javascript', framework: 'react' },
        backend: { language: 'javascript', framework: 'express' },
        progressKey
      })
      .expect(201);

    expect(completeSpy).toHaveBeenCalledWith(progressKey, 'Project created successfully');
  });
});
