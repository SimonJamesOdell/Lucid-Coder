import { describe, expect, test } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createLogBuffer } from '../services/logBuffer.js';
import { errorHandlerMiddleware, notFoundHandler } from '../middleware/errorHandlers.js';

describe('error handlers', () => {
  test('returns 400 for JSON parse errors and logs with correlationId', async () => {
    const buffer = createLogBuffer({ now: () => 'log-ts' });
    const errors = [];
    const consoleStub = { error: (...args) => errors.push(args) };

    const app = express();
    app.use((req, res, next) => {
      req.correlationId = 'corr-400';
      next();
    });
    app.use(express.json());

    app.post('/api/x', (req, res) => res.status(200).json({ ok: true }));

    app.use(errorHandlerMiddleware({ logBuffer: buffer, console: consoleStub }));

    await request(app)
      .post('/api/x')
      .set('Content-Type', 'application/json')
      .send('{"bad json"')
      .expect(400);

    const [entry] = buffer.list({ limit: 1 });
    expect(entry).toEqual(expect.objectContaining({
      level: 'error',
      message: 'server_error',
      correlationId: 'corr-400'
    }));

    expect(errors.length).toBeGreaterThan(0);
  });

  test('returns 500 with generic message outside development', async () => {
    const prior = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';

    const buffer = createLogBuffer({ now: () => 'log-ts' });
    const app = express();
    app.get('/api/boom', () => {
      throw new Error('explode');
    });
    app.use(errorHandlerMiddleware({ logBuffer: buffer, console: { error: () => {} } }));

    const response = await request(app).get('/api/boom').expect(500);
    expect(response.body).toEqual({
      success: false,
      error: 'Internal server error',
      message: 'Something went wrong'
    });

    process.env.NODE_ENV = prior;
  });

  test('returns 500 with original message in development', async () => {
    const prior = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    const app = express();
    app.get('/api/boom', (req, res, next) => next(new Error('explode')));
    app.use(errorHandlerMiddleware({ logBuffer: createLogBuffer(), console: { error: () => {} } }));

    const response = await request(app).get('/api/boom').expect(500);
    expect(response.body.message).toBe('explode');

    process.env.NODE_ENV = prior;
  });

  test('logs errors even when correlationId is missing and error has no message', async () => {
    const buffer = createLogBuffer({ now: () => 'log-ts' });
    const app = express();

    app.get('/api/boom', (req, res, next) => {
      // eslint-disable-next-line no-throw-literal
      next({});
    });

    app.use((error, req, res, next) => {
      delete req.correlationId;
      return errorHandlerMiddleware({ logBuffer: buffer, console: { error: () => {} } })(error, req, res, next);
    });

    await request(app).get('/api/boom').expect(500);

    const [entry] = buffer.list({ limit: 1 });
    expect(entry.correlationId).toBeNull();
    expect(entry.meta.message).toBe('[object Object]');
  });

  test('notFoundHandler returns a 404 payload', async () => {
    const app = express();
    app.use('*', notFoundHandler);

    const response = await request(app).get('/nope').expect(404);
    expect(response.body).toEqual({
      success: false,
      error: 'Route not found',
      path: '/nope'
    });
  });
});
