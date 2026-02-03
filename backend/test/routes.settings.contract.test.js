import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const dbMocks = vi.hoisted(() => ({
  getGitSettings: vi.fn(),
  saveGitSettings: vi.fn(),
  getPortSettings: vi.fn(),
  savePortSettings: vi.fn()
}));

vi.mock('../database.js', () => ({
  __esModule: true,
  ...dbMocks
}));

const gitConnectionMocks = vi.hoisted(() => ({
  testGitConnection: vi.fn()
}));

vi.mock('../services/gitConnectionService.js', async () => {
  const actual = await vi.importActual('../services/gitConnectionService.js');
  return {
    __esModule: true,
    ...actual,
    ...gitConnectionMocks
  };
});

const loadApp = async () => {
  const settingsRouter = (await import('../routes/settings.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRouter);
  return app;
};

describe('routes/settings contract', () => {
  let app;

  beforeEach(async () => {
    Object.values(dbMocks).forEach((mockFn) => mockFn.mockReset?.());
    Object.values(gitConnectionMocks).forEach((mockFn) => mockFn.mockReset?.());
    app = await loadApp();
  });

  it('GET /api/settings/policy returns coverage + defaults payload', async () => {
    const res = await request(app).get('/api/settings/policy').expect(200);

    expect(res.body).toMatchObject({
      success: true,
      policy: {
        coverage: expect.any(Object),
        changeScope: expect.any(Object),
        defaults: {
          coverageThresholds: expect.any(Object),
          enforceChangedFileCoverage: true,
          changeScope: expect.any(Object)
        }
      }
    });
  });

  it('POST /api/settings/git/test surfaces GitConnectionError shape', async () => {
    const { GitConnectionError } = await import('../services/gitConnectionService.js');

    gitConnectionMocks.testGitConnection.mockRejectedValue(
      new GitConnectionError('No access', {
        statusCode: 401,
        provider: 'github',
        details: { message: 'Bad credentials' }
      })
    );

    const res = await request(app)
      .post('/api/settings/git/test')
      .send({ provider: 'github', token: 'x' })
      .expect(401);

    expect(res.body).toEqual({
      success: false,
      error: 'No access',
      provider: 'github',
      details: { message: 'Bad credentials' }
    });
  });

  it('POST /api/settings/git/test falls back to 500 on unexpected errors', async () => {
    gitConnectionMocks.testGitConnection.mockRejectedValue(new Error('boom'));

    const res = await request(app)
      .post('/api/settings/git/test')
      .send({ provider: 'github', token: 'x' })
      .expect(500);

    expect(res.body).toEqual({ success: false, error: 'Failed to test git connection' });
  });

  it('PUT /api/settings/ports rejects invalid payload with 400 and error string', async () => {
    const res = await request(app)
      .put('/api/settings/ports')
      .send({ frontendPortBase: 80, backendPortBase: 6500 })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/frontendPortBase must be an integer/);
  });

  it('PUT /api/settings/git persists normalized settings and responds with settings payload', async () => {
    dbMocks.saveGitSettings.mockResolvedValue({
      workflow: 'cloud',
      provider: 'github',
      username: 'octo',
      token: '',
      tokenExpiresAt: '2026-02-03',
      defaultBranch: 'main'
    });

    const res = await request(app)
      .put('/api/settings/git')
      .send({
        workflow: 'cloud',
        provider: 'github',
        username: 'octo',
        token: '',
        tokenExpiresAt: '2026-02-03',
        defaultBranch: 'main'
      })
      .expect(200);

    expect(res.body).toMatchObject({
      success: true,
      message: 'Git settings updated',
      settings: {
        workflow: 'cloud',
        provider: 'github',
        username: 'octo',
        tokenExpiresAt: '2026-02-03',
        defaultBranch: 'main'
      }
    });

    expect(dbMocks.saveGitSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'cloud',
        provider: 'github',
        username: 'octo',
        defaultBranch: 'main'
      })
    );
  });
});
