import React from 'react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const sockets = [];

const createResponse = (ok, payload) => ({
  ok,
  status: ok ? 200 : 500,
  json: () => Promise.resolve(payload)
});

const createFakeSocket = () => {
  const handlers = new Map();

  const socket = {
    connected: false,
    __emits: [],
    __joinAckPayload: null,
    on: (event, handler) => {
      const existing = handlers.get(event) || [];
      handlers.set(event, [...existing, handler]);
    },
    off: (event) => {
      if (!event) {
        handlers.clear();
        return;
      }
      handlers.delete(event);
    },
    emit: (event, ...args) => {
      socket.__emits.push({ event, args });

      if (event === 'jobs:join') {
        const payload = args[0];
        const ack = args[1];
        if (typeof ack === 'function') {
          ack(
            socket.__joinAckPayload || {
              ok: true,
              projectId: String(payload?.projectId ?? ''),
              jobs: []
            }
          );
        }
      }
    },
    disconnect: () => {
      socket.connected = false;
      socket.trigger('disconnect', 'client disconnect');
    },
    trigger: (event, ...args) => {
      if (event === 'connect') {
        socket.connected = true;
      }
      if (event === 'disconnect' || event === 'connect_error') {
        socket.connected = false;
      }

      const listeners = handlers.get(event) || [];
      listeners.forEach((handler) => handler(...args));
    }
  };

  return socket;
};

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => {
    const socket = createFakeSocket();
    sockets.push(socket);
    return socket;
  })
}));

describe('AppStateContext jobs socket integration', () => {
  let AppStateProvider;
  let useAppState;
  let __appStateTestHelpers;

  beforeEach(async () => {
    sockets.length = 0;
    globalThis.__lucidcoderEnableJobsSocketTests = true;

    window.localStorage.clear();

    vi.resetModules();
    const module = await import('./AppStateContext');
    AppStateProvider = module.AppStateProvider;
    useAppState = module.useAppState;
    __appStateTestHelpers = module.__appStateTestHelpers;

    fetch.mockReset();
    fetch.mockImplementation((url, options) => {
      if (url === '/api/llm/status') {
        return Promise.resolve(
          createResponse(true, {
            success: true,
            ready: true,
            config: {
              provider: 'openai',
              model: 'gpt-4o-mini',
              api_url: 'https://api.openai.com/v1'
            }
          })
        );
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

      if (url === '/api/projects/proj-jobs/jobs' && (!options || options.method === 'GET')) {
        return Promise.resolve(createResponse(true, { success: true, jobs: [] }));
      }

      if (url === '/api/projects/proj-jobs/jobs' && options?.method === 'POST') {
        return Promise.resolve(
          createResponse(true, {
            success: true,
            job: {
              id: 'job-42',
              projectId: 'proj-jobs',
              status: 'running',
              createdAt: '2024-01-01T00:00:00Z',
              logs: []
            }
          })
        );
      }

      if (url === '/api/projects/proj-jobs/jobs/job-42') {
        return Promise.resolve(
          createResponse(true, {
            success: true,
            job: {
              id: 'job-42',
              projectId: 'proj-jobs',
              status: 'succeeded',
              createdAt: '2024-01-01T00:00:00Z',
              logs: []
            }
          })
        );
      }

      return Promise.resolve(createResponse(true, { success: true }));
    });
  });

  afterEach(() => {
    delete globalThis.__lucidcoderEnableJobsSocketTests;
  });

  const wrapper = ({ children }) => <AppStateProvider>{children}</AppStateProvider>;

  test('uses socket updates for job status + logs without polling while connected', async () => {
    const { result, unmount } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-jobs', name: 'Jobs Project' });
    });

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    const socket = sockets[0];

    // Ensure we cover the successful jobs:join ack path.
    socket.__joinAckPayload = {
      ok: true,
      projectId: 'proj-jobs',
      jobs: [
        {
          id: 'job-seeded',
          projectId: 'proj-jobs',
          status: 'running',
          createdAt: '2024-01-01T00:00:00Z',
          logs: []
        }
      ]
    };

    act(() => {
      socket.trigger('connect');
    });

    await waitFor(() => {
      expect(socket.__emits.some((e) => e.event === 'jobs:join')).toBe(true);
      expect(result.current.getJobsForProject('proj-jobs')).toHaveLength(1);
    });

    await act(async () => {
      await result.current.startAutomationJob('lint', { projectId: 'proj-jobs' });
    });

    // While socket-connected, we should not poll the per-job status endpoint.
    expect(global.fetch.mock.calls.some(([url]) => url === '/api/projects/proj-jobs/jobs/job-42')).toBe(false);

    act(() => {
      socket.trigger('jobs:job', {
        event: 'updated',
        job: {
          id: 'job-42',
          projectId: 'proj-jobs',
          status: 'succeeded',
          createdAt: '2024-01-01T00:00:00Z',
          logs: []
        }
      });
    });

    await waitFor(() => {
      const jobs = result.current.getJobsForProject('proj-jobs');
      expect(jobs[0].status).toBe('succeeded');
    });

    act(() => {
      socket.trigger('jobs:log', {
        projectId: 'proj-jobs',
        jobId: 'job-42',
        entry: { stream: 'stdout', message: 'hello', timestamp: 't1' }
      });
    });

    await waitFor(() => {
      const jobs = result.current.getJobsForProject('proj-jobs');
      expect(jobs[0].logs).toHaveLength(1);
      expect(jobs[0].logs[0]).toMatchObject({ stream: 'stdout', message: 'hello' });
    });

    // Cover ignored payload branches.
    act(() => {
      socket.trigger('jobs:sync', { error: 'boom' });
      socket.trigger('jobs:job', { job: { id: 'job-42', projectId: 'wrong' } });
      socket.trigger('jobs:log', { projectId: 'wrong', jobId: 'job-42', entry: { stream: 'stdout', message: 'x', timestamp: 't2' } });
      socket.trigger('jobs:log', { projectId: 'proj-jobs' });
    });

    unmount();
  });

  test('falls back to polling active jobs when the socket disconnects/errors', async () => {
    const { result, unmount } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-jobs', name: 'Jobs Project' });
    });

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    const socket = sockets[0];

    act(() => {
      socket.trigger('connect');
      socket.trigger('jobs:sync', {
        ok: true,
        projectId: 'proj-jobs',
        jobs: [
          {
            id: 'job-42',
            projectId: 'proj-jobs',
            status: 'running',
            createdAt: '2024-01-01T00:00:00Z',
            logs: []
          }
        ]
      });
    });

    await waitFor(() => {
      expect(result.current.getJobsForProject('proj-jobs')[0].status).toBe('running');
    });

    act(() => {
      socket.trigger('disconnect', 'transport close');
    });

    await waitFor(() => {
      expect(global.fetch.mock.calls.some(([url]) => url === '/api/projects/proj-jobs/jobs/job-42')).toBe(true);
    });

    act(() => {
      socket.trigger('connect_error', new Error('nope'));
    });

    await waitFor(() => {
      const jobs = result.current.getJobsForProject('proj-jobs');
      expect(jobs[0].status).toBe('succeeded');
    });

    unmount();
  });

  test('covers join error payloads and disconnect fallback with no jobs in state', async () => {
    const { result, unmount } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-jobs', name: 'Jobs Project' });
    });

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    const socket = sockets[0];

    // Disconnect before any job state exists to cover the `?.jobs || []` fallback.
    act(() => {
      socket.trigger('disconnect', 'transport close');
    });

    // Also cover connect_error fallback when there are no jobs in state.
    act(() => {
      socket.trigger('connect_error', new Error('nope'));
    });

    // Cover join ack early-return path.
    socket.__joinAckPayload = { ok: false, error: 'nope' };
    act(() => {
      socket.trigger('connect');
    });

    await waitFor(() => {
      expect(socket.__emits.some((e) => e.event === 'jobs:join')).toBe(true);
    });

    // Cover the non-array `jobs` payload branch.
    const { result: result2, unmount: unmount2 } = renderHook(() => useAppState(), { wrapper });
    await act(() => {
      result2.current.setCurrentProject({ id: 'proj-jobs', name: 'Jobs Project' });
    });
    await waitFor(() => {
      expect(sockets).toHaveLength(2);
    });
    const socket2 = sockets[1];
    socket2.__joinAckPayload = { ok: true, projectId: 'proj-jobs', jobs: null };
    act(() => {
      socket2.trigger('connect');
    });

    await waitFor(() => {
      expect(socket2.__emits.some((e) => e.event === 'jobs:join')).toBe(true);
      expect(result2.current.getJobsForProject('proj-jobs')).toHaveLength(0);
    });

    unmount2();
    unmount();
  });

  test('jobs:sync uses an empty list when payload.jobs is not an array', async () => {
    const { result, unmount } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-jobs', name: 'Jobs Project' });
    });

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = sockets[0];

    act(() => {
      socket.trigger('connect');
      socket.trigger('jobs:sync', { ok: true, jobs: null });
    });

    await waitFor(() => {
      expect(result.current.getJobsForProject('proj-jobs')).toHaveLength(0);
    });

    unmount();
  });

  test('disconnect/connect_error fall back to empty snapshot before jobs load', async () => {
    let resolveJobsList;
    const jobsListPromise = new Promise((resolve) => {
      resolveJobsList = resolve;
    });

    fetch.mockReset();
    fetch.mockImplementation((url, options) => {
      if (url === '/api/projects') {
        return Promise.resolve(createResponse(true, { success: true, projects: [] }));
      }
      if (url === '/api/settings/git') {
        return Promise.resolve(createResponse(true, { success: true, settings: {} }));
      }
      if (url === '/api/settings/ports') {
        return Promise.resolve(createResponse(true, { success: true, settings: {} }));
      }

      if (url === '/api/projects/proj-delay/jobs' && (!options || options.method === 'GET')) {
        return jobsListPromise;
      }

      return Promise.resolve(createResponse(true, { success: true }));
    });

    const { result, unmount } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-delay', name: 'Delay Project' });
    });

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const socket = sockets[0];

    act(() => {
      socket.trigger('disconnect', 'transport close');
      socket.trigger('connect_error', new Error('nope'));
    });

    resolveJobsList(createResponse(true, { success: true, jobs: [] }));

    unmount();
  });

  test('appendJobLogForProject handles missing buckets/jobs and non-array logs', async () => {
    const { result, unmount } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      // Missing args should no-op.
      __appStateTestHelpers.appendJobLogForProject();
      __appStateTestHelpers.appendJobLogForProject('proj-x');
      __appStateTestHelpers.appendJobLogForProject('proj-x', 'job-x');
    });

    await act(() => {
      // Unknown project bucket should no-op.
      __appStateTestHelpers.appendJobLogForProject('proj-missing', 'job-x', {
        stream: 'stdout',
        message: 'hello',
        timestamp: 't1'
      });
    });

    await act(() => {
      // Seed a job with a non-array logs field.
      __appStateTestHelpers.setJobsForProject('proj-logs', [
        {
          id: 'job-1',
          projectId: 'proj-logs',
          status: 'running',
          createdAt: '2024-01-01T00:00:00Z',
          logs: null
        }
      ]);
    });

    await act(() => {
      // Unknown job id should no-op.
      __appStateTestHelpers.appendJobLogForProject('proj-logs', 'job-missing', {
        stream: 'stdout',
        message: 'ignored',
        timestamp: 't2'
      });
    });

    await act(() => {
      // Existing job should get a new logs array.
      __appStateTestHelpers.appendJobLogForProject('proj-logs', 'job-1', {
        stream: 'stdout',
        message: 'first',
        timestamp: 't3'
      });
    });

    await waitFor(() => {
      const jobs = result.current.getJobsForProject('proj-logs');
      expect(jobs).toHaveLength(1);
      expect(jobs[0].logs).toHaveLength(1);
      expect(jobs[0].logs[0]).toMatchObject({ message: 'first' });
    });

    unmount();
  });

  test('pollJobStatus no-ops when socket-connected and disconnects on project change', async () => {
    const { result, unmount } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-a', name: 'A' });
    });

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    const socket1 = sockets[0];

    act(() => {
      socket1.trigger('connect');
    });

    await act(() => {
      __appStateTestHelpers.pollJobStatus('proj-a', 'job-x');
    });

    expect(global.fetch.mock.calls.some(([url]) => url === '/api/projects/proj-a/jobs/job-x')).toBe(false);

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-b', name: 'B' });
    });

    await waitFor(() => {
      expect(sockets).toHaveLength(2);
    });

    unmount();
  });

  test('ensureJobPolling no-ops when socket-connected', async () => {
    const { result, unmount } = renderHook(() => useAppState(), { wrapper });

    await act(() => {
      result.current.setCurrentProject({ id: 'proj-a', name: 'A' });
    });

    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    const socket = sockets[0];

    act(() => {
      socket.trigger('connect');
    });

    await act(() => {
      __appStateTestHelpers.ensureJobPolling('proj-a', {
        id: 'job-ensure',
        projectId: 'proj-a',
        status: 'running'
      });
    });

    expect(global.fetch.mock.calls.some(([url]) => url === '/api/projects/proj-a/jobs/job-ensure')).toBe(false);

    unmount();
  });
});
