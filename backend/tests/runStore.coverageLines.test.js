import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

import { initializeDatabase } from '../database.js';
import {
  __testing,
  createRun,
  updateRun,
  appendRunEvent,
  getRun,
  listRunsForProject,
  listRunEvents
} from '../services/runStore.js';

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

describe('runStore remaining coverage lines', () => {
  beforeEach(async () => {
    await initializeDatabase();
    await resetTables();
  });

  afterEach(async () => {
    await resetTables();
  });

  it('exercises run/all success paths, normalizers, default limits, and message coercion', async () => {
    // Create a run with no projectId to exercise projectId ?? null
    const created = await createRun({
      kind: 'job',
      status: 'pending',
      sessionId: 'coverage-lines'
    });

    expect(created).toMatchObject({
      kind: 'job',
      status: 'pending',
      projectId: null,
      sessionId: 'coverage-lines'
    });

    // Touch updateRun to ensure run wrapper success executes with changes/lastID.
    const updated = await updateRun(created.id, { status: 'running' });
    expect(updated.status).toBe('running');

    // appendRunEvent with non-string message to exercise String(...) conversion.
    const event = await appendRunEvent(created.id, {
      type: 'log',
      message: { hello: 'world' },
      payload: { ok: true }
    });
    expect(event.message).toBe('[object Object]');

    // Force NULL message in DB to exercise normalizeEventRow message fallback (row.message ?? '').
    await __testing.run('UPDATE run_events SET message = NULL WHERE id = ?', [event.id]);

    const events = await listRunEvents(created.id, { limit: -1 });
    expect(events).toHaveLength(1);
    expect(events[0].message).toBe('');

    // listRunsForProject limit defaulting branch + all() success path.
    const runsForProject = await listRunsForProject(0, { limit: 0 });
    expect(Array.isArray(runsForProject)).toBe(true);

    // getRun normalization path (snake_case -> camelCase).
    const reloaded = await getRun(created.id);
    expect(reloaded).toMatchObject({
      id: created.id,
      createdAt: expect.any(String)
    });
  });
});
