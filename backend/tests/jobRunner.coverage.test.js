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
  appendRunEventImpl
} = {}) => {
  const runStorePath = fileURLToPath(new URL('../services/runStore.js', import.meta.url));

  const updateRun = vi.fn(updateRunImpl || (() => Promise.resolve({})));
  const appendRunEvent = vi.fn(appendRunEventImpl || (() => Promise.resolve({})));
  const createRun = vi.fn(() => Promise.resolve(createRunResult));

  vi.doMock('child_process', () => ({
    spawn: vi.fn(() => child)
  }));

  vi.doMock(runStorePath, () => ({
    createRun,
    updateRun,
    appendRunEvent
  }));

  const jobRunner = await import('../services/jobRunner.js');
  return { jobRunner, child, mocks: { createRun, updateRun, appendRunEvent } };
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
});
