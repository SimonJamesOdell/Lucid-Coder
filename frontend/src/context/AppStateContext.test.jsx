import React from 'react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { AppStateProvider, useAppState, __appStateTestHelpers } from './AppStateContext';
import * as appStateHelpers from './appState/helpers.js';

const createResponse = (ok, payload) => ({
  ok,
  json: () => Promise.resolve(payload)
});

const buildFetchMock = () => vi.fn((url) => {
  if (url === '/api/llm/status') {
    return Promise.resolve(createResponse(true, {
      success: true,
      configured: true,
      ready: true,
      config: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        api_url: 'https://api.openai.com/v1',
        requires_api_key: true,
        has_api_key: true
      }
    }));
  }

  if (typeof url === 'string' && url.includes('/branches/stage')) {
    return Promise.resolve(createResponse(true, {
      success: true,
      overview: {
        workingBranches: [
          {
            name: 'feature/login',
            status: 'active',
            stagedFiles: []
          }
        ]
      }
    }));
  }

  if (url === '/api/projects') {
    return Promise.resolve(createResponse(true, { success: true, projects: [] }));
  }

  if (url === '/api/settings/git') {
    return Promise.resolve(createResponse(true, { success: true, settings: {} }));
  }

  if (url === '/api/settings/ports') {
    return Promise.resolve(createResponse(true, { success: true, settings: {} }));
  }

  if (typeof url === 'string' && url.includes('/git/status')) {
    return Promise.resolve(createResponse(true, {
      success: true,
      status: {
        branch: 'main',
        ahead: 0,
        behind: 0,
        hasRemote: true,
        dirty: false
      }
    }));
  }

  if (typeof url === 'string' && url.includes('/git/fetch')) {
    return Promise.resolve(createResponse(true, {
      success: true,
      status: {
        branch: 'main',
        ahead: 0,
        behind: 0,
        hasRemote: true,
        dirty: false
      }
    }));
  }

  if (typeof url === 'string' && url.includes('/git/pull')) {
    return Promise.resolve(createResponse(true, {
      success: true,
      status: {
        branch: 'main',
        ahead: 0,
        behind: 0,
        hasRemote: true,
        dirty: false
      },
      strategy: 'noop'
    }));
  }

  return Promise.resolve(createResponse(true, { success: true }));
});

const wrapper = ({ children }) => (
  <AppStateProvider>{children}</AppStateProvider>
);

describe('AppStateContext integrations', () => {
  let fetchMock;
  let defaultFetchImpl;

  beforeEach(() => {
    localStorage.clear();
    defaultFetchImpl = buildFetchMock();
    fetchMock = fetch;
    fetchMock.mockReset();
    fetchMock.mockImplementation((...args) => defaultFetchImpl(...args));
  });

  test('importProject persists imported metadata and returns the snapshot', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/projects/import' && options?.method === 'POST') {
        return Promise.resolve(createResponse(true, {
          success: true,
          project: { id: 'imported-1', name: 'External Repo', description: 'Cloned' },
          jobs: []
        }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });
    let imported;

    await act(async () => {
      imported = await result.current.importProject({ name: 'External Repo', description: 'Cloned' });
    });

    const importedProject = imported?.project || imported;
    expect(importedProject.name).toBe('External Repo');
    expect(importedProject.id).toEqual(expect.any(String));
    expect(importedProject.id).not.toBe('');
    await waitFor(() => {
      expect(result.current.currentProject?.id).toBe(importedProject.id);
    });
  });

  test('updateGitSettings merges server response into state', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/settings/git' && options?.method === 'PUT') {
        return Promise.resolve(createResponse(true, {
          success: true,
          settings: {
            workflow: 'remote',
            provider: 'gitlab'
          }
        }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    const response = await result.current.updateGitSettings({ provider: 'gitlab' });
    expect(response.provider).toBe('gitlab');

    await waitFor(() => {
      expect(result.current.gitSettings.provider).toBe('gitlab');
      expect(result.current.gitSettings.workflow).toBe('remote');
      expect(result.current.gitSettings.token).toBe('');
    });
  });

  test('fetchGitSettingsFromBackend warns when initial load fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/settings/git' && (!options || options.method === 'GET')) {
        return Promise.resolve({
          ok: false,
          status: 503,
          json: () => Promise.resolve({ success: false, error: 'git unavailable' })
        });
      }
      return defaultFetchImpl(url, options);
    });

    renderHook(() => useAppState(), { wrapper });

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        'Failed to load git settings from backend:',
        expect.any(Error)
      );
    });

    warnSpy.mockRestore();
  });

  test('fetchPortSettingsFromBackend warns when initial load fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/settings/ports' && (!options || options.method === 'GET')) {
        return Promise.resolve({
          ok: false,
          status: 502,
          json: () => Promise.resolve({ success: false, error: 'ports unavailable' })
        });
      }
      return defaultFetchImpl(url, options);
    });

    renderHook(() => useAppState(), { wrapper });

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        'Failed to load port settings from backend:',
        expect.any(Error)
      );
    });

    warnSpy.mockRestore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('stageAiChange falls back to creating a note when no file tokens are present', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    const { result } = renderHook(() => useAppState(), { wrapper });

    // disregard boot fetches, focus on stage calls
    fetchMock.mockClear();

    await act(async () => {
      await result.current.stageAiChange('proj-1', 'Please reason about architecture without touching files.');
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, requestConfig] = fetchMock.mock.calls[0];
    const body = JSON.parse(requestConfig.body);
    expect(body.filePath).toBe('notes/ai-request-1700000000000.md');
    expect(body.source).toBe('ai');

    nowSpy.mockRestore();
  });

  test('stageAiChange extracts at most five unique file tokens per prompt', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });
    fetchMock.mockClear();

    const prompt = `
      Update src/App.jsx plus src/App.jsx again,
      adjust utils/helpers.ts and styles/site.css,
      document docs/README.md, touch server/api.js,
      and finally poke notebooks/analysis.py and scripts/setup.py
    `;

    await act(async () => {
      await result.current.stageAiChange('proj-1', prompt);
    });

    expect(fetchMock).toHaveBeenCalledTimes(5);
    const stagedPaths = fetchMock.mock.calls.map(([, config]) => JSON.parse(config.body).filePath);
    expect(stagedPaths).toEqual([
      'src/App.jsx',
      'utils/helpers.ts',
      'styles/site.css',
      'docs/README.md',
      'server/api.js'
    ]);
  });

  test('stageAiChange exits early when project or prompt is missing', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });
    fetchMock.mockClear();

    await act(async () => {
      await result.current.stageAiChange(null, 'src/App.jsx');
      await result.current.stageAiChange('proj-1', '');
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('useAppState throws when used outside of AppStateProvider', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => useAppState())).toThrow('useAppState must be used within an AppStateProvider');
    errorSpy.mockRestore();
  });

  test('markTestRunIntent normalizes the source and sets updatedAt', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      result.current.markTestRunIntent('  user  ');
    });

    await waitFor(() => {
      expect(result.current.testRunIntent.source).toBe('user');
      expect(result.current.testRunIntent.updatedAt).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    });

    act(() => {
      result.current.markTestRunIntent('   ');
      result.current.markTestRunIntent(null);
    });

    await waitFor(() => {
      expect(result.current.testRunIntent.source).toBe('unknown');
      expect(result.current.testRunIntent.updatedAt).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    });
  });

  test('detectFileTokens returns empty array when prompt is falsy', () => {
    expect(__appStateTestHelpers.detectFileTokens()).toEqual([]);
  });

  test('detectFileTokens returns empty array when prompt has no file tokens', () => {
    expect(__appStateTestHelpers.detectFileTokens('no filenames here')).toEqual([]);
  });

  test('detectFileTokens normalizes, de-dupes, and caps results to five entries', () => {
    const prompt = 'Touch ./src/App.jsx, src/App.jsx, scripts/setup.py, docs/README.md, a/b/c/test.ts, styles/site.css, extra/more.json';
    const tokens = __appStateTestHelpers.detectFileTokens(prompt);
    expect(tokens).toEqual([
      'src/App.jsx',
      'scripts/setup.py',
      'docs/README.md',
      'a/b/c/test.ts',
      'styles/site.css'
    ]);
  });

  test('normalizeRepoPath handles nullish values and normalizes separators', () => {
    expect(__appStateTestHelpers.normalizeRepoPath()).toBe('');
    expect(__appStateTestHelpers.normalizeRepoPath(null)).toBe('');
    expect(__appStateTestHelpers.normalizeRepoPath('.\\src\\App.css ')).toBe('src/App.css');
  });

  test('stageFileChange falls back to local staging when the API errors', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/branches/stage') && options?.method === 'POST') {
        return Promise.reject(new Error('backend unavailable'));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(async () => {
      const response = await result.current.stageFileChange('proj-fallback', 'src/App.jsx', 'editor');
      expect(response).toBeNull();
    });

    await waitFor(() => {
      const stagedFiles = result.current.workspaceChanges['proj-fallback']?.stagedFiles || [];
      expect(stagedFiles.at(-1)?.path).toBe('src/App.jsx');
      expect(stagedFiles.at(-1)?.source).toBe('editor');
    });
  });

  test('clearProjectGitSettings rejects when project id is missing', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });
    await expect(result.current.clearProjectGitSettings()).rejects.toThrow('projectId is required to clear project git settings');
  });

  test('updatePortSettings rejects when backend fails to persist changes', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/settings/ports' && options?.method === 'PUT') {
        return Promise.resolve(createResponse(true, { success: false, error: 'bad ports' }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });
    await expect(result.current.updatePortSettings({ frontendPortBase: 6200 })).rejects.toThrow('bad ports');
  });

  test('updatePortSettings uses existing port settings when updates omit frontendPortBase', async () => {
    let capturedBody = null;

    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/settings/ports' && options?.method === 'PUT') {
        capturedBody = JSON.parse(options.body);
        return Promise.resolve(createResponse(true, {
          success: true,
          settings: {
            frontendPortBase: capturedBody.frontendPortBase,
            backendPortBase: capturedBody.backendPortBase
          }
        }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });
    const initialFrontendPortBase = result.current.portSettings.frontendPortBase;

    const response = await result.current.updatePortSettings({ backendPortBase: 6500 });
    expect(response.backendPortBase).toBe(6500);

    expect(capturedBody).toEqual({
      frontendPortBase: initialFrontendPortBase,
      backendPortBase: 6500
    });
  });

  test('updatePortSettings uses a default error message when backend omits details', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/settings/ports' && options?.method === 'PUT') {
        return Promise.resolve(createResponse(true, { success: false }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });
    await expect(result.current.updatePortSettings({ frontendPortBase: 6200 })).rejects.toThrow(
      'Failed to save port settings'
    );
  });

  test('updatePortSettings reports restart failures after saving ports', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/settings/ports' && options?.method === 'PUT') {
        return Promise.resolve(createResponse(true, {
          success: true,
          settings: {
            frontendPortBase: 6200,
            backendPortBase: 6600
          }
        }));
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-ports/restart')) {
        return Promise.resolve(createResponse(true, { success: false, error: 'restart failed' }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-ports', name: 'Ports Project' });
    });

    await expect(result.current.updatePortSettings({ frontendPortBase: 6200 })).rejects.toThrow(
      'Port settings saved but failed to restart project: restart failed'
    );
  });

  test('updatePortSettings restarts the active project when appropriate', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/settings/ports' && options?.method === 'PUT') {
        return Promise.resolve(createResponse(true, {
          success: true,
          settings: {
            frontendPortBase: 6201,
            backendPortBase: 6601
          }
        }));
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-restart-ok/restart') && options?.method === 'POST') {
        return Promise.resolve(createResponse(true, {
          success: true,
          processes: { backend: { status: 'running' } }
        }));
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-restart-ok/processes')) {
        return Promise.resolve(createResponse(true, { success: true, processes: {} }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-restart-ok', name: 'Restart OK' });
    });

    const response = await result.current.updatePortSettings({ frontendPortBase: 6201 });
    expect(response.frontendPortBase).toBe(6201);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/proj-restart-ok/restart',
      expect.objectContaining({ method: 'POST' })
    );
  });

  test('updatePortSettings applies server settings when restart is unnecessary', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/settings/ports' && options?.method === 'PUT') {
        return Promise.resolve(createResponse(true, {
          success: true,
          settings: {
            frontendPortBase: 6400,
            backendPortBase: 6800
          }
        }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    const response = await result.current.updatePortSettings({ frontendPortBase: 6400 });
    expect(response.frontendPortBase).toBe(6400);
    expect(response.backendPortBase).toBe(6800);

    await waitFor(() => {
      expect(result.current.portSettings.frontendPortBase).toBe(6400);
      expect(result.current.portSettings.backendPortBase).toBe(6800);
    });
  });

  test('restartProject rejects when backend payload cannot be parsed', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/restart')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.reject(new Error('invalid json'))
        });
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await expect(result.current.restartProject('proj-parse')).rejects.toThrow('HTTP error! status: 200');
  });

  test('restartProject logs a warning when refreshProcessStatus fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/restart')) {
        return Promise.resolve(createResponse(true, {
          success: true,
          processes: { backend: { status: 'running' } }
        }));
      }
      if (typeof url === 'string' && url.includes('/processes')) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ success: false, error: 'status fail' })
        });
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await expect(result.current.restartProject('proj-warn')).resolves.toEqual({ backend: { status: 'running' } });
    expect(warnSpy).toHaveBeenCalledWith('Failed to refresh process status after restart', expect.any(Error));

    warnSpy.mockRestore();
  });

  test('restartProject clears process snapshots when backend omits processes', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/proj-clear/restart')) {
        return Promise.resolve(createResponse(true, { success: true, processes: null }));
      }
      if (typeof url === 'string' && url.includes('/proj-clear/processes')) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ success: false, error: 'process fail' })
        });
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-clear', name: 'Cleared Project' });
    });

    await expect(result.current.restartProject('proj-clear')).resolves.toBeNull();

    await waitFor(() => {
      expect(result.current.projectProcesses).toBeNull();
    });

    warnSpy.mockRestore();
  });

  test('restartProject surfaces backend errors when restart fails with an explicit message', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/api/projects/proj-fail/restart') && options?.method === 'POST') {
        return Promise.resolve(createResponse(true, { success: false, error: 'restart denied' }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });
    await expect(result.current.restartProject('proj-fail')).rejects.toThrow('restart denied');
  });

  test('restartProject uses HTTP status when backend fails without details', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/api/projects/proj-httpish/restart') && options?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 503,
          json: () => Promise.resolve({ success: false })
        });
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });
    await expect(result.current.restartProject('proj-httpish')).rejects.toThrow('HTTP error! status: 503');
  });

  test('restartProject defaults to the current project id when no argument is provided', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/api/projects/proj-default/restart') && options?.method === 'POST') {
        return Promise.resolve(createResponse(true, {
          success: true,
          processes: { backend: { status: 'running' } }
        }));
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-default/processes')) {
        return Promise.resolve(createResponse(true, { success: true, processes: {} }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-default', name: 'Default Project' });
    });

    await expect(result.current.restartProject()).resolves.toEqual({ backend: { status: 'running' } });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/proj-default/restart',
      expect.objectContaining({ method: 'POST' })
    );
  });

  test('applyProcessSnapshot helper updates and clears process snapshots', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    expect(typeof __appStateTestHelpers.applyProcessSnapshot).toBe('function');

    act(() => {
      const snapshot = __appStateTestHelpers.applyProcessSnapshot('proj-process', {
        processes: {
          backend: { status: 'running', port: '7000' }
        }
      });
      expect(snapshot.projectId).toBe('proj-process');
    });

    await waitFor(() => {
      expect(result.current.projectProcesses?.projectId).toBe('proj-process');
      expect(result.current.projectProcesses?.processes.backend.port).toBe('7000');
    });

    act(() => {
      const cleared = __appStateTestHelpers.applyProcessSnapshot(null, {});
      expect(cleared).toBeNull();
    });

    await waitFor(() => {
      expect(result.current.projectProcesses).toBeNull();
    });
  });

  test('applyProcessSnapshot preserves capabilities from previous snapshots', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      __appStateTestHelpers.applyProcessSnapshot('proj-capabilities', {
        processes: { frontend: { status: 'running' } },
        capabilities: { backend: { exists: true } }
      });
    });

    await waitFor(() => {
      expect(result.current.projectProcesses?.capabilities?.backend?.exists).toBe(true);
    });

    act(() => {
      __appStateTestHelpers.applyProcessSnapshot('proj-capabilities', {
        processes: { frontend: { status: 'running' } }
      });
    });

    await waitFor(() => {
      expect(result.current.projectProcesses?.capabilities?.backend?.exists).toBe(true);
    });
  });

  test('applyProcessSnapshot returns null when snapshot building fails', async () => {
    const snapshotSpy = vi.spyOn(appStateHelpers, 'buildProcessStateSnapshot')
      .mockReturnValueOnce(null);
    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      const snapshot = __appStateTestHelpers.applyProcessSnapshot('proj-null', { processes: {} });
      expect(snapshot).toBeNull();
    });

    await waitFor(() => {
      expect(result.current.projectProcesses).toBeNull();
    });

    snapshotSpy.mockRestore();
  });

  test('createBackend delegates to backend creation and refreshes processes', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/backend/create')) {
        return Promise.resolve(createResponse(true, { success: true, created: true }));
      }
      if (typeof url === 'string' && url.includes('/processes')) {
        return Promise.resolve(createResponse(true, { success: true, processes: {} }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(async () => {
      await result.current.createBackend('proj-backend');
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/proj-backend/backend/create',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/proj-backend/processes');
  });

  test('createBackend defaults to the current project id', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/backend/create')) {
        return Promise.resolve(createResponse(true, { success: true, created: true }));
      }
      if (typeof url === 'string' && url.includes('/processes')) {
        return Promise.resolve(createResponse(true, { success: true, processes: {} }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      result.current.setCurrentProject({ id: 'proj-current', name: 'Current' });
    });

    await act(async () => {
      await result.current.createBackend();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/proj-current/backend/create',
      expect.objectContaining({ method: 'POST' })
    );
  });

  test('clearProjectGitSettings surfaces backend errors', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/git-settings') && options?.method === 'DELETE') {
        return Promise.resolve(createResponse(true, { success: false, error: 'cannot clear' }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });
    await expect(result.current.clearProjectGitSettings('proj-error')).rejects.toThrow('cannot clear');
  });

  test('clearProjectGitSettings surfaces HTTP failures when backend rejects request', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/git-settings') && options?.method === 'DELETE') {
        return Promise.resolve({
          ok: false,
          status: 502,
          json: () => Promise.resolve({ success: false, error: 'gateway down' })
        });
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });
    await expect(result.current.clearProjectGitSettings('proj-http')).rejects.toThrow('gateway down');
  });

  test('clearProjectGitSettings uses a default error message when backend omits details', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/git-settings') && options?.method === 'DELETE') {
        return Promise.resolve(createResponse(true, { success: false }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });
    await expect(result.current.clearProjectGitSettings('proj-default-error')).rejects.toThrow(
      'Failed to clear project git settings'
    );
  });

  test('createProjectRemoteRepository requires a project id', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });
    await expect(result.current.createProjectRemoteRepository(null, {})).rejects.toThrow(
      'projectId is required to create a remote repository'
    );
  });

  test('createProjectRemoteRepository surfaces backend errors', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/git/remotes') && options?.method === 'POST') {
        return Promise.resolve(createResponse(true, { success: false, error: 'remote fail' }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });
    await expect(result.current.createProjectRemoteRepository('proj-remote', {})).rejects.toThrow('remote fail');
  });

  test('createProjectRemoteRepository uses a default error message when backend omits details', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/git/remotes') && options?.method === 'POST') {
        return Promise.resolve(createResponse(true, { success: false }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });
    await expect(result.current.createProjectRemoteRepository('proj-remote-default', {})).rejects.toThrow(
      'Failed to create remote repository'
    );
  });

  test('createProjectRemoteRepository persists sanitized overrides on success', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/git/remotes') && options?.method === 'POST') {
        return Promise.resolve(createResponse(true, {
          success: true,
          projectSettings: {
            workflow: 'remote',
            provider: 'gitlab',
            token: 'secret'
          }
        }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    const response = await result.current.createProjectRemoteRepository('proj-remote', { provider: 'gitlab' });
    expect(response.success).toBe(true);

    await waitFor(() => {
      expect(result.current.getProjectGitSettingsSnapshot('proj-remote').projectSettings).toEqual({
        workflow: 'remote',
        provider: 'gitlab',
        token: ''
      });
    });
  });

  test('createProjectRemoteRepository falls back to server settings when snapshot missing', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/git/remotes') && options?.method === 'POST') {
        return Promise.resolve(createResponse(true, {
          success: true,
          settings: {
            workflow: 'hybrid',
            provider: 'bitbucket',
            token: 'server'
          }
        }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    const response = await result.current.createProjectRemoteRepository('proj-fallback', { provider: 'bitbucket' });
    expect(response.success).toBe(true);

    await waitFor(() => {
      expect(result.current.getProjectGitSettingsSnapshot('proj-fallback').projectSettings).toEqual({
        workflow: 'hybrid',
        provider: 'bitbucket',
        token: ''
      });
    });
  });

  test('createProjectRemoteRepository does not persist overrides when response contains no settings snapshot', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/git/remotes') && options?.method === 'POST') {
        return Promise.resolve(createResponse(true, { success: true }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    const response = await result.current.createProjectRemoteRepository('proj-no-snapshot', { provider: 'github' });
    expect(response.success).toBe(true);

    await waitFor(() => {
      const snapshot = result.current.getProjectGitSettingsSnapshot('proj-no-snapshot');
      expect(snapshot.projectSettings).toBeNull();
      expect(snapshot.inheritsFromGlobal).toBe(true);
    });
  });

  test('getProjectGitSettingsSnapshot falls back to globals when no project id is provided', () => {
    const { result } = renderHook(() => useAppState(), { wrapper });
    const snapshot = result.current.getProjectGitSettingsSnapshot();
    expect(snapshot.inheritsFromGlobal).toBe(true);
    expect(snapshot.projectSettings).toBeNull();
    expect(snapshot.globalSettings).toEqual(expect.any(Object));
  });

  test('updateProjectGitSettings requires a project id', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });
    await expect(result.current.updateProjectGitSettings()).rejects.toThrow(
      'projectId is required to update project git settings'
    );
  });

  test('updateProjectGitSettings surfaces backend errors', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/git-settings') && options?.method === 'PUT') {
        return Promise.resolve(createResponse(true, { success: false, error: 'save failed' }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });
    await expect(result.current.updateProjectGitSettings('proj-update', { workflow: 'remote' })).rejects.toThrow('save failed');
  });

  test('updateProjectGitSettings uses a default error message when backend omits details', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/git-settings') && options?.method === 'PUT') {
        return Promise.resolve(createResponse(true, { success: false }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });
    await expect(result.current.updateProjectGitSettings('proj-update-default', { workflow: 'remote' })).rejects.toThrow(
      'Failed to save project git settings'
    );
  });

  test('updateProjectGitSettings strips inherited tokens when updates omit the field', async () => {
    let capturedBody = null;
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/git-settings') && options?.method === 'PUT') {
        capturedBody = JSON.parse(options.body);
        return Promise.resolve(createResponse(true, {
          success: true,
          projectSettings: {
            workflow: 'remote',
            provider: 'gitlab'
          }
        }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(async () => {
      await result.current.updateProjectGitSettings('proj-tokenless', { workflow: 'remote' });
    });

    expect(capturedBody).toEqual(expect.any(Object));
    expect(capturedBody.token).toBeUndefined();

    await waitFor(() => {
      const snapshot = result.current.getProjectGitSettingsSnapshot('proj-tokenless');
      expect(snapshot.projectSettings).toMatchObject({ workflow: 'remote', token: '' });
    });
  });

  test('updateProjectGitSettings persists settings when projectSettings is omitted', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/git-settings') && options?.method === 'PUT') {
        return Promise.resolve(createResponse(true, {
          success: true,
          settings: {
            workflow: 'remote',
            provider: 'github'
          }
        }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    let response;
    await act(async () => {
      response = await result.current.updateProjectGitSettings('proj-update-settings', { workflow: 'remote' });
    });

    expect(response).toMatchObject({ workflow: 'remote', provider: 'github' });

    await waitFor(() => {
      const snapshot = result.current.getProjectGitSettingsSnapshot('proj-update-settings');
      expect(snapshot.projectSettings).toMatchObject({ workflow: 'remote', provider: 'github' });
    });
  });

  test('updateGitSettings surfaces backend errors', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/settings/git' && options?.method === 'PUT') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: false, error: 'invalid creds' })
        });
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });
    await expect(result.current.updateGitSettings({ username: 'bot' })).rejects.toThrow('invalid creds');
  });

  test('updateGitSettings uses a default error message when backend omits details', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/settings/git' && options?.method === 'PUT') {
        return Promise.resolve(createResponse(true, { success: false }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });
    await expect(result.current.updateGitSettings({ provider: 'github' })).rejects.toThrow('Failed to save git settings');
  });

  test('updateGitSettings omits token when updates do not include it', async () => {
    let capturedBody;
    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/settings/git' && options?.method === 'PUT') {
        capturedBody = JSON.parse(options.body);
        return Promise.resolve(createResponse(true, { success: true, settings: { provider: 'github' } }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });
    await result.current.updateGitSettings({ provider: 'github' });

    expect(capturedBody).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(capturedBody, 'token')).toBe(false);
  });

  test('fetchProjectGitSettings returns null when project id is missing', async () => {
    renderHook(() => useAppState(), { wrapper });

    const snapshot = await __appStateTestHelpers.fetchProjectGitSettings();
    expect(snapshot).toBeNull();
  });

  test('fetchProjectGitSettings warns when backend fails before returning settings', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/proj-git-error/git-settings')) {
        return Promise.resolve({
          ok: false,
          status: 502,
          json: () => Promise.resolve({ success: false })
        });
      }
      return defaultFetchImpl(url, options);
    });

    renderHook(() => useAppState(), { wrapper });

    const snapshot = await __appStateTestHelpers.fetchProjectGitSettings('proj-git-error');
    expect(snapshot).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith('Failed to load project git settings:', expect.any(Error));

    warnSpy.mockRestore();
  });

  test('fetchProjectGitSettings warns and returns null when backend returns success=false without a message', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/proj-git-success-false/git-settings')) {
        return Promise.resolve(createResponse(true, { success: false }));
      }
      return defaultFetchImpl(url, options);
    });

    renderHook(() => useAppState(), { wrapper });

    const snapshot = await __appStateTestHelpers.fetchProjectGitSettings('proj-git-success-false');
    expect(snapshot).toBeNull();

    expect(warnSpy).toHaveBeenCalledWith('Failed to load project git settings:', expect.any(Error));
    const errorArg = warnSpy.mock.calls[warnSpy.mock.calls.length - 1][1];
    expect(errorArg.message).toBe('Failed to load project git settings');

    warnSpy.mockRestore();
  });

  test('fetchProjects falls back to localStorage when the backend request rejects', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem('projects', JSON.stringify([{ id: 'proj-local', name: 'Local Project' }]));

    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/projects') {
        return Promise.reject(new Error('backend offline'));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(async () => {
      await result.current.fetchProjects();
    });

    await waitFor(() => {
      expect(result.current.projects).toEqual([{ id: 'proj-local', name: 'Local Project' }]);
    });

    expect(warnSpy).toHaveBeenCalledWith('Failed to fetch projects from backend:', expect.any(Error));
    warnSpy.mockRestore();
  });

  test('fetchProjects falls back to localStorage when the HTTP response is not ok', async () => {
    localStorage.setItem('projects', JSON.stringify([{ id: 'proj-local', name: 'Local Project' }]));
    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/projects') {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ success: true, projects: [] })
        });
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(async () => {
      await result.current.fetchProjects();
    });

    await waitFor(() => {
      expect(result.current.projects).toEqual([{ id: 'proj-local', name: 'Local Project' }]);
    });
  });

  test('initial load hydrates currentProject and swallows silent job refresh failures', async () => {
    localStorage.setItem('currentProject', JSON.stringify({ id: 'proj-boot', name: 'Boot Project' }));

    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/llm/status') {
        return Promise.resolve(createResponse(true, {
          success: true,
          configured: true,
          ready: true,
          config: {
            provider: 'openai',
            model: 'gpt-4o-mini',
            api_url: 'https://api.openai.com/v1',
            requires_api_key: true,
            has_api_key: true
          }
        }));
      }
      if (url === '/api/projects') {
        return Promise.resolve(createResponse(true, { success: true, projects: [] }));
      }
      if (url === '/api/settings/git') {
        return Promise.resolve(createResponse(true, { success: true, settings: {} }));
      }
      if (url === '/api/settings/ports') {
        return Promise.resolve(createResponse(true, { success: true, settings: {} }));
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-boot/jobs')) {
        return Promise.resolve(createResponse(true, { success: false }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await waitFor(() => {
      expect(result.current.currentProject?.id).toBe('proj-boot');
    });

    await waitFor(() => {
      const started = fetchMock.mock.calls.some(([url, options]) =>
        typeof url === 'string' &&
        url.includes('/api/projects/proj-boot/start') &&
        options?.method === 'POST'
      );
      expect(started).toBe(true);
    });

    await waitFor(() => {
      expect(result.current.jobState.error).toBe('Failed to load jobs');
    });
  });

  test('auto-starts a hydrated project only once', async () => {
    localStorage.setItem('currentProject', JSON.stringify({ id: 'proj-once', name: 'Once Project' }));

    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/llm/status') {
        return Promise.resolve(createResponse(true, {
          success: true,
          configured: true,
          ready: true,
          config: {
            provider: 'openai',
            model: 'gpt-4o-mini',
            api_url: 'https://api.openai.com/v1',
            requires_api_key: true,
            has_api_key: true
          }
        }));
      }
      if (url === '/api/projects') {
        return Promise.resolve(createResponse(true, { success: true, projects: [] }));
      }
      if (url === '/api/settings/git') {
        return Promise.resolve(createResponse(true, { success: true, settings: {} }));
      }
      if (url === '/api/settings/ports') {
        return Promise.resolve(createResponse(true, { success: true, settings: {} }));
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-once/git-settings')) {
        return Promise.resolve(createResponse(true, { success: true, inheritsFromGlobal: true, projectSettings: null, settings: {} }));
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-once/start')) {
        return Promise.resolve(createResponse(true, { success: true, message: 'started', processes: { frontend: { status: 'starting' } } }));
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-once/processes')) {
        return Promise.resolve(createResponse(true, { success: true, projectId: 'proj-once', processes: {} }));
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-once/jobs')) {
        return Promise.resolve(createResponse(true, { success: true, jobs: [] }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await waitFor(() => {
      expect(result.current.currentProject?.id).toBe('proj-once');
    });

    await waitFor(() => {
      const starts = fetchMock.mock.calls.filter(([url, options]) =>
        typeof url === 'string' &&
        url.includes('/api/projects/proj-once/start') &&
        options?.method === 'POST'
      );
      expect(starts).toHaveLength(1);
    });

    await act(async () => {
      await result.current.refreshLLMStatus();
    });

    await waitFor(() => {
      expect(result.current.isLLMConfigured).toBe(true);
    });

    const repeatedStarts = fetchMock.mock.calls.filter(([url, options]) =>
      typeof url === 'string' &&
      url.includes('/api/projects/proj-once/start') &&
      options?.method === 'POST'
    );
    expect(repeatedStarts).toHaveLength(1);
  });

  test('auto-start guard skips when project already started', async () => {
    localStorage.setItem('currentProject', JSON.stringify({ id: 'proj-guard', name: 'Guard Project' }));

    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/llm/status') {
        return Promise.resolve(createResponse(true, {
          success: true,
          configured: true,
          ready: true,
          config: {
            provider: 'openai',
            model: 'gpt-4o-mini',
            api_url: 'https://api.openai.com/v1',
            requires_api_key: true,
            has_api_key: true
          }
        }));
      }
      if (url === '/api/projects') {
        return Promise.resolve(createResponse(true, { success: true, projects: [] }));
      }
      if (url === '/api/settings/git') {
        return Promise.resolve(createResponse(true, { success: true, settings: {} }));
      }
      if (url === '/api/settings/ports') {
        return Promise.resolve(createResponse(true, { success: true, settings: {} }));
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-guard/git-settings')) {
        return Promise.resolve(createResponse(true, { success: true, inheritsFromGlobal: true, projectSettings: null, settings: {} }));
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-guard/start')) {
        return Promise.resolve(createResponse(true, { success: true, message: 'started', processes: { frontend: { status: 'starting' } } }));
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-guard/processes')) {
        return Promise.resolve(createResponse(true, { success: true, projectId: 'proj-guard', processes: {} }));
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-guard/jobs')) {
        return Promise.resolve(createResponse(true, { success: true, jobs: [] }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await waitFor(() => {
      expect(result.current.currentProject?.id).toBe('proj-guard');
    });

    await waitFor(() => {
      const starts = fetchMock.mock.calls.filter(([url, options]) =>
        typeof url === 'string' &&
        url.includes('/api/projects/proj-guard/start') &&
        options?.method === 'POST'
      );
      expect(starts).toHaveLength(1);
    });

    act(() => {
      __appStateTestHelpers.setAutoStartState({
        autoStartedProjectId: 'proj-guard',
        hydratedProjectFromStorage: true
      });
    });

    await act(async () => {
      await result.current.refreshLLMStatus();
    });

    const repeatedStarts = fetchMock.mock.calls.filter(([url, options]) =>
      typeof url === 'string' &&
      url.includes('/api/projects/proj-guard/start') &&
      options?.method === 'POST'
    );
    expect(repeatedStarts).toHaveLength(1);
  });

  test('auto-start marks hydrated project as started when processes already running', async () => {
    localStorage.setItem('currentProject', JSON.stringify({ id: 'proj-running', name: 'Running Project' }));

    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/llm/status') {
        return Promise.resolve(createResponse(true, {
          success: true,
          configured: true,
          ready: true,
          config: {
            provider: 'openai',
            model: 'gpt-4o-mini',
            api_url: 'https://api.openai.com/v1',
            requires_api_key: true,
            has_api_key: true
          }
        }));
      }
      if (url === '/api/projects') {
        return Promise.resolve(createResponse(true, { success: true, projects: [] }));
      }
      if (url === '/api/settings/git') {
        return Promise.resolve(createResponse(true, { success: true, settings: {} }));
      }
      if (url === '/api/settings/ports') {
        return Promise.resolve(createResponse(true, { success: true, settings: {} }));
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-running/git-settings')) {
        return Promise.resolve(createResponse(true, { success: true, inheritsFromGlobal: true, projectSettings: null, settings: {} }));
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-running/processes')) {
        return Promise.resolve(createResponse(true, { success: true, projectId: 'proj-running', processes: { frontend: { status: 'running', port: 5173 } } }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await waitFor(() => {
      expect(result.current.currentProject?.id).toBe('proj-running');
    });

    act(() => {
      __appStateTestHelpers.applyProcessSnapshot('proj-running', {
        processes: { frontend: { status: 'running', port: 5173 } }
      });
    });

    act(() => {
      result.current.reportBackendConnectivity('online');
    });

    await waitFor(() => {
      const starts = fetchMock.mock.calls.filter(([url, options]) =>
        typeof url === 'string' &&
        url.includes('/api/projects/proj-running/start') &&
        options?.method === 'POST'
      );
      expect(starts).toHaveLength(0);
    });
  });

  test('auto-start retry schedules and clears when processes start', async () => {
    globalThis.__lucidcoderEnableAutoStartRetryTests = true;

    localStorage.setItem('currentProject', JSON.stringify({ id: 'proj-retry', name: 'Retry Project' }));

    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/llm/status') {
        return Promise.resolve(createResponse(true, {
          success: true,
          configured: true,
          ready: true,
          config: {
            provider: 'openai',
            model: 'gpt-4o-mini',
            api_url: 'https://api.openai.com/v1',
            requires_api_key: true,
            has_api_key: true
          }
        }));
      }
      if (url === '/api/projects') {
        return Promise.resolve(createResponse(true, { success: true, projects: [] }));
      }
      if (url === '/api/settings/git') {
        return Promise.resolve(createResponse(true, { success: true, settings: {} }));
      }
      if (url === '/api/settings/ports') {
        return Promise.resolve(createResponse(true, { success: true, settings: {} }));
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-retry/git-settings')) {
        return Promise.resolve(createResponse(true, { success: true, inheritsFromGlobal: true, projectSettings: null, settings: {} }));
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-retry/start')) {
        return Promise.resolve(createResponse(false, { success: false, error: 'start failed' }));
      }
      return defaultFetchImpl(url, options);
    });

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    try {
      const { result } = renderHook(() => useAppState(), { wrapper });

      await waitFor(() => {
        expect(result.current.currentProject?.id).toBe('proj-retry');
      });

      act(() => {
        result.current.reportBackendConnectivity('online');
      });

      await waitFor(() => {
        expect(setTimeoutSpy).toHaveBeenCalled();
      });

      act(() => {
        __appStateTestHelpers.applyProcessSnapshot('proj-retry', {
          processes: { frontend: { status: 'running', port: 5173 } }
        });
      });

      await waitFor(() => {
        expect(clearTimeoutSpy).toHaveBeenCalled();
      });
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      delete globalThis.__lucidcoderEnableAutoStartRetryTests;
    }
  });

  test('clearProjectStopped no-ops when project is not marked stopped', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      __appStateTestHelpers.clearProjectStopped('proj-missing');
    });

    await waitFor(() => {
      expect(result.current.stoppedProjects).toEqual({});
    });
  });

  test('clearProjectStopped ignores missing project ids', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      __appStateTestHelpers.clearProjectStopped(null);
    });

    await waitFor(() => {
      expect(result.current.stoppedProjects).toEqual({});
    });
  });

  test('markProjectStopped ignores missing project ids', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      __appStateTestHelpers.markProjectStopped(undefined);
    });

    await waitFor(() => {
      expect(result.current.stoppedProjects).toEqual({});
    });
  });

  test('clearProjectStopped removes an existing stopped project entry', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      __appStateTestHelpers.markProjectStopped('proj-stopped');
    });

    await waitFor(() => {
      expect(result.current.stoppedProjects).toEqual({ 'proj-stopped': true });
    });

    act(() => {
      __appStateTestHelpers.clearProjectStopped('proj-stopped');
    });

    await waitFor(() => {
      expect(result.current.stoppedProjects).toEqual({});
    });
  });

  test('auto-start retry timer ref clears when processes report running', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/llm/status') {
        return Promise.resolve(createResponse(true, {
          success: true,
          configured: true,
          ready: true,
          config: {
            provider: 'openai',
            model: 'gpt-4o-mini',
            api_url: 'https://api.openai.com/v1',
            requires_api_key: true,
            has_api_key: true
          }
        }));
      }
      if (url === '/api/projects') {
        return Promise.resolve(createResponse(true, { success: true, projects: [] }));
      }
      if (url === '/api/settings/git') {
        return Promise.resolve(createResponse(true, { success: true, settings: {} }));
      }
      if (url === '/api/settings/ports') {
        return Promise.resolve(createResponse(true, { success: true, settings: {} }));
      }
      return defaultFetchImpl(url, options);
    });

    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    try {
      const { result } = renderHook(() => useAppState(), { wrapper });

      act(() => {
        result.current.setCurrentProject({ id: 'proj-retry-clear', name: 'Retry Clear' });
      });

      await waitFor(() => {
        expect(result.current.currentProject?.id).toBe('proj-retry-clear');
      });

      act(() => {
        __appStateTestHelpers.setAutoStartState({
          autoStartedProjectId: null,
          hydratedProjectFromStorage: true
        });
        __appStateTestHelpers.setAutoStartRetryTimer(123);
      });

      act(() => {
        __appStateTestHelpers.applyProcessSnapshot('proj-retry-clear', {
          processes: { frontend: { status: 'running', port: 5173 } }
        });
      });

      act(() => {
        __appStateTestHelpers.setAutoStartState({ hydratedProjectFromStorage: true });
      });

      act(() => {
        __appStateTestHelpers.finalizeHydratedAutoStart();
      });

      await waitFor(() => {
        expect(clearTimeoutSpy).toHaveBeenCalled();
      });
    } finally {
      clearTimeoutSpy.mockRestore();
    }
  });

  test('initial load keeps hydrated currentProject when LLM is not configured', async () => {
    localStorage.setItem('currentProject', JSON.stringify({ id: 'proj-boot', name: 'Boot Project' }));

    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/llm/status') {
        return Promise.resolve(createResponse(true, {
          success: true,
          configured: false,
          ready: false,
          reason: 'No LLM configuration found'
        }));
      }

      if (url === '/api/projects') {
        return Promise.resolve(createResponse(true, { success: true, projects: [] }));
      }

      if (url === '/api/settings/git') {
        return Promise.resolve(createResponse(true, { success: true, settings: {} }));
      }
      if (url === '/api/settings/ports') {
        return Promise.resolve(createResponse(true, { success: true, settings: {} }));
      }

      if (typeof url === 'string' && url.includes('/api/projects/proj-boot/start')) {
        return Promise.resolve(createResponse(true, { success: true, message: 'started', processes: { frontend: { status: 'starting' } } }));
      }

      if (typeof url === 'string' && url.includes('/api/projects/proj-boot/processes')) {
        return Promise.resolve(createResponse(true, { success: true, projectId: 'proj-boot', processes: {} }));
      }

      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    // Initial hydration loads the project immediately.
    await waitFor(() => {
      expect(result.current.currentProject?.id).toBe('proj-boot');
    });

    await waitFor(() => {
      const starts = fetchMock.mock.calls.filter(([url, options]) =>
        typeof url === 'string' &&
        url.includes('/api/projects/proj-boot/start') &&
        options?.method === 'POST'
      );
      expect(starts).toHaveLength(1);
    });

    expect(result.current.currentProject?.id).toBe('proj-boot');
  });

  test('does not auto-close when hydrated currentProject is missing an id', async () => {
    localStorage.setItem('currentProject', JSON.stringify({ name: 'Boot Project' }));

    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/llm/status') {
        return Promise.resolve(createResponse(true, {
          success: true,
          configured: false,
          ready: false,
          reason: 'No LLM configuration found'
        }));
      }

      if (url === '/api/projects') {
        return Promise.resolve(createResponse(true, { success: true, projects: [] }));
      }

      if (url === '/api/settings/git') {
        return Promise.resolve(createResponse(true, { success: true, settings: {} }));
      }
      if (url === '/api/settings/ports') {
        return Promise.resolve(createResponse(true, { success: true, settings: {} }));
      }

      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await waitFor(() => {
      expect(result.current.currentProject?.name).toBe('Boot Project');
    });

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => url === '/api/llm/status')).toBe(true);
    });

    expect(fetchMock.mock.calls.some(([url]) => typeof url === 'string' && url.includes('/stop'))).toBe(false);
    expect(result.current.currentProject?.name).toBe('Boot Project');
  });

  test('initial load hydrates llmConfig and marks the app as configured', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/llm/status') {
        return Promise.resolve(createResponse(true, {
          success: true,
          configured: true,
          ready: true,
          config: {
            provider: 'openai',
            model: 'gpt-4o-mini',
            api_url: 'https://api.openai.com/v1',
            requires_api_key: true,
            has_api_key: true
          }
        }));
      }
      if (url === '/api/projects') {
        return Promise.resolve(createResponse(true, { success: true, projects: [] }));
      }
      if (url === '/api/settings/git') {
        return Promise.resolve(createResponse(true, { success: true, settings: {} }));
      }
      if (url === '/api/settings/ports') {
        return Promise.resolve(createResponse(true, { success: true, settings: {} }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLLMConfigured).toBe(true);
      expect(result.current.llmConfig).toMatchObject({ provider: 'openai', model: 'gpt-4o-mini' });
    });
  });

  test('fetchProjectGitSettings persists project overrides when project settings are returned', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/proj-git-specific/git-settings')) {
        return Promise.resolve(createResponse(true, {
          success: true,
          inheritsFromGlobal: false,
          effectiveSettings: {
            workflow: 'remote',
            provider: 'github',
            token: 'effective-token'
          },
          projectSettings: {
            workflow: 'remote',
            provider: 'gitlab',
            token: 'secret'
          }
        }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    const snapshot = await __appStateTestHelpers.fetchProjectGitSettings('proj-git-specific');
    expect(snapshot?.inheritsFromGlobal).toBe(false);
    expect(snapshot?.projectSettings).toEqual({
      workflow: 'remote',
      provider: 'gitlab',
      token: ''
    });

    await waitFor(() => {
      expect(result.current.getProjectGitSettingsSnapshot('proj-git-specific').projectSettings).toEqual({
        workflow: 'remote',
        provider: 'gitlab',
        token: ''
      });
    });
  });

  test('selectProject closes the previous project and applies backend process snapshots', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/api/projects/proj-legacy/stop') && options?.method === 'POST') {
        return Promise.resolve(createResponse(true, { success: true, message: 'stopped' }));
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-next/git-settings')) {
        return Promise.resolve(createResponse(true, {
          success: true,
          inheritsFromGlobal: true,
          projectSettings: null,
          settings: { workflow: 'remote' }
        }));
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-next/start') && options?.method === 'POST') {
        return Promise.resolve(createResponse(true, {
          success: true,
          message: 'started',
          processes: {
            backend: { status: 'running', port: 7777 }
          }
        }));
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-next/processes')) {
        return Promise.resolve(createResponse(true, {
          success: true,
          processes: {
            backend: { status: 'running', port: 7777 }
          }
        }));
      }
      return defaultFetchImpl(url, options);
    });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-legacy', name: 'Legacy Project' });
    });

    fetchMock.mockClear();

    await act(async () => {
      await result.current.selectProject({ id: 'proj-next', name: 'Next Project' });
    });

    const stopCallIndex = fetchMock.mock.calls.findIndex(([url]) => typeof url === 'string' && url.includes('/proj-legacy/stop'));
    const startCallIndex = fetchMock.mock.calls.findIndex(([url]) => typeof url === 'string' && url.includes('/proj-next/start'));
    expect(stopCallIndex).toBeGreaterThan(-1);
    expect(startCallIndex).toBeGreaterThan(stopCallIndex);

    await waitFor(() => {
      expect(result.current.currentProject?.id).toBe('proj-next');
      expect(result.current.projectProcesses?.projectId).toBe('proj-next');
      expect(result.current.projectProcesses?.processes.backend.status).toBe('running');
    });
  });

  test('selectProject warns when refreshProcessStatus fails after start', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/api/projects/proj-refresh/git-settings')) {
        return Promise.resolve(createResponse(true, {
          success: true,
          inheritsFromGlobal: true,
          projectSettings: null,
          settings: {}
        }));
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-refresh/start') && options?.method === 'POST') {
        return Promise.resolve(createResponse(true, {
          success: true,
          message: 'started',
          processes: {
            backend: { status: 'running' }
          }
        }));
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-refresh/processes')) {
        return Promise.reject(new Error('status unavailable'));
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-refresh/jobs')) {
        return Promise.resolve(createResponse(true, { success: true, jobs: [] }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(async () => {
      await result.current.selectProject({ id: 'proj-refresh', name: 'Refresh Fail' });
    });

    expect(warnSpy).toHaveBeenCalledWith('Failed to refresh process status after start:', expect.any(Error));
    warnSpy.mockRestore();
  });

  test('selectProject warns when start request cannot reach backend', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/api/projects/proj-offline-start/git-settings')) {
        return Promise.resolve(createResponse(true, {
          success: true,
          inheritsFromGlobal: true,
          projectSettings: null,
          settings: {}
        }));
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-offline-start/start') && options?.method === 'POST') {
        return Promise.reject(new Error('Failed to fetch: start offline'));
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-offline-start/jobs')) {
        return Promise.resolve(createResponse(true, { success: true, jobs: [] }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(async () => {
      await result.current.selectProject({ id: 'proj-offline-start', name: 'Offline Start' });
    });

    expect(warnSpy).toHaveBeenCalledWith(
      'Backend server not available - project selected but processes not started. Please ensure the backend server is running.'
    );
    warnSpy.mockRestore();
  });

  test('selectProject logs an error when start request fails without network hints', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/api/projects/proj-start-error/git-settings')) {
        return Promise.resolve(createResponse(true, {
          success: true,
          inheritsFromGlobal: true,
          projectSettings: null,
          settings: {}
        }));
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-start-error/start') && options?.method === 'POST') {
        return Promise.reject(new Error('start crashed'));
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-start-error/jobs')) {
        return Promise.resolve(createResponse(true, { success: true, jobs: [] }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(async () => {
      await result.current.selectProject({ id: 'proj-start-error', name: 'Error Start' });
    });

    expect(errorSpy).toHaveBeenCalledWith('Failed to start project processes:', expect.any(Error));
    errorSpy.mockRestore();
  });

  test('selectProject logs an error when start returns a non-ok response', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/api/projects/proj-start-http/git-settings')) {
        return Promise.resolve(createResponse(true, {
          success: true,
          inheritsFromGlobal: true,
          projectSettings: null,
          settings: {}
        }));
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-start-http/start') && options?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 503,
          json: () => Promise.resolve({ success: false, error: 'start unavailable' })
        });
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-start-http/jobs')) {
        return Promise.resolve(createResponse(true, { success: true, jobs: [] }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(async () => {
      await result.current.selectProject({ id: 'proj-start-http', name: 'HTTP Start' });
    });

    expect(errorSpy).toHaveBeenCalledWith('Failed to start project processes:', expect.any(Error));
    errorSpy.mockRestore();
  });

  test('refreshProcessStatus effect warns when process refresh fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/api/projects/proj-effect/processes')) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ success: false, error: 'status fail' })
        });
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      result.current.setCurrentProject({ id: 'proj-effect', name: 'Effect Project' });
    });

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith('Failed to refresh process status', expect.any(Error));
    });

    warnSpy.mockRestore();
  });

  test('refreshProcessStatus short-circuits when no project is selected and clears snapshots', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      __appStateTestHelpers.applyProcessSnapshot('proj-cached', {
        processes: { backend: { status: 'running' } }
      });
    });

    await waitFor(() => {
      expect(result.current.projectProcesses?.projectId).toBe('proj-cached');
    });

    const refreshed = await result.current.refreshProcessStatus();
    expect(refreshed).toBeNull();

    await waitFor(() => {
      expect(result.current.projectProcesses).toBeNull();
    });
  });

  test('refreshProcessStatus uses a default error message when backend omits details', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/api/projects/proj-status/processes')) {
        return Promise.resolve(createResponse(true, { success: false }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });
    await expect(result.current.refreshProcessStatus('proj-status')).rejects.toThrow('Failed to load process status');
  });

  test('refreshProcessStatus defaults to the current project id when no argument is provided', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/api/projects/proj-default-status/processes')) {
        return Promise.resolve(createResponse(true, {
          success: true,
          processes: { backend: { status: 'running', port: '7001' } }
        }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-default-status', name: 'Default Status Project' });
    });

    const snapshot = await result.current.refreshProcessStatus();
    expect(snapshot?.projectId).toBe('proj-default-status');

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/proj-default-status/processes');
  });

  test('closeProject surfaces stop failures when the backend payload cannot be parsed', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/api/projects/proj-stop/stop') && options?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 502,
          json: () => Promise.reject(new Error('bad json'))
        });
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-stop', name: 'Flaky Project' });
    });

    await act(async () => {
      await result.current.closeProject();
    });

    await waitFor(() => {
      expect(result.current.projectShutdownState.error).toBe('HTTP error! status: 502');
      expect(result.current.projectShutdownState.isStopping).toBe(false);
      expect(result.current.currentProject).toBeNull();
    });

    expect(errorSpy).toHaveBeenCalledWith('Failed to stop project processes:', expect.any(Error));
    errorSpy.mockRestore();
  });

  test('closeProject warns when backend is unreachable', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/api/projects/proj-offline/stop') && options?.method === 'POST') {
        return Promise.reject(new Error('Failed to fetch: offline'));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-offline', name: 'Offline Project' });
    });

    await act(async () => {
      await result.current.closeProject();
    });

    await waitFor(() => {
      expect(result.current.projectShutdownState.error).toBe('Failed to fetch: offline');
      expect(result.current.projectShutdownState.isStopping).toBe(false);
      expect(result.current.currentProject).toBeNull();
    });

    expect(warnSpy).toHaveBeenCalledWith(
      'Backend server not available - project closed but processes may still be running. Please ensure the backend server is running.'
    );
    warnSpy.mockRestore();
  });

  test('closeProject uses an empty projectName when the current project has no name', async () => {
    let resolveStop;

    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/api/projects/proj-noname/stop') && options?.method === 'POST') {
        return new Promise((resolve) => {
          resolveStop = () => resolve(createResponse(true, { success: true, message: 'stopped' }));
        });
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-noname' });
    });

    let closePromise;
    await act(async () => {
      closePromise = result.current.closeProject();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.projectShutdownState.projectId).toBe('proj-noname');
      expect(result.current.projectShutdownState.projectName).toBe('');
      expect(result.current.projectShutdownState.isStopping).toBe(true);
    });

    await act(async () => {
      if (resolveStop) {
        resolveStop();
      }
      await closePromise;
    });

    await waitFor(() => {
      expect(result.current.projectShutdownState).toEqual(__appStateTestHelpers.buildInitialShutdownState());
      expect(result.current.currentProject).toBeNull();
    });
  });

  test('closeProject surfaces backend errors when stop fails with an explicit message', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/api/projects/proj-stop-error/stop') && options?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ success: false, error: 'stop denied' })
        });
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-stop-error', name: 'Stop Error Project' });
    });

    await act(async () => {
      await result.current.closeProject();
    });

    await waitFor(() => {
      expect(result.current.projectShutdownState.error).toBe('stop denied');
      expect(result.current.projectShutdownState.isStopping).toBe(false);
      expect(result.current.currentProject).toBeNull();
    });

    expect(errorSpy).toHaveBeenCalledWith('Failed to stop project processes:', expect.any(Error));
    errorSpy.mockRestore();
  });

  test('closeProject logs a message and clears shutdown state on success', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/api/projects/proj-ok/stop') && options?.method === 'POST') {
        return Promise.resolve(createResponse(true, { success: true, message: 'stopped' }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-ok', name: 'Happy Project' });
    });

    await act(async () => {
      await result.current.closeProject();
    });

    await waitFor(() => {
      expect(result.current.currentProject).toBeNull();
      expect(result.current.projectShutdownState).toEqual(__appStateTestHelpers.buildInitialShutdownState());
    });

    expect(logSpy).toHaveBeenCalledWith('Project processes stopped:', 'stopped');
    logSpy.mockRestore();
  });

  test('closeProject uses a generic error when the thrown error has no message', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/api/projects/proj-empty/stop') && options?.method === 'POST') {
        return Promise.reject(new Error(''));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-empty', name: 'Empty Error' });
    });

    await act(async () => {
      await result.current.closeProject();
    });

    await waitFor(() => {
      expect(result.current.projectShutdownState.error).toBe('Failed to stop project processes');
      expect(result.current.projectShutdownState.isStopping).toBe(false);
      expect(result.current.currentProject).toBeNull();
    });

    expect(errorSpy).toHaveBeenCalledWith('Failed to stop project processes:', expect.any(Error));
    errorSpy.mockRestore();
  });

  test('closeProject resets shutdown state when no project is active', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(async () => {
      await result.current.closeProject();
    });

    expect(result.current.projectShutdownState).toEqual(__appStateTestHelpers.buildInitialShutdownState());
  });

  test('isProjectStopping helper reflects shutdown progress and defaults to global state', async () => {
    let resolveStop;
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/api/projects/proj-halting/stop') && options?.method === 'POST') {
        return new Promise((resolve) => {
          resolveStop = () => resolve(createResponse(true, { success: true, message: 'stopped' }));
        });
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-halting', name: 'Halting Project' });
    });

    let closePromise;
    await act(async () => {
      closePromise = result.current.closeProject();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(__appStateTestHelpers.isProjectStopping('proj-halting')).toBe(true);
      expect(__appStateTestHelpers.isProjectStopping()).toBe(true);
      expect(__appStateTestHelpers.isProjectStopping(null)).toBe(true);
    });

    await act(async () => {
      if (resolveStop) {
        resolveStop();
      }
      await closePromise;
    });

    await waitFor(() => {
      expect(__appStateTestHelpers.isProjectStopping('proj-halting')).toBe(false);
      expect(__appStateTestHelpers.isProjectStopping()).toBe(false);
      expect(__appStateTestHelpers.isProjectStopping(null)).toBe(false);
    });
  });

  test('restartProject requires an active project', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });
    await expect(result.current.restartProject()).rejects.toThrow('Select a project before restarting processes');
  });

  test('stopProjectProcess requires a valid project id', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });
    await expect(result.current.stopProjectProcess(null, 'frontend')).rejects.toThrow(
      'Select a project before stopping processes'
    );
  });

  test('stopProjectProcess requires a valid target', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });
    await expect(result.current.stopProjectProcess('proj-x', 'wat')).rejects.toThrow(
      'Select a valid process target before stopping'
    );
  });

  test('stopProjectProcess posts stop target and refreshes status', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/api/projects/proj-target/stop?target=frontend') && options?.method === 'POST') {
        return Promise.resolve(createResponse(true, { success: true, message: 'frontend stopped successfully' }));
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-target/processes')) {
        return Promise.resolve(createResponse(true, { success: true, projectId: 'proj-target', processes: {} }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(async () => {
      await result.current.stopProjectProcess('proj-target', 'frontend');
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/proj-target/stop?target=frontend', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/proj-target/processes');
  });

  test('stopProject requires an active project when called without an id', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });
    await expect(result.current.stopProject()).rejects.toThrow('Select a project before stopping processes');
  });

  test('stopProject falls back to currentProject id when passed null', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      result.current.setCurrentProject({ id: 'proj-null-stop', name: 'Null Stop' });
    });

    await waitFor(() => {
      expect(result.current.currentProject?.id).toBe('proj-null-stop');
    });

    await expect(result.current.stopProject(null)).rejects.toThrow('Select a project before stopping processes');
  });

  test('stopProject defaults to the current project id and surfaces its name while inflight', async () => {
    let resolveStop;

    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/api/projects/proj-default-stop/stop') && options?.method === 'POST') {
        return new Promise((resolve) => {
          resolveStop = () => resolve(createResponse(true, { success: true }));
        });
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-default-stop/processes')) {
        return Promise.resolve(createResponse(true, { success: true, projectId: 'proj-default-stop', processes: {} }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-default-stop', name: 'Default Stop Project' });
    });

    let stopPromise;
    await act(async () => {
      stopPromise = result.current.stopProject();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.projectShutdownState.projectId).toBe('proj-default-stop');
      expect(result.current.projectShutdownState.projectName).toBe('Default Stop Project');
      expect(result.current.projectShutdownState.isStopping).toBe(true);
    });

    await act(async () => {
      if (resolveStop) {
        resolveStop();
      }
      await stopPromise;
    });

    await waitFor(() => {
      expect(result.current.projectShutdownState).toEqual(__appStateTestHelpers.buildInitialShutdownState());
    });
  });

  test('stopProject posts stop and refreshes status', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/api/projects/proj-stop/stop') && options?.method === 'POST') {
        return Promise.resolve(createResponse(true, { success: true, message: 'stopped' }));
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-stop/processes')) {
        return Promise.resolve(createResponse(true, { success: true, projectId: 'proj-stop', processes: {} }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(async () => {
      await result.current.stopProject('proj-stop');
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/proj-stop/stop', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/proj-stop/processes');
    expect(logSpy).toHaveBeenCalledWith('Project processes stopped:', 'stopped');
  });

  test('stopProject ignores refresh errors and still resolves', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/api/projects/proj-refreshfail/stop') && options?.method === 'POST') {
        return Promise.resolve(createResponse(true, { success: true }));
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-refreshfail/processes')) {
        return Promise.reject(new Error('refresh failed'));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(async () => {
      await expect(result.current.stopProject('proj-refreshfail')).resolves.toBe(true);
    });
  });

  test('stopProject warns and rethrows on fetch connectivity errors', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/api/projects/proj-fetchfail/stop') && options?.method === 'POST') {
        return Promise.reject(new Error('fetch failed'));
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-fetchfail/processes')) {
        return Promise.resolve(createResponse(true, { success: true, projectId: 'proj-fetchfail', processes: {} }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(async () => {
      await expect(result.current.stopProject('proj-fetchfail')).rejects.toThrow('fetch failed');
    });

    await waitFor(() => {
      expect(result.current.projectShutdownState.isStopping).toBe(false);
      expect(result.current.projectShutdownState.error).toBe('fetch failed');
    });
    expect(warnSpy).toHaveBeenCalled();
  });

  test('stopProject surfaces server-provided error messages when stop fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/api/projects/proj-stopdenied/stop') && options?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 403,
          json: () => Promise.resolve({ success: false, error: 'stop denied' })
        });
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-stopdenied/processes')) {
        return Promise.resolve(createResponse(true, { success: true, projectId: 'proj-stopdenied', processes: {} }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(async () => {
      await expect(result.current.stopProject('proj-stopdenied')).rejects.toThrow('stop denied');
    });

    await waitFor(() => {
      expect(result.current.projectShutdownState.isStopping).toBe(false);
      expect(result.current.projectShutdownState.error).toBe('stop denied');
    });

    expect(errorSpy).toHaveBeenCalledWith('Failed to stop project processes:', expect.any(Error));
    errorSpy.mockRestore();
  });

  test('stopProject uses a generic shutdown error when the thrown error has no message', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/api/projects/proj-empty-msg/stop') && options?.method === 'POST') {
        return Promise.reject(new Error(''));
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-empty-msg/processes')) {
        return Promise.resolve(createResponse(true, { success: true, projectId: 'proj-empty-msg', processes: {} }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(async () => {
      await expect(result.current.stopProject('proj-empty-msg')).rejects.toThrow();
    });

    await waitFor(() => {
      expect(result.current.projectShutdownState.isStopping).toBe(false);
      expect(result.current.projectShutdownState.error).toBe('Failed to stop project processes');
    });

    expect(errorSpy).toHaveBeenCalledWith('Failed to stop project processes:', expect.any(Error));
    errorSpy.mockRestore();
  });

  test('stopProject logs and rethrows non-fetch errors (including HTTP fallback errors)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/api/projects/proj-stopfail/stop') && options?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.reject(new Error('bad json'))
        });
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-stopfail/processes')) {
        return Promise.resolve(createResponse(true, { success: true, projectId: 'proj-stopfail', processes: {} }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(async () => {
      await expect(result.current.stopProject('proj-stopfail')).rejects.toThrow('HTTP error! status: 500');
    });

    await waitFor(() => {
      expect(result.current.projectShutdownState.isStopping).toBe(false);
      expect(result.current.projectShutdownState.error).toBe('HTTP error! status: 500');
    });
    expect(errorSpy).toHaveBeenCalled();
  });

  test('stopProjectProcess returns default success when stop response has no JSON and refresh fails', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/api/projects/proj-nojson/stop?target=backend') && options?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.reject(new Error('no json'))
        });
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-nojson/processes')) {
        return Promise.reject(new Error('refresh failed'));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    let stopResult;
    await act(async () => {
      stopResult = await result.current.stopProjectProcess('proj-nojson', 'backend');
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/proj-nojson/stop?target=backend',
      expect.objectContaining({ method: 'POST' })
    );
    expect(stopResult).toEqual({ success: true });
  });

  test('stopProjectProcess throws an HTTP fallback error when the stop request fails and lacks JSON', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/api/projects/proj-stopfail/stop?target=frontend') && options?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.reject(new Error('bad json'))
        });
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await expect(result.current.stopProjectProcess('proj-stopfail', 'frontend')).rejects.toThrow(
      'HTTP error! status: 500'
    );
  });

  test('stopProjectProcess surfaces server-provided error messages when stop fails', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/api/projects/proj-process-denied/stop?target=backend') && options?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 403,
          json: () => Promise.resolve({ success: false, error: 'backend stop denied' })
        });
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await expect(result.current.stopProjectProcess('proj-process-denied', 'backend')).rejects.toThrow('backend stop denied');
  });

  test('updatePortSettings uses a generic restart warning when the restart error lacks a message', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/settings/ports' && options?.method === 'PUT') {
        return Promise.resolve(createResponse(true, {
          success: true,
          settings: {
            frontendPortBase: 6300,
            backendPortBase: 6700
          }
        }));
      }
      if (typeof url === 'string' && url.includes('/api/projects/proj-generic/restart')) {
        return Promise.reject(new Error(''));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-generic', name: 'Generic Project' });
    });

    await expect(result.current.updatePortSettings({ frontendPortBase: 6300 })).rejects.toThrow(
      'Port settings saved but failed to restart project'
    );
  });

  test('createProject falls back to a local scaffold when backend creation fails', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/projects' && (!options || !options.method || options.method === 'GET')) {
        return Promise.resolve(createResponse(true, { success: true, projects: [] }));
      }
      if (url === '/api/projects' && options?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ error: 'backend down' })
        });
      }
      if (/\/api\/projects\/1700000000000\/git-settings$/.test(url)) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            inheritsFromGlobal: true,
            projectSettings: null,
            effectiveSettings: {},
            settings: {}
          })
        });
      }
      if (/\/api\/projects\/1700000000000\/start$/.test(url)) {
        return Promise.resolve(createResponse(true, { success: true, message: 'started', processes: null }));
      }
      if (/\/api\/projects\/1700000000000\/processes$/.test(url)) {
        return Promise.resolve(createResponse(true, { success: true, processes: {} }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    let createdProject;
    await act(async () => {
      createdProject = await result.current.createProject({ name: 'Offline Project' });
    });

    expect(createdProject.id).toBe('1700000000000');
    await waitFor(() => {
      expect(result.current.projects.some((proj) => proj.id === '1700000000000')).toBe(true);
    });

    errorSpy.mockRestore();
    nowSpy.mockRestore();
  });

  test('createProject stores server-created projects and selects them', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/projects' && options?.method === 'POST') {
        return Promise.resolve(createResponse(true, {
          success: true,
          project: { id: 'proj-server', name: 'Server Project' }
        }));
      }
      if (typeof url === 'string' && url.includes('/proj-server/git-settings')) {
        return Promise.resolve(createResponse(true, {
          success: true,
          inheritsFromGlobal: true,
          projectSettings: null,
          settings: {}
        }));
      }
      if (typeof url === 'string' && url.includes('/proj-server/start') && options?.method === 'POST') {
        return Promise.resolve(createResponse(true, {
          success: true,
          message: 'started',
          processes: {
            backend: { status: 'running', port: 7777 }
          }
        }));
      }
      if (typeof url === 'string' && url.includes('/proj-server/processes')) {
        return Promise.resolve(createResponse(true, {
          success: true,
          processes: {
            backend: { status: 'running', port: 7777 }
          }
        }));
      }
      if (typeof url === 'string' && url.includes('/proj-server/jobs')) {
        return Promise.resolve(createResponse(true, { success: true, jobs: [] }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    let created;
    await act(async () => {
      created = await result.current.createProject({ name: 'Server Project' });
    });

    expect(created.id).toBe('proj-server');

    await waitFor(() => {
      expect(result.current.currentProject?.id).toBe('proj-server');
      expect(result.current.projectProcesses?.projectId).toBe('proj-server');
    });
  });
  test('clearProjectGitSettings updates global settings even when no overrides exist', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/git-settings') && options?.method === 'DELETE') {
        return Promise.resolve(createResponse(true, {
          success: true,
          settings: {},
          globalSettings: { workflow: 'hybrid', provider: 'gitlab' }
        }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(async () => {
      const response = await result.current.clearProjectGitSettings('proj-global');
      expect(response).toBeDefined();
    });

    await waitFor(() => {
      expect(result.current.getProjectGitSettingsSnapshot('proj-global').projectSettings).toBeNull();
      expect(result.current.gitSettings.workflow).toBe('hybrid');
      expect(result.current.gitSettings.provider).toBe('gitlab');
    });
  });

  test('clearProjectGitSettings removes project overrides and applies server globals', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/git-settings') && options?.method === 'PUT') {
        return Promise.resolve(createResponse(true, {
          success: true,
          projectSettings: { workflow: 'remote' }
        }));
      }
      if (typeof url === 'string' && url.includes('/git-settings') && options?.method === 'DELETE') {
        return Promise.resolve(createResponse(true, {
          success: true,
          settings: {},
          globalSettings: { workflow: 'local', provider: 'azure' }
        }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(async () => {
      await result.current.updateProjectGitSettings('proj-git', { workflow: 'remote' });
    });

    await waitFor(() => {
      expect(result.current.getProjectGitSettingsSnapshot('proj-git').projectSettings).not.toBeNull();
    });

    await act(async () => {
      const response = await result.current.clearProjectGitSettings('proj-git');
      expect(response).toBeDefined();
    });

    await waitFor(() => {
      expect(result.current.getProjectGitSettingsSnapshot('proj-git').projectSettings).toBeNull();
      expect(result.current.gitSettings.provider).toBe('azure');
    });
  });

  test('stageFileChange short-circuits when project id or file path missing', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });
    fetchMock.mockClear();

    await act(async () => {
      expect(await result.current.stageFileChange(null, 'src/skip.js')).toBeNull();
      expect(await result.current.stageFileChange('proj-guard', '')).toBeNull();
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('stageFileChange falls back when API returns success=false payloads', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/branches/stage') && options?.method === 'POST') {
        return Promise.resolve(createResponse(true, { success: false, error: 'no snapshot' }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(async () => {
      const response = await result.current.stageFileChange('proj-degraded', 'src/broken.js', 'editor');
      expect(response).toBeNull();
    });

    await waitFor(() => {
      const stagedFiles = result.current.workspaceChanges['proj-degraded']?.stagedFiles || [];
      expect(stagedFiles.at(-1)?.path).toBe('src/broken.js');
    });
  });

  test('stageFileChange uses a default error message when backend omits details', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/branches/stage') && options?.method === 'POST') {
        return Promise.resolve(createResponse(true, { success: false }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(async () => {
      const response = await result.current.stageFileChange('proj-stage-default-error', 'src/missing-error.js', 'editor');
      expect(response).toBeNull();
    });

    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to sync staged change with backend',
      expect.objectContaining({ message: 'Failed to stage file change' })
    );

    warnSpy.mockRestore();
  });

  test('stageFileChange applies server overview when the request succeeds', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/branches/stage') && options?.method === 'POST') {
        return Promise.resolve(createResponse(true, {
          success: true,
          overview: {
            workingBranches: [
              {
                name: 'feature/success',
                status: 'active',
                stagedFiles: [{ path: 'src/success.js', timestamp: 'now' }],
                lastTestStatus: 'passed'
              }
            ]
          }
        }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    let response;
    await act(async () => {
      response = await result.current.stageFileChange('proj-stage', 'src/success.js', 'editor');
    });

    expect(response.success).toBe(true);

    await waitFor(() => {
      expect(result.current.workspaceChanges['proj-stage'].stagedFiles).toHaveLength(1);
      expect(result.current.workingBranches['proj-stage'].name).toBe('feature/success');
    });
  });

  test('stageFileChange fallback replaces duplicate entries with fresh metadata', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/branches/stage') && options?.method === 'POST') {
        return Promise.reject(new Error('backend down'));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      __appStateTestHelpers.applyBranchOverview('proj-local', {
        workingBranches: [
          {
            name: 'feature/local',
            status: 'active',
            stagedFiles: [{ path: 'src/duplicate.js', source: 'editor', timestamp: 'earlier' }]
          }
        ]
      });
    });

    await waitFor(() => {
      expect(result.current.workspaceChanges['proj-local'].stagedFiles).toHaveLength(1);
    });

    await act(async () => {
      await result.current.stageFileChange('proj-local', 'src/duplicate.js', 'ai');
    });

    const staged = result.current.workspaceChanges['proj-local'].stagedFiles;
    expect(staged).toHaveLength(1);
    expect(staged[0].source).toBe('ai');
    expect(staged[0].timestamp).toSatisfy((value) => {
      if (typeof value === 'string') return value.length > 0;
      if (typeof value === 'number') return Number.isFinite(value);
      return false;
    });
  });

  test('clearStagedChanges removes local entries after a successful DELETE', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/branches/stage') && options?.method === 'DELETE') {
        return Promise.resolve(createResponse(true, {
          success: true,
          overview: {
            workingBranches: [
              {
                name: 'feature/login',
                status: 'ready-for-merge',
                stagedFiles: [],
                lastTestStatus: 'passed'
              }
            ]
          }
        }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.syncBranchOverview('proj-1', {
        workingBranches: [
          {
            name: 'feature/login',
            status: 'ready-for-merge',
            stagedFiles: [{ path: 'src/App.jsx', timestamp: 'now' }],
            lastTestStatus: 'passed'
          }
        ]
      });
    });

    await act(async () => {
      const response = await result.current.clearStagedChanges('proj-1', { filePath: 'src/App.jsx' });
      expect(response).toBeDefined();
    });

    const deleteCall = fetchMock.mock.calls.find(([, config]) => config?.method === 'DELETE');
    expect(JSON.parse(deleteCall[1].body)).toEqual({ filePath: 'src/App.jsx' });

    await waitFor(() => {
      expect(result.current.workspaceChanges['proj-1'].stagedFiles).toEqual([]);
    });

    expect(result.current.projectFilesRevision['proj-1']).toBe(1);
  });

  test('clearStagedChanges prunes a single staged file when DELETE succeeds', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/branches/stage') && options?.method === 'DELETE') {
        return Promise.resolve(createResponse(true, {
          success: true,
          overview: {
            workingBranches: [
              {
                name: 'feature/cleanup',
                status: 'active',
                stagedFiles: [{ path: 'src/second.js', timestamp: 'later' }]
              }
            ]
          }
        }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      result.current.syncBranchOverview('proj-clean', {
        workingBranches: [
          {
            name: 'feature/cleanup',
            status: 'active',
            stagedFiles: [
              { path: 'src/first.js', timestamp: 'earlier' },
              { path: 'src/second.js', timestamp: 'later' }
            ]
          }
        ]
      });
    });

    await act(async () => {
      await result.current.clearStagedChanges('proj-clean', { filePath: 'src/first.js' });
    });

    await waitFor(() => {
      expect(result.current.workspaceChanges['proj-clean'].stagedFiles.map((file) => file.path)).toEqual(['src/second.js']);
      expect(result.current.workingBranches['proj-clean'].stagedFiles).toHaveLength(1);
    });
  });

  test('clearStagedChanges optimistically prunes local staged files before DELETE resolves', async () => {
    let resolveDelete;
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/branches/stage') && options?.method === 'DELETE') {
        return new Promise((resolve) => {
          resolveDelete = resolve;
        });
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      result.current.syncBranchOverview('proj-optimistic', {
        workingBranches: [
          {
            name: 'feature/optimistic',
            status: 'active',
            stagedFiles: [
              { path: 'src/first.js', timestamp: 'earlier' },
              { path: 'src/second.js', timestamp: 'later' }
            ]
          }
        ]
      });
    });

    await waitFor(() => {
      expect(result.current.workspaceChanges['proj-optimistic'].stagedFiles).toHaveLength(2);
    });

    let pendingClear;
    await act(async () => {
      pendingClear = result.current.clearStagedChanges('proj-optimistic', {
        branchName: 'feature/optimistic',
        filePath: 'src/first.js'
      });
    });

    await waitFor(() => {
      const stagedPaths = result.current.workspaceChanges['proj-optimistic'].stagedFiles.map((file) => file.path);
      expect(stagedPaths).toEqual(['src/second.js']);
    });

    resolveDelete(createResponse(true, {
      success: true,
      overview: {
        workingBranches: [
          {
            name: 'feature/optimistic',
            status: 'active',
            stagedFiles: [{ path: 'src/second.js', timestamp: 'later' }]
          }
        ]
      }
    }));

    await act(async () => {
      await pendingClear;
    });
  });

  test('clearStagedChanges fallback clears branch commits when DELETE rejects', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/branches/stage') && options?.method === 'DELETE') {
        return Promise.reject(new Error('disconnect'));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      result.current.syncBranchOverview('proj-bulk', {
        workingBranches: [
          {
            name: 'feature/bulk',
            status: 'active',
            merged: false,
            stagedFiles: [{ path: 'src/one.js' }, { path: 'src/two.js' }]
          }
        ]
      });
    });

    await act(async () => {
      const response = await result.current.clearStagedChanges('proj-bulk');
      expect(response).toBeNull();
    });

    await waitFor(() => {
      expect(result.current.workspaceChanges['proj-bulk'].stagedFiles).toEqual([]);
      expect(result.current.workingBranches['proj-bulk'].commits).toBe(0);
    });
  });

  test('clearStagedChanges fallback removes targeted files when DELETE rejects with a filter', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/branches/stage') && options?.method === 'DELETE') {
        return Promise.reject(new Error('flaky network'));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      result.current.syncBranchOverview('proj-target', {
        workingBranches: [
          {
            name: 'feature/target',
            status: 'active',
            stagedFiles: [
              { path: 'src/remove.js', timestamp: 'now' },
              { path: 'src/keep.js', timestamp: 'later' }
            ]
          }
        ]
      });
    });

    await act(async () => {
      const response = await result.current.clearStagedChanges('proj-target', { filePath: 'src/remove.js' });
      expect(response).toBeNull();
    });

    await waitFor(() => {
      const stagedPaths = result.current.workspaceChanges['proj-target'].stagedFiles.map((file) => file.path);
      expect(stagedPaths).toEqual(['src/keep.js']);
      const branchPaths = result.current.workingBranches['proj-target'].stagedFiles.map((file) => file.path);
      expect(branchPaths).toEqual(['src/keep.js']);
      expect(result.current.workingBranches['proj-target'].commits).toBe(1);
    });
  });

  test('applyBranchOverview removes stale branch snapshots when overview is empty', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.syncBranchOverview('proj-prune', {
        workingBranches: [
          {
            name: 'feature/login',
            status: 'active',
            stagedFiles: [{ path: 'src/file.js', timestamp: 'now' }]
          }
        ]
      });
    });

    await waitFor(() => {
      expect(result.current.workingBranches['proj-prune']).toBeDefined();
    });

    await act(() => {
      result.current.syncBranchOverview('proj-prune', { workingBranches: [] });
    });

    await waitFor(() => {
      expect(result.current.workingBranches['proj-prune']).toBeUndefined();
      expect(result.current.workspaceChanges['proj-prune']).toEqual({ stagedFiles: [] });
    });
  });

  test('registerBranchActivity ignores falsy project identifiers', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    await waitFor(() => {
      expect(typeof __appStateTestHelpers.registerBranchActivity).toBe('function');
    });

    act(() => {
      __appStateTestHelpers.registerBranchActivity(null, () => ({ commits: 42 }));
    });

    expect(result.current.workingBranches).toEqual({});
  });

  test('registerBranchActivity seeds a default branch when none exists', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T12:00:00Z'));

    try {
      const { result } = renderHook(() => useAppState(), { wrapper });
      expect(typeof __appStateTestHelpers.registerBranchActivity).toBe('function');

      act(() => {
        __appStateTestHelpers.registerBranchActivity('proj-auto', (existing) => ({
          commits: (existing.commits || 0) + 1,
          lastActivity: 'now'
        }));
      });

      const branch = result.current.workingBranches['proj-auto'];
      expect(branch).toBeDefined();
      expect(branch.name).toMatch(/^feature\/autosave-2024-01-01T12-00-00-000Z/);
      expect(branch.createdAt).toBe('2024-01-01T12:00:00.000Z');
      expect(branch.commits).toBe(1);
      expect(branch.merged).toBe(false);
      expect(branch.lastActivity).toBe('now');
    } finally {
      vi.useRealTimers();
    }
  });

  test('applyBranchOverview helper persists working branch snapshots with staged files', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      __appStateTestHelpers.applyBranchOverview('proj-overview', {
        current: 'feature/docs',
        workingBranches: [
          {
            name: 'feature/docs',
            status: 'active',
            stagedFiles: [{ path: 'docs/README.md', source: 'editor', timestamp: 'now' }],
            lastTestStatus: 'passed',
            testsRequired: true
          }
        ]
      });
    });

    await waitFor(() => {
      const branch = result.current.workingBranches['proj-overview'];
      expect(branch.name).toBe('feature/docs');
      expect(branch.stagedFiles).toHaveLength(1);
      expect(branch.testsRequired).toBe(true);
      expect(result.current.workspaceChanges['proj-overview'].stagedFiles).toHaveLength(1);
    });
  });

  test('applyBranchOverview persists coverage/test metadata when present', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      __appStateTestHelpers.applyBranchOverview('proj-overview-metadata', {
        current: 'feature/docs',
        workingBranches: [
          {
            name: 'feature/docs',
            status: 'active',
            stagedFiles: [],
            lastTestStatus: 'passed',
            testsRequired: true,
            mergeBlockedReason: 'Coverage below threshold',
            lastTestCompletedAt: '2025-01-01T10:00:00.000Z',
            lastTestSummary: {
              coverage: {
                totals: { lines: { pct: 99 } },
                thresholds: { lines: 90 }
              }
            }
          }
        ]
      });
    });

    await waitFor(() => {
      const branch = result.current.workingBranches['proj-overview-metadata'];
      expect(branch).toBeDefined();
      expect(branch.lastTestCompletedAt).toBe('2025-01-01T10:00:00.000Z');
      expect(branch.mergeBlockedReason).toBe('Coverage below threshold');
      expect(branch.lastTestSummary).toEqual({
        coverage: {
          totals: { lines: { pct: 99 } },
          thresholds: { lines: 90 }
        }
      });
    });
  });

  test('applyBranchOverview prefers the current working branch when multiple branches exist', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      __appStateTestHelpers.applyBranchOverview('proj-multi', {
        current: 'feature/new',
        workingBranches: [
          {
            name: 'feature/old',
            status: 'active',
            stagedFiles: [{ path: 'frontend/src/Old.css', source: 'editor', timestamp: 'then' }],
            lastTestStatus: null,
            testsRequired: true
          },
          {
            name: 'feature/new',
            status: 'active',
            stagedFiles: [{ path: 'frontend/src/App.css', source: 'editor', timestamp: 'now' }],
            lastTestStatus: null,
            testsRequired: true
          }
        ]
      });
    });

    await waitFor(() => {
      const branch = result.current.workingBranches['proj-multi'];
      expect(branch.name).toBe('feature/new');
      expect(branch.stagedFiles).toEqual([
        { path: 'frontend/src/App.css', source: 'editor', timestamp: 'now' }
      ]);
      expect(result.current.workspaceChanges['proj-multi'].stagedFiles).toEqual([
        { path: 'frontend/src/App.css', source: 'editor', timestamp: 'now' }
      ]);
    });
  });

  test('applyBranchOverview defaults stagedFiles to an empty array when omitted', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      result.current.syncBranchOverview('proj-no-stagedFiles', {
        workingBranches: [
          {
            name: 'feature/empty',
            status: 'active'
          }
        ]
      });
    });

    await waitFor(() => {
      const branch = result.current.workingBranches['proj-no-stagedFiles'];
      expect(branch).toBeDefined();
      expect(branch.stagedFiles).toEqual([]);
      expect(branch.commits).toBe(0);
      expect(result.current.workspaceChanges['proj-no-stagedFiles'].stagedFiles).toEqual([]);
    });
  });

  test('applyBranchOverview falls back to the first working branch when current is main', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      __appStateTestHelpers.applyBranchOverview('proj-main-fallback', {
        current: 'main',
        workingBranches: [
          {
            name: 'feature/fallback',
            status: 'active',
            stagedFiles: [{ path: 'frontend/src/Fallback.css', source: 'editor', timestamp: 'now' }],
            lastTestStatus: null,
            testsRequired: false
          }
        ]
      });
    });

    await waitFor(() => {
      const branch = result.current.workingBranches['proj-main-fallback'];
      expect(branch).toBeDefined();
      expect(branch.name).toBe('feature/fallback');
      expect(branch.stagedFiles).toEqual([
        { path: 'frontend/src/Fallback.css', source: 'editor', timestamp: 'now' }
      ]);
      expect(result.current.workspaceChanges['proj-main-fallback'].stagedFiles).toEqual([
        { path: 'frontend/src/Fallback.css', source: 'editor', timestamp: 'now' }
      ]);
    });
  });

  test('applyBranchOverview tolerates non-array workingBranches and missing current match', () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      result.current.syncBranchOverview('proj-non-array-workingBranches', {
        current: 'feature/missing',
        workingBranches: null
      });
    });

    expect(result.current.workingBranches['proj-non-array-workingBranches']).toBeUndefined();
  });

  test('syncBranchOverview ignores updates without a project id', () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      result.current.syncBranchOverview(null, {
        workingBranches: [
          {
            name: 'feature/null',
            status: 'active',
            stagedFiles: [{ path: 'src/app.js', timestamp: 'now' }]
          }
        ]
      });
    });

    expect(result.current.workingBranches).toEqual({});
    expect(result.current.workspaceChanges).toEqual({});
  });

  test('clearStagedChanges passes branch-only filters and skips missing workspaces', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/branches/stage') && options?.method === 'DELETE') {
        return Promise.resolve(createResponse(true, {
          success: true,
          overview: {
            workingBranches: []
          }
        }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(async () => {
      const response = await result.current.clearStagedChanges('proj-branch', { branchName: 'feature/login' });
      expect(response).toBeDefined();
    });

    const deleteCall = fetchMock.mock.calls.find(([, config]) => config?.method === 'DELETE');
    expect(JSON.parse(deleteCall[1].body)).toEqual({ branchName: 'feature/login' });
    expect(result.current.workspaceChanges['proj-branch']).toBeUndefined();
  });

  test('clearStagedChanges includes both branchName and filePath when provided', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/branches/stage') && options?.method === 'DELETE') {
        return Promise.resolve(createResponse(true, {
          success: true,
          overview: {
            workingBranches: []
          }
        }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(async () => {
      const response = await result.current.clearStagedChanges('proj-both', {
        branchName: 'feature/both',
        filePath: 'src/both.js'
      });
      expect(response).toBeDefined();
    });

    const deleteCall = fetchMock.mock.calls.find(([, config]) => config?.method === 'DELETE');
    expect(deleteCall[1].headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(deleteCall[1].body)).toEqual({ branchName: 'feature/both', filePath: 'src/both.js' });
  });

  test('clearStagedChanges clears entire staged state when no file filter is provided', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/branches/stage') && options?.method === 'DELETE') {
        return Promise.resolve(createResponse(true, {
          success: true,
          overview: {
            workingBranches: [
              {
                name: 'feature/login',
                status: 'active',
                stagedFiles: [],
                lastTestStatus: 'passed'
              }
            ]
          }
        }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.syncBranchOverview('proj-all', {
        workingBranches: [
          {
            name: 'feature/login',
            status: 'active',
            stagedFiles: [{ path: 'src/App.jsx', timestamp: 'now' }],
            lastTestStatus: 'passed'
          }
        ]
      });
    });

    await act(async () => {
      const response = await result.current.clearStagedChanges('proj-all');
      expect(response).toBeDefined();
    });

    const deleteCall = fetchMock.mock.calls.find(([, config]) => config?.method === 'DELETE');
    expect(deleteCall[1].body).toBeUndefined();

    await waitFor(() => {
      expect(result.current.workspaceChanges['proj-all'].stagedFiles).toEqual([]);
    });
  });

  test('clearStagedChanges falls back to local cleanup when DELETE fails', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/branches/stage') && options?.method === 'DELETE') {
        return Promise.reject(new Error('disconnect'));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.syncBranchOverview('proj-2', {
        workingBranches: [
          {
            name: 'feature/login',
            status: 'active',
            stagedFiles: [{ path: 'src/App.jsx', timestamp: 'now' }],
            lastTestStatus: 'passed'
          }
        ]
      });
    });

    await act(async () => {
      const response = await result.current.clearStagedChanges('proj-2', { filePath: 'src/App.jsx' });
      expect(response).toBeNull();
    });

    await waitFor(() => {
      expect(result.current.workspaceChanges['proj-2'].stagedFiles).toEqual([]);
      expect(result.current.workingBranches['proj-2'].commits).toBe(0);
    });
  });

  test('clearStagedChanges fallback without file filter clears all tracked changes', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/branches/stage') && options?.method === 'DELETE') {
        return Promise.reject(new Error('disconnect'));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.syncBranchOverview('proj-bulk', {
        workingBranches: [
          {
            name: 'feature/login',
            status: 'active',
            stagedFiles: [{ path: 'src/one.js' }, { path: 'src/two.js' }],
            lastTestStatus: 'passed'
          }
        ]
      });
    });

    await act(async () => {
      const response = await result.current.clearStagedChanges('proj-bulk');
      expect(response).toBeNull();
    });

    await waitFor(() => {
      expect(result.current.workspaceChanges['proj-bulk'].stagedFiles).toEqual([]);
      expect(result.current.workingBranches['proj-bulk'].stagedFiles).toEqual([]);
      expect(result.current.workingBranches['proj-bulk'].commits).toBe(0);
    });
  });

  test('clearStagedChanges short-circuits when no project id is provided', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });
    fetchMock.mockClear();

    await act(async () => {
      await result.current.clearStagedChanges(null);
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('clearStagedChanges surfaces HTTP errors when DELETE responses are not ok', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/branches/stage') && options?.method === 'DELETE') {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ success: false, error: 'server unavailable' })
        });
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      result.current.syncBranchOverview('proj-http', {
        workingBranches: [
          {
            name: 'feature/http',
            status: 'active',
            stagedFiles: [{ path: 'src/error.js', timestamp: 'now' }]
          }
        ]
      });
    });

    await act(async () => {
      const response = await result.current.clearStagedChanges('proj-http', { filePath: 'src/error.js' });
      expect(response).toBeNull();
    });

    await waitFor(() => {
      expect(result.current.workspaceChanges['proj-http'].stagedFiles).toEqual([]);
    });

    expect(warnSpy).toHaveBeenCalledWith('Falling back to clearing staged files locally', expect.any(Error));
    const errorArg = warnSpy.mock.calls[warnSpy.mock.calls.length - 1][1];
    expect(errorArg.message).toBe('server unavailable');

    warnSpy.mockRestore();
  });

  test('clearStagedChanges handles success=false responses by relying on local cleanup', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/branches/stage') && options?.method === 'DELETE') {
        return Promise.resolve(createResponse(true, {
          success: false,
          error: 'branch snapshot unavailable'
        }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(async () => {
      const response = await result.current.clearStagedChanges('proj-degraded');
      expect(response).toBeNull();
    });

    expect(result.current.workspaceChanges['proj-degraded']).toBeUndefined();
    expect(result.current.workingBranches['proj-degraded']).toBeUndefined();

    warnSpy.mockRestore();
  });

  test('clearStagedChanges uses a default error message when backend omits details', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/branches/stage') && options?.method === 'DELETE') {
        return Promise.resolve(createResponse(true, { success: false }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(async () => {
      const response = await result.current.clearStagedChanges('proj-default-stage');
      expect(response).toBeNull();
    });

    expect(warnSpy).toHaveBeenCalledWith('Falling back to clearing staged files locally', expect.any(Error));
    const errorArg = warnSpy.mock.calls[warnSpy.mock.calls.length - 1][1];
    expect(errorArg.message).toBe('Failed to clear staged changes');

    warnSpy.mockRestore();
  });

  test('clearStagedChanges cleans up even when overview stagedFiles is not an array', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/branches/stage') && options?.method === 'DELETE') {
        return Promise.resolve(createResponse(true, {
          success: true,
          overview: {
            workingBranches: [
              {
                name: 'feature/weird',
                status: 'active',
                stagedFiles: 'not-an-array'
              }
            ]
          }
        }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(async () => {
      const response = await result.current.clearStagedChanges('proj-weird', { filePath: 'src/remove.js' });
      expect(response?.success).toBe(true);
    });

    await waitFor(() => {
      expect(result.current.workspaceChanges['proj-weird'].stagedFiles).toEqual([]);
    });
  });

  test('clearStagedChanges fallback handles malformed stagedFiles state in storage', async () => {
    localStorage.setItem(
      'workspaceChanges',
      JSON.stringify({
        'proj-local-malformed': {
          stagedFiles: 'not-an-array'
        }
      })
    );
    localStorage.setItem(
      'workingBranches',
      JSON.stringify({
        'proj-local-malformed': {
          name: 'feature/local',
          status: 'active',
          merged: true,
          commits: 2,
          stagedFiles: 'also-not-an-array'
        }
      })
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/branches/stage') && options?.method === 'DELETE') {
        return Promise.reject(new Error('network down'));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(async () => {
      const response = await result.current.clearStagedChanges('proj-local-malformed', { filePath: 'src/remove.js' });
      expect(response).toBeNull();
    });

    await waitFor(() => {
      expect(result.current.workspaceChanges['proj-local-malformed'].stagedFiles).toEqual([]);
      expect(result.current.workingBranches['proj-local-malformed'].stagedFiles).toEqual([]);
      expect(result.current.workingBranches['proj-local-malformed'].commits).toBe(0);
      expect(result.current.workingBranches['proj-local-malformed'].merged).toBe(true);
    });

    expect(warnSpy).toHaveBeenCalledWith('Falling back to clearing staged files locally', expect.any(Error));
    warnSpy.mockRestore();
  });

  test('hasBranchNotification reflects staged work for the active project', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-99', name: 'Notifications Demo' });
    });

    await waitFor(() => {
      expect(result.current.currentProject?.id).toBe('proj-99');
    });

    await act(() => {
      result.current.syncBranchOverview('proj-99', {
        workingBranches: [
          {
            name: 'feature/login',
            status: 'active',
            merged: false,
            stagedFiles: [{ path: 'src/App.jsx', source: 'editor', timestamp: 'now' }],
            lastTestStatus: 'passed'
          }
        ]
      });
    });

    await waitFor(() => {
      expect(result.current.hasBranchNotification).toBe(true);
    });

    await act(() => {
      result.current.syncBranchOverview('proj-99', {
        workingBranches: [
          {
            name: 'feature/login',
            status: 'merged',
            stagedFiles: []
          }
        ]
      });
    });

    await waitFor(() => {
      expect(result.current.hasBranchNotification).toBe(false);
    });
  });

  test('hasBranchNotification falls back to commit counts when staged files missing', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (typeof url === 'string' && url.includes('/branches/stage') && options?.method === 'POST') {
        return Promise.reject(new Error('backend unavailable'));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-commit', name: 'Commit Only' });
    });

    await waitFor(() => {
      expect(result.current.currentProject?.id).toBe('proj-commit');
    });

    await act(async () => {
      await result.current.stageFileChange('proj-commit', 'src/fallback.js', 'editor');
    });

    await waitFor(() => {
      expect(result.current.workingBranches['proj-commit']?.stagedFiles).toBeUndefined();
      expect(result.current.workingBranches['proj-commit']?.commits).toBeGreaterThan(0);
      expect(result.current.hasBranchNotification).toBe(true);
    });
  });

  test('setFileExplorerState merges updates for the active project', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-files', name: 'File Explorer' });
    });

    act(() => {
      result.current.setFileExplorerState(undefined, { expandedNodes: ['src'] });
    });

    await waitFor(() => {
      expect(result.current.getFileExplorerState('proj-files')).toMatchObject({ expandedNodes: ['src'] });
    });

    act(() => {
      result.current.setFileExplorerState('proj-files', { sidebarWidth: 320 });
    });

    await waitFor(() => {
      expect(result.current.getFileExplorerState('proj-files')).toMatchObject({
        expandedNodes: ['src'],
        sidebarWidth: 320
      });
    });

    act(() => {
      result.current.setFileExplorerState(null, { hidden: true });
    });

    expect(result.current.getFileExplorerState()).toMatchObject({
      expandedNodes: ['src'],
      sidebarWidth: 320
    });
  });

  test('getFileExplorerState returns null when no project is active', () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    expect(result.current.getFileExplorerState()).toBeNull();

    act(() => {
      result.current.setCurrentProject({ id: 'proj-files', name: 'File Explorer' });
    });

    expect(result.current.getFileExplorerState(null)).toBeNull();
    expect(result.current.getFileExplorerState('proj-missing')).toBeNull();
  });

  test('updateAssistantPanelState clamps width and sanitizes position values', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      result.current.updateAssistantPanelState({ width: 100, position: 'right' });
    });

    await waitFor(() => {
      expect(result.current.assistantPanelState.position).toBe('right');
      expect(result.current.assistantPanelState.width).toBe(240);
    });

    act(() => {
      result.current.updateAssistantPanelState({ width: 99999, position: 'upward' });
    });

    await waitFor(() => {
      expect(result.current.assistantPanelState.position).toBe('right');
      expect(result.current.assistantPanelState.width).toBe(
        __appStateTestHelpers.getMaxAssistantPanelWidth()
      );
    });

    act(() => {
      result.current.updateAssistantPanelState({ position: 'left' });
    });

    await waitFor(() => {
      expect(result.current.assistantPanelState.position).toBe('left');
    });

    act(() => {
      result.current.updateAssistantPanelState({ width: 260 });
    });

    await waitFor(() => {
      expect(result.current.assistantPanelState.position).toBe('left');
      expect(result.current.assistantPanelState.width).toBe(260);
    });

    act(() => {
      result.current.updateAssistantPanelState(null);
    });

    expect(result.current.assistantPanelState.position).toBe('left');
  });

  test('requestEditorFocus records focus requests and clearEditorFocusRequest removes them', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      result.current.requestEditorFocus('proj-focus', 'src/App.jsx', { source: 'tests', highlight: 'selection' });
    });

    expect(result.current.editorFocusRequest).toMatchObject({
      projectId: 'proj-focus',
      filePath: 'src/App.jsx',
      source: 'tests',
      highlight: 'selection',
      requestedAt: 1700000000000
    });

    act(() => {
      result.current.clearEditorFocusRequest();
    });

    expect(result.current.editorFocusRequest).toBeNull();

    act(() => {
      result.current.requestEditorFocus('proj-focus', 'src/Defaults.jsx');
    });

    expect(result.current.editorFocusRequest).toMatchObject({
      projectId: 'proj-focus',
      filePath: 'src/Defaults.jsx',
      source: 'branch',
      highlight: 'diff'
    });

    act(() => {
      result.current.clearEditorFocusRequest();
    });

    expect(result.current.editorFocusRequest).toBeNull();

    act(() => {
      result.current.requestEditorFocus(null, 'src/ignored.js');
    });

    expect(result.current.editorFocusRequest).toBeNull();
    nowSpy.mockRestore();
  });

  test('configureLLM updates in-memory state', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      result.current.configureLLM({ provider: 'anthropic', apiKey: 'secret' });
    });

    await waitFor(() => {
      expect(result.current.isLLMConfigured).toBe(true);
    });
  });

  test('LLM status falls back when error payload is not a string', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/llm/status') {
        return Promise.resolve(createResponse(true, {
          success: false,
          error: { message: 'not a string error field' }
        }));
      }

      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await waitFor(() => {
      expect(result.current.llmStatusLoaded).toBe(true);
    });

    expect(result.current.isLLMConfigured).toBe(false);
    expect(result.current.llmConfig).toBeNull();
    expect(result.current.llmStatus?.reason).toBe('Failed to load LLM status');
  });

  test('LLM status uses string error payload when provided', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/llm/status') {
        return Promise.resolve(createResponse(true, {
          success: false,
          error: 'LLM misconfigured'
        }));
      }

      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await waitFor(() => {
      expect(result.current.llmStatusLoaded).toBe(true);
    });

    expect(result.current.isLLMConfigured).toBe(false);
    expect(result.current.llmConfig).toBeNull();
    expect(result.current.llmStatus?.reason).toBe('LLM misconfigured');
  });

  test('LLM status falls back to Backend unreachable when fetch error has no message', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/llm/status') {
        return Promise.reject({});
      }

      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await waitFor(() => {
      expect(result.current.llmStatusLoaded).toBe(true);
    });

    expect(result.current.isLLMConfigured).toBe(false);
    expect(result.current.llmConfig).toBeNull();
    expect(result.current.llmStatus?.reason).toBe('Backend unreachable');
  });

  test('LLM status treats invalid payload as backend offline', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/llm/status') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ not: 'a valid llm status payload' })
        });
      }

      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await waitFor(() => {
      expect(result.current.llmStatusLoaded).toBe(true);
    });

    expect(result.current.backendConnectivity?.status).toBe('offline');
    expect(result.current.isLLMConfigured).toBe(false);
    expect(result.current.llmConfig).toBeNull();
    expect(result.current.llmStatus?.reason).toBe('Backend returned an invalid LLM status response');
  });

  test('configureLLM ignores invalid config payloads', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/llm/status') {
        return Promise.resolve(createResponse(true, {
          success: true,
          configured: false,
          ready: false,
          reason: 'No LLM configuration found'
        }));
      }

      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => url === '/api/llm/status')).toBe(true);
    });

    expect(result.current.isLLMConfigured).toBe(false);

    act(() => {
      result.current.configureLLM(null);
      result.current.configureLLM('not-an-object');
    });

    expect(result.current.isLLMConfigured).toBe(false);
    expect(result.current.llmConfig).toBeNull();
  });

  test('outdated LLM status hydration does not overwrite manual configuration', async () => {
    let rejectStatusFetch;
    const statusFetchGate = new Promise((_, reject) => {
      rejectStatusFetch = reject;
    });

    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/llm/status') {
        return statusFetchGate;
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => url === '/api/llm/status')).toBe(true);
    });

    act(() => {
      result.current.configureLLM({
        provider: 'openai',
        model: 'gpt-4o-mini',
        apiUrl: 'https://api.openai.com/v1'
      });
    });

    await waitFor(() => {
      expect(result.current.isLLMConfigured).toBe(true);
      expect(result.current.llmConfig?.provider).toBe('openai');
    });

    await act(async () => {
      rejectStatusFetch(new Error('Backend unreachable'));
      await Promise.resolve();
    });

    expect(result.current.isLLMConfigured).toBe(true);
    expect(result.current.llmConfig?.provider).toBe('openai');
    expect(result.current.llmStatusLoaded).toBe(false);
  });

  test('capability flags reflect LLM configuration and active project', async () => {
    let statusCalls = 0;
    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/llm/status') {
        statusCalls += 1;

        if (statusCalls === 1) {
          return Promise.resolve(createResponse(true, {
            success: true,
            configured: false,
            ready: false,
            reason: 'No LLM configuration found'
          }));
        }

        return Promise.resolve(createResponse(true, {
          success: true,
          configured: true,
          ready: true,
          config: {
            provider: 'openai',
            model: 'gpt-4o-mini',
            api_url: 'https://api.openai.com/v1',
            requires_api_key: true,
            has_api_key: true
          }
        }));
      }

      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    expect(result.current.isLLMConfigured).toBe(false);
    expect(result.current.hasProject).toBe(false);
    expect(result.current.canUseProjects).toBe(false);
    expect(result.current.canUseTools).toBe(false);
    expect(result.current.canUseSettings).toBe(false);

    await act(async () => {
      await result.current.configureLLM({
        provider: 'openai',
        model: 'gpt-4o-mini',
        apiUrl: 'https://api.openai.com/v1'
      });
    });

    await waitFor(() => {
      expect(result.current.isLLMConfigured).toBe(true);
    });

    expect(result.current.canUseProjects).toBe(true);
    expect(result.current.canUseSettings).toBe(true);
    expect(result.current.hasProject).toBe(false);

    act(() => {
      result.current.setCurrentProject({ id: 'proj-cap', name: 'Capability Project' });
    });

    expect(result.current.hasProject).toBe(true);
    expect(result.current.canUseTools).toBe(true);
  });

  test('currentProject effect stores and clears the persisted selection', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      result.current.setCurrentProject({ id: 'proj-store', name: 'Stored Project' });
    });

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem('currentProject') || '{}');
      expect(stored.id).toBe('proj-store');
    });

    act(() => {
      result.current.setCurrentProject(null);
    });

    await waitFor(() => {
      expect(localStorage.getItem('currentProject')).toBeNull();
    });
  });

  test('persists preview tab per project and restores on switch', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      result.current.setCurrentProject({ id: 'proj-1', name: 'First Project' });
    });

    act(() => {
      result.current.setPreviewPanelTab('files', { source: 'user' });
    });

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem('previewPanelStateByProject') || '{}');
      expect(stored['proj-1']).toBe('files');
    });

    act(() => {
      result.current.setCurrentProject({ id: 'proj-2', name: 'Second Project' });
    });

    act(() => {
      result.current.setPreviewPanelTab('test', { source: 'user' });
    });

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem('previewPanelStateByProject') || '{}');
      expect(stored['proj-2']).toBe('test');
    });

    act(() => {
      result.current.setCurrentProject({ id: 'proj-1', name: 'First Project' });
    });

    await waitFor(() => {
      expect(result.current.previewPanelState?.activeTab).toBe('files');
    });
  });

  test('setPreviewPanelTab skips duplicate per-project updates', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      result.current.setCurrentProject({ id: 'proj-dup', name: 'Dup Project' });
    });

    act(() => {
      result.current.setPreviewPanelTab('files', { source: 'user' });
    });

    act(() => {
      result.current.setPreviewPanelTab('files', { source: 'user' });
    });

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem('previewPanelStateByProject') || '{}');
      expect(stored['proj-dup']).toBe('files');
    });
  });

  test('theme effect syncs preference to document and storage', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.toggleTheme();
    });

    await waitFor(() => {
      expect(localStorage.getItem('theme')).toBe(result.current.theme);
      expect(document.documentElement.getAttribute('data-theme')).toBe(result.current.theme);
    });
  });

  test('startAutomationJob validates required parameters', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    await expect(result.current.startAutomationJob()).rejects.toThrow('Job type is required');
    await expect(result.current.startAutomationJob('lint')).rejects.toThrow('Select a project before running automation jobs');
  });

  test('startAutomationJob surfaces backend failures when job payload missing', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/projects/proj-jobs/jobs' && options?.method === 'POST') {
        return Promise.resolve(createResponse(true, { success: false, error: 'start failed' }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-jobs', name: 'Jobs Project' });
    });

    await expect(result.current.startAutomationJob('lint')).rejects.toThrow('start failed');
  });

  test('startAutomationJob uses a default error message when backend omits details', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/projects/proj-jobs/jobs' && options?.method === 'POST') {
        return Promise.resolve(createResponse(true, { success: false }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-jobs', name: 'Jobs Project' });
    });

    await expect(result.current.startAutomationJob('lint')).rejects.toThrow('Failed to start automation job');
  });

  test('startAutomationJob persists jobs and polls for updates', async () => {
    const runningJob = { id: 'job-42', status: 'running', createdAt: '2024-01-01T00:00:00Z' };
    const finishedJob = { ...runningJob, status: 'succeeded' };

    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/projects/proj-jobs/jobs' && options?.method === 'POST') {
        return Promise.resolve(createResponse(true, { success: true, job: runningJob }));
      }
      if (url === '/api/projects/proj-jobs/jobs/job-42') {
        return Promise.resolve(createResponse(true, { success: true, job: finishedJob }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-jobs', name: 'Jobs Project' });
    });

    let createdJob;
    await act(async () => {
      createdJob = await result.current.startAutomationJob('lint', { payload: { branch: 'main' } });
    });

    expect(createdJob.id).toBe('job-42');
    expect(createdJob.status).toBe('running');

    await waitFor(() => {
      const jobs = result.current.getJobsForProject('proj-jobs');
      expect(jobs[0].status).toBe('succeeded');

      const defaultJobs = result.current.getJobsForProject();
      expect(defaultJobs[0].status).toBe('succeeded');
    });
  });

  test('startAutomationJob forwards branchName in the payload when provided', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/projects/proj-jobs/jobs' && options?.method === 'POST') {
        const parsedBody = JSON.parse(options.body);
        expect(parsedBody).toEqual({
          type: 'frontend:test',
          payload: { branchName: 'feature/css-only' }
        });
        return Promise.resolve(createResponse(true, {
          success: true,
          job: { id: 'job-branch', status: 'running', createdAt: '2024-01-01T00:00:00Z' }
        }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-jobs', name: 'Jobs Project' });
    });

    await act(async () => {
      await result.current.startAutomationJob('frontend:test', { branchName: 'feature/css-only' });
    });
  });

  test('startAutomationJob omits empty payload from the request body', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/projects/proj-jobs/jobs' && options?.method === 'POST') {
        const parsedBody = JSON.parse(options.body);
        expect(parsedBody).toEqual({ type: 'lint' });
        return Promise.resolve(createResponse(true, {
          success: true,
          job: { id: 'job-empty-payload', status: 'succeeded', createdAt: '2024-01-01T00:00:00Z' }
        }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-jobs', name: 'Jobs Project' });
    });

    await act(async () => {
      await result.current.startAutomationJob('lint', { payload: {} });
    });
  });

  test('startAutomationJob resolves with skip metadata when backend skips css-only tests', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/projects/proj-jobs/jobs' && options?.method === 'POST') {
        return Promise.resolve(createResponse(true, {
          success: true,
          skipped: true,
          reason: 'css-only-branch',
          branch: 'feature/css-only',
          indicator: 'git-diff'
        }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-jobs', name: 'Jobs Project' });
    });

    let skipResult;
    await act(async () => {
      skipResult = await result.current.startAutomationJob('frontend:test');
    });

    expect(skipResult).toEqual({
      skipped: true,
      reason: 'css-only-branch',
      branch: 'feature/css-only',
      indicator: 'git-diff'
    });
  });

  test('cancelAutomationJob validates required parameters', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    await expect(result.current.cancelAutomationJob()).rejects.toThrow('Job ID is required to cancel automation');
    await expect(result.current.cancelAutomationJob('job-99')).rejects.toThrow('Select a project before cancelling automation jobs');
  });

  test('cancelAutomationJob updates job snapshots after cancellation', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/projects/proj-jobs/jobs/job-77/cancel' && options?.method === 'POST') {
        return Promise.resolve(createResponse(true, {
          success: true,
          job: { id: 'job-77', status: 'cancelled', createdAt: '2024-01-01T00:00:00Z' }
        }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-jobs', name: 'Jobs Project' });
    });

    let cancelledJob;
    await act(async () => {
      cancelledJob = await result.current.cancelAutomationJob('job-77');
    });

    expect(cancelledJob.status).toBe('cancelled');
    await waitFor(() => {
      const jobs = result.current.getJobsForProject('proj-jobs');
      expect(jobs[0].id).toBe('job-77');
      expect(jobs[0].status).toBe('cancelled');
    });
  });

  test('cancelAutomationJob surfaces backend failures after posting cancel request', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/projects/proj-jobs/jobs/job-500/cancel' && options?.method === 'POST') {
        return Promise.resolve(createResponse(true, { success: false, error: 'unable to cancel' }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-jobs', name: 'Jobs Project' });
    });

    await expect(result.current.cancelAutomationJob('job-500')).rejects.toThrow('unable to cancel');
  });

  test('cancelAutomationJob uses a default error message when backend omits details', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/projects/proj-jobs/jobs/job-500/cancel' && options?.method === 'POST') {
        return Promise.resolve(createResponse(true, { success: false }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-jobs', name: 'Jobs Project' });
    });

    await expect(result.current.cancelAutomationJob('job-500')).rejects.toThrow('Failed to cancel automation job');
  });

  test('getJobsForProject returns an empty array when no project is active', () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    expect(result.current.getJobsForProject()).toEqual([]);
    expect(result.current.getJobsForProject('proj-missing')).toEqual([]);
  });

  test('clearJobPolls helper cancels scheduled polls and resets registry', () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useAppState(), { wrapper });

    expect(typeof __appStateTestHelpers.clearJobPolls).toBe('function');
    expect(__appStateTestHelpers.jobPollsRef?.current).toBeInstanceOf(Map);

    const controller = {
      cancelled: false,
      timeoutId: setTimeout(() => {}, 1000)
    };
    __appStateTestHelpers.jobPollsRef.current.set('proj:job', controller);

    __appStateTestHelpers.clearJobPolls();

    expect(controller.cancelled).toBe(true);
    expect(__appStateTestHelpers.jobPollsRef.current.size).toBe(0);

    vi.useRealTimers();
    unmount();
  });

  test('refreshJobs loads jobs and surfaces failures', async () => {
    const jobList = [
      { id: 'job-1', createdAt: '2024-01-02T00:00:00Z', status: 'succeeded' }
    ];

    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/projects/proj-jobs/jobs' && (!options || options.method === 'GET')) {
        return Promise.resolve(createResponse(true, { success: true, jobs: jobList }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-jobs', name: 'Jobs Project' });
    });

    await act(async () => {
      await result.current.refreshJobs('proj-jobs');
    });

    await waitFor(() => {
      expect(result.current.getJobsForProject('proj-jobs')).toHaveLength(1);
      expect(result.current.jobState.isLoading).toBe(false);
    });

    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/projects/proj-jobs/jobs' && (!options || options.method === 'GET')) {
        return Promise.resolve(createResponse(true, { success: false, error: 'jobs failed' }));
      }
      return defaultFetchImpl(url, options);
    });

    await expect(result.current.refreshJobs('proj-jobs')).rejects.toThrow('jobs failed');
    await waitFor(() => {
      expect(result.current.jobState.error).toBe('jobs failed');
    });

    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/projects/proj-jobs/jobs' && (!options || options.method === 'GET')) {
        return Promise.resolve(createResponse(true, { success: false }));
      }
      return defaultFetchImpl(url, options);
    });

    await expect(result.current.refreshJobs('proj-jobs')).rejects.toThrow('Failed to load jobs');
  });

  test('refreshJobs supports silent mode without toggling loading state', async () => {
    const jobList = [
      { id: 'job-silent', createdAt: '2024-01-02T00:00:00Z', status: 'succeeded' }
    ];

    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/projects/proj-jobs/jobs' && (!options || options.method === 'GET')) {
        return Promise.resolve(createResponse(true, { success: true, jobs: jobList }));
      }
      return defaultFetchImpl(url, options);
    });

    const setJobLoadingSpy = vi.spyOn(__appStateTestHelpers, 'setJobLoading');
    const setJobErrorSpy = vi.spyOn(__appStateTestHelpers, 'setJobError');

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-jobs', name: 'Jobs Project' });
    });

    await act(async () => {
      await result.current.refreshJobs('proj-jobs', { silent: true });
    });

    await waitFor(() => {
      expect(result.current.getJobsForProject('proj-jobs')).toHaveLength(1);
      expect(result.current.jobState.isLoading).toBe(false);
    });

    expect(setJobLoadingSpy).not.toHaveBeenCalled();
    expect(setJobErrorSpy).not.toHaveBeenCalled();

    setJobLoadingSpy.mockRestore();
    setJobErrorSpy.mockRestore();
  });

  test('refreshJobs toggles loading state only when not silent', async () => {
    const jobList = [
      { id: 'job-toggle', createdAt: '2024-01-02T00:00:00Z', status: 'succeeded' }
    ];

    let resolveFetch;
    const fetchGate = new Promise((resolve) => {
      resolveFetch = resolve;
    });

    fetchMock.mockImplementation(async (url, options) => {
      if (url === '/api/projects/proj-toggle/jobs' && (!options || options.method === 'GET')) {
        await fetchGate;
        return createResponse(true, { success: true, jobs: jobList });
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-toggle', name: 'Jobs Toggle Project' });
    });

    let nonSilentPromise;
    await act(async () => {
      nonSilentPromise = result.current.refreshJobs('proj-toggle');
    });

    await waitFor(() => {
      expect(result.current.jobState.isLoading).toBe(true);
    });

    resolveFetch();
    await act(async () => {
      await nonSilentPromise;
    });

    await waitFor(() => {
      expect(result.current.jobState.isLoading).toBe(false);
    });

    // Repeat with silent mode: should not flip loading state to true.
    let resolveFetchSilent;
    const fetchGateSilent = new Promise((resolve) => {
      resolveFetchSilent = resolve;
    });

    fetchMock.mockImplementation(async (url, options) => {
      if (url === '/api/projects/proj-toggle/jobs' && (!options || options.method === 'GET')) {
        await fetchGateSilent;
        return createResponse(true, { success: true, jobs: jobList });
      }
      return defaultFetchImpl(url, options);
    });

    let silentPromise;
    await act(async () => {
      silentPromise = result.current.refreshJobs('proj-toggle', { silent: true });
    });

    expect(result.current.jobState.isLoading).toBe(false);

    resolveFetchSilent();
    await act(async () => {
      await silentPromise;
    });

    expect(result.current.jobState.isLoading).toBe(false);
  });

  test('refreshJobs defaults to the current project id when no argument is provided', async () => {
    const jobList = [
      { id: 'job-default', createdAt: '2024-01-02T00:00:00Z', status: 'succeeded' }
    ];

    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/projects/proj-jobs/jobs' && (!options || options.method === 'GET')) {
        return Promise.resolve(createResponse(true, { success: true, jobs: jobList }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-jobs', name: 'Jobs Project' });
    });

    await act(async () => {
      await result.current.refreshJobs();
    });

    await waitFor(() => {
      expect(result.current.getJobsForProject('proj-jobs')).toHaveLength(1);
    });
  });

  test('refreshJobs starts polling for non-final jobs', async () => {
    const runningJob = { id: 'job-running', status: 'running', createdAt: '2024-01-03T00:00:00Z' };

    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/projects/proj-active/jobs' && (!options || options.method === 'GET')) {
        return Promise.resolve(createResponse(true, { success: true, jobs: [runningJob] }));
      }
      if (url === '/api/projects/proj-active/jobs/job-running') {
        return Promise.resolve(createResponse(true, {
          success: true,
          job: runningJob
        }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    try {
      await act(() => {
        result.current.setCurrentProject({ id: 'proj-active', name: 'Active Jobs' });
      });

      await act(async () => {
        await result.current.refreshJobs('proj-active');
      });

      await waitFor(() => {
        expect(__appStateTestHelpers.jobPollsRef.current.has('proj-active:job-running')).toBe(true);
      });
    } finally {
      __appStateTestHelpers.clearJobPolls();
    }
  });

  test('setJobsForProject helper sorts snapshots and stamps metadata', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      __appStateTestHelpers.setJobsForProject('proj-helper', [
        { id: 'job-old', createdAt: '2024-01-01T00:00:00Z', status: 'failed' },
        { id: 'job-new', createdAt: '2024-02-01T00:00:00Z', status: 'running' }
      ]);
    });

    await waitFor(() => {
      const jobs = result.current.getJobsForProject('proj-helper');
      expect(jobs.map((job) => job.id)).toEqual(['job-new', 'job-old']);
    });

    const snapshot = result.current.jobState.jobsByProject['proj-helper'];
    expect(new Date(snapshot.lastFetchedAt).toString()).not.toBe('Invalid Date');

    act(() => {
      __appStateTestHelpers.setJobsForProject(null, [{ id: 'job-ignored' }]);
    });

    expect(Object.keys(result.current.jobState.jobsByProject)).toEqual(['proj-helper']);
  });

  test('upsertJobForProject helper inserts and updates existing entries', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      __appStateTestHelpers.upsertJobForProject('proj-helper', {
        id: 'job-inline',
        createdAt: '2024-03-01T00:00:00Z',
        status: 'running'
      });
    });

    await waitFor(() => {
      expect(result.current.getJobsForProject('proj-helper')[0].status).toBe('running');
    });

    act(() => {
      __appStateTestHelpers.upsertJobForProject('proj-helper', {
        id: 'job-inline',
        createdAt: '2024-03-01T00:00:00Z',
        status: 'succeeded'
      });
    });

    await waitFor(() => {
      expect(result.current.getJobsForProject('proj-helper')[0].status).toBe('succeeded');
    });

    act(() => {
      __appStateTestHelpers.upsertJobForProject(null, { id: 'job-missing' });
      __appStateTestHelpers.upsertJobForProject('proj-helper');
    });

    expect(result.current.getJobsForProject('proj-helper')).toHaveLength(1);
  });

  test('job state helper setters toggle loading and error flags directly', () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      __appStateTestHelpers.setJobLoading(true);
    });
    expect(result.current.jobState.isLoading).toBe(true);

    act(() => {
      __appStateTestHelpers.setJobError('helper failure');
    });
    expect(result.current.jobState.error).toBe('helper failure');
  });

  test('stopPollingJob helper clears controllers whether or not they exist', () => {
    renderHook(() => useAppState(), { wrapper });

    act(() => {
      __appStateTestHelpers.stopPollingJob('proj-miss', 'job-miss');
    });
    expect(__appStateTestHelpers.jobPollsRef.current.size).toBe(0);

    const timeoutId = setTimeout(() => {}, 1000);
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    __appStateTestHelpers.jobPollsRef.current.set('proj-live:job-live', {
      timeoutId,
      cancelled: false
    });

    act(() => {
      __appStateTestHelpers.stopPollingJob('proj-live', 'job-live');
    });

    expect(clearSpy).toHaveBeenCalledWith(timeoutId);
    expect(__appStateTestHelpers.jobPollsRef.current.size).toBe(0);
    clearSpy.mockRestore();
  });

  test('pollJobStatus helper short-circuits when identifiers missing or already tracked', () => {
    renderHook(() => useAppState(), { wrapper });
    fetchMock.mockClear();

    act(() => {
      __appStateTestHelpers.pollJobStatus();
    });
    expect(fetchMock).not.toHaveBeenCalled();

    __appStateTestHelpers.jobPollsRef.current.set('proj-dup:job-dup', { cancelled: false });

    act(() => {
      __appStateTestHelpers.pollJobStatus('proj-dup', 'job-dup');
    });

    expect(fetchMock).not.toHaveBeenCalled();
    __appStateTestHelpers.jobPollsRef.current.clear();
  });

  test('pollJobStatus stops scheduled reruns when a controller is cancelled', async () => {
    const jobStatusUrl = '/api/projects/proj-loop/jobs/job-loop';
    const realSetTimeout = globalThis.setTimeout;
    const scheduled = [];

    fetchMock.mockImplementation((url, options) => {
      if (url === jobStatusUrl) {
        return Promise.resolve(createResponse(true, {
          success: true,
          job: { id: 'job-loop', status: 'running' }
        }));
      }
      return defaultFetchImpl(url, options);
    });

    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((cb, delay, ...args) => {
      if (delay === 2000 && typeof cb === 'function') {
        const handle = { run: () => cb(...args) };
        scheduled.push(handle);
        return handle;
      }
      return realSetTimeout(cb, delay, ...args);
    });

    renderHook(() => useAppState(), { wrapper });

    try {
      await act(async () => {
        __appStateTestHelpers.pollJobStatus('proj-loop', 'job-loop');
        await Promise.resolve();
      });

      const jobStatusCallCount = () =>
        fetchMock.mock.calls.filter(([url]) => url === jobStatusUrl).length;

      await waitFor(() => {
        expect(jobStatusCallCount()).toBe(1);
        expect(scheduled).toHaveLength(1);
      });

      const controller = __appStateTestHelpers.jobPollsRef.current.get('proj-loop:job-loop');
      expect(controller).toBeDefined();
      controller.cancelled = true;

      scheduled[0].run();

      await waitFor(() => {
        expect(jobStatusCallCount()).toBe(1);
      });
    } finally {
      timeoutSpy.mockRestore();
      __appStateTestHelpers.jobPollsRef.current.clear();
    }
  });

  test('refreshJobs returns empty array when no project is selected', async () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    const jobs = await result.current.refreshJobs();
    expect(jobs).toEqual([]);
    expect(result.current.jobState.isLoading).toBe(false);
  });

  test('job polling stops immediately when backend omits job payloads', async () => {
    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/projects/proj-poll/jobs' && options?.method === 'POST') {
        return Promise.resolve(createResponse(true, {
          success: true,
          job: { id: 'job-poll', status: 'running' }
        }));
      }
      if (url === '/api/projects/proj-poll/jobs/job-poll') {
        return Promise.resolve(createResponse(true, { success: false }));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-poll', name: 'Poll Project' });
    });

    await act(async () => {
      await result.current.startAutomationJob('lint');
    });

    await waitFor(() => {
      expect(__appStateTestHelpers.jobPollsRef.current.size).toBe(0);
    });
  });

  test('job polling schedules follow-up checks until a final status arrives', async () => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const scheduled = [];
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((cb, delay, ...args) => {
      if (typeof cb === 'function' && delay === 2000) {
        const handle = {
          run: () => cb(...args)
        };
        scheduled.push(handle);
        return handle;
      }
      return realSetTimeout(cb, delay, ...args);
    });
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation((handle) => {
      if (handle && typeof handle === 'object' && 'run' in handle) {
        return;
      }
      return realClearTimeout(handle);
    });
    let pollCalls = 0;

    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/projects/proj-loop/jobs' && options?.method === 'POST') {
        return Promise.resolve(createResponse(true, {
          success: true,
          job: { id: 'job-loop', status: 'running' }
        }));
      }
      if (url === '/api/projects/proj-loop/jobs/job-loop') {
        pollCalls += 1;
        const payload = pollCalls === 1
          ? { success: true, job: { id: 'job-loop', status: 'running' } }
          : { success: true, job: { id: 'job-loop', status: 'succeeded' } };
        return Promise.resolve(createResponse(true, payload));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-loop', name: 'Loop Project' });
    });

    await act(async () => {
      await result.current.startAutomationJob('lint');
    });

    await waitFor(() => {
      expect(scheduled.length).toBe(1);
      expect(__appStateTestHelpers.jobPollsRef.current.has('proj-loop:job-loop')).toBe(true);
    });

    act(() => {
      scheduled[0].run();
    });

    await waitFor(() => {
      expect(__appStateTestHelpers.jobPollsRef.current.size).toBe(0);
    });

    timeoutSpy.mockRestore();
    clearSpy.mockRestore();
  });

  test('job polling logs a warning when fetch rejects mid-loop', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    fetchMock.mockImplementation((url, options) => {
      if (url === '/api/projects/proj-warn/jobs' && options?.method === 'POST') {
        return Promise.resolve(createResponse(true, {
          success: true,
          job: { id: 'job-warn', status: 'running' }
        }));
      }
      if (url === '/api/projects/proj-warn/jobs/job-warn') {
        return Promise.reject(new Error('poll failed'));
      }
      return defaultFetchImpl(url, options);
    });

    const { result } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-warn', name: 'Warn Project' });
    });

    await act(async () => {
      await result.current.startAutomationJob('lint');
    });

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith('Failed to poll job status', expect.any(Error));
      expect(__appStateTestHelpers.jobPollsRef.current.size).toBe(0);
    });

    warnSpy.mockRestore();
  });

  test('logout clears project-scoped state and localStorage', () => {
    localStorage.setItem('custom', 'value');
    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      result.current.setCurrentProject({ id: 'proj-logout', name: 'Logout Demo' });
      result.current.syncBranchOverview('proj-logout', {
        workingBranches: [
          {
            name: 'feature/logout',
            status: 'active',
            stagedFiles: [{ path: 'src/foo.js', timestamp: 'now' }]
          }
        ]
      });
      result.current.setFileExplorerState('proj-logout', { expandedNodes: ['src'] });
    });

    act(() => {
      result.current.logout();
    });

    expect(result.current.currentProject).toBeNull();
    expect(result.current.workingBranches).toEqual({});
    expect(result.current.workspaceChanges).toEqual({});
    expect(result.current.jobState.jobsByProject).toEqual({});
    expect(localStorage.getItem('custom')).toBeNull();
  });

  test('view helpers update the current view and toggleTheme flips the theme', () => {
    const { result } = renderHook(() => useAppState(), { wrapper });

    act(() => {
      result.current.showCreateProject();
    });
    expect(result.current.currentView).toBe('create-project');

    act(() => {
      result.current.showImportProject();
    });
    expect(result.current.currentView).toBe('import-project');

    act(() => {
      result.current.showMain();
    });
    expect(result.current.currentView).toBe('main');

    act(() => {
      result.current.setView('custom-view');
    });
    expect(result.current.currentView).toBe('custom-view');

    const initialTheme = result.current.theme;
    act(() => {
      result.current.toggleTheme();
    });
    expect(result.current.theme).not.toBe(initialTheme);

    act(() => {
      result.current.toggleTheme();
    });
    expect(result.current.theme).toBe(initialTheme);
  });
});

describe('AppStateContext helper utilities', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('normalizePortNumber coerces integers and rejects invalid inputs', () => {
    expect(__appStateTestHelpers.normalizePortNumber('6100')).toBe(6100);
    expect(__appStateTestHelpers.normalizePortNumber('6100.5')).toBeNull();
    expect(__appStateTestHelpers.normalizePortNumber('not-a-number')).toBeNull();
  });

  test('coercePortBundle normalizes nested port bundles and applies defaults', () => {
    expect(__appStateTestHelpers.buildEmptyPortBundle()).toEqual({
      active: { frontend: null, backend: null },
      stored: { frontend: null, backend: null },
      preferred: { frontend: null, backend: null }
    });

    const fallbackBundle = __appStateTestHelpers.coercePortBundle(null);
    expect(fallbackBundle).toEqual({
      active: { frontend: null, backend: null },
      stored: { frontend: null, backend: null },
      preferred: { frontend: null, backend: null }
    });

    const defaultedBundle = __appStateTestHelpers.coercePortBundle();
    expect(defaultedBundle).toEqual({
      active: { frontend: 0, backend: 0 },
      stored: { frontend: 0, backend: 0 },
      preferred: { frontend: 0, backend: 0 }
    });

    const bundle = __appStateTestHelpers.coercePortBundle({
      active: { frontend: '6101', backend: '6501' },
      stored: { frontendPort: '6200', backendPort: 6600 },
      preferred: { frontend: 'invalid', backend: 6700 }
    });

    expect(bundle.active.frontend).toBe(6101);
    expect(bundle.stored.frontend).toBe(6200);
    expect(bundle.preferred.frontend).toBeNull();
    expect(bundle.preferred.backend).toBe(6700);

    const nullishBundle = __appStateTestHelpers.coercePortBundle({
      active: { frontend: 0, frontendPort: 6111, backend: null, backendPort: 6511 }
    });

    expect(nullishBundle.active.frontend).toBe(0);
    expect(nullishBundle.active.backend).toBe(6511);
  });

  test('resolveProcessPayload unwraps nested payloads and ignores invalid data', () => {
    expect(__appStateTestHelpers.resolveProcessPayload(null)).toEqual({});
    expect(__appStateTestHelpers.resolveProcessPayload({ processes: null })).toEqual({});
    expect(
      __appStateTestHelpers.resolveProcessPayload({
        processes: { backend: { status: 'running' } }
      })
    ).toEqual({ backend: { status: 'running' } });
  });

  test('buildProcessStateSnapshot derives running state and ports', () => {
    expect(__appStateTestHelpers.buildProcessStateSnapshot(null)).toBeNull();

    const nullPayloadSnapshot = __appStateTestHelpers.buildProcessStateSnapshot('proj-snapshot-null-payload', null);
    expect(nullPayloadSnapshot.projectId).toBe('proj-snapshot-null-payload');
    expect(nullPayloadSnapshot.isRunning).toBe(false);
    expect(nullPayloadSnapshot.ports.active.frontend).toBeNull();

    const frontendSnapshot = __appStateTestHelpers.buildProcessStateSnapshot('proj-snapshot-frontend', {
      processes: {
        frontend: { status: 'running', port: '6100' }
      }
    });

    expect(frontendSnapshot.isRunning).toBe(true);
    expect(frontendSnapshot.ports.active.frontend).toBe(6100);

    const snapshot = __appStateTestHelpers.buildProcessStateSnapshot('proj-snapshot', {
      processes: {
        backend: { status: 'running', port: '7000' }
      }
    });

    expect(snapshot.projectId).toBe('proj-snapshot');
    expect(snapshot.isRunning).toBe(true);
    expect(snapshot.processes.backend.status).toBe('running');
    expect(snapshot.ports.active.backend).toBe(7000);

    const snapshotWithPorts = __appStateTestHelpers.buildProcessStateSnapshot('proj-snapshot-ports', {
      processes: {
        backend: { status: 'running', port: '7000' }
      },
      ports: {
        active: { frontend: 6101, backend: 6501 },
        stored: { frontend: 6200, backend: 6600 },
        preferred: { frontend: 6300, backend: 6700 }
      }
    });

    expect(snapshotWithPorts.ports.active.frontend).toBe(6101);
    expect(snapshotWithPorts.ports.active.backend).toBe(6501);
  });

  test('getMaxAssistantPanelWidth handles missing window references and clamps to half screen', () => {
    const originalWindow = global.window;
    try {
      global.window = undefined;
      expect(__appStateTestHelpers.getMaxAssistantPanelWidth()).toBe(480);
    } finally {
      global.window = originalWindow;
    }

    const innerWidthSpy = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(900);
    expect(__appStateTestHelpers.getMaxAssistantPanelWidth()).toBe(450);
    innerWidthSpy.mockRestore();
  });

  test('clampAssistantPanelWidth enforces numeric bounds and defaults for NaN', () => {
    const clampedMin = __appStateTestHelpers.clampAssistantPanelWidth(100);
    const clampedMax = __appStateTestHelpers.clampAssistantPanelWidth(5000);
    const defaultWidth = __appStateTestHelpers.clampAssistantPanelWidth('not-a-number');

    expect(clampedMin).toBe(240);
    expect(clampedMax).toBeLessThanOrEqual(__appStateTestHelpers.getMaxAssistantPanelWidth());
    expect(defaultWidth).toBe(320);
  });

  test('loadAssistantPanelState merges persisted values, clamps width, and recovers from invalid JSON', () => {
    localStorage.removeItem('assistantPanelState');
    expect(__appStateTestHelpers.loadAssistantPanelState()).toEqual({ width: 320, position: 'left' });

    localStorage.setItem('assistantPanelState', JSON.stringify({ width: 9999, position: 'right' }));
    const persisted = __appStateTestHelpers.loadAssistantPanelState();
    expect(persisted.position).toBe('right');
    expect(persisted.width).toBeLessThanOrEqual(__appStateTestHelpers.getMaxAssistantPanelWidth());

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem('assistantPanelState', '{');
    expect(__appStateTestHelpers.loadAssistantPanelState()).toEqual({ width: 320, position: 'left' });
    expect(warnSpy).toHaveBeenCalledWith('Failed to parse assistantPanelState from storage', expect.any(Error));
    warnSpy.mockRestore();
  });

  test('storage helpers return defaults when window is undefined', () => {
    const originalWindow = global.window;

    try {
      global.window = undefined;

      expect(__appStateTestHelpers.loadAssistantPanelState()).toEqual({ width: 320, position: 'left' });
      expect(__appStateTestHelpers.loadFileExplorerState()).toEqual({});
      expect(__appStateTestHelpers.loadWorkspaceChangesFromStorage()).toEqual({});
      expect(__appStateTestHelpers.loadWorkingBranchesFromStorage()).toEqual({});
      expect(__appStateTestHelpers.loadGitSettingsFromStorage()).toMatchObject({ workflow: 'local', provider: 'github' });
    } finally {
      global.window = originalWindow;
    }
  });

  test('loadFileExplorerState returns stored layouts or falls back to empty objects', () => {
    localStorage.removeItem('fileExplorerState');
    expect(__appStateTestHelpers.loadFileExplorerState()).toEqual({});

    localStorage.setItem('fileExplorerState', JSON.stringify({ '123': { expanded: true } }));
    expect(__appStateTestHelpers.loadFileExplorerState()).toEqual({ '123': { expanded: true } });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem('fileExplorerState', '{');
    expect(__appStateTestHelpers.loadFileExplorerState()).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith('Failed to parse fileExplorerState from storage', expect.any(Error));
    warnSpy.mockRestore();
  });

  test('loadWorkspaceChangesFromStorage returns stored snapshots and handles parse failures', () => {
    localStorage.removeItem('workspaceChanges');
    expect(__appStateTestHelpers.loadWorkspaceChangesFromStorage()).toEqual({});

    localStorage.setItem('workspaceChanges', JSON.stringify({ '123': { stagedFiles: [{ path: 'src/App.jsx' }] } }));
    expect(__appStateTestHelpers.loadWorkspaceChangesFromStorage()).toEqual({ '123': { stagedFiles: [{ path: 'src/App.jsx' }] } });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem('workspaceChanges', '{');
    expect(__appStateTestHelpers.loadWorkspaceChangesFromStorage()).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith('Failed to parse workspaceChanges from storage', expect.any(Error));
    warnSpy.mockRestore();
  });

  test('loadWorkingBranchesFromStorage returns stored branches and tolerates invalid JSON', () => {
    localStorage.removeItem('workingBranches');
    expect(__appStateTestHelpers.loadWorkingBranchesFromStorage()).toEqual({});

    localStorage.setItem('workingBranches', JSON.stringify({ '123': { name: 'feature/test', commits: 1 } }));
    expect(__appStateTestHelpers.loadWorkingBranchesFromStorage()).toEqual({ '123': { name: 'feature/test', commits: 1 } });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem('workingBranches', '{');
    expect(__appStateTestHelpers.loadWorkingBranchesFromStorage()).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith('Failed to parse workingBranches from storage', expect.any(Error));
    warnSpy.mockRestore();
  });

  test('loadPreviewPanelStateByProject returns stored tabs and tolerates invalid JSON', () => {
    localStorage.removeItem('previewPanelStateByProject');
    expect(__appStateTestHelpers.loadPreviewPanelStateByProject()).toEqual({});

    localStorage.setItem('previewPanelStateByProject', JSON.stringify({ '123': 'files' }));
    expect(__appStateTestHelpers.loadPreviewPanelStateByProject()).toEqual({ '123': 'files' });

    const originalWindow = global.window;
    vi.stubGlobal('window', undefined);
    expect(__appStateTestHelpers.loadPreviewPanelStateByProject()).toEqual({});
    vi.stubGlobal('window', originalWindow);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem('previewPanelStateByProject', '{');
    expect(__appStateTestHelpers.loadPreviewPanelStateByProject()).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith('Failed to parse previewPanelStateByProject from storage', expect.any(Error));
    warnSpy.mockRestore();
  });

  test('sortJobsByCreatedAt orders jobs by newest first', () => {
    const ordered = __appStateTestHelpers.sortJobsByCreatedAt([
      { id: '1', createdAt: '2024-01-01T10:00:00Z' },
      { id: '2', createdAt: '2024-01-01T12:00:00Z' },
      { id: '3', createdAt: '2023-12-31T23:59:59Z' }
    ]);
    expect(ordered.map((job) => job.id)).toEqual(['2', '1', '3']);

    const fallbackOrdered = __appStateTestHelpers.sortJobsByCreatedAt([
      null,
      { id: 'no-date' },
      { id: 'new', createdAt: '2024-02-01T12:00:00Z' }
    ]);

    expect(fallbackOrdered[0]?.id).toBe('new');
    expect(fallbackOrdered.some((job) => job === null)).toBe(true);
  });

  test('buildInitialShutdownState returns the neutral shutdown snapshot', () => {
    expect(__appStateTestHelpers.buildInitialShutdownState()).toEqual({
      isStopping: false,
      projectId: null,
      projectName: '',
      startedAt: null,
      error: null
    });
  });

  test('loadGitSettingsFromStorage merges stored overrides and handles parse errors', () => {
    localStorage.removeItem('gitSettings');
    expect(__appStateTestHelpers.loadGitSettingsFromStorage()).toMatchObject({ workflow: 'local', provider: 'github' });

    localStorage.setItem('gitSettings', JSON.stringify({ provider: 'gitlab', autoPush: true }));
    expect(__appStateTestHelpers.loadGitSettingsFromStorage()).toMatchObject({ provider: 'gitlab', defaultBranch: 'main' });
    expect(__appStateTestHelpers.loadGitSettingsFromStorage().autoPush).toBeUndefined();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem('gitSettings', '{');
    expect(__appStateTestHelpers.loadGitSettingsFromStorage()).toMatchObject({ workflow: 'local' });
    expect(warnSpy).toHaveBeenCalledWith('Failed to parse gitSettings from storage', expect.any(Error));
    warnSpy.mockRestore();
  });

  test('loadGitConnectionStatusFromStorage merges stored values and handles parse errors', () => {
    localStorage.removeItem('gitConnectionStatus');
    expect(__appStateTestHelpers.loadGitConnectionStatusFromStorage()).toMatchObject({ provider: '', message: '' });

    localStorage.setItem('gitConnectionStatus', JSON.stringify({ provider: 'github', message: 'Connected', testedAt: '2026-01-01T00:00:00.000Z' }));
    expect(__appStateTestHelpers.loadGitConnectionStatusFromStorage()).toMatchObject({ provider: 'github', message: 'Connected' });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem('gitConnectionStatus', '{');
    expect(__appStateTestHelpers.loadGitConnectionStatusFromStorage()).toMatchObject({ provider: '' });
    expect(warnSpy).toHaveBeenCalledWith('Failed to parse gitConnectionStatus from storage', expect.any(Error));
    warnSpy.mockRestore();
  });
});
