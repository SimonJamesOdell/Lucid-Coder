import { describe, test, expect, beforeEach, vi } from 'vitest';
import axios from 'axios';
import { createRemoteRepository, RemoteRepoCreationError, __testUtils } from '../services/remoteRepoService.js';

vi.mock('axios', () => ({
  default: {
    post: vi.fn(),
    get: vi.fn()
  }
}));

const mockedAxios = axios;

beforeEach(() => {
  mockedAxios.post.mockReset();
  mockedAxios.get.mockReset();
});

describe('remoteRepoService.createRemoteRepository', () => {
  test('creates GitHub repository with normalized response', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        id: 42,
        name: 'demo-repo',
        owner: { login: 'octocat' },
        clone_url: 'https://github.com/octocat/demo-repo.git',
        ssh_url: 'git@github.com:octocat/demo-repo.git',
        html_url: 'https://github.com/octocat/demo-repo',
        private: true,
        default_branch: 'main'
      }
    });

    const repo = await createRemoteRepository({ provider: 'github', token: 'token', name: 'Demo Repo' });

    expect(repo).toMatchObject({
      provider: 'github',
      owner: 'octocat',
      remoteUrl: 'https://github.com/octocat/demo-repo.git',
      visibility: 'private'
    });
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://api.github.com/user/repos',
      expect.objectContaining({
        name: 'Demo-Repo',
        private: true
      }),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: expect.stringContaining('Bearer') }) })
    );
  });

  test('creates GitHub repository for an organization owner', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        id: 99,
        name: 'org-repo',
        owner: null,
        clone_url: 'https://github.com/org/org-repo.git',
        ssh_url: 'git@github.com:org/org-repo.git',
        html_url: 'https://github.com/org/org-repo',
        private: false,
        default_branch: 'main'
      }
    });

    const repo = await createRemoteRepository({ provider: 'github', token: 'token', name: 'Org Repo', owner: 'My Org' });

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://api.github.com/orgs/My%20Org/repos',
      expect.objectContaining({ name: 'Org-Repo' }),
      expect.any(Object)
    );
    expect(repo.owner).toBe('My Org');
    expect(repo.visibility).toBe('public');
  });

  test('GitHub repository falls back to null owner and default branch when response omits fields', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        id: 77,
        name: 'demo-repo',
        clone_url: 'https://github.com/me/demo-repo.git',
        ssh_url: 'git@github.com:me/demo-repo.git',
        html_url: 'https://github.com/me/demo-repo'
      }
    });

    const repo = await createRemoteRepository({ provider: 'github', token: 'token', name: 'Demo Repo' });
    expect(repo.owner).toBeNull();
    expect(repo.defaultBranch).toBe('main');
  });

  test('creates GitLab repository within requested namespace', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: [null, { id: 7, path: 'platform', full_path: 'team/platform' }]
    });
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        id: 77,
        name: 'remote-app',
        namespace: { full_path: 'team/platform' },
        http_url_to_repo: 'https://gitlab.com/team/platform/remote-app.git',
        ssh_url_to_repo: 'git@gitlab.com:team/platform/remote-app.git',
        web_url: 'https://gitlab.com/team/platform/remote-app',
        visibility: 'private',
        default_branch: 'main'
      }
    });

    const repo = await createRemoteRepository({
      provider: 'gitlab',
      token: 'token',
      name: 'Remote App',
      owner: 'platform'
    });

    expect(mockedAxios.get).toHaveBeenCalled();
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects',
      expect.objectContaining({
        name: 'Remote-App',
        path: 'remote-app',
        namespace_id: 7
      }),
      expect.any(Object)
    );
    expect(repo.remoteUrl).toBe('https://gitlab.com/team/platform/remote-app.git');
  });

  test('uses namespace owner fallback when GitLab response omits namespace info', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: [{ id: 3, path: 'platform' }] });
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        id: 55,
        name: 'remote-app',
        http_url_to_repo: 'https://gitlab.com/platform/remote-app.git',
        ssh_url: 'git@gitlab.com:platform/remote-app.git',
        web_url: 'https://gitlab.com/platform/remote-app'
      }
    });

    const repo = await createRemoteRepository({
      provider: 'gitlab',
      token: 'token',
      name: 'Remote App',
      owner: 'platform'
    });

    expect(repo.owner).toBe('platform');
  });

  test('wraps provider errors with RemoteRepoCreationError', async () => {
    mockedAxios.post.mockRejectedValueOnce({
      response: {
        status: 401,
        data: { message: 'Bad credentials' }
      }
    });

    await expect(
      createRemoteRepository({ provider: 'github', token: 'bad', name: 'repo' })
    ).rejects.toBeInstanceOf(RemoteRepoCreationError);
  });

  test('propagates GitHub provider error details when message is absent', async () => {
    mockedAxios.post.mockRejectedValueOnce({
      response: {
        status: 422,
        data: { error: 'Name already exists', extra: { field: 'name' } }
      }
    });

    await expect(
      createRemoteRepository({ provider: 'github', token: 'token', name: 'demo' })
    ).rejects.toMatchObject({
      message: 'Name already exists',
      statusCode: 422,
      details: expect.objectContaining({ extra: { field: 'name' } })
    });
  });

  test('throws when GitHub token is missing', async () => {
    await expect(
      createRemoteRepository({ provider: 'github', token: '   ', name: 'demo' })
    ).rejects.toThrow(/authentication token is required/i);
  });

  test('throws when GitLab token is missing', async () => {
    await expect(
      createRemoteRepository({ provider: 'gitlab', token: '   ', name: 'demo' })
    ).rejects.toThrow(/authentication token is required/i);
  });

  test('throws when GitLab namespace cannot be found', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: [] });

    await expect(
      createRemoteRepository({ provider: 'gitlab', token: 'token', name: 'demo', owner: 'unknown' })
    ).rejects.toThrow(/was not found or is not accessible/i);
  });

  test('wraps namespace lookup errors', async () => {
    mockedAxios.get.mockRejectedValueOnce({ request: {} });

    await expect(
      createRemoteRepository({ provider: 'gitlab', token: 'token', name: 'demo', owner: 'team' })
    ).rejects.toBeInstanceOf(RemoteRepoCreationError);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  test('wraps GitLab creation errors', async () => {
    mockedAxios.post.mockRejectedValueOnce({
      response: { status: 500, data: { message: 'boom' } }
    });

    await expect(
      createRemoteRepository({ provider: 'gitlab', token: 'token', name: 'demo' })
    ).rejects.toThrow(/boom/i);
  });

  test('rejects unsupported providers', async () => {
    await expect(createRemoteRepository({ provider: 'bitbucket' })).rejects.toThrow(/unsupported git provider/i);
  });

  test('defaults to GitHub when provider omitted and uses projectName fallback', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        id: 11,
        name: 'Alpha',
        owner: { login: 'me' },
        clone_url: 'https://github.com/me/Alpha.git',
        ssh_url: 'git@github.com:me/Alpha.git',
        html_url: 'https://github.com/me/Alpha',
        private: true,
        default_branch: 'main'
      }
    });

    const repo = await createRemoteRepository({ token: 'token', projectName: 'Alpha' });
    expect(repo.name).toBe('Alpha');
    expect(mockedAxios.post).toHaveBeenCalledWith('https://api.github.com/user/repos', expect.any(Object), expect.any(Object));
  });

  test('falls back to default project name when none supplied', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        id: 13,
        name: 'lucidcoder-project',
        owner: { login: 'me' },
        clone_url: 'https://github.com/me/lucidcoder-project.git',
        ssh_url: 'git@github.com:me/lucidcoder-project.git',
        html_url: 'https://github.com/me/lucidcoder-project',
        private: false,
        default_branch: 'main'
      }
    });

    const repo = await createRemoteRepository({ token: 'token' });
    expect(repo.name).toBe('lucidcoder-project');
    const payload = mockedAxios.post.mock.calls.at(-1)[1];
    expect(payload.name).toBe('lucidcoder-project');
  });

  test('creates GitLab repository without namespace and falls back to payload visibility', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: [] });
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        id: 55,
        name: 'demo-app',
        namespace: { full_path: 'me' },
        http_url_to_repo: 'https://gitlab.com/me/demo-app.git',
        ssh_url: 'git@gitlab.com:me/demo-app.git',
        web_url: 'https://gitlab.com/me/demo-app',
        default_branch: 'main'
      }
    });

    const repo = await createRemoteRepository({ provider: 'gitlab', token: 'token', name: 'Demo App' });
    expect(repo.visibility).toBe('private');
  });

  test('GitLab repository defaults owner to null and default branch to main when response omits them', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: [] });
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        id: 21,
        name: 'demo-app',
        http_url_to_repo: 'https://gitlab.com/demo-app.git',
        ssh_url: 'git@gitlab.com:demo-app.git',
        web_url: 'https://gitlab.com/demo-app'
      }
    });

    const repo = await createRemoteRepository({ provider: 'gitlab', token: 'token', name: 'Demo App' });
    expect(repo.owner).toBeNull();
    expect(repo.defaultBranch).toBe('main');
  });
});

describe('remoteRepoService helpers', () => {
  const { sanitizeName, normalizeVisibility, mapAxiosError, fetchGitlabNamespaceId } = __testUtils;

  test('sanitizeName normalizes unsafe input and falls back to default', () => {
    expect(sanitizeName('  My   Repo  ')).toBe('My-Repo');
    expect(sanitizeName('@@@!!!')).toBe('lucidcoder-project');
    expect(sanitizeName()).toBe('lucidcoder-project');
  });

  test('normalizeVisibility only returns public when requested', () => {
    expect(normalizeVisibility('public')).toBe('public');
    expect(normalizeVisibility('Private')).toBe('private');
    expect(normalizeVisibility()).toBe('private');
  });

  test('mapAxiosError handles missing, request, and message-only errors', () => {
    expect(mapAxiosError('github', null)).toMatchObject({ statusCode: 500 });
    expect(mapAxiosError('github', { request: {} })).toMatchObject({ statusCode: 504, message: /no response/i });
    const plain = mapAxiosError('github', { message: 'boom' });
    expect(plain).toMatchObject({ message: 'boom', statusCode: 500 });
  });

  test('mapAxiosError extracts provider responses and falls back when message missing', () => {
    const responseError = {
      response: {
        status: 422,
        data: { error: 'Invalid repo name' }
      }
    };
    expect(mapAxiosError('github', responseError)).toMatchObject({ statusCode: 422, message: 'Invalid repo name' });

    const fallback = mapAxiosError('github', {}, 'Custom fallback');
    expect(fallback).toMatchObject({ statusCode: 500, message: 'Custom fallback' });
  });

  test('mapAxiosError propagates provider response message and details when present', () => {
    const details = { message: 'Already exists', info: { field: 'name' } };
    const mapped = mapAxiosError('github', { response: { status: undefined, data: details } });
    expect(mapped).toMatchObject({
      message: 'Already exists',
      statusCode: 400,
      details
    });
  });

  test('mapAxiosError falls back to default message when provider payload lacks message and error', () => {
    const mapped = mapAxiosError('github', { response: { status: 503, data: { info: 'silent failure' } } });
    expect(mapped).toMatchObject({ statusCode: 503, message: 'Failed to create remote repository' });
  });

  test('fetchGitlabNamespaceId returns null when namespace missing or response invalid', async () => {
    expect(await fetchGitlabNamespaceId('token')).toBeNull();
    mockedAxios.get.mockResolvedValueOnce({ data: {} });
    expect(await fetchGitlabNamespaceId('token', 'team')).toBeNull();
  });

  test('fetchGitlabNamespaceId matches entries by full path and returns id', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: [{ id: 12, full_path: 'Team/Platform' }]
    });

    expect(await fetchGitlabNamespaceId('token', 'team/platform')).toBe(12);
  });

  test('fetchGitlabNamespaceId matches entries by display name', async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: [{ id: 18, name: 'Platform Team' }]
    });

    expect(await fetchGitlabNamespaceId('token', 'platform team')).toBe(18);
  });
});
