import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let moduleUnderTest;
let processManager;
let processManagerTestOnly;

const loadModule = async () => {
  moduleUnderTest = await import('../routes/projects.js');
  processManager = moduleUnderTest.__processManager;
  const processManagerModule = await import('../routes/projects/processManager.js');
  processManagerTestOnly = processManagerModule.__testOnly;
};

describe('process manager host protection', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await loadModule();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips terminating the API host pid when freeing ports', async () => {
    const hostPid = process.pid;
    const otherPid = hostPid + 12345;

    const killSpy = vi.fn().mockResolvedValue();
    const listPids = vi.fn().mockResolvedValue([hostPid, otherPid]);

    await moduleUnderTest.killProcessesOnPort(4242, {
      listPids,
      terminatePid: killSpy
    });

    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(otherPid, { forceDelay: 250 });
  });

  it('exposes the host pid as protected', () => {
    expect(processManager.isProtectedPid(process.pid)).toBe(true);
  });

  it('skips reserved host ports when freeing ports', async () => {
    const killSpy = vi.fn().mockResolvedValue();

    await moduleUnderTest.__processManager.ensurePortsFreed([5173, 6200], { killFn: killSpy });

    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(6200);
  });

  it('treats port 3000 as a reserved host port by default', async () => {
    const killSpy = vi.fn().mockResolvedValue();

    await moduleUnderTest.__processManager.ensurePortsFreed([3000, 6200], { killFn: killSpy });

    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(6200);
  });

  it('does not mutate stored entry when key exists but isActiveEntry is false', async () => {
    const internals = moduleUnderTest.__projectRoutesInternals;

    internals.resetRunningProcessesStore();

    const storeSpy = vi.spyOn(internals, 'storeRunningProcesses');

    internals.storeRunningProcesses(
      'p1',
      {
        frontend: { pid: null, port: 1234 },
        backend: null
      },
      'stopped',
      { exposeSnapshot: true }
    );

    storeSpy.mockClear();

    const result = await internals.terminateRunningProcesses('p1', {
      project: { id: 'p1', name: 'p1' },
      dropEntry: false,
      ports: []
    });

    expect(result).toEqual({ wasRunning: false, freedPorts: [] });
    expect(storeSpy).not.toHaveBeenCalled();
  });

  it('covers waitForPidExit invalid pid guard', async () => {
    await expect(processManagerTestOnly.waitForPidExit('not-a-pid')).resolves.toBe(true);
  });

  it('returns false when terminatePidWithRetry sees a protected pid', async () => {
    await expect(processManagerTestOnly.terminatePidWithRetry(process.pid)).resolves.toBe(false);
  });

  it('covers waitForPortsToFree early return', async () => {
    await expect(processManagerTestOnly.waitForPortsToFree([null, undefined, 'x'])).resolves.toBe(true);
  });

  it('logs and returns when killProcessTree receives a protected pid', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await moduleUnderTest.killProcessTree(process.pid);

    expect(warnSpy).toHaveBeenCalledWith(`⚠️ Skipping protected PID ${process.pid} (host process)`);
  });

  it('waitForPortsToFree retries when ports stay busy', async () => {
    const findPids = vi.fn().mockResolvedValue([99999]);
    const terminatePid = vi.fn().mockResolvedValue();

    await expect(
      processManagerTestOnly.waitForPortsToFree([6200], {
        timeoutMs: 2,
        intervalMs: 1,
        findPids,
        terminatePid
      })
    ).resolves.toBe(false);

    expect(findPids).toHaveBeenCalled();
    expect(terminatePid).toHaveBeenCalled();
  });
});
