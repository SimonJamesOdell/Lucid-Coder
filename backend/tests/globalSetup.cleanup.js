import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const deleteFileWithRetries = async (filePath, { retries = 50, delayMs = 100 } = {}) => {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      return;
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return;
      }
      lastError = error;
      await sleep(delayMs);
    }
  }

  if (lastError) {
    // Use stderr directly in case tests mock console.
    process.stderr.write(`Warning: Unable to remove test database: ${filePath} (${lastError.message})\n`);
  }
};

const deleteDirWithRetries = async (dirPath, { retries = 50, delayMs = 100 } = {}) => {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
      }
      return;
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return;
      }
      lastError = error;
      await sleep(delayMs);
    }
  }

  if (lastError) {
    process.stderr.write(`Warning: Unable to remove test runtime dir: ${dirPath} (${lastError.message})\n`);
  }
};

const cleanupDir = async (root) => {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return; // directory doesn't exist or inaccessible
  }
  return entries;
};

const cleanupWorkerArtifacts = async () => {
  const backendRoot = path.join(__dirname, '..');

  const entries = fs.readdirSync(backendRoot, { withFileTypes: true });

  const workerDbFiles = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        /^test-lucidcoder\.worker-[\w-]+\.db(?:-journal|-wal|-shm)?$/i.test(entry.name)
    )
    .map((entry) => path.join(backendRoot, entry.name));

  const workerProjectDirs = entries
    .filter((entry) => entry.isDirectory() && /^test-runtime-projects\.worker-[\w-]+$/i.test(entry.name))
    .map((entry) => path.join(backendRoot, entry.name));

  for (const dbFile of workerDbFiles) {
    await deleteFileWithRetries(dbFile);
  }

  for (const dirPath of workerProjectDirs) {
    await deleteDirWithRetries(dirPath);
  }

  // Best-effort cleanup of test-created temp dirs under backend root.
  // These are created by various route/integration tests via process.cwd().
  const knownTempDirNames = new Set([
    'test-projects',
    'test-projects-api',
    'test-project-files',
    'test-project-filter',
    'test-file-content',
    'test-missing-file',
    'test-security',
    'test-runtime-projects',
    'virtual-project',
    'virtual-tree',
    'external-project'
  ]);

  const tempDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter(
      (name) =>
        knownTempDirNames.has(name) ||
        /^integration-project-/i.test(name) ||
        /^test-project-diff(?:-content|-resolved)?-/i.test(name) ||
        /^test-project-files-ops-/i.test(name) ||
        /^outside-(?:coverage-)?\d+$/i.test(name)
    )
    .map((name) => path.join(backendRoot, name));

  for (const dirPath of tempDirs) {
    await deleteDirWithRetries(dirPath);
  }

  if (process.env.LUCIDCODER_WRITE_DEBUG_ARTIFACTS !== '1') {
    await deleteFileWithRetries(path.join(backendRoot, 'process-status-debug.json'));
    await deleteFileWithRetries(path.join(backendRoot, 'running-processes-debug.json'));
  }

  const tmpFiles = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) =>
      /^tmp-(?:agent|codeEditAgent|autopilotSessions|coverage-keys)(?:-[\w-]+)?\.txt$/i.test(name)
    )
    .map((name) => path.join(backendRoot, name));

  for (const filePath of tmpFiles) {
    await deleteFileWithRetries(filePath);
  }

  // Allow thread-mode test runs to perform fresh startup cleanup.
  await deleteFileWithRetries(path.join(backendRoot, '.vitest-threads-setup.lock'));

  // ── Workspace-root sweep ────────────────────────────────────────────
  // When vitest is launched from the workspace root (one level above backend/),
  // tests that resolve paths via process.cwd() will drop artifacts there instead
  // of under backend/. Run the same patterns against the workspace root.
  const workspaceRoot = path.join(backendRoot, '..');
  const rootEntries = await cleanupDir(workspaceRoot);
  if (rootEntries) {
    const rootTempDirs = rootEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter(
        (name) =>
          knownTempDirNames.has(name) ||
          /^test-runtime-projects\./i.test(name) ||
          /^integration-project-/i.test(name) ||
          /^test-project-diff(?:-content|-resolved)?-/i.test(name) ||
          /^test-project-files-ops-/i.test(name) ||
          /^outside-(?:coverage-)?\d+$/i.test(name)
      )
      .map((name) => path.join(workspaceRoot, name));

    for (const dirPath of rootTempDirs) {
      await deleteDirWithRetries(dirPath);
    }
  }
};

export default async function globalSetupCleanup() {
  // No-op on setup; return teardown for after the run.
  return async () => {
    // Give worker threads a beat to fully release sqlite handles (Windows).
    await sleep(50);
    await cleanupWorkerArtifacts();
  };
}
