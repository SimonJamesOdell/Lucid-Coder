import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import axios from 'axios';
import { useAppState } from '../context/AppStateContext';
import { useCommitComposer } from './branch-tab/useCommitComposer';
import CommitComposer from './branch-tab/CommitComposer';
import { describeMergeBlocker, isPassingTestStatus } from './branch-tab/utils';
import Modal from './Modal';
import './CommitsTab.css';
import './BranchTab.css';

const PENDING_COMMIT_SELECTION = '__pending__';
const CSS_ONLY_GATE_LABEL = 'CSS-only (tests optional)';
const CSS_ONLY_MERGE_BLOCK_LABEL = 'Commit CSS-only changes before merging';

const dedupeCommitsBySha = (commits = []) => {
  if (!Array.isArray(commits) || commits.length === 0) {
    return [];
  }

  const seen = new Set();
  return commits.filter((commit) => {
    const sha = typeof commit?.sha === 'string' ? commit.sha : '';
    if (!sha) {
      return true;
    }
    if (seen.has(sha)) {
      return false;
    }
    seen.add(sha);
    return true;
  });
};

const formatGateValue = (value) => {
  if (value == null) {
    return 'Unknown';
  }
  return String(value);
};

const formatCoverageGateLabel = (summary) => {
  const coverage = summary?.coverage;
  const pct = coverage?.totals?.lines?.pct;
  const required = coverage?.thresholds?.lines;

  const hasPct = typeof pct === 'number' && Number.isFinite(pct);
  const hasRequired = typeof required === 'number' && Number.isFinite(required);

  if (!hasPct && !hasRequired) {
    return null;
  }

  const pctLabel = hasPct ? `${Math.round(pct)}%` : 'Unknown';
  const requiredLabel = hasRequired ? `${Math.round(required)}%` : 'Unknown';
  return `${pctLabel} / ${requiredLabel}`;
};

const formatTimestamp = (value) => {
  if (!value) {
    return 'Unknown time';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown time';
  }

  return date.toLocaleString();
};

const CommitsTab = ({
  project,
  autofillRequestId = null,
  onConsumeAutofillRequest = null,
  testApiRef = null,
  testInitialState = null
}) => {
  const projectId = project?.id;
  const [commits, setCommits] = useState([]);
  const [selectedCommitSha, setSelectedCommitSha] = useState('');
  const [squashSelection, setSquashSelection] = useState([]);
  const [squashInFlight, setSquashInFlight] = useState(false);
  const [squashError, setSquashError] = useState(null);
  const [commitDetails, setCommitDetails] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [detailLoadingSha, setDetailLoadingSha] = useState(null);
  const initialRevertingSha = testInitialState?.revertingSha ?? null;
  const [revertingSha, setRevertingSha] = useState(initialRevertingSha);
  const [statusMessage, setStatusMessage] = useState(null);
  const [commitInFlight, setCommitInFlight] = useState(false);
  const [commitActionError, setCommitActionError] = useState(null);
  const [mergeInFlight, setMergeInFlight] = useState(false);
  const [mergeActionError, setMergeActionError] = useState(null);
  const [confirmModal, setConfirmModal] = useState(null);
  const { requestEditorFocus, workingBranches, workspaceChanges, syncBranchOverview } = useAppState();

  const commitComposer = useCommitComposer({ project });
  const {
    commitMessageRequest,
    commitMessageError,
    isLLMConfigured,
    getCommitMessageForBranch,
    getCommitSubjectForBranch,
    getCommitBodyForBranch,
    handleCommitMessageChange,
    handleCommitMessageAutofill,
    clearCommitMessageForBranch
  } = commitComposer;

  const activeWorkingBranch = projectId ? workingBranches?.[projectId] : null;
  const activeBranchName = typeof activeWorkingBranch?.name === 'string' ? activeWorkingBranch.name : '';
  const stagedFiles = useMemo(() => {
    const contextFiles = Array.isArray(activeWorkingBranch?.stagedFiles) ? activeWorkingBranch.stagedFiles : null;
    if (contextFiles) {
      return contextFiles;
    }
    const workspaceFiles = projectId && workspaceChanges?.[projectId]?.stagedFiles;
    return Array.isArray(workspaceFiles) ? workspaceFiles : [];
  }, [activeWorkingBranch?.stagedFiles, projectId, workspaceChanges]);
  const hasStagedFiles = stagedFiles.length > 0;

  const isCssOnlyStaged = useMemo(() => {
    if (!hasStagedFiles) {
      return false;
    }

    return stagedFiles.every((file) => {
      const filePath = typeof file?.path === 'string' ? file.path.trim().toLowerCase() : '';
      return Boolean(filePath) && filePath.endsWith('.css');
    });
  }, [hasStagedFiles, stagedFiles]);

  const testsPassed = isPassingTestStatus(activeWorkingBranch?.lastTestStatus);
  const testsRequired = activeWorkingBranch?.testsRequired;
  const branchIsProven = activeWorkingBranch?.status === 'ready-for-merge';
  const branchReadyToCommit = Boolean(
    activeBranchName
    && activeBranchName !== 'main'
    && hasStagedFiles
    && (isCssOnlyStaged || (branchIsProven && testsPassed))
  );

  const testsSatisfiedForMerge = Boolean(testsPassed || testsRequired === false);

  const branchReadyToMerge = Boolean(
    activeBranchName
    && activeBranchName !== 'main'
    && !hasStagedFiles
    && testsSatisfiedForMerge
    && activeWorkingBranch?.status !== 'merged'
    && activeWorkingBranch?.status !== 'protected'
  );
  const mergeIsCssOnly = Boolean(branchReadyToMerge && !testsPassed && testsRequired === false);
  const isPendingSelected = selectedCommitSha === PENDING_COMMIT_SELECTION;
  const shouldShowCommitComposer = branchReadyToCommit && isPendingSelected;

  const mergeBlockedReason = useMemo(() => {
    if (!activeWorkingBranch || !activeBranchName || activeBranchName === 'main') {
      return null;
    }
    if (branchReadyToMerge) {
      return null;
    }

    return describeMergeBlocker({
      ...activeWorkingBranch,
      stagedFiles
    });
  }, [activeWorkingBranch, activeBranchName, branchReadyToMerge, stagedFiles]);

  const mergeBlockedBannerMessage = isCssOnlyStaged ? CSS_ONLY_MERGE_BLOCK_LABEL : mergeBlockedReason;

  const gateStatus = useMemo(() => {
    if (!activeWorkingBranch || !activeBranchName || activeBranchName === 'main') {
      return null;
    }

    const testsLabel = isCssOnlyStaged
      ? CSS_ONLY_GATE_LABEL
      : (testsRequired === false
        ? 'Optional'
        : (testsPassed ? 'Passed' : (activeWorkingBranch?.lastTestStatus === 'failed' ? 'Failed' : 'Not run')));

    const coverageLabel = isCssOnlyStaged
      ? CSS_ONLY_GATE_LABEL
      : (formatCoverageGateLabel(activeWorkingBranch?.lastTestSummary)
        || (testsRequired === false ? 'Optional' : null));

    const mergeLabel = branchReadyToMerge
      ? 'Allowed'
      : (mergeBlockedBannerMessage ? `Blocked (${mergeBlockedBannerMessage})` : 'Blocked');

    return {
      tests: testsLabel,
      coverage: coverageLabel,
      merge: mergeLabel
    };
  }, [
    activeWorkingBranch,
    activeBranchName,
    branchReadyToMerge,
    mergeBlockedBannerMessage,
    testsPassed,
    testsRequired,
    isCssOnlyStaged
  ]);

  const commitSubject = getCommitSubjectForBranch(activeBranchName);
  const commitBody = getCommitBodyForBranch(activeBranchName);
  const isGeneratingCommit = commitMessageRequest === activeBranchName;
  const commitSubjectReady = Boolean(typeof commitSubject === 'string' && commitSubject.trim());
  const canCommit = Boolean(projectId && activeBranchName && hasStagedFiles && commitSubjectReady && !commitInFlight);
  const mergedCommitError = commitActionError || commitMessageError;
  const commitHint = !hasStagedFiles
    ? 'Stage at least one file to enable commits.'
    : (!commitSubjectReady ? 'Add a short subject line to enable the commit.' : null);

  const consumedAutofillRef = useRef(new Set());
  const userSelectedRef = useRef(false);

  useEffect(() => {
    userSelectedRef.current = false;
  }, [projectId]);
  useEffect(() => {
    if (!autofillRequestId) {
      return;
    }

    if (!activeBranchName) {
      return;
    }

    const key = `${autofillRequestId}:${activeBranchName}`;
    if (consumedAutofillRef.current.has(key)) {
      return;
    }

    const subjectText = typeof commitSubject === 'string' ? commitSubject.trim() : '';
    const bodyText = typeof commitBody === 'string' ? commitBody.trim() : '';
    const canAutofillNow =
      isLLMConfigured &&
      hasStagedFiles &&
      !isGeneratingCommit &&
      !commitInFlight &&
      !subjectText &&
      !bodyText;

    consumedAutofillRef.current.add(key);

    if (typeof onConsumeAutofillRequest === 'function') {
      onConsumeAutofillRequest(autofillRequestId);
    }

    if (canAutofillNow) {
      handleCommitMessageAutofill(activeBranchName, stagedFiles);
    }
  }, [
    autofillRequestId,
    onConsumeAutofillRequest,
    isLLMConfigured,
    activeBranchName,
    hasStagedFiles,
    isGeneratingCommit,
    commitInFlight,
    commitSubject,
    commitBody,
    handleCommitMessageAutofill,
    stagedFiles
  ]);

  const applyCommits = useCallback((nextCommits = []) => {
    const uniqueCommits = dedupeCommitsBySha(nextCommits);
    setCommits(uniqueCommits);
    setSelectedCommitSha((prev) => {
      if (prev === PENDING_COMMIT_SELECTION) {
        return prev;
      }
      if (prev && uniqueCommits.some((commit) => commit.sha === prev)) {
        return prev;
      }
      return uniqueCommits[0]?.sha || '';
    });
  }, []);

  const toggleSquashSelection = useCallback((sha) => {
    const normalizedSha = typeof sha === 'string' ? sha.trim() : '';
    if (!normalizedSha) {
      return;
    }

    setSquashError(null);

    setSquashSelection((prev) => {
      if (prev.includes(normalizedSha)) {
        return prev.filter((value) => value !== normalizedSha);
      }
      if (prev.length >= 2) {
        setSquashError('Select at most two commits to squash.');
        return prev;
      }
      return [...prev, normalizedSha];
    });
  }, []);

  const clearSquashSelection = useCallback(() => {
    setSquashError(null);
    setSquashSelection([]);
  }, []);

  const openConfirmModal = useCallback((config) => {
    setConfirmModal({
      title: config?.title || '',
      message: config?.message || '',
      type: config?.type || 'default',
      confirmText: config?.confirmText ?? 'Confirm',
      cancelText: config?.cancelText ?? 'Cancel',
      processingMessage: config?.processingMessage || '',
      kind: config?.kind || 'default',
      onConfirm: typeof config?.onConfirm === 'function' ? config.onConfirm : null
    });
  }, []);

  const closeConfirmModal = useCallback(() => {
    setConfirmModal(null);
  }, []);

  const resolveSquashPair = useCallback(() => {
    if (squashSelection.length !== 2) {
      return null;
    }
    const [firstSha, secondSha] = squashSelection;
    const firstIndex = commits.findIndex((commit) => commit.sha === firstSha);
    const secondIndex = commits.findIndex((commit) => commit.sha === secondSha);
    if (firstIndex < 0 || secondIndex < 0) {
      return null;
    }
    const newerSha = firstIndex < secondIndex ? firstSha : secondSha;
    const olderSha = firstIndex < secondIndex ? secondSha : firstSha;
    return { olderSha, newerSha };
  }, [commits, squashSelection]);

  useEffect(() => {
    if (branchReadyToCommit && !userSelectedRef.current) {
      setSelectedCommitSha(PENDING_COMMIT_SELECTION);
      return;
    }

    if (!branchReadyToCommit && selectedCommitSha === PENDING_COMMIT_SELECTION) {
      setSelectedCommitSha(commits[0]?.sha || '');
    }
  }, [branchReadyToCommit, commits, selectedCommitSha]);

  const fetchCommits = useCallback(async () => {
    if (!projectId) {
      setCommits([]);
      setSelectedCommitSha('');
      clearSquashSelection();
      return;
    }

    setLoading(true);
    setError(null);
    setStatusMessage(null);

    try {
      const response = await axios.get(`/api/projects/${projectId}/commits`);
      if (response.data?.success) {
        if (response.data?.overview && typeof syncBranchOverview === 'function') {
          syncBranchOverview(projectId, response.data.overview);
        }
        applyCommits(response.data.commits || []);
      } else {
        setError(response.data?.error || 'Failed to load commits');
      }
    } catch (err) {
      console.error('Error fetching commits:', err);
      setError(err.response?.data?.error || 'Failed to load commits');
    } finally {
      setLoading(false);
    }
  }, [projectId, applyCommits, syncBranchOverview]);

  const handleSquashSelectedCommits = useCallback(async (pairOverride = null) => {
    if (!projectId || squashInFlight) {
      return;
    }

    const pair = pairOverride || resolveSquashPair();
    if (!pair) {
      setSquashError('Select exactly two commits to squash.');
      return;
    }

    try {
      setSquashError(null);
      setStatusMessage(null);
      setSquashInFlight(true);

      const response = await axios.post(`/api/projects/${projectId}/commits/squash`, pair);
      if (response.data?.success) {
        const nextCommits = response.data?.commits || commits;
        applyCommits(nextCommits);
        const newSha = response.data?.squashed?.newSha;
        if (typeof newSha === 'string' && newSha.trim()) {
          setSelectedCommitSha(newSha.trim());
        }
        clearSquashSelection();
        setStatusMessage('Squashed commits');
      } else {
        setSquashError(response.data?.error || 'Failed to squash commits');
      }
    } catch (err) {
      console.error('Error squashing commits:', err);
      setSquashError(err.response?.data?.error || 'Failed to squash commits');
    } finally {
      setSquashInFlight(false);
      closeConfirmModal();
    }
  }, [applyCommits, clearSquashSelection, closeConfirmModal, commits, projectId, resolveSquashPair, squashInFlight]);

  const requestSquashSelectedCommits = useCallback(() => {
    if (!projectId || squashInFlight) {
      return;
    }

    const pair = resolveSquashPair();
    if (!pair) {
      setSquashError('Select exactly two commits to squash.');
      return;
    }

    const older = commits.find((commit) => commit.sha === pair.olderSha);
    const newer = commits.find((commit) => commit.sha === pair.newerSha);

    openConfirmModal({
      kind: 'squash',
      type: 'danger',
      title: 'Squash selected commits?',
      confirmText: 'Squash',
      cancelText: 'Cancel',
      processingMessage: 'Squashing commits…',
      message: `This rewrites history on main. Newer: ${newer?.shortSha || pair.newerSha.slice(0, 7)}. Older: ${older?.shortSha || pair.olderSha.slice(0, 7)}.`,
      onConfirm: () => handleSquashSelectedCommits(pair)
    });
  }, [commits, handleSquashSelectedCommits, openConfirmModal, projectId, resolveSquashPair, squashInFlight]);

  const handleCommitStagedChanges = useCallback(async () => {
    if (!projectId || !activeBranchName || !canCommit) {
      return;
    }

    try {
      setCommitActionError(null);
      setStatusMessage(null);
      setCommitInFlight(true);

      const rawDraftMessage = getCommitMessageForBranch(activeBranchName);
      const draftMessage = typeof rawDraftMessage === 'string' ? rawDraftMessage.trim() : '';
      const commitPayload = draftMessage ? { message: draftMessage } : undefined;

      const response = await axios.post(
        `/api/projects/${projectId}/branches/${encodeURIComponent(activeBranchName)}/commit`,
        commitPayload
      );

      if (response.data?.overview && typeof syncBranchOverview === 'function') {
        syncBranchOverview(projectId, response.data.overview);
      }

      clearCommitMessageForBranch(activeBranchName);
      await fetchCommits();
      setStatusMessage('Committed staged changes');
    } catch (err) {
      console.error('Error committing staged changes:', err);
      setCommitActionError(err.response?.data?.error || 'Failed to commit staged changes');
    } finally {
      setCommitInFlight(false);
    }
  }, [
    projectId,
    activeBranchName,
    canCommit,
    getCommitMessageForBranch,
    clearCommitMessageForBranch,
    fetchCommits,
    syncBranchOverview
  ]);

  const handleMergeBranch = useCallback(async () => {
    if (!projectId || !activeBranchName || !branchReadyToMerge) {
      return;
    }

    try {
      setMergeActionError(null);
      setStatusMessage(null);
      setMergeInFlight(true);

      const response = await axios.post(
        `/api/projects/${projectId}/branches/${encodeURIComponent(activeBranchName)}/merge`
      );

      if (response.data?.overview && typeof syncBranchOverview === 'function') {
        syncBranchOverview(projectId, response.data.overview);
      }

      await fetchCommits();
      setStatusMessage('Merged branch into main');
    } catch (err) {
      console.error('Error merging branch:', err);
      setMergeActionError(err.response?.data?.error || 'Failed to merge branch');
    } finally {
      setMergeInFlight(false);
    }
  }, [projectId, activeBranchName, branchReadyToMerge, fetchCommits, syncBranchOverview]);

  const handleManualAutofill = useCallback(() => {
    if (!isLLMConfigured || !activeBranchName || !hasStagedFiles) {
      return;
    }
    if (isGeneratingCommit || commitInFlight) {
      return;
    }
    handleCommitMessageAutofill(activeBranchName, stagedFiles);
  }, [
    isLLMConfigured,
    activeBranchName,
    hasStagedFiles,
    isGeneratingCommit,
    commitInFlight,
    handleCommitMessageAutofill,
    stagedFiles
  ]);

  useEffect(() => {
    fetchCommits();
  }, [fetchCommits]);

  const handleSelectCommit = useCallback((sha) => {
    if (!sha) {
      return;
    }
    userSelectedRef.current = true;
    setStatusMessage(null);
    setSelectedCommitSha(sha);
  }, []);

  const handleSelectPending = useCallback(() => {
    userSelectedRef.current = true;
    setStatusMessage(null);
    setSelectedCommitSha(PENDING_COMMIT_SELECTION);
  }, []);

  const loadCommitDetails = useCallback(async (sha) => {
    if (!projectId || !sha || sha === PENDING_COMMIT_SELECTION || commitDetails[sha]) {
      return;
    }

    try {
      setDetailLoadingSha(sha);
      const response = await axios.get(`/api/projects/${projectId}/commits/${encodeURIComponent(sha)}`);
      if (response.data?.success && response.data.commit) {
        setCommitDetails((prev) => ({
          ...prev,
          [sha]: response.data.commit
        }));
      }
    } catch (err) {
      console.error('Error loading commit details:', err);
      setError(err.response?.data?.error || 'Failed to load commit details');
    } finally {
      setDetailLoadingSha((current) => (current === sha ? null : current));
    }
  }, [projectId, commitDetails]);

  useEffect(() => {
    if (selectedCommitSha && selectedCommitSha !== PENDING_COMMIT_SELECTION && !commitDetails[selectedCommitSha]) {
      loadCommitDetails(selectedCommitSha);
    }
  }, [selectedCommitSha, commitDetails, loadCommitDetails]);

  const handleRevertCommit = useCallback(async (sha) => {
    if (!projectId || !sha || revertingSha === sha) {
      return;
    }

    const targetCommit = commits.find((commit) => commit.sha === sha);
    if (!targetCommit || targetCommit.canRevert === false) {
      return;
    }

    try {
      setError(null);
      setStatusMessage(null);
      setRevertingSha(sha);
      const response = await axios.post(
        `/api/projects/${projectId}/commits/${encodeURIComponent(sha)}/revert`
      );
      if (response.data?.success) {
        const nextCommits = response.data?.commits || commits;
        applyCommits(nextCommits);
        const shortSha = sha.slice(0, 7);
        setStatusMessage(`Reverted ${shortSha}`);
      } else {
        setError(response.data?.error || 'Failed to revert commit');
      }
    } catch (err) {
      console.error('Error reverting commit:', err);
      setError(err.response?.data?.error || 'Failed to revert commit');
    } finally {
      setRevertingSha(null);
      closeConfirmModal();
    }
  }, [applyCommits, closeConfirmModal, commits, projectId, revertingSha]);

  const requestRevertCommit = useCallback((sha) => {
    if (!projectId || !sha || revertingSha === sha) {
      return;
    }

    const targetCommit = commits.find((commit) => commit.sha === sha);
    if (!targetCommit || targetCommit.canRevert === false) {
      return;
    }

    openConfirmModal({
      kind: 'revert',
      type: 'warning',
      title: 'Revert this commit?',
      confirmText: 'Revert',
      cancelText: 'Cancel',
      processingMessage: 'Reverting commit…',
      message: 'A new commit will be created with the reversal.',
      onConfirm: () => handleRevertCommit(sha)
    });
  }, [commits, handleRevertCommit, openConfirmModal, projectId, revertingSha]);

  const selectedCommit = useMemo(
    () => (selectedCommitSha && selectedCommitSha !== PENDING_COMMIT_SELECTION
      ? commits.find((commit) => commit.sha === selectedCommitSha) || null
      : null),
    [commits, selectedCommitSha]
  );
  const selectedDetails = (selectedCommitSha && selectedCommitSha !== PENDING_COMMIT_SELECTION)
    ? commitDetails[selectedCommitSha]
    : null;
  const isDetailLoading = detailLoadingSha === selectedCommitSha && selectedCommitSha !== PENDING_COMMIT_SELECTION;
  const canOpenFiles = Boolean(projectId && requestEditorFocus);
  const canRevertSelectedCommit = Boolean(
    projectId &&
    selectedCommit &&
    selectedCommit.canRevert !== false
  );

  const handleOpenFileFromCommit = useCallback((filePath) => {
    if (!canOpenFiles || !filePath) {
      return;
    }
    requestEditorFocus(projectId, filePath, { source: 'commits', highlight: 'diff', commitSha: selectedCommitSha });
  }, [canOpenFiles, projectId, requestEditorFocus, selectedCommitSha]);

  useEffect(() => {
    if (testApiRef) {
      testApiRef.current = {
        applyCommits,
        fetchCommits,
        openConfirmModal,
        closeConfirmModal,
        handleCommitStagedChanges,
        handleManualAutofill,
        handleMergeBranch,
        handleSelectCommit,
        handleSelectPending,
        toggleSquashSelection,
        clearSquashSelection,
        handleSquashSelectedCommits,
        requestSquashSelectedCommits,
        loadCommitDetails,
        handleRevertCommit,
        requestRevertCommit,
        handleOpenFileFromCommit
      };
    }
  }, [
    testApiRef,
    applyCommits,
    fetchCommits,
    openConfirmModal,
    closeConfirmModal,
    handleCommitStagedChanges,
    handleManualAutofill,
    handleMergeBranch,
    handleSelectCommit,
    handleSelectPending,
    toggleSquashSelection,
    clearSquashSelection,
    handleSquashSelectedCommits,
    requestSquashSelectedCommits,
    loadCommitDetails,
    handleRevertCommit,
    requestRevertCommit,
    handleOpenFileFromCommit
  ]);

  const confirmIsOpen = Boolean(confirmModal);
  const confirmIsProcessing = confirmModal?.kind === 'squash'
    ? squashInFlight
    : (confirmModal?.kind === 'revert' ? Boolean(revertingSha) : false);

  return (
    <div className="commits-tab" data-testid="commits-tab-panel">
      <Modal
        isOpen={confirmIsOpen}
        onClose={closeConfirmModal}
        onConfirm={confirmModal?.onConfirm || null}
        title={confirmModal?.title || ''}
        message={confirmModal?.message || ''}
        confirmText={confirmModal?.confirmText}
        cancelText={confirmModal?.cancelText}
        type={confirmModal?.type || 'default'}
        isProcessing={confirmIsProcessing}
        processingMessage={confirmModal?.processingMessage || ''}
        confirmLoadingText="Working…"
      />
      {loading && <div className="loading">Loading commits...</div>}
      {error && !loading && <div className="error">{error}</div>}

      {!loading && !error && (
        <div className="commits-layout">
          <aside className="commits-list-panel">
            <div className="panel-header">
              <div>
                <p className="panel-eyebrow">Commit history</p>
                <h4>{project?.name || 'Active project'}</h4>
              </div>
              <button
                type="button"
                className="commits-action ghost"
                onClick={fetchCommits}
                disabled={!projectId}
                data-testid="commits-refresh"
              >
                Refresh
              </button>
            </div>

            {Boolean(squashSelection.length) && (
              <div className="commits-status-message" role="status" data-testid="commit-squash-bar">
                <span>{squashSelection.length} selected</span>
                <span aria-hidden="true"> • </span>
                <button
                  type="button"
                  className="commits-action"
                  onClick={requestSquashSelectedCommits}
                  disabled={!projectId || squashSelection.length !== 2 || squashInFlight}
                  data-testid="commit-squash-action"
                >
                  {squashInFlight ? 'Squashing…' : 'Squash selected'}
                </button>
                <button
                  type="button"
                  className="commits-action ghost"
                  onClick={clearSquashSelection}
                  disabled={squashInFlight}
                  data-testid="commit-squash-clear"
                >
                  Clear
                </button>
              </div>
            )}

            {squashError && (
              <div className="error" role="alert" data-testid="commit-squash-error">
                {squashError}
              </div>
            )}
            <div className="commits-list" data-testid="commits-list">
              {branchReadyToCommit && (
                <button
                  key={`pending:${activeBranchName}`}
                  type="button"
                  className={`commits-list-item pending${isPendingSelected ? ' selected' : ''}`}
                  onClick={handleSelectPending}
                  data-testid="commit-pending"
                >
                  <div className="commit-list-primary">
                    <div className="commit-message" title={`Pending commit for ${activeBranchName}`}>Pending commit</div>
                    <span className="commit-sha">{activeBranchName}</span>
                  </div>
                  <div className="commit-list-meta">
                    <span>{stagedFiles.length} staged file{stagedFiles.length === 1 ? '' : 's'}</span>
                    <span>•</span>
                    <span>{isCssOnlyStaged ? 'CSS-only (tests optional)' : 'Tests passed'}</span>
                  </div>
                </button>
              )}
              {commits.map((commit) => (
                <button
                  key={commit.sha}
                  type="button"
                  className={`commits-list-item${commit.sha === selectedCommitSha ? ' selected' : ''}`}
                  onClick={() => handleSelectCommit(commit.sha)}
                  data-testid={`commit-${commit.shortSha}`}
                >
                  <div className="commit-list-primary">
                    <input
                      type="checkbox"
                      checked={squashSelection.includes(commit.sha)}
                      onChange={() => toggleSquashSelection(commit.sha)}
                      onClick={(event) => event.stopPropagation()}
                      aria-label={`Select ${commit.shortSha} for squash`}
                      data-testid={`commit-squash-select-${commit.shortSha}`}
                    />
                    <div className="commit-message" title={commit.message}>{commit.message || 'No message'}</div>
                    <span className="commit-sha">{commit.shortSha}</span>
                  </div>
                  <div className="commit-list-meta">
                    <span>{commit.author?.name || 'Unknown author'}</span>
                    <span>•</span>
                    <span>{formatTimestamp(commit.authoredAt)}</span>
                  </div>
                </button>
              ))}
              {!commits.length && (
                <div className="commits-empty" data-testid="commits-empty">
                  No commits found in this project yet.
                </div>
              )}
            </div>
          </aside>

          <section className="commits-details-panel" data-testid="commit-details-panel">
            {statusMessage && (
              <div className="commits-status-message" role="status">
                {statusMessage}
              </div>
            )}

            {gateStatus && (
              <div className="commits-status-message" role="status" data-testid="commit-gate-status">
                <span data-testid="commit-gate-tests">Tests: {formatGateValue(gateStatus.tests)}</span>
                <span aria-hidden="true"> • </span>
                <span data-testid="commit-gate-coverage">Coverage: {formatGateValue(gateStatus.coverage)}</span>
                <span aria-hidden="true"> • </span>
                <span data-testid="commit-gate-merge">Merge: {formatGateValue(gateStatus.merge)}</span>
              </div>
            )}

            {mergeActionError && (
              <div className="error" role="alert">
                {mergeActionError}
              </div>
            )}

            {!mergeActionError && mergeBlockedBannerMessage && (
              <div className="commits-status-message" role="status" data-testid="commit-merge-blocked">
                Merge blocked: {mergeBlockedBannerMessage}
              </div>
            )}

            {branchReadyToMerge && !shouldShowCommitComposer && (
              <div className="commit-pending-header" data-testid="commit-merge-header">
                <div>
                  <p className="panel-eyebrow">Ready to merge</p>
                  <h3 data-testid="commit-merge-branch">{activeBranchName}</h3>
                  <div className="commit-detail-meta">
                    <span>No staged changes</span>
                    <span>•</span>
                    <span>{mergeIsCssOnly ? 'CSS-only (tests optional)' : 'Tests passed'}</span>
                  </div>
                </div>
                <button
                  type="button"
                  className="commits-action success"
                  onClick={handleMergeBranch}
                  disabled={mergeInFlight || commitInFlight}
                  data-testid="commit-merge"
                >
                  {mergeInFlight ? 'Merging…' : 'Merge into main'}
                </button>
              </div>
            )}

            {shouldShowCommitComposer && (
              <div className="commit-pending-header" data-testid="commit-pending-header">
                <div>
                  <p className="panel-eyebrow">Ready to commit</p>
                  <h3 data-testid="commit-pending-branch">{activeBranchName}</h3>
                  <div className="commit-detail-meta">
                    <span>{stagedFiles.length} staged file{stagedFiles.length === 1 ? '' : 's'}</span>
                    <span>•</span>
                    <span>{isCssOnlyStaged ? 'CSS-only (skip tests allowed)' : 'Tests passed'}</span>
                  </div>
                </div>
              </div>
            )}

            {shouldShowCommitComposer && (
              <CommitComposer
                hasSelectedFiles={hasStagedFiles}
                commitSubject={commitSubject}
                commitBody={commitBody}
                onSubjectChange={(value) => {
                  setCommitActionError(null);
                  handleCommitMessageChange(activeBranchName, { subject: value });
                }}
                onBodyChange={(value) => {
                  setCommitActionError(null);
                  handleCommitMessageChange(activeBranchName, { body: value });
                }}
                onCommit={handleCommitStagedChanges}
                onAutofill={handleManualAutofill}
                canAutofill={Boolean(isLLMConfigured && activeBranchName && hasStagedFiles)}
                canCommit={canCommit}
                isCommitting={commitInFlight}
                commitHint={commitHint}
                isGenerating={isGeneratingCommit}
                commitMessageError={mergedCommitError}
              />
            )}

            {selectedCommit ? (
              <>
                <div className="commit-detail-header">
                  <div>
                    <p className="panel-eyebrow">Selected commit</p>
                    <h3>{selectedCommit.message || 'No message provided'}</h3>
                    <div className="commit-detail-meta">
                      <span>{selectedCommit.shortSha}</span>
                      <span>•</span>
                      <span>{selectedCommit.author?.name || 'Unknown author'}</span>
                      <span>•</span>
                      <span>{formatTimestamp(selectedCommit.authoredAt)}</span>
                    </div>
                  </div>
                  {canRevertSelectedCommit && (
                    <button
                      type="button"
                      className="commits-action destructive"
                      onClick={() => requestRevertCommit(selectedCommit.sha)}
                      disabled={!projectId || revertingSha === selectedCommit.sha}
                      data-testid="commit-revert"
                    >
                      {revertingSha === selectedCommit.sha ? 'Reverting…' : 'Revert commit'}
                    </button>
                  )}
                </div>

                {isDetailLoading && (
                  <div className="loading" data-testid="commit-details-loading">Loading commit details…</div>
                )}

                {!isDetailLoading && selectedDetails && (
                  <>
                    <div className="commit-detail-body">
                      <p>{selectedDetails.body || 'No extended description for this commit.'}</p>
                    </div>
                    <div className="commit-files-card">
                      <div className="panel-header">
                        <div>
                          <p className="panel-eyebrow">Changed files</p>
                          <h4>
                            {selectedDetails.files?.length
                              ? `${selectedDetails.files.length} file${selectedDetails.files.length === 1 ? '' : 's'}`
                              : 'No file metadata available'}
                          </h4>
                        </div>
                      </div>
                      {selectedDetails.files?.length ? (
                        <ul className="commit-files-list" data-testid="commit-files-list">
                          {selectedDetails.files.map((file, index) => (
                            <li key={`${selectedDetails.sha}-${file.path}`}>
                              <button
                                type="button"
                                className="commit-file-entry"
                                onClick={() => handleOpenFileFromCommit(file.path)}
                                disabled={!canOpenFiles}
                                data-testid={`commit-file-open-${index}`}
                                title={canOpenFiles ? `Open ${file.path}` : undefined}
                              >
                                <span className={`commit-file-status status-${file.status?.toLowerCase() || 'm'}`}>
                                  {file.status || 'M'}
                                </span>
                                <span className="commit-file-path">{file.path}</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="commits-empty" data-testid="commit-no-files">
                          File-level details unavailable for this commit.
                        </div>
                      )}
                    </div>
                  </>
                )}

                {!isDetailLoading && !selectedDetails && (
                  <div className="commits-empty" data-testid="commit-details-missing">
                    Commit metadata is unavailable for this selection.
                  </div>
                )}
              </>
            ) : (
              <div className="commits-empty" data-testid="commit-no-selection">
                {branchReadyToCommit
                  ? 'Select the pending commit to author a message, or select a commit to view details.'
                  : 'Select a commit to view details.'}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
};

export default CommitsTab;
