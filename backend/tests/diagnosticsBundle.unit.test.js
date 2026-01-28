import { describe, expect, test, vi } from 'vitest';
import os from 'os';
import db from '../database.js';
import { __diagnosticsTesting } from '../services/diagnosticsBundle.js';

const withPatchedMethod = async (obj, key, replacement, fn) => {
  const original = obj[key];
  try {
    obj[key] = replacement;
    return await fn();
  } finally {
    obj[key] = original;
  }
};

describe('diagnostics bundle helpers', () => {
  test('dbGet/dbAll reject when db returns an error', async () => {
    await withPatchedMethod(
      db,
      'get',
      (sql, params, cb) => {
        const callback = typeof params === 'function' ? params : cb;
        callback(new Error('db down'));
      },
      async () => {
        await expect(__diagnosticsTesting.dbGet('SELECT 1')).rejects.toThrow('db down');
      }
    );

    await withPatchedMethod(
      db,
      'all',
      (sql, params, cb) => {
        const callback = typeof params === 'function' ? params : cb;
        callback(new Error('db down'));
      },
      async () => {
        await expect(__diagnosticsTesting.dbAll('SELECT 1')).rejects.toThrow('db down');
      }
    );
  });

  test('parseJson returns null on invalid JSON', () => {
    expect(__diagnosticsTesting.parseJson(null)).toBeNull();
    expect(__diagnosticsTesting.parseJson({ ok: true })).toBeNull();
    expect(__diagnosticsTesting.parseJson('{bad')).toBeNull();
    expect(__diagnosticsTesting.parseJson('{"ok":true}')).toEqual({ ok: true });
  });

  test('getTableCount handles non-numeric row values', async () => {
    await withPatchedMethod(
      db,
      'get',
      (sql, params, cb) => {
        const callback = typeof params === 'function' ? params : cb;
        callback(null, { count: '7' });
      },
      async () => {
        const count = await __diagnosticsTesting.getTableCount('projects');
        expect(count).toBe(7);
      }
    );
  });

  test('dbGet/dbAll resolve with default fallbacks when row/rows are missing', async () => {
    await withPatchedMethod(
      db,
      'get',
      (sql, params, cb) => {
        const callback = typeof params === 'function' ? params : cb;
        callback(null, undefined);
      },
      async () => {
        await expect(__diagnosticsTesting.dbGet('SELECT 1')).resolves.toBeNull();
      }
    );

    await withPatchedMethod(
      db,
      'all',
      (sql, params, cb) => {
        const callback = typeof params === 'function' ? params : cb;
        callback(null, undefined);
      },
      async () => {
        await expect(__diagnosticsTesting.dbAll('SELECT 1')).resolves.toEqual([]);
      }
    );
  });

  test('getTableCount returns numeric counts when provided', async () => {
    await withPatchedMethod(
      db,
      'get',
      (sql, params, cb) => {
        const callback = typeof params === 'function' ? params : cb;
        callback(null, { count: 2 });
      },
      async () => {
        const count = await __diagnosticsTesting.getTableCount('projects');
        expect(count).toBe(2);
      }
    );
  });

  test('getTableCount returns 0 when count is missing', async () => {
    await withPatchedMethod(
      db,
      'get',
      (sql, params, cb) => {
        const callback = typeof params === 'function' ? params : cb;
        callback(null, {});
      },
      async () => {
        const count = await __diagnosticsTesting.getTableCount('projects');
        expect(count).toBe(0);
      }
    );
  });

  test('getDatabaseStats tolerates count failures (sets null)', async () => {
    await withPatchedMethod(
      db,
      'get',
      (sql, params, cb) => {
        const callback = typeof params === 'function' ? params : cb;
        if (/FROM projects/i.test(String(sql))) {
          callback(new Error('boom'));
          return;
        }
        callback(null, { count: 1 });
      },
      async () => {
        const stats = await __diagnosticsTesting.getDatabaseStats();
        expect(stats.counts.projects).toBeNull();
        expect(stats.counts.branches).toBe(1);
      }
    );
  });

  test('listRecentRunEvents and audit logs parse payload/meta JSON when possible', async () => {
    await withPatchedMethod(
      db,
      'all',
      (sql, params, cb) => {
        const callback = typeof params === 'function' ? params : cb;
        if (/FROM run_events/i.test(String(sql))) {
          callback(null, [{
            id: 1,
            run_id: 2,
            session_event_id: 'evt-1',
            timestamp: 't',
            type: 'log',
            level: 'info',
            source: 'unit',
            correlation_id: 'c',
            message: null,
            payload: null,
            meta: '{"ok":true}',
            created_at: 'c'
          }]);
          return;
        }

        if (/FROM audit_logs/i.test(String(sql))) {
          callback(null, [{
            id: 9,
            source: 'http',
            event_type: 'http_request',
            method: 'POST',
            path: '/api/x',
            status_code: 200,
            project_id: 5,
            session_id: 'sess-1',
            payload: '{"durationMs":1}',
            created_at: 'c'
          }]);
          return;
        }

        callback(null, []);
      },
      async () => {
        const events = await __diagnosticsTesting.listRecentRunEvents(0);
        expect(events).toEqual([
          expect.objectContaining({
            sessionEventId: 'evt-1',
            level: 'info',
            source: 'unit',
            message: '',
            payload: null,
            meta: { ok: true }
          })
        ]);

        const audits = await __diagnosticsTesting.listRecentAuditLogs(0);
        expect(audits).toEqual([
          expect.objectContaining({ projectId: 5, sessionId: 'sess-1', payload: { durationMs: 1 } })
        ]);
      }
    );
  });

  test('getSafeEnvSnapshot includes optional keys when set', () => {
    const priorSocket = process.env.ENABLE_SOCKET_IO;
    const priorSkip = process.env.E2E_SKIP_SCAFFOLDING;
    try {
      process.env.ENABLE_SOCKET_IO = 'false';
      process.env.E2E_SKIP_SCAFFOLDING = 'true';

      const snapshot = __diagnosticsTesting.getSafeEnvSnapshot();
      expect(snapshot.values.ENABLE_SOCKET_IO).toBe('false');
      expect(snapshot.values.E2E_SKIP_SCAFFOLDING).toBe('true');
    } finally {
      if (priorSocket === undefined) delete process.env.ENABLE_SOCKET_IO;
      else process.env.ENABLE_SOCKET_IO = priorSocket;

      if (priorSkip === undefined) delete process.env.E2E_SKIP_SCAFFOLDING;
      else process.env.E2E_SKIP_SCAFFOLDING = priorSkip;
    }
  });

  test('getDatabaseStats falls back to null databasePath when env is missing', async () => {
    const prior = process.env.DATABASE_PATH;
    try {
      delete process.env.DATABASE_PATH;
      const stats = await __diagnosticsTesting.getDatabaseStats();
      expect(stats.databasePath).toBeNull();
    } finally {
      if (prior !== undefined) {
        process.env.DATABASE_PATH = prior;
      }
    }
  });

  test('listRecentAuditLogs falls back to raw payload string or null', async () => {
    await withPatchedMethod(
      db,
      'all',
      (sql, params, cb) => {
        const callback = typeof params === 'function' ? params : cb;
        callback(null, [
          {
            id: 1,
            source: 'http',
            event_type: 'http_request',
            method: 'POST',
            path: '/api/x',
            status_code: 200,
            project_id: null,
            session_id: null,
            payload: '{bad}',
            created_at: 'c'
          },
          {
            id: 2,
            source: 'http',
            event_type: 'http_request',
            method: 'POST',
            path: '/api/y',
            status_code: 200,
            project_id: null,
            session_id: null,
            payload: null,
            created_at: 'c'
          }
        ]);
      },
      async () => {
        const audits = await __diagnosticsTesting.listRecentAuditLogs(2);
        expect(audits[0].payload).toBe('{bad}');
        expect(audits[1].payload).toBeNull();
      }
    );
  });

  test('listRecentRunEvents covers nullish fallbacks and createdAt null', async () => {
    await withPatchedMethod(
      db,
      'all',
      (sql, params, cb) => {
        const callback = typeof params === 'function' ? params : cb;
        callback(null, [
          {
            id: 1,
            run_id: 2,
            timestamp: 't',
            type: 'log',
            // session_event_id, level, source, correlation_id intentionally missing
            // message intentionally missing
            payload: '{"x":1}',
            meta: '{bad',
            created_at: null
          }
        ]);
      },
      async () => {
        const events = await __diagnosticsTesting.listRecentRunEvents(1);
        expect(events).toEqual([
          expect.objectContaining({
            sessionEventId: null,
            level: null,
            source: null,
            correlationId: null,
            message: '',
            payload: { x: 1 },
            meta: null,
            createdAt: null
          })
        ]);
      }
    );
  });

  test('listRecentAuditLogs covers createdAt null and undefined payload', async () => {
    await withPatchedMethod(
      db,
      'all',
      (sql, params, cb) => {
        const callback = typeof params === 'function' ? params : cb;
        callback(null, [
          {
            id: 3,
            source: 'http',
            event_type: 'http_request',
            method: 'GET',
            path: '/api/z',
            status_code: 200,
            project_id: undefined,
            session_id: undefined,
            payload: undefined,
            created_at: undefined
          }
        ]);
      },
      async () => {
        const audits = await __diagnosticsTesting.listRecentAuditLogs(1);
        expect(audits).toEqual([
          expect.objectContaining({
            projectId: null,
            sessionId: null,
            payload: null,
            createdAt: null
          })
        ]);
      }
    );
  });

  test('getEnvironmentInfo reports null cpus when unavailable', () => {
    const spy = vi.spyOn(os, 'cpus').mockReturnValue(undefined);
    try {
      const info = __diagnosticsTesting.getEnvironmentInfo();
      expect(info.cpus).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
