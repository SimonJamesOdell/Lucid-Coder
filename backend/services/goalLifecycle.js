export const GOAL_STATES = Object.freeze({
  DRAFT: 'draft',
  PLANNED: 'planned',
  EXECUTING: 'executing',
  NEEDS_USER_INPUT: 'needs-user-input',
  VERIFYING: 'verifying',
  READY_TO_MERGE: 'ready-to-merge',
  MERGED: 'merged',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
});

const ALL_GOAL_STATES = Object.freeze(new Set(Object.values(GOAL_STATES)));

export const isGoalState = (value) => typeof value === 'string' && ALL_GOAL_STATES.has(value);

export const getAllowedGoalTransitions = (currentState) => {
  if (!isGoalState(currentState)) {
    throw new Error(`Unknown goal state: ${currentState}`);
  }

  switch (currentState) {
    case GOAL_STATES.DRAFT:
      return [GOAL_STATES.PLANNED, GOAL_STATES.CANCELLED];
    case GOAL_STATES.PLANNED:
      return [GOAL_STATES.EXECUTING, GOAL_STATES.CANCELLED];
    case GOAL_STATES.EXECUTING:
      return [GOAL_STATES.VERIFYING, GOAL_STATES.NEEDS_USER_INPUT, GOAL_STATES.FAILED, GOAL_STATES.CANCELLED];
    case GOAL_STATES.NEEDS_USER_INPUT:
      return [GOAL_STATES.EXECUTING, GOAL_STATES.FAILED, GOAL_STATES.CANCELLED];
    case GOAL_STATES.VERIFYING:
      return [GOAL_STATES.READY_TO_MERGE, GOAL_STATES.FAILED, GOAL_STATES.CANCELLED];
    case GOAL_STATES.READY_TO_MERGE:
      return [GOAL_STATES.MERGED, GOAL_STATES.CANCELLED];
    case GOAL_STATES.FAILED:
      return [GOAL_STATES.EXECUTING, GOAL_STATES.CANCELLED];
    case GOAL_STATES.MERGED:
    case GOAL_STATES.CANCELLED:
    default:
      return [];
  }
};

export const assertGoalTransition = (fromState, toState) => {
  if (!isGoalState(fromState)) {
    throw new Error(`Unknown goal state: ${fromState}`);
  }
  if (!isGoalState(toState)) {
    throw new Error(`Unknown goal state: ${toState}`);
  }

  const allowed = getAllowedGoalTransitions(fromState);
  if (!allowed.includes(toState)) {
    throw new Error(`Invalid goal transition: ${fromState} -> ${toState}`);
  }
};
