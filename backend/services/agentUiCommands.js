import { enqueueUiCommand, listKnownSessionIds } from './agentUiState.js';
import { buildAgentUiRoom } from '../socket/createSocketServer.js';

const normalizeSessionId = (sessionId) => {
  if (typeof sessionId !== 'string') {
    return 'default';
  }
  const trimmed = sessionId.trim();
  return trimmed ? trimmed : 'default';
};

export const sendAgentUiCommand = (options = {}) => {
  const { io, projectId, sessionId, command } = options;
  if (!projectId) {
    throw new Error('projectId is required');
  }
  if (!command || typeof command !== 'object') {
    throw new Error('command is required');
  }
  if (typeof command.type !== 'string' || !command.type.trim()) {
    throw new Error('command.type is required');
  }

  const hasExplicitSessionId = Object.prototype.hasOwnProperty.call(options, 'sessionId');

  const sessions = (() => {
    if (hasExplicitSessionId) {
      return [normalizeSessionId(sessionId)];
    }

    const known = listKnownSessionIds(projectId);
    if (known.length > 0) {
      return known;
    }

    // Fallback so the function remains non-throwing and returns a command.
    return [normalizeSessionId(sessionId)];
  })();

  let firstCreated = null;

  for (const targetSessionId of sessions) {
    const created = enqueueUiCommand(
      projectId,
      { type: command.type.trim(), payload: command.payload ?? null, meta: command.meta ?? null },
      targetSessionId
    );

    if (!firstCreated) {
      firstCreated = created;
    }

    if (io && typeof io.to === 'function') {
      io.to(buildAgentUiRoom(projectId, targetSessionId)).emit('agentUi:command', created);
    }
  }

  return firstCreated;
};

export const buildAgentUiHelpers = ({ io, projectId, sessionId } = {}) => {
  const normalizedSessionId = normalizeSessionId(sessionId);

  const send = (type, payload) =>
    sendAgentUiCommand({ io, projectId, sessionId: normalizedSessionId, command: { type, payload } });

  return {
    sessionId: normalizedSessionId,
    navigateTab: (tab) => send('NAVIGATE_TAB', { tab }),
    openFile: (filePath) => send('OPEN_FILE', { filePath })
  };
};

export const __testing = {
  normalizeSessionId
};
