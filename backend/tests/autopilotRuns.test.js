import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeDatabase } from '../database.js';
import { createAutopilotSession, __testing as autopilotTesting } from '../services/autopilotSessions.js';
import { getRunBySessionId, listRunEvents } from '../services/runStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbEnvPath = process.env.DATABASE_PATH || 'test-lucidcoder.db';
const dbPath = path.isAbsolute(dbEnvPath)
  ? dbEnvPath
  : path.join(__dirname, '..', dbEnvPath);

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

describe('autopilot sessions persist runs', () => {
  beforeEach(async () => {
    await initializeDatabase();
    await resetTables();
    autopilotTesting.reset();
  });

  afterEach(async () => {
    autopilotTesting.reset();
    await resetTables();
  });

  test('creates a run and mirrors events for a successful session', async () => {
    const now = new Date('2026-01-26T00:00:00.000Z');

    const session = await createAutopilotSession({
      projectId: 123,
      prompt: 'Do the thing',
      options: { dryRun: true },
      uiSessionId: 'ui-1',
      deps: {
        generateId: () => 'session-1',
        now: () => now,
        autopilot: async ({ deps }) => {
          deps.appendEvent({ type: 'plan', message: 'planning', payload: { steps: 1 } });
          return { ok: true };
        }
      }
    });

    expect(session).toMatchObject({
      id: 'session-1',
      projectId: 123,
      status: expect.any(String),
      runId: expect.any(Number)
    });

    await autopilotTesting.waitForSessionInternal('session-1', 2000);

    const runRecord = await getRunBySessionId('session-1');
    expect(runRecord).toMatchObject({
      projectId: 123,
      kind: 'autopilot',
      sessionId: 'session-1',
      status: 'completed'
    });

    const events = await listRunEvents(runRecord.id);
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((evt) => evt.type === 'session:created')).toBe(true);
    expect(events.some((evt) => evt.type === 'session:started')).toBe(true);
    expect(events.some((evt) => evt.type === 'plan')).toBe(true);
    expect(events.some((evt) => evt.type === 'session:completed')).toBe(true);
  });

  test('updates run status to cancelled when session is cancelled via error code', async () => {
    await createAutopilotSession({
      projectId: 321,
      prompt: 'Cancel it',
      deps: {
        generateId: () => 'session-2',
        autopilot: async () => {
          const error = new Error('User cancelled');
          error.code = 'AUTOPILOT_CANCELLED';
          throw error;
        }
      }
    });

    await autopilotTesting.waitForSessionInternal('session-2', 2000);

    const runRecord = await getRunBySessionId('session-2');
    expect(runRecord).toMatchObject({
      projectId: 321,
      kind: 'autopilot',
      sessionId: 'session-2',
      status: 'cancelled'
    });
  });
});
