import { describe, test, expect, afterEach } from 'vitest';
import {
  PROJECT_CREATION_STEPS,
  buildProgressSteps,
  calculateCompletion
} from '../constants/progressSteps.js';

const ORIGINAL_STEPS = [...PROJECT_CREATION_STEPS];

afterEach(() => {
  PROJECT_CREATION_STEPS.length = 0;
  PROJECT_CREATION_STEPS.push(...ORIGINAL_STEPS);
});

describe('progressSteps utilities', () => {
  test('buildProgressSteps marks earlier steps as completed', () => {
    const steps = buildProgressSteps(2);

    expect(steps).toHaveLength(ORIGINAL_STEPS.length);
    expect(steps[0]).toMatchObject({ name: ORIGINAL_STEPS[0], completed: true });
    expect(steps[1]).toMatchObject({ completed: true });
    expect(steps[2]).toMatchObject({ completed: false });
  });

  test('calculateCompletion converts counts to bounded percentages', () => {
    expect(calculateCompletion(2)).toBe(Math.round((2 / ORIGINAL_STEPS.length) * 100));
    expect(calculateCompletion(-5)).toBe(0);
    expect(calculateCompletion(999)).toBe(100);
  });

  test('calculateCompletion falls back gracefully when no steps defined', () => {
    PROJECT_CREATION_STEPS.length = 0;
    const completion = calculateCompletion(3);
    expect(completion).toBe(100);
  });
});
