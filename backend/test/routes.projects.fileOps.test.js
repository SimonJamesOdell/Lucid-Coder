import { describe, expect, test, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';

import {
  copyDirectoryRecursive,
  cleanupExistingImportTarget,
  prepareImportTargetPath,
  copyProjectFilesWithFallback
} from '../routes/projects/fileOps.js';

describe('projects fileOps helpers', () => {
  test('copyDirectoryRecursive copies files and skips node_modules by default', async () => {
    const base = path.resolve(process.cwd(), 'test-runtime-projects', `fileops-test-${Date.now()}`);
    const source = path.join(base, 'source');
    const target = path.join(base, 'target');

    await fs.mkdir(path.join(source, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(source, 'keep.txt'), 'ok', 'utf8');
    await fs.writeFile(path.join(source, 'node_modules', 'skip.txt'), 'skip', 'utf8');

    await copyDirectoryRecursive(source, target);

    const copied = await fs.readFile(path.join(target, 'keep.txt'), 'utf8');
    expect(copied).toBe('ok');
    await expect(fs.stat(path.join(target, 'node_modules', 'skip.txt'))).rejects.toMatchObject({ code: 'ENOENT' });

    await fs.rm(base, { recursive: true, force: true });
  });

  test('cleanupExistingImportTarget returns false for invalid target', async () => {
    await expect(cleanupExistingImportTarget('')).resolves.toBe(false);
  });

  test('prepareImportTargetPath creates parent and resolves according to target state', async () => {
    const mkdirFn = vi.fn(async () => {});
    const missingPathExistsFn = vi.fn(async () => false);
    await expect(prepareImportTargetPath('C:/tmp/proj', {
      mkdirFn,
      pathExistsFn: missingPathExistsFn
    })).resolves.toBe(true);

    const presentPathExistsFn = vi.fn(async () => true);
    const cleanupFn = vi.fn(async () => false);
    await expect(prepareImportTargetPath('C:/tmp/proj', {
      mkdirFn,
      pathExistsFn: presentPathExistsFn,
      cleanupExistingImportTargetFn: cleanupFn
    })).resolves.toBe(false);

    expect(mkdirFn).toHaveBeenCalled();
    expect(cleanupFn).toHaveBeenCalledWith('C:/tmp/proj');
  });

  test('prepareImportTargetPath throws when pathExistsFn is not provided', async () => {
    await expect(prepareImportTargetPath('C:/tmp/proj', {
      mkdirFn: async () => {}
    })).rejects.toThrow('pathExistsFn is required');
  });

  test('copyProjectFilesWithFallback falls back to recursive copy and normalizes failures', async () => {
    const cpFn = vi.fn(async () => {
      throw new Error('cp failed');
    });
    const copyDirectoryRecursiveFn = vi.fn(async () => {});
    await expect(copyProjectFilesWithFallback('src', 'dest', {
      cpFn,
      copyDirectoryRecursiveFn
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'UNKNOWN',
      failedPath: null
    });

    const cpFailWithCodeFn = vi.fn(async () => {
      const error = new Error('cp failed');
      error.code = 'EACCES';
      throw error;
    });
    const fallbackFailFn = vi.fn(async (_source, _target, options = {}) => {
      const recursiveError = new Error('recursive failed');
      recursiveError.code = 'EPERM';
      options.onFileError?.(recursiveError, 'src/file.txt');
      throw recursiveError;
    });

    await expect(copyProjectFilesWithFallback('src', 'dest', {
      cpFn: cpFailWithCodeFn,
      copyDirectoryRecursiveFn: fallbackFailFn
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'EPERM',
      failedPath: 'src/file.txt'
    });
  });
});
