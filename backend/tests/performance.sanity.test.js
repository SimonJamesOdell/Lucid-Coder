import { beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { app } from '../server.js';
import { initializeDatabase, createProject } from '../database.js';

const timeRequest = async (fn) => {
  const start = process.hrtime.bigint();
  const result = await fn();
  const durationMs = Number((process.hrtime.bigint() - start) / 1_000_000n);
  return { result, durationMs };
};

describe('performance sanity', () => {
  beforeAll(async () => {
    await initializeDatabase();
    await createProject({ name: 'Perf Project', description: 'test' });
  });

  test('GET /api/health responds quickly (generous budget)', async () => {
    const { durationMs } = await timeRequest(() => request(app).get('/api/health').expect(200));
    expect(durationMs).toBeLessThan(250);
  });

  test('GET /api/projects responds quickly (generous budget)', async () => {
    const { durationMs } = await timeRequest(() => request(app).get('/api/projects').expect(200));
    expect(durationMs).toBeLessThan(500);
  });
});
