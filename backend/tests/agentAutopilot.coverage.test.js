import { describe, expect, test, vi } from 'vitest';
import { extractFailingTestsFromWorkspaceRuns, summarizeTestRunForPrompt } from '../services/agentAutopilot/runs.js';
import { autopilotFeatureRequest, __testing as autopilotTesting } from '../services/agentAutopilot.js';

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
        lines: 80,
        statements: 100,
        functions: 100,
        branches: 100
      });
      expect(options.enforceFullCoverage).toBe(true);
      expect(options.includeCoverageLineRefs).toBe(true);
    }
  });

  test('extractFailingTestsFromWorkspaceRuns parses structured failures from logs', () => {
    const failures = extractFailingTestsFromWorkspaceRuns([
      {
        workspace: 'backend',
        tests: [],
        logs: [
          'stderr: FAIL  tests/jobRunner.test.js > jobRunner > cancels job',
          'stderr: AssertionError: expected false to be true',
          'stderr: FAILED tests/test_api.py::test_handles_missing_payload - assert 400 == 200'
        ]
      }
    ]);

    expect(failures.length).toBeGreaterThanOrEqual(2);
    expect(failures.some((entry) => entry.name.includes('cancels job'))).toBe(true);
    expect(failures.some((entry) => entry.name.includes('tests/test_api.py::test_handles_missing_payload'))).toBe(true);
  });

  test('buildFailureFingerprint stays stable for equivalent failing runs', () => {
    const run = {
      status: 'failed',
      summary: {
        failed: 2,
        coverage: {
          totals: { lines: 98, statements: 99, functions: 100, branches: 97 },
          missing: ['backend/service.js'],
          uncoveredLines: [
            { workspace: 'backend', file: 'services/a.js', lines: [10, 11] }
          ]
        }
      },
      workspaceRuns: [
        { workspace: 'backend', status: 'failed', exitCode: 1, logs: ['FAIL tests/a.test.js > suite > test'] }
      ]
    };

    const first = autopilotTesting.buildFailureFingerprint(run);
    const second = autopilotTesting.buildFailureFingerprint({ ...run });
    expect(first).toBe(second);
  });

  test('autopilot stops verification retries when failure fingerprint is unchanged', async () => {
    const plan = vi.fn().mockResolvedValue({
      parent: { branchName: 'feature/fingerprint-stop' },
      children: [{ prompt: 'Fix failing backend test' }]
    });

    const edit = vi.fn().mockResolvedValue({ steps: [], summary: 'ok' });
    const createBranch = vi.fn().mockResolvedValue({});
    const rollback = vi.fn().mockResolvedValue({ restored: true });

    const repeatedFailureRun = {
      status: 'failed',
      summary: {
        failed: 1,
        coverage: {
          totals: { lines: 98, statements: 99, functions: 100, branches: 99 }
        }
      },
      workspaceRuns: [
        {
          workspace: 'backend',
          status: 'failed',
          exitCode: 1,
          tests: [],
          logs: ['FAIL tests/failing.test.js > backend > still fails']
        }
      ]
    };

    const runTests = vi
      .fn()
      .mockResolvedValueOnce(repeatedFailureRun)
      .mockResolvedValueOnce(repeatedFailureRun)
      .mockResolvedValueOnce(repeatedFailureRun);

    await expect(
      autopilotFeatureRequest({
        projectId: 7,
        prompt: 'Stabilize backend tests',
        options: { verificationFixRetries: 5 },
        deps: {
          plan,
          edit,
          createBranch,
          runTests,
          rollback
        }
      })
    ).rejects.toThrow('Autopilot implementation did not pass tests/coverage.');

    expect(runTests).toHaveBeenCalledTimes(3);
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  test('autopilot continues retries when failure fingerprint changes before repeating', async () => {
    const plan = vi.fn().mockResolvedValue({
      parent: { branchName: 'feature/fingerprint-reset' },
      children: [{ prompt: 'Fix flaky test' }]
    });

    const edit = vi.fn().mockResolvedValue({ steps: [], summary: 'ok' });
    const createBranch = vi.fn().mockResolvedValue({});
    const rollback = vi.fn().mockResolvedValue({ restored: true });

    const runA = {
      status: 'failed',
      summary: { failed: 1, coverage: { totals: { lines: 98, statements: 99, functions: 100, branches: 99 } } },
      workspaceRuns: [{ workspace: 'backend', status: 'failed', exitCode: 1, tests: [], logs: ['FAIL tests/a.test.js > still fails a'] }]
    };
    const runB = {
      status: 'failed',
      summary: { failed: 1, coverage: { totals: { lines: 98, statements: 99, functions: 100, branches: 99 } } },
      workspaceRuns: [{ workspace: 'backend', status: 'failed', exitCode: 1, tests: [], logs: ['FAIL tests/b.test.js > still fails b'] }]
    };

    const runTests = vi
      .fn()
      .mockResolvedValueOnce(runA)
      .mockResolvedValueOnce(runA)
      .mockResolvedValueOnce(runB)
      .mockResolvedValueOnce(runB);

    await expect(
      autopilotFeatureRequest({
        projectId: 8,
        prompt: 'Stabilize retry behavior',
        options: { verificationFixRetries: 2 },
        deps: {
          plan,
          edit,
          createBranch,
          runTests,
          rollback
        }
      })
    ).rejects.toThrow('Autopilot implementation did not pass tests/coverage.');

    expect(runTests).toHaveBeenCalledTimes(4);
    expect(rollback).toHaveBeenCalledTimes(1);
  });
});
