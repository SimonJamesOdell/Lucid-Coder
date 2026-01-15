import { describe, it, expect } from 'vitest';

import {
  GOAL_STATES,
  isGoalState,
  getAllowedGoalTransitions,
  assertGoalTransition
} from '../services/goalLifecycle.js';

describe('goalLifecycle', () => {
  it('exports the expected goal states', () => {
    expect(GOAL_STATES).toMatchObject({
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
  });

  it('recognizes goal states', () => {
    expect(isGoalState('draft')).toBe(true);
    expect(isGoalState('ready-to-merge')).toBe(true);
    expect(isGoalState('nope')).toBe(false);
    expect(isGoalState(null)).toBe(false);
  });

  it('returns allowed transitions per state', () => {
    expect(getAllowedGoalTransitions('draft')).toEqual(['planned', 'cancelled']);
    expect(getAllowedGoalTransitions('planned')).toEqual(['executing', 'cancelled']);
    expect(getAllowedGoalTransitions('executing')).toEqual(['verifying', 'needs-user-input', 'failed', 'cancelled']);
    expect(getAllowedGoalTransitions('needs-user-input')).toEqual(['executing', 'failed', 'cancelled']);
    expect(getAllowedGoalTransitions('verifying')).toEqual(['ready-to-merge', 'failed', 'cancelled']);
    expect(getAllowedGoalTransitions('ready-to-merge')).toEqual(['merged', 'cancelled']);
    expect(getAllowedGoalTransitions('failed')).toEqual(['executing', 'cancelled']);
    expect(getAllowedGoalTransitions('merged')).toEqual([]);
    expect(getAllowedGoalTransitions('cancelled')).toEqual([]);
  });

  it('throws for unknown states', () => {
    expect(() => getAllowedGoalTransitions('nope')).toThrow(/Unknown goal state/i);
  });

  it('assertGoalTransition allows valid transitions', () => {
    expect(() => assertGoalTransition('draft', 'planned')).not.toThrow();
    expect(() => assertGoalTransition('executing', 'needs-user-input')).not.toThrow();
    expect(() => assertGoalTransition('ready-to-merge', 'merged')).not.toThrow();
  });

  it('assertGoalTransition rejects invalid transitions', () => {
    expect(() => assertGoalTransition('draft', 'merged')).toThrow(/Invalid goal transition/i);
    expect(() => assertGoalTransition('merged', 'executing')).toThrow(/Invalid goal transition/i);
  });

  it('assertGoalTransition throws for unknown fromState', () => {
    expect(() => assertGoalTransition('nope', 'draft')).toThrow(/Unknown goal state: nope/i);
  });

  it('assertGoalTransition throws for unknown toState', () => {
    expect(() => assertGoalTransition('draft', 'nope')).toThrow(/Unknown goal state: nope/i);
  });
});
