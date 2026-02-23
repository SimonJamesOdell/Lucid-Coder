import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../llm-client.js', () => ({
  llmClient: {
    generateResponse: vi.fn()
  }
}));

vi.mock('../services/questionToolAgent.js', () => ({
  answerProjectQuestion: vi.fn()
}));

vi.mock('../services/agentOrchestrator.js', () => ({
  planGoalFromPrompt: vi.fn()
}));

vi.mock('../services/planningFallback.js', () => ({
  isLlmPlanningError: vi.fn(() => false),
  planGoalFromPromptFallback: vi.fn()
}));

describe('agentRequestHandler', () => {
  const resetMocks = async () => {
    const { llmClient } = await import('../llm-client.js');
    const { answerProjectQuestion } = await import('../services/questionToolAgent.js');
    const { planGoalFromPrompt } = await import('../services/agentOrchestrator.js');
    const { planGoalFromPromptFallback } = await import('../services/planningFallback.js');

    llmClient.generateResponse.mockReset();
    answerProjectQuestion.mockReset();
    planGoalFromPrompt.mockReset();
    planGoalFromPromptFallback.mockReset();
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('surfaces question-agent errors in the answer text', async () => {
    await resetMocks();
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

  it('copies questionError into fallbackError after classification and planning fallbacks fail', async () => {
    await resetMocks();
    const { llmClient } = await import('../llm-client.js');
    const { answerProjectQuestion } = await import('../services/questionToolAgent.js');
    const { planGoalFromPrompt } = await import('../services/agentOrchestrator.js');
    const { planGoalFromPromptFallback } = await import('../services/planningFallback.js');
    const { handleAgentRequest } = await import('../services/agentRequestHandler.js');

    llmClient.generateResponse
      .mockResolvedValueOnce('not-json')
      .mockResolvedValueOnce('still-not-json');

    planGoalFromPrompt.mockRejectedValue(new Error('planner failed'));
    planGoalFromPromptFallback.mockRejectedValue(new Error('simplified failed'));
    answerProjectQuestion.mockRejectedValue(new Error('question agent failed hard'));

    const result = await handleAgentRequest({
      projectId: 7,
      prompt: 'Please do something complex'
    });

    expect(result.kind).toBe('question');
    expect(result.meta.classificationError).toMatch(/valid json/i);
    expect(result.meta.questionError).toBe('question agent failed hard');
    expect(result.meta.fallbackError).toBe('question agent failed hard');
  });

  it('returns feature goals from planner fallback when classification fails but planning succeeds', async () => {
    await resetMocks();
    const { llmClient } = await import('../llm-client.js');
    const { planGoalFromPrompt } = await import('../services/agentOrchestrator.js');
    const { handleAgentRequest } = await import('../services/agentRequestHandler.js');

    llmClient.generateResponse
      .mockResolvedValueOnce('not-json')
      .mockResolvedValueOnce('still-not-json');

    planGoalFromPrompt.mockResolvedValue({
      parent: { id: 1, title: 'Parent' },
      children: [{ id: 2, title: 'Child' }]
    });

    const result = await handleAgentRequest({
      projectId: 8,
      prompt: 'Implement a larger feature'
    });

    expect(result.kind).toBe('feature');
    expect(result.message).toMatch(/planner fallback/i);
    expect(result.meta.classificationError).toMatch(/valid json/i);
  });

  it('includes plannerFallbackError in simplified fallback metadata when planner fallback throws', async () => {
    await resetMocks();
    const { llmClient } = await import('../llm-client.js');
    const { planGoalFromPrompt } = await import('../services/agentOrchestrator.js');
    const { planGoalFromPromptFallback } = await import('../services/planningFallback.js');
    const { handleAgentRequest } = await import('../services/agentRequestHandler.js');

    llmClient.generateResponse
      .mockResolvedValueOnce('not-json')
      .mockResolvedValueOnce('still-not-json');

    planGoalFromPrompt.mockRejectedValue(new Error('planner fallback failed')); 
    planGoalFromPromptFallback.mockResolvedValue({
      parent: { id: 10, title: 'Fallback Parent' },
      children: [{ id: 11, title: 'Fallback Child' }]
    });

    const result = await handleAgentRequest({
      projectId: 9,
      prompt: 'Implement fallback-plan feature'
    });

    expect(result.kind).toBe('feature');
    expect(result.message).toMatch(/simplified fallback/i);
    expect(result.meta.classificationError).toMatch(/valid json/i);
    expect(result.meta.plannerFallbackError).toBe('planner fallback failed');
  });

  it('captures plannerFallbackError from non-Error thrown values', async () => {
    await resetMocks();
    const { llmClient } = await import('../llm-client.js');
    const { planGoalFromPrompt } = await import('../services/agentOrchestrator.js');
    const { planGoalFromPromptFallback } = await import('../services/planningFallback.js');
    const { handleAgentRequest } = await import('../services/agentRequestHandler.js');

    llmClient.generateResponse
      .mockResolvedValueOnce('not-json')
      .mockResolvedValueOnce('still-not-json');

    planGoalFromPrompt.mockRejectedValue('planner fallback string failure');
    planGoalFromPromptFallback.mockResolvedValue({
      parent: { id: 30, title: 'Fallback Parent' },
      children: [{ id: 31, title: 'Fallback Child' }]
    });

    const result = await handleAgentRequest({
      projectId: 12,
      prompt: 'Use fallback planning with non-error throw'
    });

    expect(result.kind).toBe('feature');
    expect(result.meta.classificationError).toMatch(/valid json/i);
    expect(result.meta.plannerFallbackError).toBe('planner fallback string failure');
  });

  it('falls back plannerFallbackError to "Unknown error" for null rejection values', async () => {
    await resetMocks();
    const { llmClient } = await import('../llm-client.js');
    const { planGoalFromPrompt } = await import('../services/agentOrchestrator.js');
    const { planGoalFromPromptFallback } = await import('../services/planningFallback.js');
    const { handleAgentRequest } = await import('../services/agentRequestHandler.js');

    llmClient.generateResponse
      .mockResolvedValueOnce('not-json')
      .mockResolvedValueOnce('still-not-json');

    planGoalFromPrompt.mockRejectedValue(null);
    planGoalFromPromptFallback.mockResolvedValue({
      parent: { id: 40, title: 'Fallback Parent' },
      children: [{ id: 41, title: 'Fallback Child' }]
    });

    const result = await handleAgentRequest({
      projectId: 13,
      prompt: 'Fallback planning unknown error case'
    });

    expect(result.kind).toBe('feature');
    expect(result.meta.classificationError).toMatch(/valid json/i);
    expect(result.meta.plannerFallbackError).toBe('Unknown error');
  });

  it('omits plannerFallbackError when planner fallback returns a non-object and simplified fallback succeeds', async () => {
    await resetMocks();
    const { llmClient } = await import('../llm-client.js');
    const { planGoalFromPrompt } = await import('../services/agentOrchestrator.js');
    const { planGoalFromPromptFallback } = await import('../services/planningFallback.js');
    const { handleAgentRequest } = await import('../services/agentRequestHandler.js');

    llmClient.generateResponse
      .mockResolvedValueOnce('not-json')
      .mockResolvedValueOnce('still-not-json');

    planGoalFromPrompt.mockResolvedValue('not-an-object');
    planGoalFromPromptFallback.mockResolvedValue({
      parent: { id: 20, title: 'Simplified Parent' },
      children: [{ id: 21, title: 'Simplified Child' }]
    });

    const result = await handleAgentRequest({
      projectId: 10,
      prompt: 'Implement simplified-fallback feature'
    });

    expect(result.kind).toBe('feature');
    expect(result.message).toMatch(/simplified fallback/i);
    expect(result.meta.classificationError).toMatch(/valid json/i);
    expect(Object.prototype.hasOwnProperty.call(result.meta, 'plannerFallbackError')).toBe(false);
  });

  it('falls back to question handling when simplified fallback throws after non-object planner result', async () => {
    await resetMocks();
    const { llmClient } = await import('../llm-client.js');
    const { answerProjectQuestion } = await import('../services/questionToolAgent.js');
    const { planGoalFromPrompt } = await import('../services/agentOrchestrator.js');
    const { planGoalFromPromptFallback } = await import('../services/planningFallback.js');
    const { handleAgentRequest } = await import('../services/agentRequestHandler.js');

    llmClient.generateResponse
      .mockResolvedValueOnce('not-json')
      .mockResolvedValueOnce('still-not-json');

    planGoalFromPrompt.mockResolvedValue(42);
    planGoalFromPromptFallback.mockRejectedValue('simplified failed as string');
    answerProjectQuestion.mockResolvedValue({
      answer: 'fallback answer',
      steps: [],
      meta: { source: 'question-agent' }
    });

    const result = await handleAgentRequest({
      projectId: 11,
      prompt: 'Recover through question fallback'
    });

    expect(result.kind).toBe('question');
    expect(result.answer).toBe('fallback answer');
    expect(result.meta.classificationError).toMatch(/valid json/i);
    expect(result.meta.questionError).toBeUndefined();
  });
});
