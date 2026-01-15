import { llmClient } from '../llm-client.js';
import { answerProjectQuestion } from './questionToolAgent.js';
import { isStyleOnlyPrompt } from './promptHeuristics.js';
import { planGoalFromPrompt } from './agentOrchestrator.js';
import { isLlmPlanningError, planGoalFromPromptFallback } from './planningFallback.js';

const normalizeJsonLikeText = (value) => {
  if (typeof value !== 'string') {
    return value;
  }

  return value
    .replace(/\u00a0/gi, ' ')
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'");
};

const stripCodeFences = (value) => {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  const normalized = normalizeJsonLikeText(trimmed);
  const fenced = normalized.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced && typeof fenced[1] === 'string') {
    return normalizeJsonLikeText(fenced[1].trim());
  }
  return normalized;
};

const extractFirstJsonObjectSubstring = (value) => {
  if (typeof value !== 'string') {
    return null;
  }

  const text = value;
  let startIndex = -1;
  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (ch === '{') {
      if (depth === 0) {
        startIndex = index;
      }
      depth += 1;
      continue;
    }

    if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && startIndex !== -1) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return null;
};

const extractJsonObject = (raw) => {
  if (!raw || typeof raw !== 'string') {
    return null;
  }

  const trimmed = stripCodeFences(raw);
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // Attempt to recover the first JSON object if the model wrapped it with prose.
    const recovered = extractFirstJsonObjectSubstring(trimmed);
    if (!recovered) {
      return null;
    }
    try {
      return JSON.parse(recovered);
    } catch {
      return null;
    }
  }
};

export const classifyAgentRequest = async ({ projectId, prompt }) => {
  if (!projectId) {
    throw new Error('projectId is required');
  }
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('prompt is required');
  }

  const systemMessage = {
    role: 'system',
    content:
      'You are an assistant that classifies user messages in a developer IDE. ' +
      'Return ONLY a JSON object, no prose. The JSON MUST be of the form ' +
      '{ "kind": "question" | "small-change" | "feature", "answer"?: string }. ' +
      'Use kind:"question" for conceptual questions or explanations, ' +
      'kind:"small-change" for narrow, localized edits, and kind:"feature" for broader, multi-step work.'
  };

  const userMessage = {
    role: 'user',
    content: prompt
  };

  const callOptions = {
    max_tokens: 400,
    temperature: 0,
    __lucidcoderDisableToolBridge: true,
    __lucidcoderPhase: 'classification',
    __lucidcoderRequestType: 'classify'
  };

  const raw = await llmClient.generateResponse([systemMessage, userMessage], callOptions);

  let parsed = extractJsonObject(raw);
  if (!parsed) {
    // One repair attempt: ask the model to re-emit *only* valid JSON.
    const repairSystem = {
      role: 'system',
      content:
        'Your previous response could not be parsed as JSON. ' +
        'Return ONLY a valid JSON object, no prose, no code fences, no markdown.'
    };
    const assistantDraft = { role: 'assistant', content: typeof raw === 'string' ? raw : '' };
    const repairUser = {
      role: 'user',
      content:
        'Rewrite your previous response as a single JSON object of the form ' +
        '{"kind":"question"|"small-change"|"feature","answer"?:string}.'
    };

    const repaired = await llmClient.generateResponse(
      [systemMessage, userMessage, repairSystem, assistantDraft, repairUser],
      { ...callOptions, __lucidcoderRequestType: 'classify_repair' }
    );
    parsed = extractJsonObject(repaired);
  }

  if (!parsed) {
    throw new Error('LLM classification response was not valid JSON');
  }

  if (!parsed || (parsed.kind !== 'question' && parsed.kind !== 'small-change' && parsed.kind !== 'feature')) {
    throw new Error('LLM classification response missing or invalid kind');
  }

  return parsed;
};

export const handleAgentRequest = async ({ projectId, prompt }) => {
  if (!projectId) {
    throw new Error('projectId is required');
  }
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('prompt is required');
  }

  const safeAnswerProjectQuestion = async (meta = undefined) => {
    try {
      const { answer, steps } = await answerProjectQuestion({ projectId, prompt });
      return {
        kind: 'question',
        answer: answer || null,
        steps: Array.isArray(steps) ? steps : [],
        ...(meta ? { meta } : {})
      };
    } catch (error) {
      console.error('[Agent] Question agent failed:', error?.message || error);
      return {
        kind: 'question',
        answer: 'Sorry — the agent is unavailable right now. Please try again.',
        steps: [],
        meta: {
          ...(meta || {}),
          questionError: error?.message || 'Unknown error'
        }
      };
    }
  };

  const normalizedPrompt = prompt.trim().toLowerCase();
  if (normalizedPrompt && /^(continue|resume)\s+goals?$/.test(normalizedPrompt)) {
    return await safeAnswerProjectQuestion();
  }

  let classification;
  try {
    classification = await classifyAgentRequest({ projectId, prompt });
  } catch (error) {
    console.warn('[Agent] Classification failed, falling back to question agent:', error?.message || error);
    const classificationError = error?.message || 'Unknown error';
    const questionResult = await safeAnswerProjectQuestion({ classificationError });
    const meta = {
      ...questionResult.meta,
      classificationError
    };
    if (meta.questionError) {
      meta.fallbackError = meta.questionError;
    }

    return {
      ...questionResult,
      answer:
        questionResult.answer ||
        'I had trouble classifying that request. Please try rephrasing it.',
      meta
    };
  }

  if (classification.kind === 'question') {
    return await safeAnswerProjectQuestion();
  }

  // For feature requests and small changes, create goals via planning
  let result;
  try {
    result = await planGoalFromPrompt({ projectId, prompt });
  } catch (error) {
    console.error('[Agent] Planning failed:', error?.message || error);

    const planningErrorMessage = error?.message || 'Unknown error';

    if (isLlmPlanningError(error)) {
      try {
        const fallbackPlan = await planGoalFromPromptFallback({ projectId, prompt });
        return {
          kind: 'feature',
          parent: fallbackPlan.parent,
          children: fallbackPlan.children,
          message: 'Goals planned using a simplified fallback because the LLM planner was unavailable.'
        };
      } catch (fallbackError) {
        console.error('[Agent] Fallback planning also failed:', fallbackError?.message || fallbackError);
        return {
          kind: 'question',
          answer:
            'I could not plan that feature right now (planning failed). Please try again, or simplify the request.',
          steps: [],
          meta: {
            planningError: planningErrorMessage,
            fallbackPlanningError: fallbackError?.message || 'Unknown error'
          }
        };
      }
    }

    return {
      kind: 'question',
      answer:
        'I could not plan that feature right now (planning failed). Please try again, or simplify the request.',
      steps: [],
      meta: {
        planningError: planningErrorMessage
      }
    };
  }
  
  return {
    kind: 'feature',
    parent: result.parent,
    children: result.children,
    message: 'Goals created successfully. Ready for execution.'
  };
};

export const __testing = {
  normalizeJsonLikeText,
  stripCodeFences,
  extractFirstJsonObjectSubstring,
  extractJsonObject
};

export default {
  classifyAgentRequest,
  handleAgentRequest
};
