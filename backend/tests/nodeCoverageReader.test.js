import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { readNodeWorkspaceCoverage, __testExports__ } from '../services/branchWorkflow/testsApi/nodeCoverageReader.js';

const workspace = { cwd: 'C:/repo/project', name: 'frontend' };

const makeReadJsonIfExists = (summary, finalCoverage) => async (filePath) => {
  if (filePath.endsWith('coverage-summary.json')) {
    return summary;
  }
  if (filePath.endsWith('coverage-final.json')) {
    return finalCoverage;
  }
  return null;
};

describe('readNodeWorkspaceCoverage', () => {
  test('shouldExcludeCoveragePath returns false for empty values', () => {
    expect(__testExports__.shouldExcludeCoveragePath('')).toBe(false);
    expect(__testExports__.shouldExcludeCoveragePath(null)).toBe(false);
  });

  test('returns no uncovered lines when final coverage has no missing lines', async () => {
    const summary = { total: { lines: { pct: 100 }, statements: { pct: 100 }, functions: { pct: 100 }, branches: { pct: 100 } } };
    const finalCoverage = {
      'C:/repo/project/src/ok.js': { statementMap: {}, fnMap: {}, branchMap: {}, s: {}, f: {}, b: {} }
    };

    const result = await readNodeWorkspaceCoverage({
      path,
      workspace,
      changedPaths: [],
      nodeWorkspaceNames: ['frontend'],
      readJsonIfExists: makeReadJsonIfExists(summary, finalCoverage),
      includeAllFiles: true
    });

    expect(result.uncoveredLines).toEqual([]);
  });

  test('respects maxFiles when includeAllFiles is enabled', async () => {
    const summary = { total: { lines: { pct: 90 }, statements: { pct: 90 }, functions: { pct: 90 }, branches: { pct: 90 } } };
    const finalCoverage = {
      'C:/repo/project/src/one.js': { l: { 1: 0 } }
    };

    const result = await readNodeWorkspaceCoverage({
      path,
      workspace,
      changedPaths: [],
      nodeWorkspaceNames: ['frontend'],
      readJsonIfExists: makeReadJsonIfExists(summary, finalCoverage),
      includeAllFiles: true,
      maxFiles: 0
    });

    expect(result.uncoveredLines).toEqual([]);
  });

  test('skips coverage entries outside of the workspace root', async () => {
    const summary = { total: { lines: { pct: 90 }, statements: { pct: 90 }, functions: { pct: 90 }, branches: { pct: 90 } } };
    const finalCoverage = {
      'C:/repo/outside.js': { l: { 2: 0 } }
    };

    const result = await readNodeWorkspaceCoverage({
      path,
      workspace,
      changedPaths: [],
      nodeWorkspaceNames: ['frontend'],
      readJsonIfExists: makeReadJsonIfExists(summary, finalCoverage),
      includeAllFiles: true
    });

    expect(result.uncoveredLines).toEqual([]);
  });

  test('skips config files when includeAllFiles is enabled', async () => {
    const summary = { total: { lines: { pct: 90 }, statements: { pct: 90 }, functions: { pct: 90 }, branches: { pct: 90 } } };
    const finalCoverage = {
      'C:/repo/project/vite.config.js': { l: { 2: 0 } },
      'C:/repo/project/src/keep.js': { l: { 1: 0 } }
    };

    const result = await readNodeWorkspaceCoverage({
      path,
      workspace,
      changedPaths: [],
      nodeWorkspaceNames: ['frontend'],
      readJsonIfExists: makeReadJsonIfExists(summary, finalCoverage),
      includeAllFiles: true
    });

    expect(result.uncoveredLines).toEqual([
      { workspace: 'frontend', file: 'src/keep.js', lines: [1] }
    ]);
  });

  test('skips config files when filtering by changed paths', async () => {
    const summary = { total: { lines: { pct: 90 }, statements: { pct: 90 }, functions: { pct: 90 }, branches: { pct: 90 } } };
    const finalCoverage = {
      'C:/repo/project/vitest.config.js': { l: { 2: 0 } },
      'C:/repo/project/src/app.js': { l: { 5: 0 } }
    };

    const result = await readNodeWorkspaceCoverage({
      path,
      workspace,
      changedPaths: ['frontend/vitest.config.js', 'frontend/src/app.js'],
      nodeWorkspaceNames: ['frontend', 'backend'],
      readJsonIfExists: makeReadJsonIfExists(summary, finalCoverage),
      includeAllFiles: false
    });

    expect(result.uncoveredLines).toEqual([
      { workspace: 'frontend', file: 'src/app.js', lines: [5] }
    ]);
  });
});
