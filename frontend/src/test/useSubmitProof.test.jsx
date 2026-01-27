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
  it('falls back to the unknown source guard when the test intent lacks a string source', async () => {
    const { submitProofIfNeeded } = renderHookInstance({
      testRunIntent: { source: null }
    });

    let result;
    await act(async () => {
      result = await submitProofIfNeeded();
    });

    expect(result).toBe(false);
    expect(axios.post).not.toHaveBeenCalled();
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
});
