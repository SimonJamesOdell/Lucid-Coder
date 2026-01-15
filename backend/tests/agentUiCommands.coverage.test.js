import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/agentUiState.js', () => ({
  enqueueUiCommand: vi.fn(),
  listKnownSessionIds: vi.fn(() => [])
}));

vi.mock('../socket/createSocketServer.js', () => ({
  buildAgentUiRoom: vi.fn()
}));

describe('agentUiCommands.js coverage', () => {
  beforeEach(async () => {
    vi.clearAllMocks();

    const { enqueueUiCommand } = await import('../services/agentUiState.js');
    enqueueUiCommand.mockImplementation((projectId, command, sessionId) => ({
      id: 1,
      projectId,
      sessionId,
      ...command
    }));

    const { buildAgentUiRoom } = await import('../socket/createSocketServer.js');
    buildAgentUiRoom.mockImplementation((projectId, sessionId) => `agent-ui:${projectId}:${sessionId}`);
  });

  it('normalizes session ids', async () => {
    const { __testing } = await import('../services/agentUiCommands.js');

    expect(__testing.normalizeSessionId(undefined)).toBe('default');
    expect(__testing.normalizeSessionId(123)).toBe('default');
    expect(__testing.normalizeSessionId('   ')).toBe('default');
    expect(__testing.normalizeSessionId('session-a')).toBe('session-a');
    expect(__testing.normalizeSessionId('  session-b  ')).toBe('session-b');
  });

  it('validates required fields for sendAgentUiCommand', async () => {
    const { sendAgentUiCommand } = await import('../services/agentUiCommands.js');

    expect(() => sendAgentUiCommand()).toThrow(/projectId is required/i);
    expect(() => sendAgentUiCommand({ projectId: 'p1' })).toThrow(/command is required/i);
    expect(() => sendAgentUiCommand({ projectId: 'p1', command: 'nope' })).toThrow(/command is required/i);
    expect(() => sendAgentUiCommand({ projectId: 'p1', command: {} })).toThrow(/command\.type is required/i);
    expect(() => sendAgentUiCommand({ projectId: 'p1', command: { type: 123 } })).toThrow(/command\.type is required/i);
    expect(() => sendAgentUiCommand({ projectId: 'p1', command: { type: '   ' } })).toThrow(/command\.type is required/i);
  });

  it('enqueues and emits a command when io is provided', async () => {
    const { sendAgentUiCommand } = await import('../services/agentUiCommands.js');
    const { enqueueUiCommand } = await import('../services/agentUiState.js');
    const { buildAgentUiRoom } = await import('../socket/createSocketServer.js');

    const emit = vi.fn();
    const io = { to: vi.fn(() => ({ emit })) };

    const created = sendAgentUiCommand({
      io,
      projectId: 'p1',
      sessionId: '  session-a  ',
      command: { type: '  NAVIGATE_TAB  ' }
    });

    expect(enqueueUiCommand).toHaveBeenCalledWith(
      'p1',
      { type: 'NAVIGATE_TAB', payload: null, meta: null },
      'session-a'
    );

    expect(buildAgentUiRoom).toHaveBeenCalledWith('p1', 'session-a');
    expect(io.to).toHaveBeenCalledWith('agent-ui:p1:session-a');
    expect(emit).toHaveBeenCalledWith('agentUi:command', created);
  });

  it('does not emit when io is missing or invalid', async () => {
    const { sendAgentUiCommand } = await import('../services/agentUiCommands.js');

    expect(() =>
      sendAgentUiCommand({
        io: null,
        projectId: 'p1',
        command: { type: 'OPEN_FILE', payload: { filePath: 'x.js' } }
      })
    ).not.toThrow();

    expect(() =>
      sendAgentUiCommand({
        io: { to: null },
        projectId: 'p1',
        command: { type: 'OPEN_FILE', payload: { filePath: 'x.js' } }
      })
    ).not.toThrow();
  });

  it('buildAgentUiHelpers returns helpers that send the expected commands', async () => {
    const { buildAgentUiHelpers } = await import('../services/agentUiCommands.js');
    const { enqueueUiCommand } = await import('../services/agentUiState.js');

    const emit = vi.fn();
    const io = { to: vi.fn(() => ({ emit })) };

    const ui = buildAgentUiHelpers({ io, projectId: 'p1', sessionId: 123 });

    expect(ui.sessionId).toBe('default');

    ui.navigateTab('tests');
    ui.openFile('src/index.js');

    expect(enqueueUiCommand).toHaveBeenCalledWith(
      'p1',
      { type: 'NAVIGATE_TAB', payload: { tab: 'tests' }, meta: null },
      'default'
    );

    expect(enqueueUiCommand).toHaveBeenCalledWith(
      'p1',
      { type: 'OPEN_FILE', payload: { filePath: 'src/index.js' }, meta: null },
      'default'
    );
  });
});
