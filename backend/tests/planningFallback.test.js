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
    it('returns multi-step prompts when the input is empty after trimming', () => {
      expect(buildFallbackChildPrompts('   ')).toEqual([
        'Identify the core change needed and update the most relevant files.',
        'Implement the requested feature end-to-end, including any reusable pieces.',
        'Wire the feature into the app entry point and verify the behavior.'
      ]);
      expect(buildFallbackChildPrompts(null)).toEqual([
        'Identify the core change needed and update the most relevant files.',
        'Implement the requested feature end-to-end, including any reusable pieces.',
        'Wire the feature into the app entry point and verify the behavior.'
      ]);
    });

    it('truncates long prompts and appends an ellipsis', () => {
      const longPrompt = 'a'.repeat(450);
      const result = buildFallbackChildPrompts(longPrompt);
      expect(result).toEqual([
        `Outline the main components/areas needed for: ${'a'.repeat(400)}…`,
        `Implement the primary feature described in: ${'a'.repeat(400)}… (include any reusable subcomponents).`,
        `Integrate the change into the app shell/layout and honor any placement constraints in: ${'a'.repeat(400)}…`
      ]);
    });
  });

  describe('planGoalFromPromptFallback', () => {
    it('delegates to createMetaGoalWithChildren with generated child prompts', async () => {
      createMetaGoalWithChildren.mockResolvedValue({ parent: { id: 1 } });

      const result = await planGoalFromPromptFallback({ projectId: 9, prompt: 'Add logs' });

      expect(createMetaGoalWithChildren).toHaveBeenCalledWith({
        projectId: 9,
        prompt: 'Add logs',
        childPrompts: [
          'Outline the main components/areas needed for: Add logs',
          'Implement the primary feature described in: Add logs (include any reusable subcomponents).',
          'Integrate the change into the app shell/layout and honor any placement constraints in: Add logs'
        ]
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
