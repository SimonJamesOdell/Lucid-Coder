import { sanitizeGitSettings } from './helpers.js';

export const fetchGitSettingsFromBackend = async ({ trackedFetch, setGitSettings }) => {
  try {
    const response = await trackedFetch('/api/settings/git');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    if (data.success && data.settings) {
      setGitSettings((prev) => ({
        ...prev,
        ...data.settings,
        token: ''
      }));
    }
  } catch (error) {
    console.warn('Failed to load git settings from backend:', error);
  }
};

export const fetchPortSettingsFromBackend = async ({ trackedFetch, setPortSettings }) => {
  try {
    const response = await trackedFetch('/api/settings/ports');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    if (data.success && data.settings) {
      setPortSettings((prev) => ({
        ...prev,
        ...data.settings
      }));
    }
  } catch (error) {
    console.warn('Failed to load port settings from backend:', error);
  }
};

export const fetchProjectGitSettings = async ({
  projectId,
  trackedFetch,
  setProjectGitSettings
}) => {
  if (!projectId) {
    return null;
  }

  try {
    const response = await trackedFetch(`/api/projects/${projectId}/git-settings`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    if (!data.success) {
      throw new Error(data.error || 'Failed to load project git settings');
    }

    setProjectGitSettings((prev) => {
      const next = { ...prev };
      if (data.inheritsFromGlobal || !data.projectSettings) {
        delete next[projectId];
      } else {
        next[projectId] = sanitizeGitSettings(data.projectSettings);
      }
      return next;
    });

    return {
      inheritsFromGlobal: data.inheritsFromGlobal,
      effectiveSettings: sanitizeGitSettings(data.effectiveSettings || data.settings),
      projectSettings: sanitizeGitSettings(data.projectSettings)
    };
  } catch (error) {
    console.warn('Failed to load project git settings:', error);
    return null;
  }
};

export const updateGitSettings = async ({ trackedFetch, gitSettings, setGitSettings, updates = {} }) => {
  const payload = {
    ...gitSettings,
    ...updates
  };

  const body = { ...payload };
  if (!Object.prototype.hasOwnProperty.call(updates, 'token')) {
    delete body.token;
  }

  const response = await trackedFetch('/api/settings/git', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  if (!response.ok || !data.success) {
    const message = data?.error || 'Failed to save git settings';
    throw new Error(message);
  }

  const nextState = {
    ...gitSettings,
    ...data.settings,
    token: ''
  };

  setGitSettings(nextState);
  return data.settings;
};

export const updatePortSettings = async ({
  trackedFetch,
  portSettings,
  setPortSettings,
  updates = {},
  currentProjectId,
  isProjectStopping,
  restartProject
}) => {
  const payload = {
    frontendPortBase: Number.parseInt(updates.frontendPortBase ?? portSettings.frontendPortBase, 10),
    backendPortBase: Number.parseInt(updates.backendPortBase ?? portSettings.backendPortBase, 10)
  };

  const response = await trackedFetch('/api/settings/ports', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();

  if (!response.ok || !data.success) {
    const message = data?.error || 'Failed to save port settings';
    throw new Error(message);
  }

  setPortSettings((prev) => ({
    ...prev,
    ...data.settings
  }));

  const shouldRestart = currentProjectId && !isProjectStopping(currentProjectId);

  if (shouldRestart) {
    try {
      await restartProject(currentProjectId);
    } catch (error) {
      console.error('Failed to restart project after updating port settings:', error);
      const restartMessage = error?.message
        ? `Port settings saved but failed to restart project: ${error.message}`
        : 'Port settings saved but failed to restart project';
      throw new Error(restartMessage);
    }
  }

  return data.settings;
};

export const getEffectiveGitSettings = ({ gitSettings, projectGitSettings, projectId }) => {
  if (projectId && projectGitSettings[projectId]) {
    return {
      ...gitSettings,
      ...projectGitSettings[projectId],
      token: ''
    };
  }
  return gitSettings;
};

export const getProjectGitSettingsSnapshot = ({ gitSettings, projectGitSettings, projectId }) => {
  const effective = getEffectiveGitSettings({ gitSettings, projectGitSettings, projectId });
  const overrides = projectId ? projectGitSettings[projectId] || null : null;
  return {
    inheritsFromGlobal: !overrides,
    effectiveSettings: { ...effective },
    projectSettings: overrides ? { ...overrides } : null,
    globalSettings: { ...gitSettings }
  };
};

export const createProjectRemoteRepository = async ({ trackedFetch, projectId, options = {}, setProjectGitSettings }) => {
  if (!projectId) {
    throw new Error('projectId is required to create a remote repository');
  }

  const response = await trackedFetch(`/api/projects/${projectId}/git/remotes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(options)
  });

  const data = await response.json();

  if (!response.ok || !data.success) {
    const message = data?.error || 'Failed to create remote repository';
    throw new Error(message);
  }

  const snapshot = data.projectSettings || data.settings || null;
  if (snapshot) {
    setProjectGitSettings((prev) => ({
      ...prev,
      [projectId]: sanitizeGitSettings(snapshot)
    }));
  }

  return data;
};

export const updateProjectGitSettings = async ({
  trackedFetch,
  projectId,
  updates = {},
  gitSettings,
  projectGitSettings,
  setProjectGitSettings
}) => {
  if (!projectId) {
    throw new Error('projectId is required to update project git settings');
  }

  const payload = {
    ...getEffectiveGitSettings({ gitSettings, projectGitSettings, projectId }),
    ...updates
  };

  const body = { ...payload };
  if (!Object.prototype.hasOwnProperty.call(updates, 'token')) {
    delete body.token;
  }

  const response = await trackedFetch(`/api/projects/${projectId}/git-settings`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  if (!response.ok || !data.success) {
    const message = data?.error || 'Failed to save project git settings';
    throw new Error(message);
  }

  setProjectGitSettings((prev) => ({
    ...prev,
    [projectId]: sanitizeGitSettings(data.projectSettings || data.settings)
  }));

  return data.settings;
};

export const clearProjectGitSettings = async ({ trackedFetch, projectId, setProjectGitSettings, setGitSettings }) => {
  if (!projectId) {
    throw new Error('projectId is required to clear project git settings');
  }

  const response = await trackedFetch(`/api/projects/${projectId}/git-settings`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json'
    }
  });

  const data = await response.json();

  if (!response.ok || !data.success) {
    const message = data?.error || 'Failed to clear project git settings';
    throw new Error(message);
  }

  setProjectGitSettings((prev) => {
    if (!prev[projectId]) {
      return prev;
    }
    const next = { ...prev };
    delete next[projectId];
    return next;
  });

  if (data.globalSettings) {
    setGitSettings((prev) => ({
      ...prev,
      ...sanitizeGitSettings(data.globalSettings)
    }));
  }

  return data.settings;
};
