export const DEFAULT_COVERAGE_THRESHOLDS = Object.freeze({
  lines: 100,
  statements: 100,
  functions: 100,
  branches: 100
});

const clampPercent = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.max(0, Math.min(100, numeric));
};

export const normalizeCoverageThresholds = (input, fallback = DEFAULT_COVERAGE_THRESHOLDS) => {
  const base = fallback && typeof fallback === 'object' ? fallback : DEFAULT_COVERAGE_THRESHOLDS;
  const thresholds = {
    lines: base.lines,
    statements: base.statements,
    functions: base.functions,
    branches: base.branches
  };

  if (!input || typeof input !== 'object') {
    return thresholds;
  }

  for (const key of Object.keys(thresholds)) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      const value = clampPercent(input[key]);
      if (value != null) {
        thresholds[key] = value;
      }
    }
  }

  return thresholds;
};

export const resolveCoveragePolicy = (options = {}) => {
  const enforceFullCoverage = options.enforceFullCoverage === true;
  const baseThresholds = enforceFullCoverage
    ? DEFAULT_COVERAGE_THRESHOLDS
    : normalizeCoverageThresholds(options.coverageThresholds, DEFAULT_COVERAGE_THRESHOLDS);

  const globalThresholds = normalizeCoverageThresholds(baseThresholds, DEFAULT_COVERAGE_THRESHOLDS);

  const changedFileThresholds = enforceFullCoverage
    ? normalizeCoverageThresholds(DEFAULT_COVERAGE_THRESHOLDS, globalThresholds)
    : normalizeCoverageThresholds(options.changedFileCoverageThresholds, globalThresholds);

  const enforceChangedFileCoverage = options.enforceChangedFileCoverage !== false;

  return {
    globalThresholds,
    changedFileThresholds,
    enforceChangedFileCoverage
  };
};
