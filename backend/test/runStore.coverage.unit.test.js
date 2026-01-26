import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fileURLToPath } from 'url';

// Unit-level coverage for a few small branches in runStore.js.
// We mock the sqlite db driver to deterministically hit wrapper branches.

describe('runStore coverage (unit)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('covers db wrapper branch edges + normalizer fallbacks + message coercion', async () => {
    let lastRunEventMessage = null;

    const dbMock = {
      run: vi.fn((sql, params, cb) => {
        // Force the run() wrapper to exercise the optional-chaining branch where
        // the sqlite callback isn't bound (so `this` is undefined).
        if (sql === 'TEST_RUN_UNBOUND_THIS') {
          cb(null);
          return;
        }

        // Capture the message used for run_events inserts to verify
        // appendRunEvent message coercion (String(...)) ran.
        if (typeof sql === 'string' && /INSERT\s+INTO\s+run_events/i.test(sql)) {
          // Params layout: [run_id, session_event_id, timestamp, type, message, payload, meta]
          lastRunEventMessage = params?.[4] ?? null;
        }

        // Default: ensure run() wrapper hits the success branch and resolves with lastID/changes.
        cb.call({ lastID: 1, changes: 1 }, null);
      }),
      get: vi.fn((sql, _params, cb) => {
        if (typeof sql === 'string' && /FROM\s+runs/i.test(sql)) {
          cb(null, {
            id: 1,
            project_id: null,
            goal_id: null,
            kind: 'job',
            status: 'pending',
            session_id: 's-1',
            status_message: null,
            metadata: null,
            error: null,
            created_at: '2026-01-26T00:00:00.000Z',
            started_at: null,
            finished_at: null
          });
          return;
        }

        if (typeof sql === 'string' && /FROM\s+run_events/i.test(sql)) {
          cb(null, {
            id: 1,
            run_id: 1,
            session_event_id: null,
            timestamp: '2026-01-26T00:00:01.000Z',
            type: 'log',
            message: null,
            payload: null,
            meta: null,
            created_at: '2026-01-26T00:00:02.000Z'
          });
          return;
        }

        cb(null, null);
      }),
      all: vi.fn((_sql, _params, cb) => {
        // Ensure all() wrapper hits resolve(rows || []) when rows is falsy.
        cb(null, null);
      })
    };

    const databasePath = fileURLToPath(new URL('../database.js', import.meta.url));
    vi.doMock(databasePath, () => ({ default: dbMock }));

    const runStore = await import('../services/runStore.js');

    // Branch coverage for line 8: callback `this` undefined + nullish fallbacks.
    const unbound = await runStore.__testing.run('TEST_RUN_UNBOUND_THIS');
    expect(unbound).toEqual({ lastID: null, changes: null });

    const created = await runStore.createRun({ kind: 'job', sessionId: 's-1' });
    expect(created.createdAt).toBe('2026-01-26T00:00:00.000Z');

    const runs = await runStore.listRunsForProject(1, { limit: 0 });
    expect(runs).toEqual([]);

    const evt = await runStore.appendRunEvent(1, { message: { hello: 'world' } });
    // normalizeEventRow fallback for null message
    expect(evt.message).toBe('');
    expect(evt.createdAt).toBe('2026-01-26T00:00:02.000Z');

    // appendRunEvent message coercion
    expect(lastRunEventMessage).toBe('[object Object]');

    // Branch coverage for line 213: event.message nullish fallback (String(event.message ?? '')).
    await runStore.appendRunEvent(1, { message: undefined });
    expect(lastRunEventMessage).toBe('');

    // Branch coverage for lines 88 / 107: created_at nullish fallbacks.
    const normalizedRunWithNoCreatedAt = runStore.__testing.normalizeRunRow({
      id: 2,
      project_id: null,
      goal_id: null,
      kind: 'job',
      status: 'pending',
      created_at: undefined
    });
    expect(normalizedRunWithNoCreatedAt.createdAt).toBeNull();

    const normalizedEventWithNoCreatedAt = runStore.__testing.normalizeEventRow({
      id: 2,
      run_id: 1,
      timestamp: '2026-01-26T00:00:03.000Z',
      type: 'log',
      created_at: undefined
    });
    expect(normalizedEventWithNoCreatedAt.createdAt).toBeNull();
  });
});
