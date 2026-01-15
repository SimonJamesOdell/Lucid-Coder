import { describe, test, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import useBranchTabState from './useBranchTabState';
import { useAppState } from '../../context/AppStateContext';
import axios from 'axios';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn()
  }
}));

vi.mock('../../context/AppStateContext', () => ({
  useAppState: vi.fn()
}));

const mockedAxios = axios;

const createOverview = (overrides = {}) => ({
  success: true,
  current: 'main',
  branches: [
    { name: 'main', status: 'active', isCurrent: true },
    { name: 'feature/login', status: 'ready-for-merge', isCurrent: false }
  ],
  workingBranches: [
    {
      name: 'feature/login',
      status: 'ready-for-merge',
      lastTestStatus: 'passed',
      stagedFiles: []
    }
  ],
  ...overrides
});

const createAppState = (overrides = {}) => ({
  clearStagedChanges: vi.fn().mockResolvedValue(null),
  syncBranchOverview: vi.fn(),
  projectShutdownState: null,
  isProjectStopping: vi.fn(() => false),
  workspaceChanges: {},
  workingBranches: {},
  startAutomationJob: vi.fn().mockResolvedValue(null),
  ...overrides
});

const defaultProps = {
  project: { id: 'proj-1', name: 'Demo Project' },
  onRequestTestsTab: vi.fn(),
  onRequestFileOpen: vi.fn(),
  getCommitMessageForBranch: vi.fn().mockReturnValue(''),
  clearCommitMessageForBranch: vi.fn()
};

describe('useBranchTabState', () => {
  let appState;

  const replaceAppState = (next) => {
    appState = next;
  };

  const patchAppState = (patch) => {
    appState = { ...appState, ...patch };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockedAxios.get.mockReset();
    mockedAxios.post.mockReset();
    mockedAxios.delete.mockReset();
    localStorage.clear();
    replaceAppState(createAppState());
    useAppState.mockImplementation(() => appState);
  });

  test('restores persisted branch selection and re-persists updates', async () => {
    const storageKey = 'branchTab:selected:proj-1';
    localStorage.setItem(storageKey, 'ghost-branch');

    mockedAxios.get
      .mockResolvedValueOnce({ data: createOverview({ branches: [{ name: 'main', status: 'active', isCurrent: true }] }) })
      .mockResolvedValueOnce({ data: createOverview() });

    const { result } = renderHook(() => useBranchTabState(defaultProps));

    await waitFor(() => {
      expect(result.current.sortedBranches.length).toBeGreaterThan(0);
    });
    expect(result.current.selectedBranchName).toBe('main');
    expect(localStorage.getItem(storageKey)).toBeFalsy();

    await act(async () => {
      await result.current.fetchBranches();
    });

    act(() => {
      result.current.setSelectedBranch('feature/login');
    });
    expect(localStorage.getItem(storageKey)).toBe('feature/login');
  });

  test('uses local workspace staged files when server data is empty', async () => {
    replaceAppState(createAppState({
      workspaceChanges: {
        'proj-1': {
          stagedFiles: [{ path: 'src/App.jsx', timestamp: 1 }]
        }
      },
      workingBranches: {
        'proj-1': { name: 'feature/login' }
      }
    }));

    mockedAxios.get.mockResolvedValue({ data: createOverview() });
    const { result } = renderHook(() => useBranchTabState(defaultProps));

    await waitFor(() => {
      expect(result.current.branchSummaries.length).toBeGreaterThan(0);
    });

    act(() => {
      result.current.setSelectedBranch('feature/login');
    });

    await waitFor(() => {
      expect(result.current.selectedFiles[0].timestamp).toBe(1);
    });
  });

  test('invalidates branch when staged signature changes', async () => {
    const overviewWithTimestamp = (timestamp) => createOverview({
      workingBranches: [
        {
          name: 'feature/login',
          status: 'ready-for-merge',
          lastTestStatus: 'passed',
          stagedFiles: [{ path: 'src/App.jsx', timestamp }]
        }
      ]
    });

    mockedAxios.get
      .mockResolvedValueOnce({ data: overviewWithTimestamp(1) })
      .mockResolvedValueOnce({ data: overviewWithTimestamp(2) });

    const { result } = renderHook(() => useBranchTabState(defaultProps));

    await waitFor(() => {
      expect(result.current.branchSummaries.length).toBeGreaterThan(0);
    });

    act(() => {
      result.current.setSelectedBranch('feature/login');
    });

    await waitFor(() => {
      expect(result.current.selectedFiles[0].timestamp).toBe(1);
    });

    await act(async () => {
      await result.current.fetchBranches();
    });

    await waitFor(() => {
      expect(result.current.selectedFiles[0].timestamp).toBe(2);
    });

    await waitFor(() => {
      expect(result.current.branchTestValidity['feature/login']).toEqual({ invalidated: true });
    });
  });

  test('handleRunTests triggers automation and records test status', async () => {
    const startAutomationJob = vi.fn().mockResolvedValue({});
    patchAppState({ startAutomationJob });

    mockedAxios.get
      .mockResolvedValueOnce({ data: createOverview() })
      .mockResolvedValueOnce({ data: createOverview() });

    mockedAxios.post.mockResolvedValue({ data: { testRun: { status: 'failed' } } });

    const props = {
      ...defaultProps,
      onRequestTestsTab: vi.fn()
    };

    const { result } = renderHook(() => useBranchTabState(props));
    await waitFor(() => {
      expect(result.current.sortedBranches.length).toBeGreaterThan(0);
    });

    await act(async () => {
      await result.current.handleRunTests('feature/login');
    });

    expect(props.onRequestTestsTab).toHaveBeenCalled();
    expect(startAutomationJob).toHaveBeenCalledTimes(2);
    expect(result.current.branchTestValidity['feature/login']).toEqual({ invalidated: true });
  });

  test('handleTestAndMerge commits staged files before merging', async () => {
    const overviewWithStaged = createOverview({
      workingBranches: [
        {
          name: 'feature/login',
          status: 'ready-for-merge',
          lastTestStatus: 'passed',
          stagedFiles: [{ path: 'src/App.jsx', timestamp: 1 }]
        }
      ]
    });

    const overviewWithoutStaged = createOverview({
      workingBranches: [
        {
          name: 'feature/login',
          status: 'ready-for-merge',
          lastTestStatus: 'passed',
          stagedFiles: []
        }
      ]
    });

    mockedAxios.get
      .mockResolvedValueOnce({ data: overviewWithStaged })
      .mockResolvedValueOnce({ data: overviewWithStaged });

    mockedAxios.post
      .mockResolvedValueOnce({ data: { testRun: { status: 'passed' } } })
      .mockResolvedValueOnce({ data: { overview: overviewWithoutStaged } })
      .mockResolvedValueOnce({ data: { success: true, overview: overviewWithoutStaged } });

    const { result } = renderHook(() => useBranchTabState(defaultProps));
    await waitFor(() => {
      expect(result.current.branchSummaries.length).toBeGreaterThan(0);
    });

    act(() => {
      result.current.setSelectedBranch('feature/login');
    });

    await waitFor(() => {
      expect(result.current.selectedFiles.length).toBe(1);
    });

    await act(async () => {
      await result.current.handleTestAndMerge('feature/login');
    });

    const postUrls = mockedAxios.post.mock.calls.map(([url]) => url);
    expect(postUrls[0]).toContain('/tests');
    expect(postUrls[1]).toContain('/commit');
    expect(postUrls[2]).toContain('/merge');
    expect(result.current.mergeWarning).toBe(null);
  });

  test('handleTestAndMerge warns when branch is still not mergeable after passing tests', async () => {
    const blockedOverview = createOverview({
      workingBranches: [
        {
          name: 'feature/login',
          status: 'active',
          lastTestStatus: 'passed',
          stagedFiles: [{ path: 'src/App.jsx', timestamp: 1 }]
        }
      ]
    });

    mockedAxios.get
      .mockResolvedValueOnce({ data: blockedOverview })
      .mockResolvedValueOnce({ data: blockedOverview });

    mockedAxios.post
      .mockResolvedValueOnce({ data: { testRun: { status: 'passed' } } })
      .mockResolvedValueOnce({ data: { overview: null } });

    const { result } = renderHook(() => useBranchTabState(defaultProps));
    await waitFor(() => {
      expect(result.current.branchSummaries.length).toBeGreaterThan(0);
    });

    await act(async () => {
      await result.current.handleTestAndMerge('feature/login');
    });

    expect(result.current.mergeWarning).toBeTruthy();
    const postUrls = mockedAxios.post.mock.calls.map(([url]) => url);
    expect(postUrls[0]).toContain('/tests');
    expect(postUrls[1]).toContain('/commit');
    expect(postUrls.some((url) => url.includes('/merge'))).toBe(false);
  });

  test('handleTestAndMerge surfaces merge blocker when working branch is missing', async () => {
    const missingContextOverview = createOverview({
      branches: [
        { name: 'main', status: 'active', isCurrent: true }
      ],
      workingBranches: []
    });

    mockedAxios.get
      .mockResolvedValueOnce({ data: createOverview() })
      .mockResolvedValueOnce({ data: missingContextOverview });

    mockedAxios.post
      .mockResolvedValueOnce({ data: { testRun: { status: 'passed' } } });

    const { result } = renderHook(() => useBranchTabState(defaultProps));
    await waitFor(() => {
      expect(result.current.branchSummaries.length).toBeGreaterThan(0);
    });

    await act(async () => {
      await result.current.handleTestAndMerge('ghost/missing');
    });

    await waitFor(() => {
      expect(result.current.mergeWarning).toBe('Tests must pass before merge');
    });

    const mergeCalls = mockedAxios.post.mock.calls.filter(([url]) => url.includes('/merge'));
    expect(mergeCalls).toHaveLength(0);
  });

  test('handleSkipTestsAndMerge commits staged files and merges without running tests', async () => {
    const overviewWithStaged = createOverview({
      workingBranches: [
        {
          name: 'feature/login',
          status: 'active',
          lastTestStatus: null,
          stagedFiles: [{ path: 'src/App.css', timestamp: 1 }]
        }
      ]
    });

    const overviewWithoutStaged = createOverview({
      workingBranches: [
        {
          name: 'feature/login',
          status: 'active',
          lastTestStatus: null,
          stagedFiles: []
        }
      ]
    });

    mockedAxios.get
      .mockResolvedValueOnce({ data: overviewWithStaged })
      .mockResolvedValueOnce({ data: overviewWithStaged })
      .mockResolvedValueOnce({ data: overviewWithoutStaged });

    mockedAxios.post
      .mockResolvedValueOnce({ data: { overview: overviewWithoutStaged } })
      .mockResolvedValueOnce({ data: { success: true, overview: overviewWithoutStaged } });

    const { result } = renderHook(() => useBranchTabState(defaultProps));
    await waitFor(() => {
      expect(result.current.branchSummaries.length).toBeGreaterThan(0);
    });

    act(() => {
      result.current.setSelectedBranch('feature/login');
    });

    await act(async () => {
      await result.current.handleSkipTestsAndMerge('feature/login');
    });

    const postUrls = mockedAxios.post.mock.calls.map(([url]) => url);
    expect(postUrls.some((url) => url.includes('/tests'))).toBe(false);
    expect(postUrls[0]).toContain('/commit');
    expect(postUrls[1]).toContain('/merge');
    expect(result.current.mergeWarning).toBe(null);
  });

  test('handleSkipTestsAndMerge surfaces commit errors and does not merge', async () => {
    const overviewWithStaged = createOverview({
      workingBranches: [
        {
          name: 'feature/login',
          status: 'active',
          lastTestStatus: null,
          stagedFiles: [{ path: 'src/App.css', timestamp: 1 }]
        }
      ]
    });

    mockedAxios.get
      .mockResolvedValueOnce({ data: overviewWithStaged })
      .mockResolvedValueOnce({ data: overviewWithStaged });

    const rejection = new Error('commit blocked');
    rejection.response = { data: { error: 'Commit blocked before merge' } };
    mockedAxios.post.mockRejectedValueOnce(rejection);

    const { result } = renderHook(() => useBranchTabState(defaultProps));
    await waitFor(() => {
      expect(result.current.branchSummaries.length).toBeGreaterThan(0);
    });

    await act(async () => {
      await result.current.handleSkipTestsAndMerge('feature/login');
    });

    expect(result.current.mergeWarning).toBe('Commit blocked before merge');
    const postUrls = mockedAxios.post.mock.calls.map(([url]) => url);
    expect(postUrls.some((url) => url.includes('/merge'))).toBe(false);
  });

  test('handleSkipTestsAndMerge refetches overview when prefetch fails and commit returns no overview', async () => {
    const overviewWithStaged = createOverview({
      workingBranches: [
        {
          name: 'feature/login',
          status: 'active',
          lastTestStatus: null,
          stagedFiles: [{ path: 'src/App.css', timestamp: 1 }]
        }
      ]
    });

    const overviewAfterRefetch = createOverview({
      workingBranches: [
        {
          name: 'feature/login',
          status: 'active',
          lastTestStatus: null,
          stagedFiles: []
        }
      ]
    });

    mockedAxios.get
      .mockResolvedValueOnce({ data: overviewWithStaged })
      .mockRejectedValueOnce(new Error('branch fetch down'))
      .mockResolvedValueOnce({ data: overviewAfterRefetch });

    mockedAxios.post
      .mockResolvedValueOnce({ data: { overview: null } })
      .mockResolvedValueOnce({ data: { success: true, overview: overviewAfterRefetch } });

    const { result } = renderHook(() => useBranchTabState(defaultProps));
    await waitFor(() => {
      expect(result.current.branchSummaries.length).toBeGreaterThan(0);
    });

    await act(async () => {
      await result.current.handleSkipTestsAndMerge('feature/login');
    });

    const postUrls = mockedAxios.post.mock.calls.map(([url]) => url);
    expect(postUrls[0]).toContain('/commit');
    expect(postUrls[1]).toContain('/merge');
    expect(mockedAxios.get).toHaveBeenCalledTimes(3);
  });

  test('handleSkipTestsAndMerge surfaces server merge error copy when available', async () => {
    mockedAxios.get.mockResolvedValue({ data: createOverview() });
    const rejection = new Error('merge blocked');
    rejection.response = { data: { error: 'Merge blocked by policy' } };
    mockedAxios.post.mockRejectedValueOnce(rejection);

    const { result } = renderHook(() => useBranchTabState(defaultProps));
    await waitFor(() => {
      expect(result.current.branchSummaries.length).toBeGreaterThan(0);
    });

    await act(async () => {
      await result.current.handleSkipTestsAndMerge('feature/login');
    });

    await waitFor(() => {
      expect(result.current.error).toBe('Merge blocked by policy');
    });
  });

  test('handleSkipTestsAndMerge falls back to default merge error copy when server response is missing', async () => {
    mockedAxios.get.mockResolvedValue({ data: createOverview() });
    mockedAxios.post.mockRejectedValueOnce(new Error('merge down'));

    const { result } = renderHook(() => useBranchTabState(defaultProps));
    await waitFor(() => {
      expect(result.current.branchSummaries.length).toBeGreaterThan(0);
    });

    await act(async () => {
      await result.current.handleSkipTestsAndMerge('feature/login');
    });

    await waitFor(() => {
      expect(result.current.error).toBe('Failed to merge branch');
    });
  });

  test('handleSkipTestsAndMerge falls back to cached workingBranches when prefetch overview lacks the branch', async () => {
    const cachedOverview = createOverview({
      workingBranches: [
        {
          name: 'feature/login',
          status: 'active',
          lastTestStatus: 'passed',
          stagedFiles: []
        }
      ]
    });

    const missingBranchOverview = createOverview({ workingBranches: [] });

    mockedAxios.get
      .mockResolvedValueOnce({ data: cachedOverview })
      .mockResolvedValueOnce({ data: missingBranchOverview });

    mockedAxios.post.mockResolvedValueOnce({ data: { success: true, overview: cachedOverview } });

    const { result } = renderHook(() => useBranchTabState(defaultProps));
    await waitFor(() => {
      expect(result.current.branchSummaries.length).toBeGreaterThan(0);
    });

    await act(async () => {
      await result.current.handleSkipTestsAndMerge('feature/login');
    });

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect(mockedAxios.post.mock.calls[0][0]).toContain('/merge');
    expect(result.current.mergeWarning).toBe(null);
  });

  test('handleSkipTestsAndMerge tolerates a null overview from fetchBranches', async () => {
    const cachedOverview = createOverview({
      workingBranches: [
        {
          name: 'feature/login',
          status: 'ready-for-merge',
          lastTestStatus: 'passed',
          stagedFiles: []
        }
      ]
    });

    mockedAxios.get
      .mockResolvedValueOnce({ data: cachedOverview })
      .mockRejectedValueOnce(new Error('branches down'));

    mockedAxios.post.mockResolvedValueOnce({ data: { success: true, overview: cachedOverview } });

    const { result } = renderHook(() => useBranchTabState(defaultProps));
    await waitFor(() => {
      expect(result.current.branchSummaries.length).toBeGreaterThan(0);
    });

    await act(async () => {
      await result.current.handleSkipTestsAndMerge('feature/login');
    });

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect(mockedAxios.post.mock.calls[0][0]).toContain('/merge');
    expect(result.current.mergeWarning).toBe(null);
  });

  test('handleSkipTestsAndMerge attempts merge even when cached workingBranches lacks the branch', async () => {
    const cachedOverview = createOverview({ workingBranches: [] });

    mockedAxios.get
      .mockResolvedValueOnce({ data: cachedOverview })
      .mockResolvedValueOnce({ data: cachedOverview });

    mockedAxios.post.mockResolvedValueOnce({ data: { success: true, overview: cachedOverview } });

    const { result } = renderHook(() => useBranchTabState(defaultProps));
    await waitFor(() => {
      expect(result.current.branchSummaries.length).toBeGreaterThan(0);
    });

    await act(async () => {
      await result.current.handleSkipTestsAndMerge('feature/missing');
    });

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect(mockedAxios.post.mock.calls[0][0]).toContain('/merge');
    expect(result.current.mergeWarning).toBe(null);
  });

  test('handleSkipTestsAndMerge keeps previous workingBranch when commit overview omits it', async () => {
    const overviewWithStaged = createOverview({
      workingBranches: [
        {
          name: 'feature/login',
          status: 'active',
          lastTestStatus: 'passed',
          stagedFiles: [{ path: 'src/App.css', timestamp: 1 }]
        }
      ]
    });

    const commitOverviewMissingBranch = createOverview({ workingBranches: [] });

    mockedAxios.get
      .mockResolvedValueOnce({ data: overviewWithStaged })
      .mockResolvedValueOnce({ data: overviewWithStaged });

    mockedAxios.post
      .mockResolvedValueOnce({ data: { overview: commitOverviewMissingBranch } })
      .mockResolvedValueOnce({ data: { success: true, overview: overviewWithStaged } });

    const { result } = renderHook(() => useBranchTabState(defaultProps));
    await waitFor(() => {
      expect(result.current.branchSummaries.length).toBeGreaterThan(0);
    });

    await act(async () => {
      await result.current.handleSkipTestsAndMerge('feature/login');
    });

    const postUrls = mockedAxios.post.mock.calls.map(([url]) => url);
    expect(postUrls[0]).toContain('/commit');
    expect(postUrls[1]).toContain('/merge');
  });

  test('handleSkipTestsAndMerge uses default commit error copy when server response is missing', async () => {
    const overviewWithStaged = createOverview({
      workingBranches: [
        {
          name: 'feature/login',
          status: 'active',
          lastTestStatus: 'passed',
          stagedFiles: [{ path: 'src/App.css', timestamp: 1 }]
        }
      ]
    });

    mockedAxios.get
      .mockResolvedValueOnce({ data: overviewWithStaged })
      .mockResolvedValueOnce({ data: overviewWithStaged });

    mockedAxios.post.mockRejectedValueOnce(new Error('commit down'));

    const { result } = renderHook(() => useBranchTabState(defaultProps));
    await waitFor(() => {
      expect(result.current.branchSummaries.length).toBeGreaterThan(0);
    });

    await act(async () => {
      await result.current.handleSkipTestsAndMerge('feature/login');
    });

    expect(result.current.mergeWarning).toBe('Failed to commit staged changes before merging');
    const postUrls = mockedAxios.post.mock.calls.map(([url]) => url);
    expect(postUrls[0]).toContain('/commit');
    expect(postUrls.some((url) => url.includes('/merge'))).toBe(false);
  });

  test('handleSkipTestsAndMerge returns early when branch name is missing', async () => {
    mockedAxios.get.mockResolvedValue({ data: createOverview() });

    const { result } = renderHook(() => useBranchTabState(defaultProps));
    await waitFor(() => {
      expect(result.current.branchSummaries.length).toBeGreaterThan(0);
    });

    await act(async () => {
      await result.current.handleSkipTestsAndMerge('');
    });

    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  test('handleSkipTestsAndMerge refetches overview when merge succeeds without returning overview', async () => {
    const overview = createOverview({
      workingBranches: [
        {
          name: 'feature/login',
          status: 'active',
          lastTestStatus: null,
          stagedFiles: []
        }
      ]
    });

    mockedAxios.get
      .mockResolvedValueOnce({ data: overview })
      .mockResolvedValueOnce({ data: overview })
      .mockResolvedValueOnce({ data: overview });

    mockedAxios.post.mockResolvedValueOnce({ data: { success: true } });

    const { result } = renderHook(() => useBranchTabState(defaultProps));
    await waitFor(() => {
      expect(result.current.branchSummaries.length).toBeGreaterThan(0);
    });

    await act(async () => {
      await result.current.handleSkipTestsAndMerge('feature/login');
    });

    expect(mockedAxios.get).toHaveBeenCalledTimes(3);
  });

  test('handleClearStaged applies overview returned from clearStagedChanges', async () => {
    const overviewAfterClear = createOverview({ workingBranches: [] });
    const clearStagedChanges = vi.fn().mockResolvedValue({ overview: overviewAfterClear });
    patchAppState({ clearStagedChanges });

    mockedAxios.get.mockResolvedValue({ data: createOverview() });
    const { result } = renderHook(() => useBranchTabState(defaultProps));

    await waitFor(() => {
      expect(result.current.branchSummaries.length).toBeGreaterThan(0);
    });

    await act(async () => {
      await result.current.handleClearStaged('feature/login');
    });

    expect(clearStagedChanges).toHaveBeenCalledWith('proj-1', { branchName: 'feature/login' });
  });

  test('handleDeleteBranch re-checks out fallback branch when deleting current', async () => {
    const currentOverview = createOverview({ current: 'feature/login' });
    mockedAxios.get.mockResolvedValue({ data: currentOverview });
    mockedAxios.delete.mockResolvedValue({ data: { success: true, overview: createOverview({ current: 'main' }) } });
    mockedAxios.post.mockResolvedValue({ data: { success: true, overview: createOverview() } });

    const { result } = renderHook(() => useBranchTabState(defaultProps));

    await waitFor(() => {
      expect(result.current.branchSummaries.length).toBeGreaterThan(0);
    });

    await act(async () => {
      await result.current.handleDeleteBranch('feature/login');
    });

    expect(mockedAxios.delete).toHaveBeenCalledWith(
      '/api/projects/proj-1/branches/feature%2Flogin',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-confirm-destructive': 'true'
        })
      })
    );
    expect(mockedAxios.post).toHaveBeenCalledWith('/api/projects/proj-1/branches/main/checkout');
  });

  test('handleCreateBranch surfaces API errors and clears inflight flag', async () => {
    mockedAxios.get.mockResolvedValue({ data: createOverview() });
    const rejection = new Error('limit reached');
    rejection.response = { data: { error: 'limit reached' } };
    mockedAxios.post.mockRejectedValueOnce(rejection);

    const { result } = renderHook(() => useBranchTabState(defaultProps));
    await waitFor(() => {
      expect(result.current.branchSummaries.length).toBeGreaterThan(0);
    });

    await expect(result.current.handleCreateBranch({ name: 'dupe' })).rejects.toBe(rejection);

    await waitFor(() => {
      expect(result.current.error).toBe('limit reached');
      expect(result.current.createBranchInFlight).toBe(false);
    });
  });

  test('handleClearFile clears individual files and guards missing paths', async () => {
    const clearStagedChanges = vi.fn().mockResolvedValue({ overview: createOverview() });
    patchAppState({ clearStagedChanges });
    mockedAxios.get.mockResolvedValue({ data: createOverview() });

    const { result } = renderHook(() => useBranchTabState(defaultProps));
    await waitFor(() => {
      expect(result.current.branchSummaries.length).toBeGreaterThan(0);
    });

    await act(async () => {
      await result.current.handleClearFile('src/App.jsx', 'feature/login');
    });

    expect(clearStagedChanges).toHaveBeenCalledWith('proj-1', {
      branchName: 'feature/login',
      filePath: 'src/App.jsx'
    });

    clearStagedChanges.mockClear();
    await act(async () => {
      await result.current.handleClearFile(undefined, 'feature/login');
    });

    expect(clearStagedChanges).not.toHaveBeenCalled();
  });

  test('handleClearFile removes staged file locally and avoids refetch when clearStagedChanges falls back', async () => {
    mockedAxios.get.mockResolvedValue({
      data: createOverview({
        workingBranches: [
          {
            name: 'feature/login',
            status: 'ready-for-merge',
            lastTestStatus: 'passed',
            stagedFiles: [{ path: 'src/App.jsx', source: 'editor', timestamp: null }]
          }
        ]
      })
    });

    const { result } = renderHook(() => useBranchTabState(defaultProps));
    await waitFor(() => {
      expect(result.current.branchSummaries.length).toBeGreaterThan(0);
    });

    act(() => {
      result.current.setSelectedBranch('feature/login');
    });

    await waitFor(() => {
      expect(result.current.selectedFiles).toHaveLength(1);
    });

    await act(async () => {
      await result.current.handleClearFile('src/App.jsx', 'feature/login');
    });

    expect(result.current.selectedFiles).toHaveLength(0);
    expect(result.current.error).toBe('Failed to clear staged changes');
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  test('handleClearFile tolerates staged entries without path during optimistic updates', async () => {
    const clearStagedChanges = vi.fn().mockResolvedValue(null);
    patchAppState({ clearStagedChanges });

    mockedAxios.get.mockResolvedValue({
      data: createOverview({
        workingBranches: [
          {
            name: 'feature/login',
            status: 'ready-for-merge',
            lastTestStatus: 'passed',
            stagedFiles: [
              { path: 'src/App.jsx', source: 'editor', timestamp: null },
              { source: 'editor', timestamp: null }
            ]
          }
        ]
      })
    });

    const { result } = renderHook(() => useBranchTabState(defaultProps));
    await waitFor(() => {
      expect(result.current.branchSummaries.length).toBeGreaterThan(0);
    });

    act(() => {
      result.current.setSelectedBranch('feature/login');
    });

    await waitFor(() => {
      expect(result.current.selectedFiles).toHaveLength(2);
    });

    await act(async () => {
      await result.current.handleClearFile('src/App.jsx', 'feature/login');
    });

    expect(clearStagedChanges).toHaveBeenCalledWith('proj-1', {
      branchName: 'feature/login',
      filePath: 'src/App.jsx'
    });
    expect(result.current.selectedFiles).toHaveLength(1);
  });

  test('handleClearStaged clears staged files locally and avoids refetch when clearStagedChanges falls back', async () => {
    mockedAxios.get.mockResolvedValue({
      data: createOverview({
        workingBranches: [
          {
            name: 'feature/login',
            status: 'ready-for-merge',
            lastTestStatus: 'passed',
            stagedFiles: [{ path: 'src/App.jsx', source: 'editor', timestamp: null }]
          }
        ]
      })
    });

    const { result } = renderHook(() => useBranchTabState(defaultProps));
    await waitFor(() => {
      expect(result.current.branchSummaries.length).toBeGreaterThan(0);
    });

    act(() => {
      result.current.setSelectedBranch('feature/login');
    });

    await waitFor(() => {
      expect(result.current.selectedFiles).toHaveLength(1);
    });

    await act(async () => {
      await result.current.handleClearStaged('feature/login');
    });

    expect(result.current.selectedFiles).toHaveLength(0);
    expect(result.current.error).toBe('Failed to clear staged changes');
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  test('handleClearStaged tolerates non-array stagedFiles during optimistic update', async () => {
    const clearStagedChanges = vi.fn().mockResolvedValue(null);
    patchAppState({ clearStagedChanges });

    mockedAxios.get.mockResolvedValue({
      data: createOverview({
        workingBranches: [
          {
            name: 'feature/login',
            status: 'ready-for-merge',
            lastTestStatus: 'passed',
            stagedFiles: null
          }
        ]
      })
    });

    const { result } = renderHook(() => useBranchTabState(defaultProps));
    await waitFor(() => {
      expect(result.current.branchSummaries.length).toBeGreaterThan(0);
    });

    await waitFor(() => {
      expect(result.current.workingBranches).toHaveLength(1);
    });

    await act(async () => {
      await result.current.handleClearStaged('feature/login');
    });

    expect(clearStagedChanges).toHaveBeenCalledWith('proj-1', { branchName: 'feature/login' });
    expect(result.current.error).toBe('Failed to clear staged changes');
    expect(result.current.workingBranches[0].stagedFiles).toBe(null);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  test('handleClearStaged no-ops optimistic update when branch has no staged files', async () => {
    mockedAxios.get.mockResolvedValue({ data: createOverview({ workingBranches: [] }) });
    const clearStagedChanges = vi.fn().mockResolvedValue({ overview: createOverview({ workingBranches: [] }) });
    patchAppState({ clearStagedChanges });

    const { result } = renderHook(() => useBranchTabState(defaultProps));
    await waitFor(() => {
      expect(result.current.branchSummaries.length).toBeGreaterThan(0);
    });

    await act(async () => {
      await result.current.handleClearStaged('feature/login');
    });

    expect(clearStagedChanges).toHaveBeenCalledWith('proj-1', { branchName: 'feature/login' });
    expect(result.current.selectedFiles).toHaveLength(0);
  });

  test('handleClearStaged refetches overview when clearStagedChanges resolves without overview', async () => {
    const clearStagedChanges = vi.fn().mockResolvedValue({});
    patchAppState({ clearStagedChanges });
    mockedAxios.get.mockResolvedValue({ data: createOverview() });

    const { result } = renderHook(() => useBranchTabState(defaultProps));
    await waitFor(() => {
      expect(result.current.branchSummaries.length).toBeGreaterThan(0);
    });

    await act(async () => {
      await result.current.handleClearStaged('feature/login');
    });

    expect(clearStagedChanges).toHaveBeenCalledWith('proj-1', { branchName: 'feature/login' });
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
  });

  test('handleClearStaged keeps workingBranches reference when no staged files and clearStagedChanges falls back', async () => {
    const clearStagedChanges = vi.fn().mockResolvedValue(null);
    patchAppState({ clearStagedChanges });

    mockedAxios.get.mockResolvedValue({
      data: createOverview({
        workingBranches: [
          {
            name: 'feature/login',
            status: 'ready-for-merge',
            lastTestStatus: 'passed',
            stagedFiles: []
          }
        ]
      })
    });

    const { result } = renderHook(() => useBranchTabState(defaultProps));
    await waitFor(() => {
      expect(result.current.branchSummaries.length).toBeGreaterThan(0);
    });

    await waitFor(() => {
      expect(result.current.workingBranches).toHaveLength(1);
    });

    await act(async () => {
      await result.current.handleClearStaged('feature/login');
    });

    expect(clearStagedChanges).toHaveBeenCalledWith('proj-1', { branchName: 'feature/login' });
    expect(result.current.error).toBe('Failed to clear staged changes');
    expect(result.current.workingBranches).toHaveLength(1);
    expect(result.current.workingBranches[0].stagedFiles).toEqual([]);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  test('handleClearFile refetches overview when clearStagedChanges resolves without overview', async () => {
    const clearStagedChanges = vi.fn().mockResolvedValue({});
    patchAppState({ clearStagedChanges });
    mockedAxios.get.mockResolvedValue({ data: createOverview() });

    const { result } = renderHook(() => useBranchTabState(defaultProps));
    await waitFor(() => {
      expect(result.current.branchSummaries.length).toBeGreaterThan(0);
    });

    await act(async () => {
      await result.current.handleClearFile('src/App.jsx', 'feature/login');
    });

    expect(clearStagedChanges).toHaveBeenCalledWith('proj-1', {
      branchName: 'feature/login',
      filePath: 'src/App.jsx'
    });
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
  });

  test('handleClearFile no-ops optimistic update when working branches are empty', async () => {
    const clearStagedChanges = vi.fn().mockResolvedValue({ overview: createOverview({ workingBranches: [] }) });
    patchAppState({ clearStagedChanges });
    mockedAxios.get.mockResolvedValue({ data: createOverview({ workingBranches: [] }) });

    const { result } = renderHook(() => useBranchTabState(defaultProps));
    await waitFor(() => {
      expect(result.current.branchSummaries.length).toBeGreaterThan(0);
    });

    await act(async () => {
      await result.current.handleClearFile('src/App.jsx', 'feature/login');
    });

    expect(clearStagedChanges).toHaveBeenCalledWith('proj-1', {
      branchName: 'feature/login',
      filePath: 'src/App.jsx'
    });
  });

  test('handleClearFile no-ops optimistic update when staged list does not include target file', async () => {
    const clearStagedChanges = vi.fn().mockResolvedValue(null);
    patchAppState({ clearStagedChanges });
    mockedAxios.get.mockResolvedValue({
      data: createOverview({
        workingBranches: [
          {
            name: 'feature/login',
            status: 'ready-for-merge',
            lastTestStatus: 'passed',
            stagedFiles: [{ path: 'src/Other.jsx', source: 'editor', timestamp: null }]
          }
        ]
      })
    });

    const { result } = renderHook(() => useBranchTabState(defaultProps));
    await waitFor(() => {
      expect(result.current.branchSummaries.length).toBeGreaterThan(0);
    });

    act(() => {
      result.current.setSelectedBranch('feature/login');
    });

    await waitFor(() => {
      expect(result.current.selectedFiles).toHaveLength(1);
    });

    await act(async () => {
      await result.current.handleClearFile('src/App.jsx', 'feature/login');
    });

    expect(clearStagedChanges).toHaveBeenCalledWith('proj-1', {
      branchName: 'feature/login',
      filePath: 'src/App.jsx'
    });
    expect(result.current.selectedFiles).toHaveLength(1);
    expect(result.current.selectedFiles[0].path).toBe('src/Other.jsx');
  });

  test('handleClearFile tolerates non-array stagedFiles during optimistic update', async () => {
    const clearStagedChanges = vi.fn().mockResolvedValue(null);
    patchAppState({ clearStagedChanges });

    mockedAxios.get.mockResolvedValue({
      data: createOverview({
        workingBranches: [
          {
            name: 'feature/login',
            status: 'ready-for-merge',
            lastTestStatus: 'passed',
            stagedFiles: null
          }
        ]
      })
    });

    const { result } = renderHook(() => useBranchTabState(defaultProps));
    await waitFor(() => {
      expect(result.current.branchSummaries.length).toBeGreaterThan(0);
    });

    await waitFor(() => {
      expect(result.current.workingBranches).toHaveLength(1);
    });

    await act(async () => {
      await result.current.handleClearFile('src/App.jsx', 'feature/login');
    });

    expect(clearStagedChanges).toHaveBeenCalledWith('proj-1', {
      branchName: 'feature/login',
      filePath: 'src/App.jsx'
    });
    expect(result.current.error).toBe('Failed to clear staged changes');
    expect(result.current.workingBranches[0].stagedFiles).toBe(null);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  test('handleClearFile keeps workingBranches reference when no staged files and clearStagedChanges falls back', async () => {
    const clearStagedChanges = vi.fn().mockResolvedValue(null);
    patchAppState({ clearStagedChanges });

    mockedAxios.get.mockResolvedValue({
      data: createOverview({
        workingBranches: [
          {
            name: 'feature/login',
            status: 'ready-for-merge',
            lastTestStatus: 'passed',
            stagedFiles: []
          }
        ]
      })
    });

    const { result } = renderHook(() => useBranchTabState(defaultProps));
    await waitFor(() => {
      expect(result.current.branchSummaries.length).toBeGreaterThan(0);
    });

    await waitFor(() => {
      expect(result.current.workingBranches).toHaveLength(1);
    });

    await act(async () => {
      await result.current.handleClearFile('src/App.jsx', 'feature/login');
    });

    expect(clearStagedChanges).toHaveBeenCalledWith('proj-1', {
      branchName: 'feature/login',
      filePath: 'src/App.jsx'
    });
    expect(result.current.error).toBe('Failed to clear staged changes');
    expect(result.current.workingBranches).toHaveLength(1);
    expect(result.current.workingBranches[0].stagedFiles).toEqual([]);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  test('handleOpenFile forwards valid paths and ignores empty input', async () => {
    mockedAxios.get.mockResolvedValue({ data: createOverview() });
    const onRequestFileOpen = vi.fn();
    const props = { ...defaultProps, onRequestFileOpen };

    const { result } = renderHook(() => useBranchTabState(props));
    await waitFor(() => {
      expect(result.current.branchSummaries.length).toBeGreaterThan(0);
    });

    act(() => {
      result.current.handleOpenFile('src/App.jsx');
    });
    expect(onRequestFileOpen).toHaveBeenCalledWith('src/App.jsx');

    onRequestFileOpen.mockClear();
    act(() => {
      result.current.handleOpenFile('');
    });
    expect(onRequestFileOpen).not.toHaveBeenCalled();
  });
});
