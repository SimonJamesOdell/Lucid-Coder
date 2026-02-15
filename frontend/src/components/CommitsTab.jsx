import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import axios from 'axios';
import { useAppState } from '../context/AppStateContext';
import { useCommitComposer } from './branch-tab/useCommitComposer';
import { describeMergeBlocker, isPassingTestStatus } from './branch-tab/utils';
import Modal from './Modal';
import './CommitsTab.css';
import './BranchTab.css';
import CommitListPanel from './commitsTab/CommitListPanel';
import CommitDetailsPanel from './commitsTab/CommitDetailsPanel';
import { dedupeCommitsBySha, formatCoverageGateLabel } from './commitsTab/formatters';

const PENDING_COMMIT_SELECTION = '__pending__';
const CSS_ONLY_GATE_LABEL = 'CSS-only (tests optional)';
const CSS_ONLY_MERGE_BLOCK_LABEL = 'Commit CSS-only changes before merging';

const CommitsTab = ({
  project,
  autofillRequestId = null,
  onConsumeAutofillRequest = null,
  onRequestTestsTab = null,
  registerCommitsActions = null,
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
  const [clearInFlight, setClearInFlight] = useState(false);
  const [commitActionError, setCommitActionError] = useState(null);
  const [mergeInFlight, setMergeInFlight] = useState(false);
  const [mergeActionError, setMergeActionError] = useState(null);
  const [confirmModal, setConfirmModal] = useState(null);
  const { requestEditorFocus, workingBranches, workspaceChanges, syncBranchOverview, clearStagedChanges } = useAppState();

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
  const testsStatus = activeWorkingBranch?.lastTestStatus;
  const branchIsProven = activeWorkingBranch?.status === 'ready-for-merge';
  const branchReadyToCommit = Boolean(
    activeBranchName
    && activeBranchName !== 'main'
    && hasStagedFiles
    && (isCssOnlyStaged || (branchIsProven && testsPassed))
  );

  // We treat "proven" (ready-for-merge) as the source of truth that a passing test
  // run has been recorded for this branch. A passing status alone is not sufficient.
  const testsSatisfiedForMerge = Boolean(testsRequired === false || (branchIsProven && testsPassed));

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

  const shouldShowTestingCta = Boolean(
    activeBranchName
    && activeBranchName !== 'main'
    && hasStagedFiles
    && testsRequired !== false
    && !isCssOnlyStaged
    && (!branchIsProven || !testsPassed || testsStatus === 'pending')
  );

  const shouldShowGateBanners = Boolean(!branchReadyToMerge && !shouldShowTestingCta && !shouldShowCommitComposer);

  const handleStartTesting = useCallback(() => {
    if (typeof onRequestTestsTab !== 'function') {
      return;
    }

    onRequestTestsTab({
      autoRun: true,
      source: 'automation',
      returnToCommits: true
    });
  }, [onRequestTestsTab]);

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
      return [];
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
        const nextCommits = response.data.commits || [];
        applyCommits(nextCommits);
        return nextCommits;
      } else {
        setError(response.data?.error || 'Failed to load commits');
      }
    } catch (err) {
      console.error('Error fetching commits:', err);
      setError(err.response?.data?.error || 'Failed to load commits');
    } finally {
      setLoading(false);
    }

    return null;
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
      const nextCommits = await fetchCommits();
      const headSha = Array.isArray(nextCommits) ? nextCommits[0]?.sha : null;
      if (typeof headSha === 'string' && headSha.trim()) {
        userSelectedRef.current = false;
        setSelectedCommitSha(headSha.trim());
      }
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

  const handleClearStagedChanges = useCallback(async () => {
    if (!projectId || !activeBranchName || !hasStagedFiles || clearInFlight || commitInFlight) {
      return;
    }

    if (typeof clearStagedChanges !== 'function') {
      return;
    }

    try {
      setCommitActionError(null);
      setStatusMessage(null);
      setClearInFlight(true);

      const response = await clearStagedChanges(projectId, { branchName: activeBranchName });

      if (response?.overview && typeof syncBranchOverview === 'function') {
        syncBranchOverview(projectId, response.overview);
      }

      await fetchCommits();
      setStatusMessage('Cleared staged changes');
    } catch (err) {
      console.error('Error clearing staged changes:', err);
      setCommitActionError(err?.message || 'Failed to clear staged changes');
    } finally {
      setClearInFlight(false);
    }
  }, [
    projectId,
    activeBranchName,
    hasStagedFiles,
    clearInFlight,
    commitInFlight,
    clearStagedChanges,
    syncBranchOverview,
    fetchCommits
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

  useEffect(() => {
    if (typeof registerCommitsActions !== 'function') {
      return undefined;
    }

    const cleanup = registerCommitsActions({
      refreshCommits: fetchCommits,
      isDisabled: !projectId
    });

    return () => {
      if (typeof cleanup === 'function') {
        cleanup();
      }
    };
  }, [fetchCommits, projectId, registerCommitsActions]);

  useEffect(() => {
    if (!statusMessage) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setStatusMessage(null);
    }, 2500);

    timeoutId.unref?.();

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [statusMessage]);

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
        handleClearStagedChanges,
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
    handleClearStagedChanges,
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
          <CommitListPanel
            projectId={projectId}
            commits={commits}
            branchReadyToCommit={branchReadyToCommit}
            activeBranchName={activeBranchName}
            isPendingSelected={isPendingSelected}
            stagedFiles={stagedFiles}
            isCssOnlyStaged={isCssOnlyStaged}
            squashSelection={squashSelection}
            squashInFlight={squashInFlight}
            squashError={squashError}
            selectedCommitSha={selectedCommitSha}
            onSelectPending={handleSelectPending}
            onSelectCommit={handleSelectCommit}
            onToggleSquashSelection={toggleSquashSelection}
            onRequestSquash={requestSquashSelectedCommits}
            onClearSquash={clearSquashSelection}
          />

          <CommitDetailsPanel
            projectId={projectId}
            statusMessage={statusMessage}
            gateStatus={shouldShowGateBanners ? gateStatus : null}
            mergeActionError={mergeActionError}
            mergeBlockedBannerMessage={shouldShowGateBanners ? mergeBlockedBannerMessage : null}
            branchReadyToMerge={branchReadyToMerge}
            shouldShowCommitComposer={shouldShowCommitComposer}
            activeBranchName={activeBranchName}
            stagedFiles={stagedFiles}
            isCssOnlyStaged={isCssOnlyStaged}
            mergeIsCssOnly={mergeIsCssOnly}
            handleMergeBranch={handleMergeBranch}
            mergeInFlight={mergeInFlight}
            commitInFlight={commitInFlight}
            shouldShowTestingCta={shouldShowTestingCta}
            testsStatus={testsStatus}
            onStartTesting={handleStartTesting}
            hideCommitDetails={shouldShowTestingCta}
            hasStagedFiles={hasStagedFiles}
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
            onClearChanges={handleClearStagedChanges}
            onAutofill={handleManualAutofill}
            canAutofill={Boolean(isLLMConfigured && activeBranchName && hasStagedFiles)}
            canCommit={canCommit}
            commitHint={commitHint}
            isGeneratingCommit={isGeneratingCommit}
            isClearingChanges={clearInFlight}
            commitMessageError={mergedCommitError}
            selectedCommit={selectedCommit}
            isDetailLoading={isDetailLoading}
            selectedDetails={selectedDetails}
            canRevertSelectedCommit={canRevertSelectedCommit}
            revertingSha={revertingSha}
            requestRevertCommit={requestRevertCommit}
            handleOpenFileFromCommit={handleOpenFileFromCommit}
            canOpenFiles={canOpenFiles}
            branchReadyToCommit={branchReadyToCommit}
          />
        </div>
      )}
    </div>
  );
};

export default CommitsTab;
