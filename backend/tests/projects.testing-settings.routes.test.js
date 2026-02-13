import { describe, test, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../database.js', () => ({
  getProject: vi.fn(),
  getTestingSettings: vi.fn(),
  getProjectTestingSettings: vi.fn(),
  saveProjectTestingSettings: vi.fn()
}));

const buildTestApp = async ({ withJsonParser = true } = {}) => {
  const { registerProjectTestingRoutes } = await import('../routes/projects/routes.testing.js');
  const app = express();
  if (withJsonParser) {
    app.use(express.json());
  }
  const router = express.Router();
  registerProjectTestingRoutes(router);
  app.use('/api/projects', router);
  return app;
};

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('project testing settings routes', () => {
  test('GET returns 404 when project is missing', async () => {
    const { getProject } = await import('../database.js');
    getProject.mockResolvedValueOnce(null);

    const app = await buildTestApp();
    const response = await request(app).get('/api/projects/7/testing-settings').expect(404);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Project not found');
  });

  test('GET returns 500 when loading settings fails', async () => {
    const { getProject, getTestingSettings } = await import('../database.js');
    getProject.mockResolvedValueOnce({ id: 7, name: 'Demo' });
    getTestingSettings.mockRejectedValueOnce(new Error('db offline'));

    const app = await buildTestApp();
    const response = await request(app).get('/api/projects/7/testing-settings').expect(500);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Failed to fetch project testing settings');
  });

  test('GET returns effective project testing settings', async () => {
    const { getProject, getTestingSettings, getProjectTestingSettings } = await import('../database.js');
    getProject.mockResolvedValueOnce({ id: 7, name: 'Demo' });
    getTestingSettings.mockResolvedValueOnce({ coverageTarget: 90 });
    getProjectTestingSettings.mockResolvedValueOnce({
      frontend: { mode: 'custom', coverageTarget: 80, effectiveCoverageTarget: 80 },
      backend: { mode: 'global', coverageTarget: null, effectiveCoverageTarget: 90 }
    });

    const app = await buildTestApp();
    const response = await request(app).get('/api/projects/7/testing-settings').expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.inheritsFromGlobal).toEqual({ frontend: false, backend: true });
    expect(response.body.settings.frontend.coverageTarget).toBe(80);
  });

  test('PUT validates local mode coverage target', async () => {
    const { getProject } = await import('../database.js');
    getProject.mockResolvedValueOnce({ id: 7, name: 'Demo' });

    const app = await buildTestApp();
    const response = await request(app)
      .put('/api/projects/7/testing-settings')
      .send({ frontend: { useGlobal: false, coverageTarget: 85 } })
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toContain('coverageTarget must be one of 50, 60, 70, 80, 90, 100');
  });

  test('PUT validates non-integer local mode coverage target', async () => {
    const { getProject } = await import('../database.js');
    getProject.mockResolvedValueOnce({ id: 7, name: 'Demo' });

    const app = await buildTestApp();
    const response = await request(app)
      .put('/api/projects/7/testing-settings')
      .send({ frontend: { useGlobal: false, coverageTarget: 'abc' } })
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toContain('coverageTarget must be one of 50, 60, 70, 80, 90, 100');
  });

  test('PUT validates out-of-range backend coverage target', async () => {
    const { getProject } = await import('../database.js');
    getProject.mockResolvedValueOnce({ id: 7, name: 'Demo' });

    const app = await buildTestApp();
    const response = await request(app)
      .put('/api/projects/7/testing-settings')
      .send({ backend: { useGlobal: false, coverageTarget: 120 } })
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toContain('coverageTarget must be one of 50, 60, 70, 80, 90, 100');
  });

  test('PUT returns 404 when project is missing', async () => {
    const { getProject } = await import('../database.js');
    getProject.mockResolvedValueOnce(null);

    const app = await buildTestApp();
    const response = await request(app)
      .put('/api/projects/7/testing-settings')
      .send({ frontend: { useGlobal: true } })
      .expect(404);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Project not found');
  });

  test('PUT requires at least one scope payload', async () => {
    const { getProject } = await import('../database.js');
    getProject.mockResolvedValueOnce({ id: 7, name: 'Demo' });

    const app = await buildTestApp();
    const response = await request(app)
      .put('/api/projects/7/testing-settings')
      .send({})
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toContain('At least one scope');
  });

  test('PUT treats null request body as empty payload', async () => {
    const { getProject } = await import('../database.js');
    getProject.mockResolvedValueOnce({ id: 7, name: 'Demo' });

    const app = await buildTestApp({ withJsonParser: false });
    const response = await request(app)
      .put('/api/projects/7/testing-settings')
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toContain('At least one scope');
  });

  test('PUT treats null frontend scope as global defaults', async () => {
    const {
      getProject,
      getTestingSettings,
      getProjectTestingSettings,
      saveProjectTestingSettings
    } = await import('../database.js');

    getProject.mockResolvedValueOnce({ id: 7, name: 'Demo' });
    saveProjectTestingSettings.mockResolvedValueOnce({});
    getTestingSettings.mockResolvedValueOnce({ coverageTarget: 100 });
    getProjectTestingSettings.mockResolvedValueOnce({
      frontend: { mode: 'global', coverageTarget: null, effectiveCoverageTarget: 100 },
      backend: { mode: 'global', coverageTarget: null, effectiveCoverageTarget: 100 }
    });

    const app = await buildTestApp();
    await request(app)
      .put('/api/projects/7/testing-settings')
      .send({ frontend: null })
      .expect(200);

    expect(saveProjectTestingSettings).toHaveBeenCalledWith('7', {
      frontendMode: 'global',
      frontendCoverageTarget: null
    });
  });

  test('PUT treats null backend scope as global defaults', async () => {
    const {
      getProject,
      getTestingSettings,
      getProjectTestingSettings,
      saveProjectTestingSettings
    } = await import('../database.js');

    getProject.mockResolvedValueOnce({ id: 7, name: 'Demo' });
    saveProjectTestingSettings.mockResolvedValueOnce({});
    getTestingSettings.mockResolvedValueOnce({ coverageTarget: 100 });
    getProjectTestingSettings.mockResolvedValueOnce({
      frontend: { mode: 'global', coverageTarget: null, effectiveCoverageTarget: 100 },
      backend: { mode: 'global', coverageTarget: null, effectiveCoverageTarget: 100 }
    });

    const app = await buildTestApp();
    await request(app)
      .put('/api/projects/7/testing-settings')
      .send({ backend: null })
      .expect(200);

    expect(saveProjectTestingSettings).toHaveBeenCalledWith('7', {
      backendMode: 'global',
      backendCoverageTarget: null
    });
  });

  test('PUT persists frontend/backend scope settings', async () => {
    const {
      getProject,
      getTestingSettings,
      getProjectTestingSettings,
      saveProjectTestingSettings
    } = await import('../database.js');

    getProject.mockResolvedValueOnce({ id: 7, name: 'Demo' });
    saveProjectTestingSettings.mockResolvedValueOnce({});
    getTestingSettings.mockResolvedValueOnce({ coverageTarget: 100 });
    getProjectTestingSettings.mockResolvedValueOnce({
      frontend: { mode: 'custom', coverageTarget: 70, effectiveCoverageTarget: 70 },
      backend: { mode: 'global', coverageTarget: null, effectiveCoverageTarget: 100 }
    });

    const app = await buildTestApp();
    const response = await request(app)
      .put('/api/projects/7/testing-settings')
      .send({
        frontend: { useGlobal: false, coverageTarget: 70 },
        backend: { useGlobal: true }
      })
      .expect(200);

    expect(saveProjectTestingSettings).toHaveBeenCalledWith('7', {
      frontendMode: 'custom',
      frontendCoverageTarget: 70,
      backendMode: 'global',
      backendCoverageTarget: null
    });
    expect(response.body.success).toBe(true);
    expect(response.body.settings.frontend.mode).toBe('custom');
  });

  test('PUT returns 500 when persistence fails', async () => {
    const { getProject, saveProjectTestingSettings } = await import('../database.js');
    getProject.mockResolvedValueOnce({ id: 7, name: 'Demo' });
    saveProjectTestingSettings.mockRejectedValueOnce(new Error('write failed'));

    const app = await buildTestApp();
    const response = await request(app)
      .put('/api/projects/7/testing-settings')
      .send({ frontend: { useGlobal: true } })
      .expect(500);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Failed to save project testing settings');
  });
});
