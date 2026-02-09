import { describe, expect, test, vi } from 'vitest';
import { summarizeTestRunForPrompt } from '../services/agentAutopilot/runs.js';
import { autopilotFeatureRequest } from '../services/agentAutopilot.js';

describe('agent autopilot coverage gates', () => {
  test('summarizeTestRunForPrompt includes uncovered line references and guidance', () => {
    const result = summarizeTestRunForPrompt({
      status: 'failed',
      summary: {
        total: 1,
        failed: 1,
        coverage: {
          passed: false,
          totals: { lines: 99, statements: 100, functions: 100, branches: 100 },
          uncoveredLines: [
            { workspace: 'frontend', file: 'src/components/Foo.jsx', lines: [10, 11, 15] },
            { workspace: 'backend', file: 'server.js', lines: [5] }
          ]
        }
      },
      workspaceRuns: []
    });

    expect(result).toContain('Coverage gaps (line references):');
    expect(result).toContain('frontend/src/components/Foo.jsx: 10, 11, 15');
    expect(result).toContain('backend/server.js: 5');
    expect(result).toContain('Instruction: add or adjust tests to execute the exact lines above so coverage reaches 100%.');
  });

  test('summarizeTestRunForPrompt formats long line lists and missing workspace', () => {
    const longLines = Array.from({ length: 15 }, (_, index) => index + 1);
    const result = summarizeTestRunForPrompt({
      status: 'failed',
      summary: {
        total: 1,
        failed: 1,
        coverage: {
          passed: false,
          uncoveredLines: [
            { workspace: '', file: 'server.js', lines: longLines }
          ]
        }
      },
      workspaceRuns: []
    });

    expect(result).toContain('server.js: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, ...');
  });

  test('autopilot enforces 100% coverage thresholds in the main loop', async () => {
    const plan = vi.fn().mockResolvedValue({
      parent: { branchName: 'feature/test' },
      children: [{ prompt: 'Add new feature' }]
    });

    const edit = vi.fn().mockResolvedValue({ steps: [], summary: 'ok' });
    const createBranch = vi.fn().mockResolvedValue({});
    const commit = vi.fn().mockResolvedValue({ commit: 'abc123' });
    const merge = vi.fn().mockResolvedValue({ mergedBranch: 'feature/test', current: 'main' });

    const runTests = vi
      .fn()
      .mockResolvedValueOnce({ status: 'failed', summary: { coverage: { passed: false } }, workspaceRuns: [] })
      .mockResolvedValueOnce({ status: 'passed', summary: { coverage: { passed: true } }, workspaceRuns: [] });

    await autopilotFeatureRequest({
      projectId: 1,
      prompt: 'Add new feature',
      options: { coverageThresholds: { lines: 80 } },
      deps: {
        plan,
        edit,
        createBranch,
        runTests,
        commit,
        merge
      }
    });

    for (const call of runTests.mock.calls) {
      const options = call[2];
      expect(options.coverageThresholds).toEqual({
        lines: 100,
        statements: 100,
        functions: 100,
        branches: 100
      });
      expect(options.enforceFullCoverage).toBe(true);
      expect(options.includeCoverageLineRefs).toBe(true);
    }
  });
});
