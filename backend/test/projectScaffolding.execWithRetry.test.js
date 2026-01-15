import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('projectScaffolding retry helpers', () => {
  let helpers;

  beforeEach(async () => {
    vi.restoreAllMocks();
    const mod = await import('../services/projectScaffolding.js');
    helpers = mod.__testing;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('looksLikeWindowsLock returns false on non-win platforms', () => {
    const error = new Error('EBUSY: resource busy');
    expect(helpers.looksLikeWindowsLock(error, 'linux')).toBe(false);
  });

  it('execWithRetry retries windows-lock errors and eventually succeeds', async () => {
    const execFn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('EBUSY: locked'), { stderr: 'EBUSY' }))
      .mockResolvedValueOnce({ stdout: 'ok' });

    const result = await helpers.execWithRetry(execFn, 'npm install', { cwd: 'C:/tmp' }, {
      maxBuffer: 1,
      platform: 'win32',
      delays: [1],
      sleepFn: vi.fn().mockResolvedValue()
    });

    expect(result).toEqual({ stdout: 'ok' });
    expect(execFn).toHaveBeenCalledTimes(2);
  });

  it('execWithRetry rethrows immediately for non-lock errors', async () => {
    const execFn = vi.fn().mockRejectedValueOnce(new Error('network down'));

    await expect(
      helpers.execWithRetry(execFn, 'npm install', { cwd: 'C:/tmp' }, {
        maxBuffer: 1,
        platform: 'win32',
        delays: [1, 2],
        sleepFn: vi.fn().mockResolvedValue()
      })
    ).rejects.toThrow(/network down/i);

    expect(execFn).toHaveBeenCalledTimes(1);
  });

  it('execWithRetry stops retrying when a retry error is non-lock', async () => {
    const execFn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('EPERM: locked'), { stderr: 'EPERM' }))
      .mockRejectedValueOnce(new Error('something else'));

    await expect(
      helpers.execWithRetry(execFn, 'npm install', { cwd: 'C:/tmp' }, {
        maxBuffer: 1,
        platform: 'win32',
        delays: [1, 2, 3],
        sleepFn: vi.fn().mockResolvedValue()
      })
    ).rejects.toThrow(/something else/i);

    expect(execFn).toHaveBeenCalledTimes(2);
  });

  it('buildExecErrorTail returns a newline-prefixed tail for stderr/stdout output', () => {
    const stderrLines = Array.from({ length: 45 }, (_, idx) => `stderr-${idx + 1}`).join('\n');
    const stdoutLines = Array.from({ length: 10 }, (_, idx) => `stdout-${idx + 1}`).join('\n');
    const tail = helpers.buildExecErrorTail({ stderr: stderrLines, stdout: stdoutLines });

    expect(tail.startsWith('\n')).toBe(true);
    expect(tail).toContain('stderr-45');
    expect(tail).toContain('stdout-10');
  });
});
