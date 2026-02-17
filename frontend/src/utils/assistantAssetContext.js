const ASSISTANT_ASSET_CONTEXT_STORAGE_KEY = 'lucidcoder:assistantAssetContextByProject';
export const ASSISTANT_ASSET_CONTEXT_CHANGED_EVENT = 'lucidcoder:assistant-asset-context-changed';

const canUseStorage = () => {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
};

const readMap = () => {
  if (!canUseStorage()) {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(ASSISTANT_ASSET_CONTEXT_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const writeMap = (value) => {
  if (!canUseStorage()) {
    return;
  }

  window.localStorage.setItem(ASSISTANT_ASSET_CONTEXT_STORAGE_KEY, JSON.stringify(value));
};

const normalizePathList = (paths) => {
  if (!Array.isArray(paths)) {
    return [];
  }

  return [...new Set(
    paths
      .filter((path) => typeof path === 'string')
      .map((path) => path.trim())
      .filter(Boolean)
  )].sort((left, right) => left.localeCompare(right));
};

const getProjectKey = (projectId) => {
  return projectId == null ? '' : String(projectId);
};

export const getAssistantAssetContextPaths = (projectId) => {
  const projectKey = getProjectKey(projectId);
  if (!projectKey) {
    return [];
  }

  const map = readMap();
  return normalizePathList(map[projectKey]);
};

export const setAssistantAssetContextPaths = (projectId, paths) => {
  const projectKey = getProjectKey(projectId);
  if (!projectKey) {
    return [];
  }

  const map = readMap();
  const nextPaths = normalizePathList(paths);

  if (nextPaths.length > 0) {
    map[projectKey] = nextPaths;
  } else {
    delete map[projectKey];
  }

  writeMap(map);
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(ASSISTANT_ASSET_CONTEXT_CHANGED_EVENT, {
      detail: {
        projectId: projectKey,
        paths: nextPaths
      }
    }));
  }
  return nextPaths;
};

export const clearAssistantAssetContextPaths = (projectId) => {
  return setAssistantAssetContextPaths(projectId, []);
};
