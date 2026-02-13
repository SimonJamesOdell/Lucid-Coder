import { isRelevantSourceFile, normalizePathForCompare } from './testsApi/workspacePathUtils.js';
import { buildChangedFilesGateForWorkspace } from './testsApi/changedFilesCoverageGate.js';
import { extractUncoveredLines } from './testsApi/coverageUtils.js';
import { readJsonIfExists as readJsonIfExistsInFs } from './testsApi/fsUtils.js';
import { discoverWorkspaces, selectWorkspacesForScope } from './testsApi/workspaceSelection.js';
import { resolveChangedPaths } from './testsApi/changedPaths.js';
import { getChangedSourceFilesForWorkspace } from './testsApi/changedFilesForWorkspace.js';
import { readNodeWorkspaceCoverage } from './testsApi/nodeCoverageReader.js';

export const createBranchWorkflowTests = (core) => {
  const {
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
    getTestingSettings,
    getProjectTestingSettings,
    runProjectGit,
    run,
    get,
    getJob,
    serializeTestRun,
    buildTestResultPayload,
    withStatusCode,
    startJob,
    waitForJobCompletion,
    JOB_STATUS,
    fs,
    path
  } = core;

  const normalizeCoverageTarget = (value) => {
    const numeric = Number(value);
    if (!Number.isInteger(numeric)) {
      return null;
    }
    if (numeric < 50 || numeric > 100) {
      return null;
    }
    if (numeric % 10 !== 0) {
      return null;
    }
    return numeric;
  };

  const buildCoverageThresholds = (target) => ({
    lines: target,
    statements: target,
    functions: target,
    branches: target
  });

  const shouldInstallNodeDependencies = ({ workspaceName, changedPaths = [] }) => {
    if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
      return false;
    }

    const normalizedWorkspace = String(workspaceName || '').trim().toLowerCase();
    const workspacePrefix = normalizedWorkspace && normalizedWorkspace !== 'root'
      ? `${normalizedWorkspace}/`
      : '';

    const rootDependencyFiles = new Set([
      'package-lock.json',
      'npm-shrinkwrap.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      'bun.lockb'
    ]);

    const workspaceDependencyFiles = new Set([
      'package.json',
      ...rootDependencyFiles
    ]);

    return changedPaths.some((filePath) => {
      const normalized = normalizePathForCompare(filePath);
      if (workspacePrefix && rootDependencyFiles.has(normalized)) {
        return true;
      }

      if (!workspacePrefix) {
        return workspaceDependencyFiles.has(normalized);
      }

      if (!normalized.startsWith(workspacePrefix)) {
        return false;
      }

      const relativePath = normalized.slice(workspacePrefix.length);
      return workspaceDependencyFiles.has(relativePath);
    });
  };

  const resolveWorkspaceThresholdConfig = async (projectId, options = {}) => {
    const globalSettings = typeof getTestingSettings === 'function'
      ? await getTestingSettings().catch(() => null)
      : null;
    const globalTarget = normalizeCoverageTarget(globalSettings?.coverageTarget) || 100;
    const globalThresholds = buildCoverageThresholds(globalTarget);

    const requestedCoverageThresholds = options?.coverageThresholds;
    const requestedChangedFileThresholds = options?.changedFileCoverageThresholds;
    const policy = resolveCoveragePolicy({
      ...options,
      enforceFullCoverage: false,
      coverageThresholds: requestedCoverageThresholds || globalThresholds,
      changedFileCoverageThresholds: requestedChangedFileThresholds || globalThresholds
    });

    const projectSettings = typeof getProjectTestingSettings === 'function'
      ? await getProjectTestingSettings(projectId).catch(() => null)
      : null;

    const resolveScopeTarget = (scope) => {
      const normalizedMode = scope?.mode === 'custom' ? 'custom' : 'global';
      if (normalizedMode !== 'custom') {
        return globalTarget;
      }
      return normalizeCoverageTarget(scope?.coverageTarget)
        || normalizeCoverageTarget(scope?.effectiveCoverageTarget)
        || globalTarget;
    };

    const frontendTarget = resolveScopeTarget(projectSettings?.frontend);
    const backendTarget = resolveScopeTarget(projectSettings?.backend);

    const resolveWorkspaceThresholds = (workspaceName) => {
      if (requestedCoverageThresholds) {
        return policy.globalThresholds;
      }
      if (workspaceName === 'frontend') {
        return buildCoverageThresholds(frontendTarget);
      }
      if (workspaceName === 'backend') {
        return buildCoverageThresholds(backendTarget);
      }
      return policy.globalThresholds;
    };

    const resolveChangedFileThresholds = (workspaceName) => {
      if (requestedChangedFileThresholds) {
        return policy.changedFileThresholds;
      }
      return resolveWorkspaceThresholds(workspaceName);
    };

    return {
      defaultThresholds: policy.globalThresholds,
      enforceChangedFileCoverage: policy.enforceChangedFileCoverage,
      resolveWorkspaceThresholds,
      resolveChangedFileThresholds
    };
  };

  const cancelScheduledAutoTests = (projectId, branchName) => {
    const key = autoTestKey(projectId, branchName);
    const timer = autoTestTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      autoTestTimers.delete(key);
    }
  };

  const scheduleAutoTests = (projectId, branchName, delayMs = AUTO_TEST_DEBOUNCE_MS) => {
    if (!branchName) {
      return;
    }
    cancelScheduledAutoTests(projectId, branchName);
    const key = autoTestKey(projectId, branchName);
    const normalizedDelay = Number.isFinite(delayMs) ? delayMs : AUTO_TEST_DEBOUNCE_MS;
    const timer = setTimeout(async () => {
      autoTestTimers.delete(key);
      try {
        await runTestsForBranch(projectId, branchName);
      } catch (error) {
        console.warn('[BranchWorkflow] Auto test run failed', error.message);
      }
    }, Math.max(normalizedDelay, 0));
    autoTestTimers.set(key, timer);
  };

  const isCssStylesheetPath = (value) => {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized.endsWith('.css');
  };

  const determineCssOnlyStatus = async (projectId, branch) => {
    const context = await getProjectContext(projectId);
    const stagedFiles = parseStagedFiles(branch?.staged_files);
    const stagedCssOnly = Array.isArray(stagedFiles)
      && stagedFiles.length > 0
      && stagedFiles.every((entry) => isCssStylesheetPath(entry?.path));

    if (!context?.gitReady || !branch?.name) {
      return { context, isCssOnly: stagedCssOnly, indicator: stagedCssOnly ? 'staged' : null };
    }

    try {
      const changedPaths = await listBranchChangedPaths(context, { branchRef: branch.name });
      if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
        return { context, isCssOnly: stagedCssOnly, indicator: stagedCssOnly ? 'staged' : null };
      }

      const cssOnlyDiff = changedPaths.every((filePath) => isCssStylesheetPath(filePath));
      return { context, isCssOnly: cssOnlyDiff, indicator: cssOnlyDiff ? 'git-diff' : null };
    } catch {
      return { context, isCssOnly: stagedCssOnly, indicator: stagedCssOnly ? 'staged' : null };
    }
  };

  const recordCssOnlySkipRun = async ({ projectId, branch, indicator }) => {
    const summaryPayload = {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      duration: 0,
      coverage: {
        passed: true,
        skipped: true,
        reason: 'css-only-branch',
        source: indicator || 'css-only'
      }
    };

    const detailsPayload = {
      tests: [],
      workspaceRuns: [],
      note: 'Tests skipped automatically because only CSS files changed in this branch.',
      skipReason: indicator || 'css-only'
    };

    const { lastID: testRunId } = await run(
      `INSERT INTO test_runs (
         project_id,
         branch_id,
         status,
         summary,
         details,
         total_tests,
         passed_tests,
         failed_tests,
         skipped_tests,
         duration,
         error,
         completed_at
       ) VALUES (?, ?, 'skipped', ?, ?, 0, 0, 0, 0, 0, NULL, CURRENT_TIMESTAMP)`,
      [projectId, branch.id, JSON.stringify(summaryPayload), JSON.stringify(detailsPayload)]
    );

    await run(
      `UPDATE branches
       SET status = 'ready-for-merge',
           ahead_commits = 0,
           last_test_run_id = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [testRunId, branch.id]
    );

    const latestRunRow = await get(
      `SELECT tr.*, b.name as branch_name
       FROM test_runs tr
       LEFT JOIN branches b ON b.id = tr.branch_id
       WHERE tr.id = ?`,
      [testRunId]
    );

    return serializeTestRun(latestRunRow);
  };

  const runTestsForBranch = async (projectId, branchName, options = {}) => {
    await ensureProjectExists(projectId);
    await ensureMainBranch(projectId);

    let branch;
    if (branchName) {
      branch = await getBranchByName(projectId, branchName);
    } else {
      branch = await get(
        'SELECT * FROM branches WHERE project_id = ? AND is_current = 1 LIMIT 1',
        [projectId]
      );

      if (!branch) {
        branch = await ensureMainBranch(projectId);
      }
    }

    const { context, isCssOnly: isCssOnlyBranch, indicator: cssOnlyIndicator } =
      await determineCssOnlyStatus(projectId, branch);

    if (isCssOnlyBranch) {
      return recordCssOnlySkipRun({ projectId, branch, indicator: cssOnlyIndicator });
    }

    const { lastID: testRunId } = await run(
      `INSERT INTO test_runs (project_id, branch_id, status)
     VALUES (?, ?, 'running')`,
      [projectId, branch.id]
    );

    const shouldSimulate = Boolean(options.forceFail) || (isTestMode() && options.real !== true);

    const runJob = async ({ displayName, command, args, cwd, env = {} }) => {
      const job = startJob({
        projectId,
        type: 'test-run',
        displayName,
        command,
        args,
        cwd,
        env
      });
      try {
        if (typeof options.onJobStarted === 'function') {
          options.onJobStarted(job);
        }
      } catch {
        // ignore hook errors
      }

      const completed = await waitForJobCompletion(job.id);

      try {
        if (typeof options.onJobCompleted === 'function') {
          options.onJobCompleted(completed);
        }
      } catch {
        // ignore hook errors
      }

      return completed;
    };

    const readJsonIfExists = (filePath) => readJsonIfExistsInFs(fs, filePath);

    const collectWorkspaceResults = async (projectContext) => {
      const context = projectContext || (await getProjectContext(projectId));
      if (!context.projectPath) {
        throw withStatusCode(new Error('Project path not found'), 400);
      }


      const projectRoot = context.projectPath;
      const { workspaces, nodeWorkspaceNames } = await discoverWorkspaces({ projectRoot, fs, path });

      if (!workspaces.length) {
        throw withStatusCode(new Error('Test runner not configured (no package.json or requirements.txt found)'), 400);
      }

      const {
        defaultThresholds: thresholds,
        enforceChangedFileCoverage,
        resolveWorkspaceThresholds,
        resolveChangedFileThresholds
      } = await resolveWorkspaceThresholdConfig(projectId, options);
      const includeCoverageLineRefs = options.includeCoverageLineRefs === true;
      const changedPaths = await resolveChangedPaths({
        options,
        context,
        branch,
        listBranchChangedPaths,
        parseStagedFiles
      });

      const selectedWorkspaces = selectWorkspacesForScope({
        workspaces,
        workspaceScope: options.workspaceScope,
        changedPaths
      });

      const workspaceRuns = [];
      const coverageSummaries = [];
      const changedFilesGates = [];
      const uncoveredLines = [];

      for (const workspace of selectedWorkspaces) {
        const workspaceThresholds = resolveWorkspaceThresholds(workspace.name);
        const workspaceChangedFileThresholds = resolveChangedFileThresholds(workspace.name);
        const startedAt = Date.now();
        let coverageJob;
        let coverageSummary = null;

        if (workspace.kind === 'node') {
          if (shouldInstallNodeDependencies({ workspaceName: workspace.name, changedPaths })) {
            await runJob({
              displayName: `${workspace.name} install dependencies`,
              command: 'npm',
              args: ['install'],
              cwd: workspace.cwd
            });
          }

          // Run coverage command (it also runs tests).
          // Prefer npm run test:coverage, fall back to npm test -- --coverage.
          const pkgPath = path.join(workspace.cwd, 'package.json');
          const pkg = await readJsonIfExists(pkgPath);
          const scripts = pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};

          const hasTestCoverageScript = typeof scripts['test:coverage'] === 'string' && scripts['test:coverage'].trim();
          const command = 'npm';
          const args = hasTestCoverageScript
            ? ['run', 'test:coverage']
            : ['test', '--', '--coverage'];

          coverageJob = await runJob({
            displayName: `${workspace.name} tests (coverage)` ,
            command,
            args,
            cwd: workspace.cwd
          });
        } else {
          // python
          coverageJob = await runJob({
            displayName: `${workspace.name} tests (coverage)` ,
            command: 'python',
            args: ['-m', 'pytest', '--cov', '--cov-report=json:coverage.json'],
            cwd: workspace.cwd
          });
        }

        // Attempt to parse coverage summary.
        if (workspace.kind === 'node') {
          const { coverageSummaryJson, coverageSummary: nodeCoverageSummary, uncoveredLines: nodeUncoveredLines } =
            await readNodeWorkspaceCoverage({
              path,
              workspace,
              changedPaths,
              nodeWorkspaceNames,
              readJsonIfExists,
              includeAllFiles: includeCoverageLineRefs
            });

          coverageSummary = nodeCoverageSummary;
          if (Array.isArray(nodeUncoveredLines) && nodeUncoveredLines.length) {
            uncoveredLines.push(...nodeUncoveredLines);
          }

          changedFilesGates.push(
            buildChangedFilesGateForWorkspace({
              workspaceName: workspace.name,
              workspaceCoverageSummary: coverageSummaryJson,
              changedPaths,
              changedFileThresholds: workspaceChangedFileThresholds,
              enforceChangedFileCoverage,
              nodeWorkspaceNames
            })
          );
        } else {
          const summaryPath = path.join(workspace.cwd, 'coverage.json');
          const parsed = await readJsonIfExists(summaryPath);
          // pytest-cov JSON shape differs; keep it raw for now.
          if (parsed) {
            coverageSummary = { raw: parsed };
          }
        }

        const durationMs = Date.now() - startedAt;
        const combinedLogs = (coverageJob?.logs || []).map((entry) => `${entry.stream}: ${entry.message}`);

        workspaceRuns.push({
          workspace: workspace.name,
          kind: workspace.kind,
          status: coverageJob?.status,
          exitCode: coverageJob?.exitCode ?? null,
          durationMs,
          logs: combinedLogs,
          coverage: coverageSummary,
          coverageThresholds: workspaceThresholds
        });

        if (coverageSummary && coverageSummary.lines != null) {
          coverageSummaries.push(coverageSummary);
        }
      }

      const anyFailed = workspaceRuns.some((run) => run.status !== JOB_STATUS.SUCCEEDED);

      // Coverage gate (Node coverage only for now; python raw is not scored yet).
      let coverageGate = {
        thresholds,
        passed: true,
        missing: [],
        totals: null,
        changedFiles: null,
        workspaceThresholds: {},
        uncoveredLines: uncoveredLines.length ? uncoveredLines : null
      };

      const scoredRuns = workspaceRuns.filter((run) => run.coverage && run.coverage.lines != null);
      if (scoredRuns.length) {
        const perWorkspaceEvaluations = scoredRuns.map((run) => {
          /* v8 ignore next -- defensive fallback: coverageThresholds is always populated when workspaceRuns are built */
          const runThresholds = run.coverageThresholds || thresholds;
          const totals = {
            lines: Number(run.coverage.lines),
            statements: Number(run.coverage.statements),
            functions: Number(run.coverage.functions),
            branches: Number(run.coverage.branches)
          };
          const passed =
            totals.lines >= runThresholds.lines &&
            totals.statements >= runThresholds.statements &&
            totals.functions >= runThresholds.functions &&
            totals.branches >= runThresholds.branches;

          return {
            workspace: run.workspace,
            passed,
            totals,
            thresholds: runThresholds
          };
        });

        const totals = {
          lines: Math.min(...scoredRuns.map((run) => Number(run.coverage.lines))),
          statements: Math.min(...scoredRuns.map((run) => Number(run.coverage.statements))),
          functions: Math.min(...scoredRuns.map((run) => Number(run.coverage.functions))),
          branches: Math.min(...scoredRuns.map((run) => Number(run.coverage.branches)))
        };
        coverageGate.totals = totals;
        coverageGate.workspaceThresholds = Object.fromEntries(
          scoredRuns.map((run) => {
            /* v8 ignore next -- defensive fallback: coverageThresholds is always populated when workspaceRuns are built */
            return [run.workspace, run.coverageThresholds || thresholds];
          })
        );
        coverageGate.workspaceRuns = perWorkspaceEvaluations;
        coverageGate.passed = perWorkspaceEvaluations.every((run) => run.passed);

        const anyApplicable = changedFilesGates.some((gate) => gate && gate.skipped !== true);
        const totalsForChanged = changedFilesGates
          .map((gate) => gate?.totals)
          .filter(Boolean);

        coverageGate.changedFiles = {
          thresholds: null,
          passed: !anyApplicable || changedFilesGates.every((gate) => gate?.passed !== false),
          missing: changedFilesGates.flatMap((gate) => gate.missing),
          totals: totalsForChanged.length
            ? {
                lines: Math.min(...totalsForChanged.map((value) => Number(value.lines))),
                statements: Math.min(...totalsForChanged.map((value) => Number(value.statements))),
                functions: Math.min(...totalsForChanged.map((value) => Number(value.functions))),
                branches: Math.min(...totalsForChanged.map((value) => Number(value.branches)))
              }
            : null,
          workspaces: changedFilesGates
        };
      } else {
        // If we ran node tests but couldn't find coverage, treat as a failure when enforcing coverage.
        const ranNode = workspaceRuns.some((run) => run.kind === 'node');
        if (ranNode) {
          coverageGate.passed = false;
          coverageGate.missing = workspaceRuns
            .filter((run) => !run.coverage || run.coverage.lines == null)
            .map((run) => run.workspace);
        }
      }

      const changedFilesPassed = coverageGate.changedFiles ? coverageGate.changedFiles.passed : true;
      const passed = !anyFailed && coverageGate.passed && changedFilesPassed;

      return {
        status: passed ? 'passed' : 'failed',
        summary: {
          total: 0,
          passed: passed ? 0 : 0,
          failed: passed ? 0 : 0,
          skipped: 0,
          duration: Number((workspaceRuns.reduce((acc, run) => acc + (run.durationMs || 0), 0) / 1000).toFixed(2)),
          coverage: coverageGate
        },
        tests: [],
        workspaceRuns
      };
    };

    const resultPayload = shouldSimulate
      ? buildTestResultPayload(branch.name, options.forceFail || false)
      : await collectWorkspaceResults(context);

    await run(
      `UPDATE test_runs
     SET status = ?,
         summary = ?,
         details = ?,
         total_tests = ?,
         passed_tests = ?,
         failed_tests = ?,
         skipped_tests = ?,
         duration = ?,
         error = ?,
         completed_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
      [
        resultPayload.status,
        JSON.stringify(resultPayload.summary),
        JSON.stringify({ tests: resultPayload.tests, workspaceRuns: resultPayload.workspaceRuns || [] }),
        resultPayload.summary.total,
        resultPayload.summary.passed,
        resultPayload.summary.failed,
        resultPayload.summary.skipped,
        resultPayload.summary.duration,
        resultPayload.status === 'failed' ? `Branch ${branch.name} has failing tests` : null,
        testRunId
      ]
    );

    await run(
      `UPDATE branches
     SET status = ?,
         ahead_commits = ?,
         last_test_run_id = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
      [
        resultPayload.status === 'passed' ? 'ready-for-merge' : 'needs-fix',
        resultPayload.status === 'passed' ? 0 : Math.max(branch.ahead_commits || 1, 1),
        testRunId,
        branch.id
      ]
    );

    const latestRunRow = await get(
      `SELECT tr.*, b.name as branch_name
     FROM test_runs tr
     LEFT JOIN branches b ON b.id = tr.branch_id
     WHERE tr.id = ?`,
      [testRunId]
    );

    return serializeTestRun(latestRunRow);
  };

  const collectJobProofCandidates = (options = {}) => {
    const pool = [];
    if (options.frontendJobId) {
      pool.push(options.frontendJobId);
    }
    if (options.backendJobId) {
      pool.push(options.backendJobId);
    }
    if (Array.isArray(options.jobIds)) {
      pool.push(...options.jobIds);
    }

    return Array.from(new Set(pool
      .map((value) => (typeof value === 'string' ? value.trim() : String(value || '').trim()))
      .filter(Boolean)));
  };

  const resolveWorkspaceLabel = (type = '') => {
    const normalized = String(type || '').toLowerCase();
    if (normalized.startsWith('frontend')) {
      return 'frontend';
    }
    if (normalized.startsWith('backend')) {
      return 'backend';
    }
    return type || 'test-run';
  };

  const recordJobProofForBranch = async (projectId, branchName, options = {}) => {
    if (typeof getJob !== 'function') {
      throw withStatusCode(new Error('Test job inspection unavailable'), 500);
    }

    await ensureProjectExists(projectId);
    const branch = await getBranchByName(projectId, branchName);

    const jobIds = collectJobProofCandidates(options);
    if (!jobIds.length) {
      throw withStatusCode(new Error('Provide at least one completed test job id'), 400);
    }

    const resolvedJobs = jobIds.map((jobId) => {
      const job = getJob(jobId);
      if (!job) {
        throw withStatusCode(new Error(`Job ${jobId} not found`), 404);
      }
      if (Number(job.projectId) !== Number(projectId)) {
        throw withStatusCode(new Error('Test job does not belong to this project'), 400);
      }
      if (!job.type || (!job.type.endsWith(':test') && job.type !== 'test-run')) {
        throw withStatusCode(new Error('Only completed test jobs can prove a branch'), 400);
      }
      if (job.status !== JOB_STATUS.SUCCEEDED) {
        throw withStatusCode(new Error(`Job ${jobId} has not completed successfully`), 400);
      }
      return job;
    });

    const toTimestamp = (value) => {
      const numeric = Date.parse(value);
      return Number.isFinite(numeric) ? numeric : null;
    };

    const workspaceRuns = resolvedJobs.map((job) => {
      const startMs = toTimestamp(job.startedAt);
      const endMs = toTimestamp(job.completedAt);
      const durationMs = (startMs != null && endMs != null && endMs >= startMs)
        ? endMs - startMs
        : null;

      const args = Array.isArray(job.args) ? job.args : [];
      const command = [job.command, ...args].filter(Boolean).join(' ').trim();

      return {
        workspace: resolveWorkspaceLabel(job.type),
        status: 'succeeded',
        durationMs,
        command,
        cwd: job.cwd || null,
        jobId: job.id,
        jobType: job.type
      };
    });

    const totalDurationSeconds = workspaceRuns
      .map((run) => (run.durationMs || 0) / 1000)
      .reduce((acc, value) => acc + value, 0);

    const summaryPayload = {
      total: workspaceRuns.length,
      passed: workspaceRuns.length,
      failed: 0,
      skipped: 0,
      duration: Number(totalDurationSeconds.toFixed(2)),
      coverage: {
        passed: true,
        proofSource: 'recorded-jobs',
        jobs: workspaceRuns.map((run) => ({
          workspace: run.workspace,
          jobId: run.jobId,
          durationMs: run.durationMs
        }))
      }
    };

    const detailsPayload = {
      tests: [],
      workspaceRuns
    };

    const { lastID: testRunId } = await run(
      `INSERT INTO test_runs (
         project_id,
         branch_id,
         status,
         summary,
         details,
         total_tests,
         passed_tests,
         failed_tests,
         skipped_tests,
         duration,
         error,
         completed_at
       ) VALUES (?, ?, 'passed', ?, ?, ?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP)`,
      [
        projectId,
        branch.id,
        JSON.stringify(summaryPayload),
        JSON.stringify(detailsPayload),
        summaryPayload.total,
        summaryPayload.passed,
        summaryPayload.failed,
        summaryPayload.skipped,
        summaryPayload.duration
      ]
    );

    await run(
      `UPDATE branches
       SET status = 'ready-for-merge',
           ahead_commits = 0,
           last_test_run_id = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [testRunId, branch.id]
    );

    const latestRunRow = await get(
      `SELECT tr.*, b.name as branch_name
       FROM test_runs tr
       LEFT JOIN branches b ON b.id = tr.branch_id
       WHERE tr.id = ?`,
      [testRunId]
    );

    return serializeTestRun(latestRunRow);
  };

  const api = {
    runTestsForBranch,
    scheduleAutoTests,
    cancelScheduledAutoTests,
    recordJobProofForBranch,
    determineCssOnlyStatus
  };

  api.__testHooks = {
    collectJobProofCandidates,
    resolveWorkspaceLabel,
    recordCssOnlySkipRun,
    shouldInstallNodeDependencies
  };

  return api;
};
