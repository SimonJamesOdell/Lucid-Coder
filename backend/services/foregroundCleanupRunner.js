import { applyCodeChange } from './codeEditAgent.js';
import {
  checkoutBranch,
  commitBranchChanges,
  createWorkingBranch,
  deleteBranchByName,
  getBranchHeadSha,
  resetBranchToCommit,
  runTestsForBranch
} from './branchWorkflow.js';
import { jobEvents } from './jobRunner.js';

const noop = () => {};

const createCancelledError = (branchName) => {
  const error = new Error('Cleanup cancelled');
  error.code = 'CLEANUP_CANCELLED';
  if (typeof branchName === 'string' && branchName.trim()) {
    error.branchName = branchName.trim();
  }
  return error;
};

const defaultThresholds = Object.freeze({ lines: 100, statements: 100, functions: 100, branches: 100 });

const buildIterationPrompt = ({ basePrompt, includeFrontend, includeBackend, pruneRedundantTests, iteration }) => {
  const scope = [includeFrontend ? 'frontend' : null, includeBackend ? 'backend' : null].filter(Boolean).join(' + ');
  const pruneLine = pruneRedundantTests
    ? 'If you delete dead code, remove/update tests that exist solely to cover that dead code.'
    : 'Do not delete tests unless they are invalidated by your change.';

  const parts = [
    `Task: Clean up dead code in this project (${scope || 'codebase'}).`,
    '',
    'Strict safety rules:',
    '- Only remove code that is provably unreachable or unreferenced and not part of any reachable flow.',
    '- If you are not 100% certain a candidate is dead, do not remove it.',
    `- Make at most ONE small, surgical removal per iteration. (Iteration ${iteration})`,
    `- ${pruneLine}`,
    '- Keep behavior identical for all reachable flows.',
    '- Prefer deleting unused exports/modules and unreachable branches over refactors.',
    '',
    'After your edit we will run the full test suite and strict 100% coverage gates. Avoid risky changes.',
    '',
    'User-provided instructions:',
    (basePrompt || '').trim()
  ];

  return parts.join('\n');
};

export const runForegroundCleanup = async ({
  projectId,
  prompt,
  includeFrontend = true,
  includeBackend = true,
  pruneRedundantTests = true,
  options,
  onEvent,
  shouldCancel,
  deps = {}
} = {}) => {
  if (!projectId) {
    throw new Error('projectId is required');
  }

  const emit = typeof onEvent === 'function' ? onEvent : noop;
  const cancelled = typeof shouldCancel === 'function' ? shouldCancel : () => false;

  const subscribeToJobLogs = ({ jobId, phase, jobLabel }) => {
    if (!jobId) {
      return noop;
    }

    const handler = (payload) => {
      if (payload?.jobId !== jobId) {
        return;
      }

      emit({
        event: 'tests-log',
        data: {
          phase,
          jobId,
          label: jobLabel || null,
          stream: payload?.entry?.stream || 'stdout',
          message: payload?.entry?.message || '',
          timestamp: payload?.entry?.timestamp || null
        }
      });
    };

    jobEvents.on('job:log', handler);
    return () => {
      jobEvents.removeListener('job:log', handler);
    };
  };

  const {
    edit,
    runTests,
    createBranch,
    checkout,
    commit,
    getHeadSha,
    resetTo,
    deleteBranch
  } = {
    edit: applyCodeChange,
    runTests: runTestsForBranch,
    createBranch: createWorkingBranch,
    checkout: checkoutBranch,
    commit: commitBranchChanges,
    getHeadSha: getBranchHeadSha,
    resetTo: resetBranchToCommit,
    deleteBranch: deleteBranchByName,
    ...deps
  };

  const coverageThresholds = {
    ...defaultThresholds,
    ...(options?.coverageThresholds && typeof options.coverageThresholds === 'object' ? options.coverageThresholds : {})
  };
  const maxIterations = Number.isFinite(options?.maxIterations)
    ? Math.max(1, Math.min(25, Math.floor(options.maxIterations)))
    : 8;
  const verificationFixRetries = Number.isFinite(options?.verificationFixRetries)
    ? Math.max(0, Math.min(5, Math.floor(options.verificationFixRetries)))
    : 2;

  let branchName = null;
  let branchCreated = false;

  const ensureNotCancelled = () => {
    if (cancelled()) {
      throw createCancelledError(branchName);
    }
  };

  try {
    emit({ event: 'status', data: { text: 'Preparing cleanup…' } });
    ensureNotCancelled();

    branchName = `feature/cleanup-${Date.now()}`;
    emit({ event: 'status', data: { text: `Creating working branch ${branchName}…` } });
    await createBranch(projectId, {
      name: branchName,
      description: 'Clean Up tool run',
      type: 'feature'
    });
    branchCreated = true;
    await checkout(projectId, branchName);

    ensureNotCancelled();
    emit({ event: 'status', data: { text: 'Running baseline tests/coverage…' } });

  let stopBaselineLogs = noop;
  const baselineRun = await runTests(projectId, branchName, {
    real: true,
    coverageThresholds,
    onJobStarted: (job) => {
      emit({
        event: 'tests-job',
        data: {
          phase: 'baseline',
          jobId: job?.id || null,
          displayName: job?.displayName || null,
          command: job?.command || null,
          args: job?.args || null,
          cwd: job?.cwd || null
        }
      });
      stopBaselineLogs();
      stopBaselineLogs = subscribeToJobLogs({
        jobId: job?.id,
        phase: 'baseline',
        jobLabel: job?.displayName || null
      });
    },
    onJobCompleted: (job) => {
      stopBaselineLogs();
      stopBaselineLogs = noop;
      emit({
        event: 'tests-job-done',
        data: {
          phase: 'baseline',
          jobId: job?.id || null,
          status: job?.status || null,
          exitCode: job?.exitCode ?? null
        }
      });
    }
  });
  stopBaselineLogs();
  stopBaselineLogs = noop;
  emit({
    event: 'tests',
    data: {
      phase: 'baseline',
      run: baselineRun?.status || null,
      summary: baselineRun?.summary || null,
      workspaceRuns: baselineRun?.workspaceRuns || []
    }
  });
    if (baselineRun?.status !== 'passed' && baselineRun?.status !== 'skipped') {
      emit({
        event: 'status',
        data: {
          text: `Baseline tests/coverage failed. Cleaning up branch ${branchName}…`
        }
      });

      let branchDeleted = false;
      try {
        await deleteBranch(projectId, branchName);
        branchDeleted = true;
      } catch {
        branchDeleted = false;
      }

      return {
        status: 'refused',
        reason: 'baseline-failed',
        branchName,
        branchDeleted
      };
    }

  let lastGoodSha = await getHeadSha(projectId, branchName);

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    ensureNotCancelled();
    emit({ event: 'status', data: { text: `Iteration ${iteration}/${maxIterations}: searching for dead code…` } });

    const iterationPrompt = buildIterationPrompt({
      basePrompt: prompt,
      includeFrontend,
      includeBackend,
      pruneRedundantTests,
      iteration
    });

    const editResult = await edit({ projectId, prompt: iterationPrompt });
    const writeCount = Array.isArray(editResult?.steps)
      ? editResult.steps.filter((step) => step?.type === 'action' && step?.action === 'write_file').length
      : 0;

    emit({
      event: 'edit',
      data: {
        iteration,
        writes: writeCount,
        summary: editResult?.summary || ''
      }
    });

    if (!writeCount) {
      emit({ event: 'status', data: { text: 'No safe dead-code removals found. Stopping.' } });
      return {
        status: 'complete',
        branchName,
        iterations: iteration,
        stoppedBecause: 'no-op'
      };
    }

    ensureNotCancelled();
    emit({ event: 'status', data: { text: 'Running tests/coverage…' } });

    let stopVerifyLogs = noop;
    let verificationRun = await runTests(projectId, branchName, {
      real: true,
      coverageThresholds,
      onJobStarted: (job) => {
        emit({
          event: 'tests-job',
          data: {
            phase: 'verify',
            jobId: job?.id || null,
            displayName: job?.displayName || null,
            command: job?.command || null,
            args: job?.args || null,
            cwd: job?.cwd || null
          }
        });
        stopVerifyLogs();
        stopVerifyLogs = subscribeToJobLogs({
          jobId: job?.id,
          phase: 'verify',
          jobLabel: job?.displayName || null
        });
      },
      onJobCompleted: (job) => {
        stopVerifyLogs();
        stopVerifyLogs = noop;
        emit({
          event: 'tests-job-done',
          data: {
            phase: 'verify',
            jobId: job?.id || null,
            status: job?.status || null,
            exitCode: job?.exitCode ?? null
          }
        });
      }
    });
    stopVerifyLogs();
    stopVerifyLogs = noop;
    emit({
      event: 'tests',
      data: {
        phase: 'verify',
        run: verificationRun?.status || null,
        summary: verificationRun?.summary || null,
        workspaceRuns: verificationRun?.workspaceRuns || []
      }
    });

    if (verificationRun?.status !== 'passed' && verificationRun?.status !== 'skipped') {
      let fixed = false;
      for (let attempt = 1; attempt <= verificationFixRetries; attempt += 1) {
        ensureNotCancelled();
        emit({ event: 'status', data: { text: `Tests failed. Attempting fix (${attempt}/${verificationFixRetries})…` } });
        await edit({
          projectId,
          prompt: [
            'Fix the test/coverage failures caused by the previous cleanup edit.',
            'Be minimal. Do not change reachable behavior.',
            pruneRedundantTests
              ? 'If failures are in tests that only existed for removed dead paths, remove/update those tests accordingly.'
              : 'Prefer fixing code/tests without deleting tests.',
            '',
            'Failure summary:',
            JSON.stringify({ status: verificationRun?.status, summary: verificationRun?.summary || null }, null, 2)
          ].join('\n')
        });

        let stopFixLogs = noop;
        verificationRun = await runTests(projectId, branchName, {
          real: true,
          coverageThresholds,
          onJobStarted: (job) => {
            const phase = `verify-fix-${attempt}`;
            emit({
              event: 'tests-job',
              data: {
                phase,
                jobId: job?.id || null,
                displayName: job?.displayName || null,
                command: job?.command || null,
                args: job?.args || null,
                cwd: job?.cwd || null
              }
            });
            stopFixLogs();
            stopFixLogs = subscribeToJobLogs({
              jobId: job?.id,
              phase,
              jobLabel: job?.displayName || null
            });
          },
          onJobCompleted: (job) => {
            const phase = `verify-fix-${attempt}`;
            stopFixLogs();
            stopFixLogs = noop;
            emit({
              event: 'tests-job-done',
              data: {
                phase,
                jobId: job?.id || null,
                status: job?.status || null,
                exitCode: job?.exitCode ?? null
              }
            });
          }
        });
        stopFixLogs();
        stopFixLogs = noop;

        emit({
          event: 'tests',
          data: {
            phase: `verify-fix-${attempt}`,
            run: verificationRun?.status || null,
            summary: verificationRun?.summary || null,
            workspaceRuns: verificationRun?.workspaceRuns || []
          }
        });

        if (verificationRun?.status === 'passed' || verificationRun?.status === 'skipped') {
          fixed = true;
          break;
        }
      }

      if (!fixed) {
        emit({ event: 'status', data: { text: 'Tests still failing. Rolling back this iteration.' } });
        if (lastGoodSha) {
          await resetTo(projectId, branchName, { commitSha: lastGoodSha, status: 'active' });
        }
        throw new Error('Cleanup iteration failed verification; changes were rolled back.');
      }
    }

    ensureNotCancelled();
    emit({ event: 'status', data: { text: 'Committing verified changes…' } });
    await commit(projectId, branchName, {
      message: `chore(cleanup): dead code removal (${iteration}/${maxIterations})`,
      autoChangelog: false
    });

    lastGoodSha = await getHeadSha(projectId, branchName);
    emit({ event: 'status', data: { text: `Iteration ${iteration} verified.` } });
  }

    emit({ event: 'status', data: { text: 'Reached iteration limit. Cleanup complete.' } });
    return {
      status: 'complete',
      branchName,
      iterations: maxIterations,
      stoppedBecause: 'limit'
    };
  } catch (error) {
    if (error?.code === 'CLEANUP_CANCELLED') {
      return {
        status: 'cancelled',
        branchName,
        canDeleteBranch: Boolean(branchCreated)
      };
    }

    if (branchCreated && branchName) {
      return {
        status: 'failed',
        branchName,
        message: error?.message || 'Cleanup failed',
        canDeleteBranch: true
      };
    }

    throw error;
  }
};

export const __testing = {
  buildIterationPrompt,
  createCancelledError
};
