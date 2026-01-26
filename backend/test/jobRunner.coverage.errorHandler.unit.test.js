import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

const spawnMock = vi.fn();

vi.mock('child_process', () => ({
  spawn: (...args) => spawnMock(...args)
}));

vi.mock('../services/runStore.js', () => ({
  appendRunEvent: vi.fn(),
  createRun: vi.fn(),
  updateRun: vi.fn()
}));

import * as jobRunner from '../services/jobRunner.js';
import * as runStore from '../services/runStore.js';

describe('jobRunner coverage (child error handler)', () => {
  afterEach(() => {
    jobRunner.__testing.clearJobs();
    jobRunner.__testing.resetJobEvents();
    vi.clearAllMocks();
  });

  it('marks job failed and queues run updates/events when child emits error', async () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 12345;

    spawnMock.mockReturnValue(child);
    runStore.createRun.mockResolvedValue({});

    const started = jobRunner.startJob({
      projectId: 1,
      type: 'build',
      command: 'node',
      args: ['-v'],
      cwd: 'C:\\tmp',
      env: {}
    });

    child.emit('error', new Error('boom'));

    const updated = jobRunner.getJob(started.id);
    expect(updated.status).toBe(jobRunner.JOB_STATUS.FAILED);
    expect(updated.completedAt).not.toBeNull();

    expect(updated.pendingRunUpdates).toMatchObject({
      status: 'failed',
      statusMessage: 'Job failed',
      error: 'boom'
    });

    const queuedTypes = (updated.pendingRunEvents || []).map((evt) => evt.type);
    expect(queuedTypes).toContain('job:failed');
  });

  it('falls back to default message when error message is empty', async () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 12345;

    spawnMock.mockReturnValue(child);
    runStore.createRun.mockResolvedValue({});

    const started = jobRunner.startJob({
      projectId: 1,
      type: 'build',
      command: 'node',
      args: ['-v'],
      cwd: 'C:\\tmp',
      env: {}
    });

    child.emit('error', new Error(''));

    const updated = jobRunner.getJob(started.id);
    expect(updated.status).toBe(jobRunner.JOB_STATUS.FAILED);

    expect(updated.pendingRunUpdates).toMatchObject({
      status: 'failed',
      statusMessage: 'Job failed',
      error: 'Job failed'
    });

    const failedEvent = (updated.pendingRunEvents || []).find((evt) => evt.type === 'job:failed');
    expect(failedEvent).toBeTruthy();
    expect(failedEvent.message).toBe('Job failed');
  });

  it('falls back to default message when error is not an Error', async () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 12345;

    spawnMock.mockReturnValue(child);
    runStore.createRun.mockResolvedValue({});

    const started = jobRunner.startJob({
      projectId: 1,
      type: 'build',
      command: 'node',
      args: ['-v'],
      cwd: 'C:\\tmp',
      env: {}
    });

    child.emit('error', {});

    const updated = jobRunner.getJob(started.id);
    expect(updated.status).toBe(jobRunner.JOB_STATUS.FAILED);
    expect(updated.pendingRunUpdates).toMatchObject({
      status: 'failed',
      statusMessage: 'Job failed',
      error: 'Job failed'
    });
  });
});
