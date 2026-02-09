import { describe, it, beforeEach, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../database.js', () => ({
  getProject: vi.fn()
}));

vi.mock('../services/jobRunner.js', () => ({
  startJob: vi.fn(),
  listJobsForProject: vi.fn(),
  getJob: vi.fn(),
  cancelJob: vi.fn()
}));

vi.mock('../services/branchWorkflow.js', () => ({
  describeBranchCssOnlyStatus: vi.fn()
}));

vi.mock('fs/promises', () => ({
  access: vi.fn(() => Promise.resolve())
}));

const buildApp = async () => {
  const app = express();
  app.use(express.json());
  const jobsRouter = (await import('../routes/jobs.js')).default;
  app.use('/api/projects/:projectId/jobs', jobsRouter);
  return app;
};

describe('routes/jobs', () => {
  let app;
  let db;
  let jobRunner;
  let branchWorkflow;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = await import('../database.js');
    jobRunner = await import('../services/jobRunner.js');
    branchWorkflow = await import('../services/branchWorkflow.js');

    db.getProject.mockResolvedValue({ id: 123, path: 'C:/tmp/project' });
    jobRunner.startJob.mockReturnValue({
      id: 'job-1',
      projectId: 123,
      type: 'frontend:test',
      displayName: 'Frontend tests',
      command: 'npm',
      args: ['run', 'test:coverage'],
      cwd: 'C:/tmp/project/frontend',
      status: 'pending',
      createdAt: '2024-01-01T00:00:00Z',
      startedAt: null,
      completedAt: null,
      exitCode: null,
      signal: null,
      logs: []
    });

    app = await buildApp();
  });

  it('skips starting test jobs when branch diff is css-only', async () => {
    branchWorkflow.describeBranchCssOnlyStatus.mockResolvedValue({
      branch: 'feature/css-only',
      isCssOnly: true,
      indicator: 'git-diff'
    });

    const res = await request(app)
      .post('/api/projects/123/jobs')
      .send({ type: 'frontend:test', payload: { branchName: 'feature/css-only' } })
      .expect(202);

    expect(res.body).toEqual({
      success: true,
      skipped: true,
      reason: 'css-only-branch',
      branch: 'feature/css-only',
      indicator: 'git-diff'
    });
    expect(jobRunner.startJob).not.toHaveBeenCalled();
    expect(branchWorkflow.describeBranchCssOnlyStatus).toHaveBeenCalledWith(123, 'feature/css-only');
  });

  it('starts backend tests when branch includes non-css changes', async () => {
    branchWorkflow.describeBranchCssOnlyStatus.mockResolvedValue({
      branch: 'feature/full',
      isCssOnly: false,
      indicator: null
    });

    const res = await request(app)
      .post('/api/projects/123/jobs')
      .send({ type: 'backend:test' })
      .expect(202);

    expect(res.body.success).toBe(true);
    expect(res.body.job).toBeTruthy();
    expect(res.body.job.id).toBe('job-1');
    expect(res.body.skipped).toBeUndefined();
    expect(jobRunner.startJob).toHaveBeenCalled();
  });

  it('continues starting test jobs when css-only detection fails', async () => {
    branchWorkflow.describeBranchCssOnlyStatus.mockRejectedValue(new Error('detector failed'));

    const res = await request(app)
      .post('/api/projects/123/jobs')
      .send({ type: 'frontend:test' })
      .expect(202);

    expect(res.body.success).toBe(true);
    expect(jobRunner.startJob).toHaveBeenCalled();
  });
});
