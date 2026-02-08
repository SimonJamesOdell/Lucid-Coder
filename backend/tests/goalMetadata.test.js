import { describe, it, expect, vi } from 'vitest';
import { createRequestClarificationQuestions } from '../services/agentOrchestrator/goalMetadata.js';

describe('goalMetadata', () => {
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
    expect(llmClient.generateResponse).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ __lucidcoderPhase: 'meta_goal_clarification' })
    );
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
