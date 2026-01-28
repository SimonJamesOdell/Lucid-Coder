import { describe, expect, test } from 'vitest';
import express from 'express';
import request from 'supertest';
import { requestContextMiddleware, __requestContextTesting } from '../middleware/requestContext.js';

describe('request context middleware', () => {
  test('normalizes header values and clips long ids', () => {
    expect(__requestContextTesting.normalizeCorrelationId('   ')).toBeNull();
    expect(__requestContextTesting.normalizeCorrelationId('  abc  ')).toBe('abc');
    expect(__requestContextTesting.normalizeCorrelationId('x'.repeat(200))).toHaveLength(128);
  });

  test('sets correlation id header and attaches it to req', async () => {
    const app = express();
    app.use(requestContextMiddleware());
    app.get('/api/health', (req, res) => {
      res.status(200).json({ correlationId: req.correlationId, started: typeof req.requestStartedAt === 'bigint' });
    });

    const response = await request(app)
      .get('/api/health')
      .set(__requestContextTesting.HEADER_NAME, 'from-client')
      .expect(200);

    expect(response.headers[__requestContextTesting.HEADER_NAME]).toBe('from-client');
    expect(response.body).toEqual({ correlationId: 'from-client', started: true });
  });
});
