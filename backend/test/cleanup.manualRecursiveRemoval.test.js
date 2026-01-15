import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import { getProjectsDir } from '../utils/projectPaths.js';
import { manualRecursiveRemoval } from '../routes/projects/cleanup.js';

describe('projects cleanup manualRecursiveRemoval', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries rmdir failures and falls back to fs.rm on the final attempt', async () => {
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn) => {
      fn();
      return 0;
    });

    let rmdirCalls = 0;
    const fs = {
      readdir: vi.fn().mockResolvedValue([]),
      chmod: vi.fn().mockResolvedValue(),
      unlink: vi.fn().mockResolvedValue(),
      rmdir: vi.fn().mockImplementation(async () => {
        rmdirCalls += 1;
        const error = new Error('EBUSY: resource busy or locked');
        error.code = 'EBUSY';
        throw error;
      }),
      rm: vi.fn().mockResolvedValue()
    };

    const safeDir = path.join(getProjectsDir(), 'lucidcoder-manual-removal');
    await manualRecursiveRemoval(fs, safeDir);

    expect(rmdirCalls).toBe(8);
    expect(fs.rm).toHaveBeenCalledTimes(1);
    expect(fs.rm).toHaveBeenCalledWith(
      safeDir,
      expect.objectContaining({ recursive: true, force: true })
    );
  });

  it('stops retrying when the directory is already gone (ENOENT)', async () => {
    const safeDir = path.join(getProjectsDir(), 'lucidcoder-missing-dir');
    const fs = {
      readdir: vi.fn().mockResolvedValue([]),
      chmod: vi.fn().mockResolvedValue(),
      unlink: vi.fn().mockResolvedValue(),
      rmdir: vi.fn().mockImplementation(async () => {
        const error = new Error('ENOENT: no such file or directory');
        error.code = 'ENOENT';
        throw error;
      }),
      rm: vi.fn().mockResolvedValue()
    };

    await manualRecursiveRemoval(fs, safeDir);

    expect(fs.rmdir).toHaveBeenCalledTimes(1);
    expect(fs.rm).not.toHaveBeenCalled();
  });

  it('rethrows non-lock errors from rmdir', async () => {
    const safeDir = path.join(getProjectsDir(), 'lucidcoder-non-lock');
    const fs = {
      readdir: vi.fn().mockResolvedValue([]),
      chmod: vi.fn().mockResolvedValue(),
      unlink: vi.fn().mockResolvedValue(),
      rmdir: vi.fn().mockImplementation(async () => {
        const error = new Error('I/O failure');
        error.code = 'EIO';
        throw error;
      }),
      rm: vi.fn().mockResolvedValue()
    };

    await expect(manualRecursiveRemoval(fs, safeDir)).rejects.toMatchObject({
      code: 'EIO'
    });
    expect(fs.rm).not.toHaveBeenCalled();
  });
});
