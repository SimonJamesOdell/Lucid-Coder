import { describe, expect, it } from 'vitest';

import { buildAutopilotJobLogLines } from '../components/chatPanel/jobLogs';

describe('chatPanel jobLogs', () => {
  it('returns an empty list when jobs is not an array', () => {
    expect(buildAutopilotJobLogLines('nope')).toEqual([]);
    expect(buildAutopilotJobLogLines(null)).toEqual([]);
  });

  it('returns an empty list when jobs array is empty', () => {
    expect(buildAutopilotJobLogLines([])).toEqual([]);
  });

  it('skips jobs that are not test-runs or have invalid logs', () => {
    const lines = buildAutopilotJobLogLines([
      null,
      { type: 'other', logs: [{ message: 'ignored' }] },
      { type: 'test-run', logs: 'not-an-array' },
      { type: 'test-run', logs: [] }
    ]);

    expect(lines).toEqual([]);
  });

  it('builds headers and log lines with sensible fallbacks', () => {
    const lines = buildAutopilotJobLogLines([
      {
        type: 'test-run',
        logs: [{}, { message: 'hi', stream: 'stderr' }]
      }
    ]);

    expect(lines[0]).toEqual({
      key: 'job-0-header',
      text: 'Test Run • pending',
      variant: 'header'
    });

    expect(lines[1]).toEqual({
      key: 'job-0-log-0',
      text: '',
      stream: 'stdout'
    });

    expect(lines[2]).toEqual({
      key: 'job-0-log-1',
      text: 'hi',
      stream: 'stderr'
    });
  });

  it('enforces per-job and total log line caps', () => {
    const longLogs = Array.from({ length: 100 }, (_, idx) => ({ message: `line-${idx}` }));
    const single = buildAutopilotJobLogLines([
      { type: 'test-run', displayName: 'One', status: 'done', logs: longLogs }
    ]);

    expect(single).toHaveLength(1 + 60);
    expect(single[1].text).toBe('line-40');
    expect(single.at(-1)?.text).toBe('line-99');

    const jobs = Array.from({ length: 5 }, (_, jobIndex) => ({
      type: 'test-run',
      displayName: `Job ${jobIndex}`,
      status: 'running',
      logs: Array.from({ length: 60 }, (_, idx) => ({ message: `job-${jobIndex}-${idx}` }))
    }));

    const capped = buildAutopilotJobLogLines(jobs);
    const headerCount = capped.filter((line) => line.variant === 'header').length;
    const logCount = capped.filter((line) => line.variant !== 'header').length;

    expect(headerCount).toBe(5);
    expect(logCount).toBe(200);
    expect(capped).toHaveLength(205);
  });
});
