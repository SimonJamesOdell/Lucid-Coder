import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initializeDatabase } from '../database.js';
import { classifyAgentRequest, handleAgentRequest, __testing } from '../services/agentRequestHandler.js';
import { llmClient } from '../llm-client.js';
import * as orchestrator from '../services/agentOrchestrator.js';
import * as questionAgent from '../services/questionToolAgent.js';
import * as planningFallback from '../services/planningFallback.js';

vi.mock('../llm-client.js', () => ({
  llmClient: {
    generateResponse: vi.fn()
  }
}));

vi.mock('../services/agentOrchestrator.js');
vi.mock('../services/questionToolAgent.js', () => ({
  answerProjectQuestion: vi.fn()
}));
vi.mock('../services/planningFallback.js', () => ({
  isLlmPlanningError: vi.fn(() => false),
  planGoalFromPromptFallback: vi.fn()
}));

describe('agentRequestHandler', () => {
  beforeEach(async () => {
    await initializeDatabase();
    vi.clearAllMocks();
  });

  it('classifies a request using the LLM and returns parsed JSON', async () => {
    llmClient.generateResponse.mockResolvedValue(
      JSON.stringify({ kind: 'question', answer: 'Yes, it is secure.' })
    );

    const result = await classifyAgentRequest({ projectId: 1, prompt: 'Is the login secure?' });

    expect(llmClient.generateResponse).toHaveBeenCalled();
    expect(result).toEqual({ kind: 'question', answer: 'Yes, it is secure.' });
  });

  it('exposes helper guards for non-string inputs via __testing (coverage for early returns)', () => {
    expect(__testing.normalizeJsonLikeText({ value: 1 })).toEqual({ value: 1 });
    expect(__testing.stripCodeFences(123)).toBe(123);
    expect(__testing.extractFirstJsonObjectSubstring({})).toBeNull();
  });

  it('requires projectId and prompt when classifying', async () => {
    await expect(classifyAgentRequest({ prompt: 'Hello' })).rejects.toThrow('projectId is required');
    await expect(classifyAgentRequest({ projectId: 1 })).rejects.toThrow('prompt is required');
  });

  it('throws if LLM response is not valid JSON', async () => {
    llmClient.generateResponse.mockResolvedValue('not-json');

    await expect(
      classifyAgentRequest({ projectId: 1, prompt: 'Is the login secure?' })
    ).rejects.toThrow(/LLM classification response was not valid JSON/i);
  });

  it('recovers JSON when the model wraps it with prose', async () => {
    llmClient.generateResponse.mockResolvedValue('Sure, here you go: {"kind":"question"}\nLet me know if you need anything else.');

    const result = await classifyAgentRequest({ projectId: 1, prompt: 'Is the login secure?' });
    expect(result).toEqual({ kind: 'question' });
  });

  it('parses JSON when the model wraps it in ```json code fences', async () => {
    llmClient.generateResponse.mockResolvedValue('```json\n{"kind":"question"}\n```');

    const result = await classifyAgentRequest({ projectId: 1, prompt: 'Is the login secure?' });
    expect(result).toEqual({ kind: 'question' });
  });

  it('parses responses that use curly smart quotes', async () => {
    llmClient.generateResponse.mockResolvedValue(`{
  \u201Ckind\u201D: \u201Cquestion\u201D
}`);

    const result = await classifyAgentRequest({ projectId: 1, prompt: 'Handle curly quotes' });
    expect(result).toEqual({ kind: 'question' });
  });

  it('recovers JSON with escaped quotes and braces inside strings', async () => {
    llmClient.generateResponse.mockResolvedValue(
      'Here is the classification you asked for: ' +
        '{"kind":"question","answer":"He said: \\\"hi\\\" and wrote {braces} in a string"}' +
        ' Thanks!'
    );

    const result = await classifyAgentRequest({ projectId: 1, prompt: 'Is the login secure?' });

    expect(result).toEqual({
      kind: 'question',
      answer: 'He said: "hi" and wrote {braces} in a string'
    });
  });

  it('recovers JSON with nested objects (covers depth>0 branches)', async () => {
    llmClient.generateResponse.mockResolvedValue(
      'Prefix text {"kind":"question","meta":{"a":1}} trailing text'
    );

    const result = await classifyAgentRequest({ projectId: 1, prompt: 'Test nested recovery' });

    expect(result).toEqual({ kind: 'question', meta: { a: 1 } });
  });

  it('rejects when the model returns a non-string or empty payload', async () => {
    llmClient.generateResponse.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    await expect(
      classifyAgentRequest({ projectId: 1, prompt: 'Test null response' })
    ).rejects.toThrow(/not valid JSON/i);

    llmClient.generateResponse.mockResolvedValueOnce('   ').mockResolvedValueOnce('   ');

    await expect(
      classifyAgentRequest({ projectId: 1, prompt: 'Test empty response' })
    ).rejects.toThrow(/not valid JSON/i);
  });

  it('rejects when the model returns a non-string response (no recovery possible)', async () => {
    llmClient.generateResponse.mockResolvedValueOnce({}).mockResolvedValueOnce({});

    await expect(
      classifyAgentRequest({ projectId: 1, prompt: 'Test object response' })
    ).rejects.toThrow(/not valid JSON/i);
  });

  it('rejects when recovered JSON blob cannot be parsed', async () => {
    llmClient.generateResponse.mockResolvedValue('Sure { "kind": "question", } more text');

    await expect(
      classifyAgentRequest({ projectId: 1, prompt: 'Test malformed recovery' })
    ).rejects.toThrow(/not valid JSON/i);
  });

  it('throws if LLM response has invalid kind', async () => {
    llmClient.generateResponse.mockResolvedValue(JSON.stringify({ kind: 'unknown' }));

    await expect(
      classifyAgentRequest({ projectId: 1, prompt: 'Is the login secure?' })
    ).rejects.toThrow(/classification response missing or invalid kind/i);
  });

  it('handleAgentRequest delegates questions to the tool-based agent', async () => {
    llmClient.generateResponse.mockResolvedValue(
      JSON.stringify({ kind: 'question' })
    );

    questionAgent.answerProjectQuestion.mockResolvedValue({
      answer: 'The project is called LSML Composer.',
      steps: [
        { type: 'action', action: 'read_file', target: 'README.md', reason: 'Find project name' },
        { type: 'observation', action: 'read_file', target: 'README.md', summary: 'README header states LSML Composer' }
      ]
    });

    const result = await handleAgentRequest({ projectId: 2, prompt: 'What is the project name?' });

    expect(questionAgent.answerProjectQuestion).toHaveBeenCalledWith({
      projectId: 2,
      prompt: 'What is the project name?'
    });
    expect(result).toEqual({
      kind: 'question',
      answer: 'The project is called LSML Composer.',
      steps: expect.any(Array)
    });
    expect(result.steps).toHaveLength(2);
    expect(orchestrator.createGoalFromPrompt).not.toHaveBeenCalled();
    expect(orchestrator.planGoalFromPrompt).not.toHaveBeenCalled();
  });

  it('normalizes missing answer/steps fields for question results', async () => {
    llmClient.generateResponse.mockResolvedValue(JSON.stringify({ kind: 'question' }));
    questionAgent.answerProjectQuestion.mockResolvedValue({});

    const result = await handleAgentRequest({ projectId: 5, prompt: 'Explain build pipeline' });

    expect(result).toEqual({ kind: 'question', answer: null, steps: [] });
  });

  it('returns a safe question response when the question agent throws', async () => {
    llmClient.generateResponse.mockResolvedValue(JSON.stringify({ kind: 'question' }));
    questionAgent.answerProjectQuestion.mockRejectedValue(new Error('tooling down'));

    const result = await handleAgentRequest({ projectId: 6, prompt: 'What is this project?' });

    expect(result).toEqual(
      expect.objectContaining({
        kind: 'question',
        steps: [],
        meta: expect.objectContaining({ questionError: 'tooling down' })
      })
    );
  });

  it('treats small-change classifications as feature requests (autopilot)', async () => {
    llmClient.generateResponse.mockResolvedValue(JSON.stringify({ kind: 'small-change' }));
    orchestrator.planGoalFromPrompt.mockResolvedValue({ parent: { id: 1 }, children: [] });

    const result = await handleAgentRequest({ projectId: 3, prompt: 'Update submit button copy' });

    expect(result).toEqual({ kind: 'feature', parent: { id: 1 }, children: [], message: 'Goals created successfully. Ready for execution.' });
    expect(orchestrator.planGoalFromPrompt).toHaveBeenCalledWith({ projectId: 3, prompt: 'Update submit button copy' });
  });

  it('marks small-change classifications as plan-only for style prompts', async () => {
    llmClient.generateResponse.mockResolvedValue(JSON.stringify({ kind: 'small-change' }));
    orchestrator.planGoalFromPrompt.mockResolvedValue({ parent: { id: 2 }, children: [] });

    const result = await handleAgentRequest({ projectId: 3, prompt: 'Change the background color to blue' });

    expect(result).toEqual({ kind: 'feature', parent: { id: 2 }, children: [], message: 'Goals created successfully. Ready for execution.' });
    expect(orchestrator.planGoalFromPrompt).toHaveBeenCalledWith({ projectId: 3, prompt: 'Change the background color to blue' });
  });

  it('handleAgentRequest creates goals for feature requests via planning', async () => {
    llmClient.generateResponse.mockResolvedValue(JSON.stringify({ kind: 'feature' }));
    orchestrator.planGoalFromPrompt.mockResolvedValue({ parent: { id: 3 }, children: [{ id: 4 }, { id: 5 }] });

    const result = await handleAgentRequest({ projectId: 4, prompt: 'Build an ecommerce site.' });

    expect(orchestrator.planGoalFromPrompt).toHaveBeenCalledWith({ projectId: 4, prompt: 'Build an ecommerce site.' });
    expect(result).toEqual({ kind: 'feature', parent: { id: 3 }, children: [{ id: 4 }, { id: 5 }], message: 'Goals created successfully. Ready for execution.' });
  });

  it('creates goals for CSS/style-only feature requests', async () => {
    llmClient.generateResponse.mockResolvedValue(JSON.stringify({ kind: 'feature' }));
    orchestrator.planGoalFromPrompt.mockResolvedValue({ parent: { id: 6 }, children: [] });

    const result = await handleAgentRequest({ projectId: 4, prompt: 'Turn the background blue' });

    expect(orchestrator.planGoalFromPrompt).toHaveBeenCalledWith({ projectId: 4, prompt: 'Turn the background blue' });
    expect(result).toEqual({ kind: 'feature', parent: { id: 6 }, children: [], message: 'Goals created successfully. Ready for execution.' });
  });

  it('treats "continue goals" as a question and bypasses LLM classification', async () => {
    questionAgent.answerProjectQuestion.mockResolvedValue({
      answer: 'Here are your goals.',
      steps: [{ type: 'action', action: 'list_goals', target: 'agent_goals' }]
    });

    const result = await handleAgentRequest({ projectId: 9, prompt: 'continue goals' });

    expect(llmClient.generateResponse).not.toHaveBeenCalled();
    expect(questionAgent.answerProjectQuestion).toHaveBeenCalledWith({ projectId: 9, prompt: 'continue goals' });
    expect(result).toEqual({
      kind: 'question',
      answer: 'Here are your goals.',
      steps: [expect.objectContaining({ action: 'list_goals' })]
    });
  });

  it('bypasses classification for "resume goals" and normalizes missing fields', async () => {
    questionAgent.answerProjectQuestion.mockResolvedValue({ answer: '', steps: null });

    const result = await handleAgentRequest({ projectId: 10, prompt: 'resume goals' });

    expect(llmClient.generateResponse).not.toHaveBeenCalled();
    expect(questionAgent.answerProjectQuestion).toHaveBeenCalledWith({ projectId: 10, prompt: 'resume goals' });
    expect(result).toEqual({ kind: 'question', answer: null, steps: [] });
  });

  it('rejects non-string prompts in handleAgentRequest (covers normalization guard)', async () => {
    await expect(handleAgentRequest({ projectId: 11, prompt: null })).rejects.toThrow(/prompt is required/i);
    expect(questionAgent.answerProjectQuestion).not.toHaveBeenCalled();
    expect(llmClient.generateResponse).not.toHaveBeenCalled();
  });

  it('rejects missing projectId in handleAgentRequest', async () => {
    await expect(handleAgentRequest({ projectId: null, prompt: 'Hello' })).rejects.toThrow(/projectId is required/i);
    expect(questionAgent.answerProjectQuestion).not.toHaveBeenCalled();
    expect(llmClient.generateResponse).not.toHaveBeenCalled();
  });

  it('falls back to question agent when classification fails', async () => {
    llmClient.generateResponse.mockResolvedValueOnce('not-json').mockResolvedValueOnce('still-not-json');

    questionAgent.answerProjectQuestion.mockResolvedValue({
      answer: 'Fallback answer',
      steps: [{ type: 'action', action: 'read_file', target: 'README.md' }]
    });

    const result = await handleAgentRequest({ projectId: 12, prompt: 'Explain the project' });

    expect(questionAgent.answerProjectQuestion).toHaveBeenCalledWith({ projectId: 12, prompt: 'Explain the project' });
    expect(result).toEqual(
      expect.objectContaining({
        kind: 'question',
        answer: 'Fallback answer',
        steps: expect.any(Array),
        meta: expect.objectContaining({ classificationError: expect.any(String) })
      })
    );
  });

  it('classification failure uses default classificationError when failure is not an Error', async () => {
    llmClient.generateResponse.mockRejectedValueOnce('boom');

    questionAgent.answerProjectQuestion.mockResolvedValue({
      answer: 'Fallback answer',
      steps: []
    });

    const result = await handleAgentRequest({ projectId: 17, prompt: 'Explain the project' });

    expect(result).toEqual(
      expect.objectContaining({
        kind: 'question',
        answer: 'Fallback answer',
        steps: [],
        meta: expect.objectContaining({ classificationError: 'Unknown error' })
      })
    );
  });

  it('fallback response uses default answer/steps when question agent omits them', async () => {
    llmClient.generateResponse.mockResolvedValueOnce('not-json').mockResolvedValueOnce('still-not-json');

    questionAgent.answerProjectQuestion.mockResolvedValue({ answer: '', steps: null });

    const result = await handleAgentRequest({ projectId: 15, prompt: 'Explain the project' });

    expect(result).toEqual(
      expect.objectContaining({
        kind: 'question',
        answer: expect.stringMatching(/trouble classifying/i),
        steps: [],
        meta: expect.objectContaining({ classificationError: expect.any(String) })
      })
    );
  });

  it('returns a safe question response when classification and fallback both fail', async () => {
    llmClient.generateResponse.mockResolvedValueOnce('not-json').mockResolvedValueOnce('still-not-json');
    questionAgent.answerProjectQuestion.mockRejectedValue(new Error('fallback down'));

    const result = await handleAgentRequest({ projectId: 14, prompt: 'Explain the project' });

    expect(result).toEqual(
      expect.objectContaining({
        kind: 'question',
        steps: [],
        meta: expect.objectContaining({
          classificationError: expect.any(String),
          fallbackError: 'fallback down'
        })
      })
    );
  });

  it('classification fallback uses default fallbackError when thrown value is not an Error', async () => {
    llmClient.generateResponse.mockRejectedValueOnce('boom');
    questionAgent.answerProjectQuestion.mockRejectedValue('fallback boom');

    const result = await handleAgentRequest({ projectId: 18, prompt: 'Explain the project' });

    expect(result).toEqual(
      expect.objectContaining({
        kind: 'question',
        steps: [],
        meta: expect.objectContaining({
          classificationError: 'Unknown error',
          fallbackError: 'Unknown error'
        })
      })
    );
  });

  it('returns a question response when planning fails (avoids throwing)', async () => {
    llmClient.generateResponse.mockResolvedValue(JSON.stringify({ kind: 'feature' }));
    orchestrator.planGoalFromPrompt.mockRejectedValue(new Error('planning blew up'));

    const result = await handleAgentRequest({ projectId: 13, prompt: 'Build a navbar' });

    expect(orchestrator.planGoalFromPrompt).toHaveBeenCalledWith({ projectId: 13, prompt: 'Build a navbar' });
    expect(planningFallback.planGoalFromPromptFallback).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        kind: 'question',
        steps: [],
        meta: expect.objectContaining({ planningError: 'planning blew up' })
      })
    );
    expect(String(result.answer)).toMatch(/planning failed/i);
  });

  it('falls back to a simplified plan when the LLM planner fails', async () => {
    llmClient.generateResponse.mockResolvedValue(JSON.stringify({ kind: 'feature' }));
    orchestrator.planGoalFromPrompt.mockRejectedValue(new Error('LLM planning response malformed'));
    planningFallback.isLlmPlanningError.mockReturnValue(true);
    planningFallback.planGoalFromPromptFallback.mockResolvedValue({
      parent: { id: 500 },
      children: [{ id: 501 }]
    });

    const result = await handleAgentRequest({ projectId: 99, prompt: 'Add global search' });

    expect(planningFallback.planGoalFromPromptFallback).toHaveBeenCalledWith({
      projectId: 99,
      prompt: 'Add global search'
    });
    expect(result).toEqual(
      expect.objectContaining({
        kind: 'feature',
        parent: { id: 500 },
        children: [{ id: 501 }],
        message: expect.stringContaining('fallback')
      })
    );
  });

  it('reports fallback planner failures when both planners error', async () => {
    llmClient.generateResponse.mockResolvedValue(JSON.stringify({ kind: 'feature' }));
    orchestrator.planGoalFromPrompt.mockRejectedValue(new Error('LLM planning response malformed'));
    planningFallback.isLlmPlanningError.mockReturnValue(true);
    planningFallback.planGoalFromPromptFallback.mockRejectedValue(new Error('fallback boom'));

    const result = await handleAgentRequest({ projectId: 101, prompt: 'Add filters' });

    expect(result).toEqual(
      expect.objectContaining({
        kind: 'question',
        meta: expect.objectContaining({
          planningError: 'LLM planning response malformed',
          fallbackPlanningError: 'fallback boom'
        })
      })
    );
  });

  it('uses a default fallbackPlanningError when the fallback planner rejects without a message', async () => {
    llmClient.generateResponse.mockResolvedValue(JSON.stringify({ kind: 'feature' }));
    orchestrator.planGoalFromPrompt.mockRejectedValue(new Error('LLM planning response malformed'));
    planningFallback.isLlmPlanningError.mockReturnValue(true);
    planningFallback.planGoalFromPromptFallback.mockRejectedValue(null);

    const result = await handleAgentRequest({ projectId: 102, prompt: 'Add charts' });

    expect(result).toEqual(
      expect.objectContaining({
        kind: 'question',
        meta: expect.objectContaining({
          planningError: 'LLM planning response malformed',
          fallbackPlanningError: 'Unknown error'
        })
      })
    );
  });

  it('uses a default planning error message when planning rejects without details', async () => {
    llmClient.generateResponse.mockResolvedValue(JSON.stringify({ kind: 'feature' }));
    orchestrator.planGoalFromPrompt.mockRejectedValue(null);

    const result = await handleAgentRequest({ projectId: 16, prompt: 'Build a navbar' });

    expect(result).toEqual(
      expect.objectContaining({
        kind: 'question',
        steps: [],
        meta: expect.objectContaining({ planningError: 'Unknown error' })
      })
    );
  });

});
