import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useJobs } from '../context/appState/useJobs.js';

const buildFetchResponse = (payload, ok = true) => ({
  ok,
  json: vi.fn().mockResolvedValue(payload)
});

describe('appState/useJobs coverage', () => {
  it('startAutomationJob falls back to a generic error message when thrown error lacks message', async () => {
    const trackedFetch = vi.fn().mockRejectedValue(null);

    const { result } = renderHook(() => useJobs({
      currentProjectId: 'proj-1',
      trackedFetch,
      isTestEnv: true,
      testHelpers: {}
    }));

    let thrown;
    await act(async () => {
      try {
        await result.current.startAutomationJob('analyze');
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBe(null);

    await waitFor(() => {
      expect(result.current.jobState.error).toBe('Failed to start automation job');
    });
  });

  it('startAutomationJob returns skip metadata when server indicates automation was skipped', async () => {
    const trackedFetch = vi.fn()
      .mockResolvedValueOnce(buildFetchResponse({ success: true, jobs: [] }))
      .mockResolvedValueOnce(buildFetchResponse({
        success: true,
        skipped: true,
        reason: 'css-only',
        branch: 'feature/css-cleanup',
        indicator: 'css-only-indicator'
      }));

    const { result } = renderHook(() => useJobs({
      currentProjectId: 'proj-1',
      trackedFetch,
      isTestEnv: true,
      testHelpers: {}
    }));

    const response = await result.current.startAutomationJob('frontend:test', {
      branchName: 'feature/css-cleanup'
    });

    expect(response).toEqual({
      skipped: true,
      reason: 'css-only',
      branch: 'feature/css-cleanup',
      indicator: 'css-only-indicator'
    });
    expect(result.current.jobState.error).toBeNull();
    expect(trackedFetch).toHaveBeenCalledTimes(2);
  });

  it('startAutomationJob normalizes skipped metadata fields to null when omitted', async () => {
    const trackedFetch = vi.fn()
      .mockResolvedValueOnce(buildFetchResponse({ success: true, jobs: [] }))
      .mockResolvedValueOnce(buildFetchResponse({ success: true, skipped: true }));

    const { result } = renderHook(() => useJobs({
      currentProjectId: 'proj-1',
      trackedFetch,
      isTestEnv: true,
      testHelpers: {}
    }));

    const response = await result.current.startAutomationJob('frontend:test');

    expect(response).toEqual({
      skipped: true,
      reason: null,
      branch: null,
      indicator: null
    });
    expect(result.current.jobState.error).toBeNull();
    expect(trackedFetch).toHaveBeenCalledTimes(2);
  });

  it('startAutomationJob persists returned jobs without scheduling polls once they are final', async () => {
    const job = {
      id: 'job-final',
      status: 'succeeded',
      projectId: 'proj-1',
      createdAt: new Date().toISOString()
    };

    const trackedFetch = vi.fn()
      .mockResolvedValueOnce(buildFetchResponse({ success: true, jobs: [] }))
      .mockResolvedValueOnce(buildFetchResponse({ success: true, job }));

    const testHelpers = {};

    const { result } = renderHook(() => useJobs({
      currentProjectId: 'proj-1',
      trackedFetch,
      isTestEnv: true,
      testHelpers
    }));

    await act(async () => {
      const responseJob = await result.current.startAutomationJob('compile');
      expect(responseJob).toEqual(job);
    });

    await waitFor(() => {
      expect(result.current.getJobsForProject('proj-1')).toHaveLength(1);
    });

    const [storedJob] = result.current.getJobsForProject('proj-1');
    expect(storedJob.status).toBe('succeeded');
    expect(trackedFetch).toHaveBeenCalledTimes(2);
    expect(testHelpers.jobPollsRef.current.size).toBe(0);
  });

  it('startAutomationJob surfaces an error when the API omits the job payload', async () => {
    const trackedFetch = vi.fn()
      .mockResolvedValueOnce(buildFetchResponse({ success: true, jobs: [] }))
      .mockResolvedValueOnce(buildFetchResponse({ success: true }));

    const { result } = renderHook(() => useJobs({
      currentProjectId: 'proj-1',
      trackedFetch,
      isTestEnv: true,
      testHelpers: {}
    }));

    await expect(result.current.startAutomationJob('compile')).rejects.toThrow('Failed to start automation job');

    await waitFor(() => {
      expect(result.current.jobState.error).toBe('Failed to start automation job');
    });
  });

  it('startAutomationJob schedules polling when a job remains in a non-final state', async () => {
    const runningJob = {
      id: 'job-pending',
      status: 'running',
      projectId: 'proj-1',
      createdAt: new Date().toISOString()
    };
    const completedJob = {
      ...runningJob,
      status: 'succeeded'
    };

    const trackedFetch = vi.fn()
      .mockResolvedValueOnce(buildFetchResponse({ success: true, jobs: [] }))
      .mockResolvedValueOnce(buildFetchResponse({ success: true, job: runningJob }))
      .mockResolvedValueOnce(buildFetchResponse({ success: true, job: completedJob }));

    const testHelpers = {};

    const { result } = renderHook(() => useJobs({
      currentProjectId: 'proj-1',
      trackedFetch,
      isTestEnv: true,
      testHelpers
    }));

    await act(async () => {
      await result.current.startAutomationJob('rerun-tests');
    });

    await waitFor(() => {
      expect(trackedFetch).toHaveBeenCalledTimes(3);
    });

    await waitFor(() => {
      const jobs = result.current.getJobsForProject('proj-1');
      expect(jobs[0].status).toBe('succeeded');
    });

    await waitFor(() => {
      expect(testHelpers.jobPollsRef.current.size).toBe(0);
    });
  });
});
