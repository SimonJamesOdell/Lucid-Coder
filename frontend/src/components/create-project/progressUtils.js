const PROGRESS_STEP_NAMES = [
  'Creating directories',
  'Generating files',
  'Initializing git repository',
  'Installing dependencies',
  'Starting development servers'
];

export const buildProgressSteps = (completed = false) =>
  PROGRESS_STEP_NAMES.map((name) => ({ name, completed }));

const clampCompletion = (value) => Math.min(100, Math.max(0, value));

export const isEmptyProgressSnapshot = (candidate) => {
  if (!candidate || typeof candidate !== 'object') {
    return true;
  }

  const stepsEmpty = Array.isArray(candidate.steps) && candidate.steps.length === 0;
  const noMetrics = candidate.status == null && candidate.completion == null;
  const noMessage = !candidate.statusMessage;
  const noError = !candidate.error;

  return stepsEmpty && noMetrics && noMessage && noError;
};

export const normalizeServerProgress = (serverProgress) => {
  if (!serverProgress || typeof serverProgress !== 'object') {
    return {
      steps: buildProgressSteps(false),
      completion: 0,
      status: 'pending',
      statusMessage: 'Working...'
    };
  }

  const declaredStatus = typeof serverProgress.status === 'string' ? serverProgress.status : null;

  const stepsProvided = Array.isArray(serverProgress.steps) && serverProgress.steps.length > 0;
  const rawSteps = stepsProvided
    ? serverProgress.steps
    : buildProgressSteps(declaredStatus === 'completed');

  const normalizedSteps = rawSteps.map((step, index) => ({
    name: step?.name || PROGRESS_STEP_NAMES[index] || `Step ${index + 1}`,
    completed: Boolean(step?.completed)
  }));

  const completionFromServer = typeof serverProgress.completion === 'number'
    ? clampCompletion(serverProgress.completion)
    : Math.round(
        (normalizedSteps.filter((step) => step.completed).length / normalizedSteps.length) * 100
      ) || 0;

  const completion = declaredStatus === 'completed'
    ? 100
    : (normalizedSteps.every((step) => step.completed) ? 100 : completionFromServer);

  const status = declaredStatus
    || (completion === 100 ? 'completed' : (completion === 0 ? 'pending' : 'in-progress'));

  return {
    steps: normalizedSteps,
    completion,
    status,
    statusMessage: serverProgress.statusMessage || 'Project created successfully',
    error: serverProgress.error
  };
};

export const generateProgressKey = () => {
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `progress-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

export const POLL_SUPPRESSION_WINDOW_MS = 1500;

export const guessProjectName = (value) => {
  if (!value || typeof value !== 'string') {
    return '';
  }
  const cleaned = value.trim().replace(/[?#].*$/, '');
  if (!cleaned) {
    return '';
  }
  const segments = cleaned.split(/[\\/]/).filter(Boolean);
  let candidate = segments.length > 0 ? segments[segments.length - 1] : '';
  if (candidate.includes(':')) {
    const afterColon = candidate.split(':').pop();
    candidate = afterColon || '';
  }
  return candidate.replace(/\.git$/i, '');
};
