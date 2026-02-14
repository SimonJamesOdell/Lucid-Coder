import { describe, expect, test } from 'vitest';
import {
  buildTestRunIntentState,
  withStoppedProject,
  withoutStoppedProject
} from '../context/appState/uiState.js';

describe('appState uiState helpers', () => {
  test('buildTestRunIntentState normalizes input and options', () => {
    const state = buildTestRunIntentState('  run-tests  ', { autoCommit: 1, returnToCommits: 0 }, () => 'now');
    expect(state).toEqual({
      source: 'run-tests',
      updatedAt: 'now',
      autoCommit: true,
      returnToCommits: false
    });
  });

  test('buildTestRunIntentState falls back to unknown source', () => {
    const state = buildTestRunIntentState('', {}, () => 't');
    expect(state.source).toBe('unknown');
    expect(state.updatedAt).toBe('t');
  });

  test('withStoppedProject adds project flag', () => {
    expect(withStoppedProject({}, 'p1')).toEqual({ p1: true });
  });

  test('withStoppedProject returns same reference when project id is missing', () => {
    const prev = { p1: true };
    expect(withStoppedProject(prev, '')).toBe(prev);
  });

  test('withoutStoppedProject removes existing project flag and keeps missing as same reference', () => {
    const prev = { p1: true, p2: true };
    expect(withoutStoppedProject(prev, 'p1')).toEqual({ p2: true });
    expect(withoutStoppedProject(prev, 'missing')).toBe(prev);
    expect(withoutStoppedProject(prev, '')).toBe(prev);
  });
});
