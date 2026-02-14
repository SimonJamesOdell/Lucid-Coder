import { describe, expect, test, vi } from 'vitest';
import {
  createChatMessage,
  callAgentWithTimeout,
  resolveAgentErrorMessage,
  buildAgentDiagnostics
} from '../components/chatPanel/agentUtils.js';

describe('chat panel agent utils', () => {
  test('createChatMessage builds expected shape', () => {
    const message = createChatMessage('assistant', 'hello', { variant: 'status' });
    expect(message).toEqual(expect.objectContaining({
      sender: 'assistant',
      text: 'hello',
      variant: 'status'
    }));
    expect(message.id).toContain('assistant-');
    expect(message.timestamp instanceof Date).toBe(true);
  });

  test('callAgentWithTimeout resolves request result', async () => {
    const result = await callAgentWithTimeout({
      projectId: 'p1',
      prompt: 'hi',
      timeoutMs: 100,
      agentRequestFn: vi.fn(async () => ({ ok: true }))
    });
    expect(result).toEqual({ ok: true });
  });

  test('resolveAgentErrorMessage handles timeout and backend configured errors', () => {
    expect(resolveAgentErrorMessage(new Error('Agent request timed out'))).toContain('too long');
    expect(resolveAgentErrorMessage({ response: { data: { error: 'LLM is not configured', reason: 'missing key' } } })).toContain('Configure it in Settings');
  });

  test('buildAgentDiagnostics formats metadata entries', () => {
    const diagnostics = buildAgentDiagnostics({
      classificationError: 'c',
      questionError: 'q',
      planningError: 'p',
      fallbackPlanningError: 'f'
    });
    expect(diagnostics).toBe('Diagnostics: classification: c | question: q | planning: p | fallback planning: f');
    expect(buildAgentDiagnostics(null)).toBeNull();
  });
});
