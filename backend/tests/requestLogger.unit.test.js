import { describe, expect, test } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createLogBuffer } from '../services/logBuffer.js';
import { requestLoggerMiddleware } from '../middleware/requestLogger.js';

describe('request logger middleware', () => {
  test('logs requests using requestStartedAt/correlationId when present', async () => {
    const buffer = createLogBuffer({ now: () => 'log-ts' });
    const logs = [];
    const consoleStub = { log: (line) => logs.push(line) };

    const app = express();
    app.use((req, res, next) => {
      req.requestStartedAt = process.hrtime.bigint();
      req.correlationId = 'corr-1';
      next();
    });
    app.use(requestLoggerMiddleware({ logBuffer: buffer, console: consoleStub, now: () => 'console-ts' }));
    app.get('/api/health', (req, res) => res.status(200).json({ ok: true }));

    await request(app).get('/api/health').expect(200);

    const [entry] = buffer.list({ limit: 1 });
    expect(entry).toEqual(expect.objectContaining({
      level: 'info',
      message: 'http_request',
      correlationId: 'corr-1',
      meta: expect.objectContaining({ method: 'GET', path: '/api/health', statusCode: 200 })
    }));

    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0])).toEqual(expect.objectContaining({
      ts: 'console-ts',
      correlationId: 'corr-1',
      message: 'http_request'
    }));
  });

  test('falls back when requestStartedAt/correlationId are missing', async () => {
    const buffer = createLogBuffer({ now: () => 'log-ts' });
    const logs = [];
    const consoleStub = { log: (line) => logs.push(line) };

    const app = express();
    app.use(requestLoggerMiddleware({ logBuffer: buffer, console: consoleStub, now: () => 'console-ts' }));
    app.get('/api/health', (req, res) => res.status(200).json({ ok: true }));

    await request(app).get('/api/health').expect(200);

    const [entry] = buffer.list({ limit: 1 });
    expect(entry.correlationId).toBeNull();
    expect(entry.meta.durationMs).toEqual(expect.any(Number));

    expect(logs).toHaveLength(1);
  });

  test('uses req.path when originalUrl is missing and normalizes blank correlation ids', async () => {
    const buffer = createLogBuffer({ now: () => 'log-ts' });
    const logs = [];
    const consoleStub = { log: (line) => logs.push(line) };

    const middleware = requestLoggerMiddleware({ logBuffer: buffer, console: consoleStub, now: () => 'console-ts' });

    const req = {
      method: 'GET',
      path: '/api/fallback-path',
      originalUrl: '',
      correlationId: '   '
    };
    const res = {
      statusCode: 204,
      on: (event, handler) => {
        if (event === 'finish') {
          handler();
        }
      }
    };

    middleware(req, res, () => {});

    const [entry] = buffer.list({ limit: 1 });
    expect(entry.correlationId).toBeNull();
    expect(entry.meta.path).toBe('/api/fallback-path');
    expect(logs).toHaveLength(1);
  });
});
