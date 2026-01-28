import { beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { app } from '../server.js';
import { initializeDatabase, createProject } from '../database.js';

describe('diagnostics routes', () => {
  beforeAll(async () => {
    await initializeDatabase();
    await createProject({ name: 'Diag Project', description: 'test' });
  });

  test('GET /api/diagnostics/bundle returns an attachment with a bundle payload', async () => {
    const response = await request(app)
      .get('/api/diagnostics/bundle')
      .expect(200);

    expect(response.headers['content-type']).toMatch(/application\/json/i);
    expect(response.headers['content-disposition']).toMatch(/attachment;\s*filename=/i);

    expect(response.body).toEqual(expect.objectContaining({
      success: true,
      bundle: expect.any(Object)
    }));

    expect(response.body.bundle).toEqual(expect.objectContaining({
      generatedAt: expect.any(String),
      version: expect.any(String),
      environment: expect.any(Object),
      env: expect.any(Object),
      database: expect.any(Object),
      recent: expect.any(Object)
    }));

    expect(response.body.bundle.env.values).toEqual(expect.objectContaining({
      NODE_ENV: 'test'
    }));

    // Ensure we do not dump the entire environment.
    expect(Object.keys(response.body.bundle.env.values)).toEqual(
      expect.arrayContaining(['NODE_ENV', 'DATABASE_PATH'])
    );
    expect(Object.keys(response.body.bundle.env.values).length).toBeLessThanOrEqual(10);
  });
});
