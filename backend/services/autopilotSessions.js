import { randomUUID } from 'crypto';
import { autopilotFeatureRequest } from './agentAutopilot.js';

const EVENT_LIMIT = 500;
const ACTIVE_STATUSES = new Set(['pending', 'running', 'paused']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export const AutopilotSessionErrorCodes = Object.freeze({
  NOT_FOUND: 'AUTOPILOT_SESSION_NOT_FOUND'
});

const sessions = new Map();

const createId = (generator) => {
  if (typeof generator === 'function') {
    const value = generator();
    if (value) {
      return String(value);
    }
  }
  return randomUUID();
};

const nowIso = (clock) => {
  if (typeof clock === 'function') {
    const value = clock();
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (typeof value === 'string') {
      return new Date(value).toISOString();
    }
  }
  return new Date().toISOString();
};

const sanitizePrompt = (value) => {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
};

const sanitizeOptions = (value) => {
  if (!value || typeof value !== 'object') {
    return {};
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {};
  }
};

const sanitizeUiSessionId = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const defaultDeps = Object.freeze({});

const getSessionInternal = (sessionId) => sessions.get(String(sessionId || ''));

const getSessionOrThrow = (sessionId) => {
  const session = getSessionInternal(sessionId);
  if (!session) {
    const error = new Error('Autopilot session not found');
    error.code = AutopilotSessionErrorCodes.NOT_FOUND;
    throw error;
  }
  return session;
};

const clonePayload = (value) => {
  if (value === undefined) {
    return null;
  }
  if (value === null) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
};

const appendSessionEvent = (session, rawEvent) => {
  if (!session || !rawEvent) {
    return;
  }

  const event = {
    id: `${session.id}:event:${session.nextEventId += 1}`,
    timestamp: nowIso(session.control.now),
    type: typeof rawEvent.type === 'string' && rawEvent.type.trim() ? rawEvent.type.trim() : 'log',
    message: typeof rawEvent.message === 'string' ? rawEvent.message : String(rawEvent.message ?? ''),
    payload: clonePayload(rawEvent.payload ?? null),
    meta: clonePayload(rawEvent.meta ?? null)
  };

  session.events.push(event);
  if (session.events.length > EVENT_LIMIT) {
    session.events.shift();
    session.eventsTrimmed += 1;
  }
  session.updatedAt = event.timestamp;
};

const summarizeSession = (session, { includeEvents = true } = {}) => {
  if (!session) {
    return null;
  }

  return {
    id: session.id,
    projectId: session.projectId,
    prompt: session.prompt,
    status: session.status,
    statusMessage: session.statusMessage,
    createdAt: session.createdAt,
    startedAt: session.startedAt,
    finishedAt: session.finishedAt,
    updatedAt: session.updatedAt,
    uiSessionId: session.uiSessionId,
    result: clonePayload(session.result),
    error: session.error,
    eventCount: session.events.length,
    eventsTrimmed: session.eventsTrimmed,
    messageCount: session.messages.length,
    events: includeEvents ? session.events.slice() : undefined
  };
};

const buildDeps = (session) => {
  const consumeUserUpdates = () => {
    const queue = session.control.pendingUpdates;
    if (!queue.length) {
      return [];
    }
    const copy = queue.slice();
    queue.length = 0;
    return copy;
  };

  const reportStatus = (message) => {
    const text = typeof message === 'string' ? message.trim() : '';
    if (!text) {
      return;
    }
    if (text === session.statusMessage) {
      return;
    }
    session.statusMessage = text;
    appendSessionEvent(session, {
      type: 'status',
      message: text,
      payload: null,
      meta: null
    });
  };

  const appendEvent = (event) => appendSessionEvent(session, event);

  const uiBridge = {
    navigateTab: (tab) => {
      const target = typeof tab === 'string' ? tab : String(tab ?? '');
      appendSessionEvent(session, {
        type: 'ui:navigate',
        message: target ? `navigate:${target}` : 'navigate',
        payload: { tab: target || null },
        meta: null
      });
    }
  };

  return {
    consumeUserUpdates,
    shouldCancel: () => session.control.cancelRequested,
    shouldPause: () => session.control.pauseRequested,
    reportStatus,
    appendEvent,
    waitForUserGuidance: true,
    ui: uiBridge
  };
};

const markSessionFailed = (session, errorMessage) => {
  session.status = 'failed';
  session.error = errorMessage;
  session.statusMessage = errorMessage;
  appendSessionEvent(session, {
    type: 'session:failed',
    message: errorMessage,
    payload: null,
    meta: null
  });
};

const startAutopilotWorker = (session) => {
  if (!session || session.control.running) {
    return session?.control.workerPromise || null;
  }

  const worker = async () => {
    session.control.running = true;
    session.status = 'running';
    session.startedAt = session.startedAt || nowIso(session.control.now);
    appendSessionEvent(session, {
      type: 'session:started',
      message: 'Autopilot execution started',
      payload: null,
      meta: null
    });

    try {
      const executor = session.control.autopilot || autopilotFeatureRequest;
      const result = await executor({
        projectId: session.projectId,
        prompt: session.prompt,
        options: session.options,
        deps: buildDeps(session)
      });
      session.result = clonePayload(result);
      session.status = 'completed';
      session.statusMessage = 'Completed successfully';
      appendSessionEvent(session, {
        type: 'session:completed',
        message: 'Autopilot completed successfully',
        payload: { status: 'completed' },
        meta: null
      });
    } catch (error) {
      const code = error?.code;
      const message = error?.message || 'Autopilot run failed';
      if (code === 'AUTOPILOT_CANCELLED' || session.control.cancelRequested) {
        session.status = 'cancelled';
        session.statusMessage = 'Cancelled';
        appendSessionEvent(session, {
          type: 'session:cancelled',
          message: error?.message || 'Autopilot cancelled',
          payload: null,
          meta: null
        });
      } else {
        markSessionFailed(session, message);
      }
    } finally {
      session.finishedAt = nowIso(session.control.now);
      session.control.running = false;
    }
  };

  session.control.workerPromise = Promise.resolve().then(worker).catch((error) => {
    console.error('[Autopilot Session] Worker crashed:', error);
    markSessionFailed(session, error?.message || 'Autopilot worker crashed');
    session.finishedAt = nowIso(session.control.now);
    session.control.running = false;
  });

  return session.control.workerPromise;
};

export const createAutopilotSession = async ({ projectId, prompt, options, uiSessionId, deps = defaultDeps } = {}) => {
  if (!projectId) {
    throw new Error('projectId is required');
  }
  const normalizedPrompt = sanitizePrompt(prompt);
  if (!normalizedPrompt) {
    throw new Error('prompt is required');
  }

  const sessionId = createId(deps.generateId);
  const createdAt = nowIso(deps.now);

  const session = {
    id: sessionId,
    projectId,
    prompt: normalizedPrompt,
    options: sanitizeOptions(options),
    uiSessionId: sanitizeUiSessionId(uiSessionId),
    status: 'pending',
    statusMessage: 'Waiting to start…',
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
    messages: [],
    events: [],
    eventsTrimmed: 0,
    nextEventId: 0,
    control: {
      pendingUpdates: [],
      cancelRequested: false,
      pauseRequested: false,
      running: false,
      workerPromise: null,
      autopilot: typeof deps.autopilot === 'function' ? deps.autopilot : null,
      now: typeof deps.now === 'function' ? deps.now : undefined
    }
  };

  sessions.set(sessionId, session);
  appendSessionEvent(session, {
    type: 'session:created',
    message: 'Autopilot session created',
    payload: { prompt: normalizedPrompt },
    meta: null
  });

  startAutopilotWorker(session);

  return summarizeSession(session);
};

export const getAutopilotSession = (sessionId, { includeEvents = true } = {}) => {
  const session = getSessionInternal(sessionId);
  return summarizeSession(session, { includeEvents });
};

const assertProjectOwnership = (session, projectId) => {
  if (projectId == null || session.projectId === projectId) {
    return;
  }
  const error = new Error('Autopilot session not found');
  error.code = AutopilotSessionErrorCodes.NOT_FOUND;
  throw error;
};

export const enqueueAutopilotSessionMessage = ({ sessionId, projectId, message, kind, metadata } = {}) => {
  if (!projectId) {
    throw new Error('projectId is required');
  }
  const normalizedMessage = sanitizePrompt(message);
  if (!normalizedMessage) {
    throw new Error('message is required');
  }

  const session = getSessionOrThrow(sessionId);
  assertProjectOwnership(session, projectId);

  const update = kind
    ? {
        kind,
        message: normalizedMessage,
        ...(metadata && typeof metadata === 'object' ? { metadata: clonePayload(metadata) } : {})
      }
    : normalizedMessage;

  session.control.pendingUpdates.push(update);
  session.messages.push({
    at: nowIso(session.control.now),
    kind: kind || null,
    message: normalizedMessage
  });

  if (kind === 'pause') {
    session.control.pauseRequested = true;
  } else if (kind === 'resume') {
    session.control.pauseRequested = false;
  } else if (kind === 'cancel') {
    session.control.cancelRequested = true;
  }

  appendSessionEvent(session, {
    type: 'user:message',
    message: normalizedMessage,
    payload: { kind: kind || null },
    meta: null
  });

  return summarizeSession(session);
};

export const cancelAutopilotSession = ({ sessionId, projectId, reason } = {}) => {
  if (!projectId) {
    throw new Error('projectId is required');
  }

  const session = getSessionOrThrow(sessionId);
  assertProjectOwnership(session, projectId);

  if (TERMINAL_STATUSES.has(session.status)) {
    return summarizeSession(session);
  }

  session.control.cancelRequested = true;
  appendSessionEvent(session, {
    type: 'session:cancel-requested',
    message: 'Cancellation requested',
    payload: reason ? { reason } : null,
    meta: null
  });

  return summarizeSession(session);
};

export const resumeAutopilotSessions = ({ projectId, uiSessionId, limit } = {}) => {
  if (!projectId) {
    throw new Error('projectId is required');
  }
  const normalizedUiSession = sanitizeUiSessionId(uiSessionId);
  if (!normalizedUiSession) {
    throw new Error('uiSessionId is required');
  }

  const limitValue = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 5;

  const candidates = [];
  for (const session of sessions.values()) {
    if (session.projectId !== projectId) {
      continue;
    }
    if (session.uiSessionId !== normalizedUiSession) {
      continue;
    }
    if (!ACTIVE_STATUSES.has(session.status)) {
      continue;
    }
    candidates.push(session);
  }

  const resumed = candidates.slice(0, limitValue).map((session) => {
    if (!session.control.running) {
      startAutopilotWorker(session);
    }
    return summarizeSession(session, { includeEvents: false });
  });

  return {
    success: true,
    resumed
  };
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForSessionInternal = async (sessionId, timeoutMs = 5000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const session = getSessionInternal(sessionId);
    if (!session) {
      return null;
    }
    if (TERMINAL_STATUSES.has(session.status)) {
      if (session.control.workerPromise) {
        try {
          await session.control.workerPromise;
        } catch {
          // Ignore worker errors – status already reflects outcome.
        }
      }
      return session;
    }
    await wait(10);
  }
  throw new Error('Timed out waiting for autopilot session to finish');
};

export const __testing = {
  reset: () => {
    sessions.clear();
  },
  getSessionInternal,
  waitForSessionInternal,
  startAutopilotWorker
};
