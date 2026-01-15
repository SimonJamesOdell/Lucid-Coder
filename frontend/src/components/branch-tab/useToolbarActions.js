import { useEffect, useMemo, useCallback, useRef } from 'react';

export const invokeCreateBranchAction = (handler) => {
  if (!handler) {
    return null;
  }
  return handler();
};

const useToolbarActions = ({
  registerBranchActions,
  selectedBranchName,
  canDelete,
  isStoppingProject,
  deleteInFlight,
  handleCreateBranch,
  handleDeleteBranch,
  selectedBranchRef,
  createBranchInFlight
}) => {
  const createBranchActionHandler = useCallback(() => (
    invokeCreateBranchAction(handleCreateBranch)
  ), [handleCreateBranch]);

  const deleteBranchActionHandler = useCallback(() => {
    const branchName = selectedBranchRef.current;
    if (!branchName) {
      return null;
    }
    return handleDeleteBranch(branchName);
  }, [handleDeleteBranch, selectedBranchRef]);

  const branchActionPayload = useMemo(() => {
    if (!selectedBranchName) {
      return null;
    }

    const actions = {};

    if (handleCreateBranch) {
      actions.createBranch = {
        label: createBranchInFlight ? 'Creating…' : 'New branch',
        onClick: createBranchActionHandler,
        disabled: isStoppingProject || createBranchInFlight,
        variant: 'success',
        testId: 'branch-create'
      };
    }

    if (canDelete) {
      actions.deleteBranch = {
        label: deleteInFlight === selectedBranchName ? 'Deleting…' : 'Delete branch',
        onClick: deleteBranchActionHandler,
        disabled: isStoppingProject || deleteInFlight === selectedBranchName,
        variant: 'destructive',
        testId: 'branch-delete'
      };
    }

    return Object.keys(actions).length ? actions : null;
  }, [
    selectedBranchName,
    canDelete,
    isStoppingProject,
    deleteInFlight,
    handleCreateBranch,
    createBranchInFlight,
    createBranchActionHandler,
    deleteBranchActionHandler
  ]);

  const lastRegisteredActionsRef = useRef(null);

  const haveSameActions = useCallback((prev, next) => {
    if (prev === next) {
      return true;
    }
    if (!prev || !next) {
      return false;
    }
    const prevKeys = Object.keys(prev);
    const nextKeys = Object.keys(next);
    if (prevKeys.length !== nextKeys.length) {
      return false;
    }
    return prevKeys.every((key) => {
      const prevAction = prev[key];
      const nextAction = next[key];
      if (!nextAction) {
        return false;
      }
      return (
        prevAction.label === nextAction.label
        && prevAction.disabled === nextAction.disabled
        && prevAction.variant === nextAction.variant
        && prevAction.onClick === nextAction.onClick
      );
    });
  }, []);

  useEffect(() => {
    if (!registerBranchActions) {
      return;
    }
    if (haveSameActions(lastRegisteredActionsRef.current, branchActionPayload)) {
      return;
    }
    registerBranchActions(branchActionPayload);
    lastRegisteredActionsRef.current = branchActionPayload;
  }, [branchActionPayload, haveSameActions, registerBranchActions]);

  useEffect(() => () => {
    if (registerBranchActions) {
      registerBranchActions(null);
    }
    lastRegisteredActionsRef.current = null;
  }, [registerBranchActions]);

  return branchActionPayload;
};

export default useToolbarActions;
