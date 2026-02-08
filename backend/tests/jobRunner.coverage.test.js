import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';

class MockChildProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = Math.floor(Math.random() * 10000) + 1000;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }
}

const flushMicrotasks = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const importJobRunnerWithMocks = async ({
  child = new MockChildProcess(),
  createRunResult = { id: 123 },
  updateRunImpl,
  appendRunEventImpl,
  readFileImpl
} = {}) => {
  const runStorePath = fileURLToPath(new URL('../services/runStore.js', import.meta.url));

  const updateRun = vi.fn(updateRunImpl || (() => Promise.resolve({})));
  const appendRunEvent = vi.fn(appendRunEventImpl || (() => Promise.resolve({})));
  const createRun = vi.fn(() => Promise.resolve(createRunResult));
  const readFile = vi.fn(readFileImpl || (() => Promise.reject(new Error('ENOENT'))));

  vi.doMock('child_process', () => ({
    spawn: vi.fn(() => child)
  }));

  vi.doMock(runStorePath, () => ({
    createRun,
    updateRun,
    appendRunEvent
  }));

  vi.doMock('fs/promises', () => ({
    __esModule: true,
    readFile,
    default: { readFile }
  }));

  const jobRunner = await import('../services/jobRunner.js');
  return { jobRunner, child, mocks: { createRun, updateRun, appendRunEvent, readFile } };
};

describe('jobRunner coverage branches', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('covers internal guards + default status mapping', async () => {
    const { jobRunner, mocks } = await importJobRunnerWithMocks();

    // Line 31: default mapping for pending/unknown statuses.
    expect(jobRunner.__testing.mapJobStatusToRunStatus(jobRunner.JOB_STATUS.PENDING)).toBe('pending');
    expect(jobRunner.__testing.mapJobStatusToRunStatus('not-a-status')).toBe('pending');

    // Line 36: enqueueRunEvent guard.
    expect(() => jobRunner.__testing.enqueueRunEvent(null, { type: 'x' })).not.toThrow();
    expect(() => jobRunner.__testing.enqueueRunEvent({ id: 'j', type: 't' }, null)).not.toThrow();

    // Lines 54/56: pendingRunEvents init + push.
    const jobNoRun = { id: 'job-1', type: 'build', runId: null, pendingRunEvents: null };
    jobRunner.__testing.enqueueRunEvent(jobNoRun, { type: 'job:log', message: 'hi' });
    expect(Array.isArray(jobNoRun.pendingRunEvents)).toBe(true);
    expect(jobNoRun.pendingRunEvents).toHaveLength(1);

    // Line 61: enqueueRunUpdate guard.
    expect(() => jobRunner.__testing.enqueueRunUpdate(null, { status: 'running' })).not.toThrow();
    expect(() => jobRunner.__testing.enqueueRunUpdate({ id: 'j' }, null)).not.toThrow();

    // Lines 49-50: enqueueRunEvent runId path + swallow catch.
    const jobWithRun = { id: 'job-2', type: 'build', runId: 999 };

    jobRunner.__testing.enqueueRunEvent(jobWithRun, { type: 'job:log', message: 'hi', meta: { a: 1 } });
    jobRunner.__testing.enqueueRunUpdate(jobWithRun, { status: 'running', statusMessage: 'running' });

    await flushMicrotasks();

    expect(mocks.appendRunEvent).toHaveBeenCalled();
    expect(mocks.updateRun).toHaveBeenCalled();

    // Line 77: flushPendingRunWork guard when runId missing.
    await expect(jobRunner.__testing.flushPendingRunWork({ id: 'no-runid' })).resolves.toBeUndefined();
  });

  it('covers flushPendingRunWork pendingUpdates path (lines 82-90)', async () => {
    const { jobRunner, mocks } = await importJobRunnerWithMocks({ createRunResult: { id: 111 } });
    const job = {
      id: 'job-flush',
      type: 'build',
      runId: 111,
      pendingRunUpdates: { status: 'running', statusMessage: 'running' },
      pendingRunEvents: null
    };

    await jobRunner.__testing.flushPendingRunWork(job);

    expect(mocks.updateRun).toHaveBeenCalledWith(111, { status: 'running', statusMessage: 'running' });
  });

  it('covers child error handler updates + events (lines 361-367)', async () => {
    const mockChild = new MockChildProcess();
    const { jobRunner, mocks } = await importJobRunnerWithMocks({
      child: mockChild,
      createRunResult: { id: 222 }
    });
    jobRunner.__testing.clearJobs();
    jobRunner.__testing.resetJobEvents();

    const job = jobRunner.startJob({
      projectId: 222,
      type: 'build',
      command: 'node',
      args: ['-e', 'console.log("hi")'],
      cwd: '/tmp'
    });

    // Allow createRun().then(...) to run and set runId.
    await flushMicrotasks();

    const latestJob = jobRunner.getJob(job.id);
    expect(latestJob?.runId).toBe(222);

    mockChild.emit('error', new Error('boom'));

    await flushMicrotasks();

    // updateRun is called via enqueueRunUpdate.
    expect(mocks.updateRun).toHaveBeenCalledWith(
      222,
      expect.objectContaining({
        status: 'failed',
        statusMessage: 'Job failed',
        error: 'boom',
        finishedAt: expect.any(String)
      })
    );

    // appendRunEvent gets called for pending job:created and job:failed.
    expect(
      mocks.appendRunEvent.mock.calls.some(([_runId, evt]) => evt?.type === 'job:failed' && evt?.message === 'boom')
    ).toBe(true);
  });

  it('captures test summary lines from stdout logs', async () => {
    const child = new MockChildProcess();
    const { jobRunner } = await importJobRunnerWithMocks({ child });

    const job = jobRunner.startJob({
      projectId: 77,
      type: 'frontend:test',
      command: 'npm',
      args: ['run', 'test:coverage'],
      cwd: '/tmp/project'
    });

    child.stdout.emit('data', Buffer.from('Test Suites: 1 passed, 1 total\nTests: 2 passed (2)'));

    await flushMicrotasks();

    const updated = jobRunner.getJob(job.id);
    expect(updated.summary.testSummaryLines).toContain('Test Suites: 1 passed, 1 total');
    expect(updated.summary.testSummaryLines).toContain('Tests: 2 passed (2)');
  });

  it('skips blank summary lines while collecting matches', async () => {
    const child = new MockChildProcess();
    const { jobRunner } = await importJobRunnerWithMocks({ child });

    const job = jobRunner.startJob({
      projectId: 81,
      type: 'frontend:test',
      command: 'npm',
      args: ['run', 'test:coverage'],
      cwd: '/tmp/project'
    });

    child.stdout.emit('data', Buffer.from('\nTest Suites: 1 passed, 1 total'));

    await flushMicrotasks();

    const updated = jobRunner.getJob(job.id);
    expect(updated.summary.testSummaryLines).toContain('Test Suites: 1 passed, 1 total');
  });

  it('skips whitespace-only summary lines while collecting matches', async () => {
    const child = new MockChildProcess();
    const { jobRunner } = await importJobRunnerWithMocks({ child });

    const job = jobRunner.startJob({
      projectId: 82,
      type: 'frontend:test',
      command: 'npm',
      args: ['run', 'test:coverage'],
      cwd: '/tmp/project'
    });

    child.stdout.emit('data', Buffer.from('   \nTest Suites: 1 passed, 1 total'));

    await flushMicrotasks();

    const updated = jobRunner.getJob(job.id);
    expect(updated.summary.testSummaryLines).toContain('Test Suites: 1 passed, 1 total');
  });

  it('appends summary lines and skips blank lines directly', async () => {
    const { jobRunner } = await importJobRunnerWithMocks();
    const job = { type: 'frontend:test', summary: { testSummaryLines: [] } };

    jobRunner.__testing.appendTestSummaryLines(job, '\nTest Suites: 1 passed, 1 total');

    expect(job.summary.testSummaryLines).toEqual(['Test Suites: 1 passed, 1 total']);
  });

  it('ignores summary lines for non-test jobs', async () => {
    const child = new MockChildProcess();
    const { jobRunner } = await importJobRunnerWithMocks({ child });

    const job = jobRunner.startJob({
      projectId: 80,
      type: 'build',
      command: 'npm',
      args: ['run', 'build'],
      cwd: '/tmp/project'
    });

    child.stdout.emit('data', Buffer.from('Test Suites: 1 passed, 1 total'));

    await flushMicrotasks();

    const updated = jobRunner.getJob(job.id);
    expect(updated.summary?.testSummaryLines).toBeUndefined();
  });

  it('does not store summary lines when no summary patterns match', async () => {
    const child = new MockChildProcess();
    const { jobRunner } = await importJobRunnerWithMocks({ child });

    const job = jobRunner.startJob({
      projectId: 78,
      type: 'frontend:test',
      command: 'npm',
      args: ['run', 'test:coverage'],
      cwd: '/tmp/project'
    });

    child.stdout.emit('data', Buffer.from('hello world'));

    await flushMicrotasks();

    const updated = jobRunner.getJob(job.id);
    expect(updated.summary?.testSummaryLines).toBeUndefined();
  });

  it('dedupes and truncates summary lines to the maximum', async () => {
    const child = new MockChildProcess();
    const { jobRunner } = await importJobRunnerWithMocks({ child });

    const job = jobRunner.startJob({
      projectId: 79,
      type: 'frontend:test',
      command: 'npm',
      args: ['run', 'test:coverage'],
      cwd: '/tmp/project'
    });

    const log = [
      'Test Suites: 1 passed, 1 total',
      'Tests: 2 passed (2)',
      'Snapshots: 0 total',
      'Time: 1.23 s',
      'Ran all test suites.',
      'Test Files 2 passed (2)',
      'Duration 1.23s',
      'Tests: 2 passed (2)'
    ].join('\n');

    child.stdout.emit('data', Buffer.from(log));

    await flushMicrotasks();

    const updated = jobRunner.getJob(job.id);
    expect(updated.summary.testSummaryLines.length).toBe(6);
    expect(updated.summary.testSummaryLines).toContain('Test Suites: 1 passed, 1 total');
    expect(updated.summary.testSummaryLines).toContain('Test Files 2 passed (2)');
    expect(updated.summary.testSummaryLines).not.toContain('Duration 1.23s');
  });

  it('returns null coverage totals when cwd is missing or totals are invalid', async () => {
    const readFileImpl = () => Promise.resolve(JSON.stringify({
      total: {
        lines: { pct: 'oops' },
        statements: { pct: 100 },
        functions: { pct: 100 },
        branches: { pct: 100 }
      }
    }));

    const { jobRunner } = await importJobRunnerWithMocks({ readFileImpl });

    await expect(jobRunner.__testing.readCoverageTotals('')).resolves.toBeNull();
    await expect(jobRunner.__testing.readCoverageTotals('/tmp/project')).resolves.toBeNull();
  });

  it('returns null coverage totals when summary total is missing', async () => {
    const readFileImpl = () => Promise.resolve(JSON.stringify({ total: null }));
    const { jobRunner } = await importJobRunnerWithMocks({ readFileImpl });

    await expect(jobRunner.__testing.readCoverageTotals('/tmp/project')).resolves.toBeNull();
  });

  it('skips invalid coverage totals when parsing logs directly', async () => {
    const { jobRunner } = await importJobRunnerWithMocks();

    const totals = jobRunner.__testing.parseCoverageTotalsFromLogs([
      { message: 'All files          |   99.0.0 |    100 |      100 |   100 |' }
    ]);

    expect(totals).toBeNull();
  });

  it('handles empty log lines when parsing coverage totals directly', async () => {
    const { jobRunner } = await importJobRunnerWithMocks();

    const totals = jobRunner.__testing.parseCoverageTotalsFromLogs([
      { message: '\nAll files          |   100 |    100 |      100 |   100 |' }
    ]);

    expect(totals).toMatchObject({
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100
    });
  });

  it('skips coverage gate evaluation for missing or non-test jobs', async () => {
    const { jobRunner } = await importJobRunnerWithMocks();

    await expect(jobRunner.__testing.evaluateCoverageGate(null)).resolves.toBeUndefined();

    const job = { status: jobRunner.JOB_STATUS.SUCCEEDED, type: 'build' };
    await expect(jobRunner.__testing.evaluateCoverageGate(job)).resolves.toBeUndefined();
    expect(job.summary).toBeUndefined();
  });

  it('skips coverage gate evaluation when test jobs are not successful', async () => {
    const { jobRunner } = await importJobRunnerWithMocks();

    const job = {
      status: jobRunner.JOB_STATUS.FAILED,
      type: 'frontend:test',
      cwd: '/tmp/project',
      logs: []
    };

    await expect(jobRunner.__testing.evaluateCoverageGate(job)).resolves.toBeUndefined();
    expect(job.summary).toBeUndefined();
    expect(job.status).toBe(jobRunner.JOB_STATUS.FAILED);
  });

  it('builds a coverage failure summary when existing summary is not an object', async () => {
    const readFileImpl = () => Promise.reject(new Error('ENOENT'));
    const { jobRunner } = await importJobRunnerWithMocks({ readFileImpl });

    const job = {
      status: jobRunner.JOB_STATUS.SUCCEEDED,
      type: 'frontend:test',
      cwd: '/tmp/project',
      logs: [],
      summary: 'nope'
    };

    await jobRunner.__testing.evaluateCoverageGate(job, { assumeSucceeded: true });

    expect(job.status).toBe(jobRunner.JOB_STATUS.FAILED);
    expect(job.summary.coverage.passed).toBe(false);
  });

  it('merges coverage failure details when an existing summary object is present', async () => {
    const readFileImpl = () => Promise.reject(new Error('ENOENT'));
    const { jobRunner } = await importJobRunnerWithMocks({ readFileImpl });

    const job = {
      status: jobRunner.JOB_STATUS.SUCCEEDED,
      type: 'frontend:test',
      cwd: '/tmp/project',
      logs: [],
      summary: { previous: 'state' }
    };

    await jobRunner.__testing.evaluateCoverageGate(job, { assumeSucceeded: true });

    expect(job.status).toBe(jobRunner.JOB_STATUS.FAILED);
    expect(job.summary.previous).toBe('state');
  });

  it('builds a coverage success summary when existing summary is not an object', async () => {
    const readFileImpl = () => Promise.resolve(JSON.stringify({
      total: {
        lines: { pct: 100 },
        statements: { pct: 100 },
        functions: { pct: 100 },
        branches: { pct: 100 }
      }
    }));

    const { jobRunner } = await importJobRunnerWithMocks({ readFileImpl });

    const job = {
      status: jobRunner.JOB_STATUS.SUCCEEDED,
      type: 'frontend:test',
      cwd: '/tmp/project',
      logs: [],
      summary: 'nope'
    };

    await jobRunner.__testing.evaluateCoverageGate(job, { assumeSucceeded: true });

    expect(job.status).toBe(jobRunner.JOB_STATUS.SUCCEEDED);
    expect(job.summary.coverage.passed).toBe(true);
  });

  it('merges coverage success details when an existing summary object is present', async () => {
    const readFileImpl = () => Promise.resolve(JSON.stringify({
      total: {
        lines: { pct: 100 },
        statements: { pct: 100 },
        functions: { pct: 100 },
        branches: { pct: 100 }
      }
    }));

    const { jobRunner } = await importJobRunnerWithMocks({ readFileImpl });

    const job = {
      status: jobRunner.JOB_STATUS.SUCCEEDED,
      type: 'frontend:test',
      cwd: '/tmp/project',
      logs: [],
      summary: { previous: 'state' }
    };

    await jobRunner.__testing.evaluateCoverageGate(job, { assumeSucceeded: true });

    expect(job.status).toBe(jobRunner.JOB_STATUS.SUCCEEDED);
    expect(job.summary.previous).toBe('state');
  });

  it('swallows finalize errors when coverage evaluation throws', async () => {
    const child = new MockChildProcess();
    const { jobRunner } = await importJobRunnerWithMocks({ child });

    const job = jobRunner.startJob({
      projectId: 91,
      type: 'frontend:test',
      command: 'npm',
      args: ['run', 'test:coverage'],
      cwd: '/tmp/project'
    });

    const rawJob = jobRunner.__testing.getRawJob(job.id);
    Object.defineProperty(rawJob, 'logs', {
      get() {
        throw new Error('boom');
      }
    });

    child.emit('exit', 0, null);

    await flushMicrotasks();

    expect(rawJob.completedAt).toEqual(expect.any(String));
  });

  it('handles empty and non-matching coverage log lines', async () => {
    const readFileImpl = () => Promise.reject(new Error('ENOENT'));
    const { jobRunner } = await importJobRunnerWithMocks({ readFileImpl });

    const job = {
      status: jobRunner.JOB_STATUS.SUCCEEDED,
      type: 'frontend:test',
      cwd: '/tmp/project',
      logs: [
        { message: '' },
        { message: 'Some other output' }
      ]
    };

    await jobRunner.__testing.evaluateCoverageGate(job, { assumeSucceeded: true });

    expect(job.status).toBe(jobRunner.JOB_STATUS.FAILED);
    expect(job.summary.coverage.totals).toBeNull();
  });

  it('handles non-array log payloads for coverage parsing', async () => {
    const readFileImpl = () => Promise.reject(new Error('ENOENT'));
    const { jobRunner } = await importJobRunnerWithMocks({ readFileImpl });

    const job = {
      status: jobRunner.JOB_STATUS.SUCCEEDED,
      type: 'frontend:test',
      cwd: '/tmp/project',
      logs: null
    };

    await jobRunner.__testing.evaluateCoverageGate(job, { assumeSucceeded: true });

    expect(job.status).toBe(jobRunner.JOB_STATUS.FAILED);
    expect(job.summary.coverage.totals).toBeNull();
  });

  it('ignores invalid coverage totals and uses the next valid log line', async () => {
    const readFileImpl = () => Promise.reject(new Error('ENOENT'));
    const { jobRunner } = await importJobRunnerWithMocks({ readFileImpl });

    const job = {
      status: jobRunner.JOB_STATUS.SUCCEEDED,
      type: 'frontend:test',
      cwd: '/tmp/project',
      logs: [
        { message: 'All files          |   99.0.0 |    100 |      100 |   100 |\nAll files          |   100 |    100 |      100 |   100 |' }
      ]
    };

    await jobRunner.__testing.evaluateCoverageGate(job, { assumeSucceeded: true });

    expect(job.summary.coverage.totals).toMatchObject({
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100
    });
    expect(job.status).toBe(jobRunner.JOB_STATUS.SUCCEEDED);
  });

  it('ignores invalid coverage totals in logs and reports missing summary', async () => {
    const readFileImpl = () => Promise.reject(new Error('ENOENT'));
    const { jobRunner } = await importJobRunnerWithMocks({ readFileImpl });

    const job = {
      status: jobRunner.JOB_STATUS.SUCCEEDED,
      type: 'frontend:test',
      cwd: '/tmp/project',
      logs: [
        { message: 'All files          |   99.0 |    nope |      100 |   100 |' }
      ]
    };

    await jobRunner.__testing.evaluateCoverageGate(job, { assumeSucceeded: true });

    expect(job.status).toBe(jobRunner.JOB_STATUS.FAILED);
    expect(job.summary.coverage.totals).toBeNull();
    expect(job.summary.coverage.message).toBe('Coverage gate failed: coverage summary not found.');
  });

  it('marks coverage gate failures when totals fall below 100%', async () => {
    const readFileImpl = () => Promise.resolve(JSON.stringify({
      total: {
        lines: { pct: 99 },
        statements: { pct: 100 },
        functions: { pct: 100 },
        branches: { pct: 100 }
      }
    }));

    const { jobRunner } = await importJobRunnerWithMocks({ readFileImpl });

    const job = {
      status: jobRunner.JOB_STATUS.SUCCEEDED,
      type: 'frontend:test',
      cwd: '/tmp/project'
    };

    await jobRunner.__testing.evaluateCoverageGate(job, { assumeSucceeded: true });

    expect(job.status).toBe(jobRunner.JOB_STATUS.FAILED);
    expect(job.summary.coverage.passed).toBe(false);
    expect(job.summary.coverage.totals.lines).toBe(99);
  });

  it('marks coverage gate failures when summary is missing', async () => {
    const readFileImpl = () => Promise.reject(new Error('ENOENT'));
    const { jobRunner } = await importJobRunnerWithMocks({ readFileImpl });

    const job = {
      status: jobRunner.JOB_STATUS.SUCCEEDED,
      type: 'frontend:test',
      cwd: '/tmp/project',
      logs: []
    };

    await jobRunner.__testing.evaluateCoverageGate(job, { assumeSucceeded: true });

    expect(job.status).toBe(jobRunner.JOB_STATUS.FAILED);
    expect(job.summary.coverage.totals).toBeNull();
  });

  it('falls back to coverage totals from logs when summary file is missing', async () => {
    const readFileImpl = () => Promise.reject(new Error('ENOENT'));
    const { jobRunner } = await importJobRunnerWithMocks({ readFileImpl });

    const job = {
      status: jobRunner.JOB_STATUS.SUCCEEDED,
      type: 'frontend:test',
      cwd: '/tmp/project',
      logs: [
        { message: 'All files          |   53.62 |    77.77 |      50 |   53.62 |' }
      ]
    };

    await jobRunner.__testing.evaluateCoverageGate(job, { assumeSucceeded: true });

    expect(job.summary.coverage.totals).toMatchObject({
      statements: 53.62,
      branches: 77.77,
      functions: 50,
      lines: 53.62
    });
    expect(job.status).toBe(jobRunner.JOB_STATUS.FAILED);
  });

  it('fails test jobs when coverage totals are below 100%', async () => {
    const mockChild = new MockChildProcess();
    const coverageJson = JSON.stringify({
      total: {
        lines: { pct: 99 },
        statements: { pct: 100 },
        functions: { pct: 100 },
        branches: { pct: 100 }
      }
    });

    const { jobRunner, child, mocks } = await importJobRunnerWithMocks({
      child: mockChild,
      createRunResult: { id: 333 },
      readFileImpl: () => Promise.resolve(coverageJson)
    });

    jobRunner.__testing.clearJobs();
    jobRunner.__testing.resetJobEvents();

    const job = jobRunner.startJob({
      projectId: 333,
      type: 'frontend:test',
      command: 'npm',
      args: ['run', 'test:coverage'],
      cwd: 'C:/tmp/project/frontend'
    });

    await flushMicrotasks();

    child.emit('exit', 0, null);

    await flushMicrotasks();

    const completed = jobRunner.getJob(job.id);
    expect(completed.status).toBe('failed');
    expect(completed.summary.coverage.passed).toBe(false);
    expect(completed.summary.coverage.totals.lines).toBe(99);
    expect(mocks.readFile).toHaveBeenCalled();
  });

  it('skips coverage gate when a test job fails', async () => {
    const mockChild = new MockChildProcess();
    const coverageJson = JSON.stringify({
      total: {
        lines: { pct: 100 },
        statements: { pct: 100 },
        functions: { pct: 100 },
        branches: { pct: 100 }
      }
    });

    const { jobRunner, child, mocks } = await importJobRunnerWithMocks({
      child: mockChild,
      createRunResult: { id: 444 },
      readFileImpl: () => Promise.resolve(coverageJson)
    });

    jobRunner.__testing.clearJobs();
    jobRunner.__testing.resetJobEvents();

    const job = jobRunner.startJob({
      projectId: 444,
      type: 'frontend:test',
      command: 'npm',
      args: ['run', 'test:coverage'],
      cwd: 'C:/tmp/project/frontend'
    });

    await flushMicrotasks();

    child.emit('exit', 1, null);

    await flushMicrotasks();

    const completed = jobRunner.getJob(job.id);
    expect(completed.status).toBe('failed');
    expect(completed.summary).toBeUndefined();
    expect(mocks.readFile).not.toHaveBeenCalled();
  });
});
