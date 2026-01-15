import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { startAgentUiBridge, __testOnly, DEFAULT_AGENT_UI_BRIDGE_INTERVAL_MS } from './agentUiBridge';
import { io } from 'socket.io-client';

vi.mock('socket.io-client', () => ({
  io: vi.fn()
}));

const createMockSocket = () => {
  const handlers = {};
  return {
    connected: false,
    on: vi.fn((event, handler) => {
      handlers[event] = handler;
    }),
    off: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
    __handlers: handlers
  };
};

const flushPromises = async (count = 10) => {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve();
  }
};

describe('agentUiBridge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('returns noop stop when missing projectId', () => {
    const stop = startAgentUiBridge({ getSnapshot: () => ({ ok: true }) });
    expect(typeof stop).toBe('function');
    stop();
    expect(io).not.toHaveBeenCalled();
  });

  test('joins on connect, executes commands, and ACKs max id', async () => {
    const socket = createMockSocket();
    io.mockReturnValue(socket);

    const executeCommand = vi.fn();
    const reportStatus = vi.fn();

    socket.emit.mockImplementation((event, payload, ack) => {
      if (event === 'agentUi:join' && typeof ack === 'function') {
        ack({
          commands: [
            { id: 1, type: 'NAVIGATE_TAB', payload: { tab: 'files' } },
            { id: 2, type: 'PREVIEW_RELOAD' }
          ]
        });
      }
    });

    const stop = startAgentUiBridge({
      projectId: 'p1',
      intervalMs: 500,
      getSnapshot: () => ({ activeTab: 'preview' }),
      executeCommand,
      onBackendStatusChange: reportStatus
    });

    socket.connected = true;
    socket.__handlers.connect();
    await flushPromises();

    expect(reportStatus).toHaveBeenCalledWith('online', undefined);
    expect(executeCommand).toHaveBeenCalledTimes(2);
    expect(socket.emit).toHaveBeenCalledWith(
      'agentUi:ack',
      expect.objectContaining({ projectId: 'p1', upToId: 2, sessionId: expect.any(String) })
    );

    stop();
  });

  test('handles command execution errors without stopping future handling', async () => {
    const socket = createMockSocket();
    io.mockReturnValue(socket);

    const executeCommand = vi.fn(() => {
      throw new Error('boom');
    });

    socket.emit.mockImplementation((event, payload, ack) => {
      if (event === 'agentUi:join' && typeof ack === 'function') {
        ack({ commands: [{ id: 1, type: 'X' }] });
      }
    });

    const stop = startAgentUiBridge({
      projectId: 2,
      intervalMs: 300,
      getSnapshot: () => ({ ok: true }),
      executeCommand
    });

    socket.connected = true;
    socket.__handlers.connect();
    await flushPromises();
    expect(executeCommand).toHaveBeenCalledTimes(1);

    socket.__handlers['agentUi:command']({ id: 2, type: 'Y' });
    expect(executeCommand).toHaveBeenCalledTimes(2);

    stop();
  });

  test('backs off when getSnapshot returns null', async () => {
    const socket = createMockSocket();
    io.mockReturnValue(socket);
    socket.connected = true;

    const getSnapshot = vi.fn(() => null);
    const stop = startAgentUiBridge({ projectId: 3, intervalMs: 400, getSnapshot });

    expect(socket.emit).not.toHaveBeenCalledWith('agentUi:snapshot', expect.anything());

    // Backoff after first idle tick is ~2x interval.
    await vi.advanceTimersByTimeAsync(799);
    await flushPromises();
    expect(getSnapshot).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2);
    await flushPromises();
    expect(getSnapshot).toHaveBeenCalledTimes(2);

    stop();
  });

  test('backs off when getSnapshot is not a function', async () => {
    const socket = createMockSocket();
    io.mockReturnValue(socket);
    socket.connected = true;

    const stop = startAgentUiBridge({ projectId: 'p6', intervalMs: 500 });

    expect(socket.emit).not.toHaveBeenCalledWith('agentUi:snapshot', expect.anything());

    await vi.advanceTimersByTimeAsync(999);
    await flushPromises();
    expect(socket.emit).not.toHaveBeenCalledWith('agentUi:snapshot', expect.anything());

    stop();
  });

  test('__testOnly.normalizeSessionId trims and defaults', () => {
    expect(__testOnly.normalizeSessionId()).toBe('default');
    expect(__testOnly.normalizeSessionId('')).toBe('default');
    expect(__testOnly.normalizeSessionId('  abc  ')).toBe('abc');
  });

  test('emits snapshot once, then backs off when snapshot is unchanged', async () => {
    const socket = createMockSocket();
    io.mockReturnValue(socket);
    socket.connected = true;

    const getSnapshot = vi.fn(() => ({ view: 'preview', selected: 1 }));
    const stop = startAgentUiBridge({ projectId: 'p-snap', intervalMs: 250, getSnapshot });

    // First tick emits immediately.
    expect(socket.emit).toHaveBeenCalledWith(
      'agentUi:snapshot',
      expect.objectContaining({ projectId: 'p-snap', sessionId: expect.any(String) })
    );

    const snapshotEmitCount = socket.emit.mock.calls.filter(([event]) => event === 'agentUi:snapshot').length;
    expect(snapshotEmitCount).toBe(1);

    // Next tick (250ms) sees identical snapshot -> no emit, and backs off.
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    const snapshotEmitCountAfter250 = socket.emit.mock.calls.filter(([event]) => event === 'agentUi:snapshot').length;
    expect(snapshotEmitCountAfter250).toBe(1);

    // Backoff should be ~2x (500ms) now.
    await vi.advanceTimersByTimeAsync(499);
    await flushPromises();
    const snapshotEmitCountAfterBackoff = socket.emit.mock.calls.filter(([event]) => event === 'agentUi:snapshot').length;
    expect(snapshotEmitCountAfterBackoff).toBe(1);

    stop();
  });

  test('skips snapshot posting when snapshot cannot be serialized', async () => {
    const socket = createMockSocket();
    io.mockReturnValue(socket);
    socket.connected = true;
    const circular = {};
    circular.self = circular;

    const stop = startAgentUiBridge({
      projectId: 'p-bad-snapshot',
      intervalMs: 250,
      getSnapshot: () => circular
    });

    // First tick happens immediately and should not emit when JSON serialization fails.
    expect(socket.emit).not.toHaveBeenCalledWith('agentUi:snapshot', expect.anything());

    stop();
  });

  test('reports offline when socket join fails', async () => {
    const socket = createMockSocket();
    io.mockReturnValue(socket);

    const onBackendStatusChange = vi.fn();

    socket.emit.mockImplementation((event, payload, ack) => {
      if (event === 'agentUi:join' && typeof ack === 'function') {
        ack({ error: 'join failed' });
      }
    });

    const stop = startAgentUiBridge({
      projectId: 'p-join-fail',
      onBackendStatusChange
    });

    socket.connected = true;
    socket.__handlers.connect();
    await flushPromises();

    expect(onBackendStatusChange).toHaveBeenCalledWith('online', undefined);
    expect(onBackendStatusChange).toHaveBeenCalledWith('offline', expect.any(Error));

    stop();
  });

  test('reports offline with default error when join payload is missing', async () => {
    const socket = createMockSocket();
    io.mockReturnValue(socket);

    const onBackendStatusChange = vi.fn();

    socket.emit.mockImplementation((event, payload, ack) => {
      if (event === 'agentUi:join' && typeof ack === 'function') {
        ack(null);
      }
    });

    const stop = startAgentUiBridge({ projectId: 'p-join-missing', onBackendStatusChange });

    socket.connected = true;
    socket.__handlers.connect();
    await flushPromises();

    expect(onBackendStatusChange).toHaveBeenCalledWith('online', undefined);
    expect(onBackendStatusChange).toHaveBeenCalledWith('offline', expect.any(Error));

    stop();
  });

  test('processes agentUi:sync commands and ACKs them', async () => {
    const socket = createMockSocket();
    io.mockReturnValue(socket);
    socket.connected = true;

    const executeCommand = vi.fn();
    const stop = startAgentUiBridge({ projectId: 'p-sync', executeCommand });

    socket.__handlers['agentUi:sync']({ commands: [{ id: 5, type: 'X' }] });
    await flushPromises();

    expect(executeCommand).toHaveBeenCalledWith(expect.objectContaining({ id: 5, type: 'X' }));
    expect(socket.emit).toHaveBeenCalledWith(
      'agentUi:ack',
      expect.objectContaining({ projectId: 'p-sync', upToId: 5, sessionId: expect.any(String) })
    );

    stop();
  });

  test('reports offline on connect_error', () => {
    const socket = createMockSocket();
    io.mockReturnValue(socket);
    const onBackendStatusChange = vi.fn();

    const stop = startAgentUiBridge({ projectId: 'p-connect-error', onBackendStatusChange });
    const error = new Error('connect_error');
    socket.__handlers.connect_error(error);

    expect(onBackendStatusChange).toHaveBeenCalledWith('offline', error);
    stop();
  });

  test('deduplicates repeated offline status reports', async () => {
    const socket = createMockSocket();
    io.mockReturnValue(socket);
    const onBackendStatusChange = vi.fn();

    socket.emit.mockImplementation((event, payload, ack) => {
      if (event === 'agentUi:join' && typeof ack === 'function') {
        ack({ commands: [] });
      }
    });

    const stop = startAgentUiBridge({ projectId: 'p-offline-2', onBackendStatusChange });

    const err1 = new Error('down');
    const err2 = new Error('still down');

    socket.__handlers.connect_error(err1);
    socket.__handlers.connect_error(err2);
    expect(onBackendStatusChange).toHaveBeenCalledTimes(1);
    expect(onBackendStatusChange).toHaveBeenCalledWith('offline', err1);

    socket.connected = true;
    socket.__handlers.connect();
    await flushPromises();

    expect(onBackendStatusChange).toHaveBeenCalledWith('online', undefined);
    expect(onBackendStatusChange).toHaveBeenCalledTimes(2);

    stop();
  });

  test('__testOnly.getOrCreateSessionId normalizes stored value', () => {
    sessionStorage.setItem('lucidcoder.uiSessionId', '  stored  ');
    expect(__testOnly.getOrCreateSessionId()).toBe('stored');
  });

  test('__testOnly.getOrCreateSessionId uses crypto.randomUUID when available', () => {
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { randomUUID: vi.fn(() => 'uuid-123') }
    });

    sessionStorage.removeItem('lucidcoder.uiSessionId');
    expect(__testOnly.getOrCreateSessionId()).toBe('uuid-123');
    expect(sessionStorage.getItem('lucidcoder.uiSessionId')).toBe('uuid-123');

    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: originalCrypto });
  });

  test('swallows onBackendStatusChange errors without breaking the bridge', async () => {
    const socket = createMockSocket();
    io.mockReturnValue(socket);

    const onBackendStatusChange = vi.fn(() => {
      throw new Error('status handler broke');
    });

    const executeCommand = vi.fn();

    socket.emit.mockImplementation((event, payload, ack) => {
      if (event === 'agentUi:join' && typeof ack === 'function') {
        ack({ commands: [] });
      }
    });

    const stop = startAgentUiBridge({
      projectId: 'p-status-errors',
      intervalMs: 300,
      getSnapshot: () => ({ activeTab: 'preview' }),
      onBackendStatusChange,
      executeCommand
    });

    socket.connected = true;
    expect(() => socket.__handlers.connect()).not.toThrow();
    await flushPromises();

    socket.__handlers['agentUi:sync']({ commands: [{ id: 1, type: 'X' }] });
    expect(executeCommand).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));

    stop();
  });

  test('__testOnly.buildSnapshotBody returns null when serialization fails', () => {
    const circular = {};
    circular.self = circular;
    expect(__testOnly.buildSnapshotBody({ projectId: 'p', sessionId: 's', snapshot: circular })).toBe(null);
  });

  test('__testOnly.getOrCreateSessionId falls back when randomUUID unavailable', () => {
    const originalCrypto = globalThis.crypto;
    const originalNow = Date.now;
    const originalRandom = Math.random;

    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
    Date.now = () => 1700000000000;
    Math.random = () => 0.5;

    sessionStorage.removeItem('lucidcoder.uiSessionId');
    const value = __testOnly.getOrCreateSessionId();
    expect(value).toMatch(/^ui-1700000000000-/);

    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: originalCrypto });
    Date.now = originalNow;
    Math.random = originalRandom;
  });

  test('__testOnly.getOrCreateSessionId returns default when sessionStorage throws', () => {
    const originalStorage = globalThis.sessionStorage;
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error('nope');
        },
        setItem: () => {
          throw new Error('nope');
        }
      }
    });

    expect(__testOnly.getOrCreateSessionId()).toBe('default');

    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: originalStorage
    });
  });

  test('__testOnly.getOrCreateSessionId returns default when window is undefined', () => {
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: undefined });

    expect(__testOnly.getOrCreateSessionId()).toBe('default');

    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  });

  test('defaults intervalMs when value is falsy/invalid', async () => {
    const socket = createMockSocket();
    io.mockReturnValue(socket);
    socket.connected = true;

    const getSnapshot = vi.fn(() => null);
    const stop = startAgentUiBridge({
      projectId: 'p5',
      intervalMs: 0,
      getSnapshot
    });

    expect(getSnapshot).toHaveBeenCalledTimes(1);

    // With idle backoff enabled, the next tick is scheduled at 2x the normalized interval.
    // Because intervalMs=0, the normalized interval should fall back to DEFAULT_AGENT_UI_BRIDGE_INTERVAL_MS.
    await vi.advanceTimersByTimeAsync(DEFAULT_AGENT_UI_BRIDGE_INTERVAL_MS * 2 - 1);
    await flushPromises();
    expect(getSnapshot).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2);
    await flushPromises();
    expect(getSnapshot).toHaveBeenCalledTimes(2);

    stop();
  });

  test('stop detaches handlers and disconnects', () => {
    const socket = createMockSocket();
    io.mockReturnValue(socket);
    socket.connected = true;

    const stop = startAgentUiBridge({ projectId: 'p-stop', getSnapshot: () => ({ ok: true }) });
    stop();

    expect(socket.off).toHaveBeenCalledWith('connect');
    expect(socket.off).toHaveBeenCalledWith('disconnect');
    expect(socket.off).toHaveBeenCalledWith('connect_error');
    expect(socket.off).toHaveBeenCalledWith('agentUi:sync');
    expect(socket.off).toHaveBeenCalledWith('agentUi:command');
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
  });

  test('reports offline on disconnect with default reason message', async () => {
    const socket = createMockSocket();
    io.mockReturnValue(socket);

    const onBackendStatusChange = vi.fn();
    const stop = startAgentUiBridge({ projectId: 'p-disconnect', onBackendStatusChange });

    socket.__handlers.disconnect();
    await flushPromises();

    expect(onBackendStatusChange).toHaveBeenCalledWith('offline', expect.any(Error));
    stop();
  });

  test('clears last snapshot tracking when disconnected so identical snapshots resend', async () => {
    const socket = createMockSocket();
    io.mockReturnValue(socket);

    socket.connected = true;
    const getSnapshot = vi.fn(() => ({ view: 'preview' }));
    const stop = startAgentUiBridge({ projectId: 'p-reset-snap', intervalMs: 250, getSnapshot });

    const firstSnapshotCount = socket.emit.mock.calls.filter(([event]) => event === 'agentUi:snapshot').length;
    expect(firstSnapshotCount).toBe(1);

    // Simulate a disconnect before the next tick.
    socket.connected = false;
    await vi.runOnlyPendingTimersAsync();
    await flushPromises();

    // Reconnect: identical snapshot should send again because lastSentSnapshotBody was cleared.
    socket.connected = true;
    await vi.runOnlyPendingTimersAsync();
    await flushPromises();

    const snapshotCountAfterReconnect = socket.emit.mock.calls.filter(([event]) => event === 'agentUi:snapshot').length;
    expect(snapshotCountAfterReconnect).toBe(2);

    stop();
  });
});
