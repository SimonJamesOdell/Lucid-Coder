import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import runsRoutes from '../routes/runs.js';
import * as runStore from '../services/runStore.js';

vi.mock('../services/runStore.js', () => ({
  getRun: vi.fn(),
  listRunEvents: vi.fn(),
  listRunsForProject: vi.fn()
}));

describe('Runs Routes', () => {
  let app;

  const buildApp = ({ mountWithProjectParam = true } = {}) => {
    const instance = express();
    instance.use(express.json());

    if (mountWithProjectParam) {
      instance.use('/api/projects/:projectId/runs', runsRoutes);
    } else {
      // Intentionally omit the :projectId param so the route handler sees it missing.
      instance.use('/api/projects/runs', runsRoutes);
    }

    return instance;
  };

  beforeEach(() => {
    app = buildApp();
    vi.clearAllMocks();

    runStore.listRunsForProject.mockResolvedValue([]);
    runStore.getRun.mockResolvedValue(null);
    runStore.listRunEvents.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('GET /api/projects/:projectId/runs', () => {
    it('returns runs for a project', async () => {
      runStore.listRunsForProject.mockResolvedValue([{ id: 1 }, { id: 2 }]);

      const response = await request(app)
        .get('/api/projects/42/runs?limit=10')
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        runs: [{ id: 1 }, { id: 2 }]
      });

      expect(runStore.listRunsForProject).toHaveBeenCalledWith('42', { limit: 10 });
    });

    it('returns 400 when projectId param is missing', async () => {
      app = buildApp({ mountWithProjectParam: false });

      const response = await request(app)
        .get('/api/projects/runs')
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'projectId is required'
      });
    });

    it('returns 500 when listRunsForProject throws', async () => {
      runStore.listRunsForProject.mockRejectedValue(new Error('boom'));

      const response = await request(app)
        .get('/api/projects/42/runs')
        .expect(500);

      expect(response.body).toEqual({
        success: false,
        error: 'Failed to list runs'
      });
    });
  });

  describe('GET /api/projects/:projectId/runs/:runId', () => {
    it('returns 400 when projectId param is missing', async () => {
      app = buildApp({ mountWithProjectParam: false });

      const response = await request(app)
        .get('/api/projects/runs/123')
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'projectId is required'
      });
    });

    it('returns 404 when the run does not exist', async () => {
      runStore.getRun.mockResolvedValue(null);

      const response = await request(app)
        .get('/api/projects/42/runs/999')
        .expect(404);

      expect(response.body).toEqual({
        success: false,
        error: 'Run not found'
      });
    });

    it('returns 404 when run.projectId does not match route projectId', async () => {
      runStore.getRun.mockResolvedValue({ id: 5, projectId: 123 });

      const response = await request(app)
        .get('/api/projects/42/runs/5')
        .expect(404);

      expect(response.body).toEqual({
        success: false,
        error: 'Run not found'
      });
    });

    it('returns the run without events by default', async () => {
      runStore.getRun.mockResolvedValue({ id: 7, projectId: 42, kind: 'job' });

      const response = await request(app)
        .get('/api/projects/42/runs/7')
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        run: { id: 7, projectId: 42, kind: 'job' }
      });
      expect(runStore.listRunEvents).not.toHaveBeenCalled();
    });

    it('returns the run with events when includeEvents=true', async () => {
      runStore.getRun.mockResolvedValue({ id: 8, projectId: 42, kind: 'job' });
      runStore.listRunEvents.mockResolvedValue([{ id: 1, type: 'log' }]);

      const response = await request(app)
        .get('/api/projects/42/runs/8?includeEvents=true')
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        run: { id: 8, projectId: 42, kind: 'job' },
        events: [{ id: 1, type: 'log' }]
      });
      expect(runStore.listRunEvents).toHaveBeenCalledWith('8');
    });

    it('returns the run with events when includeEvents=1', async () => {
      runStore.getRun.mockResolvedValue({ id: 9, projectId: 42, kind: 'job' });
      runStore.listRunEvents.mockResolvedValue([{ id: 2, type: 'log' }]);

      const response = await request(app)
        .get('/api/projects/42/runs/9?includeEvents=1')
        .expect(200);

      expect(response.body.events).toEqual([{ id: 2, type: 'log' }]);
    });

    it('returns 500 when getRun throws', async () => {
      runStore.getRun.mockRejectedValue(new Error('boom'));

      const response = await request(app)
        .get('/api/projects/42/runs/1')
        .expect(500);

      expect(response.body).toEqual({
        success: false,
        error: 'Failed to fetch run'
      });
    });

    it('returns 500 when listRunEvents throws (includeEvents=true)', async () => {
      runStore.getRun.mockResolvedValue({ id: 10, projectId: 42, kind: 'job' });
      runStore.listRunEvents.mockRejectedValue(new Error('boom'));

      const response = await request(app)
        .get('/api/projects/42/runs/10?includeEvents=true')
        .expect(500);

      expect(response.body).toEqual({
        success: false,
        error: 'Failed to fetch run'
      });
    });
  });
});
