import { describe, it, expect } from 'vitest';

import {
  DEFAULT_COVERAGE_THRESHOLDS,
  normalizeCoverageThresholds,
  resolveCoveragePolicy
} from '../constants/coveragePolicy.js';

describe('coveragePolicy', () => {
  it('normalizeCoverageThresholds returns defaults for non-object input', () => {
    expect(normalizeCoverageThresholds(null)).toEqual(DEFAULT_COVERAGE_THRESHOLDS);
    expect(normalizeCoverageThresholds('nope')).toEqual(DEFAULT_COVERAGE_THRESHOLDS);
  });

  it('normalizeCoverageThresholds ignores non-finite overrides and clamps valid values', () => {
    const normalized = normalizeCoverageThresholds({
      lines: 'not-a-number',
      statements: 101,
      functions: -1,
      branches: 99
    });

    expect(normalized).toEqual({
      lines: 100,
      statements: 100,
      functions: 0,
      branches: 99
    });
  });

  it('normalizeCoverageThresholds falls back to default base when fallback is not an object', () => {
    const normalized = normalizeCoverageThresholds({ lines: 50 }, 123);
    expect(normalized.lines).toBe(50);
    expect(normalized.statements).toBe(100);
  });

  it('resolveCoveragePolicy defaults changed-file thresholds to global and enables enforcement by default', () => {
    const policy = resolveCoveragePolicy({ coverageThresholds: { lines: 90 } });

    expect(policy.globalThresholds.lines).toBe(90);
    expect(policy.changedFileThresholds.lines).toBe(90);
    expect(policy.enforceChangedFileCoverage).toBe(true);
  });

  it('resolveCoveragePolicy allows disabling changed-file enforcement and overriding changed-file thresholds', () => {
    const policy = resolveCoveragePolicy({
      coverageThresholds: { lines: 90, statements: 90, functions: 90, branches: 90 },
      changedFileCoverageThresholds: { lines: 80 },
      enforceChangedFileCoverage: false
    });

    expect(policy.enforceChangedFileCoverage).toBe(false);
    expect(policy.globalThresholds).toMatchObject({
      lines: 90,
      statements: 90,
      functions: 90,
      branches: 90
    });
    expect(policy.changedFileThresholds).toMatchObject({
      lines: 80,
      statements: 90,
      functions: 90,
      branches: 90
    });
  });
});
