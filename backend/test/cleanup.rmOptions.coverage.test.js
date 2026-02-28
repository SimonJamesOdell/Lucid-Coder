import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import { getProjectsDir } from '../utils/projectPaths.js';

vi.mock('../routes/projects/processManager.js', () => ({
  getPlatformImpl: vi.fn(() => 'linux')
}));

describe('projects cleanup rm options coverage', () => {
  it('uses non-windows rm options when cleanupDirectoryWithRetry runs on non-win32 platform', async () => {
    const { cleanupDirectoryWithRetry } = await import('../routes/projects/cleanup.js');

    const fsStub = {
      rm: vi.fn().mockResolvedValue()
    };

    const safeDir = path.join(getProjectsDir(), 'lucidcoder-rm-options-linux');
    await cleanupDirectoryWithRetry(fsStub, safeDir, 1, 1);

    expect(fsStub.rm).toHaveBeenCalledWith(
      safeDir,
      expect.objectContaining({
        recursive: true,
        force: true
      })
    );

    const rmOptions = fsStub.rm.mock.calls[0][1] || {};
    expect(rmOptions).not.toHaveProperty('maxRetries');
    expect(rmOptions).not.toHaveProperty('retryDelay');
  });
});
