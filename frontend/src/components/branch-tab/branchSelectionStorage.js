let branchFallbackName = 'main';

export const buildBranchSelectionKey = (projectId) => (projectId ? `branchTab:selected:${projectId}` : null);

export const loadStoredBranchSelection = (projectId) => {
  if (typeof window === 'undefined') {
    return '';
  }
  const storageKey = buildBranchSelectionKey(projectId);
  if (!storageKey) {
    return '';
  }
  try {
    return localStorage.getItem(storageKey) || '';
  } catch (error) {
    console.warn('Failed to load branch selection from storage', error);
    return '';
  }
};

export const persistBranchSelection = (projectId, branchName) => {
  if (typeof window === 'undefined') {
    return;
  }
  const storageKey = buildBranchSelectionKey(projectId);
  if (!storageKey) {
    return;
  }
  try {
    if (branchName) {
      localStorage.setItem(storageKey, branchName);
    } else {
      localStorage.removeItem(storageKey);
    }
  } catch (error) {
    console.warn('Failed to persist branch selection', error);
  }
};

export const getBranchFallbackName = () => branchFallbackName;

export const setBranchFallbackName = (value) => {
  branchFallbackName = typeof value === 'string' ? value : 'main';
};

export const resetBranchFallbackName = () => {
  branchFallbackName = 'main';
};
