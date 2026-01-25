import { useEffect, useMemo, useCallback, useRef } from 'react';

export const invokeCreateBranchAction = (handler) => {
  if (!handler) {
    return null;
  }
  return handler();
};

export const haveSameActions = (prev, next) => {
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
};

const useToolbarActions = ({
  registerBranchActions,
  selectedBranchName,
  isStoppingProject,
  handleCreateBranch,
  createBranchInFlight
}) => {
  const createBranchActionHandler = useCallback(() => (
    invokeCreateBranchAction(handleCreateBranch)
  ), [handleCreateBranch]);

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

    return Object.keys(actions).length ? actions : null;
  }, [
    selectedBranchName,
    isStoppingProject,
    handleCreateBranch,
    createBranchInFlight,
    createBranchActionHandler
  ]);

  const lastRegisteredActionsRef = useRef(null);

  useEffect(() => {
    if (!registerBranchActions) {
      return;
    }
    if (haveSameActions(lastRegisteredActionsRef.current, branchActionPayload)) {
      return;
    }
    registerBranchActions(branchActionPayload);
    lastRegisteredActionsRef.current = branchActionPayload;
  }, [branchActionPayload, registerBranchActions]);

  useEffect(() => () => {
    if (registerBranchActions) {
      registerBranchActions(null);
    }
    lastRegisteredActionsRef.current = null;
  }, [registerBranchActions]);

  return branchActionPayload;
};

export default useToolbarActions;
