import { createMetaGoalWithChildren } from './agentOrchestrator.js';

const MAX_PROMPT_SNIPPET = 400;

export const buildFallbackChildPrompts = (prompt) => {
  const trimmed = typeof prompt === 'string' ? prompt.trim() : '';
  if (!trimmed) {
    return [
      'Identify the core change needed and update the most relevant files.',
      'Implement the requested feature end-to-end, including any reusable pieces.',
      'Wire the feature into the app entry point and verify the behavior.'
    ];
  }

  const snippet = trimmed.length > MAX_PROMPT_SNIPPET ? `${trimmed.slice(0, MAX_PROMPT_SNIPPET)}…` : trimmed;

  return [
    `Outline the main components/areas needed for: ${snippet}`,
    `Implement the primary feature described in: ${snippet} (include any reusable subcomponents).`,
    `Integrate the change into the app shell/layout and honor any placement constraints in: ${snippet}`
  ];
};

export const planGoalFromPromptFallback = async ({ projectId, prompt }) => {
  const childPrompts = buildFallbackChildPrompts(prompt);
  return createMetaGoalWithChildren({ projectId, prompt, childPrompts });
};

export const isLlmPlanningError = (error) => {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (!message) {
    return false;
  }
  return /LLM planning response|LLM planning produced/i.test(message);
};
