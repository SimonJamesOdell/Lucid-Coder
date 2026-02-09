const normalizePreviewTab = (value) => {
  if (typeof value !== 'string') {
    return '';
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  const lower = trimmed.toLowerCase();
  const aliases = {
    tests: 'test',
    branches: 'branch',
    goals: 'goals',
    runs: 'llm-usage',
    'llm usage': 'llm-usage',
    llmusage: 'llm-usage'
  };

  const normalized = aliases[lower] || lower;
  const allowed = new Set([
    'preview',
    'goals',
    'files',
    'branch',
    'test',
    'commits',
    'git',
    'packages',
    'processes',
    'llm-usage'
  ]);

  return allowed.has(normalized) ? normalized : '';
};

const computeNextFollowAutomation = (prevFollowAutomation, nextActiveTab, source) => {
  if (source === 'automation' || source === 'agent') {
    return true;
  }

  if (source === 'user') {
    // Only treat an explicit user click on the Goals tab as “pause automation”.
    // (Other manual tab changes should not disable agent actions.)
    return nextActiveTab === 'goals' ? false : prevFollowAutomation;
  }

  return prevFollowAutomation;
};

export { computeNextFollowAutomation, normalizePreviewTab };
