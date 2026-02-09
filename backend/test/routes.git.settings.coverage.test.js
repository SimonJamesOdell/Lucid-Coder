import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const dbMocks = vi.hoisted(() => ({
  deleteProjectGitSettings: vi.fn(),
  getGitSettings: vi.fn(),
  getProject: vi.fn(),
  getProjectGitSettings: vi.fn(),
  getGitSettingsToken: vi.fn(),
  saveProjectGitSettings: vi.fn()
}));

vi.mock('../database.js', () => ({
  __esModule: true,
  ...dbMocks
}));

const gitUtils = vi.hoisted(() => ({
  ensureGitRepository: vi.fn(),
  fetchRemote: vi.fn(),
  getAheadBehind: vi.fn(),
  getCurrentBranch: vi.fn(),
  getRemoteUrl: vi.fn(),
  hasWorkingTreeChanges: vi.fn(),
  runGitCommand: vi.fn()
}));

vi.mock('../utils/git.js', () => ({
  __esModule: true,
  ...gitUtils
}));

const loadApp = async () => {
  const { registerProjectGitRoutes } = await import('../routes/projects/routes.git.js');
  const router = express.Router();
  registerProjectGitRoutes(router);
  const app = express();
  app.use(express.json());
  app.use('/api/projects', router);
  return app;
};

describe('routes.git settings recovery coverage', () => {
  let app;

  beforeEach(async () => {
    Object.values(dbMocks).forEach((mockFn) => mockFn.mockReset?.());
    Object.values(gitUtils).forEach((mockFn) => mockFn.mockReset?.());
    gitUtils.ensureGitRepository.mockResolvedValue(undefined);
    gitUtils.getRemoteUrl.mockResolvedValue('https://github.com/octo/recovered.git');
    gitUtils.getCurrentBranch.mockResolvedValue('main');
    gitUtils.hasWorkingTreeChanges.mockResolvedValue(false);
    gitUtils.getAheadBehind.mockResolvedValue({ ahead: 0, behind: 0 });
    gitUtils.fetchRemote.mockResolvedValue(undefined);
    gitUtils.runGitCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
    app = await loadApp();
  });

  it('recovers remote and persists default provider/branch', async () => {
    const projectId = '123';
    const projectPath = '/tmp/project';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({
      workflow: 'cloud',
      provider: '',
      defaultBranch: ''
    });
    dbMocks.saveProjectGitSettings.mockResolvedValue({
      workflow: 'cloud',
      provider: 'github',
      defaultBranch: 'main',
      remoteUrl: 'https://github.com/octo/recovered.git'
    });

    const response = await request(app)
      .get(`/api/projects/${projectId}/git-settings`)
      .expect(200);

    expect(response.body.inheritsFromGlobal).toBe(false);
    expect(response.body.projectSettings).toMatchObject({
      workflow: 'cloud',
      provider: 'github',
      defaultBranch: 'main',
      remoteUrl: 'https://github.com/octo/recovered.git'
    });

    expect(gitUtils.ensureGitRepository).toHaveBeenCalledWith(projectPath, { defaultBranch: 'main' });
    expect(dbMocks.saveProjectGitSettings).toHaveBeenCalledWith(projectId, expect.objectContaining({
      provider: 'github',
      defaultBranch: 'main'
    }));
  });

  it('returns git status without a remote when workflow is not cloud', async () => {
    const projectId = '42';
    const projectPath = '/tmp/no-remote';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'local', defaultBranch: 'main' });
    gitUtils.getRemoteUrl.mockResolvedValueOnce(null);

    const response = await request(app)
      .get(`/api/projects/${projectId}/git/status`)
      .expect(200);

    expect(response.body.status).toMatchObject({
      hasRemote: false,
      remoteUrl: null,
      ahead: 0,
      behind: 0
    });
    expect(gitUtils.runGitCommand).not.toHaveBeenCalled();
  });

  it('adds origin from settings when missing', async () => {
    const projectId = '55';
    const projectPath = '/tmp/add-origin';
    const remoteUrl = 'https://github.com/octo/add.git';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'cloud', remoteUrl, defaultBranch: 'main' });
    gitUtils.getRemoteUrl.mockResolvedValueOnce(null);

    const response = await request(app)
      .get(`/api/projects/${projectId}/git/status`)
      .expect(200);

    expect(response.body.status).toMatchObject({
      hasRemote: true,
      remoteUrl
    });
    expect(gitUtils.runGitCommand).toHaveBeenCalledWith(projectPath, ['remote', 'add', 'origin', remoteUrl]);
  });

  it('surfaces remote configuration errors in git status', async () => {
    const projectId = '99';
    const projectPath = '/tmp/bad-remote';
    const remoteUrl = 'https://github.com/octo/bad.git';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'cloud', remoteUrl, defaultBranch: 'main' });
    gitUtils.getRemoteUrl.mockResolvedValueOnce(null);
    gitUtils.runGitCommand
      .mockRejectedValueOnce(new Error('add failed'))
      .mockRejectedValueOnce(new Error('set-url failed'));

    const response = await request(app)
      .get(`/api/projects/${projectId}/git/status`)
      .expect(200);

    expect(response.body.status).toMatchObject({
      hasRemote: false,
      remoteUrl: null,
      error: 'add failed'
    });
  });

  it('falls back to a generic remote error in git status when message is missing', async () => {
    const projectId = '100';
    const projectPath = '/tmp/status-remote-error';
    const remoteUrl = 'https://github.com/octo/status.git';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'cloud', remoteUrl, defaultBranch: 'main' });
    gitUtils.getRemoteUrl.mockResolvedValueOnce(null);
    gitUtils.runGitCommand
      .mockRejectedValueOnce({})
      .mockRejectedValueOnce({});

    const response = await request(app)
      .get(`/api/projects/${projectId}/git/status`)
      .expect(200);

    expect(response.body.status).toMatchObject({
      hasRemote: false,
      remoteUrl: null,
      error: 'Failed to configure remote origin.'
    });
  });

  it('falls back to set-url when adding origin fails during fetch', async () => {
    const projectId = '77';
    const projectPath = '/tmp/fetch-remote';
    const remoteUrl = 'https://github.com/octo/fetch.git';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'cloud', remoteUrl, defaultBranch: 'main' });
    gitUtils.getRemoteUrl.mockResolvedValueOnce(null);
    gitUtils.runGitCommand
      .mockRejectedValueOnce(new Error('add failed'))
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

    const response = await request(app)
      .post(`/api/projects/${projectId}/git/fetch`)
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(gitUtils.runGitCommand).toHaveBeenCalledWith(projectPath, ['remote', 'set-url', 'origin', remoteUrl]);
  });

  it('returns 400 when no remote is configured during fetch', async () => {
    const projectId = '66';
    const projectPath = '/tmp/fetch-missing-remote';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'local', defaultBranch: 'main' });
    gitUtils.getRemoteUrl.mockResolvedValueOnce(null);

    const response = await request(app)
      .post(`/api/projects/${projectId}/git/fetch`)
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Remote origin is not configured.');
  });

  it('returns fallback error when remote configuration throws without message during fetch', async () => {
    const projectId = '67';
    const projectPath = '/tmp/fetch-config-error';
    const remoteUrl = 'https://github.com/octo/fetch-error.git';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'cloud', remoteUrl, defaultBranch: 'main' });
    gitUtils.getRemoteUrl.mockResolvedValueOnce(null);
    gitUtils.runGitCommand
      .mockRejectedValueOnce({})
      .mockRejectedValueOnce({});

    const response = await request(app)
      .post(`/api/projects/${projectId}/git/fetch`)
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Failed to configure remote origin.');
  });

  it('returns 400 when remote origin cannot be configured during pull', async () => {
    const projectId = '88';
    const projectPath = '/tmp/pull-remote';
    const remoteUrl = 'https://github.com/octo/pull.git';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'cloud', remoteUrl, defaultBranch: 'main' });
    gitUtils.getRemoteUrl.mockResolvedValueOnce(null);
    gitUtils.runGitCommand
      .mockRejectedValueOnce(new Error('add failed'))
      .mockRejectedValueOnce(new Error('set-url failed'));

    const response = await request(app)
      .post(`/api/projects/${projectId}/git/pull`)
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('add failed');
  });

  it('blocks pull when working tree is dirty', async () => {
    const projectId = '101';
    const projectPath = '/tmp/pull-dirty';
    const remoteUrl = 'https://github.com/octo/pull-dirty.git';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'cloud', remoteUrl, defaultBranch: 'main' });
    gitUtils.getRemoteUrl.mockResolvedValueOnce(null);
    gitUtils.hasWorkingTreeChanges.mockResolvedValueOnce(true);

    const response = await request(app)
      .post(`/api/projects/${projectId}/git/pull`)
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Working tree has uncommitted changes. Commit or stash before pulling.');
  });

  it('blocks pull when current branch differs from default', async () => {
    const projectId = '102';
    const projectPath = '/tmp/pull-branch-mismatch';
    const remoteUrl = 'https://github.com/octo/pull-branch.git';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'cloud', remoteUrl, defaultBranch: 'main' });
    gitUtils.getRemoteUrl.mockResolvedValueOnce(null);
    gitUtils.hasWorkingTreeChanges.mockResolvedValueOnce(false);
    gitUtils.getCurrentBranch.mockResolvedValueOnce('feature/foo');

    const response = await request(app)
      .post(`/api/projects/${projectId}/git/pull`)
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Checkout main before pulling.');
  });

  it('returns 400 when remote lookup fails during pull', async () => {
    const projectId = '104';
    const projectPath = '/tmp/pull-remote-lookup';
    const remoteUrl = 'https://github.com/octo/pull-lookup.git';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'cloud', remoteUrl, defaultBranch: 'main' });
    gitUtils.getRemoteUrl.mockRejectedValueOnce(new Error('remote lookup failed'));

    const response = await request(app)
      .post(`/api/projects/${projectId}/git/pull`)
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('remote lookup failed');
  });

  it('returns fallback error when pull ensureRemoteOrigin throws without message', async () => {
    const projectId = '105';
    const projectPath = '/tmp/pull-no-msg';
    const remoteUrl = 'https://github.com/octo/pull-no-msg.git';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'cloud', remoteUrl, defaultBranch: 'main' });
    // getRemoteUrl returns null → ensureRemoteOrigin tries add/set-url, both reject with plain objects (no .message)
    gitUtils.getRemoteUrl.mockResolvedValueOnce(null);
    gitUtils.runGitCommand
      .mockRejectedValueOnce({ code: 1 })
      .mockRejectedValueOnce({ code: 1 });

    const response = await request(app)
      .post(`/api/projects/${projectId}/git/pull`)
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Failed to configure remote origin.');
  });

  it('treats working tree status errors as clean during pull', async () => {
    const projectId = '103';
    const projectPath = '/tmp/pull-status-error';
    const remoteUrl = 'https://github.com/octo/pull-status.git';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'cloud', remoteUrl, defaultBranch: 'main' });
    gitUtils.getRemoteUrl.mockResolvedValueOnce(null);
    gitUtils.hasWorkingTreeChanges.mockRejectedValueOnce(new Error('status failed'));
    gitUtils.getAheadBehind.mockResolvedValueOnce({ ahead: 0, behind: 0 });

    const response = await request(app)
      .post(`/api/projects/${projectId}/git/pull`)
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.strategy).toBe('noop');
  });
});