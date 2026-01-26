import { describe, test, expect, beforeEach, afterEach } from 'vitest';
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
  getRunBySessionId,
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

describe('runStore', () => {
  beforeEach(async () => {
    await initializeDatabase();
    await resetTables();
  });

  afterEach(async () => {
    await resetTables();
  });

  test('createRun validates kind and normalizes timestamps/metadata', async () => {
    await expect(createRun({})).rejects.toThrow(/kind is required/i);
    await expect(createRun({ kind: '   ' })).rejects.toThrow(/kind is required/i);

    const startedAt = '2026-01-26T00:00:00.000Z';
    const finishedAt = new Date('2026-01-26T00:01:00.000Z');

    const circular = {};
    circular.self = circular;

    const created = await createRun({
      projectId: 1,
      goalId: 2,
      kind: '  autopilot  ',
      status: 'pending',
      sessionId: 's-1',
      statusMessage: 'hi',
      metadata: circular,
      error: null,
      startedAt,
      finishedAt
    });

    expect(created).toMatchObject({
      projectId: 1,
      goalId: 2,
      kind: 'autopilot',
      status: 'pending',
      sessionId: 's-1',
      statusMessage: 'hi',
      metadata: null,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: finishedAt.toISOString()
    });
  });

  test('updateRun returns null when run does not exist and updates fields when it does', async () => {
    await expect(updateRun('nope', {})).rejects.toThrow(/runId is required/i);
    expect(await updateRun(999999, { status: 'completed' })).toBeNull();

    const created = await createRun({
      projectId: 10,
      kind: 'autopilot',
      metadata: { a: 1 }
    });

    const updated1 = await updateRun(created.id, { status: 'running' });
    expect(updated1).toMatchObject({
      id: created.id,
      status: 'running',
      metadata: { a: 1 }
    });

    const startedAt = new Date('2026-01-26T02:00:00.000Z');
    const updated2 = await updateRun(created.id, {
      startedAt,
      finishedAt: '2026-01-26T02:03:00.000Z',
      metadata: null
    });

    expect(updated2).toMatchObject({
      id: created.id,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date('2026-01-26T02:03:00.000Z').toISOString(),
      metadata: null
    });
  });

  test('appendRunEvent defaults type, normalizes message/timestamp, and parses payload/meta', async () => {
    await expect(appendRunEvent('nope', {})).rejects.toThrow(/runId is required/i);

    const created = await createRun({ projectId: 20, kind: 'autopilot', sessionId: 'sess-evt' });

    const circular = {};
    circular.self = circular;

    const event = await appendRunEvent(created.id, {
      id: 123,
      type: '   ',
      timestamp: new Date('2026-01-26T03:00:00.000Z'),
      message: { hello: 'world' },
      payload: { ok: true },
      meta: circular
    });

    expect(event).toMatchObject({
      runId: created.id,
      sessionEventId: '123',
      type: 'log',
      timestamp: new Date('2026-01-26T03:00:00.000Z').toISOString(),
      message: '[object Object]',
      payload: { ok: true },
      meta: null
    });

    // Force payload/meta edge cases (non-string, invalid JSON)
    // Use a BLOB so sqlite3 returns a Buffer (non-string), which parseJson should coerce to null.
    await __testing.run("UPDATE run_events SET payload = X'00', meta = 'not json' WHERE id = ?", [event.id]);
    const events = await listRunEvents(created.id, { limit: 1 });
    expect(events[0].payload).toBeNull();
    expect(events[0].meta).toBeNull();
  });

  test('getRun and getRunBySessionId validate and normalize', async () => {
    await expect(getRun('nope')).rejects.toThrow(/runId is required/i);
    expect(await getRun(123456789)).toBeNull();

    const created = await createRun({ projectId: 30, kind: 'autopilot', sessionId: 'trim-me' });

    expect(await getRunBySessionId(null)).toBeNull();
    expect(await getRunBySessionId('   ')).toBeNull();

    const found = await getRunBySessionId('  trim-me  ');
    expect(found).toMatchObject({ id: created.id, sessionId: 'trim-me' });
  });

  test('listRunsForProject and listRunEvents enforce ids and limits', async () => {
    await expect(listRunsForProject('nope')).rejects.toThrow(/projectId is required/i);
    await expect(listRunEvents('nope')).rejects.toThrow(/runId is required/i);

    await createRun({ projectId: 99, kind: 'autopilot', sessionId: 'a' });
    await createRun({ projectId: 99, kind: 'autopilot', sessionId: 'b' });

    const limited = await listRunsForProject(99, { limit: 1 });
    expect(limited).toHaveLength(1);
  });

  test('listRunEvents supports afterId pagination and type filtering', async () => {
    const created = await createRun({ projectId: 100, kind: 'autopilot', sessionId: 'evt-filter' });

    const evt1 = await appendRunEvent(created.id, { type: 'tool_call', message: 'one' });
    const evt2 = await appendRunEvent(created.id, { type: 'tool_result', message: 'two' });
    const evt3 = await appendRunEvent(created.id, { type: 'note', message: 'three' });

    const after = await listRunEvents(created.id, { afterId: evt1.id, limit: 500 });
    expect(after.map((e) => e.id)).toEqual([evt2.id, evt3.id]);

    const filtered = await listRunEvents(created.id, { types: 'tool_call, tool_result', limit: 500 });
    expect(filtered.map((e) => e.type)).toEqual(['tool_call', 'tool_result']);
  });

  test('listRunEvents option normalization covers branch edges', async () => {
    const created = await createRun({ projectId: 101, kind: 'job', sessionId: 'evt-edges' });
    const evt1 = await appendRunEvent(created.id, { type: 'note', message: 'one' });
    const evt2 = await appendRunEvent(created.id, { type: 'tool_call', message: 'two' });

    // afterId non-numeric -> ignored; limit <= 0 -> defaults to 500
    const defaulted = await listRunEvents(created.id, { afterId: 'nope', limit: 0, types: null });
    expect(defaulted.map((e) => e.id)).toEqual([evt1.id, evt2.id]);

    // afterId = 0 -> ignored (branch: normalizedAfterId not > 0)
    const ignoredAfterZero = await listRunEvents(created.id, { afterId: 0, limit: 500 });
    expect(ignoredAfterZero).toHaveLength(2);

    // types as array with trimming + non-string members -> filters to ['tool_call']
    const arrayTypes = await listRunEvents(created.id, { types: [' tool_call ', null, '   '], limit: 500 });
    expect(arrayTypes.map((e) => e.type)).toEqual(['tool_call']);
  });

  test('appendRunEvent accepts correlation_id fallback + trims level/source', async () => {
    const created = await createRun({ projectId: 102, kind: 'job', sessionId: 'evt-trace-fields' });

    const evt = await appendRunEvent(created.id, {
      type: 'tool_call',
      message: 'hi',
      level: '  info  ',
      source: '  jobRunner  ',
      correlation_id: '  corr-1  '
    });

    expect(evt).toMatchObject({
      type: 'tool_call',
      level: 'info',
      source: 'jobRunner',
      correlationId: 'corr-1'
    });

    const evt2 = await appendRunEvent(created.id, {
      type: 'tool_call',
      message: 'hi2',
      correlationId: 'corr-2'
    });
    expect(evt2.correlationId).toBe('corr-2');
  });

  test('__testing helpers cover JSON + ISO branches', () => {
    expect(__testing.parseJson(null)).toBeNull();
    expect(__testing.parseJson(123)).toBeNull();
    expect(__testing.parseJson('not json')).toBeNull();
    expect(__testing.parseJson('{"ok":true}')).toEqual({ ok: true });

    expect(__testing.toIsoOrNull(null)).toBeNull();
    expect(__testing.toIsoOrNull(new Date('2026-01-26T04:00:00.000Z'))).toBe('2026-01-26T04:00:00.000Z');
    expect(__testing.toIsoOrNull('2026-01-26T04:01:00.000Z')).toBe('2026-01-26T04:01:00.000Z');
    expect(__testing.toIsoOrNull({})).toBeNull();

    expect(__testing.serializeJson(undefined)).toBeNull();
    expect(__testing.serializeJson(null)).toBeNull();
    expect(__testing.serializeJson({ a: 1 })).toBe('{"a":1}');

    const circular = {};
    circular.self = circular;
    expect(__testing.serializeJson(circular)).toBeNull();

    expect(__testing.normalizeRunRow(null)).toBeNull();
    expect(__testing.normalizeEventRow(null)).toBeNull();
  });
});
