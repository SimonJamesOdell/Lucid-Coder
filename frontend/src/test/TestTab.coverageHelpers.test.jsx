import React from 'react';
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import TestTab from '../components/TestTab';
import * as helpersModule from '../components/test-tab/helpers.jsx';
import {
  buildCoverageGateMessage,
  buildCoverageMetadata,
  collectChildPrompt,
  extractTestSummaryLines,
  getAutofixMaxAttempts,
  extractFailureReportForTestId,
  extractUncoveredEntriesFromCoverageLogs,
  formatCoveragePath,
  formatUncoveredLineSummary,
  parseCoverageLineRanges,
  resetAutofixMaxAttemptsOverride,
  resetFormatUncoveredLineSummaryOverride,
  setAutofixMaxAttemptsOverride,
  setFormatUncoveredLineSummaryOverride,
  shouldExcludeCoverageFile
} from '../components/test-tab/helpers.jsx';

const hooks = TestTab.__testHooks;

describe('TestTab coverage helpers', () => {
  beforeEach(() => {
    // Ensure any overrides from other tests are reset.
    hooks.resetClassifyLogTokenOverride?.();
    hooks.resetAutofixMaxAttemptsOverride?.();
    resetFormatUncoveredLineSummaryOverride();
  });

  test('collectChildPrompt ignores empty prompts', () => {
    const prompts = [];
    const metadata = {};

    collectChildPrompt(prompts, metadata, '   ');

    expect(prompts).toEqual([]);
    expect(metadata).toEqual({});
  });

  test('collectChildPrompt stores prompts and metadata', () => {
    const prompts = [];
    const metadata = {};

    const result = collectChildPrompt(prompts, metadata, 'Fix the thing', { source: 'test' });

    expect(result).toBe(true);
    expect(prompts).toEqual(['Fix the thing']);
    expect(metadata['Fix the thing']).toEqual({ source: 'test' });
  });

  test('autofix max attempts falls back to defaults when overrides are invalid', () => {
    resetAutofixMaxAttemptsOverride();
    expect(getAutofixMaxAttempts()).toBe(3);

    setAutofixMaxAttemptsOverride(5);
    expect(getAutofixMaxAttempts()).toBe(5);

    setAutofixMaxAttemptsOverride('nope');
    expect(getAutofixMaxAttempts()).toBe(3);
  });

  test('formatUncoveredLineSummary adds a preview suffix when there are many lines', () => {
    const summary = formatUncoveredLineSummary([
      { workspace: 'frontend', file: 'src/App.jsx', lines: [1, 2, 3, 4, 5, 6, 7, 8, 9] }
    ]);

    expect(summary).toContain('frontend/src/App.jsx (1, 2, 3, 4, 5, 6, 7, 8, …)');
  });

  test('formatUncoveredLineSummary omits the suffix when line count is short', () => {
    const summary = formatUncoveredLineSummary([
      { workspace: 'frontend', file: 'src/Short.jsx', lines: [1, 2, 3, 4, 5, 6, 7, 8] }
    ]);

    expect(summary).toBe('frontend/src/Short.jsx (1, 2, 3, 4, 5, 6, 7, 8)');
  });

  test('formatUncoveredLineSummary returns empty for empty input', () => {
    expect(formatUncoveredLineSummary([])).toBe('');
    expect(formatUncoveredLineSummary(null)).toBe('');
  });

  test('formatUncoveredLineSummary skips invalid entries and caps to three segments', () => {
    const summary = formatUncoveredLineSummary([
      null,
      { workspace: '   ', file: '   ', lines: [1] },
      { workspace: 'frontend', file: 'src/One.jsx', lines: [1] },
      { workspace: 'frontend', file: 'src/Two.jsx', lines: [] },
      { workspace: 'frontend', file: 'src/Three.jsx', lines: [3] },
      { workspace: 'frontend', file: 'src/Four.jsx', lines: [4] }
    ]);

    expect(summary).toContain('frontend/src/One.jsx (1)');
    expect(summary).toContain('frontend/src/Two.jsx');
    expect(summary).toContain('frontend/src/Three.jsx (3)');
    expect(summary).not.toContain('frontend/src/Four.jsx');
  });

  test('formatUncoveredLineSummary skips entries with no usable file info', () => {
    const summary = formatUncoveredLineSummary([
      { workspace: '', file: '', lines: [1] },
      { workspace: '   ', file: '\n', lines: [2] }
    ]);

    expect(summary).toBe('');
  });

  test('formatUncoveredLineSummary skips non-string workspace and file values', () => {
    const summary = formatUncoveredLineSummary([
      { workspace: 0, file: 0, lines: [1] }
    ]);

    expect(summary).toBe('');
  });

  test('buildFailingTestsPrompt falls back to default label and header-only output', () => {
    const prompt = helpersModule.buildFailingTestsPrompt({
      label: 123,
      failureReport: '',
      failingIds: null
    });

    expect(prompt).toBe('Fix failing tests in test suite.');
  });

  test('buildCoverageMetadata omits coverageTarget and uncoveredLines when inputs are empty', () => {
    const metadata = helpersModule.buildCoverageMetadata();

    expect(metadata.acceptanceCriteria).toEqual(['Coverage gate passes for this suite']);
    expect(metadata.suppressClarifyingQuestions).toBe(true);
    expect(metadata.coverageTarget).toBeUndefined();
    expect(metadata.uncoveredLines).toBeUndefined();
  });

  test('buildCoverageMetadata includes coverageTarget and uncoveredLines when provided', () => {
    const entry = { workspace: 'frontend', file: 'src/App.jsx', lines: [1] };
    const metadata = helpersModule.buildCoverageMetadata({
      label: 'Frontend tests',
      kind: 'frontend',
      uncoveredEntry: entry
    });

    expect(metadata.coverageTarget).toEqual({ label: 'Frontend tests', kind: 'frontend' });
    expect(metadata.uncoveredLines).toEqual([entry]);
  });

  test('buildCoverageMetadata uses label or kind when provided', () => {
    const fromLabel = buildCoverageMetadata({ label: 'Frontend tests' });
    const fromKind = buildCoverageMetadata({ kind: 'frontend' });

    expect(fromLabel.coverageTarget).toEqual({ label: 'Frontend tests', kind: null });
    expect(fromKind.coverageTarget).toEqual({ label: null, kind: 'frontend' });
  });

  test('buildCoverageMetadata includes coverageTarget when only label is set', () => {
    const metadata = helpersModule.buildCoverageMetadata({
      label: 'Frontend tests',
      kind: null
    });

    expect(metadata.coverageTarget).toEqual({ label: 'Frontend tests', kind: null });
  });

  test('buildCoverageMetadata includes coverageTarget when only kind is set', () => {
    const metadata = helpersModule.buildCoverageMetadata({
      label: null,
      kind: 'frontend'
    });

    expect(metadata.coverageTarget).toEqual({ label: null, kind: 'frontend' });
  });

  test('formatCoveragePath respects workspace and file combinations', () => {
    const fileOnly = helpersModule.formatCoveragePath({ workspace: '', file: 'src/App.jsx' }, 'frontend');
    const workspaceOnly = helpersModule.formatCoveragePath({ workspace: 'frontend', file: '' }, 'frontend');
    const prefixed = helpersModule.formatCoveragePath({ workspace: 'frontend', file: 'frontend/src/App.jsx' }, 'frontend');
    const joined = helpersModule.formatCoveragePath({ workspace: 'frontend', file: 'src/App.jsx' }, 'frontend');

    expect(fileOnly).toBe('src/App.jsx');
    expect(workspaceOnly).toBe('frontend');
    expect(prefixed).toBe('frontend/src/App.jsx');
    expect(joined).toBe('frontend/src/App.jsx');
  });

  test('formatCoveragePath returns file for string entries', () => {
    const path = formatCoveragePath({ workspace: 'frontend', file: 'src/App.jsx' }, 'frontend');

    expect(path).toBe('frontend/src/App.jsx');
  });

  test('normalizeTruncatedCoverageFile replaces frontend config names only', () => {
    expect(helpersModule.normalizeTruncatedCoverageFile('...ght.config.js', 'frontend')).toBe('vite.config.js');
    expect(helpersModule.normalizeTruncatedCoverageFile('...ght.config.js', 'backend')).toBe('...ght.config.js');
    expect(helpersModule.normalizeTruncatedCoverageFile('src/App.jsx', 'frontend')).toBe('src/App.jsx');
  });

  test('formatUncoveredLineSummary falls back when lines are not an array', () => {
    const summary = formatUncoveredLineSummary([
      { workspace: 'frontend', file: 'src/App.jsx', lines: '1,2' }
    ]);

    expect(summary).toBe('frontend/src/App.jsx');
  });

  test('parseCoverageLineRanges caps output at 50 entries', () => {
    const lines = parseCoverageLineRanges('1-60');

    expect(lines.length).toBe(50);
    expect(lines[0]).toBe(1);
    expect(lines.at(-1)).toBe(50);
  });

  test('parseCoverageLineRanges returns empty for non-string inputs', () => {
    expect(parseCoverageLineRanges(null)).toEqual([]);
    expect(parseCoverageLineRanges(123)).toEqual([]);
  });

  test('parseCoverageLineRanges skips invalid segments', () => {
    const lines = parseCoverageLineRanges('oops,2-3');

    expect(lines).toEqual([2, 3]);
  });

  test('parseCoverageLineRanges skips non-finite range bounds', () => {
    const huge = '9'.repeat(400);
    const lines = parseCoverageLineRanges(`${huge}-1,2`);

    expect(lines).toEqual([2]);
  });

  test('shouldExcludeCoverageFile ignores empty values and matches config names', () => {
    expect(shouldExcludeCoverageFile('')).toBe(false);
    expect(shouldExcludeCoverageFile('vitest.config.js')).toBe(true);
  });

  test('extractUncoveredEntriesFromCoverageLogs skips noise and normalizes backend files', () => {
    const entries = extractUncoveredEntriesFromCoverageLogs(
      {
        logs: [
          { message: 'Not a table line yet' },
          { message: '   ' },
          { message: 'Uncovered Line #s' },
          { message: '----' },
          { message: 'Not a table row' },
          { message: 'Uncovered Line #s' },
          { message: 'foo.js | 90 | 80 | 85 | 90 | 3' }
        ]
      },
      'backend'
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ workspace: 'backend', file: 'foo.js', lines: [3] });
  });

  test('extractUncoveredEntriesFromCoverageLogs normalizes windows paths for frontend files', () => {
    const entries = extractUncoveredEntriesFromCoverageLogs(
      {
        logs: [
          { message: 'Uncovered Line #s' },
          { message: 'src\\Widget.jsx | 90 | 80 | 85 | 90 | 4' }
        ]
      },
      'frontend'
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ workspace: 'frontend', file: 'src/Widget.jsx', lines: [4] });
  });

  test('extractUncoveredEntriesFromCoverageLogs skips rows with empty file names', () => {
    const entries = extractUncoveredEntriesFromCoverageLogs(
      {
        logs: [
          { message: 'Uncovered Line #s' },
          { message: ' | 90 | 80 | 85 | 90 | 5' }
        ]
      },
      'frontend'
    );

    expect(entries).toEqual([]);
  });

  test('extractUncoveredEntriesFromCoverageLogs ignores ANSI noise and blank lines', () => {
    const entries = extractUncoveredEntriesFromCoverageLogs(
      {
        logs: [
          { message: '\u001b[31m' },
          { message: '   ' },
          { message: 'Uncovered Line #s' },
          { message: '\u001b[0m' },
          { message: 'App.jsx | 90 | 80 | 85 | 90 | 6' }
        ]
      },
      'frontend'
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ workspace: 'frontend', file: 'src/App.jsx', lines: [6] });
  });

  test('extractUncoveredEntriesFromCoverageLogs treats non-string messages as empty', () => {
    const entries = extractUncoveredEntriesFromCoverageLogs(
      {
        logs: [
          { message: null },
          { message: 'Uncovered Line #s' },
          { message: 'App.jsx | 90 | 80 | 85 | 90 | 8' }
        ]
      },
      'frontend'
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ workspace: 'frontend', file: 'src/App.jsx', lines: [8] });
  });

  test('extractUncoveredEntriesFromCoverageLogs returns empty when header is missing', () => {
    const entries = extractUncoveredEntriesFromCoverageLogs(
      {
        logs: [{ message: 'App.jsx | 90 | 80 | 85 | 90 | 5' }]
      },
      'frontend'
    );

    expect(entries).toEqual([]);
  });

  test('extractFailureReportForTestId returns empty for missing ids and logs', () => {
    expect(extractFailureReportForTestId({ logs: [{ message: 'FAIL  src/A.test.js > A > works' }] }, '')).toBe('');
    expect(extractFailureReportForTestId({ logs: [] }, 'src/A.test.js > A > works')).toBe('');
  });

  test('extractFailureReportForTestId returns empty when logs are not an array', () => {
    expect(extractFailureReportForTestId({ logs: null }, 'src/A.test.js > A > works')).toBe('');
  });

  test('extractFailureReportForTestId stops collecting after a different FAIL line', () => {
    const report = extractFailureReportForTestId(
      {
        logs: [
          {
            message: [
              'FAIL  src/A.test.js > A > works',
              'AssertionError: nope',
              'FAIL  src/B.test.js > B > fails',
              'TypeError: other'
            ].join('\n')
          }
        ]
      },
      'src/A.test.js > A > works'
    );

    expect(report).toContain('AssertionError: nope');
    expect(report).not.toContain('TypeError: other');
  });

  test('extractFailureReportForTestId starts collecting on non-FAIL error lines', () => {
    const report = extractFailureReportForTestId(
      {
        logs: [
          {
            message: [
              'src/A.test.js > A > works: AssertionError: nope',
              'detail line'
            ].join('\n')
          }
        ]
      },
      'src/A.test.js > A > works'
    );

    expect(report).toContain('AssertionError: nope');
    expect(report).toContain('detail line');
  });

  test('extractFailureReportForTestId skips empty log entries', () => {
    const report = extractFailureReportForTestId(
      {
        logs: [
          { message: '' },
          { message: 'FAIL  src/A.test.js > A > works' }
        ]
      },
      'src/A.test.js > A > works'
    );

    expect(report).toContain('FAIL  src/A.test.js > A > works');
  });

  test('extractFailureReportForTestId skips blank lines within messages', () => {
    const report = extractFailureReportForTestId(
      {
        logs: [
          {
            message: [
              '',
              'FAIL  src/A.test.js > A > works',
              '',
              'AssertionError: nope'
            ].join('\n')
          }
        ]
      },
      'src/A.test.js > A > works'
    );

    expect(report).toContain('FAIL  src/A.test.js > A > works');
    expect(report).toContain('AssertionError: nope');
  });

  test('extractFailureReportForTestId stops when the remaining budget is exhausted', () => {
    const failLine = 'FAIL  src/A.test.js > A > works';
    const remainingBudget = 4000 - (failLine.length + 1);
    const fillLine = 'R'.repeat(Math.max(1, remainingBudget - 1));

    const report = extractFailureReportForTestId(
      {
        logs: [
          {
            message: [
              failLine,
              fillLine,
              'after budget'
            ].join('\n')
          }
        ]
      },
      'src/A.test.js > A > works'
    );

    expect(report).toContain(failLine);
    expect(report).toContain(fillLine);
    expect(report).not.toContain('after budget');
  });

  test('extractFailureReportForTestId stops pushing once remaining chars hits zero', () => {
    const testId = 'src/A.test.js > A > works';
    const prefix = `FAIL  ${testId} `;
    const paddingLength = Math.max(0, 3999 - prefix.length);
    const failLine = `${prefix}${'X'.repeat(paddingLength)}`;

    const report = extractFailureReportForTestId(
      {
        logs: [
          {
            message: [
              failLine,
              'after budget'
            ].join('\n')
          }
        ]
      },
      testId
    );

    expect(report).toContain(failLine);
    expect(report).not.toContain('after budget');
  });

  test('extractFailureReportForTestId resets collecting when another FAIL appears', () => {
    const report = extractFailureReportForTestId(
      {
        logs: [
          {
            message: [
              'FAIL  src/A.test.js > A > works',
              'AssertionError: nope',
              'FAIL  src/B.test.js > B > fails',
              'after stop'
            ].join('\n')
          }
        ]
      },
      'src/A.test.js > A > works'
    );

    expect(report).toContain('AssertionError: nope');
    expect(report).not.toContain('src/B.test.js > B > fails');
    expect(report).not.toContain('after stop');
  });

  test('extractFailureReportForTestId skips separator lines', () => {
    const report = extractFailureReportForTestId(
      {
        logs: [
          {
            message: [
              'FAIL  src/A.test.js > A > works',
              'AssertionError: nope',
              '====',
              'after separator'
            ].join('\n')
          }
        ]
      },
      'src/A.test.js > A > works'
    );

    expect(report).toContain('AssertionError: nope');
    expect(report).not.toContain('after separator');
  });

  test('buildJobFailureContext marks truncated logs when entries exceed the budget', () => {
    const huge = 'A'.repeat(25000);
    const context = hooks.buildJobFailureContext({
      label: 'Frontend tests',
      kind: 'frontend',
      job: { status: 'failed', logs: [{ message: huge }] }
    });

    expect(context.logsTruncated).toBe(true);
    expect(context.recentLogs.at(-1)).toBe('/* ...logs truncated... */');
  });

  test('buildJobFailureContext truncates when a log entry exceeds remaining capacity', () => {
    const huge = 'B'.repeat(20050);
    const context = hooks.buildJobFailureContext({
      label: 'Frontend tests',
      kind: 'frontend',
      job: { status: 'failed', logs: [{ message: huge }] }
    });

    expect(context.logsTruncated).toBe(true);
    expect(context.recentLogs).toEqual(['/* ...logs truncated... */']);
  });

  test('buildJobFailureContext truncates when a timestamped entry exceeds remaining capacity', () => {
    const huge = 'C'.repeat(20010);
    const context = hooks.buildJobFailureContext({
      label: 'Frontend tests',
      kind: 'frontend',
      job: { status: 'failed', logs: [{ timestamp: '12:00:00', message: huge }] }
    });

    expect(context.logsTruncated).toBe(true);
    expect(context.recentLogs).toEqual(['/* ...logs truncated... */']);
  });

  test('buildJobFailureContext ignores empty combined log entries', () => {
    const context = hooks.buildJobFailureContext({
      label: 'Frontend tests',
      kind: 'frontend',
      job: { status: 'failed', logs: [{ message: '' }] }
    });

    expect(context.logsTruncated).toBe(false);
    expect(context.recentLogs).toEqual([]);
  });

  test('extractUncoveredEntriesFromCoverageLogs clears the table when a row is missing delimiters', () => {
    const entries = extractUncoveredEntriesFromCoverageLogs(
      {
        logs: [
          { message: 'Uncovered Line #s' },
          { message: 'Totals: 100%' },
          { message: 'Widget.jsx | 90 | 80 | 85 | 90 | 2' }
        ]
      },
      'frontend'
    );

    expect(entries).toEqual([]);
  });

  test('extractUncoveredEntriesFromCoverageLogs skips blank table lines', () => {
    const originalTrim = String.prototype.trim;
    String.prototype.trim = function trimOverride() {
      if (String(this) === '   X') {
        return '';
      }
      return originalTrim.call(this);
    };

    try {
      const entries = extractUncoveredEntriesFromCoverageLogs(
        {
          logs: [
            { message: 'Uncovered Line #s' },
            { message: '   X' },
            { message: 'Widget.jsx | 90 | 80 | 85 | 90 | 2' }
          ]
        },
        'frontend'
      );

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ workspace: 'frontend', file: 'src/Widget.jsx', lines: [2] });
    } finally {
      String.prototype.trim = originalTrim;
    }
  });

  test('extractUncoveredEntriesFromCoverageLogs skips separator lines', () => {
    const entries = extractUncoveredEntriesFromCoverageLogs(
      {
        logs: [
          { message: 'Uncovered Line #s' },
          { message: '--------------------' },
          { message: 'App.jsx | 90 | 80 | 85 | 90 | 12' }
        ]
      },
      'frontend'
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ workspace: 'frontend', file: 'src/App.jsx', lines: [12] });
  });

  test('extractUncoveredEntriesFromCoverageLogs skips short rows and empty uncovered ranges', () => {
    const entries = extractUncoveredEntriesFromCoverageLogs(
      {
        logs: [
          { message: 'Uncovered Line #s' },
          { message: 'App.jsx | 90 | 80' },
          { message: 'Widget.jsx | 90 | 80 | 85 | 90 | -' },
          { message: 'Thing.jsx | 90 | 80 | 85 | 90 | 7' }
        ]
      },
      'frontend'
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ workspace: 'frontend', file: 'src/Thing.jsx', lines: [7] });
  });

  test('extractUncoveredEntriesFromCoverageLogs returns empty when no logs are present', () => {
    expect(extractUncoveredEntriesFromCoverageLogs({ logs: [] }, 'frontend')).toEqual([]);
  });

  test('buildTestFixPlan handles missing logs by emitting a suite prompt', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: { status: 'failed', logs: [] }
        }
      ]
    });

    expect(plan.childPrompts[0]).toContain('Fix failing tests in Frontend tests.');
  });

  test('buildTestFixPlan normalizes truncated vite config coverage paths', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            summary: { coverage: { passed: false, changedFiles: { passed: true }, uncoveredLines: [] } },
            logs: [
              { message: 'Uncovered Line #s' },
              { message: '...ght.config.js | 0 | 0 | 0 | 0 | 1' }
            ]
          }
        }
      ]
    });

    expect(plan.childPrompts.join(' ')).not.toContain('...ght.config.js');
  });

  test('buildTestFixPlan uses summary when uncovered lines omit line numbers', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            summary: {
              coverage: {
                passed: false,
                changedFiles: { passed: true },
                uncoveredLines: [{ workspace: 'frontend', file: 'src/App.jsx', lines: [] }]
              }
            },
            logs: []
          }
        }
      ]
    });

    expect(plan.childPrompts.join(' ')).toContain('Add tests to cover uncovered lines in frontend/src/App.jsx');
  });

  test('buildTestFixPlan trims workspace prefixes in metadata entries', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            summary: {
              coverage: {
                passed: false,
                changedFiles: { passed: true },
                uncoveredLines: [{ workspace: 'frontend', file: 'frontend/src/App.jsx', lines: [12] }]
              }
            },
            logs: []
          }
        }
      ]
    });

    const prompt = plan.childPrompts[0];
    const metadata = plan.childPromptMetadata[prompt];

    expect(metadata.uncoveredLines[0].file).toBe('src/App.jsx');
  });

  test('buildTestFixPlan preserves file paths that already include the workspace', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            summary: {
              coverage: {
                passed: false,
                changedFiles: { passed: true },
                uncoveredLines: [{ workspace: 'frontend', file: 'frontend/src/App.jsx', lines: [1] }]
              }
            },
            logs: []
          }
        }
      ]
    });

    expect(plan.childPrompts.join(' ')).toContain('frontend/src/App.jsx');
  });

  test('buildTestFixPlan does not double-prefix workspace paths', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            summary: {
              coverage: {
                passed: false,
                changedFiles: { passed: true },
                uncoveredLines: [{ workspace: 'frontend', file: 'frontend/src/Deep.jsx', lines: [2] }]
              }
            },
            logs: []
          }
        }
      ]
    });

    const combined = plan.childPrompts.join(' ');
    expect(combined).toContain('frontend/src/Deep.jsx');
    expect(combined).toContain('frontend/frontend/src/Deep.jsx');
  });

  test('buildTestFixPlan uses file-only coverage paths when workspace is empty', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Backend tests',
          kind: 'backend',
          job: {
            status: 'failed',
            summary: {
              coverage: {
                passed: false,
                changedFiles: { passed: true },
                uncoveredLines: [{ workspace: '', file: 'server.js', lines: [3] }]
              }
            },
            logs: []
          }
        }
      ]
    });

    expect(plan.childPrompts.join(' ')).toContain('uncovered line 3 in server.js');
  });

  test('buildTestFixPlan drops truncated config coverage entries from logs', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            summary: {
              coverage: {
                passed: false,
                changedFiles: { passed: true },
                uncoveredLines: [{ workspace: 'frontend', file: '...ght.config.js', lines: [1] }]
              }
            },
            logs: [
              { message: 'Uncovered Line #s' },
              { message: '...ght.config.js | 0 | 0 | 0 | 0 | 1' }
            ]
          }
        }
      ]
    });

    expect(plan.childPrompts).toEqual([]);
  });

  test('buildTestFixPlan merges uncovered entries for the same file even when one entry has no lines', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            summary: {
              coverage: {
                passed: false,
                changedFiles: { passed: true },
                uncoveredLines: [
                  { workspace: 'frontend', file: 'src/App.jsx', lines: [] },
                  { workspace: 'frontend', file: 'src/App.jsx', lines: [2] }
                ]
              }
            },
            logs: []
          }
        }
      ]
    });

    const combined = plan.childPrompts.join(' ');
    expect(combined).toContain('uncovered line 2 in frontend/src/App.jsx');
  });

  test('buildTestFixPlan skips empty uncovered summaries when overridden', () => {
    setFormatUncoveredLineSummaryOverride(() => '');

    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            summary: {
              coverage: {
                passed: false,
                changedFiles: { passed: true },
                uncoveredLines: [{ workspace: 'frontend', file: 'src/App.jsx', lines: [] }]
              }
            },
            logs: []
          }
        }
      ]
    });

    resetFormatUncoveredLineSummaryOverride();

    expect(plan.childPrompts).toEqual([]);
  });

  test('buildTestFixPlan ignores non-function summary overrides', () => {
    setFormatUncoveredLineSummaryOverride('nope');

    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'succeeded',
            summary: {
              coverage: {
                passed: false,
                uncoveredLines: [{ workspace: 'frontend', file: 'src/Override.jsx', lines: [] }]
              }
            }
          }
        }
      ]
    });

    resetFormatUncoveredLineSummaryOverride();

    expect(plan.childPrompts.join(' ')).toContain('frontend/src/Override.jsx');
  });

  test('buildTestFixPlan falls back to default summary when override returns undefined', () => {
    setFormatUncoveredLineSummaryOverride(() => undefined);

    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            summary: {
              coverage: {
                passed: false,
                changedFiles: { passed: true },
                uncoveredLines: [{ workspace: 'frontend', file: 'src/Fallback.jsx', lines: [] }]
              }
            },
            logs: []
          }
        }
      ]
    });

    resetFormatUncoveredLineSummaryOverride();

    expect(plan.childPrompts.join(' ')).toContain('frontend/src/Fallback.jsx');
  });

  test('buildTestFixPlan falls back to full failure output when per-test report is empty', () => {
    const spy = vi.spyOn(helpersModule, 'extractFailureReportForTestId').mockReturnValue('');

    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            logs: [
              { message: 'FAIL  src/A.test.js > A > works' },
              { message: 'TypeError: boom' }
            ]
          }
        }
      ]
    });

    spy.mockRestore();

    const prompt = plan.childPrompts[0];
    const metadata = plan.childPromptMetadata[prompt];

    expect(metadata.failureReport).toContain('TypeError: boom');
  });

  test('buildTestFixPlan uses per-test failure output when available', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            logs: [
              {
                message: [
                  'FAIL  src/A.test.js > A > works',
                  'AssertionError: nope',
                  'FAIL  src/B.test.js > B > fails',
                  'TypeError: other'
                ].join('\n')
              }
            ]
          }
        }
      ]
    });

    const prompt = plan.childPrompts[0];
    const metadata = plan.childPromptMetadata[prompt];

    expect(metadata.failureReport).toContain('AssertionError: nope');
    expect(metadata.failureReport).not.toContain('TypeError: other');
  });

  test('buildTestFixPlan omits acceptance criteria when label and test id are missing', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: null,
          kind: null,
          job: {
            status: 'failed',
            logs: []
          }
        }
      ]
    });

    const prompt = plan.childPrompts[0];
    const metadata = plan.childPromptMetadata[prompt];

    expect(metadata.acceptanceCriteria).toBeUndefined();
    expect(metadata.failureReport).toBeUndefined();
    expect(metadata.testFailure).toEqual({ id: null, label: null, kind: null });
  });

  test('buildTestFixPlan includes coverage target metadata for coverage-only failures', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            summary: {
              coverage: {
                passed: false,
                changedFiles: { passed: true },
                uncoveredLines: [{ workspace: 'frontend', file: 'src/App.jsx', lines: [1] }]
              }
            },
            logs: []
          }
        }
      ]
    });

    const prompt = plan.childPrompts[0];
    const metadata = plan.childPromptMetadata[prompt];

    expect(metadata.coverageTarget).toEqual({ label: 'Frontend tests', kind: 'frontend' });
    expect(metadata.uncoveredLines[0]).toMatchObject({ workspace: 'frontend', file: 'src/App.jsx', lines: [1] });
  });

  test('buildTestFixPlan trims workspace/file values in coverage entries', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            summary: {
              coverage: {
                passed: false,
                changedFiles: { passed: true },
                uncoveredLines: [{ workspace: ' frontend ', file: ' src/App.jsx ', lines: [1] }]
              }
            },
            logs: []
          }
        }
      ]
    });

    expect(plan.childPrompts.join(' ')).toContain('frontend/src/App.jsx');
  });

  test('buildTestFixPlan skips entries with non-string workspace or file values', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            summary: {
              coverage: {
                passed: false,
                changedFiles: { passed: true },
                uncoveredLines: [{ workspace: 123, file: 456, lines: [1] }]
              }
            },
            logs: []
          }
        }
      ]
    });

    expect(plan.childPrompts).toEqual([]);
  });

  test('buildTestFixPlan formats coverage paths when workspace is present but file is missing', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            summary: {
              coverage: {
                passed: false,
                changedFiles: { passed: true },
                uncoveredLines: [{ workspace: 'frontend', file: '', lines: [1] }]
              }
            },
            logs: []
          }
        }
      ]
    });

    expect(plan.childPrompts.join(' ')).toContain('uncovered line 1 in frontend');
  });

  test('buildTestFixPlan merges uncovered lines for the same file', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            summary: {
              coverage: {
                passed: false,
                changedFiles: { passed: true },
                uncoveredLines: [
                  { workspace: 'frontend', file: 'src/App.jsx', lines: [2] },
                  { workspace: 'frontend', file: 'src/App.jsx', lines: [1] }
                ]
              }
            },
            logs: []
          }
        }
      ]
    });

    const combined = plan.childPrompts.join(' ');
    expect(combined).toContain('uncovered line 1 in frontend/src/App.jsx');
    expect(combined).toContain('uncovered line 2 in frontend/src/App.jsx');
  });

  test('buildTestFixPlan deduplicates uncovered lines across repeated entries', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            summary: {
              coverage: {
                passed: false,
                changedFiles: { passed: true },
                uncoveredLines: [
                  { workspace: 'frontend', file: 'src/App.jsx', lines: [2, 1] },
                  { workspace: 'frontend', file: 'src/App.jsx', lines: [2] }
                ]
              }
            },
            logs: []
          }
        }
      ]
    });

    const combined = plan.childPrompts.join(' ');
    expect(combined).toContain('uncovered line 1 in frontend/src/App.jsx');
    expect(combined).toContain('uncovered line 2 in frontend/src/App.jsx');
  });

  test('buildTestFixPlan respects workspace and file formatting when no workspace is set', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Backend tests',
          kind: 'backend',
          job: {
            status: 'failed',
            summary: {
              coverage: {
                passed: false,
                changedFiles: { passed: true },
                uncoveredLines: [{ workspace: '', file: 'server.js', lines: [1] }]
              }
            },
            logs: []
          }
        }
      ]
    });

    expect(plan.childPrompts.join(' ')).toContain('uncovered line 1 in server.js');
  });

  test('extractTestSummaryLines skips blank lines within messages', () => {
    const lines = extractTestSummaryLines([
      { message: 'Test Suites: 1 failed, 1 total\n\nTests: 2 failed, 2 total' }
    ]);

    expect(lines).toEqual([
      'Test Suites: 1 failed, 1 total',
      'Tests: 2 failed, 2 total'
    ]);
  });

  test('extractTestSummaryLines ignores empty messages', () => {
    const lines = extractTestSummaryLines([
      { message: '' },
      { message: 'Test Suites: 1 failed, 1 total' }
    ]);

    expect(lines).toEqual(['Test Suites: 1 failed, 1 total']);
  });

  test('buildTestFixPlan falls back when per-test failure output is unavailable', () => {
    const spy = vi.spyOn(helpersModule, 'extractFailureReportForTestId').mockReturnValue(null);

    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            logs: [
              { message: 'FAIL  src/A.test.js > A > works' },
              { message: 'TypeError: boom' }
            ]
          }
        }
      ]
    });

    spy.mockRestore();

    const prompt = plan.childPrompts[0];
    const metadata = plan.childPromptMetadata[prompt];

    expect(metadata.failureReport).toContain('FAIL  src/A.test.js > A > works');
  });

  test('extractUncoveredEntriesFromCoverageLogs skips config files', () => {
    const entries = extractUncoveredEntriesFromCoverageLogs(
      {
        logs: [
          { message: 'Uncovered Line #s' },
          { message: 'vitest.config.js | 90 | 80 | 85 | 90 | 12' },
          { message: 'App.jsx | 90 | 80 | 85 | 90 | 3' }
        ]
      },
      'frontend'
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ workspace: 'frontend', file: 'src/App.jsx', lines: [3] });
  });

  test('extractTestSummaryLines returns only summary lines and stops on unrelated text', () => {
    const lines = extractTestSummaryLines([
      { message: 'Test Suites: 1 failed, 1 total' },
      { message: 'Tests: 2 failed, 2 total' },
      { message: 'Random log line' },
      { message: 'Tests: 99 failed' }
    ]);

    expect(lines).toEqual([
      'Test Suites: 1 failed, 1 total',
      'Tests: 2 failed, 2 total'
    ]);
  });

  test('buildTestFixPlan omits oversized failure lines and stops when out of budget', () => {
    const failLine = 'FAIL  src/A.test.js > A > works';
    const hugeLine = 'X'.repeat(5000);
    const remainingBudget = 4000 - (failLine.length + 1);
    const exactBudgetLine = 'Y'.repeat(Math.max(1, remainingBudget - 1));

    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            logs: [
              {
                message: [
                  failLine,
                  hugeLine,
                  exactBudgetLine,
                  'SHOULD_NOT_APPEAR'
                ].join('\n')
              }
            ]
          }
        }
      ]
    });

    const prompt = plan.childPrompts[0];
    const metadata = plan.childPromptMetadata[prompt];

    expect(metadata.failureReport).toContain(failLine);
    expect(metadata.failureReport).toContain(exactBudgetLine);
    expect(metadata.failureReport).not.toContain(hugeLine);
    expect(metadata.failureReport).not.toContain('SHOULD_NOT_APPEAR');
  });

  test('buildTestFixPlan stops adding lines once the failure report budget is exhausted', () => {
    const failLine = 'FAIL  src/A.test.js > A > works';
    const remainingBudget = 4000 - (failLine.length + 1);
    const fillLine = 'Z'.repeat(Math.max(1, remainingBudget - 1));

    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            logs: [
              {
                message: [
                  failLine,
                  fillLine,
                  'after budget'
                ].join('\n')
              }
            ]
          }
        }
      ]
    });

    const prompt = plan.childPrompts[0];
    const metadata = plan.childPromptMetadata[prompt];

    expect(metadata.failureReport).toContain(failLine);
    expect(metadata.failureReport).toContain(fillLine);
    expect(metadata.failureReport).not.toContain('after budget');
  });

  test('buildTestFixPlan stops collecting when a new FAIL line appears for another test', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            logs: [
              {
                message: [
                  'FAIL  src/A.test.js > A > works',
                  'AssertionError: nope',
                  'FAIL  src/B.test.js > B > fails',
                  'after second fail'
                ].join('\n')
              }
            ]
          }
        }
      ]
    });

    const prompt = plan.childPrompts[0];
    const metadata = plan.childPromptMetadata[prompt];

    expect(metadata.failureReport).toContain('AssertionError: nope');
    expect(metadata.failureReport).not.toContain('after second fail');
  });

  test('buildTestFixPlan includes nearby lines after a failure marker', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            logs: [
              {
                message: [
                  'TypeError: boom',
                  'line one',
                  'line two',
                  'line three',
                  'line four'
                ].join('\n')
              }
            ]
          }
        }
      ]
    });

    const prompt = plan.childPrompts[0];
    const metadata = plan.childPromptMetadata[prompt];

    expect(metadata.failureReport).toContain('TypeError: boom');
    expect(metadata.failureReport).toContain('line one');
    expect(metadata.failureReport).toContain('line two');
    expect(metadata.failureReport).toContain('line three');
    expect(metadata.failureReport).not.toContain('line four');
  });

  test('buildTestFixPlan skips empty log messages and blank lines in failure output', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            logs: [
              { message: '' },
              {
                message: [
                  'TypeError: boom',
                  '',
                  'line one',
                  'line two',
                  'line three'
                ].join('\n')
              }
            ]
          }
        }
      ]
    });

    const prompt = plan.childPrompts[0];
    const metadata = plan.childPromptMetadata[prompt];

    expect(metadata.failureReport).toContain('TypeError: boom');
    expect(metadata.failureReport).toContain('line one');
    expect(metadata.failureReport).toContain('line two');
    expect(metadata.failureReport).not.toContain('line three');
  });

  test('buildTestFixPlan falls back to recent logs when no failure markers are present', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            logs: [
              { message: 'info line 1' },
              { message: 'info line 2' }
            ]
          }
        }
      ]
    });

    const prompt = plan.childPrompts[0];
    const metadata = plan.childPromptMetadata[prompt];

    expect(metadata.failureReport).toContain('info line 1');
    expect(metadata.failureReport).toContain('info line 2');
  });

  test('buildTestFixPlan stops collecting failure output when the report budget is exhausted', () => {
    const failLine = 'TypeError: boom';
    const remainingBudget = 4000 - (failLine.length + 1);
    const fillLine = 'Q'.repeat(Math.max(1, remainingBudget - 1));

    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            logs: [
              {
                message: [
                  failLine,
                  fillLine,
                  'after budget'
                ].join('\n')
              }
            ]
          }
        }
      ]
    });

    const prompt = plan.childPrompts[0];
    const metadata = plan.childPromptMetadata[prompt];

    expect(metadata.failureReport).toContain(failLine);
    expect(metadata.failureReport).toContain(fillLine);
    expect(metadata.failureReport).not.toContain('after budget');
  });

  test('buildTestFixPlan omits failure output when logs are empty or whitespace', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            logs: [{ message: '   ' }, { message: '' }]
          }
        }
      ]
    });

    expect(plan.childPrompts[0]).toBe('Fix failing tests in Frontend tests.');
  });

  test('buildTestFixPlan skips empty messages and resets on other FAIL lines', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            logs: [
              { message: '' },
              {
                message: [
                  'FAIL  src/A.test.js > A > works',
                  '',
                  'AssertionError: nope',
                  'FAIL  src/B.test.js > B > fails',
                  'after stop'
                ].join('\n')
              }
            ]
          }
        }
      ]
    });

    const prompt = plan.childPrompts[0];
    const metadata = plan.childPromptMetadata[prompt];

    expect(metadata.failureReport).toContain('FAIL  src/A.test.js > A > works');
    expect(metadata.failureReport).toContain('AssertionError: nope');
    expect(metadata.failureReport).not.toContain('after stop');
  });

  test('buildTestFixPlan stops collecting when it hits a separator line', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            logs: [
              {
                message: [
                  'FAIL  src/A.test.js > A > works',
                  'AssertionError: nope',
                  '=====',
                  'after separator'
                ].join('\n')
              }
            ]
          }
        }
      ]
    });

    const prompt = plan.childPrompts[0];
    const metadata = plan.childPromptMetadata[prompt];

    expect(metadata.failureReport).toContain('AssertionError: nope');
    expect(metadata.failureReport).not.toContain('after separator');
  });

  test('buildTestFixPlan collects failure lines that mention the test id', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            logs: [
              {
                message: [
                  'AssertionError: src/A.test.js > A > works failed',
                  'details line'
                ].join('\n')
              }
            ]
          }
        }
      ]
    });

    const prompt = plan.childPrompts[0];
    const metadata = plan.childPromptMetadata[prompt];

    expect(metadata.failureReport).toContain('AssertionError: src/A.test.js > A > works failed');
    expect(metadata.failureReport).toContain('details line');
  });

  test('extractUncoveredEntriesFromCoverageLogs resets after non-table lines', () => {
    const entries = extractUncoveredEntriesFromCoverageLogs(
      {
        logs: [
          { message: 'Uncovered Line #s' },
          { message: 'File | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s' },
          { message: 'Totals: 100%' },
          { message: 'App.jsx | 90 | 80 | 85 | 90 | 12' }
        ]
      },
      'frontend'
    );

    expect(entries).toEqual([]);
  });

  test('extractUncoveredEntriesFromCoverageLogs resets and re-enters table parsing', () => {
    const entries = extractUncoveredEntriesFromCoverageLogs(
      {
        logs: [
          { message: 'Uncovered Line #s' },
          { message: 'File | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s' },
          { message: 'Totals: 100%' },
          { message: 'Uncovered Line #s' },
          { message: 'Widget.jsx | 90 | 80 | 85 | 90 | 2' }
        ]
      },
      'frontend'
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ workspace: 'frontend', file: 'src/Widget.jsx', lines: [2] });
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

  test('buildTestFixPlan emits suite-level prompt when no FAIL ids exist', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        { label: 'Frontend tests', kind: 'frontend', job: { status: 'failed', logs: [{ message: 'oops' }] } },
        { label: 'Backend tests', kind: 'backend', job: { status: 'failed', logs: [{ message: '' }] } }
      ]
    });

    expect(plan.prompt).toEqual(expect.any(String));
    expect(plan.prompt.length).toBeGreaterThan(0);
    expect(plan.childPrompts.some((prompt) => prompt.includes('Fix failing tests in Frontend tests'))).toBe(true);
    expect(plan.childPrompts.some((prompt) => prompt.includes('Fix failing tests in Backend tests'))).toBe(true);
  });

  test('buildTestFixPlan groups failing test ids into a single prompt', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            logs: [
              { message: 'FAIL  src/test/Foo.test.jsx > Foo > does something' },
              { message: 'FAIL  src/test/Bar.test.jsx > Bar > does something else' }
            ]
          }
        }
      ]
    });

    expect(plan.childPrompts.length).toBe(1);
    expect(plan.childPrompts[0]).toContain('Fix failing tests in Frontend tests.');
    expect(plan.childPrompts[0]).toContain('Failing tests: src/test/Foo.test.jsx > Foo > does something, src/test/Bar.test.jsx > Bar > does something else');
    expect(plan.childPromptMetadata[plan.childPrompts[0]].acceptanceCriteria).toContain(
      'Failing test passes: src/test/Foo.test.jsx > Foo > does something'
    );
  });

  test('buildTestFixPlan uses label-specific prompt for unknown job kinds', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        { label: 'Weird tests', kind: 'other', job: { status: 'failed', logs: [] } }
      ]
    });

    expect(plan.childPrompts.some((prompt) => prompt.startsWith('Fix failing tests in Weird tests'))).toBe(true);
  });

  test('buildTestFixPlan returns no prompts when no failing jobs exist', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        { label: 'Frontend tests', kind: 'frontend', job: { status: 'succeeded', logs: [] } },
        { label: 'Backend tests', kind: 'backend', job: { status: 'succeeded', logs: [] } }
      ]
    });

    expect(plan.childPrompts).toEqual([]);
  });

  test('buildTestFixPlan skips failing-test prompts when only coverage is mentioned', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            summary: { coverage: { passed: true, changedFiles: { passed: true } } },
            logs: [{ message: 'Coverage gate failed: coverage below 100%.' }]
          }
        }
      ]
    });

    expect(plan.childPrompts).toEqual([]);
  });

  test('buildTestFixPlan uses coverage logs and skips excluded files', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            summary: { coverage: { passed: false, changedFiles: { passed: true }, uncoveredLines: [] } },
            logs: [
              { message: 'Uncovered Line #s' },
              { message: 'File | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s' },
              { message: 'App.jsx | 90 | 80 | 85 | 90 | 12, 14-15' },
              { message: 'vite.config.js | 0 | 0 | 0 | 0 | 1' },
              { message: 'App.jsx | 90 | 80 | 85 | 90 | 15' }
            ]
          }
        }
      ]
    });

    const combined = plan.childPrompts.join(' ');
    expect(combined).toContain('frontend/src/App.jsx');
    expect(combined).toContain('uncovered line 12');
    expect(combined).toContain('uncovered line 14');
    expect(combined).toContain('uncovered line 15');
    expect(combined).not.toContain('vite.config.js');
  });

  test('buildTestFixPlan handles coverage table edge cases in logs', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            summary: { coverage: { passed: false, changedFiles: { passed: true }, uncoveredLines: [] } },
            logs: [
              { message: 'Uncovered Line #s' },
              { message: '----' },
              { message: 'Not a table row' },
              { message: 'Uncovered Line #s' },
              { message: 'File | % Stmts | % Branch | % Funcs | % Lines' },
              { message: 'vite.config.js | 0 | 0 | 0 | 0 | 1' },
              { message: 'Widget.jsx | 90 | 80 | 85 | 90 |' },
              { message: 'frontend\\src\\App.jsx | 90 | 80 | 85 | 90 | 2' },
              { message: 'Another.jsx | 90 | 80 | 85 | 90 | 3' }
            ]
          }
        }
      ]
    });

    const combined = plan.childPrompts.join(' ');
    expect(combined).toContain('frontend/src/App.jsx');
    expect(combined).toContain('frontend/src/Another.jsx');
  });

  test('buildTestFixPlan falls back to coverage logs when uncoveredLines is not an array', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            summary: { coverage: { passed: false, changedFiles: { passed: true }, uncoveredLines: 'nope' } },
            logs: [
              { message: 'Uncovered Line #s' },
              { message: 'File | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s' },
              { message: 'App.jsx | 90 | 80 | 85 | 90 | 12' }
            ]
          }
        }
      ]
    });

    expect(plan.childPrompts.join(' ')).toContain('uncovered line 12 in frontend/src/App.jsx');
  });

  test('buildTestFixPlan summarizes uncovered files without line numbers', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            summary: {
              coverage: {
                passed: false,
                changedFiles: { passed: true },
                uncoveredLines: [
                  { workspace: 'frontend', file: 'src/NoLines.jsx', lines: [] }
                ]
              }
            },
            logs: []
          }
        }
      ]
    });

    expect(plan.childPrompts.join(' ')).toContain('frontend/src/NoLines.jsx');
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

  test('isCoverageGateFailed flags failed coverage summaries', () => {
    expect(hooks.isCoverageGateFailed({ summary: null })).toBe(false);
    expect(hooks.isCoverageGateFailed({ summary: { coverage: { passed: false } } })).toBe(true);
    expect(hooks.isCoverageGateFailed({ summary: { coverage: { passed: true } } })).toBe(false);
    expect(hooks.isCoverageGateFailed({ summary: { coverage: { changedFiles: { passed: false } } } })).toBe(true);
    expect(hooks.isCoverageGateFailed({ summary: { coverage: { totals: { lines: 99 } } } })).toBe(true);
    expect(hooks.isCoverageGateFailed({ summary: { coverage: { totals: { lines: 100, statements: 100, functions: 100, branches: 100 } } } })).toBe(false);
  });

  test('buildCoverageGateMessage appends coverage guidance and line refs', () => {
    const message = buildCoverageGateMessage({
      coverage: {
        passed: false,
        changedFiles: { passed: true },
        uncoveredLines: [
          { workspace: 'frontend', file: 'src/App.jsx', lines: [10, 12] }
        ]
      }
    });

    expect(message).toContain('Coverage gate failed: uncovered lines in frontend/src/App.jsx (10, 12).');
    expect(message).toContain('Add tests to reach 100% coverage.');
  });

  test('buildCoverageGateMessage falls back when coverage summary is missing', () => {
    expect(buildCoverageGateMessage()).toBe('Coverage gate failed. Add tests to reach 100% coverage.');
  });

  test('buildCoverageGateMessage falls back when coverage message is blank', () => {
    const message = buildCoverageGateMessage({
      coverage: { message: '   ' }
    });

    expect(message).toBe('Coverage gate failed. Add tests to reach 100% coverage.');
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

  test('buildJobFailureContext returns null when job is missing', () => {
    const context = hooks.buildJobFailureContext({ label: 'Frontend', kind: 'frontend', job: null });
    expect(context).toBeNull();
  });

  test('buildJobFailureContext handles empty log arrays without truncation', () => {
    const job = { logs: [] };
    const context = hooks.buildJobFailureContext({ label: 'Frontend', kind: 'frontend', job });

    expect(context.logsTruncated).toBe(false);
    expect(context.recentLogs).toEqual([]);
    expect(context.totalLogEntries).toBe(0);
  });

  test('buildJobFailureContext treats missing logs as empty', () => {
    const job = { status: 'failed' };
    const context = hooks.buildJobFailureContext({ label: 'Frontend', kind: 'frontend', job });

    expect(context.logsTruncated).toBe(false);
    expect(context.recentLogs).toEqual([]);
    expect(context.totalLogEntries).toBe(0);
  });

  test('buildJobFailureContext truncates when log count exceeds the window even if messages are blank', () => {
    const logs = Array.from({ length: 205 }).map(() => ({ message: '   ' }));
    const job = { logs };

    const context = hooks.buildJobFailureContext({ label: 'Frontend', kind: 'frontend', job });
    expect(context.logsTruncated).toBe(true);
    expect(context.recentLogs).toEqual(['/* ...logs truncated... */']);
  });

  test('buildJobFailureContext preserves coverage details when present', () => {
    const job = {
      status: 'failed',
      summary: {
        coverage: {
          passed: false,
          uncoveredLines: [{ workspace: 'frontend', file: 'src/App.jsx', lines: [3] }]
        }
      },
      logs: []
    };

    const context = hooks.buildJobFailureContext({ label: 'Frontend', kind: 'frontend', job });
    expect(context.coverage).toMatchObject({ passed: false });
    expect(context.uncoveredLines).toEqual([{ workspace: 'frontend', file: 'src/App.jsx', lines: [3] }]);
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

    expect(context).toEqual(
      expect.objectContaining({
        jobs: expect.any(Array),
        generatedAt: expect.any(String)
      })
    );
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

  test('renderLogLines appends summary lines when they are outside the recent log window', () => {
    const job = {
      logs: [
        { message: 'PASS first' },
        { message: 'Test Suites: 5 passed, 5 total' },
        { message: 'Tests:       12 passed, 12 total' },
        { message: 'Snapshots:   0 total' },
        { message: 'Time:        3.859 s' },
        { message: 'Ran all test suites.' },
        { message: 'File               | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s' },
        { message: 'All files          |   53.62 |    77.77 |      50 |   53.62 |' },
        { message: 'frontend/src       |   78.72 |     87.5 |   66.66 |   78.72 |' },
        { message: 'frontend/App.jsx   |     100 |      100 |     100 |     100 |' },
        { message: 'frontend/main.jsx  |       0 |        0 |       0 |       0 | 1-10' },
        { message: '-------------------|---------|----------|---------|---------|-------------------' }
      ]
    };

    const view = render(<div>{hooks.renderLogLines(job)}</div>);

    expect(view.container.textContent).toContain('Summary:');
    expect(view.container.textContent).toContain('Test Suites: 5 passed, 5 total');
    expect(view.container.textContent).toContain('Tests:       12 passed, 12 total');
  });

  test('renderLogLines moves summary lines below recent logs', () => {
    const job = {
      logs: [
        { message: 'Setup complete' },
        { message: 'Test Files  2 passed (2)' },
        { message: 'Tests       8 passed (8)' },
        { message: 'Duration    2.22s' },
        { message: 'File               | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s' },
        { message: 'All files          |   99.00 |   100.0 |   100.0 |   99.00 |' }
      ]
    };

    const view = render(<div>{hooks.renderLogLines(job)}</div>);

    expect(view.container.textContent).toContain('Summary:');
    expect(view.container.textContent).toContain('Test Files  2 passed (2)');
  });

  test('renderLogLines uses stored summary lines when logs omit them', () => {
    const job = {
      logs: [
        { message: 'File               | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s' },
        { message: 'All files          |   53.62 |    77.77 |      50 |   53.62 |' }
      ],
      summary: {
        testSummaryLines: [
          'Test Suites: 5 passed, 5 total',
          'Tests:       12 passed, 12 total',
          'Time:        3.859 s'
        ]
      }
    };

    const view = render(<div>{hooks.renderLogLines(job)}</div>);

    expect(view.container.textContent).toContain('Summary:');
    expect(view.container.textContent).toContain('Test Suites: 5 passed, 5 total');
    expect(view.container.textContent).toContain('Tests:       12 passed, 12 total');
  });

  test('renderLogLines appends a coverage gate failure line in red when coverage fails', () => {
    const job = {
      logs: [{ message: 'All files          |   53.62 |    77.77 |      50 |   53.62 |' }],
      summary: {
        coverage: {
          passed: false,
          message: 'Coverage gate failed: coverage below 100%.'
        }
      }
    };

    const view = render(<div>{hooks.renderLogLines(job)}</div>);

    expect(view.container.textContent).toContain('Coverage gate failed: coverage below 100%.');
    expect(view.container.querySelector('.log-highlight.fail')).toBeTruthy();
  });

  test('renderLogLines falls back to default coverage message when summary text is missing', () => {
    const job = {
      logs: [{ message: 'All files | 0 | 0 | 0 | 0 | 1' }],
      summary: {
        coverage: {
          passed: false,
          message: null
        }
      }
    };

    const view = render(<div>{hooks.renderLogLines(job)}</div>);

    expect(view.container.textContent).toContain('Coverage gate failed: coverage below 100%.');
  });

  test('buildTestFailureContext returns null for missing or empty inputs', () => {
    expect(hooks.buildTestFailureContext()).toBeNull();
    expect(hooks.buildTestFailureContext([])).toBeNull();
    expect(hooks.buildTestFailureContext([{ label: 'Skip', job: null }])).toBeNull();
  });

  test('buildTestFailureContext returns null when all entries are invalid', () => {
    const context = hooks.buildTestFailureContext([
      { label: 'Skip', job: null },
      { label: 'Also skip', job: undefined }
    ]);

    expect(context).toBeNull();
  });

  test('buildTestFailureContext returns null for non-array inputs', () => {
    expect(hooks.buildTestFailureContext({ nope: true })).toBeNull();
  });

  test('buildTestFixPlan adds coverage guidance when coverage gate fails', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'succeeded',
            summary: {
              coverage: {
                passed: false,
                uncoveredLines: [
                  { workspace: 'frontend', file: 'src/App.jsx', lines: [1] }
                ]
              }
            }
          }
        }
      ]
    });

    expect(plan.childPrompts.some((prompt) => prompt.includes('Add tests to cover uncovered line 1 in frontend/src/App.jsx'))).toBe(true);
  });

  test('buildTestFixPlan uses a generic label when coverage guidance has no label', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: null,
          kind: 'frontend',
          job: {
            status: 'succeeded',
            summary: {
              coverage: {
                passed: false,
                uncoveredLines: [
                  { workspace: 'frontend', file: 'src/App.jsx', lines: [4] }
                ]
              }
            }
          }
        }
      ]
    });

    expect(plan.childPrompts.some((prompt) => prompt.includes('Add tests to cover uncovered line 4 in frontend/src/App.jsx'))).toBe(true);
  });

  test('buildTestFixPlan skips failing-test prompt when only coverage gate failed', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            summary: {
              coverage: {
                passed: false,
                uncoveredLines: [
                  { workspace: 'frontend', file: 'src/App.jsx', lines: [1] }
                ]
              }
            },
            logs: [{ message: 'Coverage gate failed: coverage below 100%.' }]
          }
        }
      ]
    });

    expect(plan.childPrompts.some((prompt) => prompt.includes('Fix failing tests in Frontend tests'))).toBe(false);
    expect(plan.childPrompts.some((prompt) => prompt.includes('Add tests to cover uncovered line 1 in frontend/src/App.jsx'))).toBe(true);
  });

  test('buildTestFixPlan limits failure report collection to the first failing test', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            logs: [
              {
                message: [
                  'FAIL  src/A.test.js > A > works',
                  'AssertionError: nope',
                  'extra detail',
                  '====',
                  'after separator',
                  'FAIL  src/B.test.js > B > fails'
                ].join('\n')
              }
            ]
          }
        }
      ]
    });

    const prompt = plan.childPrompts[0];
    const metadata = plan.childPromptMetadata[prompt];

    expect(prompt).toContain('src/A.test.js > A > works');
    expect(metadata.failureReport).toContain('src/A.test.js > A > works');
    expect(metadata.failureReport).not.toContain('src/B.test.js > B > fails');
  });

  test('buildTestFixPlan includes failure output when no FAIL ids are present', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            logs: [{ message: 'AssertionError: nope' }]
          }
        }
      ]
    });

    const prompt = plan.childPrompts[0];
    expect(prompt).toContain('Fix failing tests in Frontend tests.');
    expect(prompt).toContain('Failure output:');
    expect(prompt).toContain('AssertionError: nope');
  });

  test('buildTestFixPlan treats test summary failures as non-coverage failures', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            logs: [{ message: 'Test Suites: 1 failed, 1 total' }]
          }
        }
      ]
    });

    expect(plan.childPrompts[0]).toContain('Fix failing tests in Frontend tests.');
  });

  test('buildTestFixPlan stops failure report collection when the char budget is exhausted', () => {
    const fillToLength = (prefix, length) => `${prefix}${'X'.repeat(Math.max(0, length - prefix.length))}`;
    const failLine = fillToLength('FAIL  src/A.test.js > A > works ', 999);
    const detailLine = fillToLength('detail ', 999);
    const extraLine = fillToLength('extra ', 999);
    const overflowLine = 'should not appear';

    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            logs: [{ message: [failLine, detailLine, detailLine, extraLine, overflowLine].join('\n') }]
          }
        }
      ]
    });

    const prompt = plan.childPrompts[0];
    const metadata = plan.childPromptMetadata[prompt];

    expect(metadata.failureReport).toContain('FAIL  src/A.test.js > A > works');
    expect(metadata.failureReport).toContain('detail ');
    expect(metadata.failureReport).toContain('extra ');
    expect(metadata.failureReport).not.toContain('should not appear');
  });

  test('buildTestFixPlan emits a suite-level prompt when logs are empty', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        { label: 'Frontend tests', kind: 'frontend', job: { status: 'failed', logs: [] } }
      ]
    });

    expect(plan.childPrompts).toEqual(['Fix failing tests in Frontend tests.']);
  });

  test('buildTestFixPlan uses a header-only prompt when no failure report exists', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Backend tests',
          kind: 'backend',
          job: { status: 'failed', logs: [] }
        }
      ]
    });

    expect(plan.childPrompts[0]).toBe('Fix failing tests in Backend tests.');
  });

  test('buildTestFixPlan uses header-only prompt when coverage summary passes', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            summary: { coverage: { passed: true, changedFiles: { passed: true } } },
            logs: []
          }
        }
      ]
    });

    expect(plan.childPrompts[0]).toBe('Fix failing tests in Frontend tests.');
  });

  test('buildTestFixPlan uses default label text when label is blank', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: '   ',
          kind: 'frontend',
          job: { status: 'failed', logs: [] }
        }
      ]
    });

    expect(plan.childPrompts[0]).toBe('Fix failing tests in test suite.');
  });

  test('buildTestFixPlan returns header-only prompts when no ids or failure output exist', () => {
    const plan = helpersModule.buildTestFixPlan({
      jobs: [
        { label: 'API tests', kind: 'backend', job: { status: 'failed', logs: [] } }
      ]
    });

    expect(plan.childPrompts).toEqual(['Fix failing tests in API tests.']);
  });

  test('buildTestFixPlan treats FAIL logs as non-coverage failures', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            summary: {
              coverage: {
                passed: true,
                changedFiles: { passed: true }
              }
            },
            logs: [{ message: 'FAIL  src/A.test.js > A > works' }]
          }
        }
      ]
    });

    expect(plan.childPrompts[0]).toContain('Fix failing tests in Frontend tests.');
  });

  test('buildTestFixPlan falls back to overall failure report when per-test output is empty', () => {
    const hugeFail = `FAIL  src/A.test.js > A > works ${'X'.repeat(5000)}`;

    const plan = helpersModule.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            logs: [
              { message: hugeFail },
              { message: '====' },
              { message: 'TypeError: boom' }
            ]
          }
        }
      ]
    });

    const prompt = plan.childPrompts[0];
    expect(prompt).toContain('Failure output:');
    expect(prompt).toContain('TypeError: boom');
  });

  test('buildTestFixPlan includes failure output for per-test logs', () => {
    const plan = helpersModule.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            logs: [
              {
                message: [
                  'FAIL  src/A.test.js > A > works',
                  'AssertionError: nope'
                ].join('\n')
              }
            ]
          }
        }
      ]
    });

    const prompt = plan.childPrompts[0];
    expect(prompt).toContain('Failure output:');
    expect(prompt).toContain('AssertionError: nope');
  });

  test('buildTestFixPlan uses per-test failure extraction when ids exist', () => {
    const plan = helpersModule.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            logs: [
              { message: 'FAIL  src/A.test.js > A > works' },
              { message: 'AssertionError: nope' }
            ]
          }
        }
      ]
    });

    const prompt = plan.childPrompts[0];
    expect(prompt).toContain('Failing tests: src/A.test.js > A > works');
  });

  test('buildTestFixPlan includes ids and failure output together', () => {
    const plan = helpersModule.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            logs: [
              {
                message: [
                  'FAIL  src/A.test.js > A > works',
                  'TypeError: boom'
                ].join('\n')
              }
            ]
          }
        }
      ]
    });

    const prompt = plan.childPrompts[0];
    expect(prompt).toContain('Failing tests: src/A.test.js > A > works');
    expect(prompt).toContain('Failure output:');
    expect(prompt).toContain('TypeError: boom');
  });

  test('buildFailingTestsPrompt filters falsy ids and includes failure output', () => {
    const prompt = helpersModule.buildFailingTestsPrompt({
      label: 'Frontend tests',
      failingIds: ['src/A.test.js > A > works', '', null],
      failureReport: 'TypeError: boom'
    });

    expect(prompt).toContain('Failing tests: src/A.test.js > A > works');
    expect(prompt).not.toContain(', ,');
    expect(prompt).toContain('Failure output:');
    expect(prompt).toContain('TypeError: boom');
  });

  test('buildFailingTestsPrompt returns header when no ids or failure output exist', () => {
    const prompt = helpersModule.buildFailingTestsPrompt({
      label: 'Frontend tests',
      failingIds: [],
      failureReport: null
    });

    expect(prompt).toBe('Fix failing tests in Frontend tests.');
  });

  test('buildCoverageMetadata includes coverageTarget and uncoveredLines when provided', () => {
    const entry = { workspace: 'frontend', file: 'src/App.jsx', lines: [1] };
    const metadata = helpersModule.buildCoverageMetadata({
      label: 'Frontend tests',
      kind: 'frontend',
      uncoveredEntry: entry
    });

    expect(metadata.coverageTarget).toEqual({ label: 'Frontend tests', kind: 'frontend' });
    expect(metadata.uncoveredLines).toEqual([entry]);
  });

  test('formatCoveragePath joins workspace and file when needed', () => {
    const path = helpersModule.formatCoveragePath({ workspace: 'frontend', file: 'src/App.jsx' }, 'frontend');

    expect(path).toBe('frontend/src/App.jsx');
  });

  test('formatCoveragePath returns workspace when file is empty', () => {
    const path = helpersModule.formatCoveragePath({ workspace: 'frontend', file: '' }, 'frontend');

    expect(path).toBe('frontend');
  });

  test('formatCoveragePath returns file when workspace is not a string', () => {
    const path = helpersModule.formatCoveragePath({ workspace: 123, file: 'src/OnlyFile.jsx' }, 'frontend');

    expect(path).toBe('src/OnlyFile.jsx');
  });

  test('formatCoveragePath treats non-string file values as empty', () => {
    const path = helpersModule.formatCoveragePath({ workspace: 'frontend', file: 123 }, 'frontend');

    expect(path).toBe('frontend');
  });

  test('buildTestFixPlan lists multiple failing test ids in the prompt', () => {
    const plan = helpersModule.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            logs: [
              {
                message: [
                  'FAIL  src/A.test.js > A > works',
                  'FAIL  src/B.test.js > B > fails'
                ].join('\n')
              }
            ]
          }
        }
      ]
    });

    const prompt = plan.childPrompts[0];
    expect(prompt).toContain('Failing tests: src/A.test.js > A > works, src/B.test.js > B > fails');
  });

  test('buildTestFixPlan suppresses prompts for coverage-only logs without coverage failures', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            summary: {
              coverage: {
                passed: true,
                changedFiles: { passed: true }
              }
            },
            logs: [{ message: 'Coverage gate failed: coverage below 100%.' }]
          }
        }
      ]
    });

    expect(plan.childPrompts).toEqual([]);
  });

  test('buildTestFixPlan includes failure output when no failing test ids exist', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            logs: [{ message: 'TypeError: boom' }]
          }
        }
      ]
    });

    const prompt = plan.childPrompts[0];
    expect(prompt).toContain('Failure output:');
    expect(prompt).toContain('TypeError: boom');
  });


  test('buildTestFixPlan omits failure output when failure report is empty', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            logs: [{ message: '   ' }]
          }
        }
      ]
    });

    const prompt = plan.childPrompts[0];
    expect(prompt).toBe('Fix failing tests in Frontend tests.');
  });

  test('buildTestFixPlan ignores blank log output when building failure reports', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            logs: [{ message: '   ' }]
          }
        }
      ]
    });

    expect(plan.childPrompts).toEqual(['Fix failing tests in Frontend tests.']);
  });

  test('buildTestFixPlan treats test summary failures as non-coverage-only', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            logs: [{ message: 'Tests: 1 failed, 2 passed' }]
          }
        }
      ]
    });

    expect(plan.childPrompts.some((prompt) => prompt.startsWith('Fix failing tests in Frontend tests.'))).toBe(true);
  });

  test('buildTestFixPlan stops failure report when a new FAIL line appears', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            logs: [
              {
                message: [
                  'FAIL  src/A.test.js > A > works',
                  'AssertionError: nope',
                  'detail line',
                  'FAIL  src/B.test.js > B > fails',
                  'after second fail'
                ].join('\n')
              }
            ]
          }
        }
      ]
    });

    const prompt = plan.childPrompts[0];
    const metadata = plan.childPromptMetadata[prompt];

    expect(metadata.failureReport).toContain('AssertionError: nope');
    expect(metadata.failureReport).not.toContain('src/B.test.js > B > fails');
    expect(metadata.failureReport).not.toContain('after second fail');
  });

  test('buildTestFixPlan stops failure report when separators are encountered', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            logs: [
              {
                message: [
                  'FAIL  src/A.test.js > A > works',
                  'AssertionError: nope',
                  '====',
                  'after separator'
                ].join('\n')
              }
            ]
          }
        }
      ]
    });

    const prompt = plan.childPrompts[0];
    const metadata = plan.childPromptMetadata[prompt];

    expect(metadata.failureReport).toContain('AssertionError: nope');
    expect(metadata.failureReport).not.toContain('after separator');
  });

  test('buildTestFixPlan parses reversed coverage ranges and skips invalid segments', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            summary: { coverage: { passed: false, changedFiles: { passed: true }, uncoveredLines: [] } },
            logs: [
              { message: 'Uncovered Line #s' },
              { message: 'File | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s' },
              { message: 'App.jsx | 90 | 80 | 85 | 90 | 5-3, nope' }
            ]
          }
        }
      ]
    });

    const combined = plan.childPrompts.join(' ');
    expect(combined).toContain('uncovered line 3');
    expect(combined).toContain('uncovered line 5');
  });

  test('buildTestFixPlan treats non-array uncovered line lists as empty', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'succeeded',
            summary: {
              coverage: {
                passed: false,
                uncoveredLines: [{ workspace: 'frontend', file: 'src/Zero.jsx', lines: 'nope' }]
              }
            }
          }
        }
      ]
    });

    expect(plan.childPrompts.join(' ')).toContain('uncovered lines in frontend/src/Zero.jsx');
  });

  test('buildTestFixPlan keeps truncated coverage files that are not config files', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Backend tests',
          kind: 'backend',
          job: {
            status: 'succeeded',
            summary: {
              coverage: {
                passed: false,
                uncoveredLines: [{ workspace: 'backend', file: '...core.js', lines: [7] }]
              }
            }
          }
        }
      ]
    });

    expect(plan.childPrompts.join(' ')).toContain('uncovered line 7 in backend/...core.js');
  });

  test('buildTestFixPlan preserves truncated backend config names', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Backend tests',
          kind: 'backend',
          job: {
            status: 'failed',
            summary: {
              coverage: {
                passed: false,
                changedFiles: { passed: true },
                uncoveredLines: [{ workspace: 'backend', file: '...ght.config.js', lines: [4] }]
              }
            },
            logs: []
          }
        }
      ]
    });

    expect(plan.childPrompts.join(' ')).toContain('backend/...ght.config.js');
  });

  test('buildTestFixPlan prefers coverage logs when summary paths are truncated', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            summary: {
              coverage: {
                passed: false,
                changedFiles: { passed: true },
                uncoveredLines: [{ workspace: 'frontend', file: '...pped.js', lines: [1] }]
              }
            },
            logs: [
              { message: 'Uncovered Line #s' },
              { message: 'App.jsx | 90 | 80 | 85 | 90 | 2' }
            ]
          }
        }
      ]
    });

    const combined = plan.childPrompts.join(' ');
    expect(combined).toContain('frontend/src/App.jsx');
    expect(combined).toContain('...pped.js');
  });

  test('buildTestFixPlan includes label-based acceptance criteria when no test id is available', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            logs: []
          }
        }
      ]
    });

    const prompt = plan.childPrompts[0];
    const metadata = plan.childPromptMetadata[prompt];

    expect(metadata.acceptanceCriteria).toContain('Frontend tests pass without failures');
  });

  test('buildTestFixPlan includes coverage targets for label and kind', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'succeeded',
            summary: {
              coverage: {
                passed: false,
                uncoveredLines: [{ workspace: 'frontend', file: 'src/App.jsx', lines: [1] }]
              }
            }
          }
        }
      ]
    });

    const prompt = plan.childPrompts[0];
    const metadata = plan.childPromptMetadata[prompt];
    expect(metadata.coverageTarget).toEqual({ label: 'Frontend tests', kind: 'frontend' });
    expect(metadata.acceptanceCriteria).toEqual(['Coverage gate passes for this suite']);
    expect(metadata.suppressClarifyingQuestions).toBe(true);
  });

  test('buildTestFixPlan includes coverage defaults when label is blank but kind is set', () => {
    const plan = helpersModule.buildTestFixPlan({
      jobs: [
        {
          label: '   ',
          kind: 'frontend',
          job: {
            status: 'failed',
            summary: {
              coverage: {
                passed: false,
                changedFiles: { passed: true },
                uncoveredLines: [{ workspace: 'frontend', file: 'src/Defaults.jsx', lines: [1] }]
              }
            },
            logs: []
          }
        }
      ]
    });

    const prompt = plan.childPrompts[0];
    const metadata = plan.childPromptMetadata[prompt];
    expect(metadata.coverageTarget).toEqual({ label: 'test suite', kind: 'frontend' });
    expect(metadata.acceptanceCriteria).toEqual(['Coverage gate passes for this suite']);
    expect(metadata.suppressClarifyingQuestions).toBe(true);
  });

  test('buildTestFixPlan includes coverage metadata when label and kind are both empty', () => {
    const plan = helpersModule.buildTestFixPlan({
      jobs: [
        {
          label: '',
          kind: '',
          job: {
            status: 'failed',
            summary: {
              coverage: {
                passed: false,
                changedFiles: { passed: true },
                uncoveredLines: [{ workspace: 'frontend', file: 'src/EmptyMeta.jsx', lines: [1] }]
              }
            },
            logs: []
          }
        }
      ]
    });

    const prompt = plan.childPrompts[0];
    const metadata = plan.childPromptMetadata[prompt];
    expect(metadata.acceptanceCriteria).toEqual(['Coverage gate passes for this suite']);
    expect(metadata.suppressClarifyingQuestions).toBe(true);
  });

  test('buildTestFixPlan supports coverage metadata when kind is null', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: null,
          job: {
            status: 'failed',
            summary: {
              coverage: {
                passed: false,
                changedFiles: { passed: true },
                uncoveredLines: [{ workspace: 'frontend', file: 'src/Kindless.jsx', lines: [2] }]
              }
            },
            logs: []
          }
        }
      ]
    });

    const prompt = plan.childPrompts[0];
    const metadata = plan.childPromptMetadata[prompt];
    expect(metadata.coverageTarget).toEqual({ label: 'Frontend tests', kind: null });
    expect(metadata.uncoveredLines).toEqual([
      { workspace: 'frontend', file: 'src/Kindless.jsx', lines: [2] }
    ]);
  });

  test('buildTestFixPlan includes coverage targets when only kind is set', () => {
    const plan = helpersModule.buildTestFixPlan({
      jobs: [
        {
          label: '',
          kind: 'frontend',
          job: {
            status: 'failed',
            summary: {
              coverage: {
                passed: false,
                changedFiles: { passed: true },
                uncoveredLines: [{ workspace: 'frontend', file: 'src/OnlyKind.jsx', lines: [1] }]
              }
            },
            logs: []
          }
        }
      ]
    });

    const prompt = plan.childPrompts[0];
    const metadata = plan.childPromptMetadata[prompt];
    expect(metadata.coverageTarget).toEqual({ label: 'test suite', kind: 'frontend' });
  });

  test('buildTestFixPlan includes coverage metadata even without labels', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: null,
          kind: null,
          job: {
            status: 'failed',
            summary: {
              coverage: {
                passed: false,
                changedFiles: { passed: true },
                uncoveredLines: [{ workspace: 'frontend', file: 'src/App.jsx', lines: [1] }]
              }
            },
            logs: []
          }
        }
      ]
    });

    const prompt = plan.childPrompts[0];
    const metadata = plan.childPromptMetadata[prompt];
    expect(metadata.acceptanceCriteria).toEqual(['Coverage gate passes for this suite']);
    expect(metadata.suppressClarifyingQuestions).toBe(true);
  });

  test('buildTestFixPlan attaches coverage targets when label and kind are set', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            summary: {
              coverage: {
                passed: false,
                changedFiles: { passed: true },
                uncoveredLines: [{ workspace: 'frontend', file: 'src/Target.jsx', lines: [4] }]
              }
            },
            logs: []
          }
        }
      ]
    });

    const prompt = plan.childPrompts[0];
    const metadata = plan.childPromptMetadata[prompt];
    expect(metadata.coverageTarget).toEqual({ label: 'Frontend tests', kind: 'frontend' });
    expect(metadata.uncoveredLines).toEqual([
      { workspace: 'frontend', file: 'src/Target.jsx', lines: [4] }
    ]);
  });

  test('buildTestFixPlan omits coverage targets when label and kind are missing', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: null,
          kind: null,
          job: {
            status: 'failed',
            summary: {
              coverage: {
                passed: false,
                changedFiles: { passed: true },
                uncoveredLines: [{ workspace: 'frontend', file: 'src/App.jsx', lines: [1] }]
              }
            },
            logs: []
          }
        }
      ]
    });

    const prompt = plan.childPrompts[0];
    const metadata = plan.childPromptMetadata[prompt];
    expect(metadata.coverageTarget).toEqual({ label: 'test suite', kind: null });
  });

  test('buildTestFixPlan formats coverage paths for missing workspace/file and truncated entries', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'succeeded',
            summary: {
              coverage: {
                passed: false,
                changedFiles: { passed: true },
                uncoveredLines: [
                  { workspace: '', file: 'src/Alpha.jsx', lines: [1] },
                  { workspace: 'frontend', file: '', lines: [2] },
                  { workspace: 'frontend', file: 'frontend/src/Beta.jsx', lines: [3] },
                  { workspace: 'frontend', file: '...ght.config.js', lines: [4] },
                  { workspace: 'frontend', file: 'src/NoLines.jsx', lines: [] }
                ]
              }
            },
            logs: []
          }
        }
      ]
    });

    const combined = plan.childPrompts.join(' ');
    expect(combined).toContain('uncovered line 1 in src/Alpha.jsx');
    expect(combined).toContain('uncovered line 2 in frontend');
    expect(combined).toContain('uncovered line 3 in frontend/src/Beta.jsx');
    expect(combined).not.toContain('frontend/vite.config.js');
    expect(combined).toContain('uncovered lines in frontend/src/NoLines.jsx');
  });

  test('buildTestFixPlan falls back to file-only paths when workspace is not a string', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'succeeded',
            summary: {
              coverage: {
                passed: false,
                changedFiles: { passed: true },
                uncoveredLines: [{ workspace: 123, file: 'src/Weird.jsx', lines: [5] }]
              }
            }
          }
        }
      ]
    });

    expect(plan.childPrompts.join(' ')).toContain('uncovered line 5 in src/Weird.jsx');
  });

  test('buildTestFixPlan uses file-only paths when workspace is empty', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            summary: {
              coverage: {
                passed: false,
                changedFiles: { passed: true },
                uncoveredLines: [{ workspace: '', file: 'src/EmptyWorkspace.jsx', lines: [3] }]
              }
            },
            logs: []
          }
        }
      ]
    });

    expect(plan.childPrompts.join(' ')).toContain('uncovered line 3 in src/EmptyWorkspace.jsx');
  });

  test('buildTestFixPlan handles empty workspace paths from helpers module', () => {
    const plan = helpersModule.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            summary: {
              coverage: {
                passed: false,
                changedFiles: { passed: true },
                uncoveredLines: [{ workspace: '', file: 'src/Direct.jsx', lines: [4] }]
              }
            },
            logs: []
          }
        }
      ]
    });

    expect(plan.childPrompts.join(' ')).toContain('uncovered line 4 in src/Direct.jsx');
  });

  test('buildTestFixPlan uses file-only paths when workspace is undefined', () => {
    const plan = helpersModule.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            summary: {
              coverage: {
                passed: false,
                changedFiles: { passed: true },
                uncoveredLines: [{ workspace: undefined, file: 'src/Undefined.jsx', lines: [5] }]
              }
            },
            logs: []
          }
        }
      ]
    });

    expect(plan.childPrompts.join(' ')).toContain('uncovered line 5 in src/Undefined.jsx');
  });

  test('buildTestFixPlan falls back to workspace-only paths when file is not a string', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'succeeded',
            summary: {
              coverage: {
                passed: false,
                changedFiles: { passed: true },
                uncoveredLines: [{ workspace: 'frontend', file: 123, lines: [9] }]
              }
            }
          }
        }
      ]
    });

    expect(plan.childPrompts.join(' ')).toContain('uncovered line 9 in frontend');
  });

  test('buildTestFixPlan formats coverage paths when file is empty', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            summary: {
              coverage: {
                passed: false,
                changedFiles: { passed: true },
                uncoveredLines: [{ workspace: 'frontend', file: '', lines: [11] }]
              }
            },
            logs: []
          }
        }
      ]
    });

    expect(plan.childPrompts.join(' ')).toContain('uncovered line 11 in frontend');
  });

  test('buildTestFixPlan uses workspace-only paths when file is empty and workspace is set', () => {
    const plan = helpersModule.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            summary: {
              coverage: {
                passed: false,
                changedFiles: { passed: true },
                uncoveredLines: [{ workspace: 'frontend', file: '', lines: [12] }]
              }
            },
            logs: []
          }
        }
      ]
    });

    expect(plan.childPrompts.join(' ')).toContain('uncovered line 12 in frontend');
  });

  test('buildTestFixPlan skips empty uncovered summaries when overridden', () => {
    setFormatUncoveredLineSummaryOverride(() => '');

    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'succeeded',
            summary: {
              coverage: {
                passed: false,
                uncoveredLines: [{ workspace: 'frontend', file: 'src/App.jsx', lines: [] }]
              }
            }
          }
        }
      ]
    });

    expect(plan.childPrompts).toEqual([]);
  });

  test('buildTestFixPlan normalizes truncated config paths for frontend logs', () => {
    const plan = hooks.buildTestFixPlan({
      jobs: [
        {
          label: 'Frontend tests',
          kind: 'frontend',
          job: {
            status: 'failed',
            summary: { coverage: { passed: false, changedFiles: { passed: true }, uncoveredLines: [] } },
            logs: [
              { message: 'Uncovered Line #s' },
              { message: 'File | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s' },
              { message: '...ght.config.js | 90 | 90 | 90 | 90 | 1' }
            ]
          }
        }
      ]
    });

    expect(plan.childPrompts.join(' ')).not.toContain('...ght.config.js');
  });

  test('renderLogLines skips summary extraction when no summary markers exist', () => {
    const job = {
      logs: [{ message: 'PASS 1 tests passed' }, { message: 'Some other line' }]
    };

    const view = render(<div>{hooks.renderLogLines(job)}</div>);
    expect(view.container.textContent).not.toContain('Summary:');
  });

  test('renderLogLines filters summary lines from recent output', () => {
    const job = {
      logs: [
        { message: 'PASS 2 tests passed' },
        { message: 'Test Suites: 2 passed, 2 total' },
        { message: 'Tests:       3 passed, 3 total' },
        { message: 'Duration    1.23s' }
      ]
    };

    const view = render(<div>{hooks.renderLogLines(job)}</div>);
    expect(view.container.textContent).toContain('Summary:');
    expect(view.container.textContent).toContain('Test Suites: 2 passed, 2 total');
  });

  test('extractTestSummaryLines returns empty list for invalid logs', () => {
    expect(extractTestSummaryLines(null)).toEqual([]);
    expect(extractTestSummaryLines([])).toEqual([]);
  });
});
