const stateByProject = new Map();

const normalizeSessionId = (sessionId) => {
  if (typeof sessionId !== 'string') {
    return 'default';
  }
  const trimmed = sessionId.trim();
  return trimmed ? trimmed : 'default';
};

const buildStateKey = (projectId, sessionId) => `${String(projectId)}:${normalizeSessionId(sessionId)}`;

const ensureProjectState = (projectId, sessionId) => {
  const key = buildStateKey(projectId, sessionId);
  let entry = stateByProject.get(key);
  if (!entry) {
    entry = {
      snapshot: null,
      snapshotUpdatedAt: null,
      commands: [],
      nextCommandId: 1
    };
    stateByProject.set(key, entry);
  }
  return entry;
};

export const upsertUiSnapshot = (projectId, snapshot, sessionId) => {
  const entry = ensureProjectState(projectId, sessionId);
  entry.snapshot = snapshot;
  entry.snapshotUpdatedAt = new Date().toISOString();
  return {
    projectId: String(projectId),
    sessionId: normalizeSessionId(sessionId),
    updatedAt: entry.snapshotUpdatedAt,
    snapshot: entry.snapshot
  };
};

export const getUiSnapshot = (projectId, sessionId) => {
  const key = buildStateKey(projectId, sessionId);
  const entry = stateByProject.get(key);
  if (!entry || !entry.snapshot) {
    return null;
  }
  return {
    projectId: String(projectId),
    sessionId: normalizeSessionId(sessionId),
    updatedAt: entry.snapshotUpdatedAt,
    snapshot: entry.snapshot
  };
};

export const enqueueUiCommand = (projectId, command, sessionId) => {
  const entry = ensureProjectState(projectId, sessionId);

  const normalizedCommand = {
    id: entry.nextCommandId,
    createdAt: new Date().toISOString(),
    type: command.type,
    payload: command.payload ?? null,
    meta: command.meta ?? null
  };

  entry.nextCommandId += 1;
  entry.commands.push(normalizedCommand);

  return normalizedCommand;
};

export const listUiCommands = (projectId, afterId = 0, sessionId) => {
  const key = buildStateKey(projectId, sessionId);
  const entry = stateByProject.get(key);
  if (!entry) {
    return [];
  }

  const minimumId = Number.isFinite(afterId) ? afterId : 0;
  return entry.commands.filter((command) => command.id > minimumId);
};

export const acknowledgeUiCommands = (projectId, upToId, sessionId) => {
  const key = buildStateKey(projectId, sessionId);
  const entry = stateByProject.get(key);
  if (!entry) {
    return { projectId: String(projectId), sessionId: normalizeSessionId(sessionId), pruned: 0 };
  }

  const numericId = Number(upToId);
  if (!Number.isFinite(numericId) || numericId <= 0) {
    return { projectId: String(projectId), sessionId: normalizeSessionId(sessionId), pruned: 0 };
  }

  const before = entry.commands.length;
  entry.commands = entry.commands.filter((command) => command.id > numericId);
  const after = entry.commands.length;
  return { projectId: String(projectId), sessionId: normalizeSessionId(sessionId), pruned: before - after };
};

export const listKnownSessionIds = (projectId) => {
  const prefix = `${String(projectId)}:`;
  const ids = new Set();

  for (const key of stateByProject.keys()) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    const session = key.slice(prefix.length);
    const normalized = normalizeSessionId(session);
    ids.add(normalized);
  }

  return Array.from(ids);
};

export const __agentUiStateTestHelpers = {
  reset: () => {
    stateByProject.clear();
  },
  normalizeSessionId,
  buildStateKey
};
