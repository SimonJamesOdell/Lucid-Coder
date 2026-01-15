import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import {
  startJob,
  cancelJob,
  getJob,
  listJobsForProject,
  getAllJobs,
  waitForJobCompletion,
  JOB_STATUS,
  __testing,
  jobEvents
} from '../services/jobRunner.js';

vi.mock('child_process', () => ({
  spawn: vi.fn()
}));

class MockChildProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = Math.floor(Math.random() * 10000) + 1000;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
  }

  kill(signal) {
    this.killed = true;
    this.emit('exit', null, signal);
  }
}

const waitFor = (assertions, delay = 50) => new Promise((resolve) => {
  setTimeout(() => {
    assertions();
    resolve();
  }, delay);
});

describe('jobRunner', () => {
  let mockChild;
  const isWindows = process.platform === 'win32';

  beforeEach(() => {
    mockChild = new MockChildProcess();
    spawn.mockReturnValue(mockChild);
    __testing.clearJobs();
    __testing.resetJobEvents();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('startJob', () => {
    it('throws error when missing required configuration', () => {
      expect(() => startJob({})).toThrow('Missing required job configuration');
      expect(() => startJob({ projectId: 1 })).toThrow('Missing required job configuration');
      expect(() => startJob({ projectId: 1, type: 'build' })).toThrow('Missing required job configuration');
      expect(() => startJob({ projectId: 1, type: 'build', command: 'npm' })).toThrow('Missing required job configuration');
    });

    it('creates a job with required fields', () => {
      const job = startJob({
        projectId: 42,
        type: 'build',
        command: 'npm',
        args: ['run', 'build'],
        cwd: '/project/path'
      });

      expect(job).toMatchObject({
        projectId: 42,
        type: 'build',
        displayName: 'build',
        command: 'npm',
        args: ['run', 'build'],
        cwd: '/project/path',
        status: JOB_STATUS.RUNNING
      });
      expect(job.id).toBeDefined();
      expect(job.createdAt).toBeDefined();
      expect(job.startedAt).toBeDefined();
      expect(job.logs).toEqual([]);
    });

    it('uses custom displayName when provided', () => {
      const job = startJob({
        projectId: 1,
        type: 'build',
        displayName: 'Custom Build Task',
        command: 'npm',
        cwd: '/path'
      });

      expect(job.displayName).toBe('Custom Build Task');
    });

    it('spawns child process with correct parameters', () => {
      startJob({
        projectId: 1,
        type: 'test',
        command: 'npm',
        args: ['test'],
        cwd: '/project',
        env: { NODE_ENV: 'test' }
      });

      expect(spawn).toHaveBeenCalledWith(
        'npm',
        ['test'],
        expect.objectContaining({
          cwd: '/project',
          env: expect.objectContaining({ NODE_ENV: 'test' }),
          shell: process.platform === 'win32',
          windowsHide: true
        })
      );
    });

    it('captures stdout logs', async () => {
      const job = startJob({
        projectId: 1,
        type: 'build',
        command: 'echo',
        args: ['hello'],
        cwd: '/path'
      });

      mockChild.stdout.emit('data', Buffer.from('Build started\n'));
      mockChild.stdout.emit('data', Buffer.from('Build finished\n'));

      await waitFor(() => {
        const updatedJob = getJob(job.id);
        expect(updatedJob.logs).toHaveLength(2);
        expect(updatedJob.logs[0]).toMatchObject({
          stream: 'stdout',
          message: 'Build started'
        });
        expect(updatedJob.logs[1]).toMatchObject({
          stream: 'stdout',
          message: 'Build finished'
        });
      });
    });

    it('swallows jobEvents listener failures for created + log emissions', async () => {
      jobEvents.on('job:created', () => {
        throw new Error('listener boom');
      });
      jobEvents.on('job:log', () => {
        throw new Error('listener boom');
      });

      const job = startJob({
        projectId: 1,
        type: 'build',
        command: 'echo',
        args: ['hello'],
        cwd: '/path'
      });

      expect(job.status).toBe(JOB_STATUS.RUNNING);
      expect(() => {
        mockChild.stdout.emit('data', Buffer.from('hello\n'));
      }).not.toThrow();

      await waitFor(() => {
        const updatedJob = getJob(job.id);
        expect(updatedJob.logs).toHaveLength(1);
      });
    });

    it('captures stderr logs', async () => {
      const job = startJob({
        projectId: 1,
        type: 'build',
        command: 'npm',
        cwd: '/path'
      });

      mockChild.stderr.emit('data', Buffer.from('Warning: deprecated package\n'));

      await waitFor(() => {
        const updatedJob = getJob(job.id);
        expect(updatedJob.logs).toHaveLength(1);
        expect(updatedJob.logs[0]).toMatchObject({
          stream: 'stderr',
          message: 'Warning: deprecated package'
        });
      });
    });

    it('ignores missing chunk events', async () => {
      const job = startJob({
        projectId: 1,
        type: 'build',
        command: 'npm',
        cwd: '/path'
      });

      mockChild.stdout.emit('data');
      mockChild.stderr.emit('data', null);

      await waitFor(() => {
        const updatedJob = getJob(job.id);
        expect(updatedJob.logs).toHaveLength(0);
      });
    });

    it('ignores empty log chunks', async () => {
      const job = startJob({
        projectId: 1,
        type: 'build',
        command: 'npm',
        cwd: '/path'
      });

      mockChild.stdout.emit('data', Buffer.from(''));
      mockChild.stdout.emit('data', Buffer.from('  \n  '));
      mockChild.stdout.emit('data', Buffer.from('Valid message\n'));

      await waitFor(() => {
        const updatedJob = getJob(job.id);
        expect(updatedJob.logs).toHaveLength(1);
        expect(updatedJob.logs[0].message).toBe('Valid message');
      });
    });

    it('skips wiring log handlers when stdio streams are absent', () => {
      mockChild.stdout = null;
      mockChild.stderr = null;

      const job = startJob({
        projectId: 1,
        type: 'build',
        command: 'npm',
        cwd: '/path'
      });

      expect(job.logs).toEqual([]);
      const reloaded = getJob(job.id);
      expect(reloaded.logs).toEqual([]);
      expect(typeof reloaded.startedAt).toBe('string');
    });

    it('limits log entries to MAX_LOG_ENTRIES', async () => {
      const job = startJob({
        projectId: 1,
        type: 'build',
        command: 'npm',
        cwd: '/path'
      });

      // Emit more than 500 log entries
      for (let i = 0; i < 600; i++) {
        mockChild.stdout.emit('data', Buffer.from(`Log entry ${i}\n`));
      }

      await waitFor(() => {
        const updatedJob = getJob(job.id);
        expect(updatedJob.logs).toHaveLength(500);
        // Should keep the most recent entries
        expect(updatedJob.logs[0].message).toBe('Log entry 100');
        expect(updatedJob.logs[499].message).toBe('Log entry 599');
      }, 100);
    });

    it('sets status to SUCCEEDED on successful exit', async () => {
      const job = startJob({
        projectId: 1,
        type: 'build',
        command: 'npm',
        cwd: '/path'
      });

      mockChild.emit('exit', 0, null);

      await waitFor(() => {
        const updatedJob = getJob(job.id);
        expect(updatedJob.status).toBe(JOB_STATUS.SUCCEEDED);
        expect(updatedJob.exitCode).toBe(0);
        expect(updatedJob.completedAt).toBeDefined();
      });
    });

    it('sets status to FAILED on non-zero exit code', async () => {
      const job = startJob({
        projectId: 1,
        type: 'build',
        command: 'npm',
        cwd: '/path'
      });

      mockChild.emit('exit', 1, null);

      await waitFor(() => {
        const updatedJob = getJob(job.id);
        expect(updatedJob.status).toBe(JOB_STATUS.FAILED);
        expect(updatedJob.exitCode).toBe(1);
        expect(updatedJob.completedAt).toBeDefined();
      });
    });

    it('handles process errors', async () => {
      const job = startJob({
        projectId: 1,
        type: 'build',
        command: 'invalid-command',
        cwd: '/path'
      });

      const error = new Error('spawn ENOENT');
      mockChild.emit('error', error);

      await waitFor(() => {
        const updatedJob = getJob(job.id);
        expect(updatedJob.status).toBe(JOB_STATUS.FAILED);
        expect(updatedJob.logs.some(log => log.message.includes('spawn ENOENT'))).toBe(true);
        expect(updatedJob.completedAt).toBeDefined();
      });
    });

    it('captures signal when process is terminated', async () => {
      const job = startJob({
        projectId: 1,
        type: 'build',
        command: 'npm',
        cwd: '/path'
      });

      mockChild.emit('exit', null, 'SIGTERM');

      await waitFor(() => {
        const updatedJob = getJob(job.id);
        expect(updatedJob.signal).toBe('SIGTERM');
        expect(updatedJob.status).toBe(JOB_STATUS.FAILED);
      });
    });

    it('does not include process object in returned job', () => {
      const job = startJob({
        projectId: 1,
        type: 'build',
        command: 'npm',
        cwd: '/path'
      });

      expect(job.process).toBeUndefined();
    });
  });

  describe('waitForJobCompletion', () => {
    it('rejects when jobId is missing', async () => {
      await expect(waitForJobCompletion()).rejects.toThrow('jobId is required');
    });

    it('resolves when the job completes successfully', async () => {
      const job = startJob({
        projectId: 1,
        type: 'test',
        command: 'npm',
        args: ['test'],
        cwd: '/project'
      });

      const promise = waitForJobCompletion(job.id, { timeoutMs: 1000 });

      // Simulate command finishing.
      mockChild.emit('exit', 0, null);

      const completed = await promise;
      expect(completed.status).toBe(JOB_STATUS.SUCCEEDED);
      expect(completed.completedAt).toBeDefined();
    });

    it('resolves immediately when the job is already in a terminal status', async () => {
      const job = startJob({
        projectId: 1,
        type: 'test',
        command: 'npm',
        args: ['test'],
        cwd: '/project'
      });

      mockChild.emit('exit', 0, null);

      await waitFor(() => {
        const updatedJob = getJob(job.id);
        expect(updatedJob.status).toBe(JOB_STATUS.SUCCEEDED);
      });

      const completed = await waitForJobCompletion(job.id, { timeoutMs: 1000 });
      expect(completed.status).toBe(JOB_STATUS.SUCCEEDED);
    });

    it('ignores unrelated job:updated events until the target job completes', async () => {
      const job = startJob({
        projectId: 1,
        type: 'test',
        command: 'npm',
        args: ['test'],
        cwd: '/project'
      });

      const promise = waitForJobCompletion(job.id, { timeoutMs: 1000 });

      jobEvents.emit('job:updated', null);
      jobEvents.emit('job:updated', { id: 'other-job', status: JOB_STATUS.SUCCEEDED });

      mockChild.emit('exit', 0, null);

      const completed = await promise;
      expect(completed.status).toBe(JOB_STATUS.SUCCEEDED);
    });

    it('ignores non-terminal updates for the target job until it completes', async () => {
      const job = startJob({
        projectId: 1,
        type: 'test',
        command: 'npm',
        args: ['test'],
        cwd: '/project'
      });

      const promise = waitForJobCompletion(job.id, { timeoutMs: 1000 });

      jobEvents.emit('job:updated', { id: job.id, status: JOB_STATUS.RUNNING });

      mockChild.emit('exit', 0, null);

      const completed = await promise;
      expect(completed.status).toBe(JOB_STATUS.SUCCEEDED);
    });

    it('handles non-finite timeouts and ignores late timeout callbacks after completion', async () => {
      const realSetTimeout = global.setTimeout;

      const setTimeoutSpy = vi
        .spyOn(global, 'setTimeout')
        .mockImplementation((callback, _delay, ...args) => {
          // Force the timeout callback to run soon, while returning a falsy handle
          // so cleanup will skip clearTimeout(timeoutHandle).
          realSetTimeout(callback, 1, ...args);
          return 0;
        });

      try {
        const job = startJob({
          projectId: 1,
          type: 'test',
          command: 'npm',
          args: ['test'],
          cwd: '/project'
        });

        const promise = waitForJobCompletion(job.id, { timeoutMs: Number.NaN });

        mockChild.emit('exit', 0, null);

        const completed = await promise;
        expect(completed.status).toBe(JOB_STATUS.SUCCEEDED);

        // Allow the forced timeout callback to run; it should not affect the settled promise.
        await new Promise((resolve) => realSetTimeout(resolve, 10));
      } finally {
        setTimeoutSpy.mockRestore();
      }
    });

    it('resolves from timeout handler when job is terminal but update listeners are missing', async () => {
      vi.useFakeTimers();
      try {
        const job = startJob({
          projectId: 1,
          type: 'test',
          command: 'npm',
          args: ['test'],
          cwd: '/project'
        });

        const promise = waitForJobCompletion(job.id, { timeoutMs: 10 });

        // Remove the waitForJobCompletion listener so the promise is not settled via onUpdate.
        jobEvents.removeAllListeners('job:updated');

        // Mark the job terminal without notifying the waiter.
        mockChild.emit('exit', 0, null);

        await vi.advanceTimersByTimeAsync(11);

        const completed = await promise;
        expect(completed.status).toBe(JOB_STATUS.SUCCEEDED);
      } finally {
        vi.useRealTimers();
      }
    });

    it('rejects when the job does not exist', async () => {
      await expect(waitForJobCompletion('missing-job', { timeoutMs: 50 })).rejects.toThrow('Job not found');
    });

    it('rejects on timeout if the job never completes', async () => {
      const job = startJob({
        projectId: 1,
        type: 'test',
        command: 'npm',
        args: ['test'],
        cwd: '/project'
      });

      await expect(waitForJobCompletion(job.id, { timeoutMs: 25 })).rejects.toThrow(
        /Timed out waiting for job completion/i
      );
    });
  });

  describe('getJob', () => {
    it('returns null for non-existent job', () => {
      expect(getJob('non-existent-id')).toBeNull();
    });

    it('returns job by id', () => {
      const job = startJob({
        projectId: 1,
        type: 'build',
        command: 'npm',
        cwd: '/path'
      });

      const retrieved = getJob(job.id);
      expect(retrieved).toEqual(job);
    });

    it('returns a copy without process object', () => {
      const job = startJob({
        projectId: 1,
        type: 'build',
        command: 'npm',
        cwd: '/path'
      });

      const retrieved = getJob(job.id);
      expect(retrieved.process).toBeUndefined();
    });
  });

  describe('listJobsForProject', () => {
    it('returns empty array when no jobs exist', () => {
      expect(listJobsForProject(1)).toEqual([]);
    });

    it('filters jobs by project id', () => {
      const job1 = startJob({
        projectId: 1,
        type: 'build',
        command: 'npm',
        cwd: '/path1'
      });

      const job2 = startJob({
        projectId: 2,
        type: 'test',
        command: 'npm',
        cwd: '/path2'
      });

      const job3 = startJob({
        projectId: 1,
        type: 'lint',
        command: 'npm',
        cwd: '/path1'
      });

      const project1Jobs = listJobsForProject(1);
      expect(project1Jobs).toHaveLength(2);
      expect(project1Jobs.map(j => j.id)).toContain(job1.id);
      expect(project1Jobs.map(j => j.id)).toContain(job3.id);
      expect(project1Jobs.map(j => j.id)).not.toContain(job2.id);
    });

    it('normalizes project id to number', () => {
      const job = startJob({
        projectId: 42,
        type: 'build',
        command: 'npm',
        cwd: '/path'
      });

      expect(listJobsForProject('42')).toHaveLength(1);
      expect(listJobsForProject(42)).toHaveLength(1);
    });
  });

  describe('getAllJobs', () => {
    it('returns empty array when no jobs exist', () => {
      expect(getAllJobs()).toEqual([]);
    });

    it('returns all jobs', () => {
      const job1 = startJob({
        projectId: 1,
        type: 'build',
        command: 'npm',
        cwd: '/path1'
      });

      const job2 = startJob({
        projectId: 2,
        type: 'test',
        command: 'npm',
        cwd: '/path2'
      });

      const allJobs = getAllJobs();
      expect(allJobs).toHaveLength(2);
      expect(allJobs.map(j => j.id)).toContain(job1.id);
      expect(allJobs.map(j => j.id)).toContain(job2.id);
    });
  });

  describe('cancelJob', () => {
    it('returns null for non-existent job', () => {
      expect(cancelJob('non-existent-id')).toBeNull();
    });

    it('terminatePid uses process.kill on non-windows platforms', () => {
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {});
      const spawnSpy = vi.fn();

      __testing.terminatePid(1234, 'linux', { spawn: spawnSpy, kill: process.kill });

      expect(killSpy).toHaveBeenCalledWith(1234, 'SIGTERM');
      expect(spawnSpy).not.toHaveBeenCalled();
      killSpy.mockRestore();
    });

    it('terminatePid is a no-op when pid is missing', () => {
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {});
      const spawnSpy = vi.fn();

      __testing.terminatePid(null, 'linux', { spawn: spawnSpy, kill: process.kill });

      expect(killSpy).not.toHaveBeenCalled();
      expect(spawnSpy).not.toHaveBeenCalled();
      killSpy.mockRestore();
    });

    it('swallows jobEvents listener failures for updated emissions', () => {
      const job = startJob({
        projectId: 1,
        type: 'build',
        command: 'npm',
        cwd: '/path'
      });

      jobEvents.on('job:updated', () => {
        throw new Error('listener boom');
      });

      expect(() => cancelJob(job.id)).not.toThrow();
    });

    it('returns job unchanged if already succeeded', async () => {
      const job = startJob({
        projectId: 1,
        type: 'build',
        command: 'npm',
        cwd: '/path'
      });

      mockChild.emit('exit', 0, null);

      await waitFor(() => {
        const cancelledJob = cancelJob(job.id);
        expect(cancelledJob.status).toBe(JOB_STATUS.SUCCEEDED);
      });
    });

    it('returns job unchanged if already failed', async () => {
      const job = startJob({
        projectId: 1,
        type: 'build',
        command: 'npm',
        cwd: '/path'
      });

      mockChild.emit('exit', 1, null);

      await waitFor(() => {
        const cancelledJob = cancelJob(job.id);
        expect(cancelledJob.status).toBe(JOB_STATUS.FAILED);
      });
    });

    it('marks running job as cancelled', () => {
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {});

      const job = startJob({
        projectId: 1,
        type: 'build',
        command: 'npm',
        cwd: '/path'
      });

      const cancelledJob = cancelJob(job.id);

      expect(cancelledJob.status).toBe(JOB_STATUS.CANCELLED);
      expect(cancelledJob.completedAt).toBeDefined();

      if (isWindows) {
        const taskkillCalls = spawn.mock.calls.filter(([cmd]) => cmd === 'taskkill');
        expect(taskkillCalls.length).toBe(1);
        expect(taskkillCalls[0][1]).toEqual(['/PID', String(mockChild.pid), '/T', '/F']);
      } else {
        expect(killSpy).toHaveBeenCalledWith(mockChild.pid, 'SIGTERM');
      }

      killSpy.mockRestore();
    });

    it('does not overwrite cancelled jobs when the process exits later', async () => {
      const job = startJob({
        projectId: 1,
        type: 'build',
        command: 'npm',
        cwd: '/path'
      });

      cancelJob(job.id);

      // Simulate the child process eventually exiting successfully.
      mockChild.emit('exit', 0, null);

      await waitFor(() => {
        const updated = getJob(job.id);
        expect(updated.status).toBe(JOB_STATUS.CANCELLED);
      });
    });

    it('handles kill errors gracefully', async () => {
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw new Error('No such process');
      });

      if (isWindows) {
        spawn.mockImplementation((cmd, args) => {
          if (cmd === 'taskkill') {
            throw new Error('No such process');
          }
          return mockChild;
        });
      }

      const job = startJob({
        projectId: 1,
        type: 'build',
        command: 'npm',
        cwd: '/path'
      });

      const cancelledJob = cancelJob(job.id);

      expect(cancelledJob.status).toBe(JOB_STATUS.CANCELLED);

      await waitFor(() => {
        const updatedJob = getJob(job.id);
        expect(updatedJob.logs.some(log => log.message.includes('No such process'))).toBe(true);
        killSpy.mockRestore();
      });
    });

    it('does not attempt to kill if process has no pid', () => {
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {});
      mockChild.pid = null;

      const job = startJob({
        projectId: 1,
        type: 'build',
        command: 'npm',
        cwd: '/path'
      });

      cancelJob(job.id);

      expect(killSpy).not.toHaveBeenCalled();

      if (isWindows) {
        const taskkillCalls = spawn.mock.calls.filter(([cmd]) => cmd === 'taskkill');
        expect(taskkillCalls.length).toBe(0);
      }
      killSpy.mockRestore();
    });

    it('returns job unchanged if already cancelled', () => {
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {});

      const job = startJob({
        projectId: 1,
        type: 'build',
        command: 'npm',
        cwd: '/path'
      });

      cancelJob(job.id);
      const secondCancel = cancelJob(job.id);

      expect(secondCancel.status).toBe(JOB_STATUS.CANCELLED);

      if (isWindows) {
        const taskkillCalls = spawn.mock.calls.filter(([cmd]) => cmd === 'taskkill');
        expect(taskkillCalls.length).toBe(1);
      } else {
        // Kill should only be called once
        expect(killSpy).toHaveBeenCalledTimes(1);
      }

      killSpy.mockRestore();
    });
  });
});
