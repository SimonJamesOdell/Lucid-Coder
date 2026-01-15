import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../services/agentUiState.js', () => ({
  enqueueUiCommand: vi.fn(),
  listKnownSessionIds: vi.fn()
}));

vi.mock('../socket/createSocketServer.js', () => ({
  buildAgentUiRoom: vi.fn((projectId, sessionId) => `agentUi:${projectId}:${sessionId}`)
}));

describe('agentUiCommands', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('throws when required inputs are missing', async () => {
    const { sendAgentUiCommand } = await import('../services/agentUiCommands.js');

    expect(() => sendAgentUiCommand({ command: { type: 'OPEN_FILE' } })).toThrow(/projectId is required/i);
    expect(() => sendAgentUiCommand({ projectId: 123 })).toThrow(/command is required/i);
    expect(() => sendAgentUiCommand({ projectId: 123, command: {} })).toThrow(/command\.type is required/i);
    expect(() =>
      sendAgentUiCommand({ projectId: 123, command: { type: '   ' } })
    ).toThrow(/command\.type is required/i);
  });

  it('broadcasts to known sessions when sessionId is omitted', async () => {
    const { enqueueUiCommand, listKnownSessionIds } = await import('../services/agentUiState.js');
    listKnownSessionIds.mockReturnValue(['s1', 's2']);

    enqueueUiCommand
      .mockReturnValueOnce({ id: 1, type: 'OPEN_FILE' })
      .mockReturnValueOnce({ id: 2, type: 'OPEN_FILE' });

    const emit = vi.fn();
    const io = {
      to: vi.fn(() => ({ emit }))
    };

    const { sendAgentUiCommand } = await import('../services/agentUiCommands.js');

    const created = sendAgentUiCommand({
      io,
      projectId: 123,
      command: { type: 'OPEN_FILE', payload: { filePath: 'src/a.js' } }
    });

    expect(created).toEqual({ id: 1, type: 'OPEN_FILE' });
    expect(listKnownSessionIds).toHaveBeenCalledWith(123);

    expect(enqueueUiCommand).toHaveBeenCalledTimes(2);
    expect(io.to).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('falls back to default session when no sessions are known', async () => {
    const { enqueueUiCommand, listKnownSessionIds } = await import('../services/agentUiState.js');
    listKnownSessionIds.mockReturnValue([]);
    enqueueUiCommand.mockReturnValue({ id: 1, type: 'NAVIGATE_TAB' });

    const emit = vi.fn();
    const io = {
      to: vi.fn(() => ({ emit }))
    };

    const { sendAgentUiCommand } = await import('../services/agentUiCommands.js');

    const created = sendAgentUiCommand({
      io,
      projectId: 123,
      command: { type: 'NAVIGATE_TAB', payload: { tab: 'files' } }
    });

    expect(created).toEqual({ id: 1, type: 'NAVIGATE_TAB' });
    expect(enqueueUiCommand).toHaveBeenCalledWith(
      123,
      { type: 'NAVIGATE_TAB', payload: { tab: 'files' }, meta: null },
      'default'
    );
  });

  it('treats explicitly-provided blank sessionId as default', async () => {
    const { enqueueUiCommand, listKnownSessionIds } = await import('../services/agentUiState.js');
    listKnownSessionIds.mockReturnValue(['ignored']);
    enqueueUiCommand.mockReturnValue({ id: 99, type: 'OPEN_FILE' });

    const io = { to: vi.fn(() => ({ emit: vi.fn() })) };

    const { sendAgentUiCommand } = await import('../services/agentUiCommands.js');

    const created = sendAgentUiCommand({
      io,
      projectId: 123,
      sessionId: '   ',
      command: { type: 'OPEN_FILE', payload: { filePath: 'src/a.js' } }
    });

    expect(created).toEqual({ id: 99, type: 'OPEN_FILE' });
    expect(enqueueUiCommand).toHaveBeenCalledWith(
      123,
      { type: 'OPEN_FILE', payload: { filePath: 'src/a.js' }, meta: null },
      'default'
    );
  });

  it('buildAgentUiHelpers normalizes sessionId and routes helpers through sendAgentUiCommand', async () => {
    const { enqueueUiCommand } = await import('../services/agentUiState.js');
    enqueueUiCommand
      .mockReturnValueOnce({ id: 1, type: 'NAVIGATE_TAB' })
      .mockReturnValueOnce({ id: 2, type: 'OPEN_FILE' });

    const io = { to: vi.fn(() => ({ emit: vi.fn() })) };

    const { buildAgentUiHelpers } = await import('../services/agentUiCommands.js');

    const helpers = buildAgentUiHelpers({ io, projectId: 123, sessionId: '  s1  ' });
    expect(helpers.sessionId).toBe('s1');

    helpers.navigateTab('files');
    helpers.openFile('src/a.js');

    expect(enqueueUiCommand).toHaveBeenCalledWith(
      123,
      { type: 'NAVIGATE_TAB', payload: { tab: 'files' }, meta: null },
      's1'
    );
    expect(enqueueUiCommand).toHaveBeenCalledWith(
      123,
      { type: 'OPEN_FILE', payload: { filePath: 'src/a.js' }, meta: null },
      's1'
    );
  });
});
