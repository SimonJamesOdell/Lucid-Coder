import { PROJECT_CREATION_STEPS, buildProgressSteps, calculateCompletion } from '../constants/progressSteps.js';
import { EventEmitter } from 'node:events';

const PROGRESS_RETENTION_MS = 1000 * 60 * 5; // 5 minutes

const progressStore = new Map();

export const progressEvents = new EventEmitter();

const createDefaultState = () => ({
  status: 'pending',
  statusMessage: 'Waiting to start',
  completion: 0,
  steps: buildProgressSteps(0),
  updatedAt: new Date().toISOString()
});

const getOrCreateEntry = (key) => {
  if (!key) {
    return null;
  }

  let entry = progressStore.get(key);
  if (!entry) {
    entry = {
      state: createDefaultState(),
      clients: new Set(),
      cleanupTimeout: null
    };
    progressStore.set(key, entry);
  }
  return entry;
};

const broadcastUpdate = (key) => {
  const entry = progressStore.get(key);
  if (!entry) {
    return;
  }

  const payload = JSON.stringify(entry.state);
  for (const client of entry.clients) {
    try {
      client.write(`event: progress\n`);
      client.write(`data: ${payload}\n\n`);
    } catch (error) {
      entry.clients.delete(client);
      try {
        client.end();
      } catch (endError) {
        // Ignore cleanup failures
      }
    }
  }
};

const scheduleCleanup = (key) => {
  const entry = progressStore.get(key);
  if (!entry) {
    return;
  }

  if (entry.cleanupTimeout) {
    clearTimeout(entry.cleanupTimeout);
  }

  entry.cleanupTimeout = setTimeout(() => {
    entry.clients.forEach((client) => {
      try {
        client.end();
      } catch {
        // Ignore
      }
    });
    progressStore.delete(key);
  }, PROGRESS_RETENTION_MS);
};

export const initProgress = (key, initialState = {}) => {
  const entry = getOrCreateEntry(key);
  if (!entry) {
    return null;
  }

  entry.state = {
    ...entry.state,
    ...initialState,
    steps: initialState.steps || entry.state.steps,
    updatedAt: new Date().toISOString()
  };
  broadcastUpdate(key);
  progressEvents.emit('progress:update', { key, state: entry.state });
  return entry.state;
};

export const updateProgress = (key, partialState = {}) => {
  const entry = getOrCreateEntry(key);
  if (!entry) {
    return null;
  }

  entry.state = {
    ...entry.state,
    ...partialState,
    steps: partialState.steps || entry.state.steps,
    completion: typeof partialState.completion === 'number'
      ? partialState.completion
      : entry.state.completion,
    updatedAt: new Date().toISOString()
  };
  broadcastUpdate(key);
  progressEvents.emit('progress:update', { key, state: entry.state });
  return entry.state;
};

export const completeProgress = (key, message = 'Project created successfully') => {
  const steps = buildProgressSteps(PROJECT_CREATION_STEPS.length);
  const state = updateProgress(key, {
    status: 'completed',
    statusMessage: message,
    completion: 100,
    steps
  });
  scheduleCleanup(key);
  return state;
};

export const failProgress = (key, errorMessage = 'Project creation failed') => {
  const state = updateProgress(key, {
    status: 'failed',
    statusMessage: errorMessage,
    error: errorMessage
  });
  scheduleCleanup(key);
  return state;
};

export const attachProgressStream = (key, res) => {
  const entry = getOrCreateEntry(key);
  if (!entry) {
    res.status(400).end();
    return;
  }

  entry.clients.add(res);
  res.write(`event: progress\n`);
  res.write(`data: ${JSON.stringify(entry.state)}\n\n`);

  const cleanup = () => {
    entry.clients.delete(res);
    if (entry.clients.size === 0 && entry.state.status !== 'in-progress') {
      scheduleCleanup(key);
    }
  };

  res.on('close', cleanup);
  res.on('error', cleanup);
};

export const getProgressSnapshot = (key) => {
  const entry = progressStore.get(key);
  return entry ? entry.state : null;
};

export const resetProgressStore = () => {
  progressStore.forEach((entry) => {
    if (entry.cleanupTimeout) {
      clearTimeout(entry.cleanupTimeout);
    }
    entry.clients.forEach((client) => {
      try {
        client.end();
      } catch {
        // Ignore errors during forced shutdown
      }
    });
  });
  progressStore.clear();
};

export const buildProgressPayload = (completedCount = 0, statusMessage = '', status = 'in-progress') => ({
  steps: buildProgressSteps(completedCount),
  completion: calculateCompletion(completedCount),
  status,
  statusMessage
});

export const __testing = {
  broadcastUpdate: (key) => broadcastUpdate(key),
  scheduleCleanup: (key) => scheduleCleanup(key)
};
