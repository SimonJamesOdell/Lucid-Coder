import { describe, expect, test } from 'vitest';

import {
  extractFailingTestsFromWorkspaceRuns,
  splitLogsByStream,
  summarizeTestRunForPrompt,
  summarizeWorkspaceRunsForPayload
} from '../services/agentAutopilot/runs.js';

describe('agentAutopilot runs helpers', () => {
  test('splitLogsByStream buckets stdout/stderr/other logs', () => {
    const runs = [
      {
        workspace: 'ws-1',
        logs: [
          { stream: 'stderr', message: 'bad' },
          { stream: 'stdout', message: 'ok' },
          { stream: 'other', message: 'misc' },
          'stderr: boom',
          'stdout: hi',
          'plain line',
          42,
          null
        ]
      }
    ];

    const [result] = splitLogsByStream(runs);

    expect(result.workspace).toBe('ws-1');
    expect(result.stderr).toEqual(['bad', 'boom']);
    expect(result.stdout).toEqual(['ok', 'hi']);
    expect(result.other).toEqual(['misc', 'plain line']);
  });

  test('splitLogsByStream handles unknown streams and empty entries', () => {
    const [result] = splitLogsByStream([
      {
        logs: [
          { stream: 'OTHER', message: 123 },
          { message: 'hello' },
          '',
          'STDERR: nope'
        ]
      }
    ]);

    expect(result.workspace).toBeNull();
    expect(result.stderr).toEqual(['nope']);
    expect(result.stdout).toEqual([]);
    expect(result.other).toEqual(['', 'hello']);
  });

  test('splitLogsByStream returns empty array for invalid input', () => {
    expect(splitLogsByStream(null)).toEqual([]);
  });

  test('summarizeWorkspaceRunsForPayload trims logs and preserves streams', () => {
    const logs = Array.from({ length: 25 }, (_, index) => `line-${index + 1}`);
    const payload = summarizeWorkspaceRunsForPayload([
      {
        workspace: 'ws-2',
        kind: 'unit',
        status: 'passed',
        exitCode: 0,
        durationMs: 1234,
        coverage: { totals: { lines: 90 } },
        logs
      },
      {
        workspace: 'ws-3',
        kind: 'unit',
        status: 'failed',
        exitCode: NaN,
        durationMs: 'n/a',
        logs: ['stdout: ok', 'stderr: nope']
      }
    ]);

    expect(payload).toHaveLength(2);
    expect(payload[0].logs).toHaveLength(20);
    expect(payload[0].logs[0]).toBe('line-6');
    expect(payload[0].exitCode).toBe(0);
    expect(payload[0].durationMs).toBe(1234);
    expect(payload[0].streams.stdout).toEqual([]);
    expect(payload[0].streams.other).toEqual(logs);

    expect(payload[1].exitCode).toBeNull();
    expect(payload[1].durationMs).toBeNull();
    expect(payload[1].streams.stdout).toEqual(['ok']);
    expect(payload[1].streams.stderr).toEqual(['nope']);
  });

  test('summarizeWorkspaceRunsForPayload returns empty array for non-array input', () => {
    expect(summarizeWorkspaceRunsForPayload(null)).toEqual([]);
  });

  test('summarizeWorkspaceRunsForPayload normalizes missing run fields', () => {
    const [result] = summarizeWorkspaceRunsForPayload([null]);

    expect(result).toEqual({
      workspace: null,
      kind: null,
      status: null,
      exitCode: null,
      durationMs: null,
      coverage: null,
      logs: [],
      streams: { workspace: null, stdout: [], stderr: [], other: [] }
    });
  });

  test('summarizeTestRunForPrompt skips invalid coverage line references', () => {
    const result = summarizeTestRunForPrompt({
      status: 'failed',
      summary: {
        total: 1,
        failed: 1,
        coverage: {
          uncoveredLines: [
            null,
            { workspace: 'frontend', file: '', lines: [1] },
            { workspace: 'backend', file: 'server.js', lines: ['nope'] },
            { workspace: 'backend', file: 'server.js', lines: null }
          ]
        }
      },
      workspaceRuns: []
    });

    expect(result).not.toContain('Coverage gaps (line references):');
  });

  test('extractFailingTestsFromWorkspaceRuns reads failed tests and log errors', () => {
    const failures = extractFailingTestsFromWorkspaceRuns([
      {
        workspace: 'ws-4',
        tests: [
          { status: 'failed', name: 'handles errors', message: 'boom' },
          { status: 'passed', name: 'happy path' }
        ]
      },
      {
        workspace: 'ws-5',
        tests: [],
        logs: ['All good', 'Error: something bad happened']
      }
    ]);

    expect(failures).toHaveLength(2);
    expect(failures[0]).toEqual({
      workspace: 'ws-4',
      name: 'handles errors',
      message: 'boom'
    });
    expect(failures[1].workspace).toBe('ws-5');
    expect(failures[1].name).toBe('error');
    expect(failures[1].message).toContain('Error:');
  });

  test('extractFailingTestsFromWorkspaceRuns defaults missing status and message', () => {
    const failures = extractFailingTestsFromWorkspaceRuns([
      {
        workspace: 'ws-missing',
        tests: [{ name: 'should default', status: '', error: 'boom' }, { name: 'no message', status: 'failed' }]
      }
    ]);

    expect(failures).toHaveLength(1);
    expect(failures[0]).toEqual({
      workspace: 'ws-missing',
      name: 'no message',
      message: null
    });
  });

  test('extractFailingTestsFromWorkspaceRuns uses title and error when present', () => {
    const failures = extractFailingTestsFromWorkspaceRuns([
      {
        workspace: 'ws-title',
        tests: [{ status: 'failed', title: 'title name', error: 'stack trace' }]
      }
    ]);

    expect(failures).toEqual([
      {
        workspace: 'ws-title',
        name: 'title name',
        message: 'stack trace'
      }
    ]);
  });

  test('extractFailingTestsFromWorkspaceRuns accepts status "fail"', () => {
    const failures = extractFailingTestsFromWorkspaceRuns([
      {
        workspace: 'ws-short',
        tests: [{ status: 'fail', name: 'short status', message: 'oops' }]
      }
    ]);

    expect(failures).toEqual([
      {
        workspace: 'ws-short',
        name: 'short status',
        message: 'oops'
      }
    ]);
  });

  test('extractFailingTestsFromWorkspaceRuns falls back to unnamed test', () => {
    const failures = extractFailingTestsFromWorkspaceRuns([
      {
        workspace: 'ws-unnamed',
        tests: [{ status: 'failed' }]
      }
    ]);

    expect(failures).toEqual([
      {
        workspace: 'ws-unnamed',
        name: 'unnamed test',
        message: null
      }
    ]);
  });

  test('extractFailingTestsFromWorkspaceRuns returns empty when no failures found', () => {
    const failures = extractFailingTestsFromWorkspaceRuns([
      {
        tests: [{ status: 'passed', name: 'ok' }, 5],
        logs: ['All good', 'Still fine']
      }
    ]);

    expect(failures).toEqual([]);
  });

  test('extractFailingTestsFromWorkspaceRuns skips invalid tests and stops after 15', () => {
    const firstRunTests = [
      null,
      ...Array.from({ length: 15 }, (_, index) => ({
        status: 'failed',
        name: `test-${index + 1}`
      }))
    ];

    const failures = extractFailingTestsFromWorkspaceRuns([
      { workspace: 'ws-a', tests: firstRunTests },
      { workspace: 'ws-b', tests: [{ status: 'failed', name: 'should-ignore' }] }
    ]);

    expect(failures).toHaveLength(15);
    expect(new Set(failures.map((failure) => failure.workspace))).toEqual(new Set(['ws-a']));
  });

  test('extractFailingTestsFromWorkspaceRuns skips empty log lines and stops after 15 log failures', () => {
    const errorLogs = Array.from({ length: 16 }, (_, index) => `Error: issue ${index + 1}`);
    const failures = extractFailingTestsFromWorkspaceRuns([
      {
        workspace: 'ws-logs',
        tests: [],
        logs: ['', null, ...errorLogs]
      }
    ]);

    expect(failures).toHaveLength(15);
    expect(failures[0].workspace).toBe('ws-logs');
    expect(failures[0].name).toBe('error');
    expect(failures[14].message).toContain('Error: issue 15');
  });

  test('summarizeTestRunForPrompt builds a readable summary', () => {
    const summary = summarizeTestRunForPrompt({
      status: 'failed',
      summary: {
        total: 5,
        failed: 2,
        coverage: {
          totals: {
            lines: 88,
            statements: 90,
            functions: 80,
            branches: 70
          },
          missing: ['src/alpha.js', 'src/beta.js']
        }
      },
      workspaceRuns: [
        {
          workspace: 'ws-6',
          tests: [{ status: 'fail', title: 'should handle error', error: 'bad' }]
        }
      ]
    });

    expect(summary).toContain('Status: failed');
    expect(summary).toContain('Summary: total=5 | failed=2');
    expect(summary).toContain('coverage(lines=88');
    expect(summary).toContain('branches=70');
    expect(summary).toContain('missing files: src/alpha.js, src/beta.js');
    expect(summary).toContain('Reported failures:');
    expect(summary).toContain('[ws-6] should handle error');
  });

  test('summarizeTestRunForPrompt omits missing files line and failure message when absent', () => {
    const summary = summarizeTestRunForPrompt({
      status: 'failed',
      summary: {
        coverage: {
          totals: { lines: 50, statements: 50, functions: 50, branches: 50 },
          missing: []
        }
      },
      workspaceRuns: [
        {
          workspace: 'ws-plain',
          tests: [{ status: 'failed', name: 'no message' }]
        }
      ]
    });

    expect(summary).toContain('coverage(');
    expect(summary).not.toContain('missing files:');
    expect(summary).toContain('[ws-plain] no message');
    expect(summary).not.toContain('—');
  });

  test('summarizeTestRunForPrompt formats missing coverage totals as n/a', () => {
    const summary = summarizeTestRunForPrompt({
      status: 'passed',
      summary: {
        coverage: {
          totals: {
            lines: undefined,
            statements: undefined,
            functions: undefined,
            branches: undefined
          }
        }
      },
      workspaceRuns: []
    });

    expect(summary).toContain('Status: passed');
    expect(summary).toContain('lines=n/a');
    expect(summary).toContain('statements=n/a');
    expect(summary).toContain('functions=n/a');
    expect(summary).toContain('branches=n/a');
  });

  test('summarizeTestRunForPrompt skips non-numeric totals', () => {
    const summary = summarizeTestRunForPrompt({
      status: 'passed',
      summary: {
        total: '5',
        failed: NaN
      },
      workspaceRuns: []
    });

    expect(summary).toBe('Status: passed');
  });

  test('summarizeTestRunForPrompt returns empty string for invalid run', () => {
    expect(summarizeTestRunForPrompt(null)).toBe('');
  });
});
