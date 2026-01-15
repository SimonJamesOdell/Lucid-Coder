import { Server as SocketIOServer } from 'socket.io';
import { acknowledgeUiCommands, getUiSnapshot, listUiCommands, upsertUiSnapshot } from '../services/agentUiState.js';
import { jobEvents, listJobsForProject } from '../services/jobRunner.js';
import { getProgressSnapshot, progressEvents } from '../services/progressTracker.js';

const normalizeSessionId = (sessionId) => {
  if (typeof sessionId !== 'string') {
    return 'default';
  }
  const trimmed = sessionId.trim();
  return trimmed ? trimmed : 'default';
};

export const buildAgentUiRoom = (projectId, sessionId) => {
  return `agent-ui:${String(projectId)}:${normalizeSessionId(sessionId)}`;
};

export const buildJobsRoom = (projectId) => {
  return `jobs:${String(projectId)}`;
};

export const buildProgressRoom = (progressKey) => {
  return `progress:${String(progressKey)}`;
};

export const attachSocketServer = (httpServer, options = {}) => {
  const corsOrigin = options.corsOrigin ?? true;

  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: corsOrigin,
      methods: ['GET', 'POST'],
      credentials: true
    }
  });

  const emitJobsSync = (socket, projectId, ack) => {
    const jobs = listJobsForProject(projectId);
    const response = { ok: true, projectId: String(projectId), jobs };
    if (typeof ack === 'function') ack(response);
    socket.emit('jobs:sync', response);
  };

  const emitProgressSync = (socket, progressKey, ack) => {
    const snapshot = getProgressSnapshot(progressKey);
    const response = { ok: true, progressKey: String(progressKey), snapshot };
    if (typeof ack === 'function') ack(response);
    socket.emit('progress:sync', response);
  };

  jobEvents.on('job:created', (job) => {
    const room = buildJobsRoom(job.projectId);
    io.to(room).emit('jobs:job', { job });
    io.to(room).emit('job:created', job);
  });

  jobEvents.on('job:updated', (job) => {
    const room = buildJobsRoom(job.projectId);
    io.to(room).emit('jobs:job', { job });
    io.to(room).emit('job:updated', job);
  });

  jobEvents.on('job:log', (logEntry) => {
    const room = buildJobsRoom(logEntry.projectId);
    io.to(room).emit('jobs:log', logEntry);
    io.to(room).emit('job:log', logEntry);
  });

  progressEvents.on('progress:update', (update) => {
    io.to(buildProgressRoom(update.progressKey)).emit('progress:update', update);
  });

  io.on('connection', (socket) => {
    socket.on('jobs:join', (payload, ack) => {
      try {
        const { projectId } = payload || {};
        if (!projectId) {
          const error = { ok: false, error: 'projectId is required' };
          if (typeof ack === 'function') ack(error);
          return;
        }
        const room = buildJobsRoom(projectId);
        socket.join(room);
        emitJobsSync(socket, projectId, ack);
      } catch (error) {
        const response = { ok: false, error: error?.message || 'Failed to join jobs room' };
        if (typeof ack === 'function') ack(response);
      }
    });

    socket.on('progress:join', (payload, ack) => {
      try {
        const { progressKey } = payload || {};
        if (!progressKey) {
          const error = { ok: false, error: 'progressKey is required' };
          if (typeof ack === 'function') ack(error);
          return;
        }
        const room = buildProgressRoom(progressKey);
        socket.join(room);
        emitProgressSync(socket, progressKey, ack);
      } catch (error) {
        const response = { ok: false, error: error?.message || 'Failed to join progress room' };
        if (typeof ack === 'function') ack(response);
      }
    });

    socket.on('agentUi:join', (payload, ack) => {
      try {
        const rawSessionId = payload?.sessionId || socket?.handshake?.query?.sessionId;
        const { projectId } = payload || {};
        if (!projectId) {
          const error = { ok: false, error: 'projectId is required' };
          if (typeof ack === 'function') ack(error);
          return;
        }
        const sessionId = normalizeSessionId(rawSessionId);
        socket.data = { projectId, sessionId };
        const room = buildAgentUiRoom(projectId, sessionId);
        socket.join(room);
        const snapshot = getUiSnapshot(projectId, sessionId);
        const commands = listUiCommands(projectId, 0, sessionId);
        const response = { ok: true, projectId: String(projectId), sessionId, snapshot, commands };
        if (typeof ack === 'function') ack(response);
        socket.emit('agentUi:sync', response);
      } catch (error) {
        const response = { ok: false, error: error?.message || 'Failed to join agent UI room' };
        if (typeof ack === 'function') ack(response);
      }
    });

    socket.on('agentUi:snapshot', (payload, ack) => {
      try {
        const { projectId, sessionId, snapshot } = payload || {};
        if (!projectId || !snapshot || typeof snapshot !== 'object') {
          return;
        }
        const normalizedSessionId = normalizeSessionId(sessionId);
        upsertUiSnapshot(projectId, snapshot, normalizedSessionId);
        const room = buildAgentUiRoom(projectId, normalizedSessionId);
        io.to(room).emit('agentUi:snapshot', { projectId: String(projectId), sessionId: normalizedSessionId, snapshot });
        if (typeof ack === 'function') ack({ ok: true });
      } catch (error) {
        console.error('[Socket] agentUi:snapshot error:', error);
      }
    });

    socket.on('agentUi:ack', (payload, ack) => {
      try {
        const { projectId, sessionId } = payload || {};
        if (!projectId) {
          return;
        }
        const normalizedSessionId = normalizeSessionId(sessionId);

        const upToId = (() => {
          const candidate = Number(payload?.upToId);
          if (Number.isFinite(candidate) && candidate > 0) {
            return candidate;
          }

          const commandIds = payload?.commandIds;
          if (!Array.isArray(commandIds)) {
            return 0;
          }

          const numericIds = commandIds
            .map((value) => Number(value))
            .filter((value) => Number.isFinite(value) && value > 0);

          if (numericIds.length === 0) {
            return 0;
          }

          return Math.max(...numericIds);
        })();

        if (!upToId) {
          return;
        }

        const pruned = acknowledgeUiCommands(projectId, upToId, normalizedSessionId);
        if (typeof ack === 'function') ack({ ok: true, pruned });
      } catch (error) {
        console.error('[Socket] agentUi:ack error:', error);
      }
    });
  });

  return io;
};
