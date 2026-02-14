import React, { useEffect, useRef, useState } from 'react';
import { useAppState } from '../context/AppStateContext';
import axios from 'axios';
import { io } from 'socket.io-client';
import FolderPickerModal from './FolderPickerModal';
import {
  guessProjectName,
  buildProgressSteps,
  normalizeServerProgress,
  isEmptyProgressSnapshot,
  generateProgressKey,
  POLL_SUPPRESSION_WINDOW_MS
} from './create-project/progressUtils';
import {
  FRONTEND_LANGUAGES,
  BACKEND_LANGUAGES,
  deriveRepoName,
  resolveFrontendFrameworkOptions,
  resolveBackendFrameworkOptions,
  applyDetectedTechToProject,
  buildGitSummaryItems
} from './create-project/formUtils';
import {
  buildBaseProjectData,
  resolveNormalizedGitConfig,
  attachGitConnectionDetails,
  buildConnectExistingProjectGitDetails
} from './create-project/payloadUtils';
import GitSetupSection from './create-project/GitSetupSection';
import ProjectSourceSection from './create-project/ProjectSourceSection';
import CompatibilitySection from './create-project/CompatibilitySection';
import CreateProjectFormActions from './create-project/CreateProjectFormActions';
import { createProgressController } from './create-project/progressController';
import { createPostCloneSetupHandlers } from './create-project/postCloneSetup';
import ProjectDetailsSection from './create-project/ProjectDetailsSection';
import { useGitTechDetection } from './create-project/useGitTechDetection';
import { useSetupJobsPolling } from './create-project/useSetupJobsPolling';
import CreateProjectProgressPanel from './create-project/CreateProjectProgressPanel';
import CreateProjectHeader from './create-project/CreateProjectHeader';
import './CreateProject.css';

export const BACKEND_UNAVAILABLE_MESSAGE = 'Unable to reach the backend server. Please make sure it is running and try again.';

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

  const frontendLanguages = FRONTEND_LANGUAGES;
  const backendLanguages = BACKEND_LANGUAGES;

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

  const {
    closeProgressStream,
    applyProgressPayload,
    startProgressStream
  } = createProgressController({
    axios,
    io,
    normalizeServerProgress,
    POLL_SUPPRESSION_WINDOW_MS,
    progressStreamRef,
    progressSocketRef,
    progressPollRef,
    progressPollTimeoutRef,
    pollSuppressedRef,
    pollSuppressionTimeoutRef,
    lastProgressUpdateAtRef,
    setProgress,
    setCreateError,
    setCreateLoading,
    setProcesses,
    setProgressKey
  });

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
        const { normalizedProvider, defaultBranch, username } = resolveNormalizedGitConfig({
          mode: connectionMode,
          gitProvider,
          gitSettings
        });

        let projectData = {
          ...buildBaseProjectData({
            name: effectiveName,
            description: newProject.description,
            frontend: newProject.frontend,
            backend: newProject.backend
          }),
          importMethod: 'git',
          gitUrl: gitRemoteUrl.trim(),
          gitProvider: normalizedProvider,
          gitDefaultBranch: defaultBranch,
          gitConnectionMode: connectionMode
        };

        projectData = attachGitConnectionDetails(projectData, {
          mode: connectionMode,
          normalizedProvider,
          remoteUrl: gitRemoteUrl,
          token: gitToken
        });

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

        const connectionMode = gitConnectionMode || 'local';
        const { normalizedProvider } = resolveNormalizedGitConfig({
          mode: connectionMode,
          gitProvider,
          gitSettings
        });

        let projectData = {
          ...buildBaseProjectData({
            name: effectiveName,
            description: newProject.description,
            frontend: newProject.frontend,
            backend: newProject.backend
          }),
          importMethod: 'local',
          importMode: localImportMode,
          localPath: localPath.trim(),
          applyCompatibility: compatibilityRequired && compatibilityConsent,
          applyStructureFix: structureRequired && structureConsent,
          gitConnectionMode: connectionMode
        };

        projectData = attachGitConnectionDetails(projectData, {
          mode: connectionMode,
          normalizedProvider,
          remoteUrl: gitConnectionRemoteUrl,
          token: gitToken
        });

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

      const { normalizedProvider, defaultBranch, username } = resolveNormalizedGitConfig({
        mode: gitWorkflowMode,
        gitProvider,
        gitSettings
      });
      const derivedName = isCloudWorkflow
        ? (gitCloudMode === 'create' ? gitRepoName.trim() : deriveRepoName(gitRemoteUrl))
        : '';
      const nameForProject = derivedName || newProject.name.trim();

      const postBody = {
        ...buildBaseProjectData({
          name: nameForProject,
          description: newProject.description,
          frontend: newProject.frontend,
          backend: newProject.backend
        }),
        progressKey: newProgressKey
      };

      // When connecting to an existing repo, include git params so the backend
      // clones instead of scaffolding a new project from scratch.
      if (isConnectExisting) {
        Object.assign(postBody, buildConnectExistingProjectGitDetails({
          normalizedProvider,
          defaultBranch,
          username,
          remoteUrl: gitRemoteUrl,
          mode: gitWorkflowMode,
          token: gitToken
        }));
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
            description: postBody.description
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
    setNewProject((prev) => applyDetectedTechToProject(prev, detected));
  };

  useGitTechDetection({
    setupStep,
    projectSource,
    gitRemoteUrl,
    gitConnectionMode,
    gitProvider,
    gitSettingsProvider: gitSettings?.provider,
    gitToken,
    gitTechKeyRef,
    setGitTechStatus,
    axios,
    onDetected: applyDetectedTech
  });

  const {
    runPostCloneSetup,
    handleApplyGitIgnore: applyGitIgnore,
    handleSkipGitIgnore: skipGitIgnore,
    handleContinueAfterGitIgnore
  } = createPostCloneSetupHandlers({
    axios,
    setGitIgnoreStatus,
    setProgress,
    setProcesses,
    setGitIgnoreSuggestion,
    showMain
  });

  const handleApplyGitIgnore = async () => {
    await applyGitIgnore(gitIgnoreSuggestion);
  };

  const handleSkipGitIgnore = async () => {
    await skipGitIgnore(gitIgnoreSuggestion);
  };

  useSetupJobsPolling({ setupState, setSetupState, showMain });

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
    return resolveFrontendFrameworkOptions(newProject.frontend.language);
  };

  const getBackendFrameworks = () => {
    return resolveBackendFrameworkOptions(newProject.backend.language);
  };

  const handleFrontendLanguageChange = (e) => {
    setNewProject((prev) => ({
      ...prev,
      frontend: {
        language: e.target.value,
        framework: resolveFrontendFrameworkOptions(e.target.value)[0]
      }
    }));
  };

  const handleFrontendFrameworkChange = (e) => {
    setNewProject((prev) => ({
      ...prev,
      frontend: { ...prev.frontend, framework: e.target.value }
    }));
  };

  const handleBackendLanguageChange = (e) => {
    setNewProject((prev) => ({
      ...prev,
      backend: {
        language: e.target.value,
        framework: resolveBackendFrameworkOptions(e.target.value)[0]
      }
    }));
  };

  const handleBackendFrameworkChange = (e) => {
    setNewProject((prev) => ({
      ...prev,
      backend: { ...prev.backend, framework: e.target.value }
    }));
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
  const gitSummaryItems = buildGitSummaryItems({
    gitWorkflowMode,
    gitCloudMode,
    gitRepoName,
    gitRemoteUrl,
    gitProvider,
    globalProvider: gitSettings?.provider
  });
  const shouldShowGitSummary = gitSummaryItems.length > 0;

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
        <CreateProjectProgressPanel
          progress={progress}
          processes={processes}
          gitIgnoreSuggestion={gitIgnoreSuggestion}
          gitIgnoreStatus={gitIgnoreStatus}
          onApplyGitIgnore={handleApplyGitIgnore}
          onSkipGitIgnore={handleSkipGitIgnore}
          onContinueAfterGitIgnore={handleContinueAfterGitIgnore}
        />
        
        <CreateProjectHeader
          isProgressBlocking={isProgressBlocking}
          onCancel={handleCancel}
        />

        <div className="create-project-form" style={{ display: isProgressBlocking ? 'none' : 'block' }}>
          <form onSubmit={handleCreateProject} role="form">
            {setupStep === 'source' && (
              <ProjectSourceSection
                projectSource={projectSource}
                setProjectSource={setProjectSource}
                setCreateError={setCreateError}
                createLoading={createLoading}
              />
            )}

            {setupStep === 'details' && (
              <ProjectDetailsSection
                createLoading={createLoading}
                projectSource={projectSource}
                newProject={newProject}
                setNewProject={setNewProject}
                createError={createError}
                setCreateError={setCreateError}
                frontendLanguages={frontendLanguages}
                backendLanguages={backendLanguages}
                getFrontendFrameworks={getFrontendFrameworks}
                getBackendFrameworks={getBackendFrameworks}
                onFrontendLanguageChange={handleFrontendLanguageChange}
                onFrontendFrameworkChange={handleFrontendFrameworkChange}
                onBackendLanguageChange={handleBackendLanguageChange}
                onBackendFrameworkChange={handleBackendFrameworkChange}
              />
            )}

            {setupStep === 'git' && (
              <GitSetupSection
                projectSource={projectSource}
                createLoading={createLoading}
                localPath={localPath}
                setLocalPath={setLocalPath}
                createError={createError}
                setCreateError={setCreateError}
                handleFolderSelect={handleFolderSelect}
                localImportMode={localImportMode}
                setLocalImportMode={setLocalImportMode}
                gitConnectionMode={gitConnectionMode}
                setGitConnectionMode={setGitConnectionMode}
                gitConnectionRemoteUrl={gitConnectionRemoteUrl}
                setGitConnectionRemoteUrl={setGitConnectionRemoteUrl}
                gitRemoteUrl={gitRemoteUrl}
                setGitRemoteUrl={setGitRemoteUrl}
                cloneCreateRemote={cloneCreateRemote}
                setCloneCreateRemote={setCloneCreateRemote}
                gitWorkflowMode={gitWorkflowMode}
                setGitWorkflowMode={setGitWorkflowMode}
                setGitCloudMode={setGitCloudMode}
                gitProvider={gitProvider}
                setGitProvider={setGitProvider}
                gitToken={gitToken}
                setGitToken={setGitToken}
                gitCloudMode={gitCloudMode}
                gitRepoName={gitRepoName}
                setGitRepoName={setGitRepoName}
                newProjectName={newProject.name}
                gitRepoOwner={gitRepoOwner}
                setGitRepoOwner={setGitRepoOwner}
                gitRepoVisibility={gitRepoVisibility}
                setGitRepoVisibility={setGitRepoVisibility}
                shouldShowGitSummary={shouldShowGitSummary}
                gitSummaryItems={gitSummaryItems}
              />
            )}

            {setupStep === 'compatibility' && projectSource === 'local' && (
              <CompatibilitySection
                compatibilityStatus={compatibilityStatus}
                compatibilityPlan={compatibilityPlan}
                compatibilityChanges={compatibilityChanges}
                compatibilityConsent={compatibilityConsent}
                setCompatibilityConsent={setCompatibilityConsent}
                structureConsent={structureConsent}
                setStructureConsent={setStructureConsent}
              />
            )}

            {createError && (
              <div className="error-message">
                {createError}
              </div>
            )}

            <CreateProjectFormActions
              setupStep={setupStep}
              projectSource={projectSource}
              createLoading={createLoading}
              handleCancel={handleCancel}
              handleBackToDetails={handleBackToDetails}
            />
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