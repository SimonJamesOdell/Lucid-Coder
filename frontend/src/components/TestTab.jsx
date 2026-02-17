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
  buildCoverageGateMessage,
  buildJobFailureContext,
  buildTestFailureContext,
  getAutofixMaxAttempts,
  setClassifyLogTokenOverride,
  resetClassifyLogTokenOverride,
  setAutofixMaxAttemptsOverride,
  resetAutofixMaxAttemptsOverride,
  isAutofixHalted,
  isCoverageGateFailed
} from './test-tab/helpers.jsx';
import { useSubmitProof } from './test-tab/useSubmitProof';
import './TestTab.css';

const MIN_COVERAGE_TARGET = 50;
const MAX_COVERAGE_TARGET = 100;
const COVERAGE_STEP = 10;

const normalizeFailureFingerprintText = (value) => {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .toLowerCase()
    .replace(/[a-z]:\\[^\s)\]]+/gi, '<path>')
    .replace(/(?:frontend|backend|src|tests?)\/[a-z0-9._\-/]+/gi, '<path>')
    .replace(/:\d+(?::\d+)?/g, ':#')
    .replace(/\b\d+\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
};

const buildAutofixFailureFingerprint = ({ jobsByType, visibleTestConfigs }) => {
  const parts = [];

  for (const config of visibleTestConfigs) {
    const job = jobsByType[config.type];
    if (!job || (job.status !== 'failed' && !isCoverageGateFailed(job))) {
      continue;
    }

    const failingIds = extractFailingTestIdsFromJob(job).sort();
    const jobContext = buildJobFailureContext({
      label: config.type.startsWith('backend') ? 'Backend tests' : 'Frontend tests',
      kind: config.type.startsWith('backend') ? 'backend' : 'frontend',
      job
    });

    const normalizedFailureReport = normalizeFailureFingerprintText(jobContext?.failureReport || '')
      .slice(0, 220);
    const normalizedError = normalizeFailureFingerprintText(jobContext?.error || '').slice(0, 160);
    const coverageFiles = Array.isArray(job?.summary?.coverage?.uncoveredLines)
      ? job.summary.coverage.uncoveredLines
        .map((entry) => {
          const workspace = typeof entry?.workspace === 'string' ? entry.workspace.trim() : '';
          const file = typeof entry?.file === 'string' ? entry.file.trim() : '';
          return [workspace, file].filter(Boolean).join('/');
        })
        .filter(Boolean)
        .sort()
      : [];

    parts.push([
      config.type,
      failingIds.length > 0 ? `ids:${failingIds.join('|')}` : 'ids:none',
      normalizedFailureReport ? `report:${normalizedFailureReport}` : 'report:none',
      normalizedError ? `error:${normalizedError}` : 'error:none',
      coverageFiles.length > 0 ? `coverage:${coverageFiles.join('|')}` : 'coverage:none'
    ].join(';'));
  }

  return parts.length > 0 ? parts.join(' || ') : null;
};

const TestTab = ({ project, registerTestActions, onRequestCommitsTab }) => {
  const {
    startAutomationJob,
    cancelAutomationJob,
    getJobsForProject,
    jobState,
    workspaceChanges,
    workingBranches,
    syncBranchOverview,
    markTestRunIntent,
    testRunIntent,
    projectProcesses,
    testingSettings,
    projectTestingSettings,
    updateProjectTestingSettings
  } = useAppState();
  const [localError, setLocalError] = useState(null);
  const [logFontSize, setLogFontSize] = useState(0.55);
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
  const [showJobLogCatchup, setShowJobLogCatchup] = useState({});
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
  const jobLogsContainerRef = useRef({});
  const jobLogAutoScrollEnabledRef = useRef({});
  const jobLogLastScrollTopRef = useRef({});
  const autoFixSessionRef = useRef({
    active: false,
    origin: 'user',
    attempt: 0,
    maxAttempts: getAutofixMaxAttempts(),
    previousCoverageTargets: new Set()
  });

  const resetCommitResumeState = useCallback(() => {
    setCanResumeCommitFlow(false);
    setResultModalRequiresExplicitDismiss(false);
  }, []);

  const applyAutofixHaltReset = useCallback(() => {
    const activeSession = autoFixSessionRef.current;
    if (!activeSession?.active) {
      return activeSession;
    }

    if (activeSession.origin === 'automation' && isAutofixHalted()) {
      autoFixSessionRef.current = {
        active: false,
        origin: 'user',
        attempt: 0,
        maxAttempts: getAutofixMaxAttempts(),
        previousCoverageTargets: new Set()
      };
    }

    return autoFixSessionRef.current;
  }, []);

  const hasBackend = useMemo(() => {
    const backendCapability = projectProcesses?.capabilities?.backend?.exists;
    if (backendCapability === false) {
      return false;
    }
    const projectBackend = project?.backend;
    if (projectBackend === null) {
      return false;
    }
    if (typeof projectBackend?.exists === 'boolean') {
      return projectBackend.exists;
    }
    return true;
  }, [project?.backend, projectProcesses?.capabilities?.backend?.exists]);

  const visibleTestConfigs = useMemo(() => (
    TEST_JOB_TYPES.filter((config) => config.type !== 'backend:test' || hasBackend)
  ), [hasBackend]);

  const testJobs = useMemo(
    () => jobs.filter((job) => job.type?.endsWith(':test')),
    [jobs]
  );

  const jobsByType = useMemo(() => {
    return visibleTestConfigs.reduce((acc, config) => {
      const latest = testJobs
        .filter((job) => job.type === config.type)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
      acc[config.type] = latest || null;
      return acc;
    }, {});
  }, [testJobs, visibleTestConfigs]);

  const triggerTestFix = useCallback(({ origin = 'user', jobTypes } = {}) => {
    const types = Array.isArray(jobTypes) && jobTypes.length
      ? new Set(jobTypes)
      : null;
    const planJobs = visibleTestConfigs
      .filter((config) => !types || types.has(config.type))
      .map((config) => ({
      label: config.type.startsWith('backend') ? 'Backend tests' : 'Frontend tests',
      kind: config.type.startsWith('backend') ? 'backend' : 'frontend',
      job: jobsByType[config.type]
    }));
    const session = autoFixSessionRef.current;
    const plan = buildTestFixPlan({
      jobs: planJobs,
      previousCoverageTargets: session.previousCoverageTargets
    });

    // Merge newly created coverage targets into session so the next round skips them.
    if (plan.coverageTargets && plan.coverageTargets.size > 0) {
      for (const target of plan.coverageTargets) {
        session.previousCoverageTargets.add(target);
      }
    }

    if (typeof window !== 'undefined') {
      if (origin === 'user') {
        window.dispatchEvent(new CustomEvent('lucidcoder:autofix-resume'));
      }
      // Do not route failing-test fixes through the generic agent planner.
      // Instead, emit an event that creates a new goal to fix tests and then re-runs suites.
      window.dispatchEvent(new CustomEvent('lucidcoder:autofix-tests', { detail: { ...plan, origin } }));
    }
  }, [jobsByType, visibleTestConfigs]);

  const activeJobs = useMemo(
    () => visibleTestConfigs.map((config) => jobsByType[config.type]).filter(isJobActive),
    [jobsByType, visibleTestConfigs]
  );

  const hasFailedJob = useCallback((job) => (
    job && (job.status === 'failed' || isCoverageGateFailed(job))
  ), []);

  const allTestsCompleted = useMemo(() => {
    return visibleTestConfigs.every((config) => {
      const job = jobsByType[config.type];
      return job && isJobFinal(job);
    });
  }, [jobsByType, visibleTestConfigs]);

  const didTestsMeetGate = useMemo(() => {
    if (!allTestsCompleted) {
      return false;
    }
    return visibleTestConfigs.every((config) => {
      const job = jobsByType[config.type];
      return job?.status === 'succeeded' && !isCoverageGateFailed(job);
    });
  }, [allTestsCompleted, jobsByType, visibleTestConfigs]);

  const coverageGateMessage = useMemo(() => {
    const failingJob = visibleTestConfigs
      .map((config) => jobsByType[config.type])
      .find((job) => isCoverageGateFailed(job));
    if (!failingJob) {
      return null;
    }
    return buildCoverageGateMessage(failingJob.summary);
  }, [jobsByType, visibleTestConfigs]);

  const testsPassedMessage = hasBackend
    ? 'Frontend and backend tests both passed.'
    : 'Frontend tests passed.';
  const testsPassedCommitsMessage = hasBackend
    ? 'Frontend and backend tests both passed. Ready to continue to commits?'
    : 'Frontend tests passed. Ready to continue to commits?';
  const testsPassedCommitMessage = hasBackend
    ? 'Frontend and backend tests both passed. Ready to continue to commit?'
    : 'Frontend tests passed. Ready to continue to commit?';
  const testsPassedNoBranchMessage = hasBackend
    ? 'Frontend and backend tests passed, but there is no active working branch selected for committing. Switch to a feature branch and try again.'
    : 'Frontend tests passed, but there is no active working branch selected for committing. Switch to a feature branch and try again.';
  const testsPassedNoStagedMessage = hasBackend
    ? 'Frontend and backend tests both passed, but this branch has no staged changes. There is nothing to commit.'
    : 'Frontend tests passed, but this branch has no staged changes. There is nothing to commit.';

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
  const displayError = useMemo(() => {
    if (!hasBackend && typeof activeError === 'string') {
      const normalized = activeError.toLowerCase();
      if (normalized.includes('backend test runner')) {
        return null;
      }
    }
    return activeError;
  }, [activeError, hasBackend]);

  const globalCoverageTarget = Number(testingSettings?.coverageTarget) || 100;
  const projectTestingSnapshot = projectId ? projectTestingSettings?.[projectId] : null;

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
      maxAttempts: getAutofixMaxAttempts(),
      previousCoverageTargets: new Set()
    };
    jobLogsContainerRef.current = {};
    jobLogAutoScrollEnabledRef.current = {};
    jobLogLastScrollTopRef.current = {};
    setShowJobLogCatchup({});
    resetCommitResumeState();
  }, [projectId, resetCommitResumeState]);

  const isJobLogScrolledToBottom = useCallback((type) => {
    const container = jobLogsContainerRef.current[type];
    if (!container) {
      return true;
    }
    const threshold = 24;
    return container.scrollHeight - container.scrollTop - container.clientHeight <= threshold;
  }, []);

  const handleJobLogScroll = useCallback((type) => {
    const container = jobLogsContainerRef.current[type];
    if (!container) {
      return;
    }

    const previousTop = Number(jobLogLastScrollTopRef.current[type]) || 0;
    const currentTop = container.scrollTop;
    jobLogLastScrollTopRef.current[type] = currentTop;

    const atBottom = isJobLogScrolledToBottom(type);
    const movedUpBy = previousTop - currentTop;
    const movedUpIntentionally = movedUpBy > 8;

    if (atBottom) {
      jobLogAutoScrollEnabledRef.current[type] = true;
    } else if (movedUpIntentionally) {
      jobLogAutoScrollEnabledRef.current[type] = false;
    }

    const shouldShowCatchup = !atBottom && jobLogAutoScrollEnabledRef.current[type] === false;
    setShowJobLogCatchup((prev) => {
      if (Boolean(prev[type]) === shouldShowCatchup) {
        return prev;
      }
      return {
        ...prev,
        [type]: shouldShowCatchup
      };
    });
  }, [isJobLogScrolledToBottom]);

  const scrollJobLogsToBottom = useCallback((type) => {
    const container = jobLogsContainerRef.current[type];
    if (!container) {
      return;
    }
    container.scrollTop = container.scrollHeight;
    jobLogLastScrollTopRef.current[type] = container.scrollTop;
    jobLogAutoScrollEnabledRef.current[type] = true;
    setShowJobLogCatchup((prev) => ({
      ...prev,
      [type]: false
    }));
  }, []);

  const scrollJobLogsToBottomIfEnabled = useCallback((type) => {
    const container = jobLogsContainerRef.current[type];
    if (!container) {
      return;
    }

    if (jobLogAutoScrollEnabledRef.current[type] === false) {
      setShowJobLogCatchup((prev) => ({
        ...prev,
        [type]: true
      }));
      return;
    }

    container.scrollTop = container.scrollHeight;
    jobLogLastScrollTopRef.current[type] = container.scrollTop;
    setShowJobLogCatchup((prev) => ({
      ...prev,
      [type]: false
    }));
  }, []);

  const setJobLogsContainer = useCallback((type, node) => {
    if (!node) {
      delete jobLogsContainerRef.current[type];
      delete jobLogLastScrollTopRef.current[type];
      return;
    }

    jobLogsContainerRef.current[type] = node;
    jobLogLastScrollTopRef.current[type] = node.scrollTop;
    if (typeof jobLogAutoScrollEnabledRef.current[type] !== 'boolean') {
      jobLogAutoScrollEnabledRef.current[type] = true;
    }
  }, []);

  const jobLogLengthFingerprint = useMemo(() => visibleTestConfigs
    .map((config) => {
      const logs = Array.isArray(jobsByType[config.type]?.logs) ? jobsByType[config.type].logs : [];
      return `${config.type}:${logs.length}`;
    })
    .join('|'), [jobsByType, visibleTestConfigs]);

  useEffect(() => {
    for (const config of visibleTestConfigs) {
      if (!jobsByType[config.type]) {
        continue;
      }
      scrollJobLogsToBottomIfEnabled(config.type);
    }
  }, [jobLogLengthFingerprint, jobsByType, scrollJobLogsToBottomIfEnabled, visibleTestConfigs]);

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
    /* c8 ignore start */
    if (frontendJob?.id && suppressedIds.has(frontendJob.id)) {
      resetCommitResumeState();
      return;
    }
    if (backendJob?.id && suppressedIds.has(backendJob.id)) {
      resetCommitResumeState();
      return;
    }
    /* c8 ignore stop */

    const modalKey = `${frontendJob?.id || 'none'}@${frontendJob?.createdAt || frontendJob?.completedAt || 'na'}:${backendJob?.id || 'none'}@${backendJob?.createdAt || backendJob?.completedAt || 'na'}`;

    if (lastResultModalKeyRef.current === modalKey) {
      return;
    }

    lastResultModalKeyRef.current = modalKey;

    // Clear any in-flight auto-fix loop when tests pass.
    if (didTestsMeetGate) {
      autoFixSessionRef.current = {
        active: false,
        origin: 'user',
        attempt: 0,
        maxAttempts: getAutofixMaxAttempts(),
        previousCoverageTargets: new Set()
      };
    }

    if (didTestsMeetGate) {
      const lastRunSource = typeof testRunIntent?.source === 'string' ? testRunIntent.source : 'unknown';
      const shouldReturnToCommits = Boolean(testRunIntent?.returnToCommits);

      const stagedCount = stagedFiles.length;
      const hasCommitContext = Boolean(activeBranchName && activeBranchName !== 'main' && stagedCount > 0);

      // Only offer commit / prove-branch flows for automation-driven runs.
      // Manual test runs should never auto-suggest or attempt commits.
      if (lastRunSource !== 'automation') {
        resetCommitResumeState();
        setResultModalVariant('default');
        setResultModalTitle('Tests passed');

        if (!hasCommitContext) {
          setResultModalMessage(testsPassedMessage);
          setResultModalConfirmText(null);
          setResultModalConfirmAction(null);
          setResultModalProcessing(false);
          setResultModalProcessingMessage('');
          setIsResultModalOpen(true);
          return;
        }

        setResultModalMessage(testsPassedCommitsMessage);
        setResultModalConfirmText('Continue to commits');
        setResultModalConfirmAction(() => () => {
          setIsResultModalOpen(false);
          if (
            projectId
            && typeof syncBranchOverview === 'function'
            && activeBranchName
            && activeBranchName !== 'main'
          ) {
            const testsRequired = typeof activeWorkingBranch?.testsRequired === 'boolean'
              ? activeWorkingBranch.testsRequired
              : true;
            const mergeBlockedReason = typeof activeWorkingBranch?.mergeBlockedReason === 'string'
              ? activeWorkingBranch.mergeBlockedReason
              : null;
            const lastTestSummary = activeWorkingBranch?.lastTestSummary && typeof activeWorkingBranch.lastTestSummary === 'object'
              ? activeWorkingBranch.lastTestSummary
              : null;
            const status = typeof activeWorkingBranch?.status === 'string'
              ? activeWorkingBranch.status
              : 'active';

            syncBranchOverview(projectId, {
              current: activeBranchName,
              workingBranches: [
                {
                  name: activeBranchName,
                  status,
                  stagedFiles,
                  lastTestStatus: 'passed',
                  testsRequired,
                  mergeBlockedReason,
                  lastTestCompletedAt: new Date().toISOString(),
                  lastTestSummary
                }
              ]
            });
          }
          onRequestCommitsTab?.();
        });
        setResultModalProcessing(false);
        setResultModalProcessingMessage('');
        setIsResultModalOpen(true);
        return;
      }

      if (!activeBranchName || activeBranchName === 'main') {
                  normalizeFailureFingerprintText,
        resetCommitResumeState();
        setResultModalVariant('danger');
        setResultModalTitle('Cannot commit');
        setResultModalMessage(testsPassedNoBranchMessage);
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
        setResultModalMessage(testsPassedNoStagedMessage);
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
      setResultModalMessage(testsPassedCommitMessage);
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
                const proofSuiteLabel = ['frontend', 'backend'][Number(Boolean(hasBackend))];
                throw buildModalError(
                  'Tests required before commit',
                  `Run ${proofSuiteLabel} tests again before committing this branch so the server can record a passing proof.`
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

    // Compute a fingerprint from the current failure so the circuit breaker
    // can detect identical errors across consecutive autofix rounds.
    const failureFingerprint = buildAutofixFailureFingerprint({
      jobsByType,
      visibleTestConfigs
    });

    const session = autoFixSessionRef.current;
    const lastRunSource = typeof testRunIntent?.source === 'string' ? testRunIntent.source : 'unknown';
    const shouldAutoStartFix = lastRunSource === 'automation' && !session.active;

    if (shouldAutoStartFix && !isAutofixHalted()) {
      autoFixSessionRef.current = {
        active: true,
        origin: 'automation',
        attempt: 0,
        maxAttempts: getAutofixMaxAttempts(),
        previousCoverageTargets: new Set()
      };
    }

    let activeSession = applyAutofixHaltReset();
    if (activeSession?.active) {
      if (Number.isFinite(activeSession.maxAttempts) && activeSession.attempt >= activeSession.maxAttempts) {
        autoFixSessionRef.current = {
          active: false,
          origin: 'user',
          attempt: 0,
          maxAttempts: getAutofixMaxAttempts(),
          previousCoverageTargets: new Set()
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
        // Circuit breaker: halt early if the same failure fingerprint repeats,
        // meaning the previous fix attempt made no progress on the error.
        const repeatedFailureCount = failureFingerprint && activeSession.lastFailureFingerprint === failureFingerprint
          ? (Number(activeSession.repeatedFailureCount) || 0) + 1
          : 0;

        if (failureFingerprint && repeatedFailureCount >= 1) {
          autoFixSessionRef.current = {
            active: false,
            origin: 'user',
            attempt: 0,
            maxAttempts: getAutofixMaxAttempts(),
            previousCoverageTargets: new Set()
          };

          resetCommitResumeState();
          setResultModalVariant('danger');
          setResultModalTitle('Tests failed');
          setResultModalMessage('Auto-fix detected the same error repeating and stopped to avoid an infinite loop. Review the logs and try a manual fix.');
          setResultModalConfirmText(null);
          setResultModalConfirmAction(null);
          setIsResultModalOpen(true);
          return;
        }

        autoFixSessionRef.current = {
          ...activeSession,
          attempt: activeSession.attempt + 1,
          lastFailureFingerprint: failureFingerprint,
          repeatedFailureCount
        };

        triggerTestFix({ origin: activeSession.origin });
        return;
      }
    }

    resetCommitResumeState();
    setResultModalVariant('danger');
    setResultModalTitle(coverageGateMessage ? 'Coverage gate failed' : 'Tests failed');
    setResultModalMessage(
      coverageGateMessage
        ? coverageGateMessage
        : 'One or more test suites failed. Want the AI assistant to help you fix them?'
    );
    setResultModalConfirmText('Fix with AI');
    setResultModalConfirmAction(() => () => {
      autoFixSessionRef.current = {
        active: true,
        origin: 'user',
        attempt: 1,
        maxAttempts: getAutofixMaxAttempts(),
        previousCoverageTargets: new Set()
      };

      triggerTestFix({ origin: 'user' });
      setIsResultModalOpen(false);
    });
    setResultModalProcessing(false);
    setResultModalProcessingMessage('');
    setIsResultModalOpen(true);
  }, [
    allTestsCompleted,
    didTestsMeetGate,
    jobsByType,
    onRequestCommitsTab,
    project,
    projectId,
    testRunIntent,
    testsPassedMessage,
    testsPassedCommitsMessage,
    testsPassedCommitMessage,
    testsPassedNoBranchMessage,
    testsPassedNoStagedMessage,
    triggerTestFix,
    hasBackend,
    stagedFiles.length,
    activeBranchName,
    syncBranchOverview,
    resetCommitResumeState,
    submitProofIfNeeded,
    coverageGateMessage
  ]);

  const shouldRunTest = useCallback((type) => {
    if (!hasBackend && type === 'backend:test') {
      return false;
    }
    const job = jobsByType[type];
    
    // Always run if there's no previous job or if it failed
    if (!job || job.status !== 'succeeded') {
      return true;
    }
    
    // If test succeeded, check if any files changed after the test completed
    const testCompletedAt = job.completedAt ? new Date(job.completedAt).getTime() : 0;
    if (!testCompletedAt) {
      return true; // No completion time, run the test
    }
    
    // Check if any staged files were modified after the test completed
    const hasNewerChanges = stagedFiles.some((file) => {
      let fileTimestamp = Date.now();
      if (file?.timestamp) {
        fileTimestamp = new Date(file.timestamp).getTime();
      }
      return fileTimestamp > testCompletedAt;
    });
    
    return hasNewerChanges;
  }, [hasBackend, jobsByType, stagedFiles]);

  const buildTestJobPayload = useCallback((type) => {
    const scope = type.startsWith('backend') ? 'backend' : 'frontend';
    const entry = projectTestingSnapshot?.[scope] || null;
    const mode = entry?.mode === 'custom' ? 'custom' : 'global';
    if (mode !== 'custom') {
      return null;
    }

    const rawCoverageTarget = Number(entry?.coverageTarget);
    const isValidCoverageTarget = Number.isFinite(rawCoverageTarget)
      && rawCoverageTarget >= MIN_COVERAGE_TARGET
      && rawCoverageTarget <= MAX_COVERAGE_TARGET;
    const coverageTarget = isValidCoverageTarget ? rawCoverageTarget : globalCoverageTarget;

    return {
      useGlobal: false,
      coverageTarget
    };
  }, [projectTestingSnapshot, globalCoverageTarget]);

  const handleRun = useCallback(async (type) => {
    if (!hasBackend && type === 'backend:test') {
      return;
    }

    setLocalError(null);

    try {
      markTestRunIntent?.('user');
      const payload = buildTestJobPayload(type);
      const startOptions = payload ? { projectId, payload } : { projectId };
      await startAutomationJob(type, startOptions);
    } catch (error) {
      setLocalError(error.message);
    }
  }, [hasBackend, markTestRunIntent, startAutomationJob, projectId, buildTestJobPayload]);

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

      // Filter to only run tests that need to be run
      const testsToRun = visibleTestConfigs.filter((config) => shouldRunTest(config.type));
      
      if (testsToRun.length === 0) {
        console.log('All tests previously succeeded with no file changes - skipping test runs');
        return;
      }
      
      if (testsToRun.length < visibleTestConfigs.length) {
        console.log(`Running ${testsToRun.length} of ${visibleTestConfigs.length} test suites (others already passed with no changes)`);
      }

      await Promise.all(
        testsToRun.map((config) => {
          const payload = buildTestJobPayload(config.type);
          const startOptions = payload ? { projectId, payload } : { projectId };
          return startAutomationJob(config.type, startOptions);
        })
      );
    } catch (error) {
      setLocalError(error.message);
    }
  }, [activeJobs.length, markTestRunIntent, projectId, startAutomationJob, shouldRunTest, visibleTestConfigs, buildTestJobPayload]);

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

  const resolveScopeSettings = useCallback((scope) => {
    const entry = projectTestingSnapshot?.[scope] || null;
    const mode = entry?.mode === 'custom' ? 'custom' : 'global';
    const rawCoverageTarget = entry?.coverageTarget;
    const coverageTarget = Number(rawCoverageTarget);
    const isValidCoverageTarget = Number.isFinite(coverageTarget)
      && coverageTarget >= MIN_COVERAGE_TARGET
      && coverageTarget <= MAX_COVERAGE_TARGET;
    const fallback = isValidCoverageTarget ? coverageTarget : globalCoverageTarget;
    return {
      mode,
      useGlobal: mode !== 'custom',
      coverageTarget: fallback
    };
  }, [globalCoverageTarget, projectTestingSnapshot]);

  const saveProjectScopeSettings = useCallback(async (scope, nextScopePayload) => {
    if (!projectId || typeof updateProjectTestingSettings !== 'function') {
      return;
    }

    setLocalError(null);
    try {
      await updateProjectTestingSettings(projectId, {
        [scope]: nextScopePayload
      });
    } catch (error) {
      setLocalError(error?.message || 'Failed to save project testing settings');
    }
  }, [projectId, updateProjectTestingSettings]);

  const handleScopeGlobalToggle = useCallback((scope, checked) => {
    const current = resolveScopeSettings(scope);
    if (checked) {
      void saveProjectScopeSettings(scope, { useGlobal: true });
      return;
    }
    void saveProjectScopeSettings(scope, {
      useGlobal: false,
      coverageTarget: current.coverageTarget
    });
  }, [resolveScopeSettings, saveProjectScopeSettings]);

  const handleScopeCoverageTargetChange = useCallback((scope, value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return;
    }
    void saveProjectScopeSettings(scope, {
      useGlobal: false,
      coverageTarget: numeric
    });
  }, [saveProjectScopeSettings]);

  useEffect(() => {
    if (typeof registerTestActions !== 'function') {
      return;
    }

    if (!project) {
      registerTestActions(null);
      return;
    }

    registerTestActions({
      onCancelActiveRuns: handleCancelActiveRuns,
      runAllTests,
      cancelDisabled: activeJobs.length === 0,
      lastFetchedAt: jobsLastFetchedAt
    });
  }, [registerTestActions, project, handleCancelActiveRuns, runAllTests, activeJobs.length, jobsLastFetchedAt]);

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
    hooks.handleScopeGlobalToggle = handleScopeGlobalToggle;
    hooks.handleScopeCoverageTargetChange = handleScopeCoverageTargetChange;
    hooks.applyAutofixHaltReset = applyAutofixHaltReset;
    hooks.getAutofixSession = () => autoFixSessionRef.current;
    hooks.setAutofixSession = (session) => {
      autoFixSessionRef.current = session;
    };
    hooks.isJobLogScrolledToBottom = isJobLogScrolledToBottom;
    hooks.handleJobLogScroll = handleJobLogScroll;
    hooks.scrollJobLogsToBottom = scrollJobLogsToBottom;
    hooks.scrollJobLogsToBottomIfEnabled = scrollJobLogsToBottomIfEnabled;
    hooks.setJobLogsContainer = setJobLogsContainer;
    hooks.shouldRunTest = shouldRunTest;
    hooks.buildTestJobPayload = buildTestJobPayload;
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
      hooks.handleScopeGlobalToggle = undefined;
      hooks.handleScopeCoverageTargetChange = undefined;
      hooks.applyAutofixHaltReset = undefined;
      hooks.getAutofixSession = undefined;
      hooks.setAutofixSession = undefined;
      hooks.isJobLogScrolledToBottom = undefined;
      hooks.handleJobLogScroll = undefined;
      hooks.scrollJobLogsToBottom = undefined;
      hooks.scrollJobLogsToBottomIfEnabled = undefined;
      hooks.setJobLogsContainer = undefined;
      hooks.shouldRunTest = undefined;
      hooks.buildTestJobPayload = undefined;
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
    handleScopeGlobalToggle,
    handleScopeCoverageTargetChange,
    applyAutofixHaltReset,
    isJobLogScrolledToBottom,
    handleJobLogScroll,
    scrollJobLogsToBottom,
    scrollJobLogsToBottomIfEnabled,
    setJobLogsContainer,
    shouldRunTest,
    buildTestJobPayload,
    localError,
    activeJobs,
    submitProofIfNeeded,
    resultModalTitle,
    resultModalMessage,
    resultModalVariant,
    isResultModalOpen,
    resultModalProcessing
  ]);

  const handleIncreaseLogFont = useCallback(() => {
    setLogFontSize((current) => Math.min(1.1, Number((current + 0.05).toFixed(2))));
  }, []);

  const handleDecreaseLogFont = useCallback(() => {
    setLogFontSize((current) => Math.max(0.55, Number((current - 0.05).toFixed(2))));
  }, []);

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
    <div
      className="test-tab"
      data-testid="test-tab-automation"
      style={{ '--test-log-font-size': `${logFontSize}rem` }}
    >
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

      {displayError && (
        <div className="test-error-banner" role="alert" data-testid="test-error-banner">
          {displayError}
        </div>
      )}

      {canResumeCommitFlow && !isResultModalOpen && (
        <div className="test-success-banner" data-testid="commit-ready-banner">
          <span>{testsPassedCommitMessage}</span>
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
        {visibleTestConfigs.map((config) => {
          const job = jobsByType[config.type];
          const active = isJobActive(job);
          const durationLabel = formatDurationSeconds(job);
          const scope = config.type.startsWith('backend') ? 'backend' : 'frontend';
          const scopeSettings = resolveScopeSettings(scope);

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

              <div className="test-scope-settings" data-testid={`test-scope-settings-${scope}`}>
                <label className="test-scope-toggle" htmlFor={`test-scope-global-${scope}-${projectId || 'none'}`}>
                  <input
                    id={`test-scope-global-${scope}-${projectId || 'none'}`}
                    type="checkbox"
                    checked={scopeSettings.useGlobal}
                    onChange={(event) => handleScopeGlobalToggle(scope, event.target.checked)}
                    data-testid={`scope-use-global-${scope}`}
                  />
                  <span>Use global settings</span>
                </label>

                {!scopeSettings.useGlobal && (
                  <div className="test-scope-slider-row">
                    <input
                      type="range"
                      min={MIN_COVERAGE_TARGET}
                      max={MAX_COVERAGE_TARGET}
                      step={COVERAGE_STEP}
                      value={scopeSettings.coverageTarget}
                      onChange={(event) => handleScopeCoverageTargetChange(scope, Number(event.target.value))}
                      data-testid={`scope-coverage-slider-${scope}`}
                    />
                    <span className="test-scope-slider-value" data-testid={`scope-coverage-value-${scope}`}>
                      {scopeSettings.coverageTarget}%
                    </span>
                  </div>
                )}
              </div>

              <div className="test-card-body">
                {job ? (
                  <>
                    <div className="job-logs-header">
                      <span className="job-logs-label">
                        Output{durationLabel ? ` • ${durationLabel}` : ''}
                      </span>
                      <div className="job-logs-controls">
                        <button
                          type="button"
                          className="job-logs-control"
                          onClick={handleDecreaseLogFont}
                          aria-label="Decrease log font size"
                        >
                          -
                        </button>
                        <button
                          type="button"
                          className="job-logs-control"
                          onClick={handleIncreaseLogFont}
                          aria-label="Increase log font size"
                        >
                          +
                        </button>
                      </div>
                    </div>
                    <div className="job-logs-wrapper">
                      <div
                        className="job-logs"
                        data-testid={`job-logs-${config.type}`}
                        ref={(node) => setJobLogsContainer(config.type, node)}
                        onScroll={() => handleJobLogScroll(config.type)}
                      >
                        {renderLogLines(job)}
                      </div>
                      {showJobLogCatchup[config.type] ? (
                        <button
                          type="button"
                          className="job-logs-catchup"
                          onClick={() => scrollJobLogsToBottom(config.type)}
                          aria-label={`Scroll ${config.label} output to latest`}
                          data-testid={`job-logs-catchup-${config.type}`}
                        >
                          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                            <path d="M8 12L3 7L4.4 5.6L8 9.2L11.6 5.6L13 7L8 12Z" fill="currentColor"/>
                          </svg>
                        </button>
                      ) : null}
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
                {hasFailedJob(job) && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => triggerTestFix({ origin: 'user', jobTypes: [config.type] })}
                    data-testid={`fix-with-ai-${config.type}`}
                  >
                    Fix with AI
                  </button>
                )}
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
  isCoverageGateFailed,
  buildCoverageGateMessage,
  normalizeFailureFingerprintText,
  buildAutofixFailureFingerprint,
  getAutofixMaxAttempts,
  setClassifyLogTokenOverride,
  resetClassifyLogTokenOverride,
  setAutofixMaxAttemptsOverride,
  resetAutofixMaxAttemptsOverride
});