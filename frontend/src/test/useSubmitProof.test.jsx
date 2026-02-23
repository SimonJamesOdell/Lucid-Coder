import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import axios from 'axios';
import { useSubmitProof } from '../components/test-tab/useSubmitProof.js';

let latestSubmitProof;

const HookHarness = (props) => {
  latestSubmitProof = useSubmitProof(props);
  return null;
};

const renderHookInstance = (override = {}) => {
  const props = {
    projectId: 'proj-123',
    activeBranchName: 'feature/proof',
    activeWorkingBranch: { status: 'in-progress' },
    jobsByType: {
      'frontend:test': { id: 'front-1', status: 'succeeded' },
      'backend:test': { id: 'back-1', status: 'succeeded' }
    },
    syncBranchOverview: vi.fn(),
    testRunIntent: { source: 'automation' },
    allTestsCompleted: true,
    ...override
  };

  render(<HookHarness {...props} />);
  return { props, submitProofIfNeeded: latestSubmitProof };
};

beforeEach(() => {
  latestSubmitProof = null;
  axios.post.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('useSubmitProof', () => {
  it('allows proof submission when the test intent source is missing', async () => {
    axios.post.mockResolvedValue({ data: {} });

    const { submitProofIfNeeded } = renderHookInstance({
      testRunIntent: { source: null }
    });

    let result;
    await act(async () => {
      result = await submitProofIfNeeded();
    });

    expect(result).toBe(true);
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  it('sends a null frontend job id when the frontend job lacks an identifier', async () => {
    const syncBranchOverview = vi.fn();
    const onBeforeSubmit = vi.fn();
    axios.post.mockResolvedValue({ data: { overview: { branch: 'feature/proof' } } });

    const { submitProofIfNeeded } = renderHookInstance({
      jobsByType: {
        'frontend:test': { status: 'succeeded' },
        'backend:test': { id: 'back-77', status: 'succeeded' }
      },
      syncBranchOverview
    });

    let result;
    await act(async () => {
      result = await submitProofIfNeeded({ onBeforeSubmit });
    });

    expect(result).toBe(true);
    expect(onBeforeSubmit).toHaveBeenCalled();
    expect(axios.post).toHaveBeenCalledTimes(1);

    const [, payload] = axios.post.mock.calls[0];
    expect(payload.jobIds).toEqual(['back-77']);
    expect(payload.frontendJobId).toBeNull();
    expect(payload.backendJobId).toBe('back-77');
    expect(syncBranchOverview).toHaveBeenCalledWith('proj-123', { branch: 'feature/proof' });
  });

  it('sends a null backend job id when the backend job lacks an identifier', async () => {
    axios.post.mockResolvedValue({ data: {} });

    const { submitProofIfNeeded } = renderHookInstance({
      jobsByType: {
        'frontend:test': { id: 'front-88', status: 'succeeded' },
        'backend:test': { status: 'succeeded' }
      }
    });

    await act(async () => {
      await submitProofIfNeeded();
    });

    const [, payload] = axios.post.mock.calls[0];
    expect(payload.jobIds).toEqual(['front-88']);
    expect(payload.frontendJobId).toBe('front-88');
    expect(payload.backendJobId).toBeNull();
  });

  it('records proof when only frontend test job is present and succeeded', async () => {
    axios.post.mockResolvedValue({ data: {} });

    const { submitProofIfNeeded } = renderHookInstance({
      jobsByType: {
        'frontend:test': { id: 'front-only', status: 'succeeded' },
        'backend:test': null
      }
    });

    let result;
    await act(async () => {
      result = await submitProofIfNeeded();
    });

    expect(result).toBe(true);
    expect(axios.post).toHaveBeenCalledTimes(1);

    const [, payload] = axios.post.mock.calls[0];
    expect(payload.jobIds).toEqual(['front-only']);
    expect(payload.frontendJobId).toBe('front-only');
    expect(payload.backendJobId).toBeNull();
  });

  it('skips proof submission when any discovered test job is incomplete', async () => {
    const { submitProofIfNeeded } = renderHookInstance({
      jobsByType: {
        'frontend:test': { id: 'front-1', status: 'running' },
        'backend:test': { id: 'back-1', status: 'succeeded' }
      }
    });

    let result;
    await act(async () => {
      result = await submitProofIfNeeded();
    });

    expect(result).toBe(false);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('returns false when there are no test jobs to record', async () => {
    const { submitProofIfNeeded } = renderHookInstance({
      jobsByType: {}
    });

    let result;
    await act(async () => {
      result = await submitProofIfNeeded();
    });

    expect(result).toBe(false);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('returns false when jobsByType is null', async () => {
    const { submitProofIfNeeded } = renderHookInstance({
      jobsByType: null
    });

    let result;
    await act(async () => {
      result = await submitProofIfNeeded();
    });

    expect(result).toBe(false);
    expect(axios.post).not.toHaveBeenCalled();
  });
});
