import { beforeEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../services/foregroundCleanupRunner.js', () => ({
  runForegroundCleanup: vi.fn()
}));

import agentRoutes from '../routes/agent.js';
import { runForegroundCleanup } from '../services/foregroundCleanupRunner.js';

describe('Agent cleanup stream routes', () => {
  let app;

  const findRouteHandler = (path, method) => {
    const layer = agentRoutes.stack.find((entry) => entry.route?.path === path && entry.route?.methods?.[method]);
    if (!layer) {
      throw new Error(`Route handler not found for ${method.toUpperCase()} ${path}`);
    }
    return layer.route.stack[0].handle;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/agent', agentRoutes);
  });

  test('rejects when body is missing (req.body fallback)', async () => {
    const appWithoutJson = express();
    appWithoutJson.use('/api/agent', agentRoutes);

    const response = await request(appWithoutJson).post('/api/agent/cleanup/stream');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'projectId is required' });
  });

  test('rejects missing projectId', async () => {
    const response = await request(app)
      .post('/api/agent/cleanup/stream')
      .send({});

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'projectId is required' });
  });

  test('streams SSE events and ends with done', async () => {
    runForegroundCleanup.mockImplementation(async ({ onEvent }) => {
      onEvent({ event: 'status', data: { text: 'Preparing cleanup…' } });
      onEvent({ event: 'status', data: { text: 'Running tests…' } });
      return { branchName: 'feature/cleanup-test', iterations: 1 };
    });

    const response = await request(app)
      .post('/api/agent/cleanup/stream')
      .set('Accept', 'text/event-stream')
      .send({ projectId: 123, prompt: 123, pruneRedundantTests: false });

    expect(runForegroundCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 123,
        prompt: '',
        pruneRedundantTests: false
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.text).toContain('event: status');
    expect(response.text).toContain('Preparing cleanup');
    expect(response.text).toContain('event: done');
    expect(response.text).toContain('feature/cleanup-test');
  });

  test('invokes flushHeaders + wires res.close cancellation into shouldCancel', async () => {
    const handler = findRouteHandler('/cleanup/stream', 'post');

    let closeCallback;
    let abortedCallback;
    const req = {
      body: { projectId: 123, prompt: 'cleanup' },
      on: (event, cb) => {
        if (event === 'aborted') {
          abortedCallback = cb;
        }
      }
    };

    const writes = [];
    const res = {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      on: (event, cb) => {
        if (event === 'close') {
          closeCallback = cb;
        }
      },
      write: vi.fn((chunk) => writes.push(String(chunk))),
      end: vi.fn()
    };

    runForegroundCleanup.mockImplementation(async ({ shouldCancel }) => {
      expect(shouldCancel()).toBe(false);
      closeCallback?.();
      expect(shouldCancel()).toBe(true);
      abortedCallback?.();
      expect(shouldCancel()).toBe(true);
      return { branchName: 'feature/cleanup-test' };
    });

    await handler(req, res);

    expect(res.flushHeaders).toHaveBeenCalledTimes(1);
    expect(writes.join('')).toContain('retry: 1000');
    expect(writes.join('')).toContain('event: done');
  });

  test('defaults missing event name and payload in onEvent', async () => {
    const handler = findRouteHandler('/cleanup/stream', 'post');

    const req = {
      body: { projectId: 123, prompt: 'cleanup' },
      on: vi.fn()
    };

    const writes = [];
    const res = {
      setHeader: vi.fn(),
      // Intentionally omit flushHeaders to cover the typeof-check false branch.
      on: vi.fn(),
      write: vi.fn((chunk) => writes.push(String(chunk))),
      end: vi.fn()
    };

    runForegroundCleanup.mockImplementation(async ({ onEvent }) => {
      onEvent({ event: '', data: null });
      return { ok: true };
    });

    await handler(req, res);

    const output = writes.join('');
    expect(output).toContain('event: message');
    expect(output).toContain('data: {}');
  });

  test('ends early when response is already destroyed (avoids writing retry)', async () => {
    const handler = findRouteHandler('/cleanup/stream', 'post');

    const req = {
      body: { projectId: 123, prompt: 'cleanup' },
      on: vi.fn()
    };

    const res = {
      destroyed: true,
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      on: vi.fn(),
      write: vi.fn(),
      end: vi.fn()
    };

    runForegroundCleanup.mockResolvedValue({ ok: true });

    await handler(req, res);

    expect(res.end).toHaveBeenCalledTimes(1);
    expect(runForegroundCleanup).not.toHaveBeenCalled();
  });

  test('ends early when retry write throws (avoids surfacing 500)', async () => {
    const handler = findRouteHandler('/cleanup/stream', 'post');

    const req = {
      body: { projectId: 123, prompt: 'cleanup' },
      on: vi.fn()
    };

    const res = {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      on: vi.fn(),
      write: vi.fn(() => {
        throw new Error('write failed');
      }),
      end: vi.fn()
    };

    runForegroundCleanup.mockResolvedValue({ ok: true });

    await handler(req, res);

    expect(res.end).toHaveBeenCalledTimes(1);
    expect(runForegroundCleanup).not.toHaveBeenCalled();
  });

  test('swallows event write failures during streaming (writeSseEvent try/catch)', async () => {
    const handler = findRouteHandler('/cleanup/stream', 'post');

    const req = {
      body: { projectId: 123, prompt: 'cleanup' },
      on: vi.fn()
    };

    let writeCalls = 0;
    const res = {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      on: vi.fn(),
      write: vi.fn(() => {
        writeCalls += 1;
        // Allow the retry directive to be written, then fail SSE event writes.
        if (writeCalls > 1) {
          throw new Error('stream write failed');
        }
      }),
      end: vi.fn()
    };

    runForegroundCleanup.mockImplementation(async ({ onEvent }) => {
      onEvent({ event: 'status', data: { text: 'Preparing cleanup…' } });
      return { ok: true };
    });

    await handler(req, res);

    expect(res.end).toHaveBeenCalledTimes(1);
    expect(runForegroundCleanup).toHaveBeenCalledTimes(1);
  });

  test('ignores events when response becomes destroyed mid-stream (writeSseEvent early return)', async () => {
    const handler = findRouteHandler('/cleanup/stream', 'post');

    const req = {
      body: { projectId: 123, prompt: 'cleanup' },
      on: vi.fn()
    };

    const writes = [];
    const res = {
      destroyed: false,
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      on: vi.fn(),
      write: vi.fn((chunk) => writes.push(String(chunk))),
      end: vi.fn()
    };

    runForegroundCleanup.mockImplementation(async ({ onEvent }) => {
      res.destroyed = true;
      onEvent({ event: 'status', data: { text: 'Preparing cleanup…' } });
      return { ok: true };
    });

    await handler(req, res);

    // Only the retry directive should have been written.
    expect(writes.join('')).toContain('retry: 1000');
    expect(writes.join('')).not.toContain('event: status');
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  test('returns done(cancelled) when runner throws CLEANUP_CANCELLED', async () => {
    const handler = findRouteHandler('/cleanup/stream', 'post');
    const req = {
      body: { projectId: 123, prompt: 'cleanup' },
      on: vi.fn()
    };

    const writes = [];
    const res = {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      on: vi.fn(),
      write: vi.fn((chunk) => writes.push(String(chunk))),
      end: vi.fn()
    };

    const error = new Error('cancelled');
    error.code = 'CLEANUP_CANCELLED';
    runForegroundCleanup.mockRejectedValue(error);

    await handler(req, res);

    const output = writes.join('');
    expect(output).toContain('event: done');
    expect(output).toContain('cancelled');
  });

  test('emits error with fallback message when error message is empty', async () => {
    const handler = findRouteHandler('/cleanup/stream', 'post');
    runForegroundCleanup.mockRejectedValue(new Error(''));

    const req = {
      body: { projectId: 123, prompt: 'cleanup' },
      on: vi.fn()
    };

    const writes = [];
    const res = {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      on: vi.fn(),
      write: vi.fn((chunk) => writes.push(String(chunk))),
      end: vi.fn()
    };

    await handler(req, res);

    const output = writes.join('');
    expect(output).toContain('event: error');
    expect(output).toContain('Cleanup failed');
  });
});
