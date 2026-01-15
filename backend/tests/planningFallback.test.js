import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/agentOrchestrator.js', () => ({
  createMetaGoalWithChildren: vi.fn()
}));

import { createMetaGoalWithChildren } from '../services/agentOrchestrator.js';
import { buildFallbackChildPrompts, planGoalFromPromptFallback, isLlmPlanningError } from '../services/planningFallback.js';

describe('planningFallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('buildFallbackChildPrompts', () => {
    it('returns a default child prompt when the input is empty after trimming', () => {
      expect(buildFallbackChildPrompts('   ')).toEqual(['Implement the requested change.']);
      expect(buildFallbackChildPrompts(null)).toEqual(['Implement the requested change.']);
    });

    it('truncates long prompts and appends an ellipsis', () => {
      const longPrompt = 'a'.repeat(450);
      const result = buildFallbackChildPrompts(longPrompt);
      expect(result).toEqual([`Implement the request: ${'a'.repeat(400)}…`]);
    });
  });

  describe('planGoalFromPromptFallback', () => {
    it('delegates to createMetaGoalWithChildren with generated child prompts', async () => {
      createMetaGoalWithChildren.mockResolvedValue({ parent: { id: 1 } });

      const result = await planGoalFromPromptFallback({ projectId: 9, prompt: 'Add logs' });

      expect(createMetaGoalWithChildren).toHaveBeenCalledWith({
        projectId: 9,
        prompt: 'Add logs',
        childPrompts: ['Implement the request: Add logs']
      });
      expect(result).toEqual({ parent: { id: 1 } });
    });
  });

  describe('isLlmPlanningError', () => {
    it('detects known planner error phrases', () => {
      expect(isLlmPlanningError(new Error('LLM planning response malformed'))).toBe(true);
      expect(isLlmPlanningError(new Error('LLM planning produced nothing useful'))).toBe(true);
    });

    it('returns false for unrelated or missing error messages', () => {
      expect(isLlmPlanningError(new Error('network failed'))).toBe(false);
      expect(isLlmPlanningError({})).toBe(false);
      expect(isLlmPlanningError(null)).toBe(false);
    });
  });
});
