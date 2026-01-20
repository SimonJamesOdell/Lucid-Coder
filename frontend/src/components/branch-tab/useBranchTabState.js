import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import axios from 'axios';
import { useAppState } from '../../context/AppStateContext';
import {
  computeStagedSignature,
  canBranchMerge,
  describeMergeBlocker,
  isPassingTestStatus,
  isCssStylesheetPath
} from './utils';
import {
  buildBranchSelectionKey,
  loadStoredBranchSelection,
  persistBranchSelection,
  getBranchFallbackName,
  setBranchFallbackName,
  resetBranchFallbackName
} from './branchSelectionStorage';
import { normalizeRepoPath } from './repoPathUtils';

const TEST_JOB_TYPES = ['frontend:test', 'backend:test'];

const useBranchTabState = ({
  project,
  onRequestTestsTab,
  onRequestCommitsTab,
  onRequestFileOpen,
  getCommitMessageForBranch,
  clearCommitMessageForBranch
}) => {
  const projectId = project?.id;
  const [currentBranch, setCurrentBranch] = useState(null);
  const [branchSummaries, setBranchSummaries] = useState([]);
  const [selectedBranch, setSelectedBranchState] = useState(() => loadStoredBranchSelection(projectId));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [workingBranches, setWorkingBranches] = useState([]);
  const [testInFlight, setTestInFlight] = useState(null);
  const [mergeInFlight, setMergeInFlight] = useState(null);
  const [commitInFlight, setCommitInFlight] = useState(null);
  const [testMergeInFlight, setTestMergeInFlight] = useState(null);
  const [skipMergeInFlight, setSkipMergeInFlight] = useState(null);
  const [deleteInFlight, setDeleteInFlight] = useState(null);
  const [createBranchInFlight, setCreateBranchInFlight] = useState(false);
  const [mergeWarning, setMergeWarning] = useState(null);
  const [branchTestValidity, setBranchTestValidity] = useState({});
  const stagedSignatureMapRef = useRef(new Map());
  const selectedBranchRef = useRef('');
  useEffect(() => {
    setSelectedBranchState(loadStoredBranchSelection(projectId));
  }, [projectId]);

  const setSelectedBranch = useCallback((branchName) => {
    const normalized = branchName || '';
    setSelectedBranchState(normalized);
    persistBranchSelection(projectId, normalized);
  }, [projectId]);

  const {
    clearStagedChanges,
    syncBranchOverview,
    projectShutdownState,
    isProjectStopping,
    workspaceChanges,
    workingBranches: contextWorkingBranches,
    startAutomationJob,
    markTestRunIntent
  } = useAppState();

  const workspaceChangesRef = useRef(workspaceChanges);
  const contextWorkingBranchesRef = useRef(contextWorkingBranches);
  const lastNonEmptyWorkingBranchesRef = useRef([]);

  useEffect(() => {
    workspaceChangesRef.current = workspaceChanges;
  }, [workspaceChanges]);

  useEffect(() => {
    contextWorkingBranchesRef.current = contextWorkingBranches;
  }, [contextWorkingBranches]);

  useEffect(() => {
    if (Array.isArray(workingBranches) && workingBranches.length > 0) {
      lastNonEmptyWorkingBranchesRef.current = workingBranches;
    }
  }, [workingBranches]);
  const isStoppingProject = isProjectStopping?.(projectId) ?? Boolean(
    projectShutdownState?.isStopping && projectShutdownState?.projectId === projectId
  );
  const shutdownError = projectShutdownState?.error && projectShutdownState?.projectId === projectId
    ? projectShutdownState.error
    : null;
  const showShutdownBanner = Boolean(isStoppingProject || shutdownError);

  const markBranchInvalidated = useCallback((branchName) => {
    if (!branchName) {
      return;
    }
    setBranchTestValidity((prev) => {
      const entry = prev[branchName];
      if (entry?.invalidated) {
        return prev;
      }
      return {
        ...prev,
        [branchName]: { invalidated: true }
      };
    });
  }, []);

  const markBranchValidated = useCallback((branchName) => {
    if (!branchName) {
      return;
    }
    setBranchTestValidity((prev) => {
      const entry = prev[branchName];
      if (entry && entry.invalidated === false) {
        return prev;
      }
      return {
        ...prev,
        [branchName]: { invalidated: false }
      };
    });
  }, []);

  const mergeOverviewWithLocalStaged = useCallback((overview) => {
    if (
      !projectId
      || !overview
      || !Array.isArray(overview.workingBranches)
      || overview.workingBranches.length === 0
    ) {
      return overview;
    }

    const localProjectChanges = workspaceChangesRef.current?.[projectId];
    const localStagedFiles = Array.isArray(localProjectChanges?.stagedFiles)
      ? localProjectChanges.stagedFiles
      : [];

    if (!localStagedFiles.length) {
      return overview;
    }

    const trackedBranchName = contextWorkingBranchesRef.current?.[projectId]?.name;
    const targetIndex = typeof trackedBranchName === 'string'
      ? overview.workingBranches.findIndex((branch) => branch.name === trackedBranchName)
      : (overview.workingBranches.length === 1 ? 0 : -1);

    if (targetIndex === -1) {
      return overview;
    }

    const nextWorkingBranches = overview.workingBranches.map((branch, index) => (
      index === targetIndex
        ? { ...branch, stagedFiles: localStagedFiles }
        : branch
    ));

    return {
      ...overview,
      workingBranches: nextWorkingBranches
    };
  }, [projectId]);

  const applyOverview = useCallback((overview) => {
    if (!overview) {
      return;
    }

    const normalizedOverview = mergeOverviewWithLocalStaged(overview);
    const allowedStatuses = new Set(['active', 'ready-for-merge', 'needs-fix', 'ready']);
    const mappedBranches = (normalizedOverview.branches || [])
      .filter((branch) => branch.name === 'main' || allowedStatuses.has(branch.status))
      .map((branch, index) => ({
        ...branch,
        order: index
      }));

    setBranchSummaries(mappedBranches);
    setWorkingBranches(Array.isArray(normalizedOverview.workingBranches) ? normalizedOverview.workingBranches : []);
    setCurrentBranch(normalizedOverview.current || 'main');
    syncBranchOverview?.(projectId, normalizedOverview);
  }, [projectId, syncBranchOverview, mergeOverviewWithLocalStaged]);

  const fetchBranches = useCallback(async () => {
    if (!projectId) {
      return null;
    }
    setLoading(true);
    let payload = null;
    try {
      const response = await axios.get(`/api/projects/${projectId}/branches`);
      payload = response.data;
      if (payload?.success) {
        applyOverview(payload);
      }
    } catch (err) {
      console.error('Failed to load branches:', err);
      setError(err.response?.data?.error || 'Failed to load branches');
      payload = null;
    } finally {
      setLoading(false);
    }
    return payload;
  }, [projectId, applyOverview]);

  useEffect(() => {
    fetchBranches();
  }, [fetchBranches]);

  const workingBranchMap = useMemo(() => {
    if (!Array.isArray(workingBranches)) {
      return new Map();
    }
    return new Map(workingBranches.map((branch) => [branch.name, branch]));
  }, [workingBranches]);

  const getCachedWorkingBranch = useCallback((branchName) => {
    if (!branchName) {
      return null;
    }
    const fromState = workingBranches.find((branch) => branch?.name === branchName) || null;
    if (fromState) {
      return fromState;
    }
    const fallback = lastNonEmptyWorkingBranchesRef.current;
    if (Array.isArray(fallback) && fallback.length > 0) {
      return fallback.find((branch) => branch?.name === branchName) || null;
    }
    return null;
  }, [workingBranches]);

  const sortedBranches = useMemo(() => {
    if (!branchSummaries.length) {
      return [];
    }

    const list = [...branchSummaries];
    list.sort((a, b) => {
      if (a.isCurrent) return -1;
      if (b.isCurrent) return 1;
      return (b.order ?? 0) - (a.order ?? 0);
    });
    return list;
  }, [branchSummaries]);

  useEffect(() => {
    if (!selectedBranch || !branchSummaries.length) {
      return;
    }
    const exists = branchSummaries.some((branch) => branch.name === selectedBranch);
    if (!exists) {
      setSelectedBranch('');
    }
  }, [branchSummaries, selectedBranch, setSelectedBranch]);

  const selectedBranchName = selectedBranch || sortedBranches[0]?.name || currentBranch || getBranchFallbackName();
  const selectedSummary = sortedBranches.find((branch) => branch.name === selectedBranchName) || null;
  const selectedWorkingBranch = workingBranchMap.get(selectedBranchName)
    || workingBranches.find((branch) => branch.name === selectedBranchName)
    || null;

  useEffect(() => {
    selectedBranchRef.current = selectedBranchName || '';
  }, [selectedBranchName]);

  const trackedWorkingBranch = projectId && contextWorkingBranches
    ? contextWorkingBranches[projectId]
    : null;
  const trackedBranchName = trackedWorkingBranch?.name;
  const localStagedFiles = useMemo(() => {
    if (!projectId || !workspaceChanges) {
      return [];
    }
    const projectState = workspaceChanges[projectId];
    return Array.isArray(projectState?.stagedFiles) ? projectState.stagedFiles : [];
  }, [projectId, workspaceChanges]);

  const selectedFiles = useMemo(() => {
    const remoteFiles = Array.isArray(selectedWorkingBranch?.stagedFiles)
      ? selectedWorkingBranch.stagedFiles
      : null;
    const shouldUseLocalFallback = (!remoteFiles || remoteFiles.length === 0)
      && trackedBranchName
      && selectedBranchName === trackedBranchName
      && localStagedFiles.length > 0;

    if (shouldUseLocalFallback) {
      return localStagedFiles;
    }
    if (remoteFiles) {
      return remoteFiles;
    }
    return [];
  }, [selectedWorkingBranch, trackedBranchName, selectedBranchName, localStagedFiles]);

  const hasSelectedFiles = selectedFiles.length > 0;
  const selectedFilesAreCssOnly = useMemo(() => {
    if (!hasSelectedFiles) {
      return false;
    }
    return selectedFiles.every((entry) => isCssStylesheetPath(entry?.path));
  }, [hasSelectedFiles, selectedFiles]);

  const triggerAutomationSuites = useCallback(async (branchNameParam, options = {}) => {
    if (!projectId || !startAutomationJob) {
      return;
    }

    const targetBranchName = branchNameParam || selectedBranchName || selectedBranchRef.current || null;
    if (!targetBranchName) {
      return;
    }

    markTestRunIntent?.('user');

    const assumeCssOnly = options.assumeCssOnly === true;
    let shouldSkipAutomation = assumeCssOnly;

    if (!shouldSkipAutomation) {
      try {
        const response = await axios.get(
          `/api/projects/${projectId}/branches/${encodeURIComponent(targetBranchName)}/css-only`
        );
        shouldSkipAutomation = Boolean(response?.data?.isCssOnly);
      } catch (cssError) {
        console.warn('[BranchTab] Failed to evaluate css-only status before automation run', cssError);
      }
    }

    if (shouldSkipAutomation) {
      return;
    }

    TEST_JOB_TYPES.forEach((jobType) => {
      startAutomationJob(jobType, { projectId, branchName: targetBranchName }).catch((jobError) => {
        console.warn(`[BranchTab] Failed to start ${jobType}`, jobError);
      });
    });
  }, [markTestRunIntent, projectId, selectedBranchName, startAutomationJob]);

  const performCommit = useCallback(async (branchName) => {
    if (!projectId || !branchName) {
      return null;
    }
    const commitDraft = (getCommitMessageForBranch?.(branchName) || '').trim();
    const commitPayload = commitDraft ? { message: commitDraft } : undefined;
    const response = await axios.post(
      `/api/projects/${projectId}/branches/${encodeURIComponent(branchName)}/commit`,
      commitPayload
    );
    if (commitDraft) {
      clearCommitMessageForBranch?.(branchName);
    }
    return response.data?.overview || null;
  }, [
    projectId,
    getCommitMessageForBranch,
    clearCommitMessageForBranch
  ]);

  const handleCommitBranch = useCallback(async (branchName) => {
    if (!projectId || !branchName || isStoppingProject) {
      return;
    }

    try {
      setMergeWarning(null);
      setCommitInFlight(branchName);
      const overview = await performCommit(branchName);
      if (overview) {
        applyOverview(overview);
      } else {
        await fetchBranches();
      }
    } catch (err) {
      console.error('Error committing branch:', err);
      setError(err.response?.data?.error || 'Failed to commit staged changes');
    } finally {
      setCommitInFlight(null);
    }
  }, [
    projectId,
    isStoppingProject,
    performCommit,
    applyOverview,
    fetchBranches,
    setMergeWarning,
    setError
  ]);

  const handleRunTests = useCallback(async (branchName, options = {}) => {
    if (!projectId || !branchName || isStoppingProject) {
      return null;
    }

    setMergeWarning(null);
    setTestInFlight(branchName);
    let result = null;
    let caughtError = null;
    try {
      onRequestTestsTab?.();
      const assumeCssOnly = branchName === selectedBranchName && selectedFilesAreCssOnly;
      await triggerAutomationSuites(branchName, { assumeCssOnly });
      const response = await axios.post(
        `/api/projects/${projectId}/branches/${encodeURIComponent(branchName)}/tests`
      );
      const payload = response.data;
      const status = payload?.testRun?.status || payload?.status || payload?.lastTestStatus;
      const navigateToCommitsOnPass = options.navigateToCommitsOnPass === true;
      if (isPassingTestStatus(status)) {
        markBranchValidated(branchName);
        if (navigateToCommitsOnPass) {
          onRequestCommitsTab?.();
        }
      } else if (status) {
        markBranchInvalidated(branchName);
      }
      const overview = await fetchBranches();
      result = { ...payload, overview };
    } catch (err) {
      console.error('Error running tests:', err);
      const message = err.response?.data?.error || 'Failed to run tests';
      setError(message);
      caughtError = err;
    } finally {
      setTestInFlight(null);
    }
    if (caughtError) {
      throw caughtError;
    }
    return result;
  }, [
    projectId,
    fetchBranches,
    isStoppingProject,
    onRequestTestsTab,
    onRequestCommitsTab,
    triggerAutomationSuites,
    markBranchValidated,
    markBranchInvalidated,
    selectedBranchName,
    selectedFilesAreCssOnly
  ]);

  const handleMergeBranch = useCallback(async (branchName) => {
    if (!projectId || !branchName || isStoppingProject) {
      return;
    }

    try {
      setMergeInFlight(branchName);
      const response = await axios.post(
        `/api/projects/${projectId}/branches/${encodeURIComponent(branchName)}/merge`
      );

      if (response.data.success && response.data.overview) {
        applyOverview(response.data.overview);
      } else {
        await fetchBranches();
      }
    } catch (err) {
      console.error('Error merging branch:', err);
      setError(err.response?.data?.error || 'Failed to merge branch');
    } finally {
      setMergeInFlight(null);
    }
  }, [projectId, applyOverview, fetchBranches, isStoppingProject]);

  const handleTestAndMerge = useCallback(async (branchName) => {
    if (!projectId || !branchName || isStoppingProject) {
      return;
    }

    const cachedWorkingBranch = getCachedWorkingBranch(branchName);

    try {
      setMergeWarning(null);
      setTestMergeInFlight(branchName);
      const result = await handleRunTests(branchName);
      const status = result?.testRun?.status || result?.status || result?.lastTestStatus;
      if (!isPassingTestStatus(status)) {
        setMergeWarning('Tests must pass before merge');
        return;
      }
      const latestTestStatus = status;
      const extractWorkingBranch = (overview) =>
        overview?.workingBranches?.find((branch) => branch.name === branchName) || null;

      let nextOverview = result?.overview || null;
      if (!nextOverview) {
        nextOverview = await fetchBranches();
      }

      let workingBranch = extractWorkingBranch(nextOverview)
        || cachedWorkingBranch
        || null;

      if (Array.isArray(workingBranch?.stagedFiles) && workingBranch.stagedFiles.length > 0) {
        try {
          const commitOverview = await performCommit(branchName);
          if (commitOverview) {
            nextOverview = commitOverview;
          }
          if (!nextOverview) {
            nextOverview = await fetchBranches();
          }
          workingBranch = extractWorkingBranch(nextOverview) || workingBranch;
        } catch (commitError) {
          console.error('Error committing staged changes before merge:', commitError);
          const message = commitError.response?.data?.error || 'Failed to commit staged changes before merging';
          setMergeWarning(message);
          return;
        }
      }
      const workingBranchForMerge = workingBranch
        ? { ...workingBranch, lastTestStatus: latestTestStatus || workingBranch.lastTestStatus }
        : null;

      if (!canBranchMerge(workingBranchForMerge)) {
        setMergeWarning(describeMergeBlocker(workingBranchForMerge));
        return;
      }
      await handleMergeBranch(branchName);
    } catch (err) {
      console.error('Error during test & merge:', err);
      setError(err.response?.data?.error || 'Failed to merge branch');
    } finally {
      setTestMergeInFlight(null);
    }
  }, [
    projectId,
    handleRunTests,
    getCachedWorkingBranch,
    canBranchMerge,
    handleMergeBranch,
    isStoppingProject,
    describeMergeBlocker,
    fetchBranches,
    performCommit
  ]);

  const handleSkipTestsAndMerge = useCallback(async (branchName) => {
    if (!projectId || !branchName || isStoppingProject) {
      return;
    }

    setMergeWarning(null);
    setSkipMergeInFlight(branchName);

    try {
      const extractWorkingBranch = (overview) =>
        overview?.workingBranches?.find((branch) => branch.name === branchName) || null;

      let nextOverview = await fetchBranches();

      let workingBranch = extractWorkingBranch(nextOverview);
      if (!workingBranch) {
        workingBranch = getCachedWorkingBranch(branchName);
      }

      if (Array.isArray(workingBranch?.stagedFiles) && workingBranch.stagedFiles.length > 0) {
        try {
          const commitOverview = await performCommit(branchName);
          if (commitOverview) {
            nextOverview = commitOverview;
          }
          if (!nextOverview) {
            nextOverview = await fetchBranches();
          }
          workingBranch = extractWorkingBranch(nextOverview) || workingBranch;
        } catch (commitError) {
          console.error('Error committing staged changes before merge:', commitError);
          const message = commitError.response?.data?.error || 'Failed to commit staged changes before merging';
          setMergeWarning(message);
          return;
        }
      }

      try {
        const response = await axios.post(
          `/api/projects/${projectId}/branches/${encodeURIComponent(branchName)}/merge`
        );

        if (response.data.success && response.data.overview) {
          applyOverview(response.data.overview);
        } else {
          await fetchBranches();
        }
      } catch (mergeError) {
        console.error('Error merging branch:', mergeError);
        setError(mergeError.response?.data?.error || 'Failed to merge branch');
      }
    } finally {
      setSkipMergeInFlight(null);
    }
  }, [
    projectId,
    getCachedWorkingBranch,
    isStoppingProject,
    fetchBranches,
    performCommit,
    applyOverview,
    setError
  ]);

  const handleCheckoutBranch = useCallback(async (branchName) => {
    if (!projectId || !branchName || isStoppingProject) {
      return;
    }

    try {
      const response = await axios.post(
        `/api/projects/${projectId}/branches/${encodeURIComponent(branchName)}/checkout`
      );

      if (response.data.success && response.data.overview) {
        applyOverview(response.data.overview);
      } else {
        await fetchBranches();
      }
    } catch (err) {
      console.error('Error switching branch:', err);
      setError(err.response?.data?.error || 'Failed to switch branch');
    }
  }, [projectId, isStoppingProject, applyOverview, fetchBranches]);

  const handleDeleteBranch = useCallback(async (branchName) => {
    if (!projectId || !branchName || branchName === 'main' || isStoppingProject) {
      return;
    }

    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      const confirmed = window.confirm(`Delete branch "${branchName}"? This cannot be undone.`);
      if (!confirmed) {
        return;
      }
    }

    const deletingCurrentBranch = branchName === currentBranch;

    try {
      setDeleteInFlight(branchName);
      const response = await axios.delete(
        `/api/projects/${projectId}/branches/${encodeURIComponent(branchName)}`,
        {
          headers: {
            'x-confirm-destructive': 'true'
          }
        }
      );

      if (response.data.success && response.data.overview) {
        applyOverview(response.data.overview);
      } else {
        await fetchBranches();
      }

      if (deletingCurrentBranch) {
        const fallbackBranch = response.data?.overview?.current || 'main';
        await handleCheckoutBranch(fallbackBranch);
      }
    } catch (err) {
      console.error('Error deleting branch:', err);
      setError(err.response?.data?.error || 'Failed to delete branch');
    } finally {
      setDeleteInFlight(null);
    }
  }, [
    projectId,
    isStoppingProject,
    currentBranch,
    applyOverview,
    fetchBranches,
    handleCheckoutBranch
  ]);

  const handleClearStaged = useCallback(async (selectedBranchNameParam) => {
    const branchName = selectedBranchNameParam || selectedBranchName;
    if (!projectId || isStoppingProject || !branchName) {
      return;
    }

    setError(null);

    setWorkingBranches((prev) => {
      if (!Array.isArray(prev) || prev.length === 0) {
        return prev;
      }

      return prev.map((branch) => {
        if (!branch || branch.name !== branchName) {
          return branch;
        }

        const existingFiles = Array.isArray(branch.stagedFiles) ? branch.stagedFiles : [];
        if (existingFiles.length === 0) {
          return branch;
        }
        return {
          ...branch,
          stagedFiles: []
        };
      });
    });

    const result = await clearStagedChanges(projectId, { branchName });
    if (result?.overview) {
      applyOverview(result.overview);
      return;
    }

    if (!result) {
      setError('Failed to clear staged changes');
    } else {
      await fetchBranches();
    }
  }, [projectId, isStoppingProject, selectedBranchName, clearStagedChanges, applyOverview, fetchBranches]);

  const handleCreateBranch = useCallback(async ({ name, description } = {}) => {
    if (!projectId || isStoppingProject) {
      return null;
    }

    const payload = {};
    if (typeof name === 'string' && name.trim()) {
      payload.name = name.trim();
    }
    if (typeof description === 'string' && description.trim()) {
      payload.description = description.trim();
    }

    setError(null);
    setCreateBranchInFlight(true);
    let createdBranch = null;
    let caughtError = null;
    try {
      const response = await axios.post(`/api/projects/${projectId}/branches`, payload);
      const data = response.data;
      if (data?.overview) {
        applyOverview(data.overview);
      } else {
        await fetchBranches();
      }

      if (data?.branch?.name) {
        setSelectedBranch(data.branch.name);
      }

      createdBranch = data?.branch || null;
    } catch (err) {
      console.error('Error creating branch:', err);
      const message = err.response?.data?.error || 'Failed to create branch';
      setError(message);
      caughtError = err;
    } finally {
      setCreateBranchInFlight(false);
    }
    if (caughtError) {
      throw caughtError;
    }
    return createdBranch;
  }, [projectId, isStoppingProject, applyOverview, fetchBranches, setSelectedBranch]);

  const handleClearFile = useCallback(async (filePath, branchNameParam) => {
    const branchName = branchNameParam || selectedBranchName;
    if (!projectId || !filePath || !branchName || isStoppingProject) {
      return;
    }

    setError(null);

    const normalizedFilePath = normalizeRepoPath(filePath);

    setWorkingBranches((prev) => {
      if (!Array.isArray(prev) || prev.length === 0) {
        return prev;
      }

      return prev.map((branch) => {
        if (!branch || branch.name !== branchName) {
          return branch;
        }

        const existingFiles = Array.isArray(branch.stagedFiles) ? branch.stagedFiles : [];
        if (existingFiles.length === 0) {
          return branch;
        }

        const filtered = existingFiles.filter((entry) => normalizeRepoPath(entry?.path) !== normalizedFilePath);
        if (filtered.length === existingFiles.length) {
          return branch;
        }
        return {
          ...branch,
          stagedFiles: filtered
        };
      });
    });

    const result = await clearStagedChanges(projectId, {
      branchName,
      filePath: normalizedFilePath
    });
    if (result?.overview) {
      applyOverview(result.overview);
      return;
    }

    if (!result) {
      setError('Failed to clear staged changes');
    } else {
      await fetchBranches();
    }
  }, [projectId, isStoppingProject, selectedBranchName, clearStagedChanges, applyOverview, fetchBranches]);

  useEffect(() => {
    if (!selectedBranchName) {
      return;
    }
    const signature = computeStagedSignature(selectedFiles);
    const previousSignature = stagedSignatureMapRef.current.get(selectedBranchName);
    const hasPassingBaseline = isPassingTestStatus(selectedWorkingBranch?.lastTestStatus);
    if (hasPassingBaseline && previousSignature && previousSignature !== signature) {
      markBranchInvalidated(selectedBranchName);
    }
    if (previousSignature !== signature) {
      stagedSignatureMapRef.current.set(selectedBranchName, signature);
    }
  }, [selectedBranchName, selectedFiles, selectedWorkingBranch?.lastTestStatus, markBranchInvalidated]);

  useEffect(() => {
    if (!selectedBranchName || !selectedWorkingBranch) {
      return;
    }

    if (selectedFiles.length === 0 && isPassingTestStatus(selectedWorkingBranch.lastTestStatus)) {
      markBranchValidated(selectedBranchName);
    }
  }, [
    selectedBranchName,
    selectedWorkingBranch,
    selectedWorkingBranch?.lastTestStatus,
    selectedFiles.length,
    markBranchValidated
  ]);

  useEffect(() => {
    setMergeWarning(null);
  }, [selectedBranchName]);

  const handleOpenFile = useCallback((filePath) => {
    if (!filePath) {
      return;
    }
    onRequestFileOpen?.(filePath);
  }, [onRequestFileOpen]);

  if (useBranchTabState.__testHooks) {
    useBranchTabState.__testHooks.latestInstance = {
      applyOverview,
      triggerAutomationSuites,
      performCommit,
      setBranchSummaries,
      setWorkingBranches,
      setSelectedBranch
    };
    useBranchTabState.__testHooks.getCachedWorkingBranch = getCachedWorkingBranch;
  }

  return {
    projectId,
    loading,
    error,
    showShutdownBanner,
    shutdownError,
    isStoppingProject,
    branchSummaries,
    sortedBranches,
    selectedBranchName,
    setSelectedBranch,
    selectedSummary,
    selectedWorkingBranch,
    workingBranchMap,
    workingBranches,
    selectedFiles,
    hasSelectedFiles,
    mergeWarning,
    setMergeWarning,
    branchTestValidity,
    markBranchInvalidated,
    markBranchValidated,
    testInFlight,
    mergeInFlight,
    commitInFlight,
    testMergeInFlight,
    skipMergeInFlight,
    deleteInFlight,
    handleRunTests,
    handleMergeBranch,
    handleTestAndMerge,
    handleSkipTestsAndMerge,
    handleCommitBranch,
    handleDeleteBranch,
    handleCheckoutBranch,
    handleClearStaged,
    handleClearFile,
    handleOpenFile,
    handleCreateBranch,
    fetchBranches,
    setError,
    createBranchInFlight,
    selectedBranchRef
  };
};

useBranchTabState.__testHooks = useBranchTabState.__testHooks || {};
Object.assign(useBranchTabState.__testHooks, {
  setBranchFallbackName: (value) => {
    setBranchFallbackName(value);
  },
  resetBranchFallbackName: () => {
    resetBranchFallbackName();
  },
  buildBranchSelectionKey,
  loadStoredBranchSelection,
  persistBranchSelection,
  getLatestInstance: () => useBranchTabState.__testHooks.latestInstance || null,
  clearLatestInstance: () => {
    delete useBranchTabState.__testHooks.latestInstance;
  }
});

export default useBranchTabState;
