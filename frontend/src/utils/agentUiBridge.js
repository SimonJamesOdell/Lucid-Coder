import { io } from 'socket.io-client';

export const DEFAULT_AGENT_UI_BRIDGE_INTERVAL_MS = 750;
const MAX_IDLE_AGENT_UI_BRIDGE_INTERVAL_MS = 5000;

const normalizeSessionId = (value) => {
  if (typeof value !== 'string') {
    return 'default';
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : 'default';
};

const getOrCreateSessionId = () => {
  if (typeof window === 'undefined') {
    return 'default';
  }

  try {
    const existing = sessionStorage.getItem('lucidcoder.uiSessionId');
    if (existing) {
      return normalizeSessionId(existing);
    }

    const generated =
      typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `ui-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    sessionStorage.setItem('lucidcoder.uiSessionId', generated);
    return normalizeSessionId(generated);
  } catch {
    return 'default';
  }
};

const buildSnapshotBody = ({ projectId, sessionId, snapshot }) => {
  try {
    return JSON.stringify({ projectId, sessionId, snapshot });
  } catch {
    return null;
  }
};

export const startAgentUiBridge = (options = {}) => {
  const {
    projectId,
    getSnapshot,
    executeCommand,
    onBackendStatusChange,
    intervalMs = DEFAULT_AGENT_UI_BRIDGE_INTERVAL_MS
  } = options;

  if (!projectId) {
    return () => {};
  }

  const sessionId = getOrCreateSessionId();
  const normalizedInterval = Math.max(250, Number(intervalMs) || DEFAULT_AGENT_UI_BRIDGE_INTERVAL_MS);

  let stopped = false;
  let lastReportedStatus = 'unknown';
  let lastSeenCommandId = 0;
  let lastAckedCommandId = 0;
  let idleStreak = 0;
  let lastSentSnapshotBody = null;
  let timerId;

  const reportStatus = (status, error) => {
    if (lastReportedStatus === status) {
      return;
    }
    lastReportedStatus = status;
    if (typeof onBackendStatusChange === 'function') {
      try {
        onBackendStatusChange(status, error);
      } catch {
        // Ignore reporting errors.
      }
    }
  };

  const computeIdleDelayMs = () => {
    const exponent = Math.min(Math.max(1, idleStreak), 3);
    return Math.min(MAX_IDLE_AGENT_UI_BRIDGE_INTERVAL_MS, normalizedInterval * Math.pow(2, exponent));
  };

  const socket = io({
    autoConnect: true,
    reconnection: true,
    transports: ['polling'],
    upgrade: false,
    auth: {
      sessionId
    }
  });

  const ackUpTo = (upToId) => {
    const numericId = Number(upToId);
    lastAckedCommandId = numericId;
    socket.emit('agentUi:ack', { projectId, sessionId, upToId: numericId });
  };

  const handleCommands = (commands) => {
    if (!Array.isArray(commands) || commands.length === 0) {
      return;
    }

    let maxId = lastSeenCommandId;
    for (const command of commands) {
      const id = Number(command?.id);
      if (Number.isFinite(id) && id > maxId) {
        maxId = id;
      }
      if (typeof executeCommand === 'function') {
        try {
          executeCommand(command);
        } catch {
          // Ignore command handler errors.
        }
      }
    }

    if (maxId > lastSeenCommandId) {
      lastSeenCommandId = maxId;
      ackUpTo(maxId);
    }
  };

  const join = () => {
    socket.emit('agentUi:join', { projectId, sessionId }, (payload) => {
      if (!payload || payload.error) {
        reportStatus('offline', new Error(payload?.error || 'Socket join failed'));
        return;
      }
      reportStatus('online');
      handleCommands(payload.commands);
    });
  };

  socket.on('connect', () => {
    reportStatus('online');
    join();
  });

  socket.on('disconnect', (reason) => {
    reportStatus('offline', new Error(reason || 'Socket disconnected'));
  });

  socket.on('connect_error', (error) => {
    reportStatus('offline', error);
  });

  socket.on('agentUi:sync', (payload) => {
    if (payload && !payload.error) {
      reportStatus('online');
      handleCommands(payload.commands);
    }
  });

  socket.on('agentUi:command', (command) => {
    handleCommands([command]);
  });

  const scheduleNext = (delayMs) => {
    if (stopped) {
      return;
    }
    if (timerId) {
      clearTimeout(timerId);
    }
    timerId = setTimeout(tick, Math.max(0, Number(delayMs)));
  };

  const tick = () => {
    let nextDelay = normalizedInterval;
    try {
      if (!socket.connected) {
        idleStreak = 0;
        lastSentSnapshotBody = null;
        nextDelay = normalizedInterval;
        return;
      }

      const snapshot = typeof getSnapshot === 'function' ? getSnapshot() : null;
      if (!snapshot || typeof snapshot !== 'object') {
        idleStreak += 1;
        nextDelay = computeIdleDelayMs();
        return;
      }

      const body = buildSnapshotBody({ projectId, sessionId, snapshot });
      if (!body) {
        idleStreak += 1;
        nextDelay = computeIdleDelayMs();
        return;
      }

      if (body === lastSentSnapshotBody) {
        idleStreak += 1;
        nextDelay = computeIdleDelayMs();
        return;
      }

      lastSentSnapshotBody = body;
      idleStreak = 0;
      socket.emit('agentUi:snapshot', { projectId, sessionId, snapshot });
      nextDelay = normalizedInterval;
    } finally {
      scheduleNext(nextDelay);
    }
  };

  tick();

  return () => {
    stopped = true;
    if (timerId) {
      clearTimeout(timerId);
    }
    // Ensure the scheduleNext stopped-guard is exercised.
    scheduleNext(0);
    socket.off('connect');
    socket.off('disconnect');
    socket.off('connect_error');
    socket.off('agentUi:sync');
    socket.off('agentUi:command');
    socket.disconnect();
  };
};

export const __testOnly = {
  normalizeSessionId,
  getOrCreateSessionId,
  buildSnapshotBody
};
