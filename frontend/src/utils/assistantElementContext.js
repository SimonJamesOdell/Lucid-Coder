const ASSISTANT_ELEMENT_CONTEXT_STORAGE_KEY = 'lucidcoder:assistantElementContextByProject';
export const ASSISTANT_ELEMENT_CONTEXT_CHANGED_EVENT = 'lucidcoder:assistant-element-context-changed';

const canUseStorage = () => {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
};

const readMap = () => {
  if (!canUseStorage()) {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(ASSISTANT_ELEMENT_CONTEXT_STORAGE_KEY);
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

  window.localStorage.setItem(ASSISTANT_ELEMENT_CONTEXT_STORAGE_KEY, JSON.stringify(value));
};

const getProjectKey = (projectId) => {
  return projectId == null ? '' : String(projectId);
};

const normalizeElementPath = (path) => {
  if (typeof path !== 'string') {
    return '';
  }

  return path.trim();
};

export const getAssistantElementContextPath = (projectId) => {
  const projectKey = getProjectKey(projectId);
  if (!projectKey) {
    return '';
  }

  const map = readMap();
  return normalizeElementPath(map[projectKey]);
};

export const setAssistantElementContextPath = (projectId, path) => {
  const projectKey = getProjectKey(projectId);
  if (!projectKey) {
    return '';
  }

  const map = readMap();
  const nextPath = normalizeElementPath(path);

  if (nextPath) {
    map[projectKey] = nextPath;
  } else {
    delete map[projectKey];
  }

  writeMap(map);

  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(ASSISTANT_ELEMENT_CONTEXT_CHANGED_EVENT, {
      detail: {
        projectId: projectKey,
        path: nextPath
      }
    }));
  }

  return nextPath;
};

export const clearAssistantElementContextPath = (projectId) => {
  return setAssistantElementContextPath(projectId, '');
};
