import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

class FakeSocket {
  constructor() {
    this.handlers = new Map();
    this.joinedRooms = [];
    this.emits = [];
    this.handshake = { query: {} };
    this.data = undefined;
  }

  on(event, handler) {
    this.handlers.set(event, handler);
  }

  join(room) {
    this.joinedRooms.push(room);
  }

  emit(event, payload) {
    this.emits.push({ event, payload });
  }

  trigger(event, payload, ack) {
    const handler = this.handlers.get(event);
    if (!handler) {
      throw new Error(`No handler for ${event}`);
    }
    return handler(payload, ack);
  }
}

class FakeSocketIOServer {
  static instances = [];

  constructor(httpServer, options) {
    this.httpServer = httpServer;
    this.options = options;

    this.handlers = new Map();
    this.toCalls = [];
    this.roomEmits = [];

    FakeSocketIOServer.instances.push(this);
  }

  on(event, handler) {
    this.handlers.set(event, handler);
  }

  to(room) {
    this.toCalls.push(room);
    return {
      emit: (event, payload) => {
        this.roomEmits.push({ room, event, payload });
      }
    };
  }

  connect(socket) {
    const handler = this.handlers.get('connection');
    if (!handler) {
      throw new Error('No connection handler registered');
    }
    handler(socket);
  }
}

const jobEvents = new EventEmitter();
const progressEvents = new EventEmitter();

vi.mock('socket.io', () => ({
  Server: FakeSocketIOServer
}));

vi.mock('../services/jobRunner.js', () => ({
  jobEvents,
  listJobsForProject: vi.fn(() => [{ id: 'job-1' }])
}));

vi.mock('../services/progressTracker.js', () => ({
  progressEvents,
  getProgressSnapshot: vi.fn(() => ({ step: 'scaffolding' }))
}));

vi.mock('../services/agentUiState.js', () => ({
  acknowledgeUiCommands: vi.fn(() => ({ projectId: 'p1', sessionId: 's1', pruned: 2 })),
  getUiSnapshot: vi.fn(() => ({ snapshot: true })),
  listUiCommands: vi.fn(() => [{ id: 1, type: 'X' }]),
  upsertUiSnapshot: vi.fn(() => ({ projectId: 'p1', sessionId: 's1', snapshot: { ok: true } }))
}));

describe('createSocketServer', () => {
  beforeEach(() => {
    FakeSocketIOServer.instances.length = 0;
    jobEvents.removeAllListeners();
    progressEvents.removeAllListeners();
    vi.clearAllMocks();
  });

  afterEach(() => {
    jobEvents.removeAllListeners();
    progressEvents.removeAllListeners();
  });

  it('builds rooms and normalizes sessionId', async () => {
    const {
      buildAgentUiRoom,
      buildJobsRoom,
      buildProgressRoom
    } = await import('../socket/createSocketServer.js');

    expect(buildAgentUiRoom('p1')).toBe('agent-ui:p1:default');
    expect(buildAgentUiRoom('p1', 123)).toBe('agent-ui:p1:default');
    expect(buildAgentUiRoom('p1', '   ')).toBe('agent-ui:p1:default');
    expect(buildAgentUiRoom(2, '  s1  ')).toBe('agent-ui:2:s1');

    expect(buildJobsRoom('p1')).toBe('jobs:p1');
    expect(buildProgressRoom('k1')).toBe('progress:k1');
  });

  it('attaches a socket server with default corsOrigin and forwards job/progress events to rooms', async () => {
    const { attachSocketServer, buildJobsRoom, buildProgressRoom } = await import('../socket/createSocketServer.js');

    const httpServer = {};
    const io = attachSocketServer(httpServer);

    expect(FakeSocketIOServer.instances.length).toBe(1);
    const instance = FakeSocketIOServer.instances[0];
    expect(instance.httpServer).toBe(httpServer);
    expect(instance.options.cors.origin).toBe(true);

    jobEvents.emit('job:created', { projectId: 7, id: 'j1' });
    jobEvents.emit('job:updated', { projectId: 7, id: 'j1' });
    jobEvents.emit('job:log', { projectId: 7, message: 'hi' });
    progressEvents.emit('progress:update', { progressKey: 'k1', step: 'x' });

    expect(instance.toCalls).toContain(buildJobsRoom(7));
    expect(instance.toCalls).toContain(buildProgressRoom('k1'));

    expect(instance.roomEmits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ room: buildJobsRoom(7), event: 'job:created' }),
        expect.objectContaining({ room: buildJobsRoom(7), event: 'job:updated' }),
        expect.objectContaining({ room: buildJobsRoom(7), event: 'job:log' }),
        expect.objectContaining({ room: buildProgressRoom('k1'), event: 'progress:update' })
      ])
    );

    expect(io).toBe(instance);
  });

  it('respects explicit corsOrigin override', async () => {
    const { attachSocketServer } = await import('../socket/createSocketServer.js');

    attachSocketServer({}, { corsOrigin: 'https://example.invalid' });

    expect(FakeSocketIOServer.instances[0].options.cors.origin).toBe('https://example.invalid');
  });

  it('handles jobs:join with validation and emits sync (also acks)', async () => {
    const { attachSocketServer } = await import('../socket/createSocketServer.js');
    const { listJobsForProject } = await import('../services/jobRunner.js');

    attachSocketServer({});
    const io = FakeSocketIOServer.instances[0];
    const socket = new FakeSocket();
    io.connect(socket);

    const ackMissing = vi.fn();
    socket.trigger('jobs:join', {}, ackMissing);
    expect(ackMissing).toHaveBeenCalledWith({ ok: false, error: 'projectId is required' });
    expect(socket.joinedRooms).toEqual([]);

    const ack = vi.fn();
    socket.trigger('jobs:join', { projectId: 'p1' }, ack);

    expect(listJobsForProject).toHaveBeenCalledWith('p1');
    expect(socket.joinedRooms).toEqual(['jobs:p1']);

    expect(ack).toHaveBeenCalledWith({ ok: true, projectId: 'p1', jobs: [{ id: 'job-1' }] });
    expect(socket.emits.some((entry) => entry.event === 'jobs:sync')).toBe(true);
  });

  it('acks a helpful error when jobs:join throws', async () => {
    const { attachSocketServer } = await import('../socket/createSocketServer.js');

    attachSocketServer({});
    const io = FakeSocketIOServer.instances[0];
    const socket = new FakeSocket();
    socket.join = () => {
      throw new Error('join failed');
    };
    io.connect(socket);

    const ack = vi.fn();
    socket.trigger('jobs:join', { projectId: 'p1' }, ack);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: 'join failed' });
  });

  it('uses default jobs:join error message when error has no message', async () => {
    const { attachSocketServer } = await import('../socket/createSocketServer.js');

    attachSocketServer({});
    const io = FakeSocketIOServer.instances[0];
    const socket = new FakeSocket();
    socket.join = () => {
      throw {};
    };
    io.connect(socket);

    const ack = vi.fn();
    socket.trigger('jobs:join', { projectId: 'p1' }, ack);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: 'Failed to join jobs room' });
  });

  it('handles progress:join with validation and emits sync (also acks)', async () => {
    const { attachSocketServer } = await import('../socket/createSocketServer.js');
    const { getProgressSnapshot } = await import('../services/progressTracker.js');

    attachSocketServer({});
    const io = FakeSocketIOServer.instances[0];
    const socket = new FakeSocket();
    io.connect(socket);

    const ackMissing = vi.fn();
    socket.trigger('progress:join', {}, ackMissing);
    expect(ackMissing).toHaveBeenCalledWith({ ok: false, error: 'progressKey is required' });
    expect(socket.joinedRooms).toEqual([]);

    const ack = vi.fn();
    socket.trigger('progress:join', { progressKey: 'k1' }, ack);

    expect(getProgressSnapshot).toHaveBeenCalledWith('k1');
    expect(socket.joinedRooms).toEqual(['progress:k1']);

    expect(ack).toHaveBeenCalledWith({ ok: true, progressKey: 'k1', snapshot: { step: 'scaffolding' } });
    expect(socket.emits.some((entry) => entry.event === 'progress:sync')).toBe(true);
  });

  it('handles agentUi:join and normalizes sessionId from payload/handshake', async () => {
    const { attachSocketServer } = await import('../socket/createSocketServer.js');
    const agentUiState = await import('../services/agentUiState.js');

    attachSocketServer({});
    const io = FakeSocketIOServer.instances[0];
    const socket = new FakeSocket();
    socket.handshake.query.sessionId = '  from-handshake  ';
    io.connect(socket);

    const ackMissing = vi.fn();
    socket.trigger('agentUi:join', { sessionId: 's1' }, ackMissing);
    expect(ackMissing).toHaveBeenCalledWith({ ok: false, error: 'projectId is required' });

    const ack = vi.fn();
    socket.trigger('agentUi:join', { projectId: 'p1' }, ack);

    expect(socket.data).toEqual({ projectId: 'p1', sessionId: 'from-handshake' });
    expect(socket.joinedRooms).toContain('agent-ui:p1:from-handshake');

    expect(agentUiState.getUiSnapshot).toHaveBeenCalledWith('p1', 'from-handshake');
    expect(agentUiState.listUiCommands).toHaveBeenCalledWith('p1', 0, 'from-handshake');

    expect(ack).toHaveBeenCalledWith({
      ok: true,
      projectId: 'p1',
      sessionId: 'from-handshake',
      snapshot: { snapshot: true },
      commands: [{ id: 1, type: 'X' }]
    });

    expect(socket.emits.some((entry) => entry.event === 'agentUi:sync')).toBe(true);
  });

  it('defaults agentUi:join sessionId when none is provided', async () => {
    const { attachSocketServer } = await import('../socket/createSocketServer.js');

    attachSocketServer({});
    const io = FakeSocketIOServer.instances[0];
    const socket = new FakeSocket();
    io.connect(socket);

    const ack = vi.fn();
    socket.trigger('agentUi:join', { projectId: 'p1' }, ack);

    expect(socket.data).toEqual({ projectId: 'p1', sessionId: 'default' });
    expect(socket.joinedRooms).toContain('agent-ui:p1:default');
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'default' }));
  });

  it('acks a helpful error when progress:join throws', async () => {
    const { attachSocketServer } = await import('../socket/createSocketServer.js');

    attachSocketServer({});
    const io = FakeSocketIOServer.instances[0];
    const socket = new FakeSocket();
    socket.join = () => {
      throw new Error('join failed');
    };
    io.connect(socket);

    const ack = vi.fn();
    socket.trigger('progress:join', { progressKey: 'k1' }, ack);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: 'join failed' });
  });

  it('uses default progress:join error message when error has no message', async () => {
    const { attachSocketServer } = await import('../socket/createSocketServer.js');

    attachSocketServer({});
    const io = FakeSocketIOServer.instances[0];
    const socket = new FakeSocket();
    socket.join = () => {
      throw {};
    };
    io.connect(socket);

    const ack = vi.fn();
    socket.trigger('progress:join', { progressKey: 'k1' }, ack);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: 'Failed to join progress room' });
  });

  it('uses default agentUi:join error message when error has no message', async () => {
    const { attachSocketServer } = await import('../socket/createSocketServer.js');
    const agentUiState = await import('../services/agentUiState.js');

    agentUiState.getUiSnapshot.mockImplementationOnce(() => {
      throw {};
    });

    attachSocketServer({});
    const io = FakeSocketIOServer.instances[0];
    const socket = new FakeSocket();
    io.connect(socket);

    const ack = vi.fn();
    socket.trigger('agentUi:join', { projectId: 'p1', sessionId: 's1' }, ack);
    expect(ack).toHaveBeenCalledWith({ ok: false, error: 'Failed to join agent UI room' });
  });

  it('does not require ack callbacks for join/snapshot/ack flows', async () => {
    const { attachSocketServer } = await import('../socket/createSocketServer.js');
    const agentUiState = await import('../services/agentUiState.js');

    attachSocketServer({});
    const io = FakeSocketIOServer.instances[0];
    const socket = new FakeSocket();
    io.connect(socket);

    expect(() => socket.trigger('jobs:join', { projectId: 'p1' })).not.toThrow();
    expect(() => socket.trigger('progress:join', { progressKey: 'k1' })).not.toThrow();
    expect(() => socket.trigger('agentUi:join', { projectId: 'p1', sessionId: '  s1  ' })).not.toThrow();

    expect(socket.emits.some((entry) => entry.event === 'jobs:sync')).toBe(true);
    expect(socket.emits.some((entry) => entry.event === 'progress:sync')).toBe(true);
    expect(socket.emits.some((entry) => entry.event === 'agentUi:sync')).toBe(true);

    expect(() => socket.trigger('agentUi:snapshot', { projectId: 'p1', sessionId: 's1', snapshot: { ok: true } })).not.toThrow();
    expect(() => socket.trigger('agentUi:ack', { projectId: 'p1', sessionId: 's1', commandIds: [1] })).not.toThrow();
    expect(agentUiState.upsertUiSnapshot).toHaveBeenCalled();
    expect(agentUiState.acknowledgeUiCommands).toHaveBeenCalled();
  });

  it('does not require ack callbacks for validation/errors in join flows', async () => {
    const { attachSocketServer } = await import('../socket/createSocketServer.js');
    const agentUiState = await import('../services/agentUiState.js');

    attachSocketServer({});
    const io = FakeSocketIOServer.instances[0];
    const socket = new FakeSocket();
    io.connect(socket);

    expect(() => socket.trigger('jobs:join', {})).not.toThrow();
    expect(() => socket.trigger('progress:join', {})).not.toThrow();
    expect(() => socket.trigger('agentUi:join', { sessionId: 's1' })).not.toThrow();

    agentUiState.getUiSnapshot.mockImplementationOnce(() => {
      throw new Error('snapshot failed');
    });
    expect(() => socket.trigger('agentUi:join', { projectId: 'p1', sessionId: 's1' })).not.toThrow();

    socket.join = () => {
      throw new Error('join failed');
    };
    expect(() => socket.trigger('jobs:join', { projectId: 'p1' })).not.toThrow();
    expect(() => socket.trigger('progress:join', { progressKey: 'k1' })).not.toThrow();
  });

  it('handles undefined payloads for join events (jobs/progress/agentUi)', async () => {
    const { attachSocketServer } = await import('../socket/createSocketServer.js');

    attachSocketServer({});
    const io = FakeSocketIOServer.instances[0];
    const socket = new FakeSocket();
    io.connect(socket);

    const jobsAck = vi.fn();
    socket.trigger('jobs:join', undefined, jobsAck);
    expect(jobsAck).toHaveBeenCalledWith({ ok: false, error: 'projectId is required' });
    expect(() => socket.trigger('jobs:join')).not.toThrow();

    const progressAck = vi.fn();
    socket.trigger('progress:join', undefined, progressAck);
    expect(progressAck).toHaveBeenCalledWith({ ok: false, error: 'progressKey is required' });
    expect(() => socket.trigger('progress:join')).not.toThrow();

    const agentUiAck = vi.fn();
    socket.trigger('agentUi:join', undefined, agentUiAck);
    expect(agentUiAck).toHaveBeenCalledWith({ ok: false, error: 'projectId is required' });
    expect(() => socket.trigger('agentUi:join')).not.toThrow();
  });

  it('covers missing projectId early-return branches for agentUi events', async () => {
    const { attachSocketServer } = await import('../socket/createSocketServer.js');
    const agentUiState = await import('../services/agentUiState.js');

    attachSocketServer({});
    const io = FakeSocketIOServer.instances[0];
    const socket = new FakeSocket();
    io.connect(socket);

    const ack = vi.fn();
    socket.trigger('agentUi:snapshot', { sessionId: 's1', snapshot: { ok: true } }, ack);
    socket.trigger('agentUi:ack', { sessionId: 's1', commandIds: [1] }, ack);

    expect(agentUiState.upsertUiSnapshot).not.toHaveBeenCalled();
    expect(agentUiState.acknowledgeUiCommands).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
  });

  it('handles undefined payloads for agentUi:snapshot and agentUi:ack', async () => {
    const { attachSocketServer } = await import('../socket/createSocketServer.js');
    const agentUiState = await import('../services/agentUiState.js');

    attachSocketServer({});
    const io = FakeSocketIOServer.instances[0];
    const socket = new FakeSocket();
    io.connect(socket);

    expect(() => socket.trigger('agentUi:snapshot')).not.toThrow();
    expect(() => socket.trigger('agentUi:ack')).not.toThrow();

    expect(agentUiState.upsertUiSnapshot).not.toHaveBeenCalled();
    expect(agentUiState.acknowledgeUiCommands).not.toHaveBeenCalled();
  });

  it('acks a helpful error when agentUi:join throws', async () => {
    const { attachSocketServer } = await import('../socket/createSocketServer.js');
    const agentUiState = await import('../services/agentUiState.js');

    agentUiState.getUiSnapshot.mockImplementationOnce(() => {
      throw new Error('snapshot failed');
    });

    attachSocketServer({});
    const io = FakeSocketIOServer.instances[0];
    const socket = new FakeSocket();
    io.connect(socket);

    const ack = vi.fn();
    socket.trigger('agentUi:join', { projectId: 'p1', sessionId: 's1' }, ack);

    expect(ack).toHaveBeenCalledWith({ ok: false, error: 'snapshot failed' });
  });

  it('handles agentUi:snapshot and agentUi:ack happy paths', async () => {
    const { attachSocketServer } = await import('../socket/createSocketServer.js');
    const agentUiState = await import('../services/agentUiState.js');

    attachSocketServer({});
    const io = FakeSocketIOServer.instances[0];
    const socket = new FakeSocket();
    io.connect(socket);

    const snapshotAck = vi.fn();
    socket.trigger(
      'agentUi:snapshot',
      { projectId: 'p1', sessionId: '  s1  ', snapshot: { ok: true } },
      snapshotAck
    );

    expect(agentUiState.upsertUiSnapshot).toHaveBeenCalledWith('p1', { ok: true }, 's1');
    expect(io.toCalls).toContain('agent-ui:p1:s1');
    expect(snapshotAck).toHaveBeenCalledWith({ ok: true });

    const ackAck = vi.fn();
    socket.trigger(
      'agentUi:ack',
      { projectId: 'p1', sessionId: '  s1  ', commandIds: [1, '2'] },
      ackAck
    );

    expect(agentUiState.acknowledgeUiCommands).toHaveBeenCalledWith('p1', 2, 's1');
    expect(ackAck).toHaveBeenCalledWith({ ok: true, pruned: { projectId: 'p1', sessionId: 's1', pruned: 2 } });
  });

  it('swallows errors in agentUi:snapshot and agentUi:ack handlers', async () => {
    const { attachSocketServer } = await import('../socket/createSocketServer.js');
    const agentUiState = await import('../services/agentUiState.js');

    vi.spyOn(console, 'error').mockImplementation(() => {});

    agentUiState.upsertUiSnapshot.mockImplementationOnce(() => {
      throw new Error('boom');
    });

    attachSocketServer({});
    const io = FakeSocketIOServer.instances[0];
    const socket = new FakeSocket();
    io.connect(socket);

    expect(() =>
      socket.trigger('agentUi:snapshot', { projectId: 'p1', sessionId: 's1', snapshot: { ok: true } })
    ).not.toThrow();

    agentUiState.acknowledgeUiCommands.mockImplementationOnce(() => {
      throw new Error('boom');
    });

    expect(() =>
      socket.trigger('agentUi:ack', { projectId: 'p1', sessionId: 's1', commandIds: [1] })
    ).not.toThrow();

    expect(console.error).toHaveBeenCalled();
  });

  it('early-returns on invalid agentUi payloads', async () => {
    const { attachSocketServer } = await import('../socket/createSocketServer.js');
    const agentUiState = await import('../services/agentUiState.js');

    attachSocketServer({});
    const io = FakeSocketIOServer.instances[0];
    const socket = new FakeSocket();
    io.connect(socket);

    const ack = vi.fn();

    expect(() => socket.trigger('agentUi:snapshot', { projectId: 'p1', sessionId: 's1' }, ack)).not.toThrow();
    expect(() => socket.trigger('agentUi:snapshot', { projectId: 'p1', sessionId: 's1', snapshot: null }, ack)).not.toThrow();
    expect(() => socket.trigger('agentUi:snapshot', { projectId: 'p1', sessionId: 's1', snapshot: 'nope' }, ack)).not.toThrow();

    expect(agentUiState.upsertUiSnapshot).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();

    expect(() => socket.trigger('agentUi:ack', { projectId: 'p1', sessionId: 's1' }, ack)).not.toThrow();
    expect(() => socket.trigger('agentUi:ack', { projectId: 'p1', sessionId: 's1', commandIds: 'nope' }, ack)).not.toThrow();
    expect(() => socket.trigger('agentUi:ack', { projectId: 'p1', sessionId: 's1', commandIds: [0, 'x', -1] }, ack)).not.toThrow();

    expect(agentUiState.acknowledgeUiCommands).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
  });
});
