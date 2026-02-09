import { describe, it, expect, vi } from 'vitest';
import { createRequestClarificationQuestions } from '../services/agentOrchestrator/goalMetadata.js';

describe('goalMetadata clarification helpers', () => {
  it('normalizes clarifying questions and handles non-string prompts', async () => {
    const llmClient = {
      generateResponse: vi.fn().mockResolvedValue('raw-json')
    };
    const extractJsonObject = vi.fn().mockReturnValue({
      needsClarification: true,
      questions: ['  Needs detail ', '', 'Needs detail']
    });

    const requestClarificationQuestions = createRequestClarificationQuestions({ llmClient, extractJsonObject });

    const result = await requestClarificationQuestions(null, undefined);

    expect(result).toEqual(['Needs detail']);
  });

  it('returns empty questions when needsClarification is false', async () => {
    const llmClient = {
      generateResponse: vi.fn().mockResolvedValue('raw-json')
    };
    const extractJsonObject = vi.fn().mockReturnValue({
      needsClarification: false,
      questions: ['Ignored']
    });

    const requestClarificationQuestions = createRequestClarificationQuestions({ llmClient, extractJsonObject });

    const result = await requestClarificationQuestions('Add a button', 'context');

    expect(result).toEqual([]);
  });
});
