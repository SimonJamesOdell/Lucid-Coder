import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isMainThread, threadId } from 'worker_threads';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Setup test environment
process.env.NODE_ENV = 'test';
process.env.PORT = '5001';
process.env.ENCRYPTION_KEY = 'test-32-character-key-for-testing';

// IMPORTANT:
// - Under Vitest "threads" pool, worker threads share a single process.env.
//   Do NOT set per-thread DATABASE_PATH/PROJECTS_DIR, or tests will flake.
// - Under "forks" pool, each worker is a separate process so per-process
//   isolation is safe and helps parallel performance.

const workerSuffix = isMainThread
  ? `worker-${process.pid}`
  : `threads-${process.pid}`;

const testDbPath = isMainThread
  ? path.join(__dirname, '..', `test-lucidcoder.${workerSuffix}.db`)
  : (process.env.DATABASE_PATH
    ? (path.isAbsolute(process.env.DATABASE_PATH)
      ? process.env.DATABASE_PATH
      : path.join(process.cwd(), process.env.DATABASE_PATH))
    : path.join(__dirname, '..', `test-lucidcoder.${workerSuffix}.db`));

const testProjectsDir = isMainThread
  ? path.join(__dirname, '..', `test-runtime-projects.${workerSuffix}`)
  : (process.env.PROJECTS_DIR
    ? (path.isAbsolute(process.env.PROJECTS_DIR)
      ? process.env.PROJECTS_DIR
      : path.join(process.cwd(), process.env.PROJECTS_DIR))
    : path.join(__dirname, '..', `test-runtime-projects.${workerSuffix}`));

process.env.DATABASE_PATH = testDbPath;
process.env.PROJECTS_DIR = testProjectsDir;


const sleepSync = (ms) => {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
};

const deleteFileWithRetriesSync = (filePath, { retries = 50, delayMs = 100 } = {}) => {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      return;
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      lastError = error;
      sleepSync(delayMs);
    }
  }

  if (lastError) {
    console.warn('Warning: Unable to remove test database before tests start:', lastError.message);
  }
};

const deleteDirWithRetriesSync = (dirPath, { retries = 50, delayMs = 100 } = {}) => {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
      }
      return;
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      lastError = error;
      sleepSync(delayMs);
    }
  }

  if (lastError) {
    console.warn('Warning: Unable to clean test projects directory before tests start:', lastError.message);
  }
};

const deleteSqliteSidecarsSync = (dbPath) => {
  deleteFileWithRetriesSync(dbPath);
  deleteFileWithRetriesSync(`${dbPath}-journal`);
  deleteFileWithRetriesSync(`${dbPath}-wal`);
  deleteFileWithRetriesSync(`${dbPath}-shm`);
};

const cleanupOnceForThreads = () => {
  const lockPath = path.join(__dirname, '..', '.vitest-threads-setup.lock');
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.closeSync(fd);
    deleteSqliteSidecarsSync(testDbPath);
    deleteDirWithRetriesSync(testProjectsDir);
  } catch (error) {
    // Another worker already did initial cleanup.
    if (error?.code !== 'EEXIST') {
      // Best-effort only.
    }
  }
};

if (isMainThread) {
  // Per-process isolated paths; safe to always clean.
  deleteSqliteSidecarsSync(testDbPath);
  deleteDirWithRetriesSync(testProjectsDir);
} else {
  // Shared process env paths; avoid concurrent delete races.
  cleanupOnceForThreads();
}

// Cleanup runs via tests/globalSetup.cleanup.js teardown.
