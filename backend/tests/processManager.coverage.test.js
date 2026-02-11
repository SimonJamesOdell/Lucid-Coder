import { describe, it, expect, vi } from 'vitest';

import * as processManager from '../routes/projects/processManager.js';

describe('process manager coverage', () => {
  it('logs when killProcessTree receives a protected pid', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await processManager.killProcessTree(process.pid);

    expect(warnSpy).toHaveBeenCalledWith(`⚠️ Skipping protected PID ${process.pid} (host process)`);
  });

  it('waitForPortsToFree retries when ports stay busy', async () => {
    const findPids = vi.fn().mockResolvedValue([99999]);
    const terminatePid = vi.fn().mockResolvedValue();

    await expect(
      processManager.__testOnly.waitForPortsToFree([6200], {
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
