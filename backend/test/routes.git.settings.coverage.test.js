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
  discardWorkingTree: vi.fn(),
  ensureGitRepository: vi.fn(),
  fetchRemote: vi.fn(),
  getAheadBehind: vi.fn(),
  getCurrentBranch: vi.fn(),
  getRemoteUrl: vi.fn(),
  hasWorkingTreeChanges: vi.fn(),
  popBranchStash: vi.fn(),
  runGitCommand: vi.fn(),
  stashWorkingTree: vi.fn()
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
    gitUtils.stashWorkingTree.mockResolvedValue(null);
    gitUtils.popBranchStash.mockResolvedValue(true);
    gitUtils.discardWorkingTree.mockResolvedValue(undefined);
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
    expect(response.body.error).toBe('Working tree has uncommitted changes. Use Stash & Pull or Discard & Pull in the Git tab before pulling.');
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

  it('requires confirmation before discard pull when dirty', async () => {
    const projectId = '106';
    const projectPath = '/tmp/pull-discard-confirm';
    const remoteUrl = 'https://github.com/octo/pull-discard.git';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'cloud', remoteUrl, defaultBranch: 'main' });
    gitUtils.getRemoteUrl.mockResolvedValueOnce(null);
    gitUtils.hasWorkingTreeChanges.mockResolvedValueOnce(true);

    const response = await request(app)
      .post(`/api/projects/${projectId}/git/pull`)
      .send({ mode: 'discard' })
      .expect(409);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Confirmation required to discard local changes.');
    expect(gitUtils.discardWorkingTree).not.toHaveBeenCalled();
  });

  it('discards working tree during pull when confirmation is provided', async () => {
    const projectId = '106-confirmed';
    const projectPath = '/tmp/pull-discard-confirmed';
    const remoteUrl = 'https://github.com/octo/pull-discard-confirmed.git';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'cloud', remoteUrl, defaultBranch: 'main' });
    gitUtils.hasWorkingTreeChanges.mockResolvedValueOnce(true);

    const response = await request(app)
      .post(`/api/projects/${projectId}/git/pull`)
      .send({ mode: 'discard', confirm: true })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(gitUtils.discardWorkingTree).toHaveBeenCalledWith(projectPath);
  });

  it('returns compare errors during pull as 400', async () => {
    const projectId = '107';
    const projectPath = '/tmp/pull-compare-error';
    const remoteUrl = 'https://github.com/octo/pull-compare.git';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'cloud', remoteUrl, defaultBranch: 'main' });
    gitUtils.getRemoteUrl.mockResolvedValueOnce(null);
    gitUtils.hasWorkingTreeChanges.mockResolvedValueOnce(false);
    gitUtils.getAheadBehind.mockResolvedValueOnce({ ahead: 0, behind: 0, error: 'compare failed' });

    const response = await request(app)
      .post(`/api/projects/${projectId}/git/pull`)
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('compare failed');
  });

  it('stashes working tree changes on request', async () => {
    const projectId = '201';
    const projectPath = '/tmp/stash-project';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'cloud', remoteUrl: 'https://github.com/octo/stash.git', defaultBranch: 'main' });
    gitUtils.stashWorkingTree.mockResolvedValueOnce('lucidcoder-auto/main');

    const response = await request(app)
      .post(`/api/projects/${projectId}/git/stash`)
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.stashed).toBe(true);
    expect(response.body.label).toBe('lucidcoder-auto/main');
  });

  it('returns 404 when stashing unknown project', async () => {
    const projectId = '201-missing';

    dbMocks.getProject.mockResolvedValue(null);

    const response = await request(app)
      .post(`/api/projects/${projectId}/git/stash`)
      .expect(404);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Project not found');
  });

  it('returns 400 when stashing project without path', async () => {
    const projectId = '201-nopath';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: '' });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'cloud', defaultBranch: 'main' });

    const response = await request(app)
      .post(`/api/projects/${projectId}/git/stash`)
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Project path is not configured.');
  });

  it('returns clean stash response when stash fails silently', async () => {
    const projectId = '201-fail';
    const projectPath = '/tmp/stash-fail';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'cloud', defaultBranch: 'main' });
    gitUtils.stashWorkingTree.mockRejectedValueOnce({});

    const response = await request(app)
      .post(`/api/projects/${projectId}/git/stash`)
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.stashed).toBe(false);
    expect(response.body.label).toBeNull();
  });

  it('falls back to default branch when current branch is empty during stash', async () => {
    const projectId = '201-branch-empty';
    const projectPath = '/tmp/stash-branch-empty';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'cloud', defaultBranch: 'main' });
    gitUtils.getCurrentBranch.mockResolvedValueOnce('');
    gitUtils.stashWorkingTree.mockResolvedValueOnce('lucidcoder-auto/main');

    const response = await request(app)
      .post(`/api/projects/${projectId}/git/stash`)
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(gitUtils.stashWorkingTree).toHaveBeenCalledWith(projectPath, 'main');
  });

  it('falls back to main when default branch is missing during stash', async () => {
    const projectId = '201-default-fallback';
    const projectPath = '/tmp/stash-default-fallback';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'cloud' });
    gitUtils.getCurrentBranch.mockRejectedValueOnce(new Error('branch failed'));

    const response = await request(app)
      .post(`/api/projects/${projectId}/git/stash`)
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(gitUtils.ensureGitRepository).toHaveBeenCalledWith(projectPath, { defaultBranch: 'main' });
    expect(gitUtils.stashWorkingTree).toHaveBeenCalledWith(projectPath, 'main');
  });

  it('returns null stash label when stash command fails', async () => {
    const projectId = '201-stash-reject';
    const projectPath = '/tmp/stash-reject';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'cloud', defaultBranch: 'main' });
    gitUtils.stashWorkingTree.mockRejectedValueOnce(new Error('stash failed'));

    const response = await request(app)
      .post(`/api/projects/${projectId}/git/stash`)
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.stashed).toBe(false);
    expect(response.body.label).toBeNull();
  });

  it('returns fallback error when stash setup fails without message', async () => {
    const projectId = '201-fail-setup';
    const projectPath = '/tmp/stash-fail-setup';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'cloud', defaultBranch: 'main' });
    gitUtils.ensureGitRepository.mockRejectedValueOnce({});

    const response = await request(app)
      .post(`/api/projects/${projectId}/git/stash`)
      .expect(500);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Failed to stash changes');
  });

  it('requires confirmation before discarding changes', async () => {
    const projectId = '202';
    const projectPath = '/tmp/discard-project';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'cloud', remoteUrl: 'https://github.com/octo/discard.git', defaultBranch: 'main' });
    gitUtils.hasWorkingTreeChanges.mockResolvedValueOnce(true);

    const response = await request(app)
      .post(`/api/projects/${projectId}/git/discard`)
      .expect(409);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Confirmation required to discard local changes.');
    expect(gitUtils.discardWorkingTree).not.toHaveBeenCalled();
  });

  it('discards changes when confirmation is provided', async () => {
    const projectId = '203';
    const projectPath = '/tmp/discard-confirmed';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'cloud', remoteUrl: 'https://github.com/octo/discard-confirmed.git', defaultBranch: 'main' });
    gitUtils.hasWorkingTreeChanges.mockResolvedValueOnce(true);

    const response = await request(app)
      .post(`/api/projects/${projectId}/git/discard`)
      .send({ confirm: true })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.discarded).toBe(true);
    expect(gitUtils.discardWorkingTree).toHaveBeenCalledWith(projectPath);
  });

  it('returns 404 when discarding unknown project', async () => {
    const projectId = '203-missing';

    dbMocks.getProject.mockResolvedValue(null);

    const response = await request(app)
      .post(`/api/projects/${projectId}/git/discard`)
      .expect(404);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Project not found');
  });

  it('returns 400 when discarding project without path', async () => {
    const projectId = '203-nopath';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: '' });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'cloud', defaultBranch: 'main' });

    const response = await request(app)
      .post(`/api/projects/${projectId}/git/discard`)
      .expect(400);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Project path is not configured.');
  });

  it('returns clean discard response when working tree is clean', async () => {
    const projectId = '203-clean';
    const projectPath = '/tmp/discard-clean';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'cloud', defaultBranch: 'main' });
    gitUtils.hasWorkingTreeChanges.mockResolvedValueOnce(false);

    const response = await request(app)
      .post(`/api/projects/${projectId}/git/discard`)
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.discarded).toBe(false);
    expect(gitUtils.discardWorkingTree).not.toHaveBeenCalled();
  });

  it('treats working tree status errors as clean during discard', async () => {
    const projectId = '203-status-error';
    const projectPath = '/tmp/discard-status-error';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'cloud', defaultBranch: 'main' });
    gitUtils.hasWorkingTreeChanges.mockRejectedValueOnce(new Error('status failed'));

    const response = await request(app)
      .post(`/api/projects/${projectId}/git/discard`)
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.discarded).toBe(false);
    expect(gitUtils.discardWorkingTree).not.toHaveBeenCalled();
  });

  it('falls back to main when default branch is missing during discard', async () => {
    const projectId = '203-default-fallback';
    const projectPath = '/tmp/discard-default-fallback';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'cloud' });
    gitUtils.hasWorkingTreeChanges.mockResolvedValueOnce(false);

    const response = await request(app)
      .post(`/api/projects/${projectId}/git/discard`)
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(gitUtils.ensureGitRepository).toHaveBeenCalledWith(projectPath, { defaultBranch: 'main' });
  });

  it('pulls with stash mode when requested', async () => {
    const projectId = '204';
    const projectPath = '/tmp/pull-stash';
    const remoteUrl = 'https://github.com/octo/pull-stash.git';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'cloud', remoteUrl, defaultBranch: 'main' });
    gitUtils.hasWorkingTreeChanges.mockResolvedValueOnce(true);
    gitUtils.stashWorkingTree.mockResolvedValueOnce('lucidcoder-auto/main');
    gitUtils.popBranchStash.mockResolvedValueOnce(true);

    const response = await request(app)
      .post(`/api/projects/${projectId}/git/pull`)
      .send({ mode: 'stash' })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.stash).toEqual({ created: true, restored: true, error: null });
  });

  it('continues pull when stash creation fails', async () => {
    const projectId = '204-stash-fails';
    const projectPath = '/tmp/pull-stash-fails';
    const remoteUrl = 'https://github.com/octo/pull-stash-fails.git';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'cloud', remoteUrl, defaultBranch: 'main' });
    gitUtils.hasWorkingTreeChanges.mockResolvedValueOnce(true);
    gitUtils.getCurrentBranch.mockResolvedValueOnce('');
    gitUtils.stashWorkingTree.mockRejectedValueOnce(new Error('stash failed'));

    const response = await request(app)
      .post(`/api/projects/${projectId}/git/pull`)
      .send({ mode: 'stash' })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.stash).toBeNull();
    expect(gitUtils.stashWorkingTree).toHaveBeenCalledWith(projectPath, 'main');
  });

  it('surfaces stash restore errors after pull', async () => {
    const projectId = '205';
    const projectPath = '/tmp/pull-stash-restore-error';
    const remoteUrl = 'https://github.com/octo/pull-stash-restore-error.git';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'cloud', remoteUrl, defaultBranch: 'main' });
    gitUtils.hasWorkingTreeChanges.mockResolvedValueOnce(true);
    gitUtils.stashWorkingTree.mockResolvedValueOnce('lucidcoder-auto/main');
    gitUtils.popBranchStash.mockRejectedValueOnce(new Error('restore failed'));

    const response = await request(app)
      .post(`/api/projects/${projectId}/git/pull`)
      .send({ mode: 'stash' })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.stash).toEqual({ created: true, restored: false, error: 'restore failed' });
  });

  it('uses default branch when current branch is empty during stash restore', async () => {
    const projectId = '205-branch-fallback';
    const projectPath = '/tmp/pull-stash-branch-fallback';
    const remoteUrl = 'https://github.com/octo/pull-stash-branch-fallback.git';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'cloud', remoteUrl, defaultBranch: 'main' });
    gitUtils.getRemoteUrl.mockResolvedValueOnce(remoteUrl);
    gitUtils.getCurrentBranch.mockResolvedValueOnce('');
    gitUtils.hasWorkingTreeChanges.mockResolvedValueOnce(true);
    gitUtils.stashWorkingTree.mockResolvedValueOnce('lucidcoder-auto/main');
    gitUtils.popBranchStash.mockResolvedValueOnce(true);

    const response = await request(app)
      .post(`/api/projects/${projectId}/git/pull`)
      .send({ mode: 'stash' })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.stash).toEqual({ created: true, restored: true, error: null });
    expect(gitUtils.popBranchStash).toHaveBeenCalledWith(projectPath, 'main');
  });

  it('uses fallback stash restore error message when missing', async () => {
    const projectId = '205-no-restore-message';
    const projectPath = '/tmp/pull-stash-restore-empty';
    const remoteUrl = 'https://github.com/octo/pull-stash-restore-empty.git';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'cloud', remoteUrl, defaultBranch: 'main' });
    gitUtils.hasWorkingTreeChanges.mockResolvedValueOnce(true);
    gitUtils.stashWorkingTree.mockResolvedValueOnce('lucidcoder-auto/main');
    gitUtils.popBranchStash.mockRejectedValueOnce({});

    const response = await request(app)
      .post(`/api/projects/${projectId}/git/pull`)
      .send({ mode: 'stash' })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.stash).toEqual({ created: true, restored: false, error: 'Failed to re-apply stashed changes.' });
  });

  it('returns 500 when discard route throws', async () => {
    const projectId = '206';
    const projectPath = '/tmp/discard-throws';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'cloud', defaultBranch: 'main' });
    gitUtils.ensureGitRepository.mockRejectedValueOnce(new Error('discard explode'));

    const response = await request(app)
      .post(`/api/projects/${projectId}/git/discard`)
      .expect(500);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('discard explode');
  });

  it('uses fallback error message when discard fails without message', async () => {
    const projectId = '207';
    const projectPath = '/tmp/discard-throws-empty';

    dbMocks.getProject.mockResolvedValue({ id: projectId, path: projectPath });
    dbMocks.getProjectGitSettings.mockResolvedValue(null);
    dbMocks.getGitSettings.mockResolvedValue({ workflow: 'cloud', defaultBranch: 'main' });
    gitUtils.ensureGitRepository.mockRejectedValueOnce({});

    const response = await request(app)
      .post(`/api/projects/${projectId}/git/discard`)
      .expect(500);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toBe('Failed to discard changes');
  });
});