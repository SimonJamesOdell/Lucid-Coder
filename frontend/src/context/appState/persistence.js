const defaultGitSettings = {
  workflow: 'local',
  provider: 'github',
  remoteUrl: '',
  username: '',
  token: '',
  tokenExpiresAt: '',
  tokenPresent: false,
  defaultBranch: 'main'
};

const defaultPortSettings = {
  frontendPortBase: 6100,
  backendPortBase: 6500
};

const defaultTestingSettings = {
  coverageTarget: 100
};

const MIN_ASSISTANT_PANEL_WIDTH = 240;
const DEFAULT_ASSISTANT_PANEL_WIDTH = 320;

const getMaxAssistantPanelWidth = () => {
  if (typeof window === 'undefined' || typeof window.innerWidth !== 'number') {
    return 480;
  }
  return Math.max(MIN_ASSISTANT_PANEL_WIDTH, Math.floor(window.innerWidth / 2));
};

const clampAssistantPanelWidth = (value) => {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) {
    return DEFAULT_ASSISTANT_PANEL_WIDTH;
  }

  const maxWidth = getMaxAssistantPanelWidth();
  return Math.min(Math.max(numeric, MIN_ASSISTANT_PANEL_WIDTH), maxWidth);
};

const defaultAssistantPanelState = {
  width: DEFAULT_ASSISTANT_PANEL_WIDTH,
  position: 'left'
};

const loadAssistantPanelState = () => {
  if (typeof window === 'undefined') {
    return defaultAssistantPanelState;
  }

  try {
    const stored = localStorage.getItem('assistantPanelState');
    if (!stored) {
      return defaultAssistantPanelState;
    }
    const parsed = JSON.parse(stored);
    const merged = {
      ...defaultAssistantPanelState,
      ...parsed
    };
    return {
      ...merged,
      width: clampAssistantPanelWidth(merged.width)
    };
  } catch (error) {
    console.warn('Failed to parse assistantPanelState from storage', error);
    return defaultAssistantPanelState;
  }
};

const loadFileExplorerState = () => {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    return JSON.parse(localStorage.getItem('fileExplorerState') || '{}');
  } catch (error) {
    console.warn('Failed to parse fileExplorerState from storage', error);
    return {};
  }
};

const loadWorkspaceChangesFromStorage = () => {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    return JSON.parse(localStorage.getItem('workspaceChanges') || '{}');
  } catch (error) {
    console.warn('Failed to parse workspaceChanges from storage', error);
    return {};
  }
};

const loadWorkingBranchesFromStorage = () => {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    return JSON.parse(localStorage.getItem('workingBranches') || '{}');
  } catch (error) {
    console.warn('Failed to parse workingBranches from storage', error);
    return {};
  }
};

const loadPreviewPanelStateByProject = () => {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    return JSON.parse(localStorage.getItem('previewPanelStateByProject') || '{}');
  } catch (error) {
    console.warn('Failed to parse previewPanelStateByProject from storage', error);
    return {};
  }
};

const loadGitSettingsFromStorage = () => {
  if (typeof window === 'undefined') {
    return defaultGitSettings;
  }

  try {
    const stored = localStorage.getItem('gitSettings');
    if (!stored) {
      return defaultGitSettings;
    }
    const parsed = JSON.parse(stored);
    if (Object.prototype.hasOwnProperty.call(parsed, 'autoPush')) {
      delete parsed.autoPush;
    }
    if (Object.prototype.hasOwnProperty.call(parsed, 'useCommitTemplate')) {
      delete parsed.useCommitTemplate;
    }
    if (Object.prototype.hasOwnProperty.call(parsed, 'commitTemplate')) {
      delete parsed.commitTemplate;
    }
    return {
      ...defaultGitSettings,
      ...parsed
    };
  } catch (error) {
    console.warn('Failed to parse gitSettings from storage', error);
    return defaultGitSettings;
  }
};

const sanitizeProjectGitSettingsEntry = (entry) => {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const { autoPush, useCommitTemplate, commitTemplate, ...rest } = entry;
  return {
    ...rest,
    token: ''
  };
};

const loadProjectGitSettingsFromStorage = () => {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    const stored = localStorage.getItem('projectGitSettings');
    if (!stored) {
      return {};
    }
    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    const next = {};
    Object.entries(parsed).forEach(([projectId, entry]) => {
      const sanitized = sanitizeProjectGitSettingsEntry(entry);
      if (sanitized) {
        next[projectId] = sanitized;
      }
    });
    return next;
  } catch (error) {
    console.warn('Failed to parse projectGitSettings from storage', error);
    return {};
  }
};

const defaultGitConnectionStatus = {
  provider: '',
  account: null,
  message: '',
  testedAt: ''
};

const loadGitConnectionStatusFromStorage = () => {
  if (typeof window === 'undefined') {
    return defaultGitConnectionStatus;
  }

  try {
    const stored = localStorage.getItem('gitConnectionStatus');
    if (!stored) {
      return defaultGitConnectionStatus;
    }
    const parsed = JSON.parse(stored);
    return {
      ...defaultGitConnectionStatus,
      ...parsed
    };
  } catch (error) {
    console.warn('Failed to parse gitConnectionStatus from storage', error);
    return defaultGitConnectionStatus;
  }
};

const loadTestingSettingsFromStorage = () => {
  if (typeof window === 'undefined') {
    return defaultTestingSettings;
  }

  try {
    const stored = localStorage.getItem('testingSettings');
    if (!stored) {
      return defaultTestingSettings;
    }
    const parsed = JSON.parse(stored);
    return {
      ...defaultTestingSettings,
      ...parsed
    };
  } catch (error) {
    console.warn('Failed to parse testingSettings from storage', error);
    return defaultTestingSettings;
  }
};

export {
  defaultGitSettings,
  defaultPortSettings,
  defaultTestingSettings,
  getMaxAssistantPanelWidth,
  clampAssistantPanelWidth,
  loadAssistantPanelState,
  loadFileExplorerState,
  loadWorkspaceChangesFromStorage,
  loadWorkingBranchesFromStorage,
  loadPreviewPanelStateByProject,
  loadGitSettingsFromStorage,
  loadProjectGitSettingsFromStorage,
  defaultGitConnectionStatus,
  loadGitConnectionStatusFromStorage,
  loadTestingSettingsFromStorage
};
