import { describe, it, expect, vi } from 'vitest';
import {
  fetchProjectsFromBackend,
  selectProjectWithProcesses,
  restartProjectProcesses,
  createProjectBackend,
  createProjectViaBackend,
  importProjectViaBackend
} from '../context/appState/projects.js';

const makeTrackedFetch = (handlers = {}) =>
  vi.fn(async (url, options) => {
    if (handlers[url]) {
      return handlers[url](url, options);
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true })
    };
  });

describe('appState/projects coverage', () => {
  it('fetchProjectsFromBackend sets projects on non-ok success payload', async () => {
    const trackedFetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ success: true, projects: [{ id: 'p1', name: 'Proj' }] })
    }));
    let projects = [];
    const setProjects = vi.fn((next) => { projects = next; });

    await fetchProjectsFromBackend({ trackedFetch, setProjects });

    expect(projects).toHaveLength(1);
    expect(projects[0].id).toBe('p1');
  });

  it('fetchProjectsFromBackend falls back to saved projects on errors', async () => {
    const trackedFetch = vi.fn(async () => {
      throw new Error('boom');
    });
    const originalStorage = globalThis.localStorage;
    const storage = {
      getItem: vi.fn(() => JSON.stringify([{ id: 'saved', name: 'Saved Project' }]))
    };
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
    let projects = [];
    const setProjects = vi.fn((next) => { projects = next; });

    await fetchProjectsFromBackend({ trackedFetch, setProjects });

    expect(storage.getItem).toHaveBeenCalledWith('projects');
    expect(projects).toHaveLength(1);
    expect(projects[0].id).toBe('saved');

    Object.defineProperty(globalThis, 'localStorage', { value: originalStorage, configurable: true });
  });
  it('getUiSessionId returns null when window is undefined', async () => {
    const originalWindow = globalThis.window;
    // Simulate SSR/worker environment
    // eslint-disable-next-line no-undef
    delete globalThis.window;

    const trackedFetch = makeTrackedFetch({
      '/api/projects/1/start': async () => ({ ok: true, status: 200, json: async () => ({ processes: null }) }),
      // If uiSessionId were present, this would be called; we assert it is not.
      '/api/agent/autopilot/resume': async () => ({ ok: true, status: 200, json: async () => ({ success: true }) })
    });

    await selectProjectWithProcesses({
      project: { id: 1, name: 'Demo' },
      currentProject: null,
      closeProject: vi.fn(),
      setCurrentProject: vi.fn(),
      fetchProjectGitSettings: vi.fn(),
      trackedFetch,
      applyProcessSnapshot: vi.fn(),
      refreshProcessStatus: vi.fn()
    });

    expect(trackedFetch).toHaveBeenCalledWith('/api/projects/1/start', expect.any(Object));
    expect(trackedFetch).not.toHaveBeenCalledWith('/api/agent/autopilot/resume', expect.anything());

    globalThis.window = originalWindow;
  });

  it('getUiSessionId returns null when sessionStorage getItem throws', async () => {
    const originalWindow = globalThis.window;

    globalThis.window = {
      sessionStorage: {
        getItem: () => {
          throw new Error('boom');
        }
      }
    };

    const trackedFetch = makeTrackedFetch({
      '/api/projects/1/start': async () => ({ ok: true, status: 200, json: async () => ({ processes: null }) }),
      '/api/agent/autopilot/resume': async () => ({ ok: true, status: 200, json: async () => ({ success: true }) })
    });

    await selectProjectWithProcesses({
      project: { id: 1, name: 'Demo' },
      currentProject: null,
      closeProject: vi.fn(),
      setCurrentProject: vi.fn(),
      fetchProjectGitSettings: vi.fn(),
      trackedFetch,
      applyProcessSnapshot: vi.fn(),
      refreshProcessStatus: vi.fn()
    });

    expect(trackedFetch).toHaveBeenCalledWith('/api/projects/1/start', expect.any(Object));
    expect(trackedFetch).not.toHaveBeenCalledWith('/api/agent/autopilot/resume', expect.anything());

    globalThis.window = originalWindow;
  });

  it('swallows autopilot resume failures (catch block coverage)', async () => {
    const originalWindow = globalThis.window;

    globalThis.window = {
      sessionStorage: {
        getItem: () => 'ui-session-123'
      }
    };

    const trackedFetch = makeTrackedFetch({
      '/api/projects/1/start': async () => ({ ok: true, status: 200, json: async () => ({ processes: null }) }),
      '/api/agent/autopilot/resume': async () => {
        throw new Error('resume failed');
      }
    });

    await expect(
      selectProjectWithProcesses({
        project: { id: 1, name: 'Demo' },
        currentProject: null,
        closeProject: vi.fn(),
        setCurrentProject: vi.fn(),
        fetchProjectGitSettings: vi.fn(),
        trackedFetch,
        applyProcessSnapshot: vi.fn(),
        refreshProcessStatus: vi.fn()
      })
    ).resolves.toBe(true);

    expect(trackedFetch).toHaveBeenCalledWith('/api/agent/autopilot/resume', expect.any(Object));

    globalThis.window = originalWindow;
  });

  it('getUiSessionId returns null for whitespace sessionStorage values', async () => {
    const originalWindow = globalThis.window;

    globalThis.window = {
      sessionStorage: {
        getItem: () => '   '
      }
    };

    const trackedFetch = makeTrackedFetch({
      '/api/projects/1/start': async () => ({ ok: true, status: 200, json: async () => ({ processes: null }) }),
      '/api/agent/autopilot/resume': async () => ({ ok: true, status: 200, json: async () => ({ success: true }) })
    });

    await selectProjectWithProcesses({
      project: { id: 1, name: 'Demo' },
      currentProject: null,
      closeProject: vi.fn(),
      setCurrentProject: vi.fn(),
      fetchProjectGitSettings: vi.fn(),
      trackedFetch,
      applyProcessSnapshot: vi.fn(),
      refreshProcessStatus: vi.fn()
    });

    expect(trackedFetch).toHaveBeenCalledWith('/api/projects/1/start', expect.any(Object));
    expect(trackedFetch).not.toHaveBeenCalledWith('/api/agent/autopilot/resume', expect.anything());

    globalThis.window = originalWindow;
  });

  it('restartProjectProcesses treats invalid JSON as a failure (parseError catch)', async () => {
    const trackedFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('invalid json');
      }
    }));

    await expect(
      restartProjectProcesses({
        projectId: 1,
        target: 'frontend',
        trackedFetch,
        applyProcessSnapshot: vi.fn(),
        refreshProcessStatus: vi.fn(),
        resetProjectProcesses: vi.fn()
      })
    ).rejects.toThrow(/HTTP error! status: 200/i);

    expect(trackedFetch).toHaveBeenCalledWith(
      '/api/projects/1/restart?target=frontend',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('createProjectBackend requires a project id', async () => {
    await expect(
      createProjectBackend({
        projectId: null,
        trackedFetch: vi.fn(),
        refreshProcessStatus: vi.fn()
      })
    ).rejects.toThrow('Select a project before creating a backend');
  });

  it('createProjectBackend refreshes process status on success', async () => {
    const refreshProcessStatus = vi.fn().mockResolvedValue(null);
    const trackedFetch = makeTrackedFetch({
      '/api/projects/1/backend/create': async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, created: true })
      })
    });

    await expect(
      createProjectBackend({
        projectId: 1,
        trackedFetch,
        refreshProcessStatus
      })
    ).resolves.toEqual({ success: true, created: true });

    expect(trackedFetch).toHaveBeenCalledWith(
      '/api/projects/1/backend/create',
      expect.objectContaining({ method: 'POST' })
    );
    expect(refreshProcessStatus).toHaveBeenCalledWith(1);
  });

  it('createProjectBackend ignores refresh failures', async () => {
    const refreshProcessStatus = vi.fn().mockRejectedValue(new Error('status failed'));
    const trackedFetch = makeTrackedFetch({
      '/api/projects/1/backend/create': async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true })
      })
    });

    await expect(
      createProjectBackend({
        projectId: 1,
        trackedFetch,
        refreshProcessStatus
      })
    ).resolves.toEqual({ success: true });

    expect(refreshProcessStatus).toHaveBeenCalledWith(1);
  });

  it('createProjectBackend throws when the backend responds with errors', async () => {
    const trackedFetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('invalid json');
      }
    }));

    await expect(
      createProjectBackend({
        projectId: 2,
        trackedFetch,
        refreshProcessStatus: vi.fn()
      })
    ).rejects.toThrow('HTTP error! status: 500');
  });

  it('createProjectBackend uses error details from the response', async () => {
    const trackedFetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ success: false, error: 'Backend create failed' })
    }));

    await expect(
      createProjectBackend({
        projectId: 3,
        trackedFetch,
        refreshProcessStatus: vi.fn()
      })
    ).rejects.toThrow('Backend create failed');
  });

  it('importProjectViaBackend throws when response parsing fails', async () => {
    const trackedFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('bad json');
      }
    }));

    await expect(
      importProjectViaBackend({
        projectData: { name: 'Bad Import' },
        trackedFetch,
        setProjects: vi.fn(),
        selectProject: vi.fn()
      })
    ).rejects.toThrow('HTTP error! status: 200');
  });

  it('importProjectViaBackend uses error details from the response', async () => {
    const trackedFetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ success: false, error: 'Import failed' })
    }));

    await expect(
      importProjectViaBackend({
        projectData: { name: 'Bad Import' },
        trackedFetch,
        setProjects: vi.fn(),
        selectProject: vi.fn()
      })
    ).rejects.toThrow('Import failed');
  });

  it('createProjectViaBackend returns server project on success', async () => {
    const trackedFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        project: { id: 'proj-1', name: 'Server Project' },
        processes: null
      })
    }));
    let projects = [];
    const setProjects = vi.fn((updater) => { projects = updater(projects); });
    const selectProject = vi.fn();

    const result = await createProjectViaBackend({
      projectData: { name: 'Server Project' },
      trackedFetch,
      setProjects,
      selectProject
    });

    expect(result).toMatchObject({ id: 'proj-1', name: 'Server Project' });
    expect(selectProject).toHaveBeenCalledWith(expect.objectContaining({ id: 'proj-1' }));
    expect(projects).toHaveLength(1);
  });

  it('createProjectViaBackend falls back to a local entry when the request fails', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1234);
    const trackedFetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ success: false, error: 'boom' })
    }));
    let projects = [];
    const setProjects = vi.fn((updater) => { projects = updater(projects); });
    const selectProject = vi.fn();

    const result = await createProjectViaBackend({
      projectData: { name: 'Local Fallback' },
      trackedFetch,
      setProjects,
      selectProject
    });

    expect(result.id).toBe('1234');
    expect(projects[0].id).toBe('1234');
    expect(selectProject).toHaveBeenCalledWith(expect.objectContaining({ id: '1234' }));
    nowSpy.mockRestore();
  });

  it('importProjectViaBackend returns empty jobs when payload is missing', async () => {
    const trackedFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, project: { id: 'p2', name: 'Jobs Missing' } })
    }));
    let projects = [];
    const setProjects = vi.fn((updater) => { projects = updater(projects); });
    const selectProject = vi.fn();

    const result = await importProjectViaBackend({
      projectData: { name: 'Jobs Missing' },
      trackedFetch,
      setProjects,
      selectProject
    });

    expect(result.jobs).toEqual([]);
    expect(projects).toHaveLength(1);
    expect(selectProject).toHaveBeenCalledWith(expect.objectContaining({ id: 'p2' }));
  });
});
