import React, { useEffect, useRef, useState } from 'react';
import { useAppState } from '../context/AppStateContext';
import axios from 'axios';
import { io } from 'socket.io-client';
import FolderPickerModal from './FolderPickerModal';
import './CreateProject.css';

const PROGRESS_STEP_NAMES = [
  'Creating directories',
  'Generating files',
  'Initializing git repository',
  'Installing dependencies',
  'Starting development servers'
];

const buildProgressSteps = (completed = false) =>
  PROGRESS_STEP_NAMES.map((name) => ({ name, completed }));

const clampCompletion = (value) => Math.min(100, Math.max(0, value));

const isEmptyProgressSnapshot = (candidate) => {
  if (!candidate || typeof candidate !== 'object') {
    return true;
  }

  const stepsEmpty = Array.isArray(candidate.steps) && candidate.steps.length === 0;
  const noMetrics = candidate.status == null && candidate.completion == null;
  const noMessage = !candidate.statusMessage;
  const noError = !candidate.error;

  return stepsEmpty && noMetrics && noMessage && noError;
};

const normalizeServerProgress = (serverProgress) => {
  if (!serverProgress || typeof serverProgress !== 'object') {
    return {
      steps: buildProgressSteps(false),
      completion: 0,
      status: 'pending',
      statusMessage: 'Working...'
    };
  }

  const declaredStatus = typeof serverProgress.status === 'string' ? serverProgress.status : null;

  const stepsProvided = Array.isArray(serverProgress.steps) && serverProgress.steps.length > 0;
  const rawSteps = stepsProvided
    ? serverProgress.steps
    : buildProgressSteps(declaredStatus === 'completed');

  const normalizedSteps = rawSteps.map((step, index) => ({
    name: step?.name || PROGRESS_STEP_NAMES[index] || `Step ${index + 1}`,
    completed: Boolean(step?.completed)
  }));

  const completionFromServer = typeof serverProgress.completion === 'number'
    ? clampCompletion(serverProgress.completion)
    : Math.round(
        (normalizedSteps.filter((step) => step.completed).length / normalizedSteps.length) * 100
      ) || 0;

  const completion = declaredStatus === 'completed'
    ? 100
    : (normalizedSteps.every((step) => step.completed) ? 100 : completionFromServer);

  const status = declaredStatus
    || (completion === 100 ? 'completed' : (completion === 0 ? 'pending' : 'in-progress'));

  return {
    steps: normalizedSteps,
    completion,
    status,
    statusMessage: serverProgress.statusMessage || 'Project created successfully',
    error: serverProgress.error
  };
};

export const BACKEND_UNAVAILABLE_MESSAGE = 'Unable to reach the backend server. Please make sure it is running and try again.';

const generateProgressKey = () => {
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `progress-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const POLL_SUPPRESSION_WINDOW_MS = 1500;

const guessProjectName = (value) => {
  if (!value || typeof value !== 'string') {
    return '';
  }
  const cleaned = value.trim().replace(/[?#].*$/, '');
  if (!cleaned) {
    return '';
  }
  const segments = cleaned.split(/[\\/]/).filter(Boolean);
  let candidate = segments.length > 0 ? segments[segments.length - 1] : '';
  if (candidate.includes(':')) {
    const afterColon = candidate.split(':').pop();
    candidate = afterColon || '';
  }
  return candidate.replace(/\.git$/i, '');
};

const CreateProject = () => {
  const {
    createProject,
    importProject,
    selectProject,
    showMain,
    fetchProjects,
    gitSettings,
    createProjectRemoteRepository
  } = useAppState();
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState('');
  const [progress, setProgress] = useState(null);
  const [processes, setProcesses] = useState(null);
  const [progressKey, setProgressKey] = useState(null);
  const progressStreamRef = useRef(null);
  const progressSocketRef = useRef(null);
  const progressPollRef = useRef(null);
  const progressPollTimeoutRef = useRef(null);
  const lastProgressUpdateAtRef = useRef(0);
  const pollSuppressedRef = useRef(false);
  const pollSuppressionTimeoutRef = useRef(null);
  const [gitIgnoreSuggestion, setGitIgnoreSuggestion] = useState(null);
  const [gitIgnoreStatus, setGitIgnoreStatus] = useState({ state: 'idle', error: '' });

  const [setupStep, setSetupStep] = useState('source');
  const [projectSource, setProjectSource] = useState('new');
  const [localPath, setLocalPath] = useState('');
  const [localImportMode, setLocalImportMode] = useState('copy');
  const [isFolderPickerOpen, setFolderPickerOpen] = useState(false);
  const [compatibilityStatus, setCompatibilityStatus] = useState({
    isLoading: false,
    error: ''
  });
  const [compatibilityPlan, setCompatibilityPlan] = useState(null);
  const [compatibilityConsent, setCompatibilityConsent] = useState(false);
  const [structureConsent, setStructureConsent] = useState(false);
  const compatibilityPathRef = useRef('');
  const [setupState, setSetupState] = useState({
    isWaiting: false,
    projectId: null,
    jobs: [],
    error: ''
  });
  
  // New project form state
  const [newProject, setNewProject] = useState({
    name: '',
    description: '',
    frontend: {
      language: 'javascript',
      framework: 'react'
    },
    backend: {
      language: 'javascript',
      framework: 'express'
    }
  });

  const [gitWorkflowMode, setGitWorkflowMode] = useState('');
  const [gitCloudMode, setGitCloudMode] = useState('');
  const [gitProvider, setGitProvider] = useState('github');
  const [gitToken, setGitToken] = useState('');
  const [gitRemoteUrl, setGitRemoteUrl] = useState('');
  const [gitConnectionMode, setGitConnectionMode] = useState('local');
  const [gitConnectionRemoteUrl, setGitConnectionRemoteUrl] = useState('');
  const [gitTechStatus, setGitTechStatus] = useState({ isLoading: false, error: '' });
  const gitTechKeyRef = useRef('');
  const [cloneCreateRemote, setCloneCreateRemote] = useState(false);
  const [gitRepoName, setGitRepoName] = useState('');
  const [gitRepoOwner, setGitRepoOwner] = useState('');
  const [gitRepoVisibility, setGitRepoVisibility] = useState('private');

  const frontendLanguages = ['javascript', 'typescript'];
  const backendLanguages = ['javascript', 'typescript', 'python', 'java', 'csharp', 'go', 'rust', 'php', 'ruby', 'swift'];

  const frontendFrameworks = {
    javascript: ['react', 'vue', 'angular', 'svelte', 'nextjs', 'nuxtjs', 'vanilla'],
    typescript: ['react', 'vue', 'angular', 'svelte', 'nextjs', 'nuxtjs', 'vanilla']
  };

  const backendFrameworks = {
    javascript: ['express', 'fastify', 'koa', 'nestjs', 'nextjs-api'],
    typescript: ['express', 'fastify', 'koa', 'nestjs', 'nextjs-api'],
    python: ['django', 'flask', 'fastapi', 'pyramid', 'tornado'],
    java: ['spring', 'springboot', 'quarkus', 'micronaut'],
    csharp: ['aspnetcore', 'webapi', 'minimal-api'],
    go: ['gin', 'echo', 'fiber', 'gorilla', 'chi'],
    rust: ['actix', 'warp', 'rocket', 'axum', 'tide'],
    php: ['laravel', 'symfony', 'codeigniter', 'slim'],
    ruby: ['rails', 'sinatra', 'grape'],
    swift: ['vapor', 'perfect', 'kitura']
  };

  useEffect(() => () => {
    if (progressStreamRef.current) {
      progressStreamRef.current.close();
      progressStreamRef.current = null;
    }
    if (progressSocketRef.current) {
      try {
        progressSocketRef.current.disconnect();
      } catch {
        // Ignore cleanup errors.
      }
      progressSocketRef.current = null;
    }

    if (progressPollRef.current) {
      clearInterval(progressPollRef.current);
      progressPollRef.current = null;
    }

    if (progressPollTimeoutRef.current) {
      clearTimeout(progressPollTimeoutRef.current);
      progressPollTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (projectSource !== 'local') {
      return;
    }
    if (newProject.name.trim()) {
      return;
    }
    const suggested = guessProjectName(localPath);
    if (suggested) {
      setNewProject((prev) => ({
        ...prev,
        name: suggested
      }));
    }
  }, [localPath, newProject.name, projectSource]);

  useEffect(() => {
    if (projectSource !== 'git') {
      return;
    }
    if (newProject.name.trim()) {
      return;
    }
    const suggested = guessProjectName(gitRemoteUrl);
    if (suggested) {
      setNewProject((prev) => ({
        ...prev,
        name: suggested
      }));
    }
  }, [gitRemoteUrl, newProject.name, projectSource]);

  useEffect(() => {
    if (projectSource !== 'new') {
      return;
    }
    if (gitWorkflowMode === 'global' || gitWorkflowMode === 'custom') {
      if (!gitCloudMode) {
        setGitCloudMode('create');
      }
    } else if (gitCloudMode) {
      setGitCloudMode('');
    }
  }, [gitCloudMode, gitWorkflowMode, projectSource]);

  const clearInitialPollTimeout = () => {
    if (progressPollTimeoutRef.current) {
      clearTimeout(progressPollTimeoutRef.current);
      progressPollTimeoutRef.current = null;
    }
  };

  const clearPollSuppression = () => {
    if (pollSuppressionTimeoutRef.current) {
      clearTimeout(pollSuppressionTimeoutRef.current);
      pollSuppressionTimeoutRef.current = null;
    }
    pollSuppressedRef.current = false;
  };

  const closeProgressStream = () => {
    if (progressStreamRef.current) {
      progressStreamRef.current.close();
      progressStreamRef.current = null;
    }

    if (progressSocketRef.current) {
      try {
        progressSocketRef.current.disconnect();
      } catch {
        // Ignore cleanup errors.
      }
      progressSocketRef.current = null;
    }

    if (progressPollRef.current) {
      clearInterval(progressPollRef.current);
      progressPollRef.current = null;
    }

    clearInitialPollTimeout();
    clearPollSuppression();
    lastProgressUpdateAtRef.current = 0;
  };

  const suppressPollingAfterUpdate = () => {
    pollSuppressedRef.current = true;
    if (pollSuppressionTimeoutRef.current) {
      clearTimeout(pollSuppressionTimeoutRef.current);
    }
    pollSuppressionTimeoutRef.current = setTimeout(() => {
      pollSuppressedRef.current = false;
      pollSuppressionTimeoutRef.current = null;
    }, POLL_SUPPRESSION_WINDOW_MS);
  };

  const applyProgressPayload = (payload) => {
    const normalized = normalizeServerProgress(payload);
    const isFailure = normalized?.status === 'failed';
    lastProgressUpdateAtRef.current = Date.now();
    suppressPollingAfterUpdate();
    setProgress(normalized);
    if (isFailure && normalized?.error) {
      setCreateError(normalized.error);
      setCreateLoading(false);
      setProcesses(null);
      setProgressKey(null);
    }
    if (normalized?.status === 'completed' || normalized?.status === 'failed' || normalized?.status === 'awaiting-user') {
      closeProgressStream();
    }
  };

  const startProgressPolling = (key) => {
    /* v8 ignore next */
    if (!key) { return; }

    const pollOnce = async () => {
      try {
        const response = await axios.get(`/api/projects/progress/${encodeURIComponent(key)}`);
        if (response?.data?.success && response.data.progress) {
          applyProgressPayload(response.data.progress);
        }
      } catch (error) {
        // 404 is expected early (progress not initialized yet). Ignore transient failures.
      }
    };

    // Initial poll soon after starting.
    clearInitialPollTimeout();
    progressPollTimeoutRef.current = setTimeout(pollOnce, 250);

    progressPollRef.current = setInterval(() => {
      if (pollSuppressedRef.current) {
        return;
      }

      if (Date.now() - lastProgressUpdateAtRef.current < POLL_SUPPRESSION_WINDOW_MS) {
        return;
      }

      pollOnce();
    }, 1000);
  };

  const handleProgressEvent = (event) => {
    try {
      const payload = JSON.parse(event.data);
      applyProgressPayload(payload);
    } catch (parseError) {
      // Ignore malformed events
    }
  };

  const handleProgressSocketPayload = (payload) => {
    if (!payload || typeof payload !== 'object') {
      return;
    }

    const candidate = Object.prototype.hasOwnProperty.call(payload, 'progress') ? payload.progress : payload;
    if (!candidate || typeof candidate !== 'object') {
      return;
    }

    const looksLikeProgress =
      Object.prototype.hasOwnProperty.call(candidate, 'steps')
      || Object.prototype.hasOwnProperty.call(candidate, 'completion')
      || Object.prototype.hasOwnProperty.call(candidate, 'status')
      || Object.prototype.hasOwnProperty.call(candidate, 'statusMessage')
      || Object.prototype.hasOwnProperty.call(candidate, 'error');

    if (looksLikeProgress) {
      applyProgressPayload(candidate);
    }
  };

  const startEventSourceProgressStream = (key) => {
    if (typeof window === 'undefined' || typeof window.EventSource === 'undefined') {
      return;
    }

    try {
      const stream = new EventSource(`/api/projects/progress/${encodeURIComponent(key)}/stream`);
      if (typeof stream.addEventListener === 'function') {
        stream.addEventListener('progress', handleProgressEvent);
      } else {
        stream.onmessage = handleProgressEvent;
      }
      stream.onerror = () => {
        stream.close();
      };
      progressStreamRef.current = stream;
    } catch (error) {
      // Fallback to no stream if EventSource fails
    }
  };

  const startProgressStream = (key) => {
    closeProgressStream();
    startProgressPolling(key);

    try {
      const socket = io({
        autoConnect: true,
        reconnection: true,
        transports: ['polling'],
        upgrade: false
      });

      progressSocketRef.current = socket;
      let settled = false;

      const fallbackToEventSource = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (progressSocketRef.current === socket) {
          progressSocketRef.current = null;
        }
        try {
          socket.off('connect');
          socket.off('connect_error');
          socket.off('progress:sync');
          socket.off('progress:update');
          socket.disconnect();
        } catch {
          // Ignore.
        }

        startEventSourceProgressStream(key);
      };

      socket.on('connect', () => {
        socket.emit('progress:join', { progressKey: key }, (response) => {
          if (!response || response.error) {
            fallbackToEventSource();
            return;
          }
          settled = true;
          handleProgressSocketPayload(response);

          // Some servers ack join without including a snapshot.
          // Poll once to pick up the initial state.
          if (!response.progress) {
            setTimeout(() => {
              // Polling interval is already running; this just prompts a sooner fetch.
              lastProgressUpdateAtRef.current = 0;
            }, 50);
          }
        });
      });

      socket.on('connect_error', () => {
        fallbackToEventSource();
      });

      socket.on('progress:sync', handleProgressSocketPayload);
      socket.on('progress:update', handleProgressSocketPayload);
    } catch (error) {
      startEventSourceProgressStream(key);
    }
  };

  const deriveRepoName = (value) => {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) {
      return '';
    }
    const cleaned = raw.replace(/\.git$/i, '');
    const lastSlash = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf(':'), cleaned.lastIndexOf('\\'));
    const candidate = lastSlash >= 0 ? cleaned.slice(lastSlash + 1) : cleaned;
    return candidate.trim();
  };

  const handleCreateProject = async (e) => {
    e.preventDefault();

    if (setupStep === 'source') {
      setCreateError('');
      setSetupStep('git');
      return;
    }

    if (setupStep === 'git') {
      if (projectSource === 'local') {
        if (!localPath.trim()) {
          setCreateError('Project path is required');
          return;
        }

        if (localImportMode === 'link') {
          try {
            setCreateLoading(true);
            setCreateError('');
            await axios.post('/api/projects/validate-local-path', {
              path: localPath.trim(),
              importMode: localImportMode
            });
          } catch (err) {
            const errorMessage = err?.response?.data?.error || err?.message || 'Invalid project path';
            setCreateError(errorMessage);
            setCreateLoading(false);
            return;
          } finally {
            setCreateLoading(false);
          }
        }

        if (gitConnectionMode !== 'local' && !gitConnectionRemoteUrl.trim()) {
          setCreateError('Repository URL is required for cloud workflows');
          return;
        }

        if (gitConnectionMode === 'custom' && !gitToken.trim()) {
          setCreateError('Personal access token is required for a custom cloud connection');
          return;
        }

        setCreateError('');
        setSetupStep('details');
        return;
      }

      if (projectSource === 'git') {
        if (!gitRemoteUrl.trim()) {
          setCreateError('Git repository URL is required');
          return;
        }

        if (gitConnectionMode === 'custom' && !gitToken.trim()) {
          setCreateError('Personal access token is required for a custom cloud connection');
          return;
        }

        if (gitConnectionMode !== 'local' && cloneCreateRemote) {
          const derivedName = gitRepoName.trim() || deriveRepoName(gitRemoteUrl);
          if (!derivedName) {
            setCreateError('Repository name is required to continue');
            return;
          }
        }

        setNewProject((prev) => ({
          ...prev,
          name: prev.name.trim() ? prev.name : deriveRepoName(gitRemoteUrl)
        }));
        setCreateError('');
        setSetupStep('details');
        return;
      }

      if (!gitWorkflowMode) {
        setCreateError('Git workflow selection is required');
        return;
      }

      const isCloudWorkflow = gitWorkflowMode === 'global' || gitWorkflowMode === 'custom';

      /* v8 ignore start */
      if (projectSource === 'new' && isCloudWorkflow && !gitCloudMode) {
        setCreateError('Remote setup selection is required for cloud workflows');
        return;
      }
      /* v8 ignore stop */

      if (gitWorkflowMode === 'custom' && !gitToken.trim()) {
        setCreateError('Personal access token is required for a custom cloud connection');
        return;
      }

      if (gitWorkflowMode === 'local') {
        setCreateError('');
        setSetupStep('details');
        return;
      }

      const derivedName = gitCloudMode === 'create'
        ? gitRepoName.trim()
        : deriveRepoName(gitRemoteUrl);

      if (derivedName) {
        setNewProject((prev) => ({
          ...prev,
          name: derivedName,
          description: prev.description || ''
        }));
      }
      setCreateError('');
      setSetupStep('details');
      return;
    }

    if (setupStep === 'details' && projectSource === 'local') {
      const effectiveName = newProject.name.trim();
      if (!effectiveName) {
        setCreateError('Project name is required');
        return;
      }

      setCreateError('');
      setSetupStep('compatibility');
      return;
    }

    if (setupStep === 'details' && projectSource === 'git') {
      const effectiveName = newProject.name.trim();
      if (!effectiveName) {
        setCreateError('Project name is required');
        return;
      }

      try {
        setCreateLoading(true);
        setCreateError('');

        const connectionMode = gitConnectionMode || 'local';
        const providerFromGlobal = (gitSettings?.provider || 'github').toLowerCase();
        const normalizedProvider = (connectionMode === 'custom' ? gitProvider : providerFromGlobal) || 'github';
        const defaultBranch = (gitSettings?.defaultBranch || 'main').trim() || 'main';
        const username = typeof gitSettings?.username === 'string' ? gitSettings.username.trim() : '';

        const projectData = {
          name: effectiveName,
          description: newProject.description.trim(),
          frontend: {
            language: newProject.frontend.language,
            framework: newProject.frontend.framework
          },
          backend: {
            language: newProject.backend.language,
            framework: newProject.backend.framework
          },
          importMethod: 'git',
          gitUrl: gitRemoteUrl.trim(),
          gitProvider: normalizedProvider,
          gitDefaultBranch: defaultBranch,
          gitConnectionMode: connectionMode
        };

        if (connectionMode !== 'local') {
          projectData.gitRemoteUrl = gitRemoteUrl.trim();
          projectData.gitConnectionProvider = normalizedProvider;
          if (connectionMode === 'custom') {
            projectData.gitToken = gitToken.trim();
          }
        }

        const result = await importProject(projectData);

        if (cloneCreateRemote && connectionMode !== 'local' && result?.project?.id) {
          const derivedName = gitRepoName.trim() || deriveRepoName(gitRemoteUrl);
          const options = {
            provider: normalizedProvider,
            name: derivedName,
            owner: gitRepoOwner.trim(),
            visibility: gitRepoVisibility,
            description: newProject.description.trim()
          };

          if (username) {
            options.username = username;
          }

          if (connectionMode === 'custom') {
            options.token = gitToken.trim();
          }

          await createProjectRemoteRepository(result.project.id, options);
        }

        const importJobs = Array.isArray(result?.jobs) ? result.jobs : [];
        if (importJobs.length > 0 && result?.project?.id) {
          setSetupState({
            isWaiting: true,
            projectId: result.project.id,
            jobs: importJobs,
            error: ''
          });
          return;
        }

        showMain();
      } catch (err) {
        setCreateError(err?.message || 'Failed to import project');
      } finally {
        setCreateLoading(false);
      }
      return;
    }

    if (setupStep === 'compatibility' && projectSource === 'local') {
      const compatibilityRequired = Boolean(compatibilityPlan?.needsChanges);
      const structureRequired = Boolean(compatibilityPlan?.structure?.needsMove);

      if (compatibilityRequired && !compatibilityConsent) {
        setCreateError('Please allow compatibility updates to continue');
        return;
      }

      if (structureRequired && !structureConsent) {
        setCreateError('Please allow moving frontend files into a frontend folder');
        return;
      }

      const effectiveName = newProject.name.trim();
      if (!effectiveName) {
        setCreateError('Project name is required');
        return;
      }

      if (!localPath.trim()) {
        setCreateError('Project path is required');
        return;
      }

      try {
        setCreateLoading(true);
        setCreateError('');

        const projectData = {
          name: effectiveName,
          description: newProject.description.trim(),
          frontend: {
            language: newProject.frontend.language,
            framework: newProject.frontend.framework
          },
          backend: {
            language: newProject.backend.language,
            framework: newProject.backend.framework
          },
          importMethod: 'local',
          importMode: localImportMode,
          localPath: localPath.trim(),
          applyCompatibility: compatibilityRequired && compatibilityConsent,
          applyStructureFix: structureRequired && structureConsent,
          gitConnectionMode: gitConnectionMode || 'local'
        };

        if (gitConnectionMode !== 'local') {
          projectData.gitRemoteUrl = gitConnectionRemoteUrl.trim();
          projectData.gitConnectionProvider = (gitConnectionMode === 'custom' ? gitProvider : (gitSettings?.provider || 'github')).toLowerCase();
          if (gitConnectionMode === 'custom') {
            projectData.gitToken = gitToken.trim();
          }
        }

        const result = await importProject(projectData);
        const importJobs = Array.isArray(result?.jobs) ? result.jobs : [];
        if (importJobs.length > 0 && result?.project?.id) {
          setSetupState({
            isWaiting: true,
            projectId: result.project.id,
            jobs: importJobs,
            error: ''
          });
          return;
        }

        showMain();
      } catch (err) {
        setCreateError(err?.message || 'Failed to import project');
      } finally {
        setCreateLoading(false);
      }
      return;
    }

    const derivedNameForValidation = gitWorkflowMode !== 'local'
      ? (gitCloudMode === 'create' ? (gitRepoName.trim() || newProject.name.trim()) : deriveRepoName(gitRemoteUrl))
      : '';
    const effectiveName = derivedNameForValidation || newProject.name.trim();
    if (!effectiveName) {
      setCreateError('Project name is required');
      return;
    }

    // Hide header immediately before any async operations
    const newProgressKey = generateProgressKey();
    setProgressKey(newProgressKey);
    startProgressStream(newProgressKey);
    setProcesses(null);
    setProgress({
      steps: buildProgressSteps(false),
      completion: 0,
      status: 'pending',
      statusMessage: 'Contacting backend server...'
    });

    try {
      setCreateLoading(true);
      setCreateError('');

      const isCloudWorkflow = gitWorkflowMode === 'global' || gitWorkflowMode === 'custom';
      const isConnectExisting = isCloudWorkflow && gitCloudMode === 'connect';

      const providerFromGlobal = (gitSettings?.provider || 'github').toLowerCase();
      const normalizedProvider = (gitWorkflowMode === 'custom' ? gitProvider : providerFromGlobal) || 'github';
      const defaultBranch = (gitSettings?.defaultBranch || 'main').trim() || 'main';
      const username = typeof gitSettings?.username === 'string' ? gitSettings.username.trim() : '';
      const derivedName = isCloudWorkflow
        ? (gitCloudMode === 'create' ? gitRepoName.trim() : deriveRepoName(gitRemoteUrl))
        : '';
      const nameForProject = derivedName || newProject.name.trim();
      const descriptionForProject = newProject.description.trim();

      const postBody = {
        name: nameForProject,
        description: descriptionForProject,
        frontend: {
          language: newProject.frontend.language,
          framework: newProject.frontend.framework
        },
        backend: {
          language: newProject.backend.language,
          framework: newProject.backend.framework
        },
        progressKey: newProgressKey
      };

      // When connecting to an existing repo, include git params so the backend
      // clones instead of scaffolding a new project from scratch.
      if (isConnectExisting) {
        postBody.gitCloudMode = 'connect';
        postBody.gitRemoteUrl = gitRemoteUrl.trim();
        postBody.gitProvider = normalizedProvider;
        postBody.gitDefaultBranch = defaultBranch;
        if (username) {
          postBody.gitUsername = username;
        }
        if (gitWorkflowMode === 'custom') {
          postBody.gitToken = gitToken.trim();
        }
      }

      const response = await axios.post('/api/projects', postBody);
      
      if (response.data && response.data.success) {
        const projectData = response.data.project;

        // Prefer progress streaming for UI updates. If the backend returns a final
        // snapshot (or streaming is unavailable), apply it.
        if (response.data.progress && !isEmptyProgressSnapshot(response.data.progress)) {
          applyProgressPayload(response.data.progress);
        } else {
          applyProgressPayload({
            steps: buildProgressSteps(true),
            completion: 100,
            status: 'completed',
            statusMessage: response.data.message || 'Project created successfully'
          });
        }

        // For "create new repo" flows, create the remote repo and push after
        // the project has been scaffolded.  The "connect existing" flow is
        // handled entirely server-side via the clone path above.
        if (isCloudWorkflow && !isConnectExisting && gitCloudMode === 'create' && projectData?.id) {
          setProgress((prev) => {
            return Object.assign(
              {
                steps: buildProgressSteps(true),
                completion: 100
              },
              prev,
              {
                status: 'in-progress',
                statusMessage: 'Setting up Git workflow...'
              }
            );
          });

          const options = {
            provider: normalizedProvider,
            name: gitRepoName.trim() || nameForProject,
            owner: gitRepoOwner.trim(),
            visibility: gitRepoVisibility,
            description: descriptionForProject
          };

          if (username) {
            options.username = username;
          }

          if (gitWorkflowMode === 'custom') {
            options.token = gitToken.trim();
          }

          await createProjectRemoteRepository(projectData.id, options);
        }

        setProgressKey(null);
        
        // Store process information
        if (response.data.processes) {
          setProcesses(response.data.processes);
        }

        if (typeof fetchProjects === 'function') {
          fetchProjects();
        }
        
        // Auto-select the newly created project
        selectProject(projectData);

        const suggestion = response.data?.gitIgnoreSuggestion;
        const setupRequired = Boolean(response.data?.setupRequired);
        const shouldPromptGitIgnore = setupRequired
          && suggestion?.needed;

        if (shouldPromptGitIgnore) {
          setGitIgnoreSuggestion({
            projectId: projectData.id,
            entries: suggestion.entries,
            detected: suggestion.detected || [],
            samplePaths: suggestion.samplePaths || [],
            trackedFiles: suggestion.trackedFiles || []
          });
        } else {
          // Show success for a moment before navigating
          setTimeout(() => {
            showMain();
          }, 2000);
        }
      }
    } catch (err) {
      closeProgressStream();
      setProgress(null);
      const isNetworkIssue = (!err.response && (err.code === 'ERR_NETWORK' || err.message === 'Network Error'));
      const errorMessage = err.response?.data?.error || (isNetworkIssue ? BACKEND_UNAVAILABLE_MESSAGE : err.message) || 'Project creation failed';
      setCreateError(errorMessage);
    } finally {
      setCreateLoading(false);
    }
  };

  const handleCancel = () => {
    setCreateError('');
    closeProgressStream();
    setProgressKey(null);
    setProgress(null);
    setProcesses(null);
    setGitIgnoreSuggestion(null);
    setGitIgnoreStatus({ state: 'idle', error: '' });
    setSetupStep('source');
    setProjectSource('new');
    setLocalPath('');
    setLocalImportMode('copy');
    setFolderPickerOpen(false);
    setCompatibilityStatus({ isLoading: false, error: '' });
    setCompatibilityPlan(null);
    setCompatibilityConsent(false);
    setStructureConsent(false);
    compatibilityPathRef.current = '';
    setSetupState({
      isWaiting: false,
      projectId: null,
      jobs: [],
      error: ''
    });
    setNewProject({
      name: '',
      description: '',
      frontend: {
        language: 'javascript',
        framework: 'react'
      },
      backend: {
        language: 'javascript',
        framework: 'express'
      }
    });
    setGitWorkflowMode('');
    setGitCloudMode('');
    setGitProvider('github');
    setGitToken('');
    setGitRemoteUrl('');
    setGitConnectionMode('local');
    setGitConnectionRemoteUrl('');
    setGitTechStatus({ isLoading: false, error: '' });
    gitTechKeyRef.current = '';
    setCloneCreateRemote(false);
    setGitRepoName('');
    setGitRepoOwner('');
    setGitRepoVisibility('private');
    showMain();
  };

  const handleBackToDetails = () => {
    setCreateError('');
    if (setupStep === 'compatibility') {
      setSetupStep('details');
      return;
    }
    if (setupStep === 'details') {
      setSetupStep('git');
      return;
    }
    setSetupStep('source');
  };

  const handleFolderSelect = () => {
    setCreateError('');
    setFolderPickerOpen(true);
  };

  const handleFolderPicked = (pathValue) => {
    if (pathValue) {
      setLocalPath(pathValue);
    }
    setFolderPickerOpen(false);
  };

  const applyDetectedTech = (detected) => {
    if (!detected || typeof detected !== 'object') {
      return;
    }

    setNewProject((prev) => {
      const nextFrontendLang = detected?.frontend?.language || prev.frontend.language;
      const nextBackendLang = detected?.backend?.language || prev.backend.language;

      const frontendOptions = frontendFrameworks[nextFrontendLang] || frontendFrameworks.javascript;
      const backendOptions = backendFrameworks[nextBackendLang] || backendFrameworks.javascript;

      const nextFrontendFramework = frontendOptions.includes(detected?.frontend?.framework)
        ? detected.frontend.framework
        : frontendOptions[0];

      const nextBackendFramework = backendOptions.includes(detected?.backend?.framework)
        ? detected.backend.framework
        : backendOptions[0];

      return {
        ...prev,
        frontend: {
          language: nextFrontendLang,
          framework: nextFrontendFramework
        },
        backend: {
          language: nextBackendLang,
          framework: nextBackendFramework
        }
      };
    });
  };

  useEffect(() => {
    if (setupStep !== 'details' || projectSource !== 'git') {
      return;
    }

    const url = gitRemoteUrl.trim();
    if (!url) {
      return;
    }

    const connectionMode = gitConnectionMode || 'local';
    const provider = (connectionMode === 'custom' ? gitProvider : (gitSettings?.provider || 'github')).toLowerCase();
    const token = connectionMode === 'custom' ? gitToken.trim() : '';
    const detectKey = `${url}|${connectionMode}|${provider}|${token}`;
    if (gitTechKeyRef.current === detectKey) {
      return;
    }
    gitTechKeyRef.current = detectKey;

    setGitTechStatus({ isLoading: true, error: '' });

    axios
      .post('/api/fs/detect-git-tech', {
        gitUrl: url,
        provider,
        token: token || undefined
      })
      .then((response) => {
        const data = response?.data;
        if (!data?.success) {
          throw new Error(data?.error || 'Failed to detect tech stack');
        }
        applyDetectedTech(data);
        setGitTechStatus({ isLoading: false, error: '' });
      })
      .catch((error) => {
        const message = error?.response?.data?.error || error?.message || 'Failed to detect tech stack';
        setGitTechStatus({ isLoading: false, error: message });
      });
  }, [
    setupStep,
    projectSource,
    gitRemoteUrl,
    gitConnectionMode,
    gitProvider,
    gitToken,
    gitSettings?.provider
  ]);

  const runPostCloneSetup = async (projectId) => {
    if (!projectId) {
      throw new Error('Missing project id for setup');
    }

    setGitIgnoreStatus({ state: 'working', error: '' });
    setProgress((prev) => {
      const existingSteps = Array.isArray(prev?.steps) && prev.steps.length > 0
        ? prev.steps
        : buildProgressSteps(false);

      const updatedSteps = existingSteps.map((step, index) => ({
        ...step,
        completed: index < 3
      }));

      return {
        ...prev,
        steps: updatedSteps,
        status: 'in-progress',
        statusMessage: 'Installing dependencies...'
      };
    });

    const response = await axios.post(`/api/projects/${projectId}/setup`);

    if (!response?.data?.success) {
      throw new Error(response?.data?.error || 'Failed to complete project setup');
    }

    if (response.data.processes) {
      setProcesses(response.data.processes);
    }

    setProgress((prev) => ({
      ...prev,
      steps: buildProgressSteps(true),
      completion: 100,
      status: 'completed',
      statusMessage: response.data.message || 'Project setup completed'
    }));

    setGitIgnoreStatus({ state: 'done', error: '' });
    setGitIgnoreSuggestion(null);
    setTimeout(() => {
      showMain();
    }, 2000);
  };

  const handleApplyGitIgnore = async () => {
    if (!gitIgnoreSuggestion?.projectId) {
      return;
    }

    try {
      const response = await axios.post(
        `/api/projects/${gitIgnoreSuggestion.projectId}/git/ignore-fix`,
        {
          entries: gitIgnoreSuggestion.entries,
          commit: true
        }
      );

      if (!response?.data?.success) {
        throw new Error(response?.data?.error || 'Failed to update .gitignore');
      }

      await runPostCloneSetup(gitIgnoreSuggestion.projectId);
    } catch (error) {
      const message = error?.response?.data?.error || error?.message || 'Failed to update .gitignore';
      setGitIgnoreStatus({ state: 'error', error: message });
    }
  };

  const handleSkipGitIgnore = async () => {
    if (!gitIgnoreSuggestion?.projectId) {
      return;
    }

    try {
      await runPostCloneSetup(gitIgnoreSuggestion.projectId);
    } catch (error) {
      const message = error?.response?.data?.error || error?.message || 'Failed to complete project setup';
      setGitIgnoreStatus({ state: 'error', error: message });
      return;
    }
  };

  const handleContinueAfterGitIgnore = () => {
    setGitIgnoreSuggestion(null);
    setGitIgnoreStatus({ state: 'idle', error: '' });
    showMain();
  };

  useEffect(() => {
    if (!setupState.isWaiting || !setupState.projectId) {
      return;
    }

    let isCancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`/api/projects/${setupState.projectId}/jobs`);
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.success) {
          throw new Error(data?.error || 'Failed to load setup jobs');
        }
        if (isCancelled) {
          return;
        }
        const jobs = Array.isArray(data.jobs) ? data.jobs : [];
        const finalStates = new Set(['succeeded', 'failed', 'cancelled']);
        const isComplete = jobs.length > 0 && jobs.every((job) => finalStates.has(job?.status));
        setSetupState((prev) => ({
          ...prev,
          jobs,
          error: ''
        }));
        if (isComplete) {
          setSetupState((prev) => ({
            ...prev,
            isWaiting: false
          }));
          showMain();
        }
      } catch (error) {
        if (!isCancelled) {
          setSetupState((prev) => ({
            ...prev,
            error: error?.message || 'Failed to load setup jobs'
          }));
        }
      }
    };

    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      isCancelled = true;
      clearInterval(timer);
    };
  }, [setupState.isWaiting, setupState.projectId, showMain]);

  useEffect(() => {
    if (process.env.NODE_ENV !== 'test') {
      return;
    }

    if (!CreateProject.__testHooks) {
      CreateProject.__testHooks = {};
    }

    CreateProject.__testHooks.runPostCloneSetup = runPostCloneSetup;
    CreateProject.__testHooks.handleApplyGitIgnore = handleApplyGitIgnore;
    CreateProject.__testHooks.handleSkipGitIgnore = handleSkipGitIgnore;
    CreateProject.__testHooks.handleContinueAfterGitIgnore = handleContinueAfterGitIgnore;
    CreateProject.__testHooks.setGitIgnoreSuggestion = setGitIgnoreSuggestion;
    CreateProject.__testHooks.setGitIgnoreStatus = setGitIgnoreStatus;
    CreateProject.__testHooks.setProgress = setProgress;
    CreateProject.__testHooks.deriveRepoName = deriveRepoName;
    CreateProject.__testHooks.setGitCloudMode = setGitCloudMode;
    CreateProject.__testHooks.setLocalPath = setLocalPath;
    CreateProject.__testHooks.setProjectSource = setProjectSource;
    CreateProject.__testHooks.setGitRemoteUrl = setGitRemoteUrl;
    CreateProject.__testHooks.applyDetectedTech = applyDetectedTech;
    CreateProject.__testHooks.handleFolderPicked = handleFolderPicked;
    CreateProject.__testHooks.setNewProject = setNewProject;
    CreateProject.__testHooks.setGitWorkflowMode = setGitWorkflowMode;
    CreateProject.__testHooks.setSetupState = setSetupState;
    CreateProject.__testHooks.setGitConnectionMode = setGitConnectionMode;

    return () => {
      if (!CreateProject.__testHooks) {
        return;
      }
      CreateProject.__testHooks.runPostCloneSetup = undefined;
      CreateProject.__testHooks.handleApplyGitIgnore = undefined;
      CreateProject.__testHooks.handleSkipGitIgnore = undefined;
      CreateProject.__testHooks.handleContinueAfterGitIgnore = undefined;
      CreateProject.__testHooks.setGitIgnoreSuggestion = undefined;
      CreateProject.__testHooks.setGitIgnoreStatus = undefined;
      CreateProject.__testHooks.setProgress = undefined;
      CreateProject.__testHooks.deriveRepoName = undefined;
      CreateProject.__testHooks.setGitCloudMode = undefined;
      CreateProject.__testHooks.setLocalPath = undefined;
      CreateProject.__testHooks.setProjectSource = undefined;
      CreateProject.__testHooks.setGitRemoteUrl = undefined;
      CreateProject.__testHooks.applyDetectedTech = undefined;
      CreateProject.__testHooks.handleFolderPicked = undefined;
      CreateProject.__testHooks.setNewProject = undefined;
      CreateProject.__testHooks.setGitWorkflowMode = undefined;
      CreateProject.__testHooks.setSetupState = undefined;
      CreateProject.__testHooks.setGitConnectionMode = undefined;
    };
  }, [
    runPostCloneSetup,
    handleApplyGitIgnore,
    handleSkipGitIgnore,
    handleContinueAfterGitIgnore
  ]);

  const getFrontendFrameworks = () => {
    return frontendFrameworks[newProject.frontend.language] || ['react'];
  };

  const getBackendFrameworks = () => {
    return backendFrameworks[newProject.backend.language] || ['express'];
  };

  const compatibilityRequired = Boolean(compatibilityPlan?.needsChanges);
  const structureRequired = Boolean(compatibilityPlan?.structure?.needsMove);
  const compatibilityChanges = Array.isArray(compatibilityPlan?.changes) ? compatibilityPlan.changes : [];

  useEffect(() => {
    if (setupStep !== 'compatibility') {
      return;
    }

    if (projectSource !== 'local') {
      setCompatibilityPlan(null);
      setCompatibilityStatus({ isLoading: false, error: '' });
      setCompatibilityConsent(false);
      return;
    }

    const pathValue = localPath.trim();
    if (!pathValue) {
      setCompatibilityPlan(null);
      setCompatibilityStatus({ isLoading: false, error: '' });
      return;
    }

    if (compatibilityPathRef.current === pathValue) {
      return;
    }

    compatibilityPathRef.current = pathValue;
    setCompatibilityStatus({ isLoading: true, error: '' });

    fetch(`/api/fs/compatibility?path=${encodeURIComponent(pathValue)}`)
      .then((response) => response.json().then((data) => ({ response, data })))
      .then(({ response, data }) => {
        if (!response.ok || !data?.success) {
          throw new Error(data?.error || 'Failed to scan compatibility');
        }
        const nextPlan = data?.plan;
        setCompatibilityPlan(nextPlan ? nextPlan : null);
        setCompatibilityStatus({ isLoading: false, error: '' });
      })
      .catch((error) => {
        setCompatibilityPlan(null);
        setCompatibilityStatus({ isLoading: false, error: error?.message || 'Failed to scan compatibility' });
      });
  }, [localPath, projectSource, setupStep]);

  const isProgressBlocking = Boolean(progress && progress.status !== 'failed');
  const isCloudWorkflowUi = gitWorkflowMode === 'global' || gitWorkflowMode === 'custom';
  const derivedRepoNameForSummary = isCloudWorkflowUi
    ? (gitCloudMode === 'create' ? gitRepoName.trim() : deriveRepoName(gitRemoteUrl))
    : '';
  const shouldShowGitSummary =
    isCloudWorkflowUi &&
    gitCloudMode === 'connect' &&
    Boolean(gitRemoteUrl.trim());
  const gitSummaryItems = shouldShowGitSummary
    ? [
        { label: 'Repo name', value: derivedRepoNameForSummary || '(not set)' },
        { label: 'Remote', value: gitRemoteUrl.trim() },
        { label: 'Provider', value: (gitWorkflowMode === 'custom' ? gitProvider : (gitSettings?.provider || 'github')) }
      ]
    : [];

  if (setupState.isWaiting) {
    const setupJobs = setupState.jobs || [];
    const setupError = setupState.error;
    return (
      <div className="create-project-view">
        <div className="create-project-container">
          <div className="create-project-header">
            <div className="create-project-header-row">
              <div>
                <h1>Preparing your project</h1>
                <p>We’re installing dependencies and getting everything ready.</p>
              </div>
              <button
                type="button"
                className="create-project-close"
                onClick={handleCancel}
                aria-label="Close add project"
              >
                &times;
              </button>
            </div>
          </div>

          <div className="create-project-form">
            {setupError && <div className="error-message">{setupError}</div>}
            <div className="setup-job-list">
              {setupJobs.map((job) => (
                <div key={job.id} className="setup-job-row">
                  <div className="setup-job-title">{job.displayName || job.type}</div>
                  <div className={`setup-job-status status-${job.status || 'pending'}`}>
                    {job.status || 'pending'}
                  </div>
                </div>
              ))}
            </div>
            <div className="tech-detect-status">Waiting for setup to finish…</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="create-project-view">
      <div className="create-project-container">
        {progress && (
          <div className="progress-container">
            <h4>Creating your project...</h4>
            <div className="progress-bar" role="progressbar" aria-valuenow={progress.completion} aria-valuemin="0" aria-valuemax="100">
              <div 
                className="progress-fill" 
                style={{ width: `${progress.completion}%` }}
              ></div>
            </div>
            {progress.statusMessage && (
              <p className="progress-status">{progress.statusMessage}</p>
            )}
            {progress.status === 'failed' && progress.error && (
              <div className="progress-error">{progress.error}</div>
            )}
            <div className="progress-steps">
              {progress.steps.map((step, index) => (
                <div key={index} className={`progress-step ${step.completed ? 'completed' : ''}`}>
                  <span className="step-icon">
                    {step.completed ? '✓' : '●'}
                  </span>
                  <span className="step-name">{step.name}</span>
                </div>
              ))}
            </div>
            {processes && progress.completion === 100 && (
              <div className="success-info">
                <p>✅ Project created successfully!</p>
                <p>Frontend running on: <a href={`http://localhost:${processes.frontend.port}`} target="_blank" rel="noopener noreferrer">http://localhost:{processes.frontend.port}</a></p>
                <p>Backend running on: <a href={`http://localhost:${processes.backend.port}`} target="_blank" rel="noopener noreferrer">http://localhost:{processes.backend.port}</a></p>
              </div>
            )}
            {gitIgnoreSuggestion && gitIgnoreStatus.state !== 'working' && (
              <div className="gitignore-suggestion">
                <h5>This repo is missing information in it's .gitignore file which will result in issues when used with Lucid Coder.</h5>
                <p>
                  If you want to continue, we can fix this issue automatically.
                </p>
                {gitIgnoreSuggestion.entries.length > 0 && (
                  <p>
                    Suggested entries:
                  </p>
                )}
                <ul>
                  {gitIgnoreSuggestion.entries.map((entry) => (
                    <li key={entry}><code>{entry}</code></li>
                  ))}
                </ul>
                {gitIgnoreSuggestion.trackedFiles?.length > 0 && (
                  <p className="gitignore-warning">
                    Note: installs will update tracked files ({gitIgnoreSuggestion.trackedFiles.join(', ')}),
                    so the working tree may still show changes.
                  </p>
                )}
                {gitIgnoreSuggestion.samplePaths?.length > 0 && (
                  <p className="gitignore-sample">
                    Detected: {gitIgnoreSuggestion.samplePaths.join(', ')}
                  </p>
                )}
                {gitIgnoreStatus.state === 'error' && (
                  <div className="gitignore-error">{gitIgnoreStatus.error}</div>
                )}
                <div className="gitignore-actions">
                  {gitIgnoreStatus.state !== 'done' ? (
                    <>
                      <button
                        type="button"
                        className="git-settings-button primary"
                        onClick={handleApplyGitIgnore}
                        disabled={gitIgnoreStatus.state === 'working'}
                      >
                        Fix Issue
                      </button>
                      <button
                        type="button"
                        className="git-settings-button secondary"
                        onClick={handleSkipGitIgnore}
                        disabled={gitIgnoreStatus.state === 'working'}
                      >
                        Cancel Installation
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="git-settings-button primary"
                      onClick={handleContinueAfterGitIgnore}
                    >
                      Continue to project
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
        
        <div className="create-project-header" style={{ display: isProgressBlocking ? 'none' : 'block' }}>
          <div className="create-project-header-row">
            <div>
              <h1>Add Project</h1>
              <p>Create a new project or bring in an existing one.</p>
            </div>
            <button
              type="button"
              className="create-project-close"
              onClick={handleCancel}
              aria-label="Close add project"
            >
              &times;
            </button>
          </div>
        </div>

        <div className="create-project-form" style={{ display: isProgressBlocking ? 'none' : 'block' }}>
          <form onSubmit={handleCreateProject} role="form">
            {setupStep === 'source' && (
              <div className="form-section">
                <h3>Project Source</h3>
                <div className="radio-group">
                  <label className={`radio-card ${projectSource === 'new' ? 'selected' : ''}`}>
                    <input
                      type="radio"
                      name="projectSource"
                      value="new"
                      checked={projectSource === 'new'}
                      onChange={() => {
                        setProjectSource('new');
                        setCreateError('');
                      }}
                      disabled={createLoading}
                    />
                    <div>
                      <div className="radio-title">Create a new project</div>
                      <div className="radio-subtitle">Scaffold a brand-new app with your chosen tech stack.</div>
                    </div>
                  </label>
                  <label className={`radio-card ${projectSource === 'local' ? 'selected' : ''}`}>
                    <input
                      type="radio"
                      name="projectSource"
                      value="local"
                      checked={projectSource === 'local'}
                      onChange={() => {
                        setProjectSource('local');
                        setCreateError('');
                      }}
                      disabled={createLoading}
                    />
                    <div>
                      <div className="radio-title">Import a local folder</div>
                      <div className="radio-subtitle">Bring in an existing project from your machine.</div>
                    </div>
                  </label>
                  <label className={`radio-card ${projectSource === 'git' ? 'selected' : ''}`}>
                    <input
                      type="radio"
                      name="projectSource"
                      value="git"
                      checked={projectSource === 'git'}
                      onChange={() => {
                        setProjectSource('git');
                        setCreateError('');
                      }}
                      disabled={createLoading}
                    />
                    <div>
                      <div className="radio-title">Clone from Git</div>
                      <div className="radio-subtitle">Connect an existing repository URL.</div>
                    </div>
                  </label>
                </div>
              </div>
            )}

            {setupStep === 'details' && (
              <>
                <div className="form-section">
                  <h3>Project Details</h3>
                  <div className="form-row">
                    <div className="form-group">
                      <label htmlFor="project-name">Project Name *</label>
                      <input
                        id="project-name"
                        type="text"
                        placeholder="Enter project name"
                        value={newProject.name}
                        onChange={(e) => {
                          setNewProject(prev => ({ ...prev, name: e.target.value }));
                          // Clear error when name changes
                          if (createError) {
                            setCreateError('');
                          }
                        }}
                        className="form-input"
                        disabled={createLoading}
                        autoFocus
                      />
                    </div>
                    
                    <div className="form-group">
                      <label htmlFor="project-description">Description</label>
                      <input
                        id="project-description"
                        type="text"
                        placeholder="Brief description of your project"
                        value={newProject.description}
                        onChange={(e) => setNewProject(prev => ({ ...prev, description: e.target.value }))}
                        className="form-input"
                        disabled={createLoading}
                      />
                    </div>
                  </div>
                </div>

                <div className="form-section">
                  <h3>Frontend Technology</h3>
                  <div className="form-row">
                    <div className="form-group">
                      <label htmlFor="frontend-language-select">Frontend Language *</label>
                      <select
                        id="frontend-language-select"
                        value={newProject.frontend.language}
                        onChange={(e) => setNewProject(prev => ({ 
                          ...prev, 
                          frontend: {
                            language: e.target.value,
                            framework: frontendFrameworks[e.target.value]?.[0] || 'react'
                          }
                        }))}
                        className="form-select"
                        disabled={createLoading || projectSource === 'git'}
                      >
                        {frontendLanguages.map(lang => (
                          <option key={lang} value={lang}>
                            {lang.charAt(0).toUpperCase() + lang.slice(1)}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="form-group">
                      <label htmlFor="frontend-framework-select">Frontend Framework *</label>
                      <select
                        id="frontend-framework-select"
                        value={newProject.frontend.framework}
                        onChange={(e) => setNewProject(prev => ({ 
                          ...prev, 
                          frontend: { ...prev.frontend, framework: e.target.value }
                        }))}
                        className="form-select"
                        disabled={createLoading || projectSource === 'git'}
                      >
                        {getFrontendFrameworks().map(framework => (
                          <option key={framework} value={framework}>
                            {framework.charAt(0).toUpperCase() + framework.slice(1)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>

                <div className="form-section">
                  <h3>Backend Technology</h3>
                  <div className="form-row">
                    <div className="form-group">
                      <label htmlFor="backend-language-select">Backend Language *</label>
                      <select
                        id="backend-language-select"
                        value={newProject.backend.language}
                        onChange={(e) => setNewProject(prev => ({ 
                          ...prev, 
                          backend: {
                            language: e.target.value,
                            framework: backendFrameworks[e.target.value]?.[0] || 'express'
                          }
                        }))}
                        className="form-select"
                        disabled={createLoading || projectSource === 'git'}
                      >
                        {backendLanguages.map(lang => (
                          <option key={lang} value={lang}>
                            {lang.charAt(0).toUpperCase() + lang.slice(1)}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="form-group">
                      <label htmlFor="backend-framework-select">Backend Framework *</label>
                      <select
                        id="backend-framework-select"
                        value={newProject.backend.framework}
                        onChange={(e) => setNewProject(prev => ({ 
                          ...prev, 
                          backend: { ...prev.backend, framework: e.target.value }
                        }))}
                        className="form-select"
                        disabled={createLoading || projectSource === 'git'}
                      >
                        {getBackendFrameworks().map(framework => (
                          <option key={framework} value={framework}>
                            {framework.charAt(0).toUpperCase() + framework.slice(1)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              </>
            )}

            {setupStep === 'git' && (
              <div className={`form-section${projectSource === 'local' ? ' form-section--full' : ''}`}>
                <h3>
                  {projectSource === 'local'
                    ? 'Import setup'
                    : (projectSource === 'git' ? 'Clone setup' : 'Git setup')}
                </h3>

                {projectSource === 'local' && (
                  <>
                    <div className="form-row">
                      <div className="form-group form-group--inline" style={{ width: '100%' }}>
                        <label htmlFor="project-path">Project Folder Path *</label>
                        <div className="path-input-group">
                          <input
                            id="project-path"
                            type="text"
                            placeholder="Enter the path to your project folder"
                            value={localPath}
                            onChange={(event) => {
                              setLocalPath(event.target.value);
                              if (createError) {
                                setCreateError('');
                              }
                            }}
                            className="form-input"
                            disabled={createLoading}
                          />
                          <button
                            type="button"
                            onClick={handleFolderSelect}
                            className="browse-btn"
                            disabled={createLoading}
                          >
                            Browse
                          </button>
                        </div>
                        <div className="radio-group">
                          <label className={`radio-card ${localImportMode === 'copy' ? 'selected' : ''}`}>
                            <input
                              type="radio"
                              name="localImportMode"
                              value="copy"
                              checked={localImportMode === 'copy'}
                              onChange={() => setLocalImportMode('copy')}
                              disabled={createLoading}
                            />
                            <div>
                              <div className="radio-title">Copy into managed folder</div>
                              <div className="radio-subtitle">LucidCoder will copy the project into its workspace.</div>
                            </div>
                          </label>
                          <label className={`radio-card ${localImportMode === 'link' ? 'selected' : ''}`}>
                            <input
                              type="radio"
                              name="localImportMode"
                              value="link"
                              checked={localImportMode === 'link'}
                              onChange={() => setLocalImportMode('link')}
                              disabled={createLoading}
                            />
                            <div>
                              <div className="radio-title">Link to existing folder</div>
                              <div className="radio-subtitle">Keep the project in place (must be inside the managed folder).</div>
                            </div>
                          </label>
                        </div>
                      </div>
                    </div>

                    <div className="form-row">
                      <div className="form-group form-group--inline">
                        <label htmlFor="git-connection-select">Git Workflow *</label>
                        <select
                          id="git-connection-select"
                          value={gitConnectionMode}
                          onChange={(e) => {
                            setGitConnectionMode(e.target.value);
                            if (createError) {
                              setCreateError('');
                            }
                          }}
                          className="form-select"
                          disabled={createLoading}
                        >
                          <option value="local">Local only</option>
                          <option value="global">Cloud (use global git settings)</option>
                          <option value="custom">Cloud (custom connection)</option>
                        </select>
                      </div>
                    </div>

                    {gitConnectionMode !== 'local' && (
                      <div className="form-row">
                        <div className="form-group" style={{ width: '100%' }}>
                          <label htmlFor="git-connection-remote-url">Repository URL *</label>
                          <input
                            id="git-connection-remote-url"
                            type="text"
                            placeholder="https://github.com/org/repo.git"
                            value={gitConnectionRemoteUrl}
                            onChange={(e) => {
                              setGitConnectionRemoteUrl(e.target.value);
                              if (createError) {
                                setCreateError('');
                              }
                            }}
                            className="form-input"
                            disabled={createLoading}
                          />
                        </div>
                      </div>
                    )}
                  </>
                )}

                {projectSource === 'git' && (
                  <>
                    <div className="form-row form-row--inline" style={{ gridTemplateColumns: '30% 70%' }}>
                      <label className="form-label" htmlFor="git-clone-url">Repository URL *</label>
                      <input
                        id="git-clone-url"
                        type="text"
                        placeholder="https://github.com/org/repo.git"
                        value={gitRemoteUrl}
                        onChange={(e) => {
                          setGitRemoteUrl(e.target.value);
                          if (createError) {
                            setCreateError('');
                          }
                        }}
                        className="form-input"
                        disabled={createLoading}
                      />
                    </div>

                    <div className="form-row form-row--inline" style={{ gridTemplateColumns: '30% 70%' }}>
                      <label className="form-label" htmlFor="git-connection-select">Git Workflow *</label>
                      <select
                        id="git-connection-select"
                        value={gitConnectionMode}
                        onChange={(e) => {
                          setGitConnectionMode(e.target.value);
                          if (createError) {
                            setCreateError('');
                          }
                        }}
                        className="form-select"
                        disabled={createLoading}
                      >
                        <option value="local">Local only</option>
                        <option value="global">Cloud (use global git settings)</option>
                        <option value="custom">Cloud (custom connection)</option>
                      </select>
                    </div>

                    {gitConnectionMode !== 'local' && (
                      <div className="radio-group radio-group--spaced radio-group--clone">
                        <label className={`radio-card ${cloneCreateRemote ? 'selected' : ''}`}>
                          <input
                            type="checkbox"
                            checked={cloneCreateRemote}
                            onChange={(event) => setCloneCreateRemote(event.target.checked)}
                            disabled={createLoading}
                          />
                          <div>
                            <div className="radio-title">Create a new repo after cloning (create fork)</div>
                            <div className="radio-subtitle">Push the cloned project into a new repository you own.</div>
                          </div>
                        </label>
                      </div>
                    )}
                  </>
                )}

                {projectSource === 'new' && (
                  <div className="form-row">
                    <div className="form-group">
                      <label htmlFor="git-workflow-select">Git Workflow *</label>
                      <select
                        id="git-workflow-select"
                        value={gitWorkflowMode}
                        onChange={(e) => {
                          const next = e.target.value;
                          setGitWorkflowMode(next);
                          setGitCloudMode('');
                          if (createError) {
                            setCreateError('');
                          }
                        }}
                        className="form-select"
                        disabled={createLoading}
                        autoFocus
                      >
                        <option value="">Select a workflow</option>
                        <option value="local">Local only</option>
                        <option value="global">Cloud (use global git settings)</option>
                        <option value="custom">Cloud (custom connection)</option>
                      </select>
                    </div>

                  </div>
                )}

                {(projectSource === 'new' ? gitWorkflowMode === 'custom' : gitConnectionMode === 'custom') && (
                  <div className="form-row">
                    <div className="form-group">
                      <label htmlFor="git-provider-select">Git Provider *</label>
                      <select
                        id="git-provider-select"
                        value={gitProvider}
                        onChange={(e) => {
                          setGitProvider(e.target.value);
                          if (createError) {
                            setCreateError('');
                          }
                        }}
                        className="form-select"
                        disabled={createLoading}
                      >
                        <option value="github">GitHub</option>
                        <option value="gitlab">GitLab</option>
                      </select>
                    </div>

                    <div className="form-group">
                      <label htmlFor="git-token-input">Personal Access Token *</label>
                      <input
                        id="git-token-input"
                        type="password"
                        placeholder="Enter PAT"
                        value={gitToken}
                        onChange={(e) => {
                          setGitToken(e.target.value);
                          if (createError) {
                            setCreateError('');
                          }
                        }}
                        className="form-input"
                        disabled={createLoading}
                        autoComplete="off"
                      />
                    </div>
                  </div>
                )}

                {projectSource === 'new' && (gitWorkflowMode === 'global' || gitWorkflowMode === 'custom') && gitCloudMode === 'connect' && (
                  <div className="form-row">
                    <div className="form-group" style={{ width: '100%' }}>
                      <label htmlFor="git-remote-url-input">Repository URL *</label>
                      <input
                        id="git-remote-url-input"
                        type="text"
                        placeholder="https://github.com/org/repo.git"
                        value={gitRemoteUrl}
                        onChange={(e) => {
                          setGitRemoteUrl(e.target.value);
                          if (createError) {
                            setCreateError('');
                          }
                        }}
                        className="form-input"
                        disabled={createLoading}
                      />
                    </div>
                  </div>
                )}

                {(projectSource === 'new' && (gitWorkflowMode === 'global' || gitWorkflowMode === 'custom') && gitCloudMode === 'create')
                  || (projectSource === 'git' && cloneCreateRemote) ? (
                  <div className="form-row">
                    <div className="form-group">
                      <label htmlFor="git-repo-name">Repository Name</label>
                      <input
                        id="git-repo-name"
                        type="text"
                        placeholder={newProject.name.trim() ? `Default: ${newProject.name.trim()}` : 'Repository name'}
                        value={gitRepoName}
                        onChange={(e) => {
                          setGitRepoName(e.target.value);
                          if (createError) {
                            setCreateError('');
                          }
                        }}
                        className="form-input"
                        disabled={createLoading}
                      />
                    </div>

                    <div className="form-group">
                      <label htmlFor="git-repo-owner">Owner / Org</label>
                      <input
                        id="git-repo-owner"
                        type="text"
                        placeholder="Optional"
                        value={gitRepoOwner}
                        onChange={(e) => {
                          setGitRepoOwner(e.target.value);
                          if (createError) {
                            setCreateError('');
                          }
                        }}
                        className="form-input"
                        disabled={createLoading}
                      />
                    </div>

                    <div className="form-group">
                      <label htmlFor="git-repo-visibility">Visibility</label>
                      <select
                        id="git-repo-visibility"
                        value={gitRepoVisibility}
                        onChange={(e) => setGitRepoVisibility(e.target.value)}
                        className="form-select"
                        disabled={createLoading}
                      >
                        <option value="private">Private</option>
                        <option value="public">Public</option>
                      </select>
                    </div>
                  </div>
                ) : null}

                {projectSource === 'new' && shouldShowGitSummary && gitSummaryItems.length > 0 && (
                  <div className="git-summary-card">
                    <h4>Derived from repo</h4>
                    {gitSummaryItems.map((item) => (
                      <div className="git-summary-row" key={item.label}>
                        <span className="git-summary-label">{item.label}</span>
                        <span className="git-summary-value">{item.value}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {setupStep === 'compatibility' && projectSource === 'local' && (
              <div className="form-section">
                <h3>Compatibility updates</h3>
                <p>
                  LucidCoder can update the imported project so the dev server binds to 0.0.0.0 and
                  works over the network.
                </p>
                <div className="tech-detect-status">
                  {compatibilityStatus.isLoading && <span>Scanning for required changes…</span>}
                  {!compatibilityStatus.isLoading && compatibilityStatus.error && (
                    <span>{compatibilityStatus.error}</span>
                  )}
                  {!compatibilityStatus.isLoading && !compatibilityStatus.error && compatibilityPlan && (
                    compatibilityChanges.length > 0 ? (
                      <ul>
                        {compatibilityChanges.map((change, index) => (
                          <li key={`${change.key || 'change'}-${index}`}>{change.description}</li>
                        ))}
                      </ul>
                    ) : (
                      <span>No compatibility changes required.</span>
                    )
                  )}
                  {!compatibilityStatus.isLoading && !compatibilityStatus.error && compatibilityPlan?.structure?.needsMove && (
                    <p>Frontend files will be moved into a frontend/ folder.</p>
                  )}
                </div>
                <div className="radio-group">
                  <label className={`radio-card ${compatibilityConsent ? 'selected' : ''}`}>
                    <input
                      type="checkbox"
                      checked={compatibilityConsent}
                      onChange={(event) => setCompatibilityConsent(event.target.checked)}
                      disabled={compatibilityStatus.isLoading}
                    />
                    <div>
                      <div className="radio-title">Allow compatibility updates</div>
                      <div className="radio-subtitle">
                        LucidCoder may edit project files to make the dev server accessible on your network.
                      </div>
                    </div>
                  </label>
                  <label className={`radio-card ${structureConsent ? 'selected' : ''}`}>
                    <input
                      type="checkbox"
                      checked={structureConsent}
                      onChange={(event) => setStructureConsent(event.target.checked)}
                      disabled={compatibilityStatus.isLoading}
                    />
                    <div>
                      <div className="radio-title">Move frontend files into a frontend folder</div>
                      <div className="radio-subtitle">
                        If the project is frontend-only, LucidCoder can move root files into frontend/.
                      </div>
                    </div>
                  </label>
                </div>
              </div>
            )}

            {createError && (
              <div className="error-message">
                {createError}
              </div>
            )}

            <div className="form-actions">
              <button
                type="button"
                onClick={handleCancel}
                className="git-settings-button secondary"
                disabled={createLoading}
              >
                Cancel
              </button>

              {setupStep !== 'source' && (
                <button
                  type="button"
                  onClick={handleBackToDetails}
                  className="git-settings-button secondary"
                  disabled={createLoading}
                >
                  Back
                </button>
              )}
              
              <button
                type="submit"
                className="git-settings-button primary"
                disabled={createLoading}
              >
                {setupStep === 'source'
                  ? 'Next'
                  : (setupStep === 'git'
                    ? (projectSource === 'local'
                      ? 'Next'
                      : (projectSource === 'git'
                        ? 'Next'
                        : 'Next'))
                  : (setupStep === 'compatibility' && projectSource === 'local')
                    ? (createLoading ? 'Importing Project...' : 'Import Project')
                  : (createLoading ? 'Creating Project...' : 'Create Project'))}
              </button>
            </div>
          </form>
        </div>
      </div>
      <FolderPickerModal
        isOpen={isFolderPickerOpen}
        initialPath={localPath}
        onSelect={handleFolderPicked}
        onClose={() => setFolderPickerOpen(false)}
      />
    </div>
  );
};

export default CreateProject;