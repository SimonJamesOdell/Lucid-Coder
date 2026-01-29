import { describe, it, expect, vi } from 'vitest';
import { selectProjectWithProcesses, restartProjectProcesses } from '../context/appState/projects.js';

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
});
