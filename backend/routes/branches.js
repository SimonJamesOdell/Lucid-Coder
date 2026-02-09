import express from 'express';
import {
  getBranchOverview,
  createWorkingBranch,
  runTestsForBranch,
  recordJobProofForBranch,
  mergeBranch,
  stageWorkspaceChange,
  clearStagedChanges,
  checkoutBranch,
  deleteBranchByName,
  commitBranchChanges,
  getBranchCommitContext,
  describeBranchCssOnlyStatus,
  getBranchChangedFiles
} from '../services/branchWorkflow.js';
import { requireDestructiveConfirmation } from './projects/internals.js';

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
  console.error('[BranchRoutes]', error.message);
  res.status(statusCode).json({ success: false, error: message });
};

router.get('/', async (req, res) => {
  try {
    const projectId = parseProjectId(req.params.projectId);
    const overview = await getBranchOverview(projectId);
    res.json({ success: true, ...overview });
  } catch (error) {
    respondWithError(res, error, 'Failed to fetch branches');
  }
});

router.post('/', async (req, res) => {
  try {
    const projectId = parseProjectId(req.params.projectId);
    const branch = await createWorkingBranch(projectId, req.body || {});
    const overview = await getBranchOverview(projectId);
    res.status(201).json({ success: true, branch, overview });
  } catch (error) {
    respondWithError(res, error, 'Failed to create branch');
  }
});

router.post('/stage', async (req, res) => {
  try {
    const projectId = parseProjectId(req.params.projectId);
    const payload = await stageWorkspaceChange(projectId, req.body || {});
    const overview = await getBranchOverview(projectId);
    res.status(201).json({ success: true, ...payload, overview });
  } catch (error) {
    respondWithError(res, error, 'Failed to stage file change');
  }
});

router.delete('/stage', async (req, res) => {
  try {
    const projectId = parseProjectId(req.params.projectId);
    const branch = await clearStagedChanges(projectId, req.body || {});
    const overview = await getBranchOverview(projectId);
    res.json({ success: true, branch, overview });
  } catch (error) {
    respondWithError(res, error, 'Failed to clear staged changes');
  }
});

router.get('/:branchName/commit-context', async (req, res) => {
  try {
    const projectId = parseProjectId(req.params.projectId);
    const branchName = decodeURIComponent(req.params.branchName);
    const context = await getBranchCommitContext(projectId, branchName);
    res.json({ success: true, context });
  } catch (error) {
    respondWithError(res, error, 'Failed to describe staged changes');
  }
});

router.get('/:branchName/css-only', async (req, res) => {
  try {
    const projectId = parseProjectId(req.params.projectId);
    const branchName = decodeURIComponent(req.params.branchName);
    const status = await describeBranchCssOnlyStatus(projectId, branchName);
    res.json({ success: true, ...status });
  } catch (error) {
    respondWithError(res, error, 'Failed to evaluate branch changes');
  }
});

router.get('/:branchName/changed-files', async (req, res) => {
  try {
    const projectId = parseProjectId(req.params.projectId);
    const branchName = decodeURIComponent(req.params.branchName);
    const result = await getBranchChangedFiles(projectId, branchName);
    res.json({ success: true, ...result });
  } catch (error) {
    respondWithError(res, error, 'Failed to fetch committed files');
  }
});

router.post('/:branchName/tests', async (req, res) => {
  try {
    const projectId = parseProjectId(req.params.projectId);
    const branchName = decodeURIComponent(req.params.branchName);
    const rawOptions = req.body || {};
    const testRun = await runTestsForBranch(projectId, branchName, {
      ...rawOptions,
      enforceFullCoverage: true,
      includeCoverageLineRefs: true
    });
    res.json({ success: true, testRun });
  } catch (error) {
    respondWithError(res, error, 'Failed to run tests');
  }
});

router.post('/:branchName/tests/proof', async (req, res) => {
  try {
    const projectId = parseProjectId(req.params.projectId);
    const branchName = decodeURIComponent(req.params.branchName);
    const testRun = await recordJobProofForBranch(projectId, branchName, req.body || {});
    const overview = await getBranchOverview(projectId);
    res.json({ success: true, testRun, overview });
  } catch (error) {
    respondWithError(res, error, 'Failed to record test proof');
  }
});

router.post('/:branchName/commit', async (req, res) => {
  try {
    const projectId = parseProjectId(req.params.projectId);
    const branchName = decodeURIComponent(req.params.branchName);
    const result = await commitBranchChanges(projectId, branchName, req.body || {});
    const overview = await getBranchOverview(projectId);
    res.json({ success: true, ...result, overview });
  } catch (error) {
    respondWithError(res, error, 'Failed to commit changes');
  }
});

router.post('/:branchName/merge', async (req, res) => {
  try {
    const projectId = parseProjectId(req.params.projectId);
    const branchName = decodeURIComponent(req.params.branchName);
    const result = await mergeBranch(projectId, branchName);
    const overview = await getBranchOverview(projectId);
    res.json({ success: true, ...result, overview });
  } catch (error) {
    respondWithError(res, error, 'Failed to merge branch');
  }
});

router.post('/:branchName/checkout', async (req, res) => {
  try {
    const projectId = parseProjectId(req.params.projectId);
    const branchName = decodeURIComponent(req.params.branchName);
    const branch = await checkoutBranch(projectId, branchName);
    const overview = await getBranchOverview(projectId);
    res.json({ success: true, branch, overview });
  } catch (error) {
    respondWithError(res, error, 'Failed to switch branch');
  }
});

router.delete('/:branchName', async (req, res) => {
  try {
    const projectId = parseProjectId(req.params.projectId);
    const branchName = decodeURIComponent(req.params.branchName);

    if (requireDestructiveConfirmation(req, res)) {
      return;
    }

    const result = await deleteBranchByName(projectId, branchName);
    const overview = await getBranchOverview(projectId);
    res.json({ success: true, ...result, overview });
  } catch (error) {
    respondWithError(res, error, 'Failed to delete branch');
  }
});

export default router;
