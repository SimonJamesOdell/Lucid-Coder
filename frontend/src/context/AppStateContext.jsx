import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import {
  defaultGitSettings,
  defaultPortSettings,
  getMaxAssistantPanelWidth,
  clampAssistantPanelWidth,
  loadAssistantPanelState,
  loadFileExplorerState,
  loadWorkspaceChangesFromStorage,
  loadWorkingBranchesFromStorage,
  loadPreviewPanelStateByProject,
  loadGitSettingsFromStorage
} from './appState/persistence.js';
import {
  detectFileTokens,
  normalizeRepoPath,
  normalizePortNumber,
  buildEmptyPortBundle,
  coercePortBundle,
  resolveProcessPayload,
  buildProcessStateSnapshot,
  sortJobsByCreatedAt,
  buildInitialShutdownState
} from './appState/helpers.js';
import { useJobs } from './appState/useJobs.js';
import {
  fetchProjectsFromBackend,
  selectProjectWithProcesses,
  closeProjectWithProcesses,
  stopProjectProcesses,
  stopProjectProcessTarget,
  restartProjectProcesses,
  createProjectViaBackend,
  importProjectLocal
} from './appState/projects.js';
import {
  fetchGitSettingsFromBackend as fetchGitSettingsFromBackendAction,
  fetchPortSettingsFromBackend as fetchPortSettingsFromBackendAction,
  fetchProjectGitSettings as fetchProjectGitSettingsAction,
  updateGitSettings as updateGitSettingsAction,
  updatePortSettings as updatePortSettingsAction,
  getEffectiveGitSettings as getEffectiveGitSettingsAction,
  getProjectGitSettingsSnapshot as getProjectGitSettingsSnapshotAction,
  createProjectRemoteRepository as createProjectRemoteRepositoryAction,
  updateProjectGitSettings as updateProjectGitSettingsAction,
  clearProjectGitSettings as clearProjectGitSettingsAction
} from './appState/settings.js';
import {
  registerBranchActivity as registerBranchActivityAction,
  applyBranchOverview as applyBranchOverviewAction,
  applyLocalStageFallback as applyLocalStageFallbackAction,
  stageFileChange as stageFileChangeAction,
  clearStagedChanges as clearStagedChangesAction,
  stageAiChange as stageAiChangeAction
} from './appState/branches.js';

const isTestEnv = typeof process !== 'undefined' && process.env?.NODE_ENV === 'test';

export const __appStateTestHelpers = {
  detectFileTokens,
  normalizeRepoPath,
  registerBranchActivity: null,
  applyBranchOverview: null
};

const AppStateContext = createContext();

if (isTestEnv) {
  Object.assign(__appStateTestHelpers, {
    normalizePortNumber,
    buildEmptyPortBundle,
    coercePortBundle,
    resolveProcessPayload,
    buildProcessStateSnapshot,
    getMaxAssistantPanelWidth,
    loadAssistantPanelState,
    clampAssistantPanelWidth,
    loadFileExplorerState,
    loadWorkspaceChangesFromStorage,
    loadWorkingBranchesFromStorage,
    loadPreviewPanelStateByProject,
    sortJobsByCreatedAt,
    buildInitialShutdownState,
    loadGitSettingsFromStorage
  });
}

export const useAppState = () => {
  const context = useContext(AppStateContext);
  if (!context) {
    throw new Error('useAppState must be used within an AppStateProvider');
  }
  return context;
};

export const AppStateProvider = ({ children }) => {
  const enableAutoStartRetry = !isTestEnv || Boolean(globalThis.__lucidcoderEnableAutoStartRetryTests);
  const [isLLMConfigured, setIsLLMConfigured] = useState(false);
  const [llmConfig, setLlmConfig] = useState(null);
  const [llmStatusLoaded, setLlmStatusLoaded] = useState(false);
  const [llmStatus, setLlmStatus] = useState({
    configured: false,
    ready: false,
    reason: null,
    requiresApiKey: null,
    hasApiKey: null
  });
  const hydratedProjectFromStorageRef = useRef(false);
  const autoClosedProjectIdRef = useRef(null);
  const autoStartedProjectIdRef = useRef(null);
  const autoStartInFlightRef = useRef(false);
  const autoStartRetryTimerRef = useRef(null);
  const llmStatusRequestIdRef = useRef(0);
  const [currentProject, setCurrentProject] = useState(null);
  const [projects, setProjects] = useState([]);
  const [theme, setTheme] = useState('dark');
  const [currentView, setCurrentView] = useState('main'); // 'main', 'create-project', 'import-project'
  const [workspaceChanges, setWorkspaceChanges] = useState(loadWorkspaceChangesFromStorage);
  const [projectFilesRevision, setProjectFilesRevision] = useState({});
  const [workingBranches, setWorkingBranches] = useState(loadWorkingBranchesFromStorage);
  const [gitSettings, setGitSettings] = useState(loadGitSettingsFromStorage);
  const [projectGitSettings, setProjectGitSettings] = useState({});
  const [portSettings, setPortSettings] = useState(defaultPortSettings);
  const [projectProcesses, setProjectProcesses] = useState(null);
  const [fileExplorerStateByProject, setFileExplorerStateByProject] = useState(loadFileExplorerState);
  const [assistantPanelState, setAssistantPanelState] = useState(loadAssistantPanelState);
  const [previewPanelStateByProject, setPreviewPanelStateByProject] = useState(loadPreviewPanelStateByProject);
  const [projectShutdownState, setProjectShutdownState] = useState(buildInitialShutdownState);
  const [editorFocusRequest, setEditorFocusRequest] = useState(null);
  const [stoppedProjects, setStoppedProjects] = useState({});
  const [previewPanelState, setPreviewPanelState] = useState({
    activeTab: 'preview',
    followAutomation: true
  });
  const [testRunIntent, setTestRunIntent] = useState({
    source: 'unknown',
    updatedAt: null,
    autoCommit: false,
    returnToCommits: false
  });
  const [backendConnectivity, setBackendConnectivity] = useState({
    status: 'unknown',
    lastError: null
  });
  const [autoStartRetryTick, setAutoStartRetryTick] = useState(0);

  if (isTestEnv) {
    __appStateTestHelpers.setAutoStartState = ({ autoStartedProjectId, hydratedProjectFromStorage } = {}) => {
      if (typeof hydratedProjectFromStorage === 'boolean') {
        hydratedProjectFromStorageRef.current = hydratedProjectFromStorage;
      }
      if (autoStartedProjectId !== undefined) {
        autoStartedProjectIdRef.current = autoStartedProjectId;
      }
    };
  }

  const markTestRunIntent = useCallback((source = 'unknown', options = {}) => {
    const normalized = typeof source === 'string' ? source.trim() : '';
    const autoCommit = Boolean(options?.autoCommit);
    const returnToCommits = Boolean(options?.returnToCommits);
    setTestRunIntent({
      source: normalized || 'unknown',
      updatedAt: new Date().toISOString(),
      autoCommit,
      returnToCommits
    });
  }, []);

  const markProjectStopped = useCallback((projectId) => {
    if (!projectId) {
      return;
    }
    setStoppedProjects((prev) => ({
      ...prev,
      [projectId]: true
    }));
  }, []);

  const clearProjectStopped = useCallback((projectId) => {
    if (!projectId) {
      return;
    }
    setStoppedProjects((prev) => {
      /* v8 ignore next */
      if (!prev[projectId]) {
        /* v8 ignore next */
        return prev;
      }
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
  }, []);

  if (isTestEnv) {
    __appStateTestHelpers.clearProjectStopped = clearProjectStopped;
    __appStateTestHelpers.markProjectStopped = markProjectStopped;
    __appStateTestHelpers.setAutoStartRetryTimer = (value) => {
      autoStartRetryTimerRef.current = value;
    };
  }

  const normalizePreviewTab = useCallback((value) => {
    if (typeof value !== 'string') {
      return '';
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return '';
    }

    const lower = trimmed.toLowerCase();
    const aliases = {
      tests: 'test',
      branches: 'branch',
      goals: 'goals',
      runs: 'runs',
      'llm usage': 'llm-usage',
      llmusage: 'llm-usage'
    };

    const normalized = aliases[lower] || lower;
    const allowed = new Set([
      'preview',
      'goals',
      'runs',
      'files',
      'branch',
      'test',
      'commits',
      'git',
      'packages',
      'processes',
      'llm-usage'
    ]);
    return allowed.has(normalized) ? normalized : '';
  }, []);

  const setPreviewPanelTab = useCallback(
    (tab, options = {}) => {
      const normalized = normalizePreviewTab(tab);
      if (!normalized) {
        return;
      }

      const projectId = currentProject?.id || null;

      const source = typeof options.source === 'string' ? options.source : 'unknown';

      setPreviewPanelState((prev) => {
        const nextActiveTab = normalized;
        const nextFollowAutomation = (() => {
          if (source === 'automation' || source === 'agent') {
            return true;
          }
          if (source === 'user') {
            // Only treat an explicit user click on the Goals tab as “pause automation”.
            // (Other manual tab changes should not disable agent actions.)
            return nextActiveTab === 'goals' ? false : prev.followAutomation;
          }
          return prev.followAutomation;
        })();

        if (prev.activeTab === nextActiveTab && prev.followAutomation === nextFollowAutomation) {
          return prev;
        }

        return {
          ...prev,
          activeTab: nextActiveTab,
          followAutomation: nextFollowAutomation
        };
      });

      if (projectId) {
        setPreviewPanelStateByProject((prev) => {
          if (prev?.[projectId] === normalized) {
            return prev;
          }
          return {
            ...prev,
            [projectId]: normalized
          };
        });
      }
    },
    [currentProject?.id, normalizePreviewTab]
  );

  useEffect(() => {
    if (!currentProject?.id) {
      return;
    }

    const savedTab = normalizePreviewTab(previewPanelStateByProject?.[currentProject.id]);
    if (!savedTab) {
      return;
    }

    setPreviewPanelState((prev) => {
      if (prev.activeTab === savedTab) {
        return prev;
      }
      return {
        ...prev,
        activeTab: savedTab
      };
    });
  }, [currentProject?.id, normalizePreviewTab, previewPanelStateByProject]);

  const pausePreviewAutomation = useCallback(() => {
    setPreviewPanelState((prev) => {
      if (prev.followAutomation === false) {
        return prev;
      }
      return { ...prev, followAutomation: false };
    });
  }, []);

  const resumePreviewAutomation = useCallback(() => {
    setPreviewPanelState((prev) => {
      if (prev.followAutomation === true) {
        return prev;
      }
      return { ...prev, followAutomation: true };
    });
  }, []);

  const reportBackendConnectivity = useCallback((status, error) => {
    if (status !== 'online' && status !== 'offline') {
      return;
    }

    if (status === 'online') {
      setBackendConnectivity({ status: 'online', lastError: null });
      return;
    }

    const message = error?.message || (typeof error === 'string' ? error : null) || 'Backend unreachable';
    setBackendConnectivity({ status: 'offline', lastError: message });
  }, []);

  const isBackendUnreachableResponse = (response, requestUrl) => {
    const status = Number(response?.status);
    if (status === 502 || status === 503 || status === 504) {
      return true;
    }

    const url = typeof requestUrl === 'string' ? requestUrl : '';
    const isConnectivityProbe = url === '/api/llm/status' || url === '/api/projects';

    // When running the frontend dev server, a missing backend can present as a 404
    // (because the proxy cannot reach the upstream). Treat that as "offline" for
    // critical probe endpoints.
    if (isConnectivityProbe && status === 404) {
      return true;
    }

    return false;
  };

  const trackedFetch = useCallback(async (...args) => {
    try {
      const requestUrl = args?.[0];
      const response = await fetch(...args);
      if (isBackendUnreachableResponse(response, requestUrl)) {
        reportBackendConnectivity('offline', `Backend unreachable (${response.status})`);
      } else {
        reportBackendConnectivity('online');
      }
      return response;
    } catch (error) {
      reportBackendConnectivity('offline', error);
      throw error;
    }
  }, [reportBackendConnectivity]);

  if (isTestEnv) {
    __appStateTestHelpers.trackedFetch = trackedFetch;
    __appStateTestHelpers.reportBackendConnectivity = reportBackendConnectivity;
  }

  const {
    jobState,
    refreshJobs,
    startAutomationJob,
    cancelAutomationJob,
    getJobsForProject,
    resetJobsState,
    clearJobPolls
  } = useJobs({
    currentProjectId: currentProject?.id,
    trackedFetch,
    isTestEnv,
    testHelpers: __appStateTestHelpers
  });

  const getFileExplorerState = useCallback(
    (projectId = currentProject?.id) => {
      if (!projectId) {
        return null;
      }
      return fileExplorerStateByProject[String(projectId)] || null;
    },
    [currentProject?.id, fileExplorerStateByProject]
  );

  const setFileExplorerState = useCallback(
    (projectId = currentProject?.id, nextState = {}) => {
      if (!projectId || !nextState) {
        return;
      }

      setFileExplorerStateByProject((prev) => ({
        ...prev,
        [String(projectId)]: {
          ...(prev[String(projectId)] || {}),
          ...nextState
        }
      }));
    },
    [currentProject?.id]
  );

  const updateAssistantPanelState = useCallback((nextState = {}) => {
    if (!nextState) {
      return;
    }

    setAssistantPanelState((prev) => {
      const hasWidth = Object.prototype.hasOwnProperty.call(nextState, 'width');
      const hasPosition = Object.prototype.hasOwnProperty.call(nextState, 'position');
      const nextWidth = hasWidth ? clampAssistantPanelWidth(nextState.width) : prev.width;
      const nextPosition = hasPosition
        ? nextState.position === 'right'
          ? 'right'
          : nextState.position === 'left'
            ? 'left'
            : prev.position
        : prev.position;

      return {
        ...prev,
        ...nextState,
        width: nextWidth,
        position: nextPosition
      };
    });
  }, []);

  const resetProjectShutdownState = useCallback(() => {
    setProjectShutdownState(buildInitialShutdownState());
  }, []);

  const resetProjectProcesses = useCallback(() => {
    setProjectProcesses(null);
  }, []);

  const applyProcessSnapshot = useCallback((projectId, payload = {}) => {
    if (!projectId) {
      resetProjectProcesses();
      return null;
    }

    const snapshot = buildProcessStateSnapshot(projectId, payload);
    setProjectProcesses(snapshot);
    return snapshot;
  }, [resetProjectProcesses]);

  if (isTestEnv) {
    __appStateTestHelpers.applyProcessSnapshot = applyProcessSnapshot;
  }

  const isProjectStopping = useCallback(
    (projectId = currentProject?.id) => {
      if (!projectShutdownState?.isStopping) {
        return false;
      }
      if (!projectId) {
        return projectShutdownState.isStopping;
      }
      return projectShutdownState.projectId === projectId;
    },
    [currentProject?.id, projectShutdownState]
  );

  if (isTestEnv) {
    __appStateTestHelpers.isProjectStopping = isProjectStopping;
  }

  const requestEditorFocus = useCallback((projectId, filePath, options = {}) => {
    if (!projectId || !filePath) {
      return;
    }

    setEditorFocusRequest({
      projectId,
      filePath,
      source: options.source || 'branch',
      highlight: options.highlight || 'diff',
      commitSha: options.commitSha || null,
      requestedAt: Date.now()
    });
  }, []);

  const clearEditorFocusRequest = useCallback(() => {
    setEditorFocusRequest(null);
  }, []);

  // Load initial state from localStorage and backend
  useEffect(() => {
    const savedProject = localStorage.getItem('currentProject');
    const savedTheme = localStorage.getItem('theme') || 'dark';
    
    if (savedProject) {
      hydratedProjectFromStorageRef.current = true;
      setCurrentProject(JSON.parse(savedProject));
    } else {
      hydratedProjectFromStorageRef.current = false;
    }
    
    // Load projects from backend instead of localStorage
    fetchProjects();

    // Hydrate LLM configuration from backend (source-of-truth).
    fetchLLMConfigFromBackend();

    setTheme(savedTheme);
  }, []);

  useEffect(() => {
    fetchGitSettingsFromBackend();
  }, []);

  useEffect(() => {
    fetchPortSettingsFromBackend();
  }, []);

  // Jobs refresh/polling is handled in useJobs.

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('workspaceChanges', JSON.stringify(workspaceChanges));
    }
  }, [workspaceChanges]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('workingBranches', JSON.stringify(workingBranches));
    }
  }, [workingBranches]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('fileExplorerState', JSON.stringify(fileExplorerStateByProject));
    }
  }, [fileExplorerStateByProject]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('assistantPanelState', JSON.stringify(assistantPanelState));
    }
  }, [assistantPanelState]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('previewPanelStateByProject', JSON.stringify(previewPanelStateByProject));
    }
  }, [previewPanelStateByProject]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('gitSettings', JSON.stringify(gitSettings));
    }
  }, [gitSettings]);

  // Fetch projects from backend
  const fetchProjects = useCallback(
    () => fetchProjectsFromBackend({ trackedFetch, setProjects }),
    [trackedFetch]
  );

  const fetchGitSettingsFromBackend = useCallback(
    () => fetchGitSettingsFromBackendAction({ trackedFetch, setGitSettings }),
    [trackedFetch]
  );

  const fetchPortSettingsFromBackend = useCallback(
    () => fetchPortSettingsFromBackendAction({ trackedFetch, setPortSettings }),
    [trackedFetch]
  );

  const fetchProjectGitSettings = useCallback(
    (projectId) => fetchProjectGitSettingsAction({ projectId, trackedFetch, setProjectGitSettings }),
    [trackedFetch]
  );

  if (isTestEnv) {
    __appStateTestHelpers.fetchProjectGitSettings = fetchProjectGitSettings;
  }

  const refreshProcessStatus = useCallback(async (projectId = currentProject?.id) => {
    if (!projectId) {
      resetProjectProcesses();
      return null;
    }

    const response = await trackedFetch(`/api/projects/${projectId}/processes`);
    const data = await response.json();

    if (!response.ok || !data.success) {
      const message = data?.error || 'Failed to load process status';
      throw new Error(message);
    }

    return applyProcessSnapshot(projectId, data);
  }, [currentProject?.id, applyProcessSnapshot, resetProjectProcesses]);

  useEffect(() => {
    if (!currentProject?.id) {
      resetProjectProcesses();
      return;
    }

    refreshProcessStatus(currentProject.id).catch((error) => {
      console.warn('Failed to refresh process status', error);
    });
  }, [currentProject?.id, refreshProcessStatus, resetProjectProcesses]);

  const fetchLLMConfigFromBackend = useCallback(async () => {
    const requestId = ++llmStatusRequestIdRef.current;

    try {
      const response = await trackedFetch('/api/llm/status');
      const data = await response.json().catch(() => null);

      // If we got a non-JSON or otherwise invalid response, treat the backend as offline.
      // This happens when the frontend dev server answers the request while the backend
      // is down, leading to confusing UI (e.g. showing the LLM configuration screen).
      const hasValidShape = data && typeof data === 'object' && typeof data.success === 'boolean';
      if (response.ok && !hasValidShape) {
        reportBackendConnectivity('offline', 'Backend returned an invalid LLM status response');
        throw new Error('Backend returned an invalid LLM status response');
      }

      if (requestId !== llmStatusRequestIdRef.current) {
        return;
      }

      if (!response.ok) {
        const message = data?.error || `Failed to load LLM configuration (${response.status})`;
        throw new Error(message);
      }

      if (data?.success) {
        const nextConfigured = Boolean(data?.configured);
        const nextReady = Boolean(data?.ready);
        const nextReason = typeof data?.reason === 'string' ? data.reason : null;

        const config = data?.config;
        const nextConfig = config
          ? {
              provider: config.provider,
              model: config.model,
              apiUrl: config.api_url,
              configured: nextReady,
              requiresApiKey: Boolean(config.requires_api_key),
              hasApiKey: Boolean(config.has_api_key)
            }
          : null;

        setLlmConfig(nextConfig);
        setIsLLMConfigured(nextReady);
        setLlmStatus({
          configured: nextConfigured,
          ready: nextReady,
          reason: nextReason,
          requiresApiKey: config ? Boolean(config.requires_api_key) : null,
          hasApiKey: config ? Boolean(config.has_api_key) : null
        });
        return;
      }

      setLlmConfig(null);
      setIsLLMConfigured(false);
      setLlmStatus({
        configured: false,
        ready: false,
        reason: typeof data?.error === 'string' ? data.error : 'Failed to load LLM status',
        requiresApiKey: null,
        hasApiKey: null
      });
    } catch (error) {
      console.warn('Failed to load LLM configuration from backend', error);
      // If we cannot reach the backend, do not pretend the LLM is configured.
      if (requestId !== llmStatusRequestIdRef.current) {
        return;
      }
      setLlmConfig(null);
      setIsLLMConfigured(false);
      setLlmStatus({
        configured: false,
        ready: false,
        reason: error?.message || 'Backend unreachable',
        requiresApiKey: null,
        hasApiKey: null
      });
    } finally {
      if (requestId !== llmStatusRequestIdRef.current) {
        return;
      }
      setLlmStatusLoaded(true);
    }
  }, [reportBackendConnectivity, trackedFetch]);

  const refreshLLMStatus = useCallback(async () => {
    setLlmStatusLoaded(false);
    await fetchLLMConfigFromBackend();
  }, [fetchLLMConfigFromBackend]);

  useEffect(() => {
    if (currentProject) {
      localStorage.setItem('currentProject', JSON.stringify(currentProject));
    } else {
      localStorage.removeItem('currentProject');
    }
  }, [currentProject]);

  // Projects are now managed by backend, no need to save to localStorage

  useEffect(() => {
    localStorage.setItem('theme', theme);
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const configureLLM = useCallback(
    async (config) => {
      // In-memory update only. Persistence is handled elsewhere (e.g. settings flows).
      if (!config || typeof config !== 'object') {
        return;
      }

      // Ensure any in-flight backend hydration does not overwrite manual configuration.
      llmStatusRequestIdRef.current += 1;
      setLlmConfig(config);
      setIsLLMConfigured(true);
    },
    []
  );

  const selectProject = async (project) => {
    hydratedProjectFromStorageRef.current = false;
    const started = await selectProjectWithProcesses({
      project,
      currentProject,
      closeProject,
      setCurrentProject,
      fetchProjectGitSettings,
      trackedFetch,
      applyProcessSnapshot,
      refreshProcessStatus
    });
    if (started && project?.id) {
      clearProjectStopped(project.id);
    }
    return started;
  };

  const closeProject = () => closeProjectWithProcesses({
    currentProject,
    setProjectShutdownState,
    trackedFetch,
    resetProjectShutdownState,
    resetProjectProcesses,
    clearJobPolls,
    setCurrentProject
  });

  // If the project was auto-hydrated from localStorage, keep it open even when
  // the LLM is not configured so the preview can load on boot.
  useEffect(() => {
    if (!llmStatusLoaded) {
      return;
    }
    if (isLLMConfigured) {
      autoClosedProjectIdRef.current = null;
      return;
    }
    if (!currentProject?.id) {
      return;
    }
    if (!hydratedProjectFromStorageRef.current) {
      return;
    }
  }, [currentProject?.id, isLLMConfigured, llmStatusLoaded]);

  // If a project was hydrated from storage, auto-start it once the backend is online
  // so the preview loads after a hard refresh.
  useEffect(() => {
    const projectSnapshot = currentProject;
    if (!projectSnapshot?.id || !hydratedProjectFromStorageRef.current) {
      return;
    }

    if (backendConnectivity?.status !== 'online') {
      return;
    }

    if (autoStartedProjectIdRef.current === projectSnapshot.id) {
      return;
    }

    if (autoStartInFlightRef.current) {
      return;
    }

    setPreviewPanelTab('preview', { source: 'system' });

    if (projectProcesses?.projectId === projectSnapshot.id && projectProcesses.isRunning) {
      autoStartedProjectIdRef.current = projectSnapshot.id;
      hydratedProjectFromStorageRef.current = false;
      return;
    }

    autoStartInFlightRef.current = true;
    void selectProjectWithProcesses({
      project: projectSnapshot,
      currentProject: projectSnapshot,
      closeProject,
      setCurrentProject,
      fetchProjectGitSettings,
      trackedFetch,
      applyProcessSnapshot,
      refreshProcessStatus
    }).then((started) => {
      if (started && projectSnapshot?.id) {
        autoStartedProjectIdRef.current = projectSnapshot.id;
        hydratedProjectFromStorageRef.current = false;
        clearProjectStopped(projectSnapshot.id);
      }
      if (!started && backendConnectivity?.status !== 'offline' && enableAutoStartRetry) {
        if (!autoStartRetryTimerRef.current) {
          autoStartRetryTimerRef.current = setTimeout(() => {
            autoStartRetryTimerRef.current = null;
            setAutoStartRetryTick((tick) => tick + 1);
          }, 2000);
        }
      }
    }).finally(() => {
      autoStartInFlightRef.current = false;
    });
  }, [
    applyProcessSnapshot,
    backendConnectivity?.status,
    clearProjectStopped,
    closeProject,
    currentProject,
    fetchProjectGitSettings,
    projectProcesses?.isRunning,
    projectProcesses?.projectId,
    refreshProcessStatus,
    setPreviewPanelTab,
    trackedFetch,
    autoStartRetryTick
  ]);

  const finalizeHydratedAutoStart = useCallback(() => {
    if (!currentProject?.id || !hydratedProjectFromStorageRef.current) {
      return false;
    }

    if (projectProcesses?.projectId === currentProject.id && projectProcesses.isRunning) {
      autoStartedProjectIdRef.current = currentProject.id;
      hydratedProjectFromStorageRef.current = false;
      /* v8 ignore next */
      if (autoStartRetryTimerRef.current) {
        /* v8 ignore next */
        clearTimeout(autoStartRetryTimerRef.current);
        /* v8 ignore next */
        autoStartRetryTimerRef.current = null;
      }
      return true;
    }

    return false;
  }, [currentProject?.id, projectProcesses?.projectId, projectProcesses?.isRunning]);

  if (isTestEnv) {
    __appStateTestHelpers.finalizeHydratedAutoStart = finalizeHydratedAutoStart;
  }

  useEffect(() => {
    finalizeHydratedAutoStart();
  }, [finalizeHydratedAutoStart]);

  // Auto-start for non-hydrated projects is handled explicitly via user actions
  // or PreviewTab's idle auto-start behavior.

  const stopProject = useCallback(
    async (projectId = currentProject?.id) => {
      const targetId = projectId || currentProject?.id;
      const result = await stopProjectProcesses({
        projectId,
        projectName: currentProject?.id === projectId ? currentProject?.name : '',
        setProjectShutdownState,
        trackedFetch,
        resetProjectShutdownState,
        resetProjectProcesses,
        clearJobPolls,
        refreshProcessStatus
      });
      if (targetId) {
        markProjectStopped(targetId);
      }
      return result;
    },
    [
      clearJobPolls,
      currentProject?.id,
      currentProject?.name,
      markProjectStopped,
      refreshProcessStatus,
      resetProjectProcesses,
      resetProjectShutdownState,
      trackedFetch
    ]
  );

  const stopProjectProcess = useCallback(
    async (projectId, target) => {
      const result = await stopProjectProcessTarget({ projectId, target, trackedFetch, refreshProcessStatus });
      if (projectId && (!target || target === 'frontend' || target === 'all')) {
        markProjectStopped(projectId);
      }
      return result;
    },
    [markProjectStopped, refreshProcessStatus, trackedFetch]
  );

  const restartProject = useCallback(
    async (projectId = currentProject?.id, target = null) => {
      const result = await restartProjectProcesses({
        projectId,
        target,
        trackedFetch,
        applyProcessSnapshot,
        refreshProcessStatus,
        resetProjectProcesses
      });
      if (projectId) {
        clearProjectStopped(projectId);
      }
      return result;
    },
    [applyProcessSnapshot, clearProjectStopped, currentProject?.id, refreshProcessStatus, resetProjectProcesses, trackedFetch]
  );

  const createProject = useCallback(
    (projectData) => createProjectViaBackend({ projectData, trackedFetch, setProjects, selectProject }),
    [selectProject, setProjects, trackedFetch]
  );

  const importProject = useCallback(
    (projectData) => importProjectLocal({ projectData, setProjects }),
    [setProjects]
  );

  const updateGitSettings = useCallback(
    (updates = {}) => updateGitSettingsAction({ trackedFetch, gitSettings, setGitSettings, updates }),
    [gitSettings, trackedFetch]
  );

  const updatePortSettings = useCallback(
    (updates = {}) => updatePortSettingsAction({
      trackedFetch,
      portSettings,
      setPortSettings,
      updates,
      currentProjectId: currentProject?.id,
      isProjectStopping,
      restartProject
    }),
    [currentProject?.id, isProjectStopping, portSettings, restartProject, trackedFetch]
  );

  const getEffectiveGitSettings = useCallback(
    (projectId) => getEffectiveGitSettingsAction({ gitSettings, projectGitSettings, projectId }),
    [gitSettings, projectGitSettings]
  );

  const getProjectGitSettingsSnapshot = useCallback(
    (projectId) => getProjectGitSettingsSnapshotAction({ gitSettings, projectGitSettings, projectId }),
    [gitSettings, projectGitSettings]
  );

  const createProjectRemoteRepository = useCallback(
    (projectId, options = {}) => createProjectRemoteRepositoryAction({ trackedFetch, projectId, options, setProjectGitSettings }),
    [trackedFetch]
  );

  const updateProjectGitSettings = useCallback(
    (projectId, updates = {}) => updateProjectGitSettingsAction({
      trackedFetch,
      projectId,
      updates,
      gitSettings,
      projectGitSettings,
      setProjectGitSettings
    }),
    [gitSettings, projectGitSettings, trackedFetch]
  );

  const clearProjectGitSettings = useCallback(
    (projectId) => clearProjectGitSettingsAction({ trackedFetch, projectId, setProjectGitSettings, setGitSettings }),
    [trackedFetch]
  );

  const resetGitSettings = () => {
    setGitSettings(defaultGitSettings);
  };

  const logout = () => {
    setCurrentProject(null);
    setIsLLMConfigured(false);
    setLlmConfig(null);
    setLlmStatus({ configured: false, ready: false, reason: null, requiresApiKey: null, hasApiKey: null });
    setProjects([]);
    setWorkspaceChanges({});
    setWorkingBranches({});
    setProjectGitSettings({});
    setPortSettings(defaultPortSettings);
    resetProjectProcesses();
    resetJobsState();
    resetGitSettings();
    setTestRunIntent({
      source: 'unknown',
      updatedAt: null,
      autoCommit: false,
      returnToCommits: false
    });
    localStorage.clear();
  };

  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  };

  const setView = (view) => {
    setCurrentView(view);
  };

  const showCreateProject = () => {
    setCurrentView('create-project');
  };

  const showImportProject = () => {
    setCurrentView('import-project');
  };

  const showMain = () => {
    setCurrentView('main');
  };

  const registerBranchActivity = useCallback(
    (projectId, updater) => registerBranchActivityAction({ projectId, updater, setWorkingBranches }),
    [setWorkingBranches]
  );

  const applyBranchOverview = useCallback(
    (projectId, overview) => applyBranchOverviewAction({ projectId, overview, setWorkingBranches, setWorkspaceChanges }),
    [setWorkingBranches, setWorkspaceChanges]
  );

  __appStateTestHelpers.registerBranchActivity = registerBranchActivity;
  __appStateTestHelpers.applyBranchOverview = applyBranchOverview;

  const applyLocalStageFallback = useCallback(
    (projectId, filePath, source) => applyLocalStageFallbackAction({
      projectId,
      filePath,
      source,
      normalizeRepoPath,
      registerBranchActivity,
      setWorkspaceChanges
    }),
    [registerBranchActivity, setWorkspaceChanges]
  );

  const stageFileChange = useCallback(
    (projectId, filePath, source = 'editor') => stageFileChangeAction({
      projectId,
      filePath,
      source,
      trackedFetch,
      normalizeRepoPath,
      applyBranchOverview,
      applyLocalStageFallback
    }),
    [applyBranchOverview, applyLocalStageFallback, trackedFetch]
  );

  const clearStagedChanges = useCallback(
    (projectId, options = {}) => clearStagedChangesAction({
      projectId,
      options,
      trackedFetch,
      normalizeRepoPath,
      workingBranches,
      setWorkspaceChanges,
      setWorkingBranches,
      setProjectFilesRevision,
      applyBranchOverview
    }),
    [applyBranchOverview, trackedFetch, workingBranches]
  );

  const stageAiChange = useCallback(
    (projectId, prompt) => stageAiChangeAction({ projectId, prompt, detectFileTokens, stageFileChange }),
    [stageFileChange]
  );

  const activeBranchState = currentProject ? workingBranches[currentProject.id] : null;
  const stagedCount = activeBranchState?.stagedFiles?.length ?? activeBranchState?.commits ?? 0;
  const hasBranchNotification = Boolean(
    activeBranchState &&
    !activeBranchState.merged &&
    stagedCount > 0
  );

  const value = {
    // State
    isLLMConfigured,
    llmConfig,
    llmStatusLoaded,
    llmStatus,
    currentProject,
    projects,
    theme,
    currentView,
    workspaceChanges,
    projectFilesRevision,
    workingBranches,
    gitSettings,
    projectGitSettings,
    portSettings,
    projectProcesses,
    jobState,
    projectShutdownState,
    fileExplorerStateByProject,
    assistantPanelState,
    editorFocusRequest,
    previewPanelState,
    testRunIntent,
    backendConnectivity,
    stoppedProjects,

    refreshLLMStatus,
    
    // Actions
    configureLLM,
    selectProject,
    closeProject,
    stopProject,
    stopProjectProcess,
    createProject,
    importProject,
    logout,
    toggleTheme,
    setView,
    showCreateProject,
    showImportProject,
    showMain,
    setCurrentProject,
    fetchProjects,
    stageFileChange,
    stageAiChange,
    clearStagedChanges,
    syncBranchOverview: applyBranchOverview,
    updateGitSettings,
    createProjectRemoteRepository,
    updateProjectGitSettings,
    clearProjectGitSettings,
    resetGitSettings,
    getEffectiveGitSettings,
    getProjectGitSettingsSnapshot,
    updatePortSettings,
    refreshProcessStatus,
    restartProject,
    startAutomationJob,
    cancelAutomationJob,
    refreshJobs,
    getJobsForProject,
    reportBackendConnectivity,
    getFileExplorerState,
    setFileExplorerState,
    updateAssistantPanelState,
    requestEditorFocus,
    clearEditorFocusRequest,
    setPreviewPanelTab,
    pausePreviewAutomation,
    resumePreviewAutomation,

    markTestRunIntent,
    
    // Computed values
    hasProject: !!currentProject,
    canUseTools: !!currentProject,
    canUseProjects: isLLMConfigured,
    canUseSettings: isLLMConfigured,
    hasBranchNotification
  };

  return (
    <AppStateContext.Provider value={value}>
      {children}
    </AppStateContext.Provider>
  );
};

export { AppStateContext };