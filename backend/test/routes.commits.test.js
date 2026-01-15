import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock the branch workflow services used by the routes
vi.mock('../services/branchWorkflow.js', () => ({
  getBranchOverview: vi.fn(),
  getCommitHistory: vi.fn(),
  getCommitDetails: vi.fn(),
  getCommitFileDiffContent: vi.fn(),
  revertCommit: vi.fn(),
  squashCommits: vi.fn()
}));

const loadApp = async () => {
  const commitsRouter = (await import('../routes/commits.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/projects/:projectId/commits', commitsRouter);
  return app;
};

describe('routes/commits', () => {
  let app;
  let svc;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    svc = await import('../services/branchWorkflow.js');

    // Safe defaults; tests will override as needed
    svc.getCommitHistory.mockResolvedValue([]);
    svc.getBranchOverview.mockResolvedValue({ branch: 'main' });
    svc.getCommitDetails.mockResolvedValue({ sha: 'abc123' });
    svc.getCommitFileDiffContent.mockResolvedValue({ content: 'diff', language: 'text' });
    svc.revertCommit.mockResolvedValue({ reverted: true });
    svc.squashCommits.mockResolvedValue({ squashed: { olderSha: 'o', newerSha: 'n', newSha: 'x' } });

    app = await loadApp();
  });

  it('GET /: invalid project id returns 400', async () => {
    const res = await request(app).get('/api/projects/0/commits');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, error: expect.stringMatching(/invalid project id/i) });
  });

  it('GET / uses fallback message on 500 errors', async () => {
    svc.getCommitHistory.mockRejectedValueOnce(new Error('Kaboom'));
    const res = await request(app).get('/api/projects/123/commits');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: 'Failed to fetch commits' });
  });

  it('GET /:commitSha forwards 400 error messages', async () => {
    const e = new Error('Bad commit');
    e.statusCode = 400;
    svc.getCommitDetails.mockRejectedValueOnce(e);

    const res = await request(app).get('/api/projects/123/commits/abc');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'Bad commit' });
  });

  it('GET /:commitSha decodes encoded commitSha', async () => {
    await request(app).get('/api/projects/123/commits/abc%20123').expect(200);
    expect(svc.getCommitDetails).toHaveBeenCalledWith(123, 'abc 123');
  });

  it('GET /:commitSha/files-diff-content/* sets no-store and returns payload', async () => {
    const res = await request(app)
      .get('/api/projects/123/commits/abc/files-diff-content/src/file.txt')
      .expect(200);

    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ success: true, content: 'diff', language: 'text' });
    expect(svc.getCommitFileDiffContent).toHaveBeenCalledWith(123, 'abc', 'src/file.txt');
  });

  it('POST /:commitSha/revert returns merged result and refreshes commits', async () => {
    svc.getCommitHistory.mockResolvedValueOnce([{ sha: 'x' }]);

    const res = await request(app)
      .post('/api/projects/123/commits/abc/revert')
      .send({})
      .expect(200);

    expect(svc.revertCommit).toHaveBeenCalledWith(123, 'abc');
    expect(svc.getCommitHistory).toHaveBeenCalledWith(123, expect.any(Object));
    expect(res.body).toEqual({ success: true, reverted: true, commits: [{ sha: 'x' }] });
  });

  it('POST /squash falls back to empty payload when body is absent (non-object path)', async () => {
    svc.squashCommits.mockResolvedValueOnce({ squashed: { olderSha: 'a', newerSha: 'b', newSha: 'c' } });
    svc.getCommitHistory.mockResolvedValueOnce([]);

    const res = await request(app)
      .post('/api/projects/123/commits/squash')
      // No body => req.body is undefined -> fallback to {}
      .expect(200);

    expect(svc.squashCommits).toHaveBeenCalledWith(123, {});
    expect(res.body).toMatchObject({ success: true, squashed: { newSha: 'c' } });
  });

  it('POST /squash uses fallback message on 500 errors', async () => {
    svc.squashCommits.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app)
      .post('/api/projects/123/commits/squash')
      .send({ olderSha: 'a', newerSha: 'b' })
      .expect(500);

    expect(svc.squashCommits).toHaveBeenCalledWith(123, { olderSha: 'a', newerSha: 'b' });
    expect(res.body).toEqual({ success: false, error: 'Failed to squash commits' });
  });
});
