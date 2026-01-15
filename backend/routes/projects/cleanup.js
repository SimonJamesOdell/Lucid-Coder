import path from 'path';
import { sanitizeProjectName, getProjectsDir } from '../../utils/projectPaths.js';
import { getPlatformImpl } from './processManager.js';

const getManagedRootSnapshot = () => {
  const managedRoot = path.resolve(getProjectsDir());
  const managedRootWithSep = managedRoot.endsWith(path.sep) ? managedRoot : `${managedRoot}${path.sep}`;
  const fsRoot = path.parse(managedRoot).root;
  return {
    managedRoot,
    managedRootWithSep,
    fsRoot
  };
};

const hasUnsafeCommandCharacters = (candidate = '') =>
  /[\"'\r\n\0]/.test(candidate);

const assertManagedProjectsRootSafe = () => {
  const { managedRoot, fsRoot } = getManagedRootSnapshot();
  if (!managedRoot || managedRoot === fsRoot) {
    const error = new Error(
      `Refusing destructive operations because managed projects root is unsafe: ${managedRoot}`
    );
    error.code = 'EUNSAFE_MANAGED_ROOT';
    throw error;
  }
};

const isWithinManagedProjectsRoot = (candidate) => {
  if (!candidate) {
    return false;
  }
  const { managedRoot, managedRootWithSep } = getManagedRootSnapshot();
  const resolved = path.resolve(candidate);
  if (resolved === managedRoot) {
    return false;
  }
  return resolved.startsWith(managedRootWithSep);
};

const assertSafeDeletionTarget = (candidate) => {
  assertManagedProjectsRootSafe();

  if (!candidate) {
    const error = new Error('Refusing to delete an empty path');
    error.code = 'EUNSAFE_DELETE_TARGET';
    throw error;
  }

  const resolved = path.resolve(candidate);
  if (!isWithinManagedProjectsRoot(resolved)) {
    const error = new Error(`Refusing to delete outside managed root: ${resolved}`);
    error.code = 'EUNSAFE_DELETE_TARGET';
    throw error;
  }

  if (hasUnsafeCommandCharacters(resolved)) {
    const error = new Error(`Refusing to delete path containing unsafe characters: ${resolved}`);
    error.code = 'EUNSAFE_DELETE_TARGET';
    throw error;
  }

  return resolved;
};

const addCleanupTarget = (collection, candidate) => {
  if (!candidate) {
    return false;
  }

  const resolved = path.resolve(candidate);
  if (!isWithinManagedProjectsRoot(resolved)) {
    return false;
  }

  if (hasUnsafeCommandCharacters(resolved)) {
    return false;
  }

  collection.add(resolved);
  return true;
};

const buildCleanupTargets = (project) => {
  const { managedRoot } = getManagedRootSnapshot();
  const targets = new Set();
  const safeProjectPath = project?.path ? path.resolve(project.path) : null;
  const sanitizedName = sanitizeProjectName(project?.name || '');
  const managedSlugPath = sanitizedName ? path.join(managedRoot, sanitizedName) : null;
  const addTarget = (candidate) => addCleanupTarget(targets, candidate);

  const projectIsManaged = safeProjectPath
    ? isWithinManagedProjectsRoot(safeProjectPath)
    : Boolean(sanitizedName);

  if (safeProjectPath && projectIsManaged) {
    addTarget(safeProjectPath);

    const parentDir = path.dirname(safeProjectPath);
    if (
      parentDir &&
      parentDir !== managedRoot &&
      sanitizedName &&
      path.basename(parentDir) === sanitizedName
    ) {
      addTarget(parentDir);
    }
  }

  if (managedSlugPath && projectIsManaged) {
    addTarget(managedSlugPath);

    const slugExtras = [
      'frontend',
      'backend',
      path.join('frontend', 'node_modules'),
      path.join('backend', 'node_modules'),
      '.gitignore',
      path.join('frontend', '.gitignore'),
      path.join('backend', '.gitignore')
    ];

    for (const extra of slugExtras) {
      addTarget(path.join(managedSlugPath, extra));
    }
  }

  return [...targets].sort((a, b) => b.length - a.length);
};

// Helper function for robust directory cleanup on Windows
async function cleanupDirectoryWithRetry(fs, dirPath, maxRetries = 5, delay = 1000) {
  const safeDirPath = assertSafeDeletionTarget(dirPath);
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // On Windows, try to make files writable first
      if (getPlatformImpl() === 'win32' && attempt > 1) {
        await makeDirectoryWritableExecutor(fs, safeDirPath);
      }

      await fs.rm(safeDirPath, { recursive: true, force: true });
      console.log(`✅ Directory cleanup succeeded on attempt ${attempt}: ${safeDirPath}`);
      return; // Success!
    } catch (error) {
      if (
        error.code === 'EBUSY' ||
        error.code === 'ENOTEMPTY' ||
        error.code === 'EPERM' ||
        error.code === 'EACCES'
      ) {
        console.log(
          `⚠️ Cleanup attempt ${attempt}/${maxRetries} failed: ${error.code}. Retrying in ${delay}ms...`
        );

        if (attempt < maxRetries) {
          // Wait before retrying with exponential backoff
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(delay * 1.5, 5000); // Cap at 5 seconds
        } else {
          // Final attempt failed, try alternative approach
          console.log('🔧 All standard cleanup attempts failed. Trying alternative cleanup...');
          await alternativeCleanupExecutor(fs, safeDirPath);
        }
      } else if (error.code === 'ENOENT') {
        // Directory doesn't exist - that's fine, consider it cleaned up
        console.log(`✅ Directory already removed: ${safeDirPath}`);
        return;
      } else {
        // Non-retryable error
        throw error;
      }
    }
  }
}

let cleanupDirectoryExecutor = cleanupDirectoryWithRetry;

const setCleanupDirectoryExecutor = (fn) => {
  cleanupDirectoryExecutor = typeof fn === 'function' ? fn : cleanupDirectoryWithRetry;
};

const resetCleanupDirectoryExecutor = () => setCleanupDirectoryExecutor();

let alternativeCleanupExecutor = alternativeCleanup;

const setAlternativeCleanupExecutor = (fn) => {
  alternativeCleanupExecutor = typeof fn === 'function' ? fn : alternativeCleanup;
};

const resetAlternativeCleanupExecutor = () => {
  alternativeCleanupExecutor = alternativeCleanup;
};

const getAlternativeCleanupExecutor = () => alternativeCleanupExecutor;

// Alternative cleanup for stubborn directories across all platforms
async function alternativeCleanup(fs, dirPath) {
  const safeDirPath = assertSafeDeletionTarget(dirPath);
  try {
    // First, try to make all files writable and remove read-only attributes
    console.log('🔧 Making directory writable...');
    await makeDirectoryWritableExecutor(fs, safeDirPath);

    // Try cleanup again after making files writable
    await fs.rm(safeDirPath, { recursive: true, force: true });
    console.log('✅ Alternative cleanup succeeded after making files writable');
    return;
  } catch (error) {
    console.log('📁 File attribute changes failed, trying other methods...');

    // Platform-specific cleanup commands
    const { execSync } = await import('child_process');

    if (getPlatformImpl() === 'win32') {
      try {
        console.log('💻 Trying Windows command line cleanup...');

        // Use cmd.exe with rmdir for Windows
        execSync(`rmdir /s /q "${safeDirPath}"`, {
          stdio: 'pipe',
          timeout: 30000,
          shell: 'cmd.exe'
        });

        console.log('✅ Windows command line cleanup succeeded');
        return;
      } catch (cmdError) {
        console.warn('⚠️ Windows cmd cleanup failed:', cmdError.message);

        // Try PowerShell as fallback on Windows
        try {
          console.log('💪 Trying PowerShell cleanup...');
          execSync(`powershell -Command "Remove-Item -Path '${safeDirPath}' -Recurse -Force"`, {
            stdio: 'pipe',
            timeout: 45000
          });

          console.log('✅ PowerShell cleanup succeeded');
          return;
        } catch (powershellError) {
          console.warn('⚠️ PowerShell cleanup also failed:', powershellError.message);
        }
      }
    } else {
      // Unix-like systems (Linux, macOS)
      try {
        console.log('🐧 Trying Unix rm command...');
        execSync(`rm -rf "${safeDirPath}"`, {
          stdio: 'pipe',
          timeout: 30000
        });

        console.log('✅ Unix rm cleanup succeeded');
        return;
      } catch (rmError) {
        console.warn('⚠️ Unix rm cleanup failed:', rmError.message);
      }
    }

    // If still failing, try manual recursive removal
    console.log('🔄 Trying manual recursive removal...');
    try {
      await manualRecursiveRemovalExecutor(fs, safeDirPath);
      console.log('✅ Manual recursive removal succeeded');
    } catch (manualError) {
      console.warn('❌ All cleanup methods failed:', manualError.message);
      throw new Error(`Failed to clean up directory ${safeDirPath}: ${manualError.message}`);
    }
  }
}

// Manual recursive removal as last resort
async function manualRecursiveRemoval(fs, dirPath) {
  const safeDirPath = assertSafeDeletionTarget(dirPath);
  try {
    const entries = await fs.readdir(safeDirPath, { withFileTypes: true });

    // Process all entries
    for (const entry of entries) {
      const fullPath = path.join(safeDirPath, entry.name);
      try {
        if (entry.isDirectory()) {
          await manualRecursiveRemoval(fs, fullPath);
        } else {
          // Make file writable and remove - cross-platform permissions
          try {
            const fileMode = 0o666;
            await fs.chmod(fullPath, fileMode);
          } catch (chmodError) {
            // Ignore chmod errors (may not be supported on all filesystems)
          }
          await fs.unlink(fullPath);
        }
      } catch (entryError) {
        console.warn(`⚠️ Could not remove ${fullPath}:`, entryError.message);
        // Continue with other files
      }
    }

    // Now try to remove the empty directory (with a small retry loop for Windows locks).
    try {
      const dirMode = 0o755;
      await fs.chmod(safeDirPath, dirMode);
    } catch (chmodError) {
      // Ignore chmod errors (may not be supported on all filesystems)
    }

    let delayMs = 100;
    for (let attempt = 1; attempt <= 8; attempt++) {
      try {
        await fs.rmdir(safeDirPath);
        break;
      } catch (removeError) {
        if (removeError?.code === 'ENOENT') {
          break;
        }
        if (
          removeError?.code === 'EBUSY' ||
          removeError?.code === 'ENOTEMPTY' ||
          removeError?.code === 'EPERM' ||
          removeError?.code === 'EACCES'
        ) {
          if (attempt === 8) {
            // As a final attempt, ask the platform rm implementation to retry as well.
            await fs.rm(safeDirPath, {
              recursive: true,
              force: true,
              maxRetries: 10,
              retryDelay: 200
            });
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          delayMs = Math.min(Math.round(delayMs * 1.5), 1000);
          continue;
        }
        throw removeError;
      }
    }
  } catch (readError) {
    if (readError.code === 'ENOENT') {
      // Directory already gone
      return;
    }
    throw readError;
  }
}

let manualRecursiveRemovalExecutor = manualRecursiveRemoval;

const setManualRecursiveRemovalExecutor = (fn) => {
  manualRecursiveRemovalExecutor = typeof fn === 'function' ? fn : manualRecursiveRemoval;
};

const resetManualRecursiveRemovalExecutor = () => {
  manualRecursiveRemovalExecutor = manualRecursiveRemoval;
};

const getManualRecursiveRemovalExecutor = () => manualRecursiveRemovalExecutor;

// Helper to make directory and contents writable (cross-platform)
async function makeDirectoryWritable(fs, dirPath) {
  const safeDirPath = (() => {
    try {
      return assertSafeDeletionTarget(dirPath);
    } catch (error) {
      // Permission changes should be best-effort; refuse unsafe targets silently.
      return null;
    }
  })();

  if (!safeDirPath) {
    return;
  }

  try {
    const stat = await fs.stat(safeDirPath);

    if (stat.isDirectory()) {
      // Make directory writable - use appropriate permissions for platform
      const dirMode = 0o755;
      await fs.chmod(safeDirPath, dirMode);

      // Recursively make contents writable
      const entries = await fs.readdir(safeDirPath);

      for (const entry of entries) {
        const fullPath = path.join(safeDirPath, entry);
        try {
          await makeDirectoryWritableExecutor(fs, fullPath);
        } catch (error) {
          // Continue with other files even if one fails
          console.warn(`Could not make ${fullPath} writable:`, error.message);
        }
      }
    } else {
      // Make file writable - use appropriate permissions for platform
      const fileMode = getPlatformImpl() === 'win32' ? 0o666 : 0o644;
      await fs.chmod(safeDirPath, fileMode);
    }
  } catch (error) {
    // Don't fail if we can't make files writable (chmod may not be supported on all filesystems)
    console.warn(`Could not make ${safeDirPath} writable:`, error.message);
  }
}

let makeDirectoryWritableExecutor = makeDirectoryWritable;

const setMakeDirectoryWritableExecutor = (fn) => {
  makeDirectoryWritableExecutor = typeof fn === 'function' ? fn : makeDirectoryWritable;
};

const resetMakeDirectoryWritableExecutor = () => {
  makeDirectoryWritableExecutor = makeDirectoryWritable;
};

const getMakeDirectoryWritableExecutor = () => makeDirectoryWritableExecutor;

export {
  hasUnsafeCommandCharacters,
  assertManagedProjectsRootSafe,
  assertSafeDeletionTarget,
  isWithinManagedProjectsRoot,
  addCleanupTarget,
  buildCleanupTargets,
  cleanupDirectoryWithRetry,
  cleanupDirectoryExecutor,
  setCleanupDirectoryExecutor,
  resetCleanupDirectoryExecutor,
  alternativeCleanup,
  alternativeCleanupExecutor,
  setAlternativeCleanupExecutor,
  resetAlternativeCleanupExecutor,
  getAlternativeCleanupExecutor,
  manualRecursiveRemoval,
  manualRecursiveRemovalExecutor,
  setManualRecursiveRemovalExecutor,
  resetManualRecursiveRemovalExecutor,
  getManualRecursiveRemovalExecutor,
  makeDirectoryWritable,
  makeDirectoryWritableExecutor,
  setMakeDirectoryWritableExecutor,
  resetMakeDirectoryWritableExecutor,
  getMakeDirectoryWritableExecutor
};
