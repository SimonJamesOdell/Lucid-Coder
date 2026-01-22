import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import axios from 'axios';
import { useAppState } from '../context/AppStateContext';
import Modal from './Modal';
import TestSuiteCard from './test-tab/TestSuiteCard';
import {
  TEST_JOB_TYPES,
  statusLabel,
  isJobActive,
  isJobFinal,
  extractFailingTestIdsFromJob,
  buildTestFixPlan,
  formatDurationSeconds,
  classifyLogToken,
  formatLogMessage,
  renderLogLines,
  buildProofFailureMessage,
  buildJobFailureContext,
  buildTestFailureContext,
  getAutofixMaxAttempts,
  setClassifyLogTokenOverride,
  resetClassifyLogTokenOverride,
  setAutofixMaxAttemptsOverride,
  resetAutofixMaxAttemptsOverride,
  isAutofixHalted
} from './test-tab/helpers.jsx';
import { useSubmitProof } from './test-tab/useSubmitProof';
import './TestTab.css';

const TestTab = ({ project, registerTestActions, onRequestCommitsTab }) => {
  const {
    startAutomationJob,
    cancelAutomationJob,
    getJobsForProject,
    jobState,
    refreshJobs,
    workspaceChanges,
    workingBranches,
    syncBranchOverview,
    markTestRunIntent,
    testRunIntent
  } = useAppState();
  const [localError, setLocalError] = useState(null);
  const [isResultModalOpen, setIsResultModalOpen] = useState(false);
  const [resultModalVariant, setResultModalVariant] = useState('default');
  const [resultModalTitle, setResultModalTitle] = useState('');
  const [resultModalMessage, setResultModalMessage] = useState('');
  const [resultModalConfirmText, setResultModalConfirmText] = useState(null);
  const [resultModalConfirmAction, setResultModalConfirmAction] = useState(null);
  const [resultModalProcessing, setResultModalProcessing] = useState(false);
  const [resultModalProcessingMessage, setResultModalProcessingMessage] = useState('');
  const [canResumeCommitFlow, setCanResumeCommitFlow] = useState(false);
  const [resultModalRequiresExplicitDismiss, setResultModalRequiresExplicitDismiss] = useState(false);
  const projectId = project?.id;
  const jobs = useMemo(() => getJobsForProject(projectId), [getJobsForProject, projectId]);
  const jobsLastFetchedAt = useMemo(() => {
    if (!projectId) {
      return null;
    }
    return jobState.jobsByProject[String(projectId)]?.lastFetchedAt || null;
  }, [jobState.jobsByProject, projectId]);

  const lastResultModalKeyRef = useRef(null);
  const testTabMountedAtRef = useRef(Date.now());
  const hasObservedTestRunRef = useRef(false);
  const suppressedModalJobIdsRef = useRef(new Set());
  const autoFixSessionRef = useRef({
    active: false,
    origin: 'user',
    attempt: 0,
    maxAttempts: getAutofixMaxAttempts()
  });

  const resetCommitResumeState = useCallback(() => {
    setCanResumeCommitFlow(false);
    setResultModalRequiresExplicitDismiss(false);
  }, []);

  const testJobs = useMemo(
    () => jobs.filter((job) => job.type?.endsWith(':test')),
    [jobs]
  );

  const jobsByType = useMemo(() => {
    return TEST_JOB_TYPES.reduce((acc, config) => {
      const latest = testJobs
        .filter((job) => job.type === config.type)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
      acc[config.type] = latest || null;
      return acc;
    }, {});
  }, [testJobs]);

  const triggerTestFix = useCallback(({ origin = 'user' } = {}) => {
    const frontendJob = jobsByType['frontend:test'];
    const backendJob = jobsByType['backend:test'];
    const plan = buildTestFixPlan({
      jobs: [
        { label: 'Frontend tests', kind: 'frontend', job: frontendJob },
        { label: 'Backend tests', kind: 'backend', job: backendJob }
      ]
    });

    if (typeof window !== 'undefined') {
      // Do not route failing-test fixes through the generic agent planner.
      // Instead, emit an event that creates a new goal to fix tests and then re-runs suites.
      window.dispatchEvent(new CustomEvent('lucidcoder:autofix-tests', { detail: { ...plan, origin } }));
    }
  }, [jobsByType, project]);

  const activeJobs = useMemo(
    () => TEST_JOB_TYPES.map((config) => jobsByType[config.type]).filter(isJobActive),
    [jobsByType]
  );

  const allTestsCompleted = useMemo(() => {
    const frontendJob = jobsByType['frontend:test'];
    const backendJob = jobsByType['backend:test'];
    if (!frontendJob || !backendJob) {
      return false;
    }
    return isJobFinal(frontendJob) && isJobFinal(backendJob);
  }, [jobsByType]);

  const didTestsPass = useMemo(() => {
    if (!allTestsCompleted) {
      return false;
    }
    const frontendJob = jobsByType['frontend:test'];
    const backendJob = jobsByType['backend:test'];
    return frontendJob?.status === 'succeeded' && backendJob?.status === 'succeeded';
  }, [allTestsCompleted, jobsByType]);

  const activeWorkingBranch = projectId ? workingBranches?.[projectId] : null;
  const activeBranchName = typeof activeWorkingBranch?.name === 'string' ? activeWorkingBranch.name : '';
  const stagedFiles = useMemo(() => {
    const branchFiles = Array.isArray(activeWorkingBranch?.stagedFiles) ? activeWorkingBranch.stagedFiles : null;
    if (branchFiles) {
      return branchFiles;
    }
    const workspaceFiles = projectId && workspaceChanges?.[projectId]?.stagedFiles;
    return Array.isArray(workspaceFiles) ? workspaceFiles : [];
  }, [activeWorkingBranch?.stagedFiles, projectId, workspaceChanges]);

  const activeError = localError || jobState.error;

  const submitProofIfNeeded = useSubmitProof({
    projectId,
    activeBranchName,
    activeWorkingBranch,
    jobsByType,
    syncBranchOverview,
    testRunIntent,
    allTestsCompleted
  });

  useEffect(() => {
    // Reset per-project guards so we don't show completion modals from stale job history
    // when navigating into the Test tab.
    testTabMountedAtRef.current = Date.now();
    hasObservedTestRunRef.current = false;
    lastResultModalKeyRef.current = null;
    suppressedModalJobIdsRef.current = new Set();
    autoFixSessionRef.current = {
      active: false,
      origin: 'user',
      attempt: 0,
      maxAttempts: getAutofixMaxAttempts()
    };
    resetCommitResumeState();
  }, [projectId, resetCommitResumeState]);

  useEffect(() => {
    if (!projectId) {
      return;
    }

    const frontendJob = jobsByType['frontend:test'];
    const backendJob = jobsByType['backend:test'];
    const candidates = [frontendJob, backendJob].filter(Boolean);

    // If we ever observe a non-final test job (or a freshly created job while mounted),
    // treat that as "this tab has observed a test run" and only then allow result modals.
    const sawActiveJob = candidates.some((job) => job && !isJobFinal(job));

    const mountedAt = testTabMountedAtRef.current;
    const sawNewJobWhileMounted = candidates.some((job) => {
      if (!job?.createdAt) {
        return false;
      }
      const createdTime = new Date(job.createdAt).getTime();
      return Number.isFinite(createdTime) && createdTime >= mountedAt;
    });

    if (sawActiveJob || sawNewJobWhileMounted) {
      hasObservedTestRunRef.current = true;
    }
  }, [jobsByType, projectId]);

  useEffect(() => {
    if (!projectId) {
      resetCommitResumeState();
      return;
    }

    if (!allTestsCompleted) {
      resetCommitResumeState();
      return;
    }

    // Avoid showing "Tests passed" immediately when the page has historical completed jobs,
    // but the user just kicked off a new run and the new jobs haven't appeared yet.
    if (!hasObservedTestRunRef.current) {
      resetCommitResumeState();
      return;
    }

    const frontendJob = jobsByType['frontend:test'];
    const backendJob = jobsByType['backend:test'];

    // If either suite reports cancelled, do not treat that as a failure (and do not
    // lock in a modal key), because some job runners may transiently report cancelled
    // even when work continues in the background.
    if (frontendJob?.status === 'cancelled' || backendJob?.status === 'cancelled') {
      resetCommitResumeState();
      return;
    }

    // If the user explicitly cancelled these job ids, suppress any pass/fail modals
    // for that run.
    const suppressedIds = suppressedModalJobIdsRef.current;
    if (frontendJob?.id && suppressedIds.has(frontendJob.id)) {
      resetCommitResumeState();
      return;
    }
    if (backendJob?.id && suppressedIds.has(backendJob.id)) {
      resetCommitResumeState();
      return;
    }

    const modalKey = `${frontendJob?.id || 'none'}@${frontendJob?.createdAt || frontendJob?.completedAt || 'na'}:${backendJob?.id || 'none'}@${backendJob?.createdAt || backendJob?.completedAt || 'na'}`;

    if (lastResultModalKeyRef.current === modalKey) {
      return;
    }

    lastResultModalKeyRef.current = modalKey;

    // Clear any in-flight auto-fix loop when tests pass.
    if (didTestsPass) {
      autoFixSessionRef.current = {
        active: false,
        origin: 'user',
        attempt: 0,
        maxAttempts: getAutofixMaxAttempts()
      };
    }

    if (didTestsPass) {
      const lastRunSource = typeof testRunIntent?.source === 'string' ? testRunIntent.source : 'unknown';
      const shouldReturnToCommits = Boolean(testRunIntent?.returnToCommits);

      // Only offer commit / prove-branch flows for automation-driven runs.
      // Manual test runs should never auto-suggest or attempt commits.
      if (lastRunSource !== 'automation') {
        resetCommitResumeState();
        return;
      }

      const stagedCount = stagedFiles.length;

      if (!activeBranchName || activeBranchName === 'main') {
        resetCommitResumeState();
        setResultModalVariant('danger');
        setResultModalTitle('Cannot commit');
        setResultModalMessage('Frontend and backend tests passed, but there is no active working branch selected for committing. Switch to a feature branch and try again.');
        setResultModalConfirmText(null);
        setResultModalConfirmAction(null);
        setResultModalProcessing(false);
        setResultModalProcessingMessage('');
        setIsResultModalOpen(true);
        return;
      }

      if (stagedCount === 0) {
        resetCommitResumeState();
        setResultModalVariant('default');
        setResultModalTitle('Nothing to commit');
        setResultModalMessage('Frontend and backend tests both passed, but this branch has no staged changes. There is nothing to commit.');
        setResultModalConfirmText(null);
        setResultModalConfirmAction(null);
        setResultModalProcessing(false);
        setResultModalProcessingMessage('');
        setIsResultModalOpen(true);
        return;
      }

      if (shouldReturnToCommits) {
        setResultModalProcessing(false);
        setResultModalProcessingMessage('');
        setIsResultModalOpen(false);

        (async () => {
          try {
            await submitProofIfNeeded({
              onBeforeSubmit: () => setResultModalProcessingMessage('Recording test proof…')
            });
          } catch (proofError) {
            /* c8 ignore next */
            const proofMessage = proofError.response?.data?.error
              || proofError.message
              || 'Failed to record branch test proof';
            setLocalError(proofMessage);
            setResultModalVariant('danger');
            setResultModalTitle('Commit failed');
            setResultModalMessage(proofMessage);
            setResultModalConfirmText(null);
            setResultModalConfirmAction(null);
            setIsResultModalOpen(true);
            return;
          }

          onRequestCommitsTab?.();
          resetCommitResumeState();
        })();
        return;
      }

      setResultModalVariant('default');
      setResultModalTitle('Tests passed');
      setResultModalMessage('Frontend and backend tests both passed. Ready to continue to commit?');
      setResultModalConfirmText('Continue to commit');
      setResultModalConfirmAction(() => () => {
        setResultModalProcessing(true);
        setResultModalProcessingMessage('Committing staged changes…');
        setLocalError(null);

        (async () => {
          try {
            const commitUrl = `/api/projects/${projectId}/branches/${encodeURIComponent(activeBranchName)}/commit`;

            const buildModalError = (title, message) => {
              const error = new Error(message);
              error.__lucidcoderModalTitle = title;
              return error;
            };

            const tryCommit = async () => {
              const response = await axios.post(commitUrl);
              if (response.data?.overview && typeof syncBranchOverview === 'function') {
                syncBranchOverview(projectId, response.data.overview);
              }
            };

            const ensureProofRecorded = async () => {
              try {
                const recorded = await submitProofIfNeeded({
                  onBeforeSubmit: () => setResultModalProcessingMessage('Recording test proof…')
                });
                if (recorded) {
                  setResultModalProcessingMessage('Committing staged changes…');
                }
              } catch (proofError) {
                /* c8 ignore next */
                const proofMessage = proofError.response?.data?.error
                  || proofError.message
                  || 'Failed to record branch test proof';
                throw buildModalError('Commit failed', proofMessage);
              }
            };

            try {
              await ensureProofRecorded();
              await tryCommit();
            } catch (commitError) {
              const message = commitError.response?.data?.error || commitError.message || 'Failed to commit staged changes';
              const normalized = String(message).toLowerCase();

              const proofPhrases = [
                'run tests to prove',
                'resolve failing tests and run tests again',
                'resolve failing tests',
                'run backend tests again',
                'record a passing proof'
              ];

              const errorSamples = [
                commitError.response?.data?.error,
                commitError.message,
                message
              ].filter((sample) => typeof sample === 'string');

              const needsProof = errorSamples.some((sample) => {
                const normalizedSample = sample.toLowerCase();
                return proofPhrases.some((phrase) => normalizedSample.includes(phrase));
              });

              if (needsProof) {
                throw buildModalError(
                  'Tests required before commit',
                  'Run backend tests again before committing this branch so the server can record a passing proof.'
                );
              }

              throw commitError;
            }

            setResultModalProcessing(false);
            setResultModalProcessingMessage('');
            setIsResultModalOpen(false);
            onRequestCommitsTab?.();
            resetCommitResumeState();
          } catch (error) {
            const message = error.response?.data?.error || error.message || 'Failed to commit staged changes';
            const title = error.__lucidcoderModalTitle || 'Commit failed';
            setLocalError(message);
            setResultModalProcessing(false);
            setResultModalProcessingMessage('');
            setResultModalVariant('danger');
            setResultModalTitle(title);
            setResultModalMessage(message);
            setResultModalConfirmText('Try again');
            setIsResultModalOpen(true);
          }
        })();
      });
      setResultModalProcessing(false);
      setResultModalProcessingMessage('');
      setIsResultModalOpen(true);
      setResultModalRequiresExplicitDismiss(true);
      setCanResumeCommitFlow(true);
      return;
    }

    resetCommitResumeState();

    const session = autoFixSessionRef.current;
    const lastRunSource = typeof testRunIntent?.source === 'string' ? testRunIntent.source : 'unknown';
    const shouldAutoStartFix = lastRunSource === 'automation' && !session.active;

    if (shouldAutoStartFix && !isAutofixHalted()) {
      autoFixSessionRef.current = {
        active: true,
        origin: 'automation',
        attempt: 0,
        maxAttempts: getAutofixMaxAttempts()
      };
    }

    let activeSession = autoFixSessionRef.current;
    if (activeSession.active) {
      // If the user has halted the auto-fix loop, fall back to manual prompting.
      if (activeSession.origin === 'automation' && isAutofixHalted()) {
        autoFixSessionRef.current = {
          active: false,
          origin: 'user',
          attempt: 0,
          maxAttempts: getAutofixMaxAttempts()
        };
        activeSession = autoFixSessionRef.current;
      } else if (Number.isFinite(activeSession.maxAttempts) && activeSession.attempt >= activeSession.maxAttempts) {
        autoFixSessionRef.current = {
          active: false,
          origin: 'user',
          attempt: 0,
          maxAttempts: getAutofixMaxAttempts()
        };

        resetCommitResumeState();
        setResultModalVariant('danger');
        setResultModalTitle('Tests failed');
        setResultModalMessage(`Auto-fix tried ${activeSession.maxAttempts} times but tests are still failing. Review the logs and try a manual fix.`);
        setResultModalConfirmText(null);
        setResultModalConfirmAction(null);
        setIsResultModalOpen(true);
        return;
      }

      if (activeSession.active) {
        autoFixSessionRef.current = {
          ...activeSession,
          attempt: activeSession.attempt + 1
        };

        triggerTestFix({ origin: activeSession.origin });
        return;
      }
    }

    resetCommitResumeState();
    setResultModalVariant('danger');
    setResultModalTitle('Tests failed');
    setResultModalMessage('One or more test suites failed. Want the AI assistant to help you fix them?');
    setResultModalConfirmText('Fix with AI');
    setResultModalConfirmAction(() => () => {
      autoFixSessionRef.current = {
        active: true,
        origin: 'user',
        attempt: 1,
        maxAttempts: getAutofixMaxAttempts()
      };

      triggerTestFix({ origin: 'user' });
      setIsResultModalOpen(false);
    });
    setResultModalProcessing(false);
    setResultModalProcessingMessage('');
    setIsResultModalOpen(true);
  }, [
    allTestsCompleted,
    didTestsPass,
    jobsByType,
    onRequestCommitsTab,
    project,
    projectId,
    testRunIntent,
    triggerTestFix,
    stagedFiles.length,
    activeBranchName,
    syncBranchOverview,
    resetCommitResumeState,
    submitProofIfNeeded
  ]);

  const handleRun = useCallback(async (type) => {
    setLocalError(null);
    try {
      markTestRunIntent?.('user');
      await startAutomationJob(type, { projectId });
    } catch (error) {
      setLocalError(error.message);
    }
  }, [markTestRunIntent, startAutomationJob, projectId]);

  const runAllTests = useCallback(async (options = {}) => {
    if (!projectId || activeJobs.length) {
      return;
    }

    setLocalError(null);

    const source = typeof options?.source === 'string' ? options.source : 'user';

    try {
      markTestRunIntent?.(source, {
        autoCommit: Boolean(options?.autoCommit),
        returnToCommits: Boolean(options?.returnToCommits)
      });

      await Promise.all(
        TEST_JOB_TYPES.map((config) => startAutomationJob(config.type, { projectId }))
      );
    } catch (error) {
      setLocalError(error.message);
    }
  }, [activeJobs.length, markTestRunIntent, projectId, startAutomationJob]);

  const handleCancel = useCallback(async (job) => {
    if (!job) {
      return;
    }

    if (job.id) {
      suppressedModalJobIdsRef.current.add(job.id);
    }

    // Cancelling is an explicit user intent; silence any currently-open result modal.
    setIsResultModalOpen(false);

    try {
      await cancelAutomationJob(job.id, { projectId });
    } catch (error) {
      setLocalError(error.message);
    }
  }, [cancelAutomationJob, projectId]);

  const handleCancelActiveRuns = useCallback(async () => {
    if (!activeJobs.length) {
      return;
    }
    setLocalError(null);

    for (const job of activeJobs) {
      if (job?.id) {
        suppressedModalJobIdsRef.current.add(job.id);
      }
    }

    setIsResultModalOpen(false);

    try {
      await Promise.all(
        activeJobs.map((job) => cancelAutomationJob(job.id, { projectId }))
      );
    } catch (error) {
      setLocalError(error.message);
    }
  }, [activeJobs, cancelAutomationJob, projectId]);

  const handleRefresh = useCallback(async () => {
    setLocalError(null);
    try {
      await refreshJobs(projectId);
    } catch (error) {
      setLocalError(error.message);
    }
  }, [projectId, refreshJobs]);

  useEffect(() => {
    if (typeof registerTestActions !== 'function') {
      return;
    }

    if (!project) {
      registerTestActions(null);
      return;
    }

    registerTestActions({
      onRefresh: handleRefresh,
      onCancelActiveRuns: handleCancelActiveRuns,
      runAllTests,
      refreshDisabled: jobState.isLoading,
      cancelDisabled: activeJobs.length === 0,
      isRefreshing: jobState.isLoading,
      lastFetchedAt: jobsLastFetchedAt
    });
  }, [registerTestActions, project, handleRefresh, handleCancelActiveRuns, runAllTests, jobState.isLoading, activeJobs.length, jobsLastFetchedAt]);

  useEffect(() => () => {
    if (typeof registerTestActions === 'function') {
      registerTestActions(null);
    }
  }, [registerTestActions]);

  useEffect(() => {
    if (!TestTab.__testHooks) {
      return;
    }

    const hooks = TestTab.__testHooks;
    hooks.handleRun = handleRun;
    hooks.handleCancel = handleCancel;
    hooks.handleCancelActiveRuns = handleCancelActiveRuns;
    hooks.handleRefresh = handleRefresh;
    hooks.setLocalError = setLocalError;
    hooks.getLocalError = () => localError;
    hooks.getActiveJobs = () => activeJobs;
    hooks.submitProofIfNeeded = submitProofIfNeeded;
    hooks.getResultModalState = () => ({
      title: resultModalTitle,
      message: resultModalMessage,
      variant: resultModalVariant,
      isOpen: isResultModalOpen,
      isProcessing: resultModalProcessing
    });

    return () => {
      if (!TestTab.__testHooks) {
        return;
      }
      hooks.handleRun = undefined;
      hooks.handleCancel = undefined;
      hooks.handleCancelActiveRuns = undefined;
      hooks.handleRefresh = undefined;
      hooks.setLocalError = undefined;
      hooks.getLocalError = undefined;
      hooks.getActiveJobs = undefined;
      hooks.submitProofIfNeeded = undefined;
      hooks.getResultModalState = undefined;
    };
  }, [
    handleRun,
    handleCancel,
    handleCancelActiveRuns,
    handleRefresh,
    localError,
    activeJobs,
    submitProofIfNeeded,
    resultModalTitle,
    resultModalMessage,
    resultModalVariant,
    isResultModalOpen,
    resultModalProcessing
  ]);

  if (!project) {
    return (
      <div className="test-tab" data-testid="test-tab-empty">
        <div className="test-empty">
          <div className="empty-icon">🧪</div>
          <h4>Select a project to view automation runs</h4>
        </div>
      </div>
    );
  }

  return (
    <div className="test-tab" data-testid="test-tab-automation">
      <Modal
        isOpen={isResultModalOpen}
        onClose={() => setIsResultModalOpen(false)}
        onConfirm={resultModalConfirmAction}
        title={resultModalTitle}
        message={resultModalMessage}
        confirmText={resultModalConfirmText}
        cancelText="Close"
        type={resultModalVariant}
        isProcessing={resultModalProcessing}
        processingMessage={resultModalProcessingMessage}
        confirmLoadingText="Committing…"
        dismissOnBackdrop={!resultModalRequiresExplicitDismiss}
        dismissOnEscape={!resultModalRequiresExplicitDismiss}
      />

      {activeError && (
        <div className="test-error-banner" role="alert" data-testid="test-error-banner">
          {activeError}
        </div>
      )}

      {canResumeCommitFlow && !isResultModalOpen && (
        <div className="test-success-banner" data-testid="commit-ready-banner">
          <span>Frontend and backend tests both passed. Ready to continue to commit?</span>
          <button
            type="button"
            className="commit-ready-button"
            onClick={() => setIsResultModalOpen(true)}
            data-testid="commit-ready-button"
          >
            Continue to commit
          </button>
        </div>
      )}

      <div className="test-grid">
        {TEST_JOB_TYPES.map((config) => {
          const job = jobsByType[config.type];
          const active = isJobActive(job);
          const durationLabel = formatDurationSeconds(job);

          return (
            <div className="test-card" key={config.type} data-testid={`test-card-${config.type}`}>
              <div className="test-card-header">
                <div>
                  <h4>{config.label}</h4>
                  <p>{config.description}</p>
                </div>
                <span className={`job-status ${job?.status || 'idle'}`} data-testid={`job-status-${config.type}`}>
                  {statusLabel(job?.status)}
                </span>
              </div>

              <div className="test-card-body">
                {job ? (
                  <>
                    <div className="job-meta">
                      <code data-testid={`job-command-${config.type}`}>
                        {job.command} {job.args?.join(' ') || ''}
                      </code>
                      <span className="job-cwd">{job.cwd}</span>
                      {durationLabel && (
                        <span className="job-duration">{durationLabel}</span>
                      )}
                    </div>
                    <div className="job-logs" data-testid={`job-logs-${config.type}`}>
                      {renderLogLines(job)}
                    </div>
                  </>
                ) : (
                  <div className="test-empty-inline">
                    <p>No runs yet. Kick off the first {config.label.toLowerCase()}.</p>
                  </div>
                )}
              </div>

              <div className="test-card-actions">
                <button
                  type="button"
                  onClick={() => handleRun(config.type)}
                  disabled={!project || active}
                  data-testid={`run-${config.type}`}
                >
                  {active ? 'Running…' : `Run ${config.label}`}
                </button>
                {active && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => handleCancel(job)}
                    data-testid={`cancel-${config.type}`}
                  >
                    Cancel Run
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

    </div>
  );
};

export default TestTab;

TestTab.__testHooks = TestTab.__testHooks || {};
Object.assign(TestTab.__testHooks, {
  statusLabel,
  isJobActive,
  extractFailingTestIdsFromJob,
  buildTestFixPlan,
  formatDurationSeconds,
  classifyLogToken,
  formatLogMessage,
  renderLogLines,
  buildProofFailureMessage,
   buildJobFailureContext,
   buildTestFailureContext,
  getAutofixMaxAttempts,
  setClassifyLogTokenOverride,
  resetClassifyLogTokenOverride,
  setAutofixMaxAttemptsOverride,
  resetAutofixMaxAttemptsOverride
});