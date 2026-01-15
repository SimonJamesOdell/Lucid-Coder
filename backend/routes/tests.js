import express from 'express';
import { runTestsForBranch, getLatestTestRun, getBranchOverview } from '../services/branchWorkflow.js';

const router = express.Router({ mergeParams: true });

const DEFAULT_MIN_TEST_RUN_INTERVAL_MS = 10 * 1000;
const testRunRateLimitState = new Map();
let nowProvider = () => Date.now();
let minTestRunIntervalMs = DEFAULT_MIN_TEST_RUN_INTERVAL_MS;

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
  console.error('[TestsRoutes]', error.message);
  res.status(statusCode).json({ success: false, error: message });
};

export const getLatestTestsHandler = async (req, res) => {
  try {
    const projectId = parseProjectId(req.params.projectId);
    const testRun = await getLatestTestRun(projectId);
    res.json({ success: true, testRun });
  } catch (error) {
    respondWithError(res, error, 'Failed to fetch tests');
  }
};

export const runTestsHandler = async (req, res) => {
  try {
    const projectId = parseProjectId(req.params.projectId);

    const now = Number(nowProvider());
    const intervalMs = Number.isFinite(minTestRunIntervalMs) ? minTestRunIntervalMs : DEFAULT_MIN_TEST_RUN_INTERVAL_MS;
    const previous = testRunRateLimitState.get(projectId);
    if (Number.isFinite(previous) && Number.isFinite(now) && now - previous < intervalMs) {
      const retryAfterMs = Math.max(intervalMs - (now - previous), 0);
      res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      res.status(429).json({
        success: false,
        error: 'Test runs are rate-limited. Please wait before retrying.',
        retryAfterMs
      });
      return;
    }

    testRunRateLimitState.set(projectId, now);
    const { branchName, forceFail, workspaceScope } = req.body || {};
    const options = { forceFail };
    if (typeof workspaceScope === 'string' && workspaceScope.trim()) {
      options.workspaceScope = workspaceScope;
    }
    const testRun = await runTestsForBranch(projectId, branchName, options);
    const overview = await getBranchOverview(projectId);
    res.json({ success: true, testRun, overview });
  } catch (error) {
    respondWithError(res, error, 'Failed to run tests');
  }
};

router.get('/latest', getLatestTestsHandler);
router.post('/run', runTestsHandler);

export const __testsRoutesInternals = {
  resetTestRunRateLimitState: () => testRunRateLimitState.clear(),
  setNowProvider: (fn) => {
    nowProvider = typeof fn === 'function' ? fn : (() => Date.now());
  },
  setMinTestRunIntervalMs: (value) => {
    minTestRunIntervalMs = value;
  }
};

export default router;
