const defaultGitSettings = {
  workflow: 'local',
  provider: 'github',
  remoteUrl: '',
  username: '',
  token: '',
  defaultBranch: 'main',
  autoPush: false,
  useCommitTemplate: false,
  commitTemplate: ''
};

const defaultPortSettings = {
  frontendPortBase: 6100,
  backendPortBase: 6500
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
    return {
      ...defaultGitSettings,
      ...parsed
    };
  } catch (error) {
    console.warn('Failed to parse gitSettings from storage', error);
    return defaultGitSettings;
  }
};

export {
  defaultGitSettings,
  defaultPortSettings,
  getMaxAssistantPanelWidth,
  clampAssistantPanelWidth,
  loadAssistantPanelState,
  loadFileExplorerState,
  loadWorkspaceChangesFromStorage,
  loadWorkingBranchesFromStorage,
  loadGitSettingsFromStorage
};
