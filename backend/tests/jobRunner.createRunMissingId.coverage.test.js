import { describe, it, expect, beforeEach, vi } from 'vitest';
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

describe('jobRunner createRun missing id coverage', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('covers startJob createRun missing id early-return (line 335)', async () => {
    const mockChild = new MockChildProcess();

    const runStorePath = fileURLToPath(new URL('../services/runStore.js', import.meta.url));

    vi.doMock('child_process', () => ({
      spawn: vi.fn(() => mockChild)
    }));

    vi.doMock(runStorePath, () => ({
      appendRunEvent: vi.fn(() => Promise.resolve()),
      updateRun: vi.fn(() => Promise.resolve()),
      createRun: vi.fn(() => Promise.resolve({}))
    }));

    const jobRunner = await import('../services/jobRunner.js');

    jobRunner.__testing.clearJobs();

    const job = jobRunner.startJob({
      projectId: 1,
      type: 'build',
      command: 'node',
      args: ['-e', 'console.log("hi")'],
      cwd: '/tmp'
    });

    await flushMicrotasks();

    const latest = jobRunner.getJob(job.id);
    expect(latest).toBeTruthy();
    expect(latest.runId).toBeNull();
  });
});
