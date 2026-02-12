import React, { useState, useEffect, useCallback } from 'react';
import { useAppState } from '../context/AppStateContext';
import axios from 'axios';
import Modal from './Modal';
import './ProjectSelector.css';

const ProjectSelector = () => {
  const { isLLMConfigured, currentProject, selectProject, showCreateProject } = useAppState();
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deletingProjectId, setDeletingProjectId] = useState(null);
  const [cleanupWarning, setCleanupWarning] = useState(null);
  const [cleanupRetryStatus, setCleanupRetryStatus] = useState({ state: 'idle', error: '' });
  const [showCleanupDetails, setShowCleanupDetails] = useState(false);



  // Fetch projects on mount
  const fetchProjects = useCallback(async ({ silent = false } = {}) => {
    try {
      if (!silent) {
        setLoading(true);
      }
      setError('');
      const response = await axios.get('/api/projects');
      if (response.data.success) {
        setProjects(response.data.projects || []);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to fetch projects');
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  const handleSelectProject = (project) => {
    selectProject(project);
  };

  const handleDeleteProject = (project) => {
    setProjectToDelete(project);
    setShowDeleteModal(true);
  };

  const confirmDeleteProject = useCallback(async () => {
    if (!projectToDelete) return;

    try {
      setIsDeleting(true);
      setDeletingProjectId(projectToDelete.id);
      const response = await axios.delete(`/api/projects/${projectToDelete.id}`, {
        headers: {
          'x-confirm-destructive': 'true'
        }
      });
      const cleanup = response?.data?.cleanup;
      if (cleanup && cleanup.success === false) {
        const failures = Array.isArray(cleanup.failures) ? cleanup.failures : [];
        setCleanupWarning({
          projectId: projectToDelete.id,
          message: response?.data?.message || 'Project deleted, but cleanup failed. Some files may remain.',
          failures
        });
        setCleanupRetryStatus({ state: 'idle', error: '' });
        setShowCleanupDetails(false);
      } else {
        setCleanupWarning(null);
        setCleanupRetryStatus({ state: 'idle', error: '' });
        setShowCleanupDetails(false);
      }
      await fetchProjects({ silent: true });
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete project');
    } finally {
      setIsDeleting(false);
      setDeletingProjectId(null);
      setShowDeleteModal(false);
      setProjectToDelete(null);
    }
  }, [projectToDelete, fetchProjects]);

  const handleRetryCleanup = useCallback(async () => {
    if (!cleanupWarning?.projectId) {
      return;
    }

    setCleanupRetryStatus({ state: 'working', error: '' });

    try {
      const targets = cleanupWarning.failures
        .map((failure) => failure?.target)
        .filter(Boolean);
      const response = await axios.post(
        `/api/projects/${cleanupWarning.projectId}/cleanup`,
        { targets },
        { headers: { 'x-confirm-destructive': 'true' } }
      );

      if (!response?.data?.success) {
        throw new Error(response?.data?.error || 'Failed to retry cleanup');
      }

      const cleanup = response?.data?.cleanup;
      if (cleanup && cleanup.success === false) {
        const failures = Array.isArray(cleanup.failures) ? cleanup.failures : [];
        setCleanupWarning({
          projectId: cleanupWarning.projectId,
          message: response?.data?.message || 'Cleanup failed. See cleanup details.',
          failures
        });
        setCleanupRetryStatus({ state: 'error', error: 'Cleanup still failed. Some files remain.' });
      } else {
        setCleanupWarning(null);
        setCleanupRetryStatus({ state: 'done', error: '' });
        setShowCleanupDetails(false);
      }
    } catch (error) {
      const message = error?.response?.data?.error || error?.message || 'Failed to retry cleanup';
      setCleanupRetryStatus({ state: 'error', error: message });
    }
  }, [cleanupWarning]);

  const cancelDeleteProject = useCallback(() => {
    if (isDeleting) return;
    setShowDeleteModal(false);
    setProjectToDelete(null);
  }, [isDeleting]);

  const formatDate = (dateString) => {
    if (!dateString) {
      return 'Unknown date';
    }
    const parsedDate = new Date(dateString);
    if (Number.isNaN(parsedDate.getTime())) {
      return 'Unknown date';
    }
    return parsedDate.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  };

  useEffect(() => {
    if (!ProjectSelector.__testHooks) {
      return;
    }
    ProjectSelector.__testHooks.fetchProjects = fetchProjects;
    ProjectSelector.__testHooks.confirmDeleteProject = confirmDeleteProject;
    ProjectSelector.__testHooks.cancelDeleteProject = cancelDeleteProject;
    ProjectSelector.__testHooks.setProjectToDelete = setProjectToDelete;
    ProjectSelector.__testHooks.setShowDeleteModal = setShowDeleteModal;
    ProjectSelector.__testHooks.setIsDeleting = setIsDeleting;
    ProjectSelector.__testHooks.getError = () => error;
    ProjectSelector.__testHooks.getShowDeleteModal = () => showDeleteModal;
    return () => {
      if (ProjectSelector.__testHooks) {
        ProjectSelector.__testHooks.fetchProjects = undefined;
        ProjectSelector.__testHooks.confirmDeleteProject = undefined;
        ProjectSelector.__testHooks.cancelDeleteProject = undefined;
        ProjectSelector.__testHooks.setProjectToDelete = undefined;
        ProjectSelector.__testHooks.setShowDeleteModal = undefined;
        ProjectSelector.__testHooks.setIsDeleting = undefined;
        ProjectSelector.__testHooks.getError = undefined;
        ProjectSelector.__testHooks.getShowDeleteModal = undefined;
      }
    };
  }, [fetchProjects, confirmDeleteProject, cancelDeleteProject, error, showDeleteModal]);

  // Don't render if LLM not configured or project already selected
  if (!isLLMConfigured || currentProject) {
    return null;
  }

  if (loading) {
    return (
      <div className="project-selector">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading projects...</p>
        </div>
      </div>
    );
  }

  if (error && projects.length === 0) {
    return (
      <div className="project-selector">
        <div className="error-state">
          <h2>Error Loading Projects</h2>
          <p className="error-message">{error}</p>
          <button onClick={fetchProjects} className="retry-btn">
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="project-selector">
      <div className="project-selector-header">
        <div className="header-content">
          <div className="header-text">
            <h2>Select Project</h2>
            <p>Choose an existing project or add a new one to get started.</p>
          </div>
          <div className="header-actions">
            <button
              onClick={showCreateProject}
              className="create-project-btn primary"
            >
              Add Project
            </button>
          </div>
        </div>
      </div>

      {cleanupWarning && (
        <div className="cleanup-warning" role="status" aria-live="polite">
          <h4>Cleanup incomplete</h4>
          <p>{cleanupWarning.message}</p>
          {cleanupWarning.failures.length > 0 && (
            <button
              type="button"
              className="cleanup-details-toggle"
              onClick={() => setShowCleanupDetails((prev) => !prev)}
            >
              {showCleanupDetails ? 'Hide cleanup log' : 'View cleanup log'}
            </button>
          )}
          {showCleanupDetails && cleanupWarning.failures.length > 0 && (
            <ul>
              {cleanupWarning.failures.map((failure, index) => (
                <li key={`${failure.target || 'unknown'}-${index}`}>
                  {failure.target || 'Unknown path'}
                  {failure.code ? ` (${failure.code})` : ''}
                  {failure.message ? ` - ${failure.message}` : ''}
                </li>
              ))}
            </ul>
          )}
          {cleanupRetryStatus.state === 'error' && (
            <p className="cleanup-warning-error">{cleanupRetryStatus.error}</p>
          )}
          <div className="cleanup-warning-actions">
            <button
              type="button"
              className="retry-cleanup-btn"
              onClick={handleRetryCleanup}
              disabled={cleanupRetryStatus.state === 'working'}
            >
              {cleanupRetryStatus.state === 'working' ? 'Retrying cleanup...' : 'Retry cleanup'}
            </button>
          </div>
        </div>
      )}

      {projects.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">📁</div>
          <h3>No projects yet</h3>
          <p>Add your first project to get started with AI-powered coding assistance.</p>
        </div>
      ) : (
        <div className="projects-grid">
          {projects.map(project => {
            const isProjectBeingDeleted = deletingProjectId === project.id && isDeleting;
            const handleCardActivate = () => {
              if (isProjectBeingDeleted) {
                return;
              }
              handleSelectProject(project);
            };
            const handleCardKeyDown = (event) => {
              if (isProjectBeingDeleted) {
                return;
              }
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                handleSelectProject(project);
              }
            };
            return (
              <div
                key={project.id}
                className="project-card"
                role="button"
                tabIndex={isProjectBeingDeleted ? -1 : 0}
                aria-disabled={isProjectBeingDeleted}
                aria-label={`Open ${project.name}`}
                onClick={handleCardActivate}
                onKeyDown={handleCardKeyDown}
              >
              <div className="project-header">
                <h3 className="project-name">{project.name}</h3>
                <div className="project-actions">
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      handleDeleteProject(project);
                    }}
                    className="delete-btn"
                    disabled={isDeleting}
                    title="Delete project"
                  >
                    {isProjectBeingDeleted ? 'Deleting…' : <span aria-hidden="true">🗑️</span>}
                    <span className="sr-only">Delete</span>
                  </button>
                </div>
              </div>
              
              {project.description && (
                <p className="project-description">{project.description}</p>
              )}
              
              <div className="project-meta">
                <span className="project-language">{project.language}</span>
                {project.framework && (
                  <span className="project-framework">{project.framework}</span>
                )}
              </div>
              
              <div className="project-dates">
                <small>Updated {formatDate(project.updatedAt || project.createdAt)}</small>
              </div>

              {isProjectBeingDeleted && (
                <div className="project-status" role="status" aria-live="polite">
                  <span className="project-status-spinner" aria-hidden="true"></span>
                  <span>Deleting project…</span>
                </div>
              )}
              </div>
            );
          })}
        </div>
      )}

      <Modal
        isOpen={showDeleteModal}
        onClose={cancelDeleteProject}
        onConfirm={confirmDeleteProject}
        title="Delete Project"
        message={`Are you sure you want to delete "${projectToDelete?.name}"? This action cannot be undone and will permanently remove all project data.`}
        confirmText="Delete"
        cancelText="Cancel"
        type="danger"
        isProcessing={isDeleting}
        processingMessage={projectToDelete ? `Deleting "${projectToDelete.name}". This may take a few seconds.` : 'Deleting project…'}
        confirmLoadingText="Deleting…"
      />
    </div>
  );
};

export default ProjectSelector;

ProjectSelector.__testHooks = ProjectSelector.__testHooks || {};