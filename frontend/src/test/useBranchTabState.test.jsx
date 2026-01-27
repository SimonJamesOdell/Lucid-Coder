import React, { useEffect } from 'react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, act, cleanup } from '@testing-library/react';
import useBranchTabState from '../components/branch-tab/useBranchTabState';
import { useAppState } from '../context/AppStateContext';
import axios from 'axios';

vi.mock('../context/AppStateContext', () => ({
  useAppState: vi.fn()
}));

const computeStagedSignatureMock = vi.fn((files = []) => JSON.stringify(files));
const canBranchMergeMock = vi.fn(() => true);
const describeMergeBlockerMock = vi.fn(() => 'blocked');
const isPassingTestStatusMock = vi.fn((status) => status === 'passed' || status === 'skipped');

vi.mock('../components/branch-tab/utils', async () => {
  const actual = await vi.importActual('../components/branch-tab/utils');
  return {
    ...actual,
    computeStagedSignature: (...args) => computeStagedSignatureMock(...args),
    canBranchMerge: (...args) => canBranchMergeMock(...args),
    describeMergeBlocker: (...args) => describeMergeBlockerMock(...args),
    isPassingTestStatus: (...args) => isPassingTestStatusMock(...args)
  };
});

const defaultProject = { id: 'proj-hook', name: 'Hook Project' };

const buildOverview = (overrides = {}) => ({
  success: true,
  branches: [
    { name: 'main', status: 'protected', isCurrent: true, stagedFileCount: 0 }
  ],
  current: 'main',
  workingBranches: [
    { name: 'main', stagedFiles: [] }
  ],
  ...overrides
});

const buildAppState = (overrides = {}) => ({
  clearStagedChanges: vi.fn().mockResolvedValue({}),
  syncBranchOverview: vi.fn(),
  projectShutdownState: {},
  isProjectStopping: vi.fn(() => false),
  workspaceChanges: {},
  workingBranches: {},
  startAutomationJob: vi.fn().mockResolvedValue({}),
  ...overrides
});

const HookHarness = ({ hookProps, onState }) => {
  const state = useBranchTabState(hookProps);
  useEffect(() => {
    onState(state);
  }, [state, onState]);
  return null;
};

const renderHookState = async ({
  project = defaultProject,
  overviewSequence = [buildOverview()],
  appStateOverrides = {},
  hookProps = {}
} = {}) => {
  axios.get.mockReset();
  overviewSequence.forEach((payload) => {
    axios.get.mockResolvedValueOnce({ data: payload });
  });
  axios.get.mockResolvedValue({ data: overviewSequence[overviewSequence.length - 1] });

  const appState = buildAppState(appStateOverrides);
  useAppState.mockReturnValue(appState);

  let latestState;
  const handleState = (nextState) => {
    latestState = nextState;
  };

  render(
    <HookHarness
      hookProps={{ project, ...hookProps }}
      onState={handleState}
    />
  );

  await waitFor(() => {
    expect(latestState).not.toBeUndefined();
  });

  return {
    getState: () => latestState,
    appState
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  axios.post.mockResolvedValue({ data: { success: true } });
  axios.delete.mockResolvedValue({ data: { success: true } });
  canBranchMergeMock.mockImplementation(() => true);
  describeMergeBlockerMock.mockImplementation(() => 'blocked');
  isPassingTestStatusMock.mockImplementation((status) => status === 'passed' || status === 'skipped');
});

afterEach(() => {
  cleanup();
  computeStagedSignatureMock.mockClear();
  isPassingTestStatusMock.mockReset();
  useBranchTabState.__testHooks?.resetBranchFallbackName?.();
  useBranchTabState.__testHooks?.clearLatestInstance?.();
});

describe('branch selection storage helpers', () => {
  test('loadStoredBranchSelection restores persisted values and persistBranchSelection writes updates', () => {
    const {
      loadStoredBranchSelection,
      persistBranchSelection,
      buildBranchSelectionKey
    } = useBranchTabState.__testHooks;

    const storageProjectId = 'storage-proj';
    const storageKey = buildBranchSelectionKey(storageProjectId);
    const getSpy = vi.spyOn(window.localStorage, 'getItem').mockReturnValueOnce('stored-branch');
    const setSpy = vi.spyOn(window.localStorage, 'setItem');
    const removeSpy = vi.spyOn(window.localStorage, 'removeItem');

    expect(loadStoredBranchSelection(storageProjectId)).toBe('stored-branch');
    expect(getSpy).toHaveBeenCalledWith(storageKey);

    persistBranchSelection(storageProjectId, 'next-branch');
    expect(setSpy).toHaveBeenCalledWith(storageKey, 'next-branch');

    persistBranchSelection(storageProjectId, '');
    expect(removeSpy).toHaveBeenCalledWith(storageKey);

    getSpy.mockRestore();
    setSpy.mockRestore();
    removeSpy.mockRestore();
  });

  test('storage helpers guard against unavailable environments and surface warnings for failures', () => {
    const {
      loadStoredBranchSelection,
      persistBranchSelection
    } = useBranchTabState.__testHooks;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const readError = new Error('read fail');
    const writeError = new Error('write fail');
    const removeError = new Error('remove fail');

    const getSpy = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw readError;
    });
    expect(loadStoredBranchSelection('guard-proj')).toBe('');
    expect(warnSpy).toHaveBeenCalledWith('Failed to load branch selection from storage', readError);
    getSpy.mockRestore();

    const setSpy = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw writeError;
    });
    persistBranchSelection('guard-proj', 'main');
    expect(warnSpy).toHaveBeenCalledWith('Failed to persist branch selection', writeError);
    setSpy.mockRestore();

    const removeSpy = vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => {
      throw removeError;
    });
    persistBranchSelection('guard-proj', '');
    expect(warnSpy).toHaveBeenCalledWith('Failed to persist branch selection', removeError);
    removeSpy.mockRestore();

    expect(loadStoredBranchSelection(null)).toBe('');
    persistBranchSelection(null, 'ignored');

    const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const originalWindowValue = globalThis.window;
    Object.defineProperty(globalThis, 'window', { value: undefined, configurable: true });
    try {
      expect(loadStoredBranchSelection('any')).toBe('');
      persistBranchSelection('any', 'noop');
    } finally {
      if (originalWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
      } else {
        Object.defineProperty(globalThis, 'window', { value: originalWindowValue, configurable: true });
      }
    }

    warnSpy.mockRestore();
  });
});

describe('useBranchTabState targeted guards', () => {
  test('fetchBranches resolves to null when no project is selected', async () => {
    const { getState } = await renderHookState({ project: null });

    axios.get.mockClear();
    let result;
    await act(async () => {
      result = await getState().fetchBranches();
    });

    expect(result).toBeNull();
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('fetchBranches surfaces default error message when request fails', async () => {
    const { getState } = await renderHookState();

    axios.get.mockReset();
    axios.get.mockRejectedValueOnce(new Error('network down'));

    let result;
    await act(async () => {
      result = await getState().fetchBranches();
    });

    expect(result).toBeNull();
    await waitFor(() => {
      expect(getState().error).toBe('Failed to load branches');
      expect(getState().loading).toBe(false);
    });
  });

  test('fetchBranches surfaces server error message when request fails', async () => {
    const { getState } = await renderHookState();

    const apiError = Object.assign(new Error('load upstream'), {
      response: { data: { error: 'Upstream unavailable' } }
    });
    axios.get.mockReset();
    axios.get.mockRejectedValueOnce(apiError);

    await act(async () => {
      await getState().fetchBranches();
    });

    await waitFor(() => {
      expect(getState().error).toBe('Upstream unavailable');
      expect(getState().loading).toBe(false);
    });
  });

  test('fetchBranches resets loading state when request throws synchronously', async () => {
    const { getState } = await renderHookState();

    axios.get.mockReset();
    axios.get.mockImplementationOnce(() => {
      throw new Error('load sync');
    });

    await act(async () => {
      const result = await getState().fetchBranches();
      expect(result).toBeNull();
    });

    await waitFor(() => {
      expect(getState().error).toBe('Failed to load branches');
      expect(getState().loading).toBe(false);
    });
  });

  test('showShutdownBanner uses project shutdown fallback when stop hook is unavailable', async () => {
    const shutdownErrorMessage = 'Stop failed';
    const { getState } = await renderHookState({
      appStateOverrides: {
        isProjectStopping: undefined,
        projectShutdownState: {
          isStopping: true,
          projectId: defaultProject.id,
          error: shutdownErrorMessage
        }
      }
    });

    await waitFor(() => {
      expect(getState().isStoppingProject).toBe(true);
      expect(getState().showShutdownBanner).toBe(true);
      expect(getState().shutdownError).toBe(shutdownErrorMessage);
    });
  });

  test('handleDeleteBranch ignores main branch deletions', async () => {
    const { getState } = await renderHookState();

    axios.delete.mockClear();
    await act(async () => {
      await getState().handleDeleteBranch('main');
    });

    expect(axios.delete).not.toHaveBeenCalled();
  });

  test('handleDeleteBranch aborts when confirmation is declined', async () => {
    const { getState } = await renderHookState();

    const originalConfirm = window.confirm;
    window.confirm = vi.fn(() => false);

    try {
      axios.delete.mockClear();

      await act(async () => {
        await getState().handleDeleteBranch('feature-decline');
      });

      expect(window.confirm).toHaveBeenCalledTimes(1);
      expect(axios.delete).not.toHaveBeenCalled();
    } finally {
      window.confirm = originalConfirm;
    }
  });

  test('handleCreateBranch returns null when no project is selected', async () => {
    const { getState } = await renderHookState({ project: null });

    axios.post.mockClear();
    let result;
    await act(async () => {
      result = await getState().handleCreateBranch({ name: 'feature-empty' });
    });

    expect(result).toBeNull();
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('handleCreateBranch aborts while project is stopping', async () => {
    const { getState } = await renderHookState({
      appStateOverrides: { isProjectStopping: vi.fn(() => true) }
    });

    axios.post.mockClear();
    await act(async () => {
      const result = await getState().handleCreateBranch({ name: 'feature-stop' });
      expect(result).toBeNull();
    });

    expect(axios.post).not.toHaveBeenCalled();
  });

  test('handleCreateBranch refetches overview when API omits payload', async () => {
    const { getState } = await renderHookState();

    axios.get.mockClear();
    axios.post.mockResolvedValue({ data: { success: true, branch: { name: 'feature-lone' } } });

    await act(async () => {
      await getState().handleCreateBranch({ name: 'feature-lone' });
    });

    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('handleCreateBranch surfaces server errors and resets inflight state', async () => {
    const { getState } = await renderHookState();

    const apiError = Object.assign(new Error('create blocked'), {
      response: { data: { error: 'Branch already exists' } }
    });
    axios.post.mockRejectedValueOnce(apiError);

    await act(async () => {
      await expect(getState().handleCreateBranch({ name: 'feature-dup' })).rejects.toThrow('create blocked');
    });

    await waitFor(() => {
      expect(getState().error).toBe('Branch already exists');
      expect(getState().createBranchInFlight).toBe(false);
    });
  });

  test('handleCreateBranch returns null when API omits branch payload', async () => {
    const { getState } = await renderHookState();

    axios.get.mockClear();
    const overviewPayload = buildOverview({
      current: 'feature-null-branch',
      branches: [
        { name: 'main', status: 'protected', isCurrent: false },
        { name: 'feature-null-branch', status: 'active', isCurrent: true }
      ],
      workingBranches: [{ name: 'feature-null-branch', stagedFiles: [] }]
    });
    axios.post.mockResolvedValueOnce({ data: { overview: overviewPayload } });

    let result;
    await act(async () => {
      result = await getState().handleCreateBranch({ name: 'feature-null-branch' });
    });

    expect(result).toBeNull();
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('handleCreateBranch surfaces default error message when server response lacks copy', async () => {
    const { getState } = await renderHookState();

    axios.post.mockRejectedValueOnce(new Error('create unavailable'));

    await act(async () => {
      await expect(getState().handleCreateBranch({ name: 'feature-default' })).rejects.toThrow('create unavailable');
    });

    await waitFor(() => {
      expect(getState().error).toBe('Failed to create branch');
    });
  });

  test('handleCreateBranch resets inflight state when request throws synchronously', async () => {
    const { getState } = await renderHookState();

    axios.post.mockImplementationOnce(() => {
      throw new Error('create sync');
    });

    await act(async () => {
      await expect(getState().handleCreateBranch({ name: 'feature-sync' })).rejects.toThrow('create sync');
    });

    await waitFor(() => {
      expect(getState().createBranchInFlight).toBe(false);
      expect(getState().error).toBe('Failed to create branch');
    });
  });

  test('handleCreateBranch resets inflight flag after successful creation', async () => {
    const { getState } = await renderHookState();

    const overviewPayload = buildOverview({
      current: 'feature-inflight',
      branches: [
        { name: 'main', status: 'protected', isCurrent: false },
        { name: 'feature-inflight', status: 'active', isCurrent: true }
      ],
      workingBranches: [{ name: 'feature-inflight', stagedFiles: [] }]
    });

    axios.post.mockResolvedValueOnce({ data: { overview: overviewPayload, branch: { name: 'feature-inflight' } } });

    await act(async () => {
      await getState().handleCreateBranch({ name: 'feature-inflight' });
    });

    await waitFor(() => {
      expect(getState().createBranchInFlight).toBe(false);
    });
  });

  test('handleCreateBranch trims description fields and applies overview payloads', async () => {
    const { getState } = await renderHookState();

    axios.get.mockClear();
    const overviewPayload = buildOverview({
      current: 'feature-desc',
      branches: [
        { name: 'main', status: 'protected', isCurrent: false },
        { name: 'feature-desc', status: 'active', isCurrent: true }
      ],
      workingBranches: [{ name: 'feature-desc', stagedFiles: [] }]
    });
    const branchPayload = { name: 'feature-desc' };
    axios.post.mockResolvedValueOnce({ data: { overview: overviewPayload, branch: branchPayload } });

    let result;
    await act(async () => {
      result = await getState().handleCreateBranch({ name: ' feature-desc ', description: ' New feature ' });
    });

    const payloadArg = axios.post.mock.calls.find(([url]) => url.endsWith('/branches'))?.[1];
    expect(payloadArg).toEqual({ name: 'feature-desc', description: 'New feature' });
    expect(result).toEqual(branchPayload);
    expect(axios.get).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(getState().selectedBranchName).toBe('feature-desc');
    });
  });

  test('handleCheckoutBranch refetches when overview is missing', async () => {
    const { getState } = await renderHookState();

    axios.get.mockClear();
    axios.post.mockResolvedValueOnce({ data: { success: true } });

    await act(async () => {
      await getState().handleCheckoutBranch('feature-x');
    });

    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('handleCheckoutBranch surfaces default error message', async () => {
    const { getState } = await renderHookState();

    axios.post.mockRejectedValueOnce(new Error('checkout boom'));

    await act(async () => {
      await getState().handleCheckoutBranch('feature-x');
    });

    await waitFor(() => {
      expect(getState().error).toBe('Failed to switch branch');
    });
  });

  test('handleCheckoutBranch surfaces server error copy when available', async () => {
    const { getState } = await renderHookState();

    const apiError = Object.assign(new Error('server blocked'), {
      response: { data: { error: 'Checkout blocked by policy' } }
    });
    axios.post.mockRejectedValueOnce(apiError);

    await act(async () => {
      await getState().handleCheckoutBranch('feature-x');
    });

    await waitFor(() => {
      expect(getState().error).toBe('Checkout blocked by policy');
    });
  });

  test('handleDeleteBranch refetches when overview is missing', async () => {
    const { getState } = await renderHookState();

    vi.spyOn(window, 'confirm').mockReturnValue(true);

    axios.get.mockClear();
    axios.delete.mockResolvedValueOnce({ data: { success: true } });

    await act(async () => {
      await getState().handleDeleteBranch('feature-y');
    });

    expect(axios.delete).toHaveBeenCalledWith(
      expect.stringContaining('/branches/feature-y'),
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-confirm-destructive': 'true' })
      })
    );
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('handleDeleteBranch re-checks out fallback branch after deleting current branch', async () => {
    const currentBranchName = 'feature-current';
    const initialOverview = buildOverview({
      current: currentBranchName,
      branches: [
        { name: 'main', status: 'protected', isCurrent: false },
        { name: currentBranchName, status: 'active', isCurrent: true }
      ],
      workingBranches: [{ name: currentBranchName, stagedFiles: [] }]
    });
    const { getState } = await renderHookState({ overviewSequence: [initialOverview] });

    vi.spyOn(window, 'confirm').mockReturnValue(true);

    axios.delete.mockReset();
    axios.post.mockReset();
    axios.delete.mockResolvedValueOnce({ data: { success: true, overview: buildOverview() } });
    axios.post.mockResolvedValueOnce({ data: { success: true, overview: buildOverview() } });

    await waitFor(() => {
      expect(getState().selectedBranchName).toBe(currentBranchName);
    });

    await act(async () => {
      await getState().handleDeleteBranch(currentBranchName);
    });

    const checkoutCall = axios.post.mock.calls.find(([url]) => url.includes('/checkout'));
    expect(checkoutCall).toBeDefined();
    expect(checkoutCall[0]).toContain('/branches/main/checkout');
  });

  test('handleDeleteBranch defaults fallback checkout to main when API omits overview', async () => {
    const currentBranchName = 'feature-current';
    const initialOverview = buildOverview({
      current: currentBranchName,
      branches: [
        { name: 'main', status: 'protected', isCurrent: false },
        { name: currentBranchName, status: 'active', isCurrent: true }
      ],
      workingBranches: [{ name: currentBranchName, stagedFiles: [] }]
    });
    const { getState } = await renderHookState({ overviewSequence: [initialOverview] });

    vi.spyOn(window, 'confirm').mockReturnValue(true);

    axios.delete.mockReset();
    axios.post.mockReset();
    axios.delete.mockResolvedValueOnce({ data: { success: true } });
    axios.post.mockResolvedValueOnce({ data: { success: true, overview: buildOverview() } });

    await waitFor(() => {
      expect(getState().selectedBranchName).toBe(currentBranchName);
    });

    await act(async () => {
      await getState().handleDeleteBranch(currentBranchName);
    });

    const checkoutCall = axios.post.mock.calls.find(([url]) => url.includes('/checkout'));
    expect(checkoutCall).toBeDefined();
    expect(checkoutCall[0]).toContain('/branches/main/checkout');
  });

  test('handleDeleteBranch surfaces default error message', async () => {
    const { getState } = await renderHookState();

    vi.spyOn(window, 'confirm').mockReturnValue(true);

    axios.delete.mockRejectedValueOnce(new Error('delete boom'));

    await act(async () => {
      await getState().handleDeleteBranch('feature-y');
    });

    await waitFor(() => {
      expect(getState().error).toBe('Failed to delete branch');
    });
  });

  test('handleDeleteBranch surfaces server error message when available', async () => {
    const { getState } = await renderHookState();

    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const deleteError = Object.assign(new Error('delete server'), {
      response: { data: { error: 'Cannot delete branch' } }
    });
    axios.delete.mockRejectedValueOnce(deleteError);

    await act(async () => {
      await getState().handleDeleteBranch('feature-y');
    });

    await waitFor(() => {
      expect(getState().error).toBe('Cannot delete branch');
    });
  });

  test('handleClearStaged aborts when project is stopping', async () => {
    const { getState, appState } = await renderHookState({
      appStateOverrides: { isProjectStopping: vi.fn(() => true) }
    });

    await act(async () => {
      await getState().handleClearStaged('feature-hold');
    });

    expect(appState.clearStagedChanges).not.toHaveBeenCalled();
  });

  test('handleClearStaged prefers explicit branch parameter when provided', async () => {
    const { getState, appState } = await renderHookState();

    axios.get.mockClear();
    await act(async () => {
      await getState().handleClearStaged('feature-explicit');
    });

    expect(appState.clearStagedChanges).toHaveBeenCalledWith(expect.any(String), {
      branchName: 'feature-explicit'
    });
  });

  test('handleClearStaged falls back to selected branch when parameter is omitted', async () => {
    const { getState, appState } = await renderHookState();

    appState.clearStagedChanges.mockClear();
    await act(async () => {
      await getState().handleClearStaged();
    });

    expect(appState.clearStagedChanges).toHaveBeenCalledWith(expect.any(String), {
      branchName: getState().selectedBranchName
    });
  });

  test('handleClearStaged exits when no branch can be resolved', async () => {
    useBranchTabState.__testHooks?.setBranchFallbackName?.('');
    const emptyOverview = buildOverview({ branches: [], workingBranches: [], current: '' });
    const { getState, appState } = await renderHookState({
      project: null,
      overviewSequence: [emptyOverview]
    });

    appState.clearStagedChanges.mockClear();
    await act(async () => {
      await getState().handleClearStaged();
    });

    expect(appState.clearStagedChanges).not.toHaveBeenCalled();
  });

  test('handleClearStaged applies overview payloads without refetching', async () => {
    const overviewPayload = buildOverview({ current: 'feature-applied' });
    const clearStagedChanges = vi.fn().mockResolvedValue({ overview: overviewPayload });
    const { getState, appState } = await renderHookState({
      appStateOverrides: { clearStagedChanges }
    });

    appState.syncBranchOverview.mockClear();
    axios.get.mockClear();
    await act(async () => {
      await getState().handleClearStaged();
    });

    expect(clearStagedChanges).toHaveBeenCalled();
    expect(appState.syncBranchOverview).toHaveBeenCalledWith(
      defaultProject.id,
      expect.objectContaining({ current: 'feature-applied' })
    );
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('mergeOverviewWithLocalStaged overlays tracked staged files', async () => {
    const branchName = 'feature-overlay';
    const stagedFile = { path: 'src/App.jsx', source: 'editor' };
    const { appState } = await renderHookState({
      overviewSequence: [buildOverview({
        current: branchName,
        branches: [
          { name: 'main', status: 'protected', isCurrent: false },
          { name: branchName, status: 'active', isCurrent: true }
        ],
        workingBranches: [{ name: branchName, stagedFiles: [] }]
      })],
      appStateOverrides: {
        workspaceChanges: {
          [defaultProject.id]: { stagedFiles: [stagedFile] }
        },
        workingBranches: {
          [defaultProject.id]: { name: branchName }
        }
      }
    });

    const instance = useBranchTabState.__testHooks.getLatestInstance();
    expect(instance).toBeTruthy();
    const overview = buildOverview({
      current: branchName,
      workingBranches: [{ name: branchName, stagedFiles: [] }]
    });

    const syncSpy = appState.syncBranchOverview;
    syncSpy.mockClear();
    await act(async () => {
      instance.applyOverview(overview);
    });

    expect(syncSpy).toHaveBeenCalledWith(
      defaultProject.id,
      expect.objectContaining({
        workingBranches: [
          expect.objectContaining({
            name: branchName,
            stagedFiles: [stagedFile]
          })
        ]
      })
    );
  });

  test('mergeOverviewWithLocalStaged returns overview when project is missing', async () => {
    const overview = buildOverview({ workingBranches: [{ name: 'main', stagedFiles: [] }] });
    const { appState } = await renderHookState({ project: null, overviewSequence: [] });
    const instance = useBranchTabState.__testHooks.getLatestInstance();
    expect(instance).toBeTruthy();

    appState.syncBranchOverview.mockClear();
    await act(async () => {
      instance.applyOverview(overview);
    });

    expect(appState.syncBranchOverview).toHaveBeenCalledWith(undefined, overview);
  });

  test('mergeOverviewWithLocalStaged returns overview when no local staged files exist', async () => {
    const overview = buildOverview({
      current: 'feature-empty',
      branches: [
        { name: 'main', status: 'protected', isCurrent: false },
        { name: 'feature-empty', status: 'active', isCurrent: true }
      ],
      workingBranches: [{ name: 'feature-empty', stagedFiles: [] }]
    });
    const { appState } = await renderHookState({ overviewSequence: [overview] });
    const instance = useBranchTabState.__testHooks.getLatestInstance();

    appState.syncBranchOverview.mockClear();
    await act(async () => {
      instance.applyOverview(overview);
    });

    expect(appState.syncBranchOverview).toHaveBeenCalledWith(defaultProject.id, overview);
  });

  test('mergeOverviewWithLocalStaged returns overview when tracked branch cannot be determined', async () => {
    const branchA = 'feature-a';
    const branchB = 'feature-b';
    const stagedFile = { path: 'src/local.js', source: 'editor' };
    const overview = buildOverview({
      branches: [
        { name: 'main', status: 'protected', isCurrent: false },
        { name: branchA, status: 'active', isCurrent: false },
        { name: branchB, status: 'ready', isCurrent: false }
      ],
      workingBranches: [
        { name: branchA, stagedFiles: [] },
        { name: branchB, stagedFiles: [] }
      ]
    });
    const { appState } = await renderHookState({
      overviewSequence: [overview],
      appStateOverrides: {
        workspaceChanges: {
          [defaultProject.id]: { stagedFiles: [stagedFile] }
        },
        workingBranches: {}
      }
    });
    const instance = useBranchTabState.__testHooks.getLatestInstance();

    appState.syncBranchOverview.mockClear();
    await act(async () => {
      instance.applyOverview(overview);
    });

    expect(appState.syncBranchOverview).toHaveBeenCalledWith(
      defaultProject.id,
      expect.objectContaining({
        workingBranches: [
          expect.objectContaining({ name: branchA, stagedFiles: [] }),
          expect.objectContaining({ name: branchB, stagedFiles: [] })
        ]
      })
    );
  });

  test('mergeOverviewWithLocalStaged uses single entry fallback when branch context is missing', async () => {
    const branchName = 'feature-single';
    const stagedFile = { path: 'src/single.js', source: 'editor' };
    const overview = buildOverview({
      current: branchName,
      branches: [
        { name: 'main', status: 'protected', isCurrent: false },
        { name: branchName, status: 'active', isCurrent: true }
      ],
      workingBranches: [{ name: branchName, stagedFiles: [] }]
    });
    const { appState } = await renderHookState({
      overviewSequence: [overview],
      appStateOverrides: {
        workspaceChanges: {
          [defaultProject.id]: { stagedFiles: [stagedFile] }
        },
        workingBranches: {}
      }
    });
    const instance = useBranchTabState.__testHooks.getLatestInstance();

    appState.syncBranchOverview.mockClear();
    await act(async () => {
      instance.applyOverview(overview);
    });

    await waitFor(() => {
      expect(appState.syncBranchOverview).toHaveBeenCalledWith(
        defaultProject.id,
        expect.objectContaining({
          workingBranches: [
            expect.objectContaining({ name: branchName, stagedFiles: [stagedFile] })
          ]
        })
      );
    });
  });

  test('mergeOverviewWithLocalStaged only mutates targeted branch when multiple entries exist', async () => {
    const branchA = 'feature-primary';
    const branchB = 'feature-secondary';
    const stagedFile = { path: 'src/only.js', source: 'editor' };
    const overview = buildOverview({
      workingBranches: [
        { name: branchA, stagedFiles: [] },
        { name: branchB, stagedFiles: [{ path: 'src/existing.js' }] }
      ],
      branches: [
        { name: 'main', status: 'protected', isCurrent: false },
        { name: branchA, status: 'active', isCurrent: true },
        { name: branchB, status: 'ready', isCurrent: false }
      ],
      current: branchA
    });
    const { appState } = await renderHookState({
      overviewSequence: [overview],
      appStateOverrides: {
        workspaceChanges: {
          [defaultProject.id]: { stagedFiles: [stagedFile] }
        },
        workingBranches: {
          [defaultProject.id]: { name: branchA }
        }
      }
    });
    const instance = useBranchTabState.__testHooks.getLatestInstance();

    appState.syncBranchOverview.mockClear();
    await act(async () => {
      instance.applyOverview(overview);
    });

    expect(appState.syncBranchOverview).toHaveBeenCalledWith(
      defaultProject.id,
      expect.objectContaining({
        workingBranches: [
          expect.objectContaining({ name: branchA, stagedFiles: [stagedFile] }),
          expect.objectContaining({ name: branchB, stagedFiles: [{ path: 'src/existing.js' }] })
        ]
      })
    );
  });

  test('sortedBranches promotes current branch regardless of initial order', async () => {
    const overview = buildOverview({
      branches: [
        { name: 'feature-old', status: 'active', isCurrent: false },
        { name: 'feature-spare', status: 'ready', isCurrent: false },
        { name: 'main', status: 'protected', isCurrent: true }
      ],
      workingBranches: [
        { name: 'feature-old', stagedFiles: [] },
        { name: 'feature-spare', stagedFiles: [] },
        { name: 'main', stagedFiles: [] }
      ]
    });
    const { getState } = await renderHookState({ overviewSequence: [overview] });

    await waitFor(() => {
      expect(getState().sortedBranches[0].name).toBe('main');
    });
  });

  test('sortedBranches falls back to branch order when no entries are marked current', async () => {
    const overview = buildOverview({
      branches: [
        { name: 'main', status: 'protected', isCurrent: false },
        { name: 'beta', status: 'active', isCurrent: false },
        { name: 'alpha', status: 'ready', isCurrent: false }
      ],
      workingBranches: [
        { name: 'main', stagedFiles: [] },
        { name: 'beta', stagedFiles: [] },
        { name: 'alpha', stagedFiles: [] }
      ],
      current: ''
    });
    const { getState } = await renderHookState({ overviewSequence: [overview] });

    await waitFor(() => {
      expect(getState().sortedBranches.map((branch) => branch.name)).toEqual(['alpha', 'beta', 'main']);
    });
  });

  test('sortedBranches uses order fallback when summaries omit ordering metadata', async () => {
    const { getState } = await renderHookState();
    const latestInstance = useBranchTabState.__testHooks.getLatestInstance();

    await act(async () => {
      latestInstance.setBranchSummaries([
        { name: 'beta', status: 'active', isCurrent: false },
        { name: 'alpha', status: 'ready', isCurrent: false, order: 5 }
      ]);
    });

    await waitFor(() => {
      expect(getState().sortedBranches.map((branch) => branch.name)).toEqual(['alpha', 'beta']);
    });
  });

  test('sortedBranches preserves insertion order when all entries lack ordering metadata', async () => {
    const { getState } = await renderHookState();
    const latestInstance = useBranchTabState.__testHooks.getLatestInstance();

    await act(async () => {
      latestInstance.setBranchSummaries([
        { name: 'alpha', status: 'ready', isCurrent: false },
        { name: 'beta', status: 'active', isCurrent: false }
      ]);
    });

    await waitFor(() => {
      expect(getState().sortedBranches.map((branch) => branch.name)).toEqual(['alpha', 'beta']);
    });
  });

  test('selectedFiles falls back to local staged files when remote state is empty', async () => {
    const branchName = 'feature-local';
    const stagedFile = { path: 'src/local.js', source: 'editor' };
    const overview = buildOverview({
      current: branchName,
      branches: [
        { name: 'main', status: 'protected', isCurrent: false },
        { name: branchName, status: 'active', isCurrent: true }
      ],
      workingBranches: [{ name: 'main', stagedFiles: [] }]
    });
    const { getState } = await renderHookState({
      overviewSequence: [overview],
      appStateOverrides: {
        workspaceChanges: {
          [defaultProject.id]: { stagedFiles: [stagedFile] }
        },
        workingBranches: {
          [defaultProject.id]: { name: branchName }
        }
      }
    });

    await act(async () => {
      getState().setSelectedBranch(branchName);
    });

    await waitFor(() => {
      expect(getState().selectedFiles).toEqual([stagedFile]);
      expect(getState().hasSelectedFiles).toBe(true);
    });
  });

  test('selectedFiles falls back to local staged files when remote stagedFiles is an empty array', async () => {
    const branchName = 'feature-empty-remote';
    const stagedFile = { path: 'src/empty-remote.js', source: 'editor' };
    const overview = buildOverview({
      current: branchName,
      branches: [
        { name: 'main', status: 'protected', isCurrent: false },
        { name: branchName, status: 'active', isCurrent: true }
      ],
      workingBranches: [
        { name: 'main', stagedFiles: [] },
        { name: branchName, stagedFiles: [] }
      ]
    });

    const { getState } = await renderHookState({
      overviewSequence: [overview],
      appStateOverrides: {
        workspaceChanges: {
          [defaultProject.id]: { stagedFiles: [stagedFile] }
        },
        workingBranches: {
          [defaultProject.id]: { name: branchName }
        }
      }
    });

    await act(async () => {
      getState().setSelectedBranch(branchName);
    });

    await waitFor(() => {
      expect(getState().selectedFiles).toEqual([stagedFile]);
      expect(getState().hasSelectedFiles).toBe(true);
    });
  });

  test('staged signature changes mark branch as invalidated', async () => {
    const initialOverview = buildOverview({
      workingBranches: [
        {
          name: 'main',
          lastTestStatus: 'passed',
          stagedFiles: [{ path: 'README.md', source: 'editor', timestamp: '2025-01-01T00:00:00.000Z' }]
        }
      ]
    });

    const { getState } = await renderHookState({ overviewSequence: [initialOverview] });

    await waitFor(() => {
      expect(getState().selectedFiles.length).toBe(1);
    });

    const updatedOverview = buildOverview({
      workingBranches: [
        {
          name: 'main',
          lastTestStatus: 'passed',
          stagedFiles: [{ path: 'src/app.jsx', source: 'editor', timestamp: '2025-01-02T00:00:00.000Z' }]
        }
      ]
    });

    axios.get.mockResolvedValue({ data: updatedOverview });

    await act(async () => {
      await getState().fetchBranches();
    });

    await waitFor(() => {
      expect(getState().branchTestValidity.main?.invalidated).toBe(true);
    });
  });

  test('markBranchInvalidated ignores falsy branch names', async () => {
    const { getState } = await renderHookState();

    await act(async () => {
      getState().markBranchInvalidated('main');
    });
    await waitFor(() => {
      expect(getState().branchTestValidity.main?.invalidated).toBe(true);
    });

    await act(async () => {
      getState().markBranchInvalidated('');
    });

    await waitFor(() => {
      expect(getState().branchTestValidity.main?.invalidated).toBe(true);
    });
  });

  test('markBranchValidated ignores falsy branch names', async () => {
    const { getState } = await renderHookState();

    await act(async () => {
      getState().markBranchValidated('main');
    });
    await waitFor(() => {
      expect(getState().branchTestValidity.main?.invalidated).toBe(false);
    });

    await act(async () => {
      getState().markBranchValidated('');
    });

    await waitFor(() => {
      expect(getState().branchTestValidity.main?.invalidated).toBe(false);
    });
  });

  test('markBranchInvalidated reuses prior validity map when state already invalidated', async () => {
    const { getState } = await renderHookState();

    await act(async () => {
      getState().markBranchInvalidated('main');
    });
    await waitFor(() => {
      expect(getState().branchTestValidity.main?.invalidated).toBe(true);
    });

    const priorValidity = getState().branchTestValidity;
    await act(async () => {
      getState().markBranchInvalidated('main');
    });

    expect(getState().branchTestValidity).toBe(priorValidity);
  });

  test('markBranchValidated reuses prior validity map when state already validated', async () => {
    const { getState } = await renderHookState();

    await act(async () => {
      getState().markBranchValidated('main');
    });
    await waitFor(() => {
      expect(getState().branchTestValidity.main?.invalidated).toBe(false);
    });

    const priorValidity = getState().branchTestValidity;
    await act(async () => {
      getState().markBranchValidated('main');
    });

    expect(getState().branchTestValidity).toBe(priorValidity);
  });

  test('staged signature watcher short-circuits when branch fallback is empty', async () => {
    useBranchTabState.__testHooks?.setBranchFallbackName?.('');
    const { getState } = await renderHookState({ project: null, overviewSequence: [] });

    computeStagedSignatureMock.mockClear();

    await act(async () => {
      getState().setSelectedBranch('');
    });

    await waitFor(() => {
      expect(computeStagedSignatureMock).not.toHaveBeenCalled();
    });
  });

  test('branches auto-validate when no staged files remain after passing tests', async () => {
    const overview = buildOverview({
      workingBranches: [
        {
          name: 'main',
          stagedFiles: [],
          lastTestStatus: 'passed'
        }
      ]
    });

    const { getState } = await renderHookState({ overviewSequence: [overview] });

    await waitFor(() => {
      expect(getState().branchTestValidity.main?.invalidated).toBe(false);
    });
  });

  test('handleCommitBranch refetches when commit response lacks overview', async () => {
    const { getState } = await renderHookState();

    axios.get.mockClear();
    axios.post.mockResolvedValueOnce({ data: { success: true } });

    await act(async () => {
      await getState().handleCommitBranch('main');
    });

    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('handleCommitBranch applies overview payloads and clears commit drafts', async () => {
    const commitOverview = buildOverview({
      current: 'feature-commit',
      branches: [
        { name: 'main', status: 'protected', isCurrent: false },
        { name: 'feature-commit', status: 'active', isCurrent: true }
      ],
      workingBranches: [{ name: 'feature-commit', stagedFiles: [] }]
    });
    const getCommitMessageForBranch = vi.fn(() => ' Draft message ');
    const clearCommitMessageForBranch = vi.fn();
    const { getState, appState } = await renderHookState({
      hookProps: { getCommitMessageForBranch, clearCommitMessageForBranch }
    });

    axios.post.mockReset();
    axios.post.mockResolvedValueOnce({ data: { overview: commitOverview } });
    axios.get.mockClear();
    appState.syncBranchOverview.mockClear();

    await act(async () => {
      await getState().handleCommitBranch('main');
    });

    expect(getCommitMessageForBranch).toHaveBeenCalledWith('main');
    expect(clearCommitMessageForBranch).toHaveBeenCalledWith('main');
    expect(axios.get).not.toHaveBeenCalled();
    expect(appState.syncBranchOverview).toHaveBeenCalledWith(
      defaultProject.id,
      expect.objectContaining({ current: 'feature-commit' })
    );
  });

  test('handleCommitBranch surfaces default error message when commit fails', async () => {
    const { getState } = await renderHookState();

    axios.post.mockRejectedValueOnce(new Error('commit boom'));

    await act(async () => {
      await getState().handleCommitBranch('main');
    });

    await waitFor(() => {
      expect(getState().error).toBe('Failed to commit staged changes');
    });
  });

  test('handleCommitBranch surfaces server-provided error messages', async () => {
    const { getState } = await renderHookState();

    const apiError = Object.assign(new Error('commit rejected'), {
      response: { data: { error: 'Commit refused by policy' } }
    });
    axios.post.mockRejectedValueOnce(apiError);

    await act(async () => {
      await getState().handleCommitBranch('main');
    });

    await waitFor(() => {
      expect(getState().error).toBe('Commit refused by policy');
    });
  });

  test('handleCommitBranch exits early when branch name is missing', async () => {
    const { getState } = await renderHookState();

    axios.post.mockClear();
    await act(async () => {
      await getState().handleCommitBranch('');
    });

    expect(axios.post).not.toHaveBeenCalled();
  });

  test('handleRunTests exits early when branch name is missing', async () => {
    const { getState } = await renderHookState();

    axios.post.mockClear();
    let result;
    await act(async () => {
      result = await getState().handleRunTests('');
    });

    expect(result).toBeNull();
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('handleRunTests surfaces server errors when available', async () => {
    const { getState } = await renderHookState();

    const apiError = Object.assign(new Error('tests blocked'), {
      response: { data: { error: 'Tests cannot run right now' } }
    });
    axios.post.mockRejectedValueOnce(apiError);

    await act(async () => {
      await expect(getState().handleRunTests('main')).rejects.toThrow('tests blocked');
    });

    await waitFor(() => {
      expect(getState().error).toBe('Tests cannot run right now');
    });
  });

  test('handleRunTests surfaces default error message when server copy is missing', async () => {
    const { getState } = await renderHookState();

    axios.post.mockRejectedValueOnce(new Error('tests offline'));

    await act(async () => {
      await expect(getState().handleRunTests('main')).rejects.toThrow('tests offline');
    });

    await waitFor(() => {
      expect(getState().error).toBe('Failed to run tests');
    });
  });

  test('handleRunTests clears inflight state when request throws synchronously', async () => {
    const { getState } = await renderHookState();

    axios.post.mockImplementationOnce(() => {
      throw new Error('tests sync');
    });

    await act(async () => {
      await expect(getState().handleRunTests('main')).rejects.toThrow('tests sync');
    });

    await waitFor(() => {
      expect(getState().testInFlight).toBeNull();
      expect(getState().error).toBe('Failed to run tests');
    });
  });

  test('handleRunTests activates tests tab callback and resets inflight state after success', async () => {
    const onRequestTestsTab = vi.fn();
    const { getState } = await renderHookState({ hookProps: { onRequestTestsTab } });

    axios.post.mockReset();
    axios.get.mockClear();
    axios.post.mockResolvedValueOnce({ data: { testRun: { status: 'passed' } } });
    axios.get.mockResolvedValueOnce({ data: buildOverview() });

    await act(async () => {
      await getState().handleRunTests('main');
    });

    expect(onRequestTestsTab).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(getState().testInFlight).toBeNull();
      expect(getState().branchTestValidity.main?.invalidated).toBe(false);
    });
  });

  test('handleRunTests navigates to commits tab when configured and tests pass', async () => {
    const onRequestCommitsTab = vi.fn();
    const { getState } = await renderHookState({ hookProps: { onRequestCommitsTab } });

    axios.post.mockReset();
    axios.get.mockClear();
    axios.post.mockResolvedValueOnce({ data: { testRun: { status: 'passed' } } });
    axios.get.mockResolvedValueOnce({ data: buildOverview() });

    await act(async () => {
      await getState().handleRunTests('main', { navigateToCommitsOnPass: true });
    });

    expect(onRequestCommitsTab).toHaveBeenCalledTimes(1);
  });

  test('handleTestAndMerge ignores requests without branch names', async () => {
    const { getState } = await renderHookState();

    axios.post.mockClear();
    await act(async () => {
      await getState().handleTestAndMerge('');
    });

    expect(axios.post).not.toHaveBeenCalled();
  });

  test('handleTestAndMerge warns when tests fail before merge', async () => {
    const { getState } = await renderHookState();

    axios.post.mockClear();
    axios.get.mockClear();
    axios.post.mockResolvedValueOnce({ data: { testRun: { status: 'failed' } } });
    axios.get.mockResolvedValueOnce({ data: buildOverview() });

    await act(async () => {
      await getState().handleTestAndMerge('main');
    });

    await waitFor(() => {
      expect(getState().mergeWarning).toBe('Tests must pass before merge');
    });
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  test('handleTestAndMerge surfaces commit errors before merge', async () => {
    const branchName = 'feature-commit-failure';
    const stagedOverview = buildOverview({
      current: branchName,
      branches: [{ name: branchName, status: 'active', isCurrent: true }],
      workingBranches: [
        {
          name: branchName,
          stagedFiles: [{ path: 'src/app.jsx', source: 'editor' }]
        }
      ]
    });
    const { getState } = await renderHookState({ overviewSequence: [stagedOverview] });

    axios.post.mockReset();
    axios.get.mockReset();
    axios.post.mockResolvedValueOnce({ data: { testRun: { status: 'passed' }, overview: stagedOverview } });
    const commitError = Object.assign(new Error('commit blocked'), {
      response: { data: { error: 'Commit blocked before merge' } }
    });
    axios.post.mockRejectedValueOnce(commitError);

    await act(async () => {
      await getState().handleTestAndMerge(branchName);
    });

    await waitFor(() => {
      expect(getState().mergeWarning).toBe('Commit blocked before merge');
    });

    expect(axios.post.mock.calls.some(([url]) => url.includes('/merge'))).toBe(false);
  });

  test('handleTestAndMerge refetches overview when run result lacks overview', async () => {
    const { getState } = await renderHookState();

    axios.post.mockClear();
    axios.get.mockClear();

    axios.post.mockResolvedValueOnce({ data: { testRun: { status: 'passed' } } });
    axios.post.mockResolvedValueOnce({ data: { success: true, overview: buildOverview() } });
    axios.get.mockRejectedValueOnce(new Error('overview missing'));
    axios.get.mockResolvedValueOnce({ data: buildOverview() });

    await act(async () => {
      await getState().handleTestAndMerge('main');
    });

    await waitFor(() => {
      expect(axios.get).toHaveBeenCalledTimes(2);
    });
  });

  test('handleTestAndMerge commits staged files before surfacing merge blockers', async () => {
    const branchName = 'feature-commit';
    const stagedOverview = buildOverview({
      current: branchName,
      branches: [{ name: branchName, status: 'active', isCurrent: true }],
      workingBranches: [
        {
          name: branchName,
          stagedFiles: [{ path: 'src/app.jsx', source: 'editor' }]
        }
      ]
    });
    const { getState } = await renderHookState({ overviewSequence: [stagedOverview] });

    axios.post.mockClear();
    axios.get.mockClear();

    axios.post.mockResolvedValueOnce({ data: { testRun: { status: 'passed' } } });
    axios.get.mockResolvedValueOnce({ data: stagedOverview });
    axios.post.mockResolvedValueOnce({ data: { overview: stagedOverview } });

    canBranchMergeMock.mockReturnValue(false);
    describeMergeBlockerMock.mockReturnValue('blocked reason');

    await act(async () => {
      await getState().handleTestAndMerge(branchName);
    });

    await waitFor(() => {
      expect(getState().mergeWarning).toBe('blocked reason');
    });

    const commitCall = axios.post.mock.calls.find(([url]) => url.includes('/commit'));
    expect(commitCall).toBeTruthy();
    expect(axios.post.mock.calls.some(([url]) => url.includes('/merge'))).toBe(false);
  });

  test('handleTestAndMerge surfaces merge errors when automation fails', async () => {
    const { getState } = await renderHookState();

    axios.post.mockClear();
    axios.post.mockRejectedValueOnce(new Error('tests down'));

    await act(async () => {
      await getState().handleTestAndMerge('main');
    });

    await waitFor(() => {
      expect(getState().error).toBe('Failed to merge branch');
    });
  });

  test('handleTestAndMerge falls back to working branch test status when run result omits status', async () => {
    const branchName = 'feature-legacy-test-status';
    const overview = buildOverview({
      current: branchName,
      branches: [
        { name: 'main', status: 'protected', isCurrent: false },
        { name: branchName, status: 'ready-for-merge', isCurrent: true }
      ],
      workingBranches: [
        {
          name: branchName,
          status: 'ready-for-merge',
          lastTestStatus: 'legacy-pass',
          stagedFiles: []
        }
      ]
    });
    const { getState } = await renderHookState({ overviewSequence: [overview] });

    axios.post.mockReset();
    axios.get.mockReset();

    axios.post
      .mockResolvedValueOnce({ data: { overview } })
      .mockResolvedValueOnce({ data: { success: true, overview: buildOverview() } });

    isPassingTestStatusMock.mockImplementation(() => true);

    let capturedBranch = null;
    canBranchMergeMock.mockImplementation((branch) => {
      capturedBranch = branch;
      return true;
    });

    await act(async () => {
      await getState().handleTestAndMerge(branchName);
    });

    expect(capturedBranch?.lastTestStatus).toBe('legacy-pass');
    const mergeCalls = axios.post.mock.calls.filter(([url]) => url.includes(`/branches/${branchName}/merge`));
    expect(mergeCalls).toHaveLength(1);
  });

  test('handleTestAndMerge treats legacy status field as authoritative', async () => {
    const branchName = 'feature-legacy-status';
    const overview = buildOverview({
      current: branchName,
      branches: [
        { name: 'main', status: 'protected', isCurrent: false },
        { name: branchName, status: 'active', isCurrent: true }
      ],
      workingBranches: [{ name: branchName, stagedFiles: [] }]
    });
    const { getState } = await renderHookState({ overviewSequence: [overview] });

    axios.post.mockReset();
    axios.get.mockClear();
    axios.post.mockResolvedValueOnce({ data: { status: 'passed' } });
    axios.get.mockResolvedValueOnce({ data: overview });
    axios.post.mockResolvedValueOnce({ data: { success: true, overview } });

    await act(async () => {
      await getState().handleTestAndMerge(branchName);
    });

    expect(axios.post.mock.calls.some(([url]) => url.includes('/merge'))).toBe(true);
    await waitFor(() => {
      expect(getState().mergeWarning).toBeNull();
    });
  });

  test('handleTestAndMerge falls back to lastTestStatus when other fields are missing', async () => {
    const { getState } = await renderHookState();

    axios.post.mockReset();
    axios.get.mockClear();
    axios.post.mockResolvedValueOnce({ data: { lastTestStatus: 'failed' } });
    axios.get.mockResolvedValueOnce({ data: buildOverview() });

    await act(async () => {
      await getState().handleTestAndMerge('main');
    });

    await waitFor(() => {
      expect(getState().mergeWarning).toBe('Tests must pass before merge');
    });
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  test('handleTestAndMerge falls back to cached working branches when overview lacks entries', async () => {
    const branchName = 'feature-cached-branch';
    const cachedBranch = { name: branchName, stagedFiles: [], marker: 'cached-branch' };
    const overview = buildOverview({
      current: branchName,
      branches: [
        { name: 'main', status: 'protected', isCurrent: false },
        { name: branchName, status: 'active', isCurrent: true }
      ],
      workingBranches: [cachedBranch]
    });
    const { getState } = await renderHookState({ overviewSequence: [overview] });

    const latestInstance = useBranchTabState.__testHooks.getLatestInstance();
    await act(async () => {
      latestInstance?.setWorkingBranches([]);
    });

    axios.post.mockReset();
    axios.get.mockClear();
    axios.post.mockResolvedValueOnce({ data: { status: 'passed' } });
    axios.get.mockResolvedValueOnce({ data: buildOverview({ workingBranches: [] }) });
    axios.post.mockResolvedValueOnce({ data: { success: true, overview } });

    let fallbackUsed = false;
    canBranchMergeMock.mockImplementation((branch) => {
      if (branch?.marker === 'cached-branch') {
        fallbackUsed = true;
      }
      return true;
    });

    await act(async () => {
      await getState().handleTestAndMerge(branchName);
    });

    expect(fallbackUsed).toBe(true);
    expect(axios.post.mock.calls.some(([url]) => url.includes('/merge'))).toBe(true);
  });

  test('handleTestAndMerge prefers current working branch context when available', async () => {
    const branchName = 'feature-live-branch';
    const liveBranch = { name: branchName, stagedFiles: [], marker: 'live-current' };
    const overview = buildOverview({
      current: branchName,
      branches: [
        { name: 'main', status: 'protected', isCurrent: false },
        { name: branchName, status: 'active', isCurrent: true }
      ],
      workingBranches: [liveBranch]
    });
    const { getState } = await renderHookState({ overviewSequence: [overview] });

    axios.post.mockReset();
    axios.post
      .mockResolvedValueOnce({ data: { testRun: { status: 'passed' }, overview } })
      .mockResolvedValueOnce({ data: { success: true, overview } });

    let receivedMarker = null;
    canBranchMergeMock.mockImplementation((branch) => {
      receivedMarker = branch?.marker || null;
      return true;
    });

    await act(async () => {
      await getState().handleTestAndMerge(branchName);
    });

    expect(receivedMarker).toBe('live-current');
    expect(axios.post.mock.calls.some(([url]) => url.includes('/merge'))).toBe(true);
  });

  test('getCachedWorkingBranch returns null for falsy branch names', async () => {
    await renderHookState();

    const helper = useBranchTabState.__testHooks.getCachedWorkingBranch;
    expect(helper('')).toBeNull();
    expect(helper()).toBeNull();
  });

  test('getCachedWorkingBranch falls back to the last cached snapshot when working branches are empty', async () => {
    const branchName = 'feature-cached-helper';
    const cachedBranch = { name: branchName, stagedFiles: [], marker: 'cached-helper' };
    const overview = buildOverview({
      current: branchName,
      branches: [
        { name: 'main', status: 'protected', isCurrent: false },
        { name: branchName, status: 'active', isCurrent: true }
      ],
      workingBranches: [cachedBranch]
    });

    await renderHookState({ overviewSequence: [overview] });

    const instance = useBranchTabState.__testHooks.getLatestInstance();
    await act(async () => {
      await instance.setWorkingBranches([]);
    });

    const helper = useBranchTabState.__testHooks.getCachedWorkingBranch;
    expect(helper(branchName)?.marker).toBe('cached-helper');
    expect(helper('feature-missing-cache')).toBeNull();
  });

  test('handleTestAndMerge reuses cached overview when commit response lacks payload', async () => {
    const branchName = 'feature-commit-reuse';
    const stagedOverview = buildOverview({
      current: branchName,
      branches: [
        { name: 'main', status: 'protected', isCurrent: false },
        { name: branchName, status: 'active', isCurrent: true }
      ],
      workingBranches: [
        { name: branchName, stagedFiles: [{ path: 'src/file.js', source: 'editor' }] }
      ]
    });
    const { getState } = await renderHookState({ overviewSequence: [stagedOverview] });

    axios.post.mockReset();
    axios.get.mockClear();

    axios.post.mockResolvedValueOnce({ data: { testRun: { status: 'passed' } } });
    axios.get.mockResolvedValueOnce({ data: stagedOverview });
    axios.post.mockResolvedValueOnce({ data: { success: true } });
    axios.post.mockResolvedValueOnce({ data: { success: true, overview: buildOverview() } });

    await act(async () => {
      await getState().handleTestAndMerge(branchName);
    });

    const overviewCalls = axios.get.mock.calls.filter(([url]) => typeof url === 'string' && !url.includes('/css-only'));
    expect(overviewCalls).toHaveLength(1);
  });

  test('handleTestAndMerge refetches overview when commit response and cached data are missing', async () => {
    const branchName = 'feature-commit-refetch';
    const stagedBranch = {
      name: branchName,
      stagedFiles: [{ path: 'src/file.js', source: 'editor' }]
    };
    const initialOverview = buildOverview({
      current: branchName,
      branches: [
        { name: 'main', status: 'protected', isCurrent: false },
        { name: branchName, status: 'active', isCurrent: true }
      ],
      workingBranches: [stagedBranch]
    });
    const { getState } = await renderHookState({ overviewSequence: [initialOverview] });

    axios.post.mockReset();
    axios.get.mockClear();

    axios.post.mockResolvedValueOnce({ data: { testRun: { status: 'passed' } } });
    axios.get.mockRejectedValueOnce(new Error('initial overview missing'));
    axios.get.mockRejectedValueOnce(new Error('refetch missing'));
    axios.post.mockResolvedValueOnce({ data: { success: true } });
    axios.get.mockResolvedValueOnce({
      data: buildOverview({ workingBranches: [{ name: branchName, stagedFiles: [] }] })
    });
    axios.post.mockResolvedValueOnce({ data: { success: true, overview: buildOverview() } });

    await act(async () => {
      await getState().handleTestAndMerge(branchName);
    });

    const overviewCalls = axios.get.mock.calls.filter(([url]) => typeof url === 'string' && !url.includes('/css-only'));
    expect(overviewCalls).toHaveLength(3);
  });

  test('handleTestAndMerge refetches overview after commit when overview is missing', async () => {
    const branchName = 'feature-commit-null-overview';
    const stagedBranch = {
      name: branchName,
      stagedFiles: [{ path: 'src/file.js', source: 'editor' }]
    };

    const initialOverview = buildOverview({
      current: branchName,
      branches: [
        { name: 'main', status: 'protected', isCurrent: false },
        { name: branchName, status: 'active', isCurrent: true }
      ],
      workingBranches: [stagedBranch]
    });

    const { getState } = await renderHookState({ overviewSequence: [initialOverview] });

    axios.post.mockReset();
    axios.get.mockClear();

    // run tests succeeds but returns no overview
    axios.post.mockResolvedValueOnce({ data: { testRun: { status: 'passed' } } });
    // handleRunTests always fetches branches; keep it null
    axios.get.mockResolvedValueOnce({ data: null });
    // handleTestAndMerge then attempts its own refetch; keep it null so it falls back to cached workingBranches
    axios.get.mockResolvedValueOnce({ data: null });
    // commit succeeds but returns no overview
    axios.post.mockResolvedValueOnce({ data: { success: true } });
    // post-commit refetch returns a valid overview
    axios.get.mockResolvedValueOnce({
      data: buildOverview({ workingBranches: [{ name: branchName, stagedFiles: [] }] })
    });
    // merge succeeds and returns overview to avoid extra refetch
    axios.post.mockResolvedValueOnce({ data: { success: true, overview: buildOverview() } });

    await act(async () => {
      await getState().handleTestAndMerge(branchName);
    });

    const overviewCalls = axios.get.mock.calls.filter(([url]) => typeof url === 'string' && !url.includes('/css-only'));
    // Three fetches: handleRunTests always fetches once, then handleTestAndMerge refetches before commit,
    // and finally refetches again after commit when nextOverview is still null.
    expect(overviewCalls).toHaveLength(3);
  });

  test('handleTestAndMerge fetches overview inside commit block when earlier fetches return null', async () => {
    const branchName = 'feature-commit-inline-refetch';
    const stagedBranch = {
      name: branchName,
      stagedFiles: [{ path: 'src/file.js', source: 'editor' }]
    };
    const stagedOverview = buildOverview({
      current: branchName,
      branches: [
        { name: 'main', status: 'protected', isCurrent: false },
        { name: branchName, status: 'active', isCurrent: true }
      ],
      workingBranches: [stagedBranch]
    });
    const { getState } = await renderHookState({ overviewSequence: [stagedOverview] });

    axios.post.mockReset();
    axios.get.mockReset();

    axios.post
      .mockResolvedValueOnce({ data: { testRun: { status: 'passed' } } })
      .mockResolvedValueOnce({ data: { success: true } })
      .mockResolvedValueOnce({ data: { success: true, overview: buildOverview() } });

    const unstagedOverview = buildOverview({
      current: branchName,
      branches: [
        { name: 'main', status: 'protected', isCurrent: false },
        { name: branchName, status: 'active', isCurrent: true }
      ],
      workingBranches: [{ name: branchName, stagedFiles: [] }]
    });

    axios.get
      .mockResolvedValueOnce({ data: null })
      .mockResolvedValueOnce({ data: null })
      .mockResolvedValueOnce({ data: unstagedOverview });

    await act(async () => {
      await getState().handleTestAndMerge(branchName);
    });

    const overviewCalls = axios.get.mock.calls.filter(([url]) => typeof url === 'string' && !url.includes('/css-only'));
    await waitFor(() => {
      expect(overviewCalls).toHaveLength(3);
    });
    expect(getState().mergeWarning).toBeNull();
    expect(
      axios.post.mock.calls.filter(([url]) => url.includes(`/branches/${branchName}/merge`))
    ).toHaveLength(1);
  });

  test('handleTestAndMerge refetches overview inside commit block when nextOverview stays null', async () => {
    const branchName = 'feature-commit-fetch-after-null';
    const stagedBranch = {
      name: branchName,
      stagedFiles: [{ path: 'src/file.js', source: 'editor' }]
    };
    const initialOverview = buildOverview({
      current: branchName,
      branches: [
        { name: 'main', status: 'protected', isCurrent: false },
        { name: branchName, status: 'active', isCurrent: true }
      ],
      workingBranches: [stagedBranch]
    });

    const { getState } = await renderHookState({ overviewSequence: [initialOverview] });

    axios.post.mockReset();
    axios.get.mockClear();

    axios.post.mockResolvedValueOnce({ data: { testRun: { status: 'passed' } } });
    axios.get.mockResolvedValueOnce({ data: null });
    axios.post.mockResolvedValueOnce({ data: { success: true } });
    axios.get.mockResolvedValueOnce({ data: buildOverview({ workingBranches: [{ name: branchName, stagedFiles: [] }] }) });
    axios.post.mockResolvedValueOnce({ data: { success: true, overview: buildOverview() } });

    await act(async () => {
      await getState().handleTestAndMerge(branchName);
    });

    const overviewCalls = axios.get.mock.calls.filter(([url]) => typeof url === 'string' && !url.includes('/css-only'));
    expect(overviewCalls.length).toBeGreaterThanOrEqual(2);
    expect(overviewCalls[1]).toBeDefined();
  });

  test('handleTestAndMerge retains cached working branches when commit overview omits entries', async () => {
    const branchName = 'feature-commit-fallback';
    const cachedBranch = {
      name: branchName,
      stagedFiles: [{ path: 'src/file.js', source: 'editor' }],
      marker: 'commit-fallback'
    };
    const stagedOverview = buildOverview({
      current: branchName,
      branches: [
        { name: 'main', status: 'protected', isCurrent: false },
        { name: branchName, status: 'active', isCurrent: true }
      ],
      workingBranches: [cachedBranch]
    });
    const { getState } = await renderHookState({ overviewSequence: [stagedOverview] });

    axios.post.mockReset();
    axios.get.mockClear();

    axios.post.mockResolvedValueOnce({ data: { testRun: { status: 'passed' } } });
    axios.get.mockResolvedValueOnce({ data: stagedOverview });
    axios.post.mockResolvedValueOnce({ data: { overview: buildOverview({ workingBranches: [] }) } });
    axios.post.mockResolvedValueOnce({ data: { success: true, overview: buildOverview() } });

    let fallbackUsed = false;
    canBranchMergeMock.mockImplementation((branch) => {
      if (branch?.marker === 'commit-fallback') {
        fallbackUsed = true;
      }
      return true;
    });

    await act(async () => {
      await getState().handleTestAndMerge(branchName);
    });

    expect(fallbackUsed).toBe(true);
  });

  test('handleTestAndMerge uses working branch from commit overview when available', async () => {
    const branchName = 'feature-commit-branch-update';
    const initialBranch = {
      name: branchName,
      stagedFiles: [{ path: 'src/file.js', source: 'editor' }],
      marker: 'initial'
    };
    const stagedOverview = buildOverview({
      current: branchName,
      branches: [
        { name: 'main', status: 'protected', isCurrent: false },
        { name: branchName, status: 'active', isCurrent: true }
      ],
      workingBranches: [initialBranch]
    });
    const { getState } = await renderHookState({ overviewSequence: [stagedOverview] });

    axios.post.mockReset();
    axios.get.mockClear();

    axios.post.mockResolvedValueOnce({ data: { testRun: { status: 'passed' } } });
    axios.get.mockResolvedValueOnce({ data: stagedOverview });

    const commitOverview = buildOverview({
      current: branchName,
      branches: [
        { name: 'main', status: 'protected', isCurrent: false },
        { name: branchName, status: 'active', isCurrent: true }
      ],
      workingBranches: [
        { name: branchName, stagedFiles: [], marker: 'from-commit' }
      ]
    });
    axios.post.mockResolvedValueOnce({ data: { overview: commitOverview } });
    axios.post.mockResolvedValueOnce({ data: { success: true, overview: buildOverview() } });

    let sawCommittedBranch = false;
    canBranchMergeMock.mockImplementation((branch) => {
      if (branch?.marker === 'from-commit') {
        sawCommittedBranch = true;
      }
      return true;
    });

    await act(async () => {
      await getState().handleTestAndMerge(branchName);
    });

    expect(sawCommittedBranch).toBe(true);
    expect(axios.post.mock.calls.some(([url]) => url.includes('/merge'))).toBe(true);
  });

  test('handleTestAndMerge proceeds when working branch context is missing', async () => {
    const branchName = 'feature-orphan';
    const overview = buildOverview({
      branches: [
        { name: 'main', status: 'protected', isCurrent: true }
      ],
      workingBranches: []
    });
    const { getState } = await renderHookState({ overviewSequence: [overview] });

    axios.post.mockReset();
    axios.get.mockClear();

    axios.post.mockResolvedValueOnce({ data: { testRun: { status: 'passed' }, overview } });
    axios.get.mockResolvedValueOnce({ data: overview });
    axios.post.mockResolvedValueOnce({ data: { success: true, overview: buildOverview() } });

    await act(async () => {
      await getState().handleTestAndMerge(branchName);
    });

    const mergeCalls = axios.post.mock.calls.filter(([url]) => url.includes(`/branches/${branchName}/merge`));
    expect(mergeCalls).toHaveLength(1);
  });

  test('handleTestAndMerge surfaces merge blockers when working branch cannot be derived', async () => {
    const emptyOverview = buildOverview({ workingBranches: [] });
    const { getState } = await renderHookState({ overviewSequence: [buildOverview(), emptyOverview] });

    axios.post.mockReset();
    axios.post.mockResolvedValueOnce({ data: { testRun: { status: 'passed' } } });

    canBranchMergeMock.mockImplementation((branch) => {
      expect(branch).toBeNull();
      return false;
    });
    describeMergeBlockerMock.mockImplementation(() => 'Tests must pass before merge');

    await act(async () => {
      await getState().handleTestAndMerge('ghost/missing');
    });

    await waitFor(() => {
      expect(getState().mergeWarning).toBe('Tests must pass before merge');
    });

    const mergeCalls = axios.post.mock.calls.filter(([url]) => url.includes('/merge'));
    expect(mergeCalls).toHaveLength(0);
  });

  test('handleTestAndMerge updates working branch test status before checking merge readiness', async () => {
    const branchName = 'feature-refresh-status';
    const overview = buildOverview({
      current: branchName,
      branches: [
        { name: 'main', status: 'protected', isCurrent: false },
        { name: branchName, status: 'ready-for-merge', isCurrent: true }
      ],
      workingBranches: [
        {
          name: branchName,
          status: 'ready-for-merge',
          lastTestStatus: 'failed',
          stagedFiles: []
        }
      ]
    });

    const { getState } = await renderHookState({ overviewSequence: [overview] });

    axios.post.mockReset();
    axios.get.mockClear();

    axios.post.mockResolvedValueOnce({ data: { testRun: { status: 'passed' }, overview } });
    axios.post.mockResolvedValueOnce({ data: { success: true, overview } });

    let capturedBranch = null;
    canBranchMergeMock.mockImplementation((branch) => {
      capturedBranch = branch;
      return true;
    });

    await act(async () => {
      await getState().handleTestAndMerge(branchName);
    });

    expect(capturedBranch?.lastTestStatus).toBe('passed');
    const mergeCalls = axios.post.mock.calls.filter(([url]) => url.includes(`/branches/${branchName}/merge`));
    expect(mergeCalls).toHaveLength(1);
  });

  test('handleTestAndMerge fetches overview after commit when earlier fetches fail', async () => {
    const branchName = 'feature-commit-fetch';
    const stagedBranch = {
      name: branchName,
      stagedFiles: [{ path: 'src/file.js', source: 'editor' }]
    };
    const stagedOverview = buildOverview({
      current: branchName,
      branches: [
        { name: 'main', status: 'protected', isCurrent: false },
        { name: branchName, status: 'active', isCurrent: true }
      ],
      workingBranches: [stagedBranch]
    });
    const { getState } = await renderHookState({ overviewSequence: [stagedOverview] });

    axios.post.mockReset();
    axios.get.mockReset();

    axios.post.mockResolvedValueOnce({ data: { testRun: { status: 'passed' } } });
    axios.get.mockRejectedValueOnce(new Error('result overview missing'));
    axios.get.mockRejectedValueOnce(new Error('post-test overview missing'));
    axios.post.mockResolvedValueOnce({ data: { success: true } });
    const finalOverview = buildOverview({
      current: branchName,
      branches: [
        { name: 'main', status: 'protected', isCurrent: false },
        { name: branchName, status: 'active', isCurrent: true }
      ],
      workingBranches: [{ name: branchName, stagedFiles: [] }]
    });
    axios.get.mockResolvedValueOnce({ data: finalOverview });
    axios.post.mockResolvedValueOnce({ data: { success: true, overview: buildOverview() } });

    await act(async () => {
      await getState().handleTestAndMerge(branchName);
    });

    const overviewCalls = axios.get.mock.calls.filter(([url]) => typeof url === 'string' && !url.includes('/css-only'));
    expect(overviewCalls).toHaveLength(3);
    expect(axios.post.mock.calls.filter(([url]) => url.includes('/merge')).length).toBe(1);
  });

  test('handleTestAndMerge proceeds when tests are skipped for css-only changes', async () => {
    const branchName = 'feature-css-only';
    const stagedOverview = buildOverview({
      current: branchName,
      branches: [
        { name: 'main', status: 'protected', isCurrent: false },
        { name: branchName, status: 'active', isCurrent: true }
      ],
      workingBranches: [
        {
          name: branchName,
          stagedFiles: [{ path: 'src/styles/app.css', source: 'editor' }],
          lastTestStatus: 'failed'
        }
      ]
    });

    const commitOverview = buildOverview({
      current: branchName,
      branches: [
        { name: 'main', status: 'protected', isCurrent: false },
        { name: branchName, status: 'ready-for-merge', isCurrent: true }
      ],
      workingBranches: [
        {
          name: branchName,
          stagedFiles: [],
          lastTestStatus: 'skipped'
        }
      ]
    });

    const mergedOverview = buildOverview();

    const { getState } = await renderHookState({ overviewSequence: [stagedOverview] });

    axios.post.mockReset();
    axios.get.mockReset();

    axios.post
      .mockResolvedValueOnce({ data: { testRun: { status: 'skipped' } } })
      .mockResolvedValueOnce({ data: { overview: commitOverview } })
      .mockResolvedValueOnce({ data: { success: true, overview: mergedOverview } });

    axios.get.mockImplementation((url) => {
      if (typeof url === 'string' && url.includes(`/branches/${branchName}/css-only`)) {
        return Promise.resolve({ data: { isCssOnly: true } });
      }

      return Promise.resolve({ data: stagedOverview });
    });

    await act(async () => {
      await getState().handleTestAndMerge(branchName);
    });

    const commitCall = axios.post.mock.calls.find(([url]) => url.includes(`/branches/${branchName}/commit`));
    const mergeCall = axios.post.mock.calls.find(([url]) => url.includes(`/branches/${branchName}/merge`));

    expect(commitCall).toBeTruthy();
    expect(mergeCall).toBeTruthy();
  });

  test('handleTestAndMerge surfaces default commit error copy when server response is missing', async () => {
    const branchName = 'feature-commit-default';
    const stagedOverview = buildOverview({
      current: branchName,
      branches: [
        { name: 'main', status: 'protected', isCurrent: false },
        { name: branchName, status: 'active', isCurrent: true }
      ],
      workingBranches: [
        { name: branchName, stagedFiles: [{ path: 'src/file.js', source: 'editor' }] }
      ]
    });
    const { getState } = await renderHookState({ overviewSequence: [stagedOverview] });

    axios.post.mockReset();
    axios.get.mockClear();

    axios.post.mockResolvedValueOnce({ data: { testRun: { status: 'passed' } } });
    axios.get.mockResolvedValueOnce({ data: stagedOverview });
    axios.post.mockRejectedValueOnce(new Error('commit down'));

    await waitFor(() => {
      expect(getState().workingBranches.some((branch) => branch.name === branchName)).toBe(true);
    });

    await act(async () => {
      await getState().handleTestAndMerge(branchName);
    });

    await waitFor(() => {
      expect(getState().mergeWarning).toBe('Failed to commit staged changes before merging');
    });
  });

  test('handleTestAndMerge surfaces server-provided automation errors', async () => {
    const { getState } = await renderHookState();

    const apiError = Object.assign(new Error('ci down'), {
      response: { data: { error: 'Tests blocked by CI' } }
    });
    axios.post.mockRejectedValueOnce(apiError);

    await act(async () => {
      await getState().handleTestAndMerge('main');
    });

    await waitFor(() => {
      expect(getState().error).toBe('Tests blocked by CI');
    });
  });

  test('handleCheckoutBranch ignores empty branch names', async () => {
    const { getState } = await renderHookState();

    axios.post.mockClear();
    await act(async () => {
      await getState().handleCheckoutBranch('');
    });

    expect(axios.post).not.toHaveBeenCalled();
  });

  test('handleMergeBranch exits early when branch context is missing', async () => {
    const { getState } = await renderHookState();

    axios.post.mockClear();
    await act(async () => {
      await getState().handleMergeBranch('');
    });

    expect(axios.post).not.toHaveBeenCalled();
  });

  test('handleMergeBranch refetches when overview payload is missing', async () => {
    const { getState } = await renderHookState();

    axios.get.mockClear();
    axios.post.mockResolvedValueOnce({ data: { success: true } });

    await act(async () => {
      await getState().handleMergeBranch('main');
    });

    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('handleMergeBranch surfaces default error message when merge fails', async () => {
    const { getState } = await renderHookState();

    axios.post.mockRejectedValueOnce(new Error('merge boom'));

    await act(async () => {
      await getState().handleMergeBranch('main');
    });

    await waitFor(() => {
      expect(getState().error).toBe('Failed to merge branch');
    });
  });

  test('handleMergeBranch surfaces server error copy when available', async () => {
    const { getState } = await renderHookState();

    const apiError = Object.assign(new Error('merge blocked'), {
      response: { data: { error: 'Merge blocked by policy' } }
    });
    axios.post.mockRejectedValueOnce(apiError);

    await act(async () => {
      await getState().handleMergeBranch('main');
    });

    await waitFor(() => {
      expect(getState().error).toBe('Merge blocked by policy');
    });
  });

  test('handleMergeBranch aborts when project is stopping', async () => {
    const { getState } = await renderHookState({
      appStateOverrides: { isProjectStopping: vi.fn(() => true) }
    });

    axios.post.mockClear();
    await act(async () => {
      await getState().handleMergeBranch('main');
    });

    expect(axios.post).not.toHaveBeenCalled();
  });

  test('workingBranchMap guards against non-array state', async () => {
    const { getState } = await renderHookState();
    const latestInstance = useBranchTabState.__testHooks.getLatestInstance();
    expect(latestInstance).toBeTruthy();

    await act(async () => {
      latestInstance.setWorkingBranches({ find: () => null });
    });

    await waitFor(() => {
      expect(getState().workingBranchMap).toBeInstanceOf(Map);
      expect(getState().workingBranchMap.size).toBe(0);
    });
  });

  test('applyOverview safely ignores falsy payloads', async () => {
    await renderHookState();
    const latestInstance = useBranchTabState.__testHooks.getLatestInstance();
    expect(latestInstance).toBeTruthy();

    await act(async () => {
      latestInstance.applyOverview(null);
    });
  });

  test('applyOverview filters disallowed branches and defaults missing working data', async () => {
    const { getState } = await renderHookState();
    const latestInstance = useBranchTabState.__testHooks.getLatestInstance();
    expect(latestInstance).toBeTruthy();

    const overview = {
      success: true,
      branches: [
        { name: 'archived-branch', status: 'archived', isCurrent: false },
        { name: 'main', status: 'protected', isCurrent: false }
      ],
      workingBranches: null,
      current: ''
    };

    await act(async () => {
      latestInstance.applyOverview(overview);
    });

    await waitFor(() => {
      expect(getState().branchSummaries.some((branch) => branch.name === 'archived-branch')).toBe(true);
      expect(getState().sortedBranches.some((branch) => branch.name === 'archived-branch')).toBe(false);
      expect(getState().workingBranches).toEqual([]);
      expect(getState().selectedBranchName).toBe('main');
    });
  });

  test('applyOverview handles missing branch arrays by clearing summaries', async () => {
    const emptyOverview = buildOverview({
      branches: null,
      workingBranches: null,
      current: ''
    });
    const { getState } = await renderHookState({ overviewSequence: [emptyOverview] });
    const latestInstance = useBranchTabState.__testHooks.getLatestInstance();

    await act(async () => {
      latestInstance.applyOverview(emptyOverview);
    });

    await waitFor(() => {
      expect(getState().branchSummaries).toEqual([]);
      expect(getState().selectedBranchName).toBe('main');
    });
  });

  test('triggerAutomationSuites no-ops when automation hooks are unavailable', async () => {
    await renderHookState({
      appStateOverrides: { startAutomationJob: null }
    });
    const latestInstance = useBranchTabState.__testHooks.getLatestInstance();
    expect(latestInstance).toBeTruthy();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await act(async () => {
      await latestInstance.triggerAutomationSuites('main');
    });

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('triggerAutomationSuites exits early when no branch can be resolved', async () => {
    useBranchTabState.__testHooks?.setBranchFallbackName?.('');
    const startAutomationJob = vi.fn().mockResolvedValue({});
    const markTestRunIntent = vi.fn();

    const { getState } = await renderHookState({
      overviewSequence: [{ success: false }],
      appStateOverrides: { startAutomationJob, markTestRunIntent }
    });

    await waitFor(() => {
      expect(getState().selectedBranchName).toBe('');
    });

    const latestInstance = useBranchTabState.__testHooks.getLatestInstance();
    expect(latestInstance).toBeTruthy();

    await act(async () => {
      await latestInstance.triggerAutomationSuites();
    });

    expect(markTestRunIntent).not.toHaveBeenCalled();
    expect(startAutomationJob).not.toHaveBeenCalled();
  });

  test('triggerAutomationSuites warns when automation jobs fail to start', async () => {
    const jobError = new Error('job failure');
    await renderHookState({
      appStateOverrides: {
        startAutomationJob: vi.fn(() => Promise.reject(jobError))
      }
    });
    const latestInstance = useBranchTabState.__testHooks.getLatestInstance();
    expect(latestInstance).toBeTruthy();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await act(async () => {
      await latestInstance.triggerAutomationSuites('main');
    });

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith('[BranchTab] Failed to start frontend:test', jobError);
    });
    expect(warnSpy).toHaveBeenCalledWith('[BranchTab] Failed to start backend:test', jobError);
    warnSpy.mockRestore();
  });

  test('triggerAutomationSuites records the user test run intent when available', async () => {
    const startAutomationJob = vi.fn().mockResolvedValue({});
    const markTestRunIntent = vi.fn();

    await renderHookState({
      appStateOverrides: {
        startAutomationJob,
        markTestRunIntent
      }
    });

    const latestInstance = useBranchTabState.__testHooks.getLatestInstance();
    expect(latestInstance).toBeTruthy();

    await act(async () => {
      await latestInstance.triggerAutomationSuites('main');
    });

    expect(markTestRunIntent).toHaveBeenCalledWith('user');
    expect(startAutomationJob).toHaveBeenCalledWith('frontend:test', expect.objectContaining({
      projectId: defaultProject.id,
      branchName: 'main'
    }));
    expect(startAutomationJob).toHaveBeenCalledWith('backend:test', expect.objectContaining({
      projectId: defaultProject.id,
      branchName: 'main'
    }));
  });

  test('performCommit guard exits when branch name or project is missing', async () => {
    await renderHookState();
    const instanceWithProject = useBranchTabState.__testHooks.getLatestInstance();
    expect(instanceWithProject).toBeTruthy();
    axios.post.mockClear();

    await act(async () => {
      const result = await instanceWithProject.performCommit('');
      expect(result).toBeNull();
    });
    expect(axios.post).not.toHaveBeenCalled();

    await renderHookState({ project: null, overviewSequence: [] });
    const instanceWithoutProject = useBranchTabState.__testHooks.getLatestInstance();
    axios.post.mockClear();

    await act(async () => {
      const result = await instanceWithoutProject.performCommit('main');
      expect(result).toBeNull();
    });
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('setBranchFallbackName normalizes non-string inputs to main', async () => {
    useBranchTabState.__testHooks?.setBranchFallbackName?.('custom-fallback');
    useBranchTabState.__testHooks?.setBranchFallbackName?.(0);

    const emptyOverview = buildOverview({ branches: [], workingBranches: [], current: '' });
    const { getState } = await renderHookState({ project: null, overviewSequence: [emptyOverview] });

    expect(getState().selectedBranchName).toBe('main');
  });

  test('getLatestInstance returns null when hook has not been rendered', () => {
    useBranchTabState.__testHooks?.clearLatestInstance?.();
    expect(useBranchTabState.__testHooks?.getLatestInstance?.()).toBeNull();
  });

  test('handleClearFile respects explicit branch parameters', async () => {
    const { getState, appState } = await renderHookState();

    appState.clearStagedChanges.mockClear();
    await act(async () => {
      await getState().handleClearFile('src/App.jsx', 'feature-files');
    });

    expect(appState.clearStagedChanges).toHaveBeenCalledWith(expect.any(String), {
      branchName: 'feature-files',
      filePath: 'src/App.jsx'
    });
  });

  test('handleClearFile falls back to the selected branch when parameter omitted', async () => {
    const { getState, appState } = await renderHookState();

    appState.clearStagedChanges.mockClear();
    await act(async () => {
      await getState().handleClearFile('src/App.jsx');
    });

    expect(appState.clearStagedChanges).toHaveBeenCalledWith(expect.any(String), {
      branchName: getState().selectedBranchName,
      filePath: 'src/App.jsx'
    });
  });

  test('handleClearFile exits when required parameters are missing', async () => {
    const { getState, appState } = await renderHookState();

    appState.clearStagedChanges.mockClear();
    await act(async () => {
      await getState().handleClearFile('', 'main');
    });

    expect(appState.clearStagedChanges).not.toHaveBeenCalled();
  });

  test('handleClearFile applies overview payloads without refetching', async () => {
    const overviewPayload = buildOverview({ current: 'feature-cleared' });
    const clearStagedChanges = vi.fn().mockResolvedValue({ overview: overviewPayload });
    const { getState, appState } = await renderHookState({
      appStateOverrides: { clearStagedChanges }
    });

    axios.get.mockClear();
    appState.syncBranchOverview.mockClear();
    await act(async () => {
      await getState().handleClearFile('src/App.jsx', 'main');
    });

    expect(clearStagedChanges).toHaveBeenCalledWith(defaultProject.id, {
      branchName: 'main',
      filePath: 'src/App.jsx'
    });
    expect(appState.syncBranchOverview).toHaveBeenCalledWith(
      defaultProject.id,
      expect.objectContaining({ current: 'feature-cleared' })
    );
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('handleOpenFile forwards file paths to the provided hook', async () => {
    const onRequestFileOpen = vi.fn();
    const { getState } = await renderHookState({ hookProps: { onRequestFileOpen } });

    await act(async () => {
      getState().handleOpenFile('src/App.jsx');
    });

    expect(onRequestFileOpen).toHaveBeenCalledWith('src/App.jsx');
  });

  test('handleOpenFile no-ops when the path is missing', async () => {
    const onRequestFileOpen = vi.fn();
    const { getState } = await renderHookState({ hookProps: { onRequestFileOpen } });

    await act(async () => {
      getState().handleOpenFile('');
    });

    expect(onRequestFileOpen).not.toHaveBeenCalled();
  });
});
