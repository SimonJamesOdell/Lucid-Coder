import { createMetaGoalWithChildren } from './agentOrchestrator.js';

const MAX_PROMPT_SNIPPET = 400;

export const buildFallbackChildPrompts = (prompt) => {
  const trimmed = typeof prompt === 'string' ? prompt.trim() : '';
  if (!trimmed) {
    return ['Implement the requested change.'];
  }

  const snippet = trimmed.length > MAX_PROMPT_SNIPPET ? `${trimmed.slice(0, MAX_PROMPT_SNIPPET)}…` : trimmed;
  return [`Implement the request: ${snippet}`];
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
