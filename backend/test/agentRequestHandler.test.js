import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../llm-client.js', () => ({
  llmClient: {
    generateResponse: vi.fn()
  }
}));

vi.mock('../services/questionToolAgent.js', () => ({
  answerProjectQuestion: vi.fn()
}));

describe('agentRequestHandler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('surfaces question-agent errors in the answer text', async () => {
    const { llmClient } = await import('../llm-client.js');
    const { answerProjectQuestion } = await import('../services/questionToolAgent.js');
    const { handleAgentRequest } = await import('../services/agentRequestHandler.js');

    llmClient.generateResponse.mockResolvedValue('{"kind":"question","answer":"ok"}');
    answerProjectQuestion.mockRejectedValue(new Error('LLM API Error: quota exceeded'));

    const result = await handleAgentRequest({
      projectId: 1,
      prompt: 'Why is the agent down?'
    });

    expect(result.answer).toContain('LLM API Error: quota exceeded');
    expect(result.meta.questionError).toBe('LLM API Error: quota exceeded');
  });
});
