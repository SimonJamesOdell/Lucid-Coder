export const fetchProjectsFromBackend = async ({ trackedFetch, setProjects }) => {
  try {
    const response = await trackedFetch('/api/projects');
    let result = null;
    try {
      result = await response.json();
    } catch {
      result = null;
    }

    if (!response.ok) {
      throw new Error(result?.error || 'Failed to fetch projects');
    }

    if (result?.success) {
      const nextProjects = Array.isArray(result.projects) ? result.projects : [];
      setProjects((prev) => {
        if (nextProjects.length === 0 && Array.isArray(prev) && prev.length > 0) {
          return prev;
        }

        const merged = new Map();
        if (Array.isArray(prev)) {
          prev.forEach((project) => {
            if (project?.id) {
              merged.set(project.id, project);
            }
          });
        }

        nextProjects.forEach((project) => {
          if (project?.id) {
            merged.set(project.id, { ...merged.get(project.id), ...project });
          }
        });

        return Array.from(merged.values());
      });
    }
  } catch (error) {
    console.warn('Failed to fetch projects from backend:', error);
    const savedProjects = localStorage.getItem('projects');
    if (savedProjects) {
      setProjects(JSON.parse(savedProjects));
    }
  }
};

export const selectProjectWithProcesses = async ({
  project,
  currentProject,
  closeProject,
  setCurrentProject,
  fetchProjectGitSettings,
  fetchProjectTestingSettings,
  trackedFetch,
  applyProcessSnapshot,
  refreshProcessStatus
}) => {
  let started = false;
  const getUiSessionId = () => {
    if (typeof window === 'undefined') {
      return null;
    }

    try {
      const value = window.sessionStorage?.getItem?.('lucidcoder.uiSessionId');
      if (typeof value !== 'string') {
        return null;
      }
      const trimmed = value.trim();
      return trimmed ? trimmed : null;
    } catch {
      return null;
    }
  };

  if (!project) {
    return false;
  }

  if (currentProject && currentProject.id !== project.id) {
    await closeProject();
  }

  setCurrentProject(project);

  if (project && project.id) {
    await fetchProjectGitSettings(project.id);
    await fetchProjectTestingSettings?.(project.id);

    try {
      const response = await trackedFetch(`/api/projects/${project.id}/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json();
      if (result?.processes) {
        applyProcessSnapshot(project.id, result.processes);
      }

      try {
        await refreshProcessStatus(project.id);
      } catch (statusError) {
        console.warn('Failed to refresh process status after start:', statusError);
      }
      started = true;
    } catch (error) {
      if (error.message.includes('Failed to fetch') || error.message.includes('fetch')) {
        console.warn(
          'Backend server not available - project selected but processes not started. Please ensure the backend server is running.'
        );
      } else {
        console.error('Failed to start project processes:', error);
      }
    }

    // Best-effort: only resume autopilot sessions for the project the user opened.
    // (Resumption can trigger paid LLM calls, so this is intentionally user-driven.)
    const uiSessionId = getUiSessionId();
    if (uiSessionId) {
      try {
        await trackedFetch('/api/agent/autopilot/resume', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ projectId: project.id, uiSessionId, limit: 1 })
        });
      } catch (resumeError) {
        // Not fatal; resume is best-effort and can be retried by reopening the project.
      }
    }
  }

  return started;
};

export const closeProjectWithProcesses = async ({
  currentProject,
  setProjectShutdownState,
  trackedFetch,
  resetProjectShutdownState,
  resetProjectProcesses,
  clearJobPolls,
  setCurrentProject
}) => {
  if (currentProject && currentProject.id) {
    const activeProject = { id: currentProject.id, name: currentProject.name };
    setProjectShutdownState({
      isStopping: true,
      projectId: activeProject.id,
      projectName: activeProject.name || '',
      startedAt: new Date().toISOString(),
      error: null
    });

    try {
      const response = await trackedFetch(`/api/projects/${activeProject.id}/stop`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      let result = null;
      try {
        result = await response.json();
      } catch (parseError) {
        result = null;
      }

      if (!response.ok) {
        const message = result?.error || `HTTP error! status: ${response.status}`;
        throw new Error(message);
      }

      console.log('Project processes stopped:', result?.message ?? result);

      resetProjectShutdownState();
    } catch (error) {
      if (error.message.includes('Failed to fetch') || error.message.includes('fetch')) {
        console.warn(
          'Backend server not available - project closed but processes may still be running. Please ensure the backend server is running.'
        );
      } else {
        console.error('Failed to stop project processes:', error);
      }

      setProjectShutdownState((prev) => ({
        ...prev,
        isStopping: false,
        error: error.message || 'Failed to stop project processes'
      }));
    }
  } else {
    resetProjectShutdownState();
  }

  resetProjectProcesses();
  clearJobPolls();
  setCurrentProject(null);
};

export const stopProjectProcesses = async ({
  projectId,
  projectName,
  setProjectShutdownState,
  trackedFetch,
  resetProjectShutdownState,
  resetProjectProcesses,
  clearJobPolls,
  refreshProcessStatus
}) => {
  if (!projectId) {
    throw new Error('Select a project before stopping processes');
  }

  setProjectShutdownState({
    isStopping: true,
    projectId,
    projectName: projectName || '',
    startedAt: new Date().toISOString(),
    error: null
  });

  try {
    const response = await trackedFetch(`/api/projects/${projectId}/stop`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    let result = null;
    try {
      result = await response.json();
    } catch (parseError) {
      result = null;
    }

    if (!response.ok) {
      const message = result?.error || `HTTP error! status: ${response.status}`;
      throw new Error(message);
    }

    console.log('Project processes stopped:', result?.message ?? result);

    resetProjectShutdownState();
  } catch (error) {
    if (error.message.includes('Failed to fetch') || error.message.includes('fetch')) {
      console.warn(
        'Backend server not available - project stop requested but processes may still be running. Please ensure the backend server is running.'
      );
    } else {
      console.error('Failed to stop project processes:', error);
    }

    setProjectShutdownState((prev) => ({
      ...prev,
      isStopping: false,
      error: error.message || 'Failed to stop project processes'
    }));

    throw error;
  } finally {
    resetProjectProcesses();
    clearJobPolls();
    try {
      await refreshProcessStatus(projectId);
    } catch (refreshError) {
      // Not fatal after a stop request.
    }
  }

  return true;
};

export const stopProjectProcessTarget = async ({ projectId, target, trackedFetch, refreshProcessStatus }) => {
  if (!projectId) {
    throw new Error('Select a project before stopping processes');
  }
  if (target !== 'frontend' && target !== 'backend') {
    throw new Error('Select a valid process target before stopping');
  }

  const response = await trackedFetch(`/api/projects/${projectId}/stop?target=${target}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    }
  });

  let result = null;
  try {
    result = await response.json();
  } catch (parseError) {
    result = null;
  }

  if (!response.ok) {
    const message = result?.error || `HTTP error! status: ${response.status}`;
    throw new Error(message);
  }

  try {
    await refreshProcessStatus(projectId);
  } catch (refreshError) {
    // Not fatal after a stop request.
  }

  return result || { success: true };
};

export const restartProjectProcesses = async ({
  projectId,
  target,
  trackedFetch,
  applyProcessSnapshot,
  refreshProcessStatus,
  resetProjectProcesses
}) => {
  if (!projectId) {
    throw new Error('Select a project before restarting processes');
  }

  const normalizedTarget = target === 'frontend' || target === 'backend' ? target : null;

  const suffix = normalizedTarget ? `?target=${encodeURIComponent(normalizedTarget)}` : '';
  const response = await trackedFetch(`/api/projects/${projectId}/restart${suffix}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    }
  });

  let data = null;
  try {
    data = await response.json();
  } catch (parseError) {
    data = null;
  }

  if (!response.ok || !data?.success) {
    const message = data?.error || `HTTP error! status: ${response.status}`;
    throw new Error(message);
  }

  if (data.processes) {
    applyProcessSnapshot(projectId, data.processes);
  } else {
    resetProjectProcesses();
  }

  try {
    await refreshProcessStatus(projectId);
  } catch (error) {
    console.warn('Failed to refresh process status after restart', error);
  }

  return data.processes || null;
};

export const createProjectBackend = async ({ projectId, trackedFetch, refreshProcessStatus }) => {
  if (!projectId) {
    throw new Error('Select a project before creating a backend');
  }

  const response = await trackedFetch(`/api/projects/${projectId}/backend/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    }
  });

  let result = null;
  try {
    result = await response.json();
  } catch (parseError) {
    result = null;
  }

  if (!response.ok || !result?.success) {
    const message = result?.error || `HTTP error! status: ${response.status}`;
    throw new Error(message);
  }

  try {
    await refreshProcessStatus(projectId);
  } catch {
    // ignore refresh failures
  }

  return result;
};

export const createProjectViaBackend = async ({ projectData, trackedFetch, setProjects, selectProject }) => {
  try {
    const response = await trackedFetch('/api/projects', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: projectData.name,
        description: projectData.description || '',
        frontend: { language: 'javascript', framework: 'react' },
        backend: { language: 'javascript', framework: 'express' }
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json();
    const newProject = result.project;

    setProjects((prev) => [...prev, newProject]);
    await selectProject(newProject);

    return newProject;
  } catch (error) {
    console.error('Failed to create project:', error);

    const newProject = {
      id: Date.now().toString(),
      name: projectData.name,
      description: projectData.description || '',
      createdAt: new Date().toISOString(),
      ...projectData
    };

    setProjects((prev) => [...prev, newProject]);
    selectProject(newProject);

    return newProject;
  }
};

export const importProjectViaBackend = async ({ projectData, trackedFetch, setProjects, selectProject }) => {
  const response = await trackedFetch('/api/projects/import', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(projectData)
  });

  let result = null;
  try {
    result = await response.json();
  } catch (error) {
    result = null;
  }

  if (!response.ok || !result?.success) {
    const message = result?.error || `HTTP error! status: ${response.status}`;
    throw new Error(message);
  }

  const newProject = result.project;
  setProjects((prev) => [...prev, newProject]);
  await selectProject(newProject);
  return {
    project: newProject,
    jobs: Array.isArray(result.jobs) ? result.jobs : []
  };
};
