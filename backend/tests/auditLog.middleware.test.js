import express from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, afterAll, describe, expect, test } from 'vitest';
import db, { initializeDatabase } from '../database.js';
import { appendAuditLog, auditHttpRequestsMiddleware, __auditLogTesting } from '../services/auditLog.js';

describe('audit log middleware', () => {
  let app;

  beforeAll(async () => {
    await initializeDatabase();
  });

  beforeEach(async () => {
    app = express();
    app.use(express.json());
    app.use(auditHttpRequestsMiddleware());

    app.get('/api/health', (req, res) => res.json({ ok: true }));
    app.post('/api/health', (req, res) => res.json({ ok: true }));

    app.post('/api/non-project', (req, res) => {
      res.status(201).json({ ok: true });
    });

    app.post('/not-api', (req, res) => {
      res.status(201).json({ ok: true });
    });

    app.options('/api/non-project', (req, res) => {
      res.status(204).end();
    });

    app.post('/api/projects/:projectId/tests/run', (req, res) => {
      res.status(200).json({ success: true });
    });

    await __auditLogTesting.clearAll();
  });

  afterAll(async () => {
    // Intentionally do not close the shared sqlite handle.
    // Other backend tests in this suite expect it to remain open.
  });

  test('does not log GET /api/health requests', async () => {
    await request(app).get('/api/health').expect(200);

    await __auditLogTesting.waitForIdle();
    const rows = await __auditLogTesting.listLatest(5);
    expect(rows).toHaveLength(0);
  });

  test('does not log POST /api/health requests (health-specific filter)', async () => {
    await request(app).post('/api/health').send({ keep: true }).expect(200);

    await __auditLogTesting.waitForIdle();
    const rows = await __auditLogTesting.listLatest(5);
    expect(rows).toHaveLength(0);
  });

  test('does not log OPTIONS requests even under /api', async () => {
    await request(app).options('/api/non-project').expect(204);

    await __auditLogTesting.waitForIdle();
    const rows = await __auditLogTesting.listLatest(5);
    expect(rows).toHaveLength(0);
  });

  test('does not log HEAD requests', async () => {
    await request(app).head('/api/health').expect(200);

    await __auditLogTesting.waitForIdle();
    const rows = await __auditLogTesting.listLatest(5);
    expect(rows).toHaveLength(0);
  });

  test('does not log mutating non-/api requests', async () => {
    await request(app).post('/not-api').send({ token: 'secret' }).expect(201);

    await __auditLogTesting.waitForIdle();
    const rows = await __auditLogTesting.listLatest(5);
    expect(rows).toHaveLength(0);
  });

  test('logs mutating /api requests with status code and project id', async () => {
    await request(app)
      .post('/api/projects/5/tests/run?confirm=true')
      .send({ token: 'secret', keep: 'ok' })
      .expect(200);

    await __auditLogTesting.waitForIdle();
    const rows = await __auditLogTesting.listLatest(10);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      source: 'http',
      eventType: 'http_request',
      method: 'POST',
      path: '/api/projects/5/tests/run?confirm=true',
      statusCode: 200,
      projectId: 5
    }));

    const payload = JSON.parse(rows[0].payload);
    expect(payload.query).toEqual({ confirm: 'true' });
    expect(payload.body).toEqual({ token: '[redacted]', keep: 'ok' });
  });

  test('logs /api/projects/0/* but stores projectId=null (invalid project id)', async () => {
    await request(app)
      .post('/api/projects/0/tests/run')
      .send({ keep: true })
      .expect(200);

    await __auditLogTesting.waitForIdle();
    const rows = await __auditLogTesting.listLatest(5);

    expect(rows).toHaveLength(1);
    expect(rows[0].projectId).toBeNull();
  });

  test('logs /api routes without a project id and stores projectId=null', async () => {
    await request(app)
      .post('/api/non-project')
      .send({ apiKey: 'abc', nested: { password: 'p', keep: true }, arr: [{ token: 't' }] })
      .expect(201);

    await __auditLogTesting.waitForIdle();
    const rows = await __auditLogTesting.listLatest(5);

    expect(rows).toHaveLength(1);
    expect(rows[0].projectId).toBeNull();

    const payload = JSON.parse(rows[0].payload);
    expect(payload.body).toEqual({
      apiKey: '[redacted]',
      nested: { password: '[redacted]', keep: true },
      arr: [{ token: '[redacted]' }]
    });
  });

  test('best-effort: db write failures do not break the response', async () => {
    const originalRun = db.run;
    try {
      db.run = (sql, params, callback) => {
        if (typeof callback === 'function') {
          callback(new Error('db down'));
          return;
        }
        return undefined;
      };

      await request(app)
        .post('/api/projects/123/tests/run')
        .send({ keep: 'ok' })
        .expect(200);

      await __auditLogTesting.waitForIdle();
      const rows = await __auditLogTesting.listLatest(5);
      expect(rows).toHaveLength(0);
    } finally {
      db.run = originalRun;
    }
  });
});

describe('audit log service', () => {
  beforeAll(async () => {
    await initializeDatabase();
  });

  beforeEach(async () => {
    await __auditLogTesting.clearAll();
  });

  test('appendAuditLog normalizes default fields and trims source/type', async () => {
    await appendAuditLog({ source: '  test  ', eventType: '  event  ' });
    await __auditLogTesting.waitForIdle();

    const [row] = await __auditLogTesting.listLatest(1);
    expect(row).toEqual(expect.objectContaining({
      source: 'test',
      eventType: 'event',
      method: null,
      path: null,
      statusCode: null,
      projectId: null,
      sessionId: null
    }));
  });

  test('appendAuditLog falls back to unknown when source/type are blank', async () => {
    await appendAuditLog({ source: '   ', eventType: '   ' });
    await __auditLogTesting.waitForIdle();

    const [row] = await __auditLogTesting.listLatest(1);
    expect(row.source).toBe('unknown');
    expect(row.eventType).toBe('unknown');
  });

  test('appendAuditLog stores session id when provided', async () => {
    await appendAuditLog({
      source: 'unit',
      eventType: 'session',
      sessionId: 'sess-1',
      method: 'POST',
      path: '/api/example',
      statusCode: 201,
      projectId: 7,
      payload: { keep: true }
    });
    await __auditLogTesting.waitForIdle();

    const [row] = await __auditLogTesting.listLatest(1);
    expect(row.sessionId).toBe('sess-1');
    expect(row.statusCode).toBe(201);
    expect(row.projectId).toBe(7);
  });

  test('appendAuditLog redacts sensitive keys and stores JSON payload', async () => {
    await appendAuditLog({
      source: 'unit',
      eventType: 'custom',
      payload: {
        api_key: 'x',
        token: 'y',
        nested: { password: 'p', keep: 1 }
      }
    });
    await __auditLogTesting.waitForIdle();

    const [row] = await __auditLogTesting.listLatest(1);
    const payload = JSON.parse(row.payload);
    expect(payload).toEqual({
      api_key: '[redacted]',
      token: '[redacted]',
      nested: { password: '[redacted]', keep: 1 }
    });
  });

  test('appendAuditLog stores payload=null when JSON serialization fails', async () => {
    await appendAuditLog({ source: 'unit', eventType: 'bigint', payload: { big: BigInt(1) } });
    await __auditLogTesting.waitForIdle();

    const [row] = await __auditLogTesting.listLatest(1);
    expect(row.payload).toBeNull();
  });

  test('appendAuditLog stores payload=null when JSON.stringify returns non-string', async () => {
    const originalStringify = JSON.stringify;
    try {
      JSON.stringify = () => 123;
      await appendAuditLog({ source: 'unit', eventType: 'odd', payload: { ok: true } });
    } finally {
      JSON.stringify = originalStringify;
    }

    await __auditLogTesting.waitForIdle();
    const [row] = await __auditLogTesting.listLatest(1);
    expect(row.payload).toBeNull();
  });

  test('appendAuditLog truncates overly large payload strings', async () => {
    const huge = 'x'.repeat(20_000);
    await appendAuditLog({ source: 'unit', eventType: 'huge', payload: { huge } });
    await __auditLogTesting.waitForIdle();

    const [row] = await __auditLogTesting.listLatest(1);
    expect(typeof row.payload).toBe('string');
    expect(row.payload.length).toBe(10_000);
  });

  test('extracts projectId from route params when middleware runs under a mounted router', async () => {
    const mounted = express();
    mounted.use(express.json());

    const router = express.Router({ mergeParams: true });
    router.use(auditHttpRequestsMiddleware());
    router.post('/tests/run', (req, res) => res.status(200).json({ ok: true }));
    mounted.use('/api/projects/:projectId', router);

    await request(mounted).post('/api/projects/9/tests/run').send({ keep: true }).expect(200);

    await __auditLogTesting.waitForIdle();
    const [row] = await __auditLogTesting.listLatest(1);
    expect(row.projectId).toBe(9);
  });

  test('listLatest normalizes limit to at least 1', async () => {
    await appendAuditLog({ source: 'unit', eventType: 'one' });
    await appendAuditLog({ source: 'unit', eventType: 'two' });
    await __auditLogTesting.waitForIdle();

    const rows = await __auditLogTesting.listLatest(0);
    expect(rows).toHaveLength(1);
  });

  test('listLatest falls back to default limit when non-finite', async () => {
    await appendAuditLog({ source: 'unit', eventType: 'one' });
    await __auditLogTesting.waitForIdle();

    const rows = await __auditLogTesting.listLatest(Number.NaN);
    expect(rows).toHaveLength(1);
  });

  test('waitForIdle no-ops when no writes are pending', async () => {
    await __auditLogTesting.waitForIdle();
    expect(true).toBe(true);
  });

  test('nowIso returns a valid ISO timestamp', async () => {
    const iso = __auditLogTesting.nowIso();
    expect(typeof iso).toBe('string');
    expect(Number.isNaN(Date.parse(iso))).toBe(false);
  });

  test('listLatest rejects when the database query fails', async () => {
    const originalAll = db.all;
    try {
      db.all = (sql, params, callback) => {
        callback(new Error('query failed'));
      };

      await expect(__auditLogTesting.listLatest(1)).rejects.toThrow('query failed');
    } finally {
      db.all = originalAll;
    }
  });

  test('listLatest returns an empty list when the database returns null rows', async () => {
    const originalAll = db.all;
    try {
      db.all = (sql, params, callback) => {
        callback(null, null);
      };

      const rows = await __auditLogTesting.listLatest(1);
      expect(rows).toEqual([]);
    } finally {
      db.all = originalAll;
    }
  });

  test('appendAuditLog tolerates db.run resolving without callback context', async () => {
    const originalRun = db.run;
    try {
      db.run = (sql, params, callback) => {
        callback(null);
      };

      await appendAuditLog({ source: 'unit', eventType: 'contextless', payload: { keep: true } });
    } finally {
      db.run = originalRun;
    }
  });

  test('extractProjectId tolerates non-string originalUrl when logging is forced', async () => {
    const middleware = auditHttpRequestsMiddleware({ shouldLog: () => true });
    const req = {
      method: 'POST',
      originalUrl: 123,
      path: '/api/projects/11/tests/run',
      body: { keep: true },
      query: {}
    };

    const res = {
      statusCode: 200,
      on: (event, handler) => {
        if (event === 'finish') {
          res.__finishHandler = handler;
        }
        return res;
      }
    };

    middleware(req, res, () => {});
    res.__finishHandler();
    await __auditLogTesting.waitForIdle();

    const [row] = await __auditLogTesting.listLatest(1);
    expect(row.projectId).toBeNull();
  });

  test('middleware uses req.path when req.originalUrl is missing', async () => {
    const middleware = auditHttpRequestsMiddleware();

    const req = {
      method: 'POST',
      originalUrl: '',
      path: '/api/fallback-path',
      body: { keep: true },
      query: { token: 'secret' },
      params: undefined
    };

    const res = {
      statusCode: 200,
      on: (event, handler) => {
        if (event === 'finish') {
          res.__finishHandler = handler;
        }
        return res;
      }
    };

    let nextCalled = false;
    middleware(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);

    res.__finishHandler();
    await __auditLogTesting.waitForIdle();

    const [row] = await __auditLogTesting.listLatest(1);
    expect(row.path).toBe('/api/fallback-path');

    const payload = JSON.parse(row.payload);
    expect(payload.query).toEqual({ token: '[redacted]' });
  });

  test('middleware shouldLog handles missing method/path without throwing', async () => {
    const middleware = auditHttpRequestsMiddleware();
    const req = {};
    let onCalled = false;
    const res = {
      statusCode: 200,
      on: () => {
        onCalled = true;
      }
    };

    let nextCalled = false;
    middleware(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(onCalled).toBe(false);
  });
});
