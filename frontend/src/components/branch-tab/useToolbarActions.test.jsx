import { describe, test, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import useToolbarActions, { haveSameActions, invokeCreateBranchAction } from './useToolbarActions';

const buildProps = (overrides = {}) => {
  const selectedBranchName = overrides.selectedBranchName ?? 'feature/login';

  return {
    registerBranchActions: vi.fn(),
    selectedBranchName,
    hasSelectedWorkingBranch: true,
    selectedStagedCount: 2,
    canBeginMerge: true,
    readyForMerge: true,
    isStoppingProject: false,
    mergeInFlight: null,
    createBranchInFlight: false,
    handleCreateBranch: vi.fn(() => 'created'),
    handleMergeBranch: vi.fn(() => 'merge'),
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
      readyForMerge: false
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

    expect(Object.keys(result.current)).toEqual(['createBranch']);
    expect(result.current.createBranch.label).toBe('New branch');

    result.current.createBranch.onClick();

    expect(props.handleCreateBranch).toHaveBeenCalled();

    rerender({
      ...props,
      createBranchInFlight: true
    });

    await waitFor(() => expect(props.registerBranchActions).toHaveBeenCalledTimes(2));
    const updatedPayload = props.registerBranchActions.mock.calls.at(-1)[0];
    expect(updatedPayload.createBranch.label).toBe('Creating…');
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

    rerender({ ...props, createBranchInFlight: true });
    await waitFor(() => expect(registerBranchActions).toHaveBeenCalledTimes(2));
    const latestPayload = registerBranchActions.mock.calls.at(-1)[0];
    expect(latestPayload.createBranch.label).toBe('Creating…');

    unmount();
    expect(registerBranchActions).toHaveBeenCalledWith(null);
  });

  test('returns null payload when create action is removed after being present', async () => {
    const registerBranchActions = vi.fn();
    const props = buildProps({ registerBranchActions });

    const { rerender } = renderHook((hookProps) => useToolbarActions(hookProps), {
      initialProps: props
    });

    await waitFor(() => expect(registerBranchActions).toHaveBeenCalledTimes(1));
    expect(Object.keys(registerBranchActions.mock.calls[0][0])).toEqual(['createBranch']);

    rerender({
      ...props,
      handleCreateBranch: null
    });

    await waitFor(() => expect(registerBranchActions).toHaveBeenCalledTimes(2));
    expect(registerBranchActions.mock.calls[1][0]).toBeNull();
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

describe('haveSameActions', () => {
  test('returns false when action key counts differ', () => {
    const handler = vi.fn();
    expect(haveSameActions({ a: { label: 'A', disabled: false, variant: 'success', onClick: handler } }, {
      a: { label: 'A', disabled: false, variant: 'success', onClick: handler },
      b: { label: 'B', disabled: false, variant: 'success', onClick: handler }
    })).toBe(false);
  });

  test('returns false when the next payload is missing an action value', () => {
    const handler = vi.fn();
    expect(haveSameActions({ a: { label: 'A', disabled: false, variant: 'success', onClick: handler } }, {
      a: undefined
    })).toBe(false);
  });
});
