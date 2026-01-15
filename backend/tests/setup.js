import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Setup test environment
process.env.NODE_ENV = 'test';
process.env.PORT = '5001';
process.env.ENCRYPTION_KEY = 'test-32-character-key-for-testing';

// Clean up test database before and after tests
const testDbPath = path.join(__dirname, '..', 'test-lucidcoder.db')
process.env.DATABASE_PATH = testDbPath

// Keep scaffolding output inside the backend folder when tests run
const testProjectsDir = path.join(__dirname, '..', 'test-runtime-projects')
process.env.PROJECTS_DIR = testProjectsDir


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


deleteSqliteSidecarsSync(testDbPath);
deleteDirWithRetriesSync(testProjectsDir);

// Cleanup runs via tests/globalSetup.cleanup.js teardown.