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

    const readJsonIfExists = async (filePath) => {
      try {
        const raw = await fs.readFile(filePath, 'utf8');
        return JSON.parse(raw);
      } catch {
        return null;
      }
    };

    const pathExists = async (targetPath) => {
      try {
        await fs.access(targetPath);
        return true;
      } catch {
        return false;
      }
    };

    const collectWorkspaceResults = async (projectContext) => {
      const context = projectContext || (await getProjectContext(projectId));
      if (!context.projectPath) {
        throw withStatusCode(new Error('Project path not found'), 400);
      }

      const normalizePathForCompare = (value) => String(value).replace(/\\/g, '/');
      const isRelevantSourceFile = (filePath) => {
        const normalized = normalizePathForCompare(filePath).toLowerCase();
        return (
          normalized.endsWith('.js') ||
          normalized.endsWith('.jsx') ||
          normalized.endsWith('.ts') ||
          normalized.endsWith('.tsx') ||
          normalized.endsWith('.mjs') ||
          normalized.endsWith('.cjs') ||
          normalized.endsWith('.vue')
        );
      };

      const resolveChangedPaths = async () => {
        const explicit = options.changedFiles ?? options.changedPaths;
        if (Array.isArray(explicit)) {
          return explicit.map((entry) => String(entry || '').trim()).filter(Boolean);
        }

        if (context.gitReady) {
          try {
            const changed = await listBranchChangedPaths(context, { baseRef: 'main', branchRef: branch.name });
            if (Array.isArray(changed) && changed.length) {
              return changed;
            }
          } catch {
            // ignore git diff failures
          }
        }

        const stagedFiles = parseStagedFiles(branch.staged_files);
        if (Array.isArray(stagedFiles) && stagedFiles.length) {
          return stagedFiles
            .map((entry) => String(entry?.path || '').trim())
            .filter(Boolean);
        }

        return [];
      };

      const projectRoot = context.projectPath;
      const frontendPath = path.join(projectRoot, 'frontend');
      const backendPath = path.join(projectRoot, 'backend');

      const hasFrontend = await pathExists(path.join(frontendPath, 'package.json'));
      const hasBackendPackage = await pathExists(path.join(backendPath, 'package.json'));
      const hasBackendPython = !hasBackendPackage && (await pathExists(path.join(backendPath, 'requirements.txt')));

      const workspaces = [];
      if (hasFrontend) workspaces.push({ name: 'frontend', cwd: frontendPath, kind: 'node' });
      if (hasBackendPackage) workspaces.push({ name: 'backend', cwd: backendPath, kind: 'node' });
      if (hasBackendPython) workspaces.push({ name: 'backend', cwd: backendPath, kind: 'python' });

      if (!workspaces.length) {
        // Fallback: try running at project root if no conventional workspaces exist.
        const rootHasPackage = await pathExists(path.join(projectRoot, 'package.json'));
        if (rootHasPackage) {
          workspaces.push({ name: 'root', cwd: projectRoot, kind: 'node' });
        }
      }

      if (!workspaces.length) {
        throw withStatusCode(new Error('Test runner not configured (no package.json or requirements.txt found)'), 400);
      }

      const { globalThresholds: thresholds, changedFileThresholds, enforceChangedFileCoverage } = resolveCoveragePolicy(options);
      const changedPaths = await resolveChangedPaths();

      const workspaceScope = typeof options.workspaceScope === 'string' ? options.workspaceScope : 'all';
      let selectedWorkspaces = workspaces;
      if (workspaceScope === 'changed' && workspaces.length > 1 && changedPaths.length > 0) {
        const normalizePathForCompare = (value) => String(value).replace(/\\/g, '/');
        const normalizedChanged = changedPaths.map(normalizePathForCompare);
        const workspaceNames = workspaces.map((workspace) => String(workspace.name));

        const isPrefixedByWorkspace = (value) => workspaceNames.some((name) => value.startsWith(`${name}/`));
        const hasUnscopedChanges = normalizedChanged.some((value) => !isPrefixedByWorkspace(value));

        if (!hasUnscopedChanges) {
          const relevantNames = new Set(
            normalizedChanged
              .map((value) => workspaceNames.find((name) => value.startsWith(`${name}/`)))
              .filter(Boolean)
          );

          selectedWorkspaces = workspaces.filter((workspace) => relevantNames.has(String(workspace.name)));
        }
      }

      const nodeWorkspaceNames = workspaces.filter((workspace) => workspace.kind === 'node').map((workspace) => workspace.name);

      const buildChangedFilesGateForWorkspace = ({ workspaceName, workspaceCoverageSummary }) => {
        const gate = {
          workspace: workspaceName,
          thresholds: changedFileThresholds,
          passed: true,
          missing: [],
          totals: null,
          skipped: false,
          reason: null
        };

        if (!enforceChangedFileCoverage) {
          gate.skipped = true;
          gate.reason = 'disabled';
          return gate;
        }

        const fileKeys = workspaceCoverageSummary && typeof workspaceCoverageSummary === 'object'
          ? Object.keys(workspaceCoverageSummary).filter((key) => key && key !== 'total')
          : [];

        if (fileKeys.length === 0) {
          gate.skipped = true;
          gate.reason = 'per_file_coverage_unavailable';
          return gate;
        }

        const normalizedWorkspacePrefix = `${normalizePathForCompare(workspaceName)}/`;
        const changedForWorkspace = changedPaths
          .map(normalizePathForCompare)
          .filter((value) => {
            if (nodeWorkspaceNames.length <= 1) {
              return true;
            }
            return value.startsWith(normalizedWorkspacePrefix);
          })
          .map((value) => (value.startsWith(normalizedWorkspacePrefix) ? value.slice(normalizedWorkspacePrefix.length) : value))
          .filter(isRelevantSourceFile);

        if (changedForWorkspace.length === 0) {
          return gate;
        }

        const byFile = new Map();
        for (const key of fileKeys) {
          const normalized = normalizePathForCompare(key);
          const entry = workspaceCoverageSummary[key];
          if (entry && typeof entry === 'object') {
            byFile.set(normalized, entry);
          }
        }

        const resolveCoverageEntry = (relativePath) => {
          const normalized = normalizePathForCompare(relativePath);
          if (byFile.has(normalized)) {
            return byFile.get(normalized);
          }
          for (const [key, entry] of byFile.entries()) {
            if (key === normalized || key.endsWith(`/${normalized}`)) {
              return entry;
            }
          }
          return null;
        };

        let totals = {
          lines: 100,
          statements: 100,
          functions: 100,
          branches: 100
        };
        for (const relativePath of changedForWorkspace) {
          const entry = resolveCoverageEntry(relativePath);
          if (!entry) {
            gate.missing.push(`${workspaceName}/${relativePath}`);
            continue;
          }

          const linesPct = Number(entry?.lines?.pct);
          const statementsPct = Number(entry?.statements?.pct);
          const functionsPct = Number(entry?.functions?.pct);
          const branchesPct = Number(entry?.branches?.pct);

          if (
            !Number.isFinite(linesPct) ||
            !Number.isFinite(statementsPct) ||
            !Number.isFinite(functionsPct) ||
            !Number.isFinite(branchesPct)
          ) {
            gate.missing.push(`${workspaceName}/${relativePath}`);
            continue;
          }

          totals = {
            lines: Math.min(totals.lines, linesPct),
            statements: Math.min(totals.statements, statementsPct),
            functions: Math.min(totals.functions, functionsPct),
            branches: Math.min(totals.branches, branchesPct)
          };
        }

        gate.totals = totals;
        gate.passed =
          gate.missing.length === 0 &&
          totals.lines >= changedFileThresholds.lines &&
          totals.statements >= changedFileThresholds.statements &&
          totals.functions >= changedFileThresholds.functions &&
          totals.branches >= changedFileThresholds.branches;

        return gate;
      };

      const workspaceRuns = [];
      const coverageSummaries = [];
      const changedFilesGates = [];
      const uncoveredLines = [];

      const extractUncoveredLines = (coverageEntry) => {
        if (!coverageEntry || typeof coverageEntry !== 'object') {
          return [];
        }

        const lineMap = coverageEntry.l;
        if (lineMap && typeof lineMap === 'object') {
          const lines = Object.entries(lineMap)
            .map(([line, count]) => ({ line: Number(line), count: Number(count) }))
            .filter((entry) => Number.isFinite(entry.line) && entry.count === 0)
            .map((entry) => entry.line)
            .sort((a, b) => a - b);
          return Array.from(new Set(lines));
        }

        const statementMap = coverageEntry.statementMap;
        const statementCounts = coverageEntry.s;
        if (!statementMap || typeof statementMap !== 'object' || !statementCounts || typeof statementCounts !== 'object') {
          return [];
        }

        const lines = [];
        for (const key of Object.keys(statementMap)) {
          const hitCount = Number(statementCounts[key]);
          if (Number.isFinite(hitCount) && hitCount > 0) {
            continue;
          }
          const loc = statementMap[key];
          const startLine = Number(loc?.start?.line);
          const endLine = Number(loc?.end?.line);
          if (!Number.isFinite(startLine)) {
            continue;
          }
          if (!Number.isFinite(endLine) || endLine === startLine) {
            lines.push(startLine);
            continue;
          }
          const boundedEnd = Math.min(endLine, startLine + 25);
          for (let line = startLine; line <= boundedEnd; line += 1) {
            lines.push(line);
          }
        }

        lines.sort((a, b) => a - b);
        return Array.from(new Set(lines));
      };

      for (const workspace of selectedWorkspaces) {
        const startedAt = Date.now();
        let coverageJob;
        let coverageSummary = null;

        if (workspace.kind === 'node') {
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
          const summaryPath = path.join(workspace.cwd, 'coverage', 'coverage-summary.json');
          const parsed = await readJsonIfExists(summaryPath);
          const totals = parsed?.total;
          if (totals) {
            coverageSummary = {
              lines: totals.lines?.pct,
              statements: totals.statements?.pct,
              functions: totals.functions?.pct,
              branches: totals.branches?.pct
            };
          }

          const normalizedWorkspacePrefix = `${normalizePathForCompare(workspace.name)}/`;
          const changedForWorkspace = changedPaths
            .map(normalizePathForCompare)
            .filter((value) => {
              if (nodeWorkspaceNames.length <= 1) {
                return true;
              }
              return value.startsWith(normalizedWorkspacePrefix);
            })
            .map((value) => (value.startsWith(normalizedWorkspacePrefix) ? value.slice(normalizedWorkspacePrefix.length) : value))
            .filter(isRelevantSourceFile);

          if (changedForWorkspace.length) {
            const finalPath = path.join(workspace.cwd, 'coverage', 'coverage-final.json');
            const finalCoverage = await readJsonIfExists(finalPath);
            if (finalCoverage && typeof finalCoverage === 'object') {
              const byFile = new Map();
              for (const key of Object.keys(finalCoverage)) {
                const normalized = normalizePathForCompare(key);
                const entry = finalCoverage[key];
                if (entry && typeof entry === 'object') {
                  byFile.set(normalized, entry);
                }
              }

              const resolveCoverageEntry = (relativePath) => {
                const normalized = normalizePathForCompare(relativePath);
                if (byFile.has(normalized)) {
                  return byFile.get(normalized);
                }
                for (const [key, entry] of byFile.entries()) {
                  if (key.endsWith(`/${normalized}`)) {
                    return entry;
                  }
                }
                return null;
              };

              for (const relativePath of changedForWorkspace) {
                const entry = resolveCoverageEntry(relativePath);
                const lines = extractUncoveredLines(entry);
                if (lines.length) {
                  uncoveredLines.push({ workspace: workspace.name, file: relativePath, lines });
                }
              }
            }
          }

          changedFilesGates.push(
            buildChangedFilesGateForWorkspace({
              workspaceName: workspace.name,
              workspaceCoverageSummary: parsed
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
          coverage: coverageSummary
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
        uncoveredLines: uncoveredLines.length ? uncoveredLines : null
      };

      const scoredRuns = workspaceRuns.filter((run) => run.coverage && run.coverage.lines != null);
      if (scoredRuns.length) {
        const totals = {
          lines: Math.min(...scoredRuns.map((run) => Number(run.coverage.lines))),
          statements: Math.min(...scoredRuns.map((run) => Number(run.coverage.statements))),
          functions: Math.min(...scoredRuns.map((run) => Number(run.coverage.functions))),
          branches: Math.min(...scoredRuns.map((run) => Number(run.coverage.branches)))
        };
        coverageGate.totals = totals;
        coverageGate.passed =
          totals.lines >= thresholds.lines &&
          totals.statements >= thresholds.statements &&
          totals.functions >= thresholds.functions &&
          totals.branches >= thresholds.branches;

        const anyApplicable = changedFilesGates.some((gate) => gate && gate.skipped !== true);
        const totalsForChanged = changedFilesGates
          .map((gate) => gate?.totals)
          .filter(Boolean);

        coverageGate.changedFiles = {
          thresholds: changedFileThresholds,
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
    recordCssOnlySkipRun
  };

  return api;
};
