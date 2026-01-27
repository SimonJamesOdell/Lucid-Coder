import { describe, test, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { AppStateProvider, useAppState } from '../context/AppStateContext';

const createProviderWrapper = () => ({ children }) => <AppStateProvider>{children}</AppStateProvider>;

const mockProject = { id: 'proj-1', name: 'Lifecycle Project' };

const mockProjectsResponse = async () => ({ ok: true, json: async () => ({ success: true, projects: [] }) });
const mockProcessResponse = async () => ({ ok: true, json: async () => ({ message: 'ok' }) });
const mockProcessesStatusResponse = async () => ({
  ok: true,
  json: async () => ({ success: true, processes: {} })
});
const mockGitSettingsResponse = async () => ({
  ok: true,
  json: async () => ({
    success: true,
    settings: {
      workflow: 'local',
      provider: 'github',
      remoteUrl: '',
      username: '',
      token: '',
      defaultBranch: 'main',
      autoPush: false,
      useCommitTemplate: false,
      commitTemplate: ''
    }
  })
});
const mockCreateProjectResponse = async () => ({ ok: true, json: async () => ({ project: mockProject, success: true }) });

const defaultFetchImpl = async (url, options = {}) => {
  if (url === '/api/projects' && (!options.method || options.method === 'GET')) {
    return mockProjectsResponse();
  }
  if (url === '/api/projects' && options.method === 'POST') {
    return mockCreateProjectResponse();
  }
  if (url === '/api/settings/git') {
    return mockGitSettingsResponse();
  }
  if (typeof url === 'string' && url.includes('/git-settings')) {
    return mockGitSettingsResponse();
  }
  if (url === `/api/projects/${mockProject.id}/processes`) {
    return mockProcessesStatusResponse();
  }
  return mockProcessResponse();
};

beforeEach(() => {
  vi.restoreAllMocks();
  fetch.mockReset();
  fetch.mockImplementation(defaultFetchImpl);
  localStorage.clear();
});

describe('Project Process Lifecycle', () => {
  describe('Opening a Project Should Start Processes', () => {
    test('should no-op when selecting a null project', async () => {
      const { result } = renderHook(() => useAppState(), { wrapper: createProviderWrapper() });

      // Ignore AppStateProvider boot-time fetches; we only care about the selectProject call.
      global.fetch.mockClear();

      await act(async () => {
        await result.current.selectProject(null);
      });

      const startCall = global.fetch.mock.calls.find(([url]) => typeof url === 'string' && url.includes('/start'));
      expect(startCall).toBeUndefined();
      expect(result.current.currentProject).toBe(null);
    });

    test('should call backend API to start project processes when project is selected', async () => {
      const { result } = renderHook(() => useAppState(), { wrapper: createProviderWrapper() });

      await act(async () => {
        await result.current.selectProject(mockProject);
      });

      expect(global.fetch).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/start`, expect.objectContaining({ method: 'POST' }));
    });

    test('should handle start API success and update process status', async () => {
      const { result } = renderHook(() => useAppState(), { wrapper: createProviderWrapper() });

      await act(async () => {
        await result.current.selectProject(mockProject);
      });

      const processesCall = global.fetch.mock.calls.find(([url]) => url === `/api/projects/${mockProject.id}/processes`);
      expect(processesCall?.[0]).toBe(`/api/projects/${mockProject.id}/processes`);
      expect(result.current.projectProcesses?.projectId).toBe(mockProject.id);
    });

    test('should handle start API failure gracefully', async () => {
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      global.fetch.mockImplementation((url, options) => {
        if (typeof url === 'string' && url.includes('/start')) {
          return Promise.reject(new Error('Failed to fetch start'));
        }
        return defaultFetchImpl(url, options);
      });
      const { result } = renderHook(() => useAppState(), { wrapper: createProviderWrapper() });

      await act(async () => {
        await result.current.selectProject(mockProject);
      });

      expect(consoleWarn).toHaveBeenCalledWith(
        'Backend server not available - project selected but processes not started. Please ensure the backend server is running.'
      );
      consoleWarn.mockRestore();
    });

    test('should handle HTTP error responses', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      global.fetch.mockImplementation((url, options) => {
        if (typeof url === 'string' && url.includes('/start')) {
          return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
        }
        return defaultFetchImpl(url, options);
      });
      const { result } = renderHook(() => useAppState(), { wrapper: createProviderWrapper() });

      await act(async () => {
        await result.current.selectProject(mockProject);
      });

      expect(consoleError).toHaveBeenCalledWith('Failed to start project processes:', expect.any(Error));
      consoleError.mockRestore();
    });
  });

  describe('Closing a Project Should Stop Processes', () => {
    test('should call backend API to stop project processes when project is closed', async () => {
      const { result } = renderHook(() => useAppState(), { wrapper: createProviderWrapper() });

      await act(async () => {
        await result.current.selectProject(mockProject);
      });

      await act(async () => {
        await result.current.closeProject();
      });

      const stopCall = global.fetch.mock.calls.find(([url]) => url === `/api/projects/${mockProject.id}/stop`);
      expect(stopCall?.[0]).toBe(`/api/projects/${mockProject.id}/stop`);
      expect(stopCall?.[1]).toMatchObject({ method: 'POST' });
    });
  });

  describe('Project Creation Should Start Processes', () => {
    test('should create project via backend API and start processes', async () => {
      const { result } = renderHook(() => useAppState(), { wrapper: createProviderWrapper() });

      await act(async () => {
        await result.current.createProject({ name: 'New Project' });
      });

      const createCall = global.fetch.mock.calls.find(([url, options]) => url === '/api/projects' && options?.method === 'POST');
      expect(createCall?.[1]).toMatchObject({ method: 'POST' });

      const startCall = global.fetch.mock.calls.find(([url]) => url === `/api/projects/${mockProject.id}/start`);
      expect(startCall?.[0]).toBe(`/api/projects/${mockProject.id}/start`);
      expect(startCall?.[1]).toMatchObject({ method: 'POST' });
    });
  });

  describe('Integration with ProjectSelector', () => {
    test('should start processes when selecting project from ProjectSelector', async () => {
      const { result } = renderHook(() => useAppState(), { wrapper: createProviderWrapper() });

      await act(async () => {
        await result.current.selectProject(mockProject);
      });

      expect(result.current.currentProject).toEqual(mockProject);
    });
  });
});