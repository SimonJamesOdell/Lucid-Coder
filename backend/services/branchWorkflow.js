import fs from 'fs/promises';
import path from 'path';
import { resolveCoveragePolicy } from '../constants/coveragePolicy.js';
import {
  MAX_AGGREGATE_DIFF_CHARS,
  MAX_FILE_DIFF_CHARS,
  buildCommitMessage,
  normalizeCommitLimit,
  parseGitLog,
  parseJsonColumn,
  parseStagedFiles,
  summarizeStagedChanges,
  trimDiff,
  interpolateCommitTemplate,
  withStatusCode
} from './branchWorkflow/formatting.js';
import {
  all,
  checkoutGitBranch,
  ensureGitBranchExists,
  ensureProjectExists,
  get,
  getProjectContext,
  isCssOnlyBranchDiff,
  isTestMode,
  listBranchChangedPaths,
  listGitStagedEntries,
  listGitStagedPaths,
  listGitStagedStatusMap,
  parseGitLsFilesStageBlob,
  resolveProjectGitSettings,
  run,
  runProjectGit,
  setGitContextOverride,
  setTestModeOverride,
  syncCurrentBranchStagedFilesFromGit
} from './branchWorkflow/context.js';
import { createBranchWorkflowTests } from './branchWorkflow/testsApi.js';
import { createBranchWorkflowStaging } from './branchWorkflow/stagingApi.js';
import { createBranchWorkflowCommits } from './branchWorkflow/commitsApi.js';
import * as git from '../utils/git.js';
import * as jobRunner from './jobRunner.js';

const JOB_STATUS_FALLBACK = {
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
};

const SUCCESSFUL_TEST_STATUSES = new Set(['passed', 'skipped']);

const AUTO_TEST_DEBOUNCE_MS = 750;
const autoTestTimers = new Map();

const ensureMainBranch = async (projectId) => {
  const existing = await get(
    'SELECT * FROM branches WHERE project_id = ? AND name = ? LIMIT 1',
    [projectId, 'main']
  );

  if (existing) {
    return existing;
  }

  await run(
    `INSERT INTO branches (project_id, name, description, type, status, is_current, ahead_commits, behind_commits, staged_files)
     VALUES (?, 'main', 'Default protected branch', 'main', 'protected', 1, 0, 0, '[]')`,
    [projectId]
  );

  return get('SELECT * FROM branches WHERE project_id = ? AND name = ? LIMIT 1', [projectId, 'main']);
};

const setCurrentBranch = async (projectId, branchId) => {
  await run(
    `UPDATE branches
     SET is_current = CASE WHEN id = ? THEN 1 ELSE 0 END,
         updated_at = CURRENT_TIMESTAMP
     WHERE project_id = ?`,
    [branchId, projectId]
  );
};

const getBranchByName = async (projectId, branchName) => {
  const branch = await get(
    `SELECT * FROM branches
     WHERE project_id = ? AND LOWER(name) = LOWER(?)
     LIMIT 1`,
    [projectId, branchName]
  );

  if (!branch) {
    throw withStatusCode(new Error(`Branch "${branchName}" not found`), 404);
  }

  return branch;
};

const serializeTestRun = (row) => {
  if (!row) {
    return null;
  }

  const summary = parseJsonColumn(row.summary, {
    total: row.total_tests || 0,
    passed: row.passed_tests || 0,
    failed: row.failed_tests || 0,
    skipped: row.skipped_tests || 0,
    duration: row.duration || 0
  });

  const details = parseJsonColumn(row.details, []);
  const tests = Array.isArray(details)
    ? details
    : (details && typeof details === 'object' && Array.isArray(details.tests) ? details.tests : []);
  const workspaceRuns =
    details && typeof details === 'object' && Array.isArray(details.workspaceRuns)
      ? details.workspaceRuns
      : [];

  return {
    id: row.id,
    projectId: row.project_id,
    branch: row.branch_name || null,
    status: row.status,
    success: SUCCESSFUL_TEST_STATUSES.has(row.status),
    summary,
    tests,
    workspaceRuns,
    error: row.error || null,
    createdAt: row.created_at,
    completedAt: row.completed_at
  };
};

const serializeBranchRow = (row) => {
  const lastTestRunId = row.last_test_run_id || null;
  const testSummary = lastTestRunId ? parseJsonColumn(row.last_test_summary) : null;
  const testDetails = lastTestRunId ? parseJsonColumn(row.last_test_details, []) : [];
  const stagedFiles = parseStagedFiles(row.staged_files);

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type,
    status: row.status,
    isCurrent: Boolean(row.is_current),
    ahead: row.ahead_commits || 0,
    behind: row.behind_commits || 0,
    lastTestStatus: lastTestRunId ? (row.last_test_status || null) : null,
    lastTestSummary: testSummary,
    lastTestDetails: testDetails,
    lastTestCompletedAt: lastTestRunId ? (row.last_test_completed_at || null) : null,
    stagedFiles
  };
};

const buildOverview = (rows, latestTestRun) => {
  const branches = rows.map((row) => {
    const stagedFiles = parseStagedFiles(row.staged_files);
    return {
      name: row.name,
      ahead: row.ahead_commits || 0,
      behind: row.behind_commits || 0,
      status: row.status,
      isCurrent: Boolean(row.is_current),
      stagedFileCount: stagedFiles.length
    };
  });

  const currentBranch = rows.find((row) => row.is_current === 1)?.name || 'main';

  const workingBranches = rows
    .filter((row) => row.type !== 'main' && row.status !== 'merged')
    .map((row) => {
      const lastTestRunId = row.last_test_run_id || null;
      const lastTestStatus = lastTestRunId ? (row.last_test_status || null) : null;
      const summary = lastTestRunId ? parseJsonColumn(row.last_test_summary) : null;
      const stagedFiles = parseStagedFiles(row.staged_files);
      const cssOnlyMergeAllowed = Boolean(row.__cssOnlyMergeAllowed);
      const testsRequired = stagedFiles.length > 0
        ? true
        : !(row.status === 'ready-for-merge' || cssOnlyMergeAllowed);
      const mergeBlockedReason = testsRequired
        ? (!lastTestRunId
            ? 'Run tests before merging'
            : (lastTestStatus === 'failed'
                ? 'Resolve failing tests before merging'
                : 'Tests must pass before merge'))
        : null;
      return {
        name: row.name,
        description: row.description,
        status: row.status,
        lastTestStatus,
        lastTestCompletedAt: lastTestRunId ? (row.last_test_completed_at || null) : null,
        mergeBlockedReason,
        testsRequired,
        lastTestSummary: summary,
        lastTestDetails: lastTestRunId ? parseJsonColumn(row.last_test_details, []) : [],
        stagedFiles
      };
    });

  return {
    branches,
    current: currentBranch,
    workingBranches,
    latestTestRun
  };
};

const fetchBranchRows = async (projectId) => {
  return all(
    `SELECT 
        b.*, 
        tr.status as last_test_status,
        tr.summary as last_test_summary,
        tr.details as last_test_details,
        tr.completed_at as last_test_completed_at
      FROM branches b
      LEFT JOIN test_runs tr ON tr.id = b.last_test_run_id
      WHERE b.project_id = ?
      ORDER BY CASE WHEN b.name = 'main' THEN 0 ELSE 1 END, b.created_at ASC`,
    [projectId]
  );
};

const getActiveWorkingBranchRow = (projectId) =>
  get(
    `SELECT * FROM branches
     WHERE project_id = ? AND type != 'main' AND is_current = 1
     ORDER BY updated_at DESC
     LIMIT 1`,
    [projectId]
  );

const generateAutoBranchName = () => `feature/autosave-${Date.now()}`;

const buildTestResultPayload = (branchName, forceFail = false) => {
  const baseTests = [
    { name: 'Project builds and lints', status: 'passed', duration: 0.35 },
    { name: 'Unit tests', status: 'passed', duration: 0.42 },
    { name: 'Integration tests', status: 'passed', duration: 0.51 },
    { name: 'Accessibility checks', status: 'passed', duration: 0.18 },
    { name: 'End-to-end smoke suite', status: 'passed', duration: 0.73 }
  ];

  let failed = 0;
  if (forceFail) {
    baseTests[2] = {
      ...baseTests[2],
      status: 'failed',
      error: `Regression detected on branch ${branchName}`
    };
    failed = 1;
  }

  const passed = baseTests.filter((test) => test.status === 'passed').length;

  const summary = {
    total: baseTests.length,
    passed,
    failed,
    skipped: 0,
    duration: Number(baseTests.reduce((total, test) => total + test.duration, 0).toFixed(2))
  };

  return { summary, tests: baseTests, status: failed > 0 ? 'failed' : 'passed' };
};

export const getBranchOverview = async (projectId) => {
  await ensureProjectExists(projectId);
  await ensureMainBranch(projectId);

  const context = await getProjectContext(projectId);
  await syncCurrentBranchStagedFilesFromGit(projectId, context);

  const [rows, latestTestRunRow] = await Promise.all([
    fetchBranchRows(projectId),
    get(
      `SELECT tr.*, b.name as branch_name
       FROM test_runs tr
       LEFT JOIN branches b ON b.id = tr.branch_id
       WHERE tr.project_id = ?
       ORDER BY tr.created_at DESC
       LIMIT 1`,
      [projectId]
    )
  ]);

  const latestTestRun = serializeTestRun(latestTestRunRow);

  if (context.gitReady) {
    for (const row of rows) {
      if (!row || row.type === 'main' || row.status === 'merged') {
        continue;
      }

      if (row.status === 'ready-for-merge') {
        continue;
      }

      const stagedFiles = parseStagedFiles(row.staged_files);
      if (stagedFiles.length > 0) {
        continue;
      }

      const isCssOnly = await isCssOnlyBranchDiff(context, row.name).catch(() => false);
      if (!isCssOnly) {
        continue;
      }

      row.__cssOnlyMergeAllowed = true;

      await run(
        `UPDATE branches
         SET status = 'ready-for-merge',
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [row.id]
      );

      row.status = 'ready-for-merge';
    }
  }

  return buildOverview(rows, latestTestRun);
};

export const createWorkingBranch = async (projectId, payload = {}) => {
  const context = await getProjectContext(projectId);
  await ensureMainBranch(projectId);

  const desiredName = typeof payload.name === 'string' ? payload.name.trim() : '';
  const branchName = desiredName || `feature-${Date.now()}`;

  const existing = await get(
    'SELECT id FROM branches WHERE project_id = ? AND LOWER(name) = LOWER(?) LIMIT 1',
    [projectId, branchName]
  );

  if (existing) {
    throw withStatusCode(new Error('Branch with that name already exists'), 409);
  }

  const description = payload.description || 'AI generated feature branch';
  const type = payload.type || 'feature';

  const insertResult = await run(
    `INSERT INTO branches (project_id, name, description, type, status, is_current, ahead_commits, behind_commits, staged_files)
     VALUES (?, ?, ?, ?, 'active', 1, 1, 0, '[]')`,
    [projectId, branchName, description, type]
  );

  await setCurrentBranch(projectId, insertResult.lastID);

  if (context.gitReady) {
    try {
      await runProjectGit(context, ['checkout', '-b', branchName]);
    } catch (error) {
      console.warn(`[BranchWorkflow] Failed to create git branch ${branchName}: ${error.message}`);
    }
  }

  const branchRow = await get('SELECT * FROM branches WHERE id = ?', [insertResult.lastID]);
  return serializeBranchRow(branchRow);
};

// runTestsForBranch implemented in ./branchWorkflow/testsApi.js

export const checkoutBranch = async (projectId, branchName) => {
  const context = await getProjectContext(projectId);
  await ensureMainBranch(projectId);

  const branch = await getBranchByName(projectId, branchName);
  await setCurrentBranch(projectId, branch.id);

  if (context.gitReady) {
    try {
      await ensureGitBranchExists(context, branch.name);
      await checkoutGitBranch(context, branch.name);
    } catch (error) {
      console.warn(`[BranchWorkflow] Failed to checkout git branch ${branch.name}: ${error.message}`);
    }
  }

  const refreshed = await get('SELECT * FROM branches WHERE id = ?', [branch.id]);
  return serializeBranchRow(refreshed);
};

export const deleteBranchByName = async (projectId, branchName) => {
  const context = await getProjectContext(projectId);
  await ensureMainBranch(projectId);

  const branch = await getBranchByName(projectId, branchName);
  if (branch.name === 'main') {
    throw withStatusCode(new Error('Cannot delete the main branch'), 400);
  }

  await run('DELETE FROM branches WHERE id = ?', [branch.id]);

  const current = await get(
    'SELECT id FROM branches WHERE project_id = ? AND is_current = 1 LIMIT 1',
    [projectId]
  );

  if (!current) {
    const main = await ensureMainBranch(projectId);
    await setCurrentBranch(projectId, main.id);
  }

  if (context.gitReady) {
    try {
      const currentGitBranch = await git.getCurrentBranch(context.projectPath).catch(() => null);
      if (currentGitBranch === branch.name) {
        await checkoutGitBranch(context, 'main');
      }
      await runProjectGit(context, ['branch', '-D', branch.name]).catch((error) => {
        if (!/not found/i.test(error.message || '')) {
          throw error;
        }
      });
      await git.removeBranchStashes(context.projectPath, branch.name).catch(() => null);
    } catch (error) {
      console.warn(`[BranchWorkflow] Failed to delete git branch ${branch.name}: ${error.message}`);
    }
  }

  return { deletedBranch: branch.name };
};

const autoTestKey = (projectId, branchName) => `${projectId}:${branchName}`;

const getJobFromRunner = jobRunner.getJob.bind(jobRunner);

const testsApi = createBranchWorkflowTests({
  AUTO_TEST_DEBOUNCE_MS,
  autoTestTimers,
  autoTestKey,
  isTestMode,
  ensureProjectExists,
  ensureMainBranch,
  getBranchByName,
  getProjectContext,
  listBranchChangedPaths,
  parseStagedFiles,
  resolveCoveragePolicy,
  runProjectGit,
  run,
  get,
  getJob: getJobFromRunner,
  serializeTestRun,
  buildTestResultPayload,
  withStatusCode,
  startJob: (...args) => jobRunner.startJob(...args),
  waitForJobCompletion: (...args) => jobRunner.waitForJobCompletion(...args),
  JOB_STATUS: JOB_STATUS_FALLBACK,
  fs,
  path
});

export const runTestsForBranch = testsApi.runTestsForBranch;
const scheduleAutoTests = testsApi.scheduleAutoTests;
const cancelScheduledAutoTests = testsApi.cancelScheduledAutoTests;
export const recordJobProofForBranch = testsApi.recordJobProofForBranch;

export const describeBranchCssOnlyStatus = async (projectId, branchName) => {
  await ensureProjectExists(projectId);
  await ensureMainBranch(projectId);

  let branch;
  if (branchName) {
    branch = await getBranchByName(projectId, branchName);
  } else {
    branch = await getActiveWorkingBranchRow(projectId);
    if (!branch) {
      branch = await ensureMainBranch(projectId);
    }
  }

  const { isCssOnly, indicator } = await testsApi.determineCssOnlyStatus(projectId, branch);

  return {
    branch: branch?.name || null,
    isCssOnly,
    indicator: indicator || null
  };
};

const stagingApi = createBranchWorkflowStaging({
  fs,
  path,
  withStatusCode,
  MAX_FILE_DIFF_CHARS,
  MAX_AGGREGATE_DIFF_CHARS,
  trimDiff,
  ensureProjectExists,
  ensureMainBranch,
  getProjectContext,
  getBranchByName,
  getActiveWorkingBranchRow,
  generateAutoBranchName,
  createWorkingBranch,
  parseStagedFiles,
  serializeBranchRow,
  runProjectGit,
  listGitStagedPaths,
  listGitStagedStatusMap,
  run,
  get,
  scheduleAutoTests,
  checkoutBranch,
  resolveProjectGitSettings,
  buildCommitMessage,
  ensureGitBranchExists,
  checkoutGitBranch,
  commitAllChanges: (...args) => git.commitAllChanges(...args),
  isCssOnlyBranchDiff
});

export const stageWorkspaceChange = stagingApi.stageWorkspaceChange;
export const getBranchCommitContext = stagingApi.getBranchCommitContext;
export const clearStagedChanges = stagingApi.clearStagedChanges;
export const rollbackBranchChanges = stagingApi.rollbackBranchChanges;
export const commitBranchChanges = stagingApi.commitBranchChanges;
export const getBranchHeadSha = stagingApi.getBranchHeadSha;
export const resetBranchToCommit = stagingApi.resetBranchToCommit;
export const getBranchStagedPatch = stagingApi.getBranchStagedPatch;
export const applyBranchPatch = stagingApi.applyBranchPatch;
const parseNumstatLine = stagingApi.parseNumstatLine;
const coerceReasonableSummary = stagingApi.coerceReasonableSummary;

const commitsApi = createBranchWorkflowCommits({
  withStatusCode,
  ensureMainBranch,
  getProjectContext,
  runProjectGit,
  normalizeCommitLimit,
  parseGitLog,
  getBranchByName,
  cancelScheduledAutoTests,
  isCssOnlyBranchDiff,
  ensureGitBranchExists,
  checkoutGitBranch,
  run,
  get,
  setCurrentBranch
});

export const getCommitHistory = commitsApi.getCommitHistory;
export const getCommitDetails = commitsApi.getCommitDetails;
export const getCommitFileDiffContent = commitsApi.getCommitFileDiffContent;
export const revertCommit = commitsApi.revertCommit;
export const squashCommits = commitsApi.squashCommits;
export const mergeBranch = commitsApi.mergeBranch;
const buildCommitFilesArgs = commitsApi.buildCommitFilesArgs;

export const getLatestTestRun = async (projectId) => {
  await ensureProjectExists(projectId);
  const row = await get(
    `SELECT tr.*, b.name as branch_name
     FROM test_runs tr
     LEFT JOIN branches b ON b.id = tr.branch_id
     WHERE tr.project_id = ?
     ORDER BY tr.created_at DESC
     LIMIT 1`,
    [projectId]
  );

  return serializeTestRun(row);
};

export const __testing = {
  getScheduledAutoTests: () => Array.from(autoTestTimers.keys()),
  getAutoTestHandle: (projectId, branchName) => autoTestTimers.get(autoTestKey(projectId, branchName)) || null,
  runScheduledAutoTestsNow: async () => {
    const keys = Array.from(autoTestTimers.keys());
    for (const key of keys) {
      const [projectIdPart, ...branchParts] = key.split(':');
      const branchName = branchParts.join(':');
      cancelScheduledAutoTests(projectIdPart, branchName);
      const numericId = Number(projectIdPart);
      const resolvedProjectId = Number.isNaN(numericId) ? projectIdPart : numericId;
      try {
        await runTestsForBranch(resolvedProjectId, branchName);
      } catch (error) {
        console.warn('[BranchWorkflow] Auto test run failed', error.message);
      }
    }
  },
  scheduleAutoTests,
  cancelScheduledAutoTests,
  runProjectGit: (context, args, options) => runProjectGit(context, args, options),
  listGitStagedStatusMap,
  listGitStagedEntries,
  parseGitLsFilesStageBlob,
  ensureGitBranchExists,
  checkoutGitBranch,
  getProjectContext,
  buildCommitFilesArgs,
  listBranchChangedPaths,
  isCssOnlyBranchDiff,
  getCommitFileDiffContent,
  coerceReasonableSummary,
  parseNumstatLine,
  runSql: (sql, params) => run(sql, params),
  getSql: (sql, params) => get(sql, params),
  allSql: (sql, params) => all(sql, params),
  parseJsonColumn,
  parseStagedFiles,
  withStatusCode,
  ensureProjectExists,
  resolveProjectGitSettings,
  summarizeStagedChanges,
  trimDiff,
  interpolateCommitTemplate,
  buildCommitMessage,
  normalizeCommitLimit,
  setTestModeOverride,
  setGitContextOverride
};
