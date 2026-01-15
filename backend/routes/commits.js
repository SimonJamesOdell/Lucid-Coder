import express from 'express';
import {
  getBranchOverview,
  getCommitHistory,
  getCommitDetails,
  getCommitFileDiffContent,
  revertCommit,
  squashCommits
} from '../services/branchWorkflow.js';

const router = express.Router({ mergeParams: true });

const parseProjectId = (value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    const error = new Error('Invalid project id');
    error.statusCode = 400;
    throw error;
  }
  return id;
};

const respondWithError = (res, error, fallbackMessage) => {
  const statusCode = error.statusCode || 500;
  const message = statusCode === 500 ? fallbackMessage : error.message;
  console.error('[CommitRoutes]', error.message);
  res.status(statusCode).json({ success: false, error: message });
};

router.get('/', async (req, res) => {
  try {
    const projectId = parseProjectId(req.params.projectId);
    const [commits, overview] = await Promise.all([
      getCommitHistory(projectId, req.query),
      getBranchOverview(projectId)
    ]);
    res.json({ success: true, commits, overview });
  } catch (error) {
    respondWithError(res, error, 'Failed to fetch commits');
  }
});

router.get('/:commitSha', async (req, res) => {
  try {
    const projectId = parseProjectId(req.params.projectId);
    const commitSha = decodeURIComponent(req.params.commitSha);
    const commit = await getCommitDetails(projectId, commitSha);
    res.json({ success: true, commit });
  } catch (error) {
    respondWithError(res, error, 'Failed to fetch commit details');
  }
});

router.get('/:commitSha/files-diff-content/*', async (req, res) => {
  try {
    // Commit diffs are static for a given sha; still disable caching to avoid confusing stale editor state.
    res.set('Cache-Control', 'no-store');

    const projectId = parseProjectId(req.params.projectId);
    const commitSha = decodeURIComponent(req.params.commitSha);
    const filePath = req.params[0];

    const result = await getCommitFileDiffContent(projectId, commitSha, filePath);
    res.json({ success: true, ...result });
  } catch (error) {
    respondWithError(res, error, 'Failed to fetch commit diff');
  }
});

router.post('/:commitSha/revert', async (req, res) => {
  try {
    const projectId = parseProjectId(req.params.projectId);
    const commitSha = decodeURIComponent(req.params.commitSha);
    const result = await revertCommit(projectId, commitSha);
    const commits = await getCommitHistory(projectId, req.query);
    res.json({ success: true, ...result, commits });
  } catch (error) {
    respondWithError(res, error, 'Failed to revert commit');
  }
});

router.post('/squash', async (req, res) => {
  try {
    const projectId = parseProjectId(req.params.projectId);
    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const result = await squashCommits(projectId, payload);
    const commits = await getCommitHistory(projectId, req.query);
    res.json({ success: true, ...result, commits });
  } catch (error) {
    respondWithError(res, error, 'Failed to squash commits');
  }
});

export default router;
