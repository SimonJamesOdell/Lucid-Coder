import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

const spawnMock = vi.fn();

vi.mock('child_process', () => ({
  spawn: (...args) => spawnMock(...args)
}));

vi.mock('../services/runStore.js', () => ({
  appendRunEvent: vi.fn(async () => {}),
  createRun: vi.fn(async () => ({ id: 'run-1' })),
  updateRun: vi.fn(async () => {})
}));

import * as jobRunner from '../services/jobRunner.js';
import * as runStore from '../services/runStore.js';

const tick = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('jobRunner coverage (functions)', () => {
  afterEach(() => {
    jobRunner.__testing.clearJobs();
    jobRunner.__testing.resetJobEvents();
    vi.clearAllMocks();
  });

  it('covers startJob lifecycle, logging, exit handler, and waitForJobCompletion', async () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 12345;

    spawnMock.mockReturnValue(child);
    runStore.createRun.mockResolvedValueOnce({ id: 'run-abc' });

    // Attach listeners to exercise emitter paths.
    jobRunner.jobEvents.on('job:created', () => {});
    jobRunner.jobEvents.on('job:updated', () => {});
    jobRunner.jobEvents.on('job:log', () => {});

    const started = jobRunner.startJob({
      projectId: 7,
      type: 'build',
      command: 'node',
      args: ['-v'],
      cwd: 'C:\\tmp',
      env: {}
    });

    expect(started.status).toBe(jobRunner.JOB_STATUS.RUNNING);

    // Allow createRun().then(...) to run and flush queued run work.
    await tick();
    await tick();

    // Exercise stdout/stderr handlers and pushLog filters.
    child.stdout.emit('data', Buffer.from('hello\n'));
    child.stderr.emit('data', Buffer.from('  \n'));

    const completion = jobRunner.waitForJobCompletion(started.id, { timeoutMs: 5000 });
    child.emit('exit', 0, null);

    const completed = await completion;
    expect(completed.status).toBe(jobRunner.JOB_STATUS.SUCCEEDED);

    // Exercise exported selectors.
    expect(jobRunner.getJob(started.id)).not.toBeNull();
    expect(jobRunner.listJobsForProject(7).length).toBeGreaterThan(0);
    expect(jobRunner.getAllJobs().length).toBeGreaterThan(0);

    // Terminal cancelJob is a quick-return path.
    const cancelled = jobRunner.cancelJob(started.id);
    expect(cancelled.status).toBe(jobRunner.JOB_STATUS.SUCCEEDED);

    expect(runStore.appendRunEvent).toHaveBeenCalled();
  });

  it('rejects when waitForJobCompletion times out', async () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 333;

    spawnMock.mockReturnValue(child);

    const started = jobRunner.startJob({
      projectId: 99,
      type: 'build',
      command: 'node',
      args: ['-v'],
      cwd: 'C:\\tmp',
      env: {}
    });

    await expect(jobRunner.waitForJobCompletion(started.id, { timeoutMs: 0 }))
      .rejects
      .toMatchObject({ message: 'Timed out waiting for job completion', jobId: started.id });
  });

  it('covers createRun rejection catch handler (best-effort)', async () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 222;

    spawnMock.mockReturnValue(child);
    runStore.createRun.mockRejectedValueOnce(new Error('nope'));

    jobRunner.startJob({
      projectId: 1,
      type: 'build',
      command: 'node',
      args: ['-v'],
      cwd: 'C:\\tmp',
      env: {}
    });

    await tick();
  });

  it('covers cancelJob non-terminal path and terminatePid branches', async () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 999;

    spawnMock.mockReturnValue(child);
    runStore.createRun.mockResolvedValueOnce({ id: 'run-cancel' });

    const started = jobRunner.startJob({
      projectId: 2,
      type: 'build',
      command: 'node',
      args: ['-v'],
      cwd: 'C:\\tmp',
      env: {}
    });

    await tick();

    // Unknown job id.
    expect(jobRunner.cancelJob('nope')).toBeNull();

    const cancelled = jobRunner.cancelJob(started.id);
    expect(cancelled.status).toBe(jobRunner.JOB_STATUS.CANCELLED);

    // Directly cover non-win32 terminatePid branch.
    const killMock = vi.fn();
    const spawnNoop = vi.fn();
    jobRunner.__testing.terminatePid(123, 'linux', { spawn: spawnNoop, kill: killMock });
    expect(killMock).toHaveBeenCalled();
  });

  it('logs stderr when terminatePid throws during cancelJob (Error + non-Error)', async () => {
    // Case 1: terminatePid throws Error with a message.
    {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 444;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw new Error('kill failed');
      });

      spawnMock.mockReturnValueOnce(child);
      runStore.createRun.mockResolvedValueOnce({ id: 'run-cancel-error' });

      const started = jobRunner.startJob({
        projectId: 3,
        type: 'build',
        command: 'node',
        args: ['-v'],
        cwd: 'C:\\tmp',
        env: {}
      });

      await tick();

      const cancelled = jobRunner.cancelJob(started.id);
      expect(cancelled.status).toBe(jobRunner.JOB_STATUS.CANCELLED);
      expect((cancelled.logs || []).some((l) => l.stream === 'stderr' && l.message.includes('kill failed'))).toBe(true);
      killSpy.mockRestore();
    }

    // Case 2: terminatePid throws a non-Error value (fallback message).
    {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 555;
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw {};
      });

      spawnMock.mockReturnValueOnce(child);
      runStore.createRun.mockResolvedValueOnce({ id: 'run-cancel-non-error' });

      const started = jobRunner.startJob({
        projectId: 4,
        type: 'build',
        command: 'node',
        args: ['-v'],
        cwd: 'C:\\tmp',
        env: {}
      });

      await tick();

      const cancelled = jobRunner.cancelJob(started.id);
      expect(cancelled.status).toBe(jobRunner.JOB_STATUS.CANCELLED);
      expect((cancelled.logs || []).some((l) => l.stream === 'stderr' && l.message.includes('Job failed'))).toBe(true);
      killSpy.mockRestore();
    }
  });

  it('covers runId fast-path rejection handlers for run updates/events', async () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 777;

    spawnMock.mockReturnValue(child);

    // Ensure job.runId is set, then force updateRun/appendRunEvent to reject so the
    // inline .catch(() => {}) handlers are exercised.
    runStore.createRun.mockResolvedValueOnce({ id: 'run-fast-path' });
    runStore.appendRunEvent.mockRejectedValue(new Error('append exploded'));
    runStore.updateRun.mockRejectedValue(new Error('update exploded'));

    const started = jobRunner.startJob({
      projectId: 5,
      type: 'build',
      command: 'node',
      args: ['-v'],
      cwd: 'C:\\tmp',
      env: {}
    });

    // Allow createRun().then(...) to set runId and flush pending work.
    await tick();
    await tick();

    // With runId set, this should route through enqueueRunEvent's runId path.
    child.stdout.emit('data', Buffer.from('hello\n'));

    // With runId set, this should route through enqueueRunUpdate's runId path.
    child.emit('exit', 0, null);

    await tick();
    await tick();

    const latest = jobRunner.getJob(started.id);
    expect(latest.runId).toBe('run-fast-path');
    expect(runStore.appendRunEvent).toHaveBeenCalled();
    expect(runStore.updateRun).toHaveBeenCalled();
  });

  it('normalizes non-finite coverage thresholds to defaults', async () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 111;

    spawnMock.mockReturnValue(child);

    const started = jobRunner.startJob({
      projectId: 6,
      type: 'frontend:test',
      command: 'node',
      args: ['-v'],
      cwd: 'C:\\tmp',
      env: {},
      coverageThresholds: {
        lines: 'NaN',
        statements: undefined,
        functions: null,
        branches: Infinity
      }
    });

    const rawJob = jobRunner.__testing.getRawJob(started.id);
    expect(rawJob.coverageThresholds).toEqual({
      lines: 100,
      statements: 100,
      functions: 0,
      branches: 100
    });
  });
});
