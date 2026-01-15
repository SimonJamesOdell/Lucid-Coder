import { describe, test, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

const buildTestApp = async () => {
  const { default: settingsRouter } = await import('../routes/settings.js');
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRouter);
  return app;
};

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe('settings policy endpoint (coverage)', () => {
  test('GET /api/settings/policy returns default policy', async () => {
    const app = await buildTestApp();

    const response = await request(app)
      .get('/api/settings/policy')
      .expect(200);

    expect(response.body).toMatchObject({
      success: true,
      policy: {
        coverage: {
          globalThresholds: { lines: 100, statements: 100, functions: 100, branches: 100 },
          changedFileThresholds: { lines: 100, statements: 100, functions: 100, branches: 100 },
          enforceChangedFileCoverage: true
        },
        changeScope: {
          allowConfigEdits: false,
          guidance: expect.any(String)
        },
        defaults: {
          coverageThresholds: { lines: 100, statements: 100, functions: 100, branches: 100 },
          enforceChangedFileCoverage: true,
          changeScope: {
            allowConfigEdits: false,
            guidance: expect.any(String)
          }
        }
      }
    });
  });

  test('GET /api/settings/policy returns 500 when policy resolution throws', async () => {
    vi.doMock('../constants/coveragePolicy.js', () => ({
      DEFAULT_COVERAGE_THRESHOLDS: { lines: 100, statements: 100, functions: 100, branches: 100 },
      resolveCoveragePolicy: () => {
        throw new Error('boom');
      }
    }));

    const app = await buildTestApp();

    const response = await request(app)
      .get('/api/settings/policy')
      .expect(500);

    expect(response.body).toEqual({
      success: false,
      error: 'Failed to resolve policy defaults'
    });
  });
});
