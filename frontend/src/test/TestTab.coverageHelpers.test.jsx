import React from 'react';
import { describe, test, expect, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import TestTab from '../components/TestTab';

const hooks = TestTab.__testHooks;

describe('TestTab coverage helpers', () => {
  beforeEach(() => {
    // Ensure any overrides from other tests are reset.
    hooks.resetClassifyLogTokenOverride?.();
    hooks.resetAutofixMaxAttemptsOverride?.();
  });

  test('formatDurationSeconds returns null for invalid dates', () => {
    expect(
      hooks.formatDurationSeconds({ startedAt: 'not-a-date', completedAt: 'also-bad' })
    ).toBeNull();
  });

  test('classifyLogToken respects overrides (and falls through on undefined)', () => {
    hooks.setClassifyLogTokenOverride?.((token) => {
      if (token === 'X') return 'pass';
      return undefined;
    });

    expect(hooks.classifyLogToken('X')).toBe('pass');
    expect(hooks.classifyLogToken('0.1s')).toBe('duration');

    hooks.resetClassifyLogTokenOverride?.();
  });

  test('extractFailingTestIdsFromJob returns ids from FAIL lines (deduped)', () => {
    const job = {
      logs: [
        { message: 'some noise\nFAIL  src/test/Foo.test.jsx > Foo > does something\nmore' },
        { message: 'FAIL  backend/tests/bar.test.js' },
        { message: 'FAIL  src/test/Foo.test.jsx > Foo > does something' }
      ]
    };

    const ids = hooks.extractFailingTestIdsFromJob(job);
    expect(ids).toContain('src/test/Foo.test.jsx > Foo > does something');
    expect(ids).toContain('backend/tests/bar.test.js');
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('buildTestFixPlan falls back to suite-level prompts when no FAIL ids exist', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        { label: 'Frontend tests', kind: 'frontend', job: { status: 'failed', logs: [{ message: 'oops' }] } },
        { label: 'Backend tests', kind: 'backend', job: { status: 'failed', logs: [{ message: '' }] } }
      ]
    });

    expect(plan.prompt).toBeTruthy();
    expect(plan.childPrompts).toContain('Fix failing frontend tests');
    expect(plan.childPrompts).toContain('Fix failing backend tests');
  });

  test('buildTestFixPlan falls back to a label-specific prompt for unknown job kinds', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        { label: 'Weird tests', kind: 'other', job: { status: 'failed', logs: [] } }
      ]
    });

    expect(plan.childPrompts).toEqual(['Fix failing tests in Weird tests']);
  });

  test('buildTestFixPlan has a defensive fallback when no failing jobs exist', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        { label: 'Frontend tests', kind: 'frontend', job: { status: 'succeeded', logs: [] } },
        { label: 'Backend tests', kind: 'backend', job: { status: 'succeeded', logs: [] } }
      ]
    });

    expect(plan.childPrompts).toEqual(['Investigate which tests are failing and fix them']);
  });

  test('buildProofFailureMessage uses explicit error text when provided', () => {
    expect(hooks.buildProofFailureMessage({ error: '  nope  ' })).toBe('nope');
  });

  test('buildProofFailureMessage formats uncovered line preview with truncation', () => {
    const message = hooks.buildProofFailureMessage({
      summary: {
        coverage: {
          passed: false,
          changedFiles: { passed: true },
          uncoveredLines: [
            {
              workspace: 'frontend',
              file: 'src/App.jsx',
              lines: [1, 2, 3, 4, 5, 6, 7, 8]
            }
          ]
        }
      }
    });

    expect(message).toContain('Coverage gate failed: uncovered lines in frontend/src/App.jsx');
    expect(message).toContain('(1, 2, 3, 4, 5, 6, …)');
  });

  test('buildProofFailureMessage omits truncation suffix when line count is small', () => {
    const message = hooks.buildProofFailureMessage({
      summary: {
        coverage: {
          passed: false,
          changedFiles: { passed: true },
          uncoveredLines: [
            {
              workspace: 'frontend',
              file: 'src/App.jsx',
              lines: [1, 2, 3]
            }
          ]
        }
      }
    });

    expect(message).toBe('Coverage gate failed: uncovered lines in frontend/src/App.jsx (1, 2, 3).');
  });

  test('buildProofFailureMessage tolerates malformed uncoveredLine entries', () => {
    const message = hooks.buildProofFailureMessage({
      summary: {
        coverage: {
          passed: false,
          changedFiles: { passed: true },
          uncoveredLines: [null]
        }
      }
    });

    expect(message).toBe('Branch workflow tests failed the coverage gate. Fix coverage and try again.');
  });

  test('buildProofFailureMessage treats non-array uncovered line lists as empty', () => {
    const message = hooks.buildProofFailureMessage({
      summary: {
        coverage: {
          passed: false,
          changedFiles: { passed: true },
          uncoveredLines: [{ workspace: 'frontend', file: 'x.js', lines: 'nope' }]
        }
      }
    });

    expect(message).toBe('Coverage gate failed: uncovered lines in frontend/x.js.');
  });

  test('buildProofFailureMessage triggers the coverage gate path when changed-files gate fails', () => {
    const message = hooks.buildProofFailureMessage({
      summary: {
        coverage: {
          passed: true,
          changedFiles: { passed: false },
          uncoveredLines: []
        }
      }
    });

    expect(message).toBe('Branch workflow tests failed the coverage gate. Fix coverage and try again.');
  });

  test('buildProofFailureMessage handles uncovered file without line numbers', () => {
    const message = hooks.buildProofFailureMessage({
      summary: {
        coverage: {
          passed: false,
          changedFiles: { passed: false },
          uncoveredLines: [{ workspace: 'backend', file: 'server.js', lines: [] }]
        }
      }
    });

    expect(message).toBe('Coverage gate failed: uncovered lines in backend/server.js.');
  });

  test('buildProofFailureMessage has a generic gate-failed fallback', () => {
    const message = hooks.buildProofFailureMessage({
      summary: {
        coverage: {
          passed: false,
          changedFiles: { passed: true },
          uncoveredLines: []
        }
      }
    });

    expect(message).toBe('Branch workflow tests failed the coverage gate. Fix coverage and try again.');
  });

  test('buildProofFailureMessage reports failing workspace when present', () => {
    const message = hooks.buildProofFailureMessage({
      workspaceRuns: [
        { workspace: 'frontend', status: 'succeeded' },
        { workspace: 'backend', status: 'failed' }
      ]
    });

    expect(message).toBe('Branch workflow tests failed in backend.');
  });

  test('buildProofFailureMessage tolerates non-array workspaceRuns', () => {
    const message = hooks.buildProofFailureMessage({ workspaceRuns: { nope: true } });
    expect(message).toBe('Branch workflow tests failed. Fix failing tests and try again.');
  });

  test('buildProofFailureMessage has a final fallback message', () => {
    const message = hooks.buildProofFailureMessage({ workspaceRuns: [{ workspace: '', status: 'failed' }] });
    expect(message).toBe('Branch workflow tests failed. Fix failing tests and try again.');
  });

  test('buildJobFailureContext surfaces truncated logs and normalized args', () => {
    const logs = Array.from({ length: 205 }).map((_, index) => ({
      timestamp: `2024-01-01T00:00:${String(index).padStart(2, '0')}Z`,
      message:
        index === 204
          ? 'FAIL  src/test/Foo.test.jsx > Foo > does something'
          : `Log line ${index}`
    }));
    const job = {
      id: 'job-1',
      status: 'failed',
      type: 'frontend',
      args: [' npm test ', '', 'vitest'],
      command: 'npm',
      cwd: '/repo',
      logs,
      error: '   ',
      summary: { error: ' Boom ' }
    };

    const context = hooks.buildJobFailureContext({ label: 'Frontend', kind: 'frontend', job });
    expect(context.args).toEqual([' npm test ', 'vitest']);
    expect(context.logsTruncated).toBe(true);
    expect(context.recentLogs.at(-1)).toBe('/* ...logs truncated... */');
    expect(context.testFailures).toContain('src/test/Foo.test.jsx > Foo > does something');
    expect(context.error).toBe('Boom');
    expect(context.totalLogEntries).toBe(logs.length);
  });

  test('buildJobFailureContext truncates when a single log exceeds the char budget', () => {
    const giantLog = 'X'.repeat(20050);
    const job = {
      logs: [{ timestamp: null, message: giantLog }]
    };

    const context = hooks.buildJobFailureContext({ label: 'Frontend', kind: 'frontend', job });
    expect(context.logsTruncated).toBe(true);
    expect(context.recentLogs).toEqual(['/* ...logs truncated... */']);
  });

  test('buildJobFailureContext truncates after consuming the exact char budget', () => {
    const exactBudgetLog = 'Z'.repeat(19999);
    const job = {
      logs: [{ timestamp: null, message: exactBudgetLog }]
    };

    const context = hooks.buildJobFailureContext({ label: 'Frontend', kind: 'frontend', job });
    expect(context.logsTruncated).toBe(true);
    expect(context.recentLogs[0].length).toBe(19999);
    expect(context.recentLogs.at(-1)).toBe('/* ...logs truncated... */');
  });

  test('buildJobFailureContext prefers explicit error text over summary fallbacks', () => {
    const job = {
      error: '  Primary failure  ',
      summary: { error: 'Secondary text' },
      logs: []
    };

    const context = hooks.buildJobFailureContext({ label: 'Frontend', kind: 'frontend', job });
    expect(context.error).toBe('Primary failure');
  });

  test('buildTestFailureContext filters invalid entries and stamps generatedAt', () => {
    const context = hooks.buildTestFailureContext([
      { label: 'Skip', job: null },
      { label: 'Frontend', kind: 'frontend', job: { status: 'failed', logs: [] } }
    ]);

    expect(context).toBeTruthy();
    expect(context.jobs).toHaveLength(1);
    expect(context.jobs[0].label).toBe('Frontend');
    expect(typeof context.generatedAt).toBe('string');
  });

  test('renderLogLines renders placeholders and highlights pass/fail tokens', () => {
    const emptyView = render(<div>{hooks.renderLogLines({ logs: [] })}</div>);
    expect(emptyView.getByTestId('test-job-empty-logs')).toBeInTheDocument();

    emptyView.unmount();

    const job = {
      logs: [{ message: 'PASS 1 tests passed' }, { message: 'FAIL  src/components/App.test.jsx' }]
    };
    const populatedView = render(<div>{hooks.renderLogLines(job)}</div>);
    expect(populatedView.container.querySelectorAll('.log-highlight.pass').length).toBeGreaterThan(0);
    expect(populatedView.container.querySelectorAll('.log-highlight.fail').length).toBeGreaterThan(0);
    populatedView.unmount();
  });

  test('buildTestFailureContext returns null for missing or empty inputs', () => {
    expect(hooks.buildTestFailureContext()).toBeNull();
    expect(hooks.buildTestFailureContext([])).toBeNull();
    expect(hooks.buildTestFailureContext([{ label: 'Skip', job: null }])).toBeNull();
  });
});
