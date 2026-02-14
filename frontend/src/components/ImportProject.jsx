import React, { useEffect, useRef, useState } from 'react';
import { useAppState } from '../context/AppStateContext';
import FolderPickerModal from './FolderPickerModal';
import {
  FRONTEND_LANGUAGES,
  BACKEND_LANGUAGES,
  resolveFrontendFrameworks,
  resolveBackendFrameworks,
  guessProjectName,
  sanitizeImportTab
} from './importProject/utils.js';
import './ImportProject.css';

export { resolveFrontendFrameworks, resolveBackendFrameworks, guessProjectName };

const ImportProject = ({ initialImportMethod = 'local', __testHooks } = {}) => {
  const { importProject, showMain, gitSettings, gitConnectionStatus } = useAppState();
  const totalSteps = 6;
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState('');
  const [activeTab, setActiveTab] = useState(sanitizeImportTab(initialImportMethod));
  const [currentStep, setCurrentStep] = useState(0);
  const [localImportMode, setLocalImportMode] = useState('copy');
  const [gitProvider, setGitProvider] = useState('github');
  const [gitAuthMethod, setGitAuthMethod] = useState('pat');
  const [gitConnectionMode, setGitConnectionMode] = useState('local');
  const [gitConnectionProvider, setGitConnectionProvider] = useState('github');
  const [gitConnectionRemoteUrl, setGitConnectionRemoteUrl] = useState('');
  const [gitConnectionDefaultBranch, setGitConnectionDefaultBranch] = useState('main');
  const [isFolderPickerOpen, setFolderPickerOpen] = useState(false);
  const [techDetectStatus, setTechDetectStatus] = useState({
    isLoading: false,
    error: ''
  });
  const [compatibilityStatus, setCompatibilityStatus] = useState({
    isLoading: false,
    error: ''
  });
  const [compatibilityPlan, setCompatibilityPlan] = useState(null);
  const [compatibilityConsent, setCompatibilityConsent] = useState(false);
  const [structureConsent, setStructureConsent] = useState(false);
  const [setupState, setSetupState] = useState({
    isWaiting: false,
    projectId: null,
    jobs: [],
    error: ''
  });
  const [hasDetectedTech, setHasDetectedTech] = useState(false);
  const [frontendTouched, setFrontendTouched] = useState(false);
  const [backendTouched, setBackendTouched] = useState(false);
  const [nameTouched, setNameTouched] = useState(false);
  const importAttemptIdRef = useRef(0);
  const techDetectPathRef = useRef('');
  const compatibilityPathRef = useRef('');
  const gitRemoteTouchedRef = useRef(false);
  
  // Import form state
  const [importData, setImportData] = useState({
    name: '',
    description: '',
    path: '',
    gitUrl: '',
    gitUsername: '',
    gitToken: '',
    frontend: {
      language: 'javascript',
      framework: 'react'
    },
    backend: {
      language: 'javascript',
      framework: 'express'
    }
  });

  const frontendLanguages = FRONTEND_LANGUAGES;
  const backendLanguages = BACKEND_LANGUAGES;
  const globalProvider = gitSettings?.provider || gitConnectionStatus?.provider || 'github';
  const globalDefaultBranch = gitSettings?.defaultBranch || 'main';
  const isGlobalConfigured = Boolean(gitSettings?.tokenPresent) || Boolean(gitConnectionStatus?.provider);

  useEffect(() => {
    if (gitConnectionMode === 'global') {
      setGitConnectionProvider(globalProvider);
    }
    if (!gitConnectionDefaultBranch && globalDefaultBranch) {
      setGitConnectionDefaultBranch(globalDefaultBranch);
    }
  }, [gitConnectionDefaultBranch, gitConnectionMode, globalDefaultBranch, globalProvider]);

  useEffect(() => {
    if (nameTouched) {
      return;
    }
    if (activeTab === 'local' && importData.path.trim()) {
      const suggested = guessProjectName(importData.path);
      if (suggested && suggested !== importData.name) {
        setImportData((prev) => ({ ...prev, name: suggested }));
      } else if (!suggested && importData.name) {
        setImportData((prev) => ({ ...prev, name: '' }));
      }
    }
  }, [activeTab, importData.name, importData.path, nameTouched]);

  useEffect(() => {
    if (nameTouched) {
      return;
    }
    if (activeTab === 'git' && importData.gitUrl.trim()) {
      const suggested = guessProjectName(importData.gitUrl);
      if (suggested && suggested !== importData.name) {
        setImportData((prev) => ({ ...prev, name: suggested }));
      } else if (!suggested && importData.name) {
        setImportData((prev) => ({ ...prev, name: '' }));
      }
    }
  }, [activeTab, importData.gitUrl, importData.name, nameTouched]);

  useEffect(() => {
    if (importError) {
      setImportError('');
    }
  }, [activeTab, currentStep]);

  useEffect(() => {
    if (activeTab !== 'git') {
      return;
    }
    gitRemoteTouchedRef.current = false;
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'git') {
      return;
    }
    const trimmedGitUrl = importData.gitUrl.trim();
    if (!trimmedGitUrl || gitRemoteTouchedRef.current) {
      return;
    }
    setGitConnectionRemoteUrl(trimmedGitUrl);
  }, [activeTab, importData.gitUrl]);

  useEffect(() => {
    if (currentStep !== 3) {
      return;
    }
    if (activeTab !== 'local') {
      return;
    }
    const pathValue = importData.path.trim();
    if (!pathValue) {
      return;
    }
    if (techDetectPathRef.current === pathValue) {
      return;
    }

    techDetectPathRef.current = pathValue;
    setTechDetectStatus({ isLoading: true, error: '' });

    fetch(`/api/fs/detect-tech?path=${encodeURIComponent(pathValue)}`)
      .then((response) => response.json().then((data) => ({ response, data })))
      .then(({ response, data }) => {
        if (!response.ok || !data?.success) {
          throw new Error(data?.error || 'Failed to detect tech stack');
        }

        setHasDetectedTech(true);
        const detectedFrontendLanguage = data.frontend?.language;
        const detectedFrontendFramework = data.frontend?.framework;
        const detectedBackendLanguage = data.backend?.language;
        const detectedBackendFramework = data.backend?.framework;
        setImportData((prev) => ({
          ...prev,
          frontend: frontendTouched ? prev.frontend : {
            language: detectedFrontendLanguage ? detectedFrontendLanguage : prev.frontend.language,
            framework: detectedFrontendFramework ? detectedFrontendFramework : prev.frontend.framework
          },
          backend: backendTouched ? prev.backend : {
            language: detectedBackendLanguage ? detectedBackendLanguage : prev.backend.language,
            framework: detectedBackendFramework ? detectedBackendFramework : prev.backend.framework
          }
        }));
        setTechDetectStatus({ isLoading: false, error: '' });
      })
      .catch((error) => {
        setTechDetectStatus({ isLoading: false, error: error?.message || 'Failed to detect tech stack' });
      });
  }, [activeTab, backendTouched, currentStep, frontendTouched, importData.path]);

  useEffect(() => {
    if (currentStep !== 4) {
      return;
    }

    if (activeTab !== 'local') {
      setCompatibilityPlan(null);
      setCompatibilityStatus({ isLoading: false, error: '' });
      setCompatibilityConsent(false);
      return;
    }

    const pathValue = importData.path.trim();
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
  }, [activeTab, currentStep, importData.path]);

  const handleImportProject = async () => {
    if (currentStep < 5) {
      return;
    }

    const compatibilityRequired = activeTab === 'git' || Boolean(compatibilityPlan?.needsChanges);
    if (compatibilityRequired && !compatibilityConsent) {
      setImportError('Please allow compatibility updates to continue');
      return;
    }

    if (structureRequired && !structureConsent) {
      setImportError('Please allow moving frontend files into a frontend folder');
      return;
    }
    
    if (!importData.name.trim()) {
      setImportError('Project name is required');
      return;
    }

    if (activeTab === 'local' && !importData.path.trim()) {
      setImportError('Project path is required');
      return;
    }

    if (activeTab === 'git' && !importData.gitUrl.trim()) {
      setImportError('Git repository URL is required');
      return;
    }

    const attemptId = importAttemptIdRef.current + 1;
    importAttemptIdRef.current = attemptId;

    try {
      setImportLoading(true);
      setImportError('');
      const trimmedName = importData.name.trim();
      const trimmedDescription = importData.description.trim();
      const trimmedPath = importData.path.trim();
      const trimmedGitUrl = importData.gitUrl.trim();
      const trimmedGitUsername = importData.gitUsername.trim();
      const trimmedGitToken = importData.gitToken.trim();
      const trimmedGitRemoteUrl = gitConnectionRemoteUrl.trim();
      const trimmedGitDefaultBranch = gitConnectionDefaultBranch.trim() || globalDefaultBranch;
      const requestedConnectionMode = gitConnectionMode === 'global' && !isGlobalConfigured
        ? 'local'
        : gitConnectionMode;
      const effectiveConnectionMode = (requestedConnectionMode !== 'local' && !trimmedGitRemoteUrl)
        ? 'local'
        : requestedConnectionMode;
      const effectiveRemoteUrl = effectiveConnectionMode === 'local' ? '' : trimmedGitRemoteUrl;
      const effectiveConnectionProvider = effectiveConnectionMode === 'global'
        ? globalProvider
        : gitConnectionProvider;
      
      const projectData = {
        name: trimmedName,
        description: trimmedDescription,
        frontend: {
          language: importData.frontend.language,
          framework: importData.frontend.framework
        },
        backend: {
          language: importData.backend.language,
          framework: importData.backend.framework
        },
        importMethod: activeTab,
        importMode: localImportMode,
        localPath: trimmedPath,
        gitUrl: trimmedGitUrl,
        gitProvider,
        gitAuthMethod,
        gitUsername: trimmedGitUsername,
        gitToken: trimmedGitToken,
        applyCompatibility: compatibilityRequired && compatibilityConsent,
        applyStructureFix: structureRequired && structureConsent,
        gitConnectionMode: effectiveConnectionMode,
        gitRemoteUrl: effectiveRemoteUrl,
        gitDefaultBranch: trimmedGitDefaultBranch,
        gitConnectionProvider: effectiveConnectionProvider
      };

      const result = await importProject(projectData);
      const importedProject = result?.project || null;
      const importJobs = Array.isArray(result?.jobs) ? result.jobs : [];
      if (importJobs.length > 0 && importedProject?.id) {
        setSetupState({
          isWaiting: true,
          projectId: importedProject.id,
          jobs: importJobs,
          error: ''
        });
        return;
      }
      showMain();
    } catch (err) {
      const isCurrentAttempt = importAttemptIdRef.current === attemptId;
      if (!isCurrentAttempt) {
        return;
      }
      setImportError(err.message || 'Failed to import project');
    } finally {
      const isCurrentAttempt = importAttemptIdRef.current === attemptId;
      if (isCurrentAttempt) {
        setImportLoading(false);
      }
    }
  };

  useEffect(() => {
    if (typeof __testHooks !== 'function') {
      return;
    }

    __testHooks({
      setStateForTests: (next = {}) => {
        if (Object.prototype.hasOwnProperty.call(next, 'currentStep')) {
          setCurrentStep(next.currentStep);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'activeTab')) {
          setActiveTab(next.activeTab);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'importData')) {
          setImportData((prev) => ({
            ...prev,
            ...next.importData,
            frontend: {
              ...prev.frontend,
              ...(next.importData?.frontend || {})
            },
            backend: {
              ...prev.backend,
              ...(next.importData?.backend || {})
            }
          }));
        }
        if (Object.prototype.hasOwnProperty.call(next, 'compatibilityPlan')) {
          setCompatibilityPlan(next.compatibilityPlan);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'compatibilityConsent')) {
          setCompatibilityConsent(next.compatibilityConsent);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'structureConsent')) {
          setStructureConsent(next.structureConsent);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'nameTouched')) {
          setNameTouched(next.nameTouched);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'frontendTouched')) {
          setFrontendTouched(next.frontendTouched);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'backendTouched')) {
          setBackendTouched(next.backendTouched);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'importError')) {
          setImportError(next.importError || '');
        }
        if (Object.prototype.hasOwnProperty.call(next, 'localImportMode')) {
          setLocalImportMode(next.localImportMode);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'gitProvider')) {
          setGitProvider(next.gitProvider);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'gitAuthMethod')) {
          setGitAuthMethod(next.gitAuthMethod);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'gitConnectionMode')) {
          setGitConnectionMode(next.gitConnectionMode);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'gitConnectionProvider')) {
          setGitConnectionProvider(next.gitConnectionProvider);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'gitConnectionRemoteUrl')) {
          setGitConnectionRemoteUrl(next.gitConnectionRemoteUrl);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'gitConnectionDefaultBranch')) {
          setGitConnectionDefaultBranch(next.gitConnectionDefaultBranch);
        }
        if (Object.prototype.hasOwnProperty.call(next, 'setupState')) {
          setSetupState((prev) => ({
            ...prev,
            ...(next.setupState || {})
          }));
        }
      },
      triggerImportForTests: handleImportProject,
      setAttemptIdForTests: (value) => {
        importAttemptIdRef.current = value;
      }
    });
  }, [__testHooks, handleImportProject]);

  const handleCancel = () => {
    setImportError('');
    setCurrentStep(0);
    setActiveTab('local');
    setLocalImportMode('copy');
    setGitProvider('github');
    setGitAuthMethod('pat');
    setFolderPickerOpen(false);
    setTechDetectStatus({ isLoading: false, error: '' });
    setCompatibilityStatus({ isLoading: false, error: '' });
    setCompatibilityPlan(null);
    setCompatibilityConsent(false);
    setStructureConsent(false);
    setSetupState({
      isWaiting: false,
      projectId: null,
      jobs: [],
      error: ''
    });
    setHasDetectedTech(false);
    setFrontendTouched(false);
    setBackendTouched(false);
    setNameTouched(false);
    techDetectPathRef.current = '';
    compatibilityPathRef.current = '';
    setImportData({
      name: '',
      description: '',
      path: '',
      gitUrl: '',
        gitUsername: '',
        gitToken: '',
      frontend: {
        language: 'javascript',
        framework: 'react'
      },
      backend: {
        language: 'javascript',
        framework: 'express'
      }
    });
    showMain();
  };

  const handleFolderSelect = () => {
    setImportError('');
    setFolderPickerOpen(true);
  };

  const handleFolderPicked = (pathValue) => {
    if (pathValue) {
      setImportData((prev) => ({ ...prev, path: pathValue }));
    }
    setFolderPickerOpen(false);
  };

  const setTabAndReset = (tab) => {
    setActiveTab(tab);
    setCurrentStep(0);
    setImportError('');
  };

  const validateStep = (step) => {
    if (step === 0) {
      return true;
    }

    if (step === 1) {
      if (activeTab === 'local' && !importData.path.trim()) {
        setImportError('Project path is required');
        return false;
      }
      if (activeTab === 'git' && !importData.gitUrl.trim()) {
        setImportError('Git repository URL is required');
        return false;
      }
      return true;
    }

    if (step === 2) {
      if (!importData.name.trim()) {
        setImportError('Project name is required');
        return false;
      }
      return true;
    }

    return true;
  };

  const handleNextStep = () => {
    setImportError('');
    if (!validateStep(currentStep)) {
      return;
    }
    setCurrentStep((prev) => Math.min(prev + 1, 5));
  };

  const handlePrevStep = () => {
    setImportError('');
    setCurrentStep((prev) => Math.max(prev - 1, 0));
  };

  const getAvailableFrontendFrameworks = () => resolveFrontendFrameworks(importData.frontend.language);

  const getAvailableBackendFrameworks = () => resolveBackendFrameworks(importData.backend.language);

  const handleGitConnectionModeChange = (nextMode) => {
    setGitConnectionMode(nextMode);
    if (nextMode === 'global') {
      setGitConnectionProvider(globalProvider);
    }
  };

  const compatibilityRequired = activeTab === 'git'
    || Boolean(compatibilityStatus.error)
    || Boolean(compatibilityPlan?.needsChanges);
  const structureRequired = activeTab === 'git'
    || Boolean(compatibilityPlan?.structure?.needsMove);
  const compatibilityChanges = Array.isArray(compatibilityPlan?.changes) ? compatibilityPlan.changes : [];
  const gitRemoteRequired = gitConnectionMode !== 'local';
  const gitRemoteMissing = gitRemoteRequired && !gitConnectionRemoteUrl.trim();
  const gitStepTitle = activeTab === 'local' ? 'Configure Git' : 'Configure Git connection';
  const gitStepDescription = activeTab === 'local'
    ? 'LucidCoder will initialize Git if needed and can connect the repo to a remote.'
    : 'Decide whether to keep this clone local or connect it to a cloud workflow.';
  const gitLocalSubtitle = activeTab === 'local'
    ? 'Initialize Git locally and keep the repository on this machine.'
    : 'Keep the cloned repository local only.';
  const gitGlobalSubtitle = activeTab === 'local'
    ? 'Reuse your global GitHub/GitLab connection for this repo.'
    : 'Reuse your global GitHub/GitLab connection for this repo.';
  const gitCustomSubtitle = activeTab === 'local'
    ? 'Provide a remote URL and provider for this repo.'
    : 'Specify a different remote and provider.';
  const setupJobs = setupState.jobs || [];
  const setupProjectId = setupState.projectId;
  const setupError = setupState.error;
  const isSetupWaiting = setupState.isWaiting;
  const finalJobStates = new Set(['succeeded', 'failed', 'cancelled']);
  const areJobsFinal = setupJobs.length > 0 && setupJobs.every((job) => finalJobStates.has(job?.status));
  useEffect(() => {
    if (!isSetupWaiting || !setupProjectId) {
      return;
    }

    let isCancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`/api/projects/${setupProjectId}/jobs`);
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.success) {
          throw new Error(data?.error || 'Failed to load setup jobs');
        }
        if (isCancelled) {
          return;
        }
        const jobs = Array.isArray(data.jobs) ? data.jobs : [];
        const isComplete = jobs.length > 0 && jobs.every((job) => finalJobStates.has(job?.status));
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
  }, [finalJobStates, isSetupWaiting, setupProjectId, showMain]);

  if (isSetupWaiting) {
    return (
      <div className="import-project-view">
        <div className="import-project-container">
          <div className="import-project-header">
            <div className="import-project-header-row">
              <div>
                <h1>Preparing your project</h1>
                <p>We’re installing dependencies and getting everything ready.</p>
              </div>
              <button
                type="button"
                className="import-project-close"
                onClick={handleCancel}
                aria-label="Close import"
              >
                &times;
              </button>
            </div>
          </div>

          <div className="import-project-form">
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
            {!areJobsFinal && <div className="tech-detect-status">Waiting for setup to finish…</div>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="import-project-view">
      <div className="import-project-container">
        <div className="import-project-header">
          <div className="import-project-header-row">
            <div>
              <h1>Import Existing Project</h1>
              <p>Import an existing project from your local machine or a Git repository.</p>
            </div>
            <button
              type="button"
              className="import-project-close"
              onClick={handleCancel}
              aria-label="Close import"
            >
              &times;
            </button>
          </div>
        </div>

        <div className="import-project-form">
          <form onSubmit={(event) => event.preventDefault()} role="form">
            <div className="form-section">
              <h3>Step {currentStep + 1} of {totalSteps}</h3>
              {currentStep === 0 && (
                <>
                  <h4 className="step-title">Choose an import source</h4>
                  <div className="import-tabs" role="tablist">
                    <button
                      type="button"
                      className={`import-tab ${activeTab === 'local' ? 'active' : ''}`}
                      onClick={() => setTabAndReset('local')}
                      role="tab"
                      aria-selected={activeTab === 'local'}
                    >
                      Local Folder
                    </button>
                    <button
                      type="button"
                      className={`import-tab ${activeTab === 'git' ? 'active' : ''}`}
                      onClick={() => setTabAndReset('git')}
                      role="tab"
                      aria-selected={activeTab === 'git'}
                    >
                      GitHub / GitLab
                    </button>
                  </div>
                </>
              )}

              {currentStep === 1 && (
                <>
                  <h4 className="step-title">Provide your project source</h4>
                  {activeTab === 'local' && (
                    <div className="form-group">
                      <label htmlFor="project-path">Project Folder Path *</label>
                      <div className="path-input-group">
                        <input
                          id="project-path"
                          type="text"
                          placeholder="Enter the path to your project folder"
                          value={importData.path}
                          onChange={(e) => setImportData(prev => ({ ...prev, path: e.target.value }))}
                          className="form-input"
                          disabled={importLoading}
                        />
                        <button
                          type="button"
                          onClick={handleFolderSelect}
                          className="browse-btn"
                          disabled={importLoading}
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
                            disabled={importLoading}
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
                            disabled={importLoading}
                          />
                          <div>
                            <div className="radio-title">Link to existing folder</div>
                            <div className="radio-subtitle">Keep the project in place (must be inside the managed folder).</div>
                          </div>
                        </label>
                      </div>
                    </div>
                  )}

                  {activeTab === 'git' && (
                    <>
                      <div className="form-group">
                        <label htmlFor="git-provider">Git Provider</label>
                        <select
                          id="git-provider"
                          value={gitProvider}
                          onChange={(e) => setGitProvider(e.target.value)}
                          className="form-select"
                          disabled={importLoading}
                        >
                          <option value="github">GitHub</option>
                          <option value="gitlab">GitLab</option>
                        </select>
                      </div>
                      <div className="form-group">
                        <label htmlFor="git-url">Git Repository URL *</label>
                        <input
                          id="git-url"
                          type="url"
                          placeholder="https://github.com/username/repository.git"
                          value={importData.gitUrl}
                          onChange={(e) => setImportData(prev => ({ ...prev, gitUrl: e.target.value }))}
                          className="form-input"
                          disabled={importLoading}
                        />
                      </div>
                      <div className="form-group">
                        <label>Authentication</label>
                        <div className="radio-group">
                          <label className={`radio-card ${gitAuthMethod === 'pat' ? 'selected' : ''}`}>
                            <input
                              type="radio"
                              name="gitAuthMethod"
                              value="pat"
                              checked={gitAuthMethod === 'pat'}
                              onChange={() => setGitAuthMethod('pat')}
                              disabled={importLoading}
                            />
                            <div>
                              <div className="radio-title">PAT (HTTPS)</div>
                              <div className="radio-subtitle">Use a personal access token for private repos.</div>
                            </div>
                          </label>
                          <label className={`radio-card ${gitAuthMethod === 'ssh' ? 'selected' : ''}`}>
                            <input
                              type="radio"
                              name="gitAuthMethod"
                              value="ssh"
                              checked={gitAuthMethod === 'ssh'}
                              onChange={() => setGitAuthMethod('ssh')}
                              disabled={importLoading}
                            />
                            <div>
                              <div className="radio-title">SSH</div>
                              <div className="radio-subtitle">Use your configured SSH keys.</div>
                            </div>
                          </label>
                        </div>
                      </div>
                      {gitAuthMethod === 'pat' && (
                        <div className="form-row">
                          <div className="form-group">
                            <label htmlFor="git-username">Username (optional)</label>
                            <input
                              id="git-username"
                              type="text"
                              placeholder="Your Git username"
                              value={importData.gitUsername}
                              onChange={(e) => setImportData(prev => ({ ...prev, gitUsername: e.target.value }))}
                              className="form-input"
                              disabled={importLoading}
                            />
                          </div>
                          <div className="form-group">
                            <label htmlFor="git-token">Personal Access Token</label>
                            <input
                              id="git-token"
                              type="password"
                              placeholder="Paste your token"
                              value={importData.gitToken}
                              onChange={(e) => setImportData(prev => ({ ...prev, gitToken: e.target.value }))}
                              className="form-input"
                              disabled={importLoading}
                            />
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}

              {currentStep === 2 && (
                <>
                  <h4 className="step-title">Describe your project</h4>
                  <div className="form-row">
                    <div className="form-group">
                      <label htmlFor="project-name">Project Name *</label>
                      <input
                        id="project-name"
                        type="text"
                        placeholder="Enter project name"
                        value={importData.name}
                        onChange={(e) => {
                          setNameTouched(true);
                          setImportData(prev => ({ ...prev, name: e.target.value }));
                        }}
                        className="form-input"
                        disabled={importLoading}
                      />
                    </div>
                    
                    <div className="form-group">
                      <label htmlFor="project-description">Description</label>
                      <input
                        id="project-description"
                        type="text"
                        placeholder="Brief description of your project"
                        value={importData.description}
                        onChange={(e) => setImportData(prev => ({ ...prev, description: e.target.value }))}
                        className="form-input"
                        disabled={importLoading}
                      />
                    </div>
                  </div>
                </>
              )}

              {currentStep === 3 && (
                <>
                  <h4 className="step-title">Choose your tech stack</h4>
                  <div className="form-section">
                    <h3>Frontend Technology</h3>
                    <div className="form-row">
                      <div className="form-group">
                        <label htmlFor="frontend-language-select">Frontend Language *</label>
                        <select
                          id="frontend-language-select"
                          value={importData.frontend.language}
                          onChange={(e) => {
                            setFrontendTouched(true);
                            setImportData(prev => ({ 
                              ...prev, 
                              frontend: {
                                ...prev.frontend,
                                language: e.target.value,
                                framework: resolveFrontendFrameworks(e.target.value)[0]
                              }
                            }));
                          }}
                          className="form-select"
                          disabled={importLoading}
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
                          value={importData.frontend.framework}
                          onChange={(e) => {
                            setFrontendTouched(true);
                            setImportData(prev => ({ 
                              ...prev, 
                              frontend: { ...prev.frontend, framework: e.target.value }
                            }));
                          }}
                          className="form-select"
                          disabled={importLoading}
                        >
                          {getAvailableFrontendFrameworks().map(framework => (
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
                          value={importData.backend.language}
                          onChange={(e) => {
                            setBackendTouched(true);
                            setImportData(prev => ({ 
                              ...prev, 
                              backend: {
                                ...prev.backend,
                                language: e.target.value,
                                framework: resolveBackendFrameworks(e.target.value)[0]
                              }
                            }));
                          }}
                          className="form-select"
                          disabled={importLoading}
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
                          value={importData.backend.framework}
                          onChange={(e) => {
                            setBackendTouched(true);
                            setImportData(prev => ({ 
                              ...prev, 
                              backend: { ...prev.backend, framework: e.target.value }
                            }));
                          }}
                          className="form-select"
                          disabled={importLoading}
                        >
                          {getAvailableBackendFrameworks().map(framework => (
                            <option key={framework} value={framework}>
                              {framework.charAt(0).toUpperCase() + framework.slice(1)}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>
                  {activeTab === 'local' && (
                    <div className="tech-detect-status">
                      {techDetectStatus.isLoading && <span>Detecting tech stack…</span>}
                      {!techDetectStatus.isLoading && techDetectStatus.error && <span>{techDetectStatus.error}</span>}
                      {!techDetectStatus.isLoading && !techDetectStatus.error && hasDetectedTech && <span>Tech stack detected.</span>}
                    </div>
                  )}
                </>
              )}

              {currentStep === 4 && (
                <>
                  <h4 className="step-title">Compatibility updates</h4>
                  <p>
                    LucidCoder can update the imported project so the dev server binds to 0.0.0.0 and
                    works over the network.
                  </p>

                  {activeTab === 'local' && (
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
                  )}

                  {activeTab === 'git' && (
                    <div className="tech-detect-status">
                      We’ll scan the cloned project and apply required updates automatically if you approve.
                    </div>
                  )}

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

                </>
              )}

              {currentStep === 5 && (
                <>
                  <h4 className="step-title">{gitStepTitle}</h4>
                  <p>{gitStepDescription}</p>

                  <div className="form-section">
                    <h3>Git connection</h3>
                    <div className="radio-group">
                      <label className={`radio-card ${gitConnectionMode === 'local' ? 'selected' : ''}`}>
                        <input
                          type="radio"
                          name="gitConnectionMode"
                          value="local"
                          checked={gitConnectionMode === 'local'}
                          onChange={() => handleGitConnectionModeChange('local')}
                          disabled={importLoading}
                        />
                        <div>
                          <div className="radio-title">Local only</div>
                          <div className="radio-subtitle">{gitLocalSubtitle}</div>
                        </div>
                      </label>
                      <label className={`radio-card ${gitConnectionMode === 'global' ? 'selected' : ''}`}>
                        <input
                          type="radio"
                          name="gitConnectionMode"
                          value="global"
                          checked={gitConnectionMode === 'global'}
                          onChange={() => handleGitConnectionModeChange('global')}
                          disabled={importLoading}
                        />
                        <div>
                          <div className="radio-title">Use global connection</div>
                          <div className="radio-subtitle">{gitGlobalSubtitle}</div>
                        </div>
                      </label>
                      <label className={`radio-card ${gitConnectionMode === 'custom' ? 'selected' : ''}`}>
                        <input
                          type="radio"
                          name="gitConnectionMode"
                          value="custom"
                          checked={gitConnectionMode === 'custom'}
                          onChange={() => handleGitConnectionModeChange('custom')}
                          disabled={importLoading}
                        />
                        <div>
                          <div className="radio-title">Use custom connection</div>
                          <div className="radio-subtitle">{gitCustomSubtitle}</div>
                        </div>
                      </label>
                    </div>

                    {gitConnectionMode !== 'local' && (
                      <div className="form-row">
                        <div className="form-group">
                          <label htmlFor="import-git-provider">Git Provider</label>
                          <select
                            id="import-git-provider"
                            value={gitConnectionProvider}
                            onChange={(event) => setGitConnectionProvider(event.target.value)}
                            className="form-select"
                            disabled={importLoading || gitConnectionMode === 'global'}
                          >
                            <option value="github">GitHub</option>
                            <option value="gitlab">GitLab</option>
                          </select>
                        </div>
                        <div className="form-group">
                          <label htmlFor="import-git-remote-url">Remote Repository URL *</label>
                          <input
                            id="import-git-remote-url"
                            type="url"
                            placeholder="https://github.com/username/repository.git"
                            value={gitConnectionRemoteUrl}
                            onChange={(event) => {
                              gitRemoteTouchedRef.current = true;
                              setGitConnectionRemoteUrl(event.target.value);
                            }}
                            className="form-input"
                            disabled={importLoading}
                          />
                        </div>
                      </div>
                    )}

                    {gitConnectionMode === 'global' && !isGlobalConfigured && (
                      <div className="tech-detect-status">
                        Global connection is not configured. This import will fall back to local-only Git.
                      </div>
                    )}

                    {gitRemoteMissing && gitConnectionMode !== 'local' && (
                      <div className="tech-detect-status">
                        No remote URL provided. This import will default to local-only Git.
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>

            {importError && (
              <div className="error-message">
                {importError}
              </div>
            )}

            <div className="form-actions">
              <button
                type="button"
                onClick={handleCancel}
                className="git-settings-button secondary"
                disabled={importLoading}
              >
                Cancel
              </button>

              {currentStep > 0 && (
                <button
                  type="button"
                  onClick={handlePrevStep}
                  className="git-settings-button secondary"
                  disabled={importLoading}
                >
                  Back
                </button>
              )}

              {currentStep < 5 ? (
                <button
                  type="button"
                  onClick={handleNextStep}
                  className="git-settings-button primary"
                  disabled={importLoading}
                >
                  Next
                </button>
              ) : (
                <button
                  type="button"
                  className="git-settings-button primary"
                  onClick={handleImportProject}
                  disabled={importLoading || !importData.name.trim() || 
                    (activeTab === 'local' && !importData.path.trim()) ||
                    (activeTab === 'git' && !importData.gitUrl.trim()) ||
                    (compatibilityRequired && !compatibilityConsent) ||
                    (structureRequired && !structureConsent)}
                >
                  {importLoading ? 'Importing Project...' : 'Import Project'}
                </button>
              )}
            </div>
          </form>
        </div>
      </div>
      <FolderPickerModal
        isOpen={isFolderPickerOpen}
        initialPath={importData.path}
        onSelect={handleFolderPicked}
        onClose={() => setFolderPickerOpen(false)}
      />
    </div>
  );
};

export default ImportProject;