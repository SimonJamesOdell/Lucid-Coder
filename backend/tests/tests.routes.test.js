import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import testsRoutes, { runTestsHandler, __testsRoutesInternals } from '../routes/tests.js';

const workflowMocks = vi.hoisted(() => ({
  runTestsForBranch: vi.fn(),
  getLatestTestRun: vi.fn(),
  getBranchOverview: vi.fn()
}));

vi.mock('../services/branchWorkflow.js', () => workflowMocks);

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/projects/:projectId/tests', testsRoutes);
  return app;
};

describe('tests routes', () => {
  let app;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.values(workflowMocks).forEach((mockFn) => mockFn.mockReset());
    __testsRoutesInternals.resetTestRunRateLimitState();
    __testsRoutesInternals.setMinTestRunIntervalMs(10_000);
    __testsRoutesInternals.setNowProvider(() => Date.now());
    app = buildApp();
  });

  it('rejects invalid project ids on latest endpoint', async () => {
    const res = await request(app)
      .get('/api/projects/not-a-number/tests/latest')
      .expect(400);

    expect(workflowMocks.getLatestTestRun).not.toHaveBeenCalled();
    expect(res.body).toEqual({ success: false, error: 'Invalid project id' });
  });

  it('rejects non-positive project ids on latest endpoint', async () => {
    const res = await request(app)
      .get('/api/projects/0/tests/latest')
      .expect(400);

    expect(workflowMocks.getLatestTestRun).not.toHaveBeenCalled();
    expect(res.body).toEqual({ success: false, error: 'Invalid project id' });
  });

  it('returns latest test run payload', async () => {
    workflowMocks.getLatestTestRun.mockResolvedValue({ id: 9, status: 'passed' });

    const res = await request(app)
      .get('/api/projects/8/tests/latest')
      .expect(200);

    expect(workflowMocks.getLatestTestRun).toHaveBeenCalledWith(8);
    expect(res.body).toEqual({ success: true, testRun: { id: 9, status: 'passed' } });
  });

  it('falls back to generic error when latest fetch fails', async () => {
    workflowMocks.getLatestTestRun.mockRejectedValue(new Error('db unavailable'));

    const res = await request(app)
      .get('/api/projects/3/tests/latest')
      .expect(500);

    expect(res.body).toEqual({ success: false, error: 'Failed to fetch tests' });
  });

  it('runs tests for a branch and returns overview', async () => {
    const testRun = { id: 4, branch: 'feature/login', status: 'passed' };
    const overview = { branches: [], current: 'main' };
    workflowMocks.runTestsForBranch.mockResolvedValue(testRun);
    workflowMocks.getBranchOverview.mockResolvedValue(overview);

    const res = await request(app)
      .post('/api/projects/5/tests/run')
      .send({ branchName: 'feature/login', forceFail: false })
      .expect(200);

    expect(workflowMocks.runTestsForBranch).toHaveBeenCalledWith(5, 'feature/login', {
      forceFail: false,
      enforceFullCoverage: true
    });
    expect(workflowMocks.getBranchOverview).toHaveBeenCalledWith(5);
    expect(res.body).toEqual({ success: true, testRun, overview });
  });

  it('forwards workspaceScope to workflow when provided (performance)', async () => {
    const testRun = { id: 4, branch: 'feature/login', status: 'passed' };
    const overview = { branches: [], current: 'main' };
    workflowMocks.runTestsForBranch.mockResolvedValue(testRun);
    workflowMocks.getBranchOverview.mockResolvedValue(overview);

    await request(app)
      .post('/api/projects/5/tests/run')
      .send({ branchName: 'feature/login', forceFail: false, workspaceScope: 'changed' })
      .expect(200);

    expect(workflowMocks.runTestsForBranch).toHaveBeenCalledWith(5, 'feature/login', {
      forceFail: false,
      enforceFullCoverage: true,
      workspaceScope: 'changed'
    });
  });

  it('rejects invalid project ids on run endpoint', async () => {
    const res = await request(app)
      .post('/api/projects/not-a-number/tests/run')
      .send({ branchName: 'main' })
      .expect(400);

    expect(workflowMocks.runTestsForBranch).not.toHaveBeenCalled();
    expect(res.body).toEqual({ success: false, error: 'Invalid project id' });
  });

  it('rejects non-positive project ids on run endpoint', async () => {
    const res = await request(app)
      .post('/api/projects/0/tests/run')
      .send({ branchName: 'main' })
      .expect(400);

    expect(workflowMocks.runTestsForBranch).not.toHaveBeenCalled();
    expect(res.body).toEqual({ success: false, error: 'Invalid project id' });
  });

  it('propagates custom status codes from workflow errors', async () => {
    const error = new Error('Branch not found');
    error.statusCode = 404;
    workflowMocks.runTestsForBranch.mockRejectedValue(error);

    const res = await request(app)
      .post('/api/projects/2/tests/run')
      .send({ branchName: 'missing' })
      .expect(404);

    expect(workflowMocks.getBranchOverview).not.toHaveBeenCalled();
    expect(res.body).toEqual({ success: false, error: 'Branch not found' });
  });

  it('falls back to generic error when run fails unexpectedly', async () => {
    workflowMocks.runTestsForBranch.mockRejectedValue(new Error('db offline'));

    const res = await request(app)
      .post('/api/projects/7/tests/run')
      .send({ branchName: 'hotfix', forceFail: true })
      .expect(500);

    expect(workflowMocks.getBranchOverview).not.toHaveBeenCalled();
    expect(res.body).toEqual({ success: false, error: 'Failed to run tests' });
  });

  it('rate-limits repeated test runs for the same project', async () => {
    const testRun = { id: 4, branch: 'main', status: 'passed' };
    const overview = { branches: [], current: 'main' };
    workflowMocks.runTestsForBranch.mockResolvedValue(testRun);
    workflowMocks.getBranchOverview.mockResolvedValue(overview);

    let now = 1_000_000;
    __testsRoutesInternals.setMinTestRunIntervalMs(10_000);
    __testsRoutesInternals.setNowProvider(() => now);

    const first = await request(app)
      .post('/api/projects/5/tests/run')
      .send({ branchName: 'main' })
      .expect(200);

    expect(first.body.success).toBe(true);
    expect(workflowMocks.runTestsForBranch).toHaveBeenCalledTimes(1);

    now += 1_000;
    const blocked = await request(app)
      .post('/api/projects/5/tests/run')
      .send({ branchName: 'main' })
      .expect(429);

    expect(workflowMocks.runTestsForBranch).toHaveBeenCalledTimes(1);
    expect(blocked.headers['retry-after']).toBe('9');
    expect(blocked.body.success).toBe(false);
    expect(blocked.body.error).toMatch(/rate-limited/i);
    expect(blocked.body.retryAfterMs).toBe(9000);

    now += 9_000;
    const allowedAgain = await request(app)
      .post('/api/projects/5/tests/run')
      .send({ branchName: 'main' })
      .expect(200);

    expect(allowedAgain.body.success).toBe(true);
    expect(workflowMocks.runTestsForBranch).toHaveBeenCalledTimes(2);
  });

  it('falls back to Date.now when now provider is invalid (coverage)', async () => {
    const testRun = { id: 4, branch: 'main', status: 'passed' };
    const overview = { branches: [], current: 'main' };
    workflowMocks.runTestsForBranch.mockResolvedValue(testRun);
    workflowMocks.getBranchOverview.mockResolvedValue(overview);

    __testsRoutesInternals.setMinTestRunIntervalMs(10_000);
    __testsRoutesInternals.setNowProvider(null);

    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(1_000_000);
    nowSpy.mockReturnValueOnce(1_001_000);

    const first = await request(app)
      .post('/api/projects/5/tests/run')
      .send({ branchName: 'main' })
      .expect(200);

    expect(first.body.success).toBe(true);

    const blocked = await request(app)
      .post('/api/projects/5/tests/run')
      .send({ branchName: 'main' })
      .expect(429);

    expect(blocked.headers['retry-after']).toBe('9');

    nowSpy.mockRestore();
  });

  it('uses default interval when min interval is non-finite (coverage)', async () => {
    const testRun = { id: 4, branch: 'main', status: 'passed' };
    const overview = { branches: [], current: 'main' };
    workflowMocks.runTestsForBranch.mockResolvedValue(testRun);
    workflowMocks.getBranchOverview.mockResolvedValue(overview);

    let now = 2_000_000;
    __testsRoutesInternals.setNowProvider(() => now);
    __testsRoutesInternals.setMinTestRunIntervalMs(Number.NaN);

    await request(app)
      .post('/api/projects/5/tests/run')
      .send({ branchName: 'main' })
      .expect(200);

    now += 1_000;
    const blocked = await request(app)
      .post('/api/projects/5/tests/run')
      .send({ branchName: 'main' })
      .expect(429);

    // Default interval is 10 seconds.
    expect(blocked.body.retryAfterMs).toBe(9000);
    expect(blocked.headers['retry-after']).toBe('9');
  });
});

describe('tests route internals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.values(workflowMocks).forEach((mockFn) => mockFn.mockReset());
  });

  it('run handler treats undefined body as empty payload', async () => {
    const testRun = { id: 99, status: 'passed' };
    const overview = { branches: ['main'], current: 'main' };
    workflowMocks.runTestsForBranch.mockResolvedValue(testRun);
    workflowMocks.getBranchOverview.mockResolvedValue(overview);

    const req = { params: { projectId: '11' }, body: undefined };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis()
    };

    await runTestsHandler(req, res);

    expect(workflowMocks.runTestsForBranch).toHaveBeenCalledWith(11, undefined, {
      forceFail: undefined,
      enforceFullCoverage: true
    });
    expect(workflowMocks.getBranchOverview).toHaveBeenCalledWith(11);
    expect(res.json).toHaveBeenCalledWith({ success: true, testRun, overview });
  });
});
