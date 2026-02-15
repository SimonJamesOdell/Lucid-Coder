import fs from 'fs/promises';
import path from 'path';
import { isWithinManagedProjectsRoot } from './cleanup.js';

const normalizeCopyError = (error, failedPath = null) => {
  const code = error?.code || 'UNKNOWN';
  const message = error?.message || 'Unknown error';
  const wrappedMessage = failedPath
    ? `Failed to copy project files: ${code} ${message} (${failedPath})`
    : `Failed to copy project files: ${code} ${message}`;
  const wrapped = new Error(wrappedMessage);
  wrapped.statusCode = 400;
  wrapped.code = code;
  wrapped.failedPath = failedPath || null;
  return wrapped;
};

export const copyDirectoryRecursive = async (sourcePath, targetPath, options = {}) => {
  const {
    ignoreNodeModules = true,
    onFileError
  } = options;

  await fs.mkdir(targetPath, { recursive: true });
  const entries = await fs.readdir(sourcePath, { withFileTypes: true });

  for (const entry of entries) {
    if (ignoreNodeModules && entry.name === 'node_modules') {
      continue;
    }

    const sourceEntryPath = path.join(sourcePath, entry.name);
    const targetEntryPath = path.join(targetPath, entry.name);

    if (entry.isDirectory()) {
      await copyDirectoryRecursive(sourceEntryPath, targetEntryPath, options);
      continue;
    }

    if (entry.isSymbolicLink()) {
      try {
        const linkTarget = await fs.readlink(sourceEntryPath);
        await fs.symlink(linkTarget, targetEntryPath);
      } catch (error) {
        onFileError?.(error, sourceEntryPath);
        if (!onFileError) {
          throw error;
        }
      }
      continue;
    }

    try {
      await fs.copyFile(sourceEntryPath, targetEntryPath);
    } catch (error) {
      onFileError?.(error, sourceEntryPath);
      if (!onFileError) {
        throw error;
      }
    }
  }
};

export const cleanupExistingImportTarget = async (targetPath, { rmFn = fs.rm } = {}) => {
  if (!targetPath || typeof targetPath !== 'string') {
    return false;
  }

  if (!isWithinManagedProjectsRoot(targetPath)) {
    return false;
  }

  try {
    await rmFn(targetPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
};

export const prepareImportTargetPath = async (targetPath, {
  mkdirFn = fs.mkdir,
  pathExistsFn,
  cleanupExistingImportTargetFn = cleanupExistingImportTarget
} = {}) => {
  if (typeof pathExistsFn !== 'function') {
    throw new Error('pathExistsFn is required');
  }

  await mkdirFn(path.dirname(targetPath), { recursive: true });

  const exists = await pathExistsFn(targetPath);
  if (!exists) {
    return true;
  }

  return cleanupExistingImportTargetFn(targetPath);
};

export const copyProjectFilesWithFallback = async (sourcePath, targetPath, {
  cpFn = fs.cp,
  copyDirectoryRecursiveFn = copyDirectoryRecursive
} = {}) => {
  try {
    await cpFn(sourcePath, targetPath, { recursive: true, force: true });
    return;
  } catch (copyError) {
    let fallbackError = null;
    let failedPath = null;

    try {
      await copyDirectoryRecursiveFn(sourcePath, targetPath, {
        onFileError: (error, currentPath) => {
          if (!fallbackError && error) {
            fallbackError = error;
            failedPath = currentPath || null;
          }
        }
      });
    } catch (error) {
      if (!fallbackError) {
        fallbackError = error;
      }
      if (!failedPath && error?.failedPath) {
        failedPath = error.failedPath;
      }
    }

    throw normalizeCopyError(fallbackError || copyError, failedPath);
  }
};
