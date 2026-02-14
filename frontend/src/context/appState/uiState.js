export const buildTestRunIntentState = (source = 'unknown', options = {}, now = () => new Date().toISOString()) => {
  const normalized = typeof source === 'string' ? source.trim() : '';
  const autoCommit = Boolean(options?.autoCommit);
  const returnToCommits = Boolean(options?.returnToCommits);

  return {
    source: normalized || 'unknown',
    updatedAt: now(),
    autoCommit,
    returnToCommits
  };
};

export const withStoppedProject = (prev = {}, projectId) => {
  if (!projectId) {
    return prev;
  }

  return {
    ...prev,
    [projectId]: true
  };
};

export const withoutStoppedProject = (prev = {}, projectId) => {
  if (!projectId || !prev[projectId]) {
    return prev;
  }

  const next = { ...prev };
  delete next[projectId];
  return next;
};
