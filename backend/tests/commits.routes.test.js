import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import commitsRoutes from '../routes/commits.js';
import * as branchWorkflow from '../services/branchWorkflow.js';

vi.mock('../services/branchWorkflow.js', () => ({
  getBranchOverview: vi.fn(),
  getCommitHistory: vi.fn(),
  getCommitDetails: vi.fn(),
  getCommitFileDiffContent: vi.fn(),
  revertCommit: vi.fn(),
  squashCommits: vi.fn()
}));

describe('Commits Routes', () => {
  let app;

  const buildApp = (mutateRequest) => {
    const instance = express();
    instance.use(express.json());
    if (mutateRequest) {
      instance.use((req, _res, next) => {
        mutateRequest(req);
        next();
      });
    }
    instance.use('/api/projects/:projectId/commits', commitsRoutes);
    return instance;
  };

  beforeEach(() => {
    app = buildApp();
    vi.clearAllMocks();

    branchWorkflow.getBranchOverview.mockResolvedValue({
      branches: [],
      current: 'main',
      workingBranches: [],
      latestTestRun: null
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('GET /api/projects/:projectId/commits', () => {
    it('returns commit history for valid project', async () => {
      const mockCommits = [
        { sha: 'abc123', message: 'Initial commit', author: 'User', date: '2024-01-01' },
        { sha: 'def456', message: 'Add feature', author: 'User', date: '2024-01-02' }
      ];

      branchWorkflow.getCommitHistory.mockResolvedValue(mockCommits);
      const mockOverview = {
        branches: [],
        current: 'main',
        workingBranches: [],
        latestTestRun: null
      };
      branchWorkflow.getBranchOverview.mockResolvedValue(mockOverview);

      const response = await request(app)
        .get('/api/projects/42/commits')
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        commits: mockCommits,
        overview: mockOverview
      });
      expect(branchWorkflow.getCommitHistory).toHaveBeenCalledWith(42, {});
      expect(branchWorkflow.getBranchOverview).toHaveBeenCalledWith(42);
    });

    it('passes query parameters to getCommitHistory', async () => {
      branchWorkflow.getCommitHistory.mockResolvedValue([]);

      await request(app)
        .get('/api/projects/42/commits?limit=10&branch=main')
        .expect(200);

      expect(branchWorkflow.getCommitHistory).toHaveBeenCalledWith(42, {
        limit: '10',
        branch: 'main'
      });
    });

    it('returns 400 for invalid project id', async () => {
      const response = await request(app)
        .get('/api/projects/invalid/commits')
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'Invalid project id'
      });
      expect(branchWorkflow.getCommitHistory).not.toHaveBeenCalled();
    });

    it('returns 400 for negative project id', async () => {
      const response = await request(app)
        .get('/api/projects/-5/commits')
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'Invalid project id'
      });
    });

    it('returns 400 for zero project id', async () => {
      await request(app)
        .get('/api/projects/0/commits')
        .expect(400);
    });

    it('handles service errors with custom status codes', async () => {
      const error = new Error('Repository not found');
      error.statusCode = 404;
      branchWorkflow.getCommitHistory.mockRejectedValue(error);

      const response = await request(app)
        .get('/api/projects/42/commits')
        .expect(404);

      expect(response.body).toEqual({
        success: false,
        error: 'Repository not found'
      });
    });

    it('returns generic message for 500 errors', async () => {
      const error = new Error('Database connection failed');
      error.statusCode = 500;
      branchWorkflow.getCommitHistory.mockRejectedValue(error);

      const response = await request(app)
        .get('/api/projects/42/commits')
        .expect(500);

      expect(response.body).toEqual({
        success: false,
        error: 'Failed to fetch commits'
      });
    });

    it('defaults to 500 for errors without status code', async () => {
      const error = new Error('Unexpected error');
      branchWorkflow.getCommitHistory.mockRejectedValue(error);

      const response = await request(app)
        .get('/api/projects/42/commits')
        .expect(500);

      expect(response.body.success).toBe(false);
    });
  });

  describe('GET /api/projects/:projectId/commits/:commitSha', () => {
    it('returns commit details for valid sha', async () => {
      const mockCommit = {
        sha: 'abc123',
        message: 'Initial commit',
        author: 'User',
        date: '2024-01-01',
        files: ['README.md', 'package.json']
      };

      branchWorkflow.getCommitDetails.mockResolvedValue(mockCommit);

      const response = await request(app)
        .get('/api/projects/42/commits/abc123')
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        commit: mockCommit
      });
      expect(branchWorkflow.getCommitDetails).toHaveBeenCalledWith(42, 'abc123');
    });

    it('decodes URL-encoded commit SHA', async () => {
      const mockCommit = { sha: 'abc/123', message: 'Test commit' };
      branchWorkflow.getCommitDetails.mockResolvedValue(mockCommit);

      await request(app)
        .get('/api/projects/42/commits/abc%2F123')
        .expect(200);

      expect(branchWorkflow.getCommitDetails).toHaveBeenCalledWith(42, 'abc/123');
    });

    it('returns 400 for invalid project id', async () => {
      const response = await request(app)
        .get('/api/projects/invalid/commits/abc123')
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(branchWorkflow.getCommitDetails).not.toHaveBeenCalled();
    });

    it('handles commit not found error', async () => {
      const error = new Error('Commit not found');
      error.statusCode = 404;
      branchWorkflow.getCommitDetails.mockRejectedValue(error);

      const response = await request(app)
        .get('/api/projects/42/commits/nonexistent')
        .expect(404);

      expect(response.body).toEqual({
        success: false,
        error: 'Commit not found'
      });
    });

    it('returns generic message for 500 errors', async () => {
      const error = new Error('Git command failed');
      error.statusCode = 500;
      branchWorkflow.getCommitDetails.mockRejectedValue(error);

      const response = await request(app)
        .get('/api/projects/42/commits/abc123')
        .expect(500);

      expect(response.body).toEqual({
        success: false,
        error: 'Failed to fetch commit details'
      });
    });
  });

  describe('GET /api/projects/:projectId/commits/:commitSha/files-diff-content/*', () => {
    it('returns diff content for a commit file', async () => {
      branchWorkflow.getCommitFileDiffContent.mockResolvedValue({
        path: 'src/App.css',
        original: 'body { color: red; }',
        modified: 'body { color: blue; }',
        originalLabel: 'abc1234',
        modifiedLabel: 'def5678'
      });

      const response = await request(app)
        .get('/api/projects/42/commits/def5678/files-diff-content/src/App.css')
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        path: 'src/App.css',
        original: 'body { color: red; }',
        modified: 'body { color: blue; }',
        originalLabel: 'abc1234',
        modifiedLabel: 'def5678'
      });
      expect(branchWorkflow.getCommitFileDiffContent).toHaveBeenCalledWith(42, 'def5678', 'src/App.css');
    });

    it('decodes URL-encoded commit SHA and passes wildcard file path', async () => {
      branchWorkflow.getCommitFileDiffContent.mockResolvedValue({
        path: 'src/App.css',
        original: '',
        modified: 'body { }'
      });

      await request(app)
        .get('/api/projects/42/commits/abc%2F123/files-diff-content/src/App.css')
        .expect(200);

      expect(branchWorkflow.getCommitFileDiffContent).toHaveBeenCalledWith(42, 'abc/123', 'src/App.css');
    });

    it('returns 400 for invalid project id', async () => {
      const response = await request(app)
        .get('/api/projects/invalid/commits/abc123/files-diff-content/src/App.css')
        .expect(400);

      expect(response.body).toEqual({
        success: false,
        error: 'Invalid project id'
      });
      expect(branchWorkflow.getCommitFileDiffContent).not.toHaveBeenCalled();
    });

    it('returns generic message for 500 errors', async () => {
      const error = new Error('Git show failed');
      error.statusCode = 500;
      branchWorkflow.getCommitFileDiffContent.mockRejectedValue(error);

      const response = await request(app)
        .get('/api/projects/42/commits/abc123/files-diff-content/src/App.css')
        .expect(500);

      expect(response.body).toEqual({
        success: false,
        error: 'Failed to fetch commit diff'
      });
    });
  });

  describe('POST /api/projects/:projectId/commits/squash', () => {
    it('squashes two commits and returns refreshed history', async () => {
      const payload = { olderSha: 'abc123', newerSha: 'def456' };
      branchWorkflow.squashCommits.mockResolvedValue({
        squashed: {
          olderSha: 'abc123',
          newerSha: 'def456',
          newSha: 'zzz999'
        }
      });
      branchWorkflow.getCommitHistory.mockResolvedValueOnce([{ sha: 'zzz999' }]);

      const response = await request(app)
        .post('/api/projects/42/commits/squash')
        .send(payload)
        .expect(200);

      expect(branchWorkflow.squashCommits).toHaveBeenCalledWith(42, payload);
      expect(branchWorkflow.getCommitHistory).toHaveBeenCalledTimes(1);
      expect(response.body).toEqual({
        success: true,
        squashed: {
          olderSha: 'abc123',
          newerSha: 'def456',
          newSha: 'zzz999'
        },
        commits: [{ sha: 'zzz999' }]
      });
    });

    it('falls back to empty payload when body is missing', async () => {
      const rawApp = buildApp((req) => {
        req.body = undefined;
      });
      branchWorkflow.squashCommits.mockResolvedValue({ squashed: { newSha: 'abc' } });
      branchWorkflow.getCommitHistory.mockResolvedValue([]);

      await request(rawApp)
        .post('/api/projects/42/commits/squash')
        .expect(200);

      expect(branchWorkflow.squashCommits).toHaveBeenCalledWith(42, {});
    });

    it('surfaces non-500 errors from the squash service', async () => {
      const error = new Error('Commits must be adjacent');
      error.statusCode = 400;
      branchWorkflow.squashCommits.mockRejectedValue(error);

      const response = await request(app)
        .post('/api/projects/42/commits/squash')
        .send({ olderSha: 'a', newerSha: 'b' })
        .expect(400);

      expect(response.body).toEqual({ success: false, error: 'Commits must be adjacent' });
    });
  });

  describe('POST /api/projects/:projectId/commits/:commitSha/revert', () => {
    it('reverts commit and returns updated history', async () => {
      const mockRevertResult = {
        revertedSha: 'abc123',
        newCommitSha: 'xyz789',
        message: 'Revert "Initial commit"'
      };

      const mockCommits = [
        { sha: 'xyz789', message: 'Revert "Initial commit"' },
        { sha: 'def456', message: 'Add feature' },
        { sha: 'abc123', message: 'Initial commit' }
      ];

      branchWorkflow.revertCommit.mockResolvedValue(mockRevertResult);
      branchWorkflow.getCommitHistory.mockResolvedValue(mockCommits);

      const response = await request(app)
        .post('/api/projects/42/commits/abc123/revert')
        .expect(200);

      expect(response.body).toEqual({
        success: true,
        ...mockRevertResult,
        commits: mockCommits
      });
      expect(branchWorkflow.revertCommit).toHaveBeenCalledWith(42, 'abc123');
      expect(branchWorkflow.getCommitHistory).toHaveBeenCalledWith(42, {});
    });

    it('decodes URL-encoded commit SHA', async () => {
      branchWorkflow.revertCommit.mockResolvedValue({ revertedSha: 'abc/123' });
      branchWorkflow.getCommitHistory.mockResolvedValue([]);

      await request(app)
        .post('/api/projects/42/commits/abc%2F123/revert')
        .expect(200);

      expect(branchWorkflow.revertCommit).toHaveBeenCalledWith(42, 'abc/123');
    });

    it('returns 400 for invalid project id', async () => {
      const response = await request(app)
        .post('/api/projects/invalid/commits/abc123/revert')
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(branchWorkflow.revertCommit).not.toHaveBeenCalled();
    });

    it('handles revert conflicts', async () => {
      const error = new Error('Revert would create conflicts');
      error.statusCode = 409;
      branchWorkflow.revertCommit.mockRejectedValue(error);

      const response = await request(app)
        .post('/api/projects/42/commits/abc123/revert')
        .expect(409);

      expect(response.body).toEqual({
        success: false,
        error: 'Revert would create conflicts'
      });
    });

    it('handles commit not found during revert', async () => {
      const error = new Error('Commit not found');
      error.statusCode = 404;
      branchWorkflow.revertCommit.mockRejectedValue(error);

      const response = await request(app)
        .post('/api/projects/42/commits/nonexistent/revert')
        .expect(404);

      expect(response.body).toEqual({
        success: false,
        error: 'Commit not found'
      });
    });

    it('returns generic message for 500 errors', async () => {
      const error = new Error('Git error');
      error.statusCode = 500;
      branchWorkflow.revertCommit.mockRejectedValue(error);

      const response = await request(app)
        .post('/api/projects/42/commits/abc123/revert')
        .expect(500);

      expect(response.body).toEqual({
        success: false,
        error: 'Failed to revert commit'
      });
    });

    it('passes query parameters to getCommitHistory after revert', async () => {
      branchWorkflow.revertCommit.mockResolvedValue({ revertedSha: 'abc123' });
      branchWorkflow.getCommitHistory.mockResolvedValue([]);

      await request(app)
        .post('/api/projects/42/commits/abc123/revert?branch=develop')
        .expect(200);

      expect(branchWorkflow.getCommitHistory).toHaveBeenCalledWith(42, { branch: 'develop' });
    });
  });

  describe('Error logging', () => {
    it('logs errors to console', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const error = new Error('Test error');
      branchWorkflow.getCommitHistory.mockRejectedValue(error);

      await request(app)
        .get('/api/projects/42/commits')
        .expect(500);

      expect(consoleErrorSpy).toHaveBeenCalledWith('[CommitRoutes]', 'Test error');
      consoleErrorSpy.mockRestore();
    });
  });
});
