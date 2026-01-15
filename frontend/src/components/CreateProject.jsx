import React, { useEffect, useRef, useState } from 'react';
import { useAppState } from '../context/AppStateContext';
import axios from 'axios';
import { io } from 'socket.io-client';
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

const CreateProject = () => {
  const { createProject, selectProject, showMain } = useAppState();
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
    if (normalized?.status === 'completed' || normalized?.status === 'failed') {
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

  const handleCreateProject = async (e) => {
    e.preventDefault();
    
    if (!newProject.name.trim()) {
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
      
      const response = await axios.post('/api/projects', {
        name: newProject.name.trim(),
        description: newProject.description.trim(),
        frontend: {
          language: newProject.frontend.language,
          framework: newProject.frontend.framework
        },
        backend: {
          language: newProject.backend.language,
          framework: newProject.backend.framework
        },
        progressKey: newProgressKey
      });
      
      if (response.data && response.data.success) {
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
        setProgressKey(null);
        
        // Store process information
        if (response.data.processes) {
          setProcesses(response.data.processes);
        }
        
        // Auto-select the newly created project
        const projectData = response.data.project;
        selectProject(projectData);
        
        // Show success for a moment before navigating
        setTimeout(() => {
          showMain();
        }, 2000);
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
    showMain();
  };

  const getFrontendFrameworks = () => {
    return frontendFrameworks[newProject.frontend.language] || ['react'];
  };

  const getBackendFrameworks = () => {
    return backendFrameworks[newProject.backend.language] || ['express'];
  };

  const isProgressBlocking = Boolean(progress && progress.status !== 'failed');

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
          </div>
        )}
        
        <div className="create-project-header" style={{ display: isProgressBlocking ? 'none' : 'block' }}>
          <button onClick={handleCancel} className="back-btn">
            ← Back to Projects
          </button>
          <h1>Create New Project</h1>
          <p>Set up a new project with AI-powered coding assistance.</p>
        </div>

        <div className="create-project-form" style={{ display: isProgressBlocking ? 'none' : 'block' }}>
          <form onSubmit={handleCreateProject} role="form">
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
                    disabled={createLoading}
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
                    disabled={createLoading}
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
                    disabled={createLoading}
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
                    disabled={createLoading}
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

            {createError && (
              <div className="error-message">
                {createError}
              </div>
            )}

            <div className="form-actions">
              <button
                type="button"
                onClick={handleCancel}
                className="cancel-btn"
                disabled={createLoading}
              >
                Cancel
              </button>
              
              <button
                type="submit"
                className="create-btn"
                disabled={createLoading}
              >
                {createLoading ? 'Creating Project...' : 'Create Project'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export default CreateProject;