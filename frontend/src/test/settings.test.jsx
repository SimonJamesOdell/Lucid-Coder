import { describe, test, expect, vi } from 'vitest';
import {
  fetchGitSettingsFromBackend,
  fetchProjectGitStatus,
  fetchProjectGitRemote,
  pullProjectGitRemote,
  stashProjectGitChanges,
  discardProjectGitChanges,
  fetchProjectBranchesOverview,
  checkoutProjectBranch,
  updateGitSettings,
  testGitConnection,
  updateProjectGitSettings,
  fetchTestingSettingsFromBackend,
  updateTestingSettings
} from '../context/appState/settings.js';

const buildResponse = (ok, payload) => ({
  ok,
  json: () => Promise.resolve(payload)
});

describe('settings git helpers', () => {
  test('fetchGitSettingsFromBackend merges sanitized backend settings into state', async () => {
    const trackedFetch = () => Promise.resolve(buildResponse(true, {
      success: true,
      settings: {
        workflow: 'cloud',
        provider: 'gitlab',
        remoteUrl: 'https://gitlab.com/acme/repo.git',
        username: 'alice',
        defaultBranch: 'main',
        autoPush: true,
        useCommitTemplate: true,
        commitTemplate: 'feat: {summary}'
      }
    }));
    const setGitSettings = vi.fn();

    await fetchGitSettingsFromBackend({ trackedFetch, setGitSettings });

    expect(setGitSettings).toHaveBeenCalledTimes(1);
    const updater = setGitSettings.mock.calls[0][0];
    const next = updater({ workflow: 'local', provider: 'github', remoteUrl: 'https://old' });
    expect(next).toMatchObject({
      workflow: 'cloud',
      provider: 'gitlab',
      username: 'alice',
      defaultBranch: 'main'
    });
    expect(Object.prototype.hasOwnProperty.call(next, 'remoteUrl')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(next, 'autoPush')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(next, 'useCommitTemplate')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(next, 'commitTemplate')).toBe(false);
  });

  test('fetchGitSettingsFromBackend skips state updates when payload has no settings', async () => {
    const trackedFetch = () => Promise.resolve(buildResponse(true, { success: true }));
    const setGitSettings = vi.fn();

    await fetchGitSettingsFromBackend({ trackedFetch, setGitSettings });

    expect(setGitSettings).not.toHaveBeenCalled();
  });

  test('fetchGitSettingsFromBackend handles non-ok responses without updating state', async () => {
    const trackedFetch = () => Promise.resolve(buildResponse(false, { success: false }));
    const setGitSettings = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await fetchGitSettingsFromBackend({ trackedFetch, setGitSettings });

    expect(setGitSettings).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to load git settings from backend:',
      expect.any(Error)
    );

    warnSpy.mockRestore();
  });

  test('fetchProjectGitRemote throws when projectId is missing', async () => {
    await expect(fetchProjectGitRemote({ trackedFetch: () => null })).rejects.toThrow(
      'projectId is required to fetch git remote status'
    );
  });

  test('fetchProjectGitRemote throws backend error', async () => {
    const trackedFetch = () => Promise.resolve(buildResponse(false, { success: false, error: 'nope' }));
    await expect(fetchProjectGitRemote({ trackedFetch, projectId: 'proj-1' })).rejects.toThrow('nope');
  });

  test('fetchProjectGitRemote falls back to default error message', async () => {
    const trackedFetch = () => Promise.resolve(buildResponse(false, { success: false }));
    await expect(fetchProjectGitRemote({ trackedFetch, projectId: 'proj-1e' })).rejects.toThrow('Failed to fetch git remote');
  });

  test('fetchProjectGitRemote returns null when status is missing', async () => {
    const trackedFetch = () => Promise.resolve(buildResponse(true, { success: true }));

    const result = await fetchProjectGitRemote({ trackedFetch, projectId: 'proj-1f' });
    expect(result).toBeNull();
  });

  test('fetchProjectGitStatus throws when projectId is missing', async () => {
    await expect(fetchProjectGitStatus({ trackedFetch: () => null })).rejects.toThrow(
      'projectId is required to fetch git status'
    );
  });

  test('fetchProjectGitStatus throws backend error', async () => {
    const trackedFetch = () => Promise.resolve(buildResponse(false, { success: false, error: 'status failed' }));
    await expect(fetchProjectGitStatus({ trackedFetch, projectId: 'proj-1a' })).rejects.toThrow('status failed');
  });

  test('fetchProjectGitStatus falls back to default error message', async () => {
    const trackedFetch = () => Promise.resolve(buildResponse(false, { success: false }));
    await expect(fetchProjectGitStatus({ trackedFetch, projectId: 'proj-1c' })).rejects.toThrow('Failed to fetch git status');
  });

  test('fetchProjectGitStatus returns status payload on success', async () => {
    const trackedFetch = () => Promise.resolve(buildResponse(true, {
      success: true,
      status: { branch: 'main', ahead: 0, behind: 0 }
    }));

    const result = await fetchProjectGitStatus({ trackedFetch, projectId: 'proj-1b' });
    expect(result).toMatchObject({ branch: 'main', ahead: 0, behind: 0 });
  });

  test('fetchProjectGitStatus returns null when status is missing', async () => {
    const trackedFetch = () => Promise.resolve(buildResponse(true, { success: true }));

    const result = await fetchProjectGitStatus({ trackedFetch, projectId: 'proj-1d' });
    expect(result).toBeNull();
  });

  test('pullProjectGitRemote throws when projectId is missing', async () => {
    await expect(pullProjectGitRemote({ trackedFetch: () => null })).rejects.toThrow(
      'projectId is required to pull git remote'
    );
  });

  test('pullProjectGitRemote returns status and strategy', async () => {
    const trackedFetch = () => Promise.resolve(buildResponse(true, {
      success: true,
      status: { branch: 'main', ahead: 0, behind: 0 },
      strategy: 'ff-only'
    }));

    const result = await pullProjectGitRemote({ trackedFetch, projectId: 'proj-2' });
    expect(result).toMatchObject({
      status: { branch: 'main', ahead: 0, behind: 0 },
      strategy: 'ff-only'
    });
  });

  test('pullProjectGitRemote throws backend error', async () => {
    const trackedFetch = () => Promise.resolve(buildResponse(true, { success: false, error: 'blocked' }));
    await expect(pullProjectGitRemote({ trackedFetch, projectId: 'proj-3' })).rejects.toThrow('blocked');
  });

  test('pullProjectGitRemote falls back to default error message', async () => {
    const trackedFetch = () => Promise.resolve(buildResponse(false, { success: false }));
    await expect(pullProjectGitRemote({ trackedFetch, projectId: 'proj-4' })).rejects.toThrow(
      'Failed to pull git remote'
    );
  });

  test('pullProjectGitRemote returns null status and strategy when omitted', async () => {
    const trackedFetch = () => Promise.resolve(buildResponse(true, { success: true }));

    const result = await pullProjectGitRemote({ trackedFetch, projectId: 'proj-5' });
    expect(result).toEqual({ status: null, strategy: null, stash: null });
  });

  test('pullProjectGitRemote includes mode and confirm payload when provided', async () => {
    let captured;
    const trackedFetch = (url, options) => {
      captured = { url, options };
      return Promise.resolve(buildResponse(true, { success: true }));
    };

    await pullProjectGitRemote({
      trackedFetch,
      projectId: 'proj-5b',
      mode: 'rebase',
      confirm: true
    });

    expect(captured.url).toBe('/api/projects/proj-5b/git/pull');
    expect(JSON.parse(captured.options.body)).toEqual({ mode: 'rebase', confirm: true });
    expect(captured.options.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  test('stashProjectGitChanges throws when projectId is missing', async () => {
    await expect(stashProjectGitChanges({ trackedFetch: () => null })).rejects.toThrow(
      'projectId is required to stash git changes'
    );
  });

  test('stashProjectGitChanges returns payload on success', async () => {
    const trackedFetch = () => Promise.resolve(buildResponse(true, {
      success: true,
      stashed: true,
      label: 'lucidcoder-auto/main',
      status: { branch: 'main', ahead: 0, behind: 0 }
    }));

    const result = await stashProjectGitChanges({ trackedFetch, projectId: 'proj-stash' });
    expect(result).toMatchObject({ stashed: true, label: 'lucidcoder-auto/main' });
  });

  test('stashProjectGitChanges falls back to default error message', async () => {
    const trackedFetch = () => Promise.resolve(buildResponse(false, { success: false }));

    await expect(stashProjectGitChanges({ trackedFetch, projectId: 'proj-stash-2' }))
      .rejects.toThrow('Failed to stash changes');
  });

  test('discardProjectGitChanges throws when projectId is missing', async () => {
    await expect(discardProjectGitChanges({ trackedFetch: () => null })).rejects.toThrow(
      'projectId is required to discard git changes'
    );
  });

  test('discardProjectGitChanges throws backend error', async () => {
    const trackedFetch = () => Promise.resolve(buildResponse(false, { success: false, error: 'blocked' }));
    await expect(discardProjectGitChanges({ trackedFetch, projectId: 'proj-discard' })).rejects.toThrow('blocked');
  });

  test('discardProjectGitChanges falls back to default error message', async () => {
    const trackedFetch = () => Promise.resolve(buildResponse(false, { success: false }));

    await expect(discardProjectGitChanges({ trackedFetch, projectId: 'proj-discard-2' }))
      .rejects.toThrow('Failed to discard changes');
  });

  test('fetchProjectBranchesOverview throws on missing id', async () => {
    await expect(fetchProjectBranchesOverview({ trackedFetch: () => null })).rejects.toThrow(
      'projectId is required to fetch branches'
    );
  });

  test('fetchProjectBranchesOverview throws backend error', async () => {
    const trackedFetch = () => Promise.resolve(buildResponse(false, { success: false, error: 'bad branches' }));
    await expect(fetchProjectBranchesOverview({ trackedFetch, projectId: 'proj-4' })).rejects.toThrow('bad branches');
  });

  test('fetchProjectBranchesOverview falls back to default error message', async () => {
    const trackedFetch = () => Promise.resolve(buildResponse(false, { success: false }));
    await expect(fetchProjectBranchesOverview({ trackedFetch, projectId: 'proj-4b' })).rejects.toThrow('Failed to fetch branches');
  });

  test('fetchProjectBranchesOverview returns payload on success', async () => {
    const trackedFetch = () => Promise.resolve(buildResponse(true, {
      success: true,
      branches: [{ name: 'main' }],
      current: 'main'
    }));

    const result = await fetchProjectBranchesOverview({ trackedFetch, projectId: 'proj-4a' });
    expect(result).toMatchObject({ branches: [{ name: 'main' }], current: 'main' });
  });

  test('checkoutProjectBranch throws on missing input', async () => {
    await expect(checkoutProjectBranch({ trackedFetch: () => null, projectId: 'proj-5' })).rejects.toThrow(
      'projectId and branchName are required to checkout branch'
    );
  });

  test('checkoutProjectBranch throws backend error', async () => {
    const trackedFetch = () => Promise.resolve(buildResponse(false, { success: false, error: 'cannot checkout' }));
    await expect(checkoutProjectBranch({ trackedFetch, projectId: 'proj-6', branchName: 'main' })).rejects.toThrow('cannot checkout');
  });

  test('checkoutProjectBranch falls back to default error message', async () => {
    const trackedFetch = () => Promise.resolve(buildResponse(false, { success: false }));
    await expect(checkoutProjectBranch({ trackedFetch, projectId: 'proj-6b', branchName: 'main' })).rejects.toThrow(
      'Failed to checkout branch'
    );
  });

  test('checkoutProjectBranch returns response on success', async () => {
    const trackedFetch = () => Promise.resolve(buildResponse(true, { success: true, branch: 'main' }));
    const result = await checkoutProjectBranch({ trackedFetch, projectId: 'proj-7', branchName: 'main' });
    expect(result).toMatchObject({ success: true, branch: 'main' });
  });

  test('updateGitSettings marks token presence when token is provided', async () => {
    const trackedFetch = () => Promise.resolve(buildResponse(true, {
      success: true,
      settings: {
        workflow: 'cloud',
        provider: 'github',
        remoteUrl: '',
        username: '',
        defaultBranch: 'main'
      }
    }));
    const setGitSettings = vi.fn();

    const gitSettings = {
      workflow: 'local',
      provider: 'github',
      remoteUrl: '',
      username: '',
      token: '',
      tokenPresent: false,
      defaultBranch: 'main'
    };

    await updateGitSettings({
      trackedFetch,
      gitSettings,
      setGitSettings,
      updates: { token: 'abc123' }
    });

    expect(setGitSettings).toHaveBeenCalledWith(expect.objectContaining({ tokenPresent: true }));
  });

  test('updateGitSettings does not mark token presence for non-string token', async () => {
    const trackedFetch = () => Promise.resolve(buildResponse(true, {
      success: true,
      settings: {
        workflow: 'cloud',
        provider: 'github',
        remoteUrl: '',
        username: '',
        defaultBranch: 'main',
        tokenPresent: false
      }
    }));
    const setGitSettings = vi.fn();

    const gitSettings = {
      workflow: 'local',
      provider: 'github',
      remoteUrl: '',
      username: '',
      token: '',
      tokenPresent: false,
      defaultBranch: 'main'
    };

    await updateGitSettings({
      trackedFetch,
      gitSettings,
      setGitSettings,
      updates: { token: 123 }
    });

    expect(setGitSettings).not.toHaveBeenCalledWith(expect.objectContaining({ tokenPresent: true }));
  });

  test('testGitConnection returns payload on success', async () => {
    const trackedFetch = () => Promise.resolve(buildResponse(true, {
      success: true,
      provider: 'github',
      account: { login: 'octo' }
    }));

    const result = await testGitConnection({ trackedFetch, provider: 'github', token: 'abc' });
    expect(result).toMatchObject({ provider: 'github', account: { login: 'octo' } });
  });

  test('testGitConnection throws default error when response omits details', async () => {
    const trackedFetch = () => Promise.resolve(buildResponse(false, { success: false }));
    await expect(testGitConnection({ trackedFetch })).rejects.toThrow('Failed to test git connection');
  });

  test('updateProjectGitSettings uses project overrides as base and omits token by default', async () => {
    let capturedBody;
    const trackedFetch = (url, options) => {
      capturedBody = JSON.parse(options.body);
      return Promise.resolve(buildResponse(true, { success: true, settings: { workflow: 'cloud' } }));
    };
    const setProjectGitSettings = vi.fn();

    const projectGitSettings = {
      'proj-1': {
        workflow: 'cloud',
        provider: 'gitlab',
        remoteUrl: 'https://gitlab.com/acme/demo.git',
        defaultBranch: 'main',
        autoPush: true
      }
    };

    await updateProjectGitSettings({
      trackedFetch,
      projectId: 'proj-1',
      updates: { defaultBranch: 'release' },
      gitSettings: { workflow: 'local', provider: 'github' },
      projectGitSettings,
      setProjectGitSettings
    });

    expect(capturedBody).toMatchObject({
      workflow: 'cloud',
      provider: 'gitlab',
      remoteUrl: 'https://gitlab.com/acme/demo.git',
      defaultBranch: 'release'
    });
    expect(Object.prototype.hasOwnProperty.call(capturedBody, 'token')).toBe(false);
  });

  test('updateProjectGitSettings includes token when explicitly provided', async () => {
    let capturedBody;
    const trackedFetch = (url, options) => {
      capturedBody = JSON.parse(options.body);
      return Promise.resolve(buildResponse(true, { success: true, settings: { workflow: 'cloud' } }));
    };
    const setProjectGitSettings = vi.fn();

    await updateProjectGitSettings({
      trackedFetch,
      projectId: 'proj-2',
      updates: { token: 'secret' },
      gitSettings: { workflow: 'cloud', provider: 'github', remoteUrl: '' },
      projectGitSettings: {},
      setProjectGitSettings
    });

    expect(capturedBody.token).toBe('secret');
  });

  test('fetchTestingSettingsFromBackend merges backend settings into state', async () => {
    const trackedFetch = () => Promise.resolve(buildResponse(true, {
      success: true,
      settings: { coverageTarget: 80 }
    }));
    const setTestingSettings = vi.fn();

    await fetchTestingSettingsFromBackend({ trackedFetch, setTestingSettings });

    expect(setTestingSettings).toHaveBeenCalledTimes(1);
    const updater = setTestingSettings.mock.calls[0][0];
    expect(updater({ coverageTarget: 100 })).toEqual({ coverageTarget: 80 });
  });

  test('updateTestingSettings sends payload and updates state', async () => {
    let capturedBody;
    const trackedFetch = (url, options) => {
      capturedBody = JSON.parse(options.body);
      return Promise.resolve(buildResponse(true, {
        success: true,
        settings: { coverageTarget: 60 }
      }));
    };
    const setTestingSettings = vi.fn();

    const result = await updateTestingSettings({
      trackedFetch,
      testingSettings: { coverageTarget: 100 },
      setTestingSettings,
      updates: { coverageTarget: 60 }
    });

    expect(capturedBody).toEqual({ coverageTarget: 60 });
    expect(result).toEqual({ coverageTarget: 60 });
    expect(setTestingSettings).toHaveBeenCalledTimes(1);
  });

  test('updateTestingSettings falls back to current coverage target when updates omit coverageTarget', async () => {
    let capturedBody;
    const trackedFetch = (url, options) => {
      capturedBody = JSON.parse(options.body);
      return Promise.resolve(buildResponse(true, {
        success: true,
        settings: { coverageTarget: 90 }
      }));
    };

    await updateTestingSettings({
      trackedFetch,
      testingSettings: { coverageTarget: 90 },
      setTestingSettings: vi.fn(),
      updates: {}
    });

    expect(capturedBody).toEqual({ coverageTarget: 90 });
  });

  test('updateTestingSettings surfaces fetch errors from request failures', async () => {
    const trackedFetch = () => Promise.reject(new Error('Network offline'));

    await expect(updateTestingSettings({
      trackedFetch,
      testingSettings: { coverageTarget: 100 },
      setTestingSettings: vi.fn(),
      updates: { coverageTarget: 80 }
    })).rejects.toThrow('Network offline');
  });

  test('updateTestingSettings throws default error when response body is not valid JSON', async () => {
    const trackedFetch = () => Promise.resolve({
      ok: true,
      json: () => Promise.reject(new Error('invalid json'))
    });

    await expect(updateTestingSettings({
      trackedFetch,
      testingSettings: { coverageTarget: 100 },
      setTestingSettings: vi.fn(),
      updates: { coverageTarget: 80 }
    })).rejects.toThrow('Failed to save testing settings');
  });

  test('updateTestingSettings falls back to default error when backend omits details', async () => {
    const trackedFetch = () => Promise.resolve(buildResponse(false, { success: false }));

    await expect(updateTestingSettings({
      trackedFetch,
      testingSettings: { coverageTarget: 100 },
      setTestingSettings: vi.fn(),
      updates: { coverageTarget: 90 }
    })).rejects.toThrow('Failed to save testing settings');
  });
});
