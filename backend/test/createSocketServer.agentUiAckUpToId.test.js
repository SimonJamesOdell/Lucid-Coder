import { describe, it, expect, beforeEach, vi } from 'vitest';

let lastIoInstance;

vi.mock('socket.io', () => {
  class MockServer {
    constructor(httpServer, options) {
      this.httpServer = httpServer;
      this.options = options;
      this._handlers = {};
      lastIoInstance = this;
    }

    on(event, handler) {
      this._handlers[event] = handler;
    }

    to() {
      return { emit: vi.fn() };
    }

    _connect(socket) {
      const handler = this._handlers.connection;
      if (typeof handler === 'function') {
        handler(socket);
      }
    }
  }

  return { Server: MockServer };
});

vi.mock('../services/agentUiState.js', () => ({
  acknowledgeUiCommands: vi.fn(() => ({ projectId: '1', sessionId: 's1', pruned: 3 })),
  getUiSnapshot: vi.fn(() => null),
  listUiCommands: vi.fn(() => []),
  upsertUiSnapshot: vi.fn()
}));

vi.mock('../services/jobRunner.js', () => ({
  jobEvents: { on: vi.fn() },
  listJobsForProject: vi.fn(() => [])
}));

vi.mock('../services/progressTracker.js', () => ({
  progressEvents: { on: vi.fn() },
  getProgressSnapshot: vi.fn(() => null)
}));

describe('createSocketServer agentUi:ack upToId handling', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    lastIoInstance = undefined;
  });

  it('acknowledges commands using payload.upToId when valid', async () => {
    const { attachSocketServer } = await import('../socket/createSocketServer.js');
    const io = attachSocketServer({}, { corsOrigin: true });

    const socketHandlers = {};
    const socket = {
      handshake: { query: {} },
      join: vi.fn(),
      emit: vi.fn(),
      on: (event, handler) => {
        socketHandlers[event] = handler;
      }
    };

    // Trigger connection handler registration.
    (lastIoInstance || io)._connect(socket);

    const ack = vi.fn();

    socketHandlers['agentUi:ack']({ projectId: 1, sessionId: '  s1  ', upToId: 7 }, ack);

    const { acknowledgeUiCommands } = await import('../services/agentUiState.js');

    expect(acknowledgeUiCommands).toHaveBeenCalledWith(1, 7, 's1');
    expect(ack).toHaveBeenCalledWith({ ok: true, pruned: { projectId: '1', sessionId: 's1', pruned: 3 } });
  });
});
