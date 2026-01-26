import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';

import { initializeDatabase } from '../database.js';
import { getRunBySessionId, listRunEvents } from '../services/runStore.js';
import { startJob, __testing as jobTesting } from '../services/jobRunner.js';
import { spawn } from 'child_process';

vi.mock('child_process', () => ({
  spawn: vi.fn()
}));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbEnvPath = process.env.DATABASE_PATH || 'test-lucidcoder.db';
const dbPath = path.isAbsolute(dbEnvPath)
  ? dbEnvPath
  : path.join(__dirname, '..', dbEnvPath);

class MockChildProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = Math.floor(Math.random() * 10000) + 1000;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }
}

const resetTables = () => {
  const client = new sqlite3.Database(dbPath);
  const tables = ['run_events', 'runs'];
  return new Promise((resolve, reject) => {
    client.serialize(() => {
      tables.reduce((promise, table) => (
        promise.then(() => new Promise((innerResolve, innerReject) => {
          client.run(`DELETE FROM ${table}`, (err) => {
            if (err && !/no such table/i.test(err.message)) {
              innerReject(err);
              return;
            }
            innerResolve();
          });
        }))
      ), Promise.resolve())
        .then(() => {
          client.close(() => resolve());
        })
        .catch((error) => {
          client.close(() => reject(error));
        });
    });
  });
};

const waitForAsync = async (assertions, { timeoutMs = 1500, intervalMs = 25 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await assertions();
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
};

describe('jobRunner persists runs', () => {
  let mockChild;

  beforeEach(async () => {
    mockChild = new MockChildProcess();
    spawn.mockReturnValue(mockChild);

    await initializeDatabase();
    await resetTables();

    jobTesting.clearJobs();
    jobTesting.resetJobEvents();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    jobTesting.clearJobs();
    jobTesting.resetJobEvents();
    await resetTables();
  });

  it('creates a run, mirrors logs as events, and completes the run', async () => {
    const job = startJob({
      projectId: 123,
      type: 'build',
      displayName: 'Build Project',
      command: 'node',
      args: ['-e', 'console.log("hi")'],
      cwd: '/project/path'
    });

    mockChild.stdout.emit('data', Buffer.from('Hello from job\n'));
    mockChild.emit('exit', 0, null);

    await waitForAsync(async () => {
      const run = await getRunBySessionId(job.id);
      expect(run).toBeTruthy();
      expect(run).toMatchObject({
        projectId: 123,
        kind: 'job',
        sessionId: job.id,
        status: 'completed'
      });

      const events = await listRunEvents(run.id);
      expect(events.some((evt) => evt.type === 'job:created')).toBe(true);
      expect(events.some((evt) => evt.type === 'job:log' && /Hello from job/.test(evt.message))).toBe(true);
      expect(events.some((evt) => evt.type === 'job:completed' && evt.payload?.status === 'completed')).toBe(true);
    });
  });
});
