import { describe, test, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import useToolbarActions, { invokeCreateBranchAction } from './useToolbarActions';

const buildProps = (overrides = {}) => {
  const selectedBranchName = overrides.selectedBranchName ?? 'feature/login';
  const selectedBranchRef = overrides.selectedBranchRef || { current: selectedBranchName };

  return {
    registerBranchActions: vi.fn(),
    selectedBranchName,
    hasSelectedWorkingBranch: true,
    selectedStagedCount: 2,
    canBeginMerge: true,
    readyForMerge: true,
    canDelete: true,
    isStoppingProject: false,
    mergeInFlight: null,
    deleteInFlight: null,
    createBranchInFlight: false,
    selectedBranchRef,
    handleCreateBranch: vi.fn(() => 'created'),
    handleMergeBranch: vi.fn(() => 'merge'),
    handleDeleteBranch: vi.fn(() => 'delete'),
    ...overrides
  };
};

describe('useToolbarActions', () => {
  test('returns null payload and avoids registration when no branch is selected', () => {
    const props = buildProps({ selectedBranchName: null });
    const { result } = renderHook((hookProps) => useToolbarActions(hookProps), {
      initialProps: props
    });

    expect(result.current).toBeNull();
    expect(props.registerBranchActions).not.toHaveBeenCalled();
  });

  test('builds payload but skips registration when registerBranchActions is missing', () => {
    const props = buildProps({ registerBranchActions: null });
    const { result } = renderHook((hookProps) => useToolbarActions(hookProps), {
      initialProps: props
    });

    expect(result.current).not.toBeNull();
    expect(result.current.createBranch.label).toBe('New branch');
  });

  test('returns null payload when branch is selected but no actions apply', () => {
    const props = buildProps({
      handleCreateBranch: null,
      hasSelectedWorkingBranch: false,
      selectedStagedCount: 0,
      canBeginMerge: false,
      readyForMerge: false,
      canDelete: false
    });
    const { result } = renderHook((hookProps) => useToolbarActions(hookProps), {
      initialProps: props
    });

    expect(result.current).toBeNull();
    expect(props.registerBranchActions).not.toHaveBeenCalled();
  });

  test('builds actionable payload and honors handler calls and labels', async () => {
    const props = buildProps();
    const { result, rerender } = renderHook((hookProps) => useToolbarActions(hookProps), {
      initialProps: props
    });

    await waitFor(() => expect(props.registerBranchActions).toHaveBeenCalledTimes(1));

    expect(Object.keys(result.current)).toEqual(['createBranch', 'deleteBranch']);
    expect(result.current.createBranch.label).toBe('New branch');

    result.current.createBranch.onClick();
    result.current.deleteBranch.onClick();

    expect(props.handleCreateBranch).toHaveBeenCalled();
    expect(props.handleDeleteBranch).toHaveBeenCalledWith('feature/login');

    rerender({
      ...props,
      createBranchInFlight: true,
      deleteInFlight: 'feature/login'
    });

    await waitFor(() => expect(props.registerBranchActions).toHaveBeenCalledTimes(2));
    const updatedPayload = props.registerBranchActions.mock.calls.at(-1)[0];
    expect(updatedPayload.createBranch.label).toBe('Creating…');
    expect(updatedPayload.deleteBranch.label).toBe('Deleting…');
  });

  test('action handlers bail out when the branch ref is empty', async () => {
    const selectedBranchRef = { current: 'feature/login' };
    const props = buildProps({ selectedBranchRef });
    const { result } = renderHook((hookProps) => useToolbarActions(hookProps), {
      initialProps: props
    });

    await waitFor(() => expect(props.registerBranchActions).toHaveBeenCalledTimes(1));

    selectedBranchRef.current = '';
    expect(result.current.deleteBranch.onClick()).toBeNull();

    expect(props.handleMergeBranch).not.toHaveBeenCalled();
    expect(props.handleDeleteBranch).not.toHaveBeenCalled();
  });

  test('re-registers only when payload changes and cleans up on unmount', async () => {
    const registerBranchActions = vi.fn();
    const props = buildProps({ registerBranchActions });
    const { rerender, unmount } = renderHook((hookProps) => useToolbarActions(hookProps), {
      initialProps: props
    });

    await waitFor(() => expect(registerBranchActions).toHaveBeenCalledTimes(1));

    rerender({ ...props });
    await waitFor(() => expect(registerBranchActions).toHaveBeenCalledTimes(1));

    rerender({ ...props, canDelete: false });
    await waitFor(() => expect(registerBranchActions).toHaveBeenCalledTimes(2));
    const latestPayload = registerBranchActions.mock.calls.at(-1)[0];
    expect(latestPayload.deleteBranch).toBeUndefined();

    unmount();
    expect(registerBranchActions).toHaveBeenCalledWith(null);
  });

  test('treats same-length payloads with different keys as changed', async () => {
    const registerBranchActions = vi.fn();
    const props = buildProps({
      registerBranchActions,
      canBeginMerge: false,
      readyForMerge: false,
      canDelete: false
    });

    const { rerender } = renderHook((hookProps) => useToolbarActions(hookProps), {
      initialProps: props
    });

    await waitFor(() => expect(registerBranchActions).toHaveBeenCalledTimes(1));
    expect(Object.keys(registerBranchActions.mock.calls[0][0])).toEqual(['createBranch']);

    rerender({
      ...props,
      handleCreateBranch: null,
      canDelete: true
    });

    await waitFor(() => expect(registerBranchActions).toHaveBeenCalledTimes(2));
    expect(Object.keys(registerBranchActions.mock.calls[1][0])).toEqual(['deleteBranch']);
  });
});

describe('invokeCreateBranchAction', () => {
  test('returns null when no handler is available', () => {
    expect(invokeCreateBranchAction()).toBeNull();
  });

  test('delegates to the provided handler', () => {
    const handler = vi.fn(() => 'created');
    expect(invokeCreateBranchAction(handler)).toBe('created');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
