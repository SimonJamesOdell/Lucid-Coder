import { describe, test, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../database.js', () => ({
  getGitSettings: vi.fn(),
  saveGitSettings: vi.fn(),
  getPortSettings: vi.fn(),
  savePortSettings: vi.fn()
}));

const buildTestApp = async ({ withJson = true } = {}) => {
  const { default: settingsRouter } = await import('../routes/settings.js');
  const app = express();
  if (withJson) {
    app.use(express.json());
  }
  app.use('/api/settings', settingsRouter);
  return app;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('settings routes', () => {
  test('validateGitSettingsPayload applies defaults and trims input', async () => {
    const { validateGitSettingsPayload } = await import('../routes/settings.js');

    expect(validateGitSettingsPayload()).toEqual({
      errors: [],
      nextSettings: {
        workflow: 'local',
        provider: 'github',
        remoteUrl: '',
        username: '',
        defaultBranch: 'main',
        autoPush: false,
        useCommitTemplate: false,
        commitTemplate: ''
      }
    });

    const { errors, nextSettings } = validateGitSettingsPayload({
      workflow: 'CLOUD',
      provider: 'GitLab',
      remoteUrl: ' https://example.com/repo.git ',
      username: ' alice ',
      defaultBranch: ' dev ',
      autoPush: 1,
      useCommitTemplate: true,
      commitTemplate: ' feat: {title} ',
      token: 123
    });

    expect(errors).toEqual([]);
    expect(nextSettings).toMatchObject({
      workflow: 'cloud',
      provider: 'gitlab',
      remoteUrl: 'https://example.com/repo.git',
      username: 'alice',
      defaultBranch: 'dev',
      autoPush: true,
      useCommitTemplate: true,
      commitTemplate: 'feat: {title}',
      token: ''
    });

    const normalizedNonStrings = validateGitSettingsPayload({
      workflow: 'local',
      remoteUrl: 123,
      username: null,
      defaultBranch: null,
      token: 'secrettoken'
    });
    expect(normalizedNonStrings.errors).toEqual([]);
    expect(normalizedNonStrings.nextSettings).toMatchObject({
      workflow: 'local',
      remoteUrl: '',
      username: '',
      defaultBranch: 'main',
      token: 'secrettoken'
    });
  });

  test('validateGitSettingsPayload returns validation errors for bad inputs', async () => {
    const { validateGitSettingsPayload } = await import('../routes/settings.js');

    expect(validateGitSettingsPayload({ workflow: 'nope' }).errors).toContain(
      'workflow must be either "local" or "cloud"'
    );

    const invalidProvider = validateGitSettingsPayload({
      workflow: 'cloud',
      provider: 'bitbucket',
      remoteUrl: 'https://example.com/repo.git'
    });
    expect(invalidProvider.errors).toContain('provider must be one of: GitHub, GitLab');
    expect(invalidProvider.nextSettings.provider).toBeUndefined();

    expect(validateGitSettingsPayload({ workflow: 'cloud' }).errors).toContain(
      'remoteUrl is required when workflow is cloud'
    );

    expect(
      validateGitSettingsPayload({
        workflow: 'local',
        useCommitTemplate: true,
        commitTemplate: '   '
      }).errors
    ).toContain('commitTemplate is required when useCommitTemplate is enabled');
  });

  test('validatePortSettingsPayload accepts integer-like values and rejects invalid ports', async () => {
    const { validatePortSettingsPayload } = await import('../routes/settings.js');

    expect(validatePortSettingsPayload({ frontendPortBase: '5300', backendPortBase: 5800 })).toEqual({
      errors: [],
      nextSettings: { frontendPortBase: 5300, backendPortBase: 5800 }
    });

    const { errors } = validatePortSettingsPayload({ frontendPortBase: 1000, backendPortBase: 'wat' });
    expect(errors).toContain('frontendPortBase must be an integer between 1024 and 65535');
    expect(errors).toContain('backendPortBase must be an integer between 1024 and 65535');
  });

  test('GET /api/settings/git returns saved settings', async () => {
    const { getGitSettings } = await import('../database.js');
    getGitSettings.mockResolvedValueOnce({ workflow: 'local' });

    const app = await buildTestApp();

    const response = await request(app)
      .get('/api/settings/git')
      .expect(200);

    expect(response.body).toEqual({ success: true, settings: { workflow: 'local' } });
  });

  test('GET /api/settings/git returns 500 when loading fails', async () => {
    const { getGitSettings } = await import('../database.js');
    getGitSettings.mockRejectedValueOnce(new Error('boom'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const app = await buildTestApp();

    const response = await request(app)
      .get('/api/settings/git')
      .expect(500);

    expect(response.body).toEqual({ success: false, error: 'Failed to load git settings' });
  });

  test('PUT /api/settings/git returns 400 for invalid payload', async () => {
    const app = await buildTestApp();

    const response = await request(app)
      .put('/api/settings/git')
      .send({ workflow: 'invalid' })
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toContain('workflow must be either "local" or "cloud"');
  });

  test('PUT /api/settings/git uses req.body fallback when body is missing', async () => {
    const { saveGitSettings } = await import('../database.js');
    saveGitSettings.mockResolvedValueOnce({ workflow: 'local', provider: 'github' });

    const app = await buildTestApp({ withJson: false });

    const response = await request(app)
      .put('/api/settings/git')
      .expect(200);

    expect(saveGitSettings).toHaveBeenCalledTimes(1);
    expect(response.body).toMatchObject({
      success: true,
      message: 'Git settings updated',
      settings: { workflow: 'local', provider: 'github' }
    });
  });

  test('PUT /api/settings/git returns 500 when save fails', async () => {
    const { saveGitSettings } = await import('../database.js');
    saveGitSettings.mockRejectedValueOnce(new Error('boom'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const app = await buildTestApp();

    const response = await request(app)
      .put('/api/settings/git')
      .send({ workflow: 'local' })
      .expect(500);

    expect(response.body).toEqual({ success: false, error: 'Failed to save git settings' });
  });

  test('GET /api/settings/ports returns saved settings', async () => {
    const { getPortSettings } = await import('../database.js');
    getPortSettings.mockResolvedValueOnce({ frontendPortBase: 5100, backendPortBase: 5500 });

    const app = await buildTestApp();

    const response = await request(app)
      .get('/api/settings/ports')
      .expect(200);

    expect(response.body).toEqual({
      success: true,
      settings: { frontendPortBase: 5100, backendPortBase: 5500 }
    });
  });

  test('GET /api/settings/ports returns 500 when loading fails', async () => {
    const { getPortSettings } = await import('../database.js');
    getPortSettings.mockRejectedValueOnce(new Error('boom'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const app = await buildTestApp();

    const response = await request(app)
      .get('/api/settings/ports')
      .expect(500);

    expect(response.body).toEqual({ success: false, error: 'Failed to load port settings' });
  });

  test('PUT /api/settings/ports returns 400 for invalid payload', async () => {
    const app = await buildTestApp();

    const response = await request(app)
      .put('/api/settings/ports')
      .send({ frontendPortBase: 'wat', backendPortBase: 0 })
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toContain('frontendPortBase must be an integer between 1024 and 65535');
    expect(response.body.error).toContain('backendPortBase must be an integer between 1024 and 65535');
  });

  test('PUT /api/settings/ports updates settings when payload is valid', async () => {
    const { savePortSettings } = await import('../database.js');
    savePortSettings.mockResolvedValueOnce({ frontendPortBase: 5300, backendPortBase: 5800 });

    const app = await buildTestApp();

    const response = await request(app)
      .put('/api/settings/ports')
      .send({ frontendPortBase: 5300, backendPortBase: 5800 })
      .expect(200);

    expect(savePortSettings).toHaveBeenCalledWith({ frontendPortBase: 5300, backendPortBase: 5800 });
    expect(response.body).toEqual({
      success: true,
      message: 'Port settings updated',
      settings: { frontendPortBase: 5300, backendPortBase: 5800 }
    });
  });

  test('PUT /api/settings/ports uses req.body fallback when body is missing', async () => {
    const app = await buildTestApp({ withJson: false });

    const response = await request(app)
      .put('/api/settings/ports')
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toContain('frontendPortBase must be an integer between 1024 and 65535');
  });

  test('PUT /api/settings/ports returns 500 when save fails', async () => {
    const { savePortSettings } = await import('../database.js');
    savePortSettings.mockRejectedValueOnce(new Error('boom'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const app = await buildTestApp();

    const response = await request(app)
      .put('/api/settings/ports')
      .send({ frontendPortBase: 5300, backendPortBase: 5800 })
      .expect(500);

    expect(response.body).toEqual({ success: false, error: 'Failed to save port settings' });
  });

  test('GET /api/settings/done-signals returns defaults', async () => {
    const app = await buildTestApp();

    const response = await request(app)
      .get('/api/settings/done-signals')
      .expect(200);

    expect(response.body).toEqual({
      success: true,
      doneSignals: expect.any(Object)
    });
  });
});
