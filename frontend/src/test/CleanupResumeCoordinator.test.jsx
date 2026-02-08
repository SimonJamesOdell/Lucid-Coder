import React from 'react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

import CleanupResumeCoordinator from '../components/CleanupResumeCoordinator.jsx';
import { useAppState } from '../context/AppStateContext';
import { peekCleanupResumeRequest, setCleanupResumeRequest } from '../utils/cleanupResume';
import * as cleanupResume from '../utils/cleanupResume';

vi.mock('../context/AppStateContext', () => ({
  useAppState: vi.fn()
}));

const buildState = (overrides = {}) => ({
  currentProject: { id: 'proj-1', name: 'Demo', backend: { exists: true } },
  projectProcesses: { capabilities: { backend: { exists: true } } },
  getJobsForProject: vi.fn().mockReturnValue([]),
  testRunIntent: { source: 'automation', updatedAt: new Date().toISOString() },
  jobState: { jobsByProject: {} },
  ...overrides
});

describe('CleanupResumeCoordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setCleanupResumeRequest(null);
  });

  test('does nothing when there is no pending resume token', async () => {
    useAppState.mockImplementation(() => buildState());

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    render(<CleanupResumeCoordinator />);

    await new Promise((r) => setTimeout(r, 0));
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  test('does not dispatch when testRunIntent source is not automation', async () => {
    setCleanupResumeRequest({
      token: 'cleanup-resume:not-automation',
      includeFrontend: true,
      includeBackend: true,
      requestedAt: new Date().toISOString()
    });

    useAppState.mockImplementation(() =>
      buildState({
        testRunIntent: { source: 'user', updatedAt: new Date().toISOString() },
        getJobsForProject: vi.fn().mockReturnValue([
          { id: 'front-1', type: 'frontend:test', status: 'succeeded', createdAt: new Date().toISOString() }
        ])
      })
    );

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    render(<CleanupResumeCoordinator />);

    await new Promise((r) => setTimeout(r, 0));
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  test('does not dispatch when testRunIntent updatedAt predates the request', async () => {
    const now = Date.now();
    const requestedAt = new Date(now + 1000).toISOString();

    setCleanupResumeRequest({
      token: 'cleanup-resume:intent-stale',
      includeFrontend: true,
      includeBackend: false,
      requestedAt
    });

    useAppState.mockImplementation(() =>
      buildState({
        testRunIntent: { source: 'automation', updatedAt: new Date(now).toISOString() }
      })
    );

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    render(<CleanupResumeCoordinator />);

    await new Promise((r) => setTimeout(r, 0));
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  test('handles invalid requestedAt values without dispatching', async () => {
    setCleanupResumeRequest({
      token: 'cleanup-resume:invalid-date',
      includeFrontend: true,
      includeBackend: false,
      requestedAt: 'not-a-date'
    });

    useAppState.mockImplementation(() =>
      buildState({
        testRunIntent: { source: 'automation', updatedAt: new Date().toISOString() },
        getJobsForProject: vi.fn().mockReturnValue([])
      })
    );

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    render(<CleanupResumeCoordinator />);

    await new Promise((r) => setTimeout(r, 0));
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  test('handles non-array job payloads when selecting latest jobs', async () => {
    setCleanupResumeRequest({
      token: 'cleanup-resume:non-array',
      includeFrontend: true,
      includeBackend: false,
      requestedAt: new Date().toISOString()
    });

    useAppState.mockImplementation(() =>
      buildState({
        testRunIntent: { source: 'automation', updatedAt: new Date().toISOString() },
        getJobsForProject: vi.fn().mockReturnValue(null)
      })
    );

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    render(<CleanupResumeCoordinator />);

    await new Promise((r) => setTimeout(r, 0));
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  test('returns null when the latest job lookup yields a falsy entry', async () => {
    const originalSort = Array.prototype.sort;
    Array.prototype.sort = function () {
      return [undefined];
    };

    try {
      setCleanupResumeRequest({
        token: 'cleanup-resume:falsy-latest',
        includeFrontend: true,
        includeBackend: false,
        requestedAt: new Date().toISOString()
      });

      useAppState.mockImplementation(() =>
        buildState({
          testRunIntent: { source: 'automation', updatedAt: new Date().toISOString() },
          getJobsForProject: vi.fn().mockReturnValue([
            { id: 'front-1', type: 'frontend:test', status: 'succeeded', createdAt: new Date().toISOString() }
          ])
        })
      );

      const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
      render(<CleanupResumeCoordinator />);

      await new Promise((r) => setTimeout(r, 0));
      expect(dispatchSpy).not.toHaveBeenCalled();
    } finally {
      Array.prototype.sort = originalSort;
    }
  });

  test('ignores backend when backend capability is false', async () => {
    const now = Date.now();
    const requestedAt = new Date(now).toISOString();
    const createdAt = new Date(now + 10).toISOString();
    const updatedAt = new Date(now + 20).toISOString();

    setCleanupResumeRequest({
      token: 'cleanup-resume:no-backend',
      includeFrontend: true,
      includeBackend: true,
      requestedAt
    });

    useAppState.mockImplementation(() =>
      buildState({
        projectProcesses: { capabilities: { backend: { exists: false } } },
        testRunIntent: { source: 'automation', updatedAt },
        jobState: { jobsByProject: { 'proj-1': { lastFetchedAt: updatedAt } } },
        getJobsForProject: vi.fn().mockReturnValue([
          { id: 'front-1', type: 'frontend:test', status: 'succeeded', createdAt, completedAt: updatedAt }
        ])
      })
    );

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    render(<CleanupResumeCoordinator />);

    await waitFor(() => {
      expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'lucidcoder:open-cleanup-tool' }));
      expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'lucidcoder:cleanup-tool:resume' }));
    });
  });

  test('does not dispatch when passing jobs are older than the request', async () => {
    const now = Date.now();
    const requestedAt = new Date(now + 1000).toISOString();
    const createdAt = new Date(now).toISOString();

    setCleanupResumeRequest({
      token: 'cleanup-resume:stale',
      includeFrontend: true,
      includeBackend: false,
      requestedAt
    });

    useAppState.mockImplementation(() =>
      buildState({
        testRunIntent: { source: 'automation', updatedAt: new Date(now + 2000).toISOString() },
        getJobsForProject: vi.fn().mockReturnValue([
          { id: 'front-1', type: 'frontend:test', status: 'succeeded', createdAt }
        ])
      })
    );

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    render(<CleanupResumeCoordinator />);

    await new Promise((r) => setTimeout(r, 0));
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  test('reads jobs for the project before returning when frontend is not ready', async () => {
    const now = Date.now();
    const requestedAt = new Date(now).toISOString();
    const createdAt = new Date(now + 10).toISOString();

    setCleanupResumeRequest({
      token: 'cleanup-resume:jobs-called',
      includeFrontend: true,
      includeBackend: false,
      requestedAt
    });

    const getJobsForProject = vi.fn().mockReturnValue([
      { id: 'front-1', type: 'frontend:test', status: 'running', createdAt }
    ]);

    useAppState.mockImplementation(() =>
      buildState({
        testRunIntent: { source: 'automation', updatedAt: new Date(now + 20).toISOString() },
        getJobsForProject
      })
    );

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    render(<CleanupResumeCoordinator />);

    await new Promise((r) => setTimeout(r, 0));

    expect(getJobsForProject).toHaveBeenCalledWith('proj-1');
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  test('does not dispatch when backend job predates the request', async () => {
    const now = Date.now();
    const requestedAt = new Date(now + 1000).toISOString();
    const frontendCreatedAt = new Date(now + 2000).toISOString();
    const backendCreatedAt = new Date(now).toISOString();

    setCleanupResumeRequest({
      token: 'cleanup-resume:backend-stale',
      includeFrontend: true,
      includeBackend: true,
      requestedAt
    });

    useAppState.mockImplementation(() =>
      buildState({
        testRunIntent: { source: 'automation', updatedAt: new Date(now + 3000).toISOString() },
        getJobsForProject: vi.fn().mockReturnValue([
          { id: 'front-1', type: 'frontend:test', status: 'succeeded', createdAt: frontendCreatedAt },
          { id: 'back-1', type: 'backend:test', status: 'succeeded', createdAt: backendCreatedAt }
        ])
      })
    );

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    render(<CleanupResumeCoordinator />);

    await new Promise((r) => setTimeout(r, 0));
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  test('skips backend checks when currentProject.backend is null', async () => {
    const now = Date.now();
    const requestedAt = new Date(now).toISOString();
    const createdAt = new Date(now + 10).toISOString();
    const updatedAt = new Date(now + 20).toISOString();

    setCleanupResumeRequest({
      token: 'cleanup-resume:backend-null',
      includeFrontend: true,
      includeBackend: true,
      requestedAt
    });

    useAppState.mockImplementation(() =>
      buildState({
        currentProject: { id: 'proj-1', name: 'Demo', backend: null },
        projectProcesses: { capabilities: { backend: { exists: true } } },
        testRunIntent: { source: 'automation', updatedAt },
        jobState: { jobsByProject: { 'proj-1': { lastFetchedAt: updatedAt } } },
        getJobsForProject: vi.fn().mockReturnValue([
          { id: 'front-1', type: 'frontend:test', status: 'succeeded', createdAt, completedAt: updatedAt }
        ])
      })
    );

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    render(<CleanupResumeCoordinator />);

    await waitFor(() => {
      expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'lucidcoder:open-cleanup-tool' }));
    });
  });

  test('skips backend checks when currentProject.backend.exists is false', async () => {
    const now = Date.now();
    const requestedAt = new Date(now).toISOString();
    const createdAt = new Date(now + 10).toISOString();
    const updatedAt = new Date(now + 20).toISOString();

    setCleanupResumeRequest({
      token: 'cleanup-resume:backend-exists-false',
      includeFrontend: true,
      includeBackend: true,
      requestedAt
    });

    useAppState.mockImplementation(() =>
      buildState({
        currentProject: { id: 'proj-1', name: 'Demo', backend: { exists: false } },
        testRunIntent: { source: 'automation', updatedAt },
        jobState: { jobsByProject: { 'proj-1': { lastFetchedAt: updatedAt } } },
        getJobsForProject: vi.fn().mockReturnValue([
          { id: 'front-1', type: 'frontend:test', status: 'succeeded', createdAt, completedAt: updatedAt }
        ])
      })
    );

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    render(<CleanupResumeCoordinator />);

    await waitFor(() => {
      expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'lucidcoder:open-cleanup-tool' }));
    });
  });

  test('uses the latest job by createdAt when deciding readiness', async () => {
    const now = Date.now();
    const requestedAt = new Date(now).toISOString();
    const earlier = new Date(now + 10).toISOString();
    const later = new Date(now + 20).toISOString();

    setCleanupResumeRequest({
      token: 'cleanup-resume:latest-job',
      includeFrontend: true,
      includeBackend: false,
      requestedAt
    });

    useAppState.mockImplementation(() =>
      buildState({
        testRunIntent: { source: 'automation', updatedAt: new Date(now + 30).toISOString() },
        getJobsForProject: vi.fn().mockReturnValue([
          { id: 'front-old', type: 'frontend:test', status: 'succeeded', createdAt: earlier },
          { id: 'front-new', type: 'frontend:test', status: 'failed', createdAt: later }
        ])
      })
    );

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    render(<CleanupResumeCoordinator />);

    await new Promise((r) => setTimeout(r, 0));
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  test('stops if consumeCleanupResumeRequest returns null and suppresses re-handling the same token', async () => {
    const now = Date.now();
    const requestedAt = new Date(now).toISOString();
    const createdAt = new Date(now + 10).toISOString();
    const updatedAt = new Date(now + 20).toISOString();

    setCleanupResumeRequest({
      token: 'cleanup-resume:consume-null',
      includeFrontend: true,
      includeBackend: false,
      requestedAt
    });

    useAppState.mockImplementation(() =>
      buildState({
        testRunIntent: { source: 'automation', updatedAt },
        jobState: { jobsByProject: { 'proj-1': { lastFetchedAt: updatedAt } } },
        getJobsForProject: vi.fn().mockReturnValue([
          { id: 'front-1', type: 'frontend:test', status: 'succeeded', createdAt, completedAt: updatedAt }
        ])
      })
    );

    const consumeSpy = vi.spyOn(cleanupResume, 'consumeCleanupResumeRequest');
    consumeSpy.mockReturnValueOnce(null);

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    const view = render(<CleanupResumeCoordinator />);

    await new Promise((r) => setTimeout(r, 0));
    expect(dispatchSpy).not.toHaveBeenCalled();

    // Rerender: the same token should not be handled again.
    view.rerender(<CleanupResumeCoordinator />);
    await new Promise((r) => setTimeout(r, 0));
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  test('dispatches open+resume events and consumes the pending request when suites pass after the request time', async () => {
    const requestedAt = new Date(Date.now() + 10).toISOString();
    const createdAt = new Date(Date.now() + 20).toISOString();
    const updatedAt = new Date(Date.now() + 30).toISOString();

    setCleanupResumeRequest({
      token: 'cleanup-resume:test',
      includeFrontend: true,
      includeBackend: true,
      pruneRedundantTests: true,
      requestedAt
    });

    let jobs = [
      { id: 'front-1', type: 'frontend:test', status: 'running', createdAt },
      { id: 'back-1', type: 'backend:test', status: 'running', createdAt }
    ];

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    let state = buildState({
      testRunIntent: { source: 'automation', updatedAt },
      jobState: { jobsByProject: { 'proj-1': { lastFetchedAt: updatedAt } } },
      getJobsForProject: vi.fn(() => jobs)
    });

    useAppState.mockImplementation(() => state);

    const view = render(<CleanupResumeCoordinator />);

    jobs = [
      { id: 'front-1', type: 'frontend:test', status: 'succeeded', createdAt, completedAt: updatedAt },
      { id: 'back-1', type: 'backend:test', status: 'succeeded', createdAt, completedAt: updatedAt }
    ];

    state = {
      ...state,
      jobState: { jobsByProject: { 'proj-1': { lastFetchedAt: new Date(Date.now() + 40).toISOString() } } }
    };

    view.rerender(<CleanupResumeCoordinator />);

    await waitFor(() => {
      expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'lucidcoder:open-cleanup-tool' }));
      expect(dispatchSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'lucidcoder:cleanup-tool:resume',
          detail: expect.objectContaining({ token: 'cleanup-resume:test' })
        })
      );
    });

    expect(peekCleanupResumeRequest()).toBeNull();
  });
});
