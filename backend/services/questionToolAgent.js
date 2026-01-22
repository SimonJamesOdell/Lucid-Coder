import { llmClient } from '../llm-client.js';
import { readProjectFile } from './projectTools.js';
import { listGoals as listStoredGoals } from './goalStore.js';
import JSON5 from 'json5';

const MAX_AGENT_STEPS = 4;
const CONTENT_SNIPPET_LIMIT = 1200;
const FALLBACK_FILES = [
  'README.md',
  'package.json',
  'frontend/package.json',
  'backend/package.json',
  'frontend/src/App.jsx',
  'frontend/src/App.tsx',
  'frontend/src/main.jsx',
  'frontend/src/main.tsx',
  'frontend/src/index.jsx',
  'frontend/src/index.tsx'
];

/* c8 ignore start */
const SYSTEM_PROMPT = `You are an autonomous software engineer with access to developer tools.
You must figure out answers about a project by reasoning step-by-step and using tools when needed.

IMPORTANT:
- You must respond with a SINGLE JSON object and nothing else (no prose, no Markdown, no code fences).
- Never invoke API-level tool/function calls. All tool usage must be described via the JSON object you output.
- If you need to use a tool, emit { "action": "read_file", ... } as text; do NOT rely on the API for tools.
- This repo often uses a workspace layout. Frontend files usually live under frontend/ and backend files under backend/. Check those folders first for UI questions.
 - Output MUST be plain text JSON in the assistant message content. Do NOT use tool_calls/function_call.

TOOLS AVAILABLE:
- read_file(path): returns the contents of the project file at the given relative path.
- list_goals(): returns the persisted goals for the current project (from the DB).

RESPONSE FORMAT:
Always respond with a strict JSON object containing:
{
  "action": "read_file" | "list_goals" | "answer" | "unable",
  "path"?: string,
  "reason"?: string,
  "answer"?: string,
  "explanation"?: string
}

Rules:
- Plan carefully. If you need information, call read_file with a relative path like README.md or frontend/package.json.
- If the user asks about "goals" (e.g. list/show/continue goals), prefer list_goals() over trying to read GOALS.md files.
- When you have enough evidence, respond with {"action":"answer","answer":"..."}.
- The "answer" field MAY include Markdown for formatting.
- If you truly cannot answer, respond with {"action":"unable","explanation":"why"}.
- Never return prose outside the JSON object.`;
/* c8 ignore stop */

const formatStepsForPrompt = (steps = []) => {
  if (!steps.length) {
    return 'None';
  }
  return steps
    .map((step, index) => {
      const prefix = `Step ${index + 1}`;
      if (step.type === 'action') {
        return `${prefix} ACTION: ${step.action} ${step.target || ''} ${step.reason ? `(${step.reason})` : ''}`.trim();
      }
      if (step.type === 'observation') {
        if (step.error) {
          return `${prefix} OBSERVATION: Failed to ${step.action} ${step.target || ''} -> ${step.error}`.trim();
        }
        return `${prefix} OBSERVATION: ${step.action} ${step.target || ''} -> ${step.summary || ''}`.trim();
      }
      if (step.type === 'answer') {
        return `${prefix} ANSWER: ${step.content}`;
      }
      return `${prefix} NOTE: ${JSON.stringify(step)}`;
    })
    .join('\n');
};

const summarizeContent = (content = '', limit = CONTENT_SNIPPET_LIMIT) => {
  if (!content) {
    return 'No content returned.';
  }
  if (content.length <= limit) {
    return content;
  }
  return `${content.slice(0, limit)}\n…content truncated…`;
};

const shouldIncludeGoalsContext = (prompt = '') => {
  if (!prompt || typeof prompt !== 'string') {
    return false;
  }
  const normalized = prompt.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (/\bcontinue\s+goals?\b/.test(normalized)) {
    return true;
  }
  if (/\b(list|show|resume)\s+goals?\b/.test(normalized)) {
    return true;
  }

  if (/\bgoals?\b/.test(normalized)) {
    return true;
  }

  return false;
};

const summarizeGoalsForPrompt = (goals = []) => {
  const payload = JSON.stringify(
    goals.map((goal) => ({
      id: goal.id,
      parentGoalId: goal.parentGoalId ?? null,
      prompt: goal.prompt,
      status: goal.status,
      lifecycleState: goal.lifecycleState,
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt
    })),
    null,
    2
  );
  return summarizeContent(payload);
};

const preloadGoalsContext = async ({ projectId, prompt, steps }) => {
  /* c8 ignore next 3 */
  if (!shouldIncludeGoalsContext(prompt)) {
    return;
  }

  steps.push({
    type: 'action',
    action: 'list_goals',
    target: 'agent_goals',
    reason: 'Preload stored goals because the prompt is goal-related.'
  });

  try {
    const goals = await listStoredGoals(projectId);
    steps.push({
      type: 'observation',
      action: 'list_goals',
      target: 'agent_goals',
      summary: goals.length ? summarizeGoalsForPrompt(goals) : 'No stored goals found for this project.'
    });
  } catch (error) {
    steps.push({
      type: 'observation',
      action: 'list_goals',
      target: 'agent_goals',
      error: error?.message || 'Failed to list goals'
    });
  }
};

const buildMessages = (prompt, steps) => [
  { role: 'system', content: SYSTEM_PROMPT },
  {
    role: 'user',
    content: `QUESTION:\n${prompt}\n\nPREVIOUS STEPS:\n${formatStepsForPrompt(steps)}\n\nReminder: UI code is often under frontend/ and backend code under backend/. Respond with the next JSON action. If you already have enough information, use the answer action.`
  }
];

const coerceJsonObject = (raw) => {
  if (!raw || typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const candidates = [trimmed];
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (match && match[0] !== trimmed) {
    candidates.push(match[0]);
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      try {
        return JSON5.parse(candidate);
      } catch {
        // Try next candidate.
      }
    }
  }
  return null;
};

const parseAgentJson = (raw) => {
  const parsed = coerceJsonObject(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw Object.assign(new Error('Agent planner returned invalid JSON'), { statusCode: 502 });
  }
  if (!parsed.action) {
    throw Object.assign(new Error('Agent planner returned invalid JSON'), { statusCode: 502 });
  }
  return parsed;
};

const tryRepairPlannerJson = async ({ messages, rawDecision }) => {
  // Keep unit tests strict: only attempt self-repair outside test runs.
  if (process.env.NODE_ENV === 'test') {
    return null;
  }

  const repairSystem = {
    role: 'system',
    content:
      'Your previous response could not be parsed as a valid JSON action. ' +
      'Return ONLY a single JSON object, with no prose, no code fences, no markdown.'
  };

  const assistantDraft = {
    role: 'assistant',
    content: typeof rawDecision === 'string' ? rawDecision : ''
  };

  const repairUser = {
    role: 'user',
    content:
      'Rewrite your previous response as EXACTLY one JSON object matching this schema: ' +
      '{"action":"read_file"|"list_goals"|"answer"|"unable","path"?:string,"reason"?:string,"answer"?:string,"explanation"?:string}.'
  };

  const repaired = await llmClient.generateResponse(
    [...messages, repairSystem, assistantDraft, repairUser],
    {
      max_tokens: 600,
      temperature: 0,
      __lucidcoderDisableToolBridge: true,
      __lucidcoderPhase: 'question',
      __lucidcoderRequestType: 'question_decision_repair'
    }
  );

  try {
    return parseAgentJson(repaired);
  } catch {
    return null;
  }
};

const createAgentError = (message) => Object.assign(new Error(message), { statusCode: 502 });

const FALLBACK_SYSTEM_PROMPT = `You are a senior developer assistant. You will be given project files and a question about the project. Answer the question as accurately as possible using ONLY the supplied files. If the information is not present, say so explicitly. The repo may use frontend/ and backend/ subfolders for source code. You may use Markdown for formatting.`;

const collectFallbackSections = async (projectId, prompt) => {
  const sections = [];

  if (shouldIncludeGoalsContext(prompt)) {
    try {
      const goals = await listStoredGoals(projectId);
      if (goals.length) {
        sections.push({
          path: 'agent_goals',
          content: summarizeGoalsForPrompt(goals)
        });
      }
    } catch {
      // Ignore goal listing failures for fallback context.
    }
  }

  for (const relativePath of FALLBACK_FILES) {
    try {
      const content = await readProjectFile(projectId, relativePath);
      sections.push({ path: relativePath, content });
    } catch {
      // Ignore missing files.
    }
  }
  return sections;
};

const tryFallbackAnswer = async ({ projectId, prompt, steps }) => {
  const sections = await collectFallbackSections(projectId, prompt);
  if (!sections.length) {
    return null;
  }

  const contextText = sections
    .map((section) => `FILE: ${section.path}\n${summarizeContent(section.content)}`)
    .join('\n\n');

  const messages = [
    { role: 'system', content: FALLBACK_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `QUESTION:\n${prompt}\n\nPROJECT FILES:\n${contextText}`
    }
  ];

  const rawAnswer = await llmClient.generateResponse(messages, {
    max_tokens: 600,
    temperature: 0,
    __lucidcoderDisableToolBridge: true,
    __lucidcoderPhase: 'question',
    __lucidcoderRequestType: 'question_fallback_answer'
  });

  const answer = rawAnswer?.trim();
  if (!answer) {
    return null;
  }

  const fallbackSteps = [
    {
      type: 'action',
      action: 'fallback_context',
      reason: 'Gather default project files to answer directly.'
    },
    ...sections.map((section) => ({
      type: 'observation',
      action: 'read_file',
      target: section.path,
      summary: summarizeContent(section.content)
    }))
  ];

  steps.push(...fallbackSteps);
  return { answer, steps };
};

export const answerProjectQuestion = async ({ projectId, prompt }) => {
  if (!projectId) {
    throw new Error('projectId is required');
  }
  if (!prompt || !prompt.trim()) {
    throw new Error('prompt is required');
  }

  const steps = [];

  await preloadGoalsContext({ projectId, prompt, steps });

  for (let iteration = 0; iteration < MAX_AGENT_STEPS; iteration += 1) {
    const messages = buildMessages(prompt, steps);
    const rawDecision = await llmClient.generateResponse(messages, {
      max_tokens: 600,
      temperature: 0,
      __lucidcoderDisableToolBridge: true,
      __lucidcoderPhase: 'question',
      __lucidcoderRequestType: 'question_decision'
    });

    let decision;
    try {
      decision = parseAgentJson(rawDecision);
    } catch (error) {
      const repaired = await tryRepairPlannerJson({ messages, rawDecision });
      if (repaired) {
        decision = repaired;
      } else {
        const fallback = await tryFallbackAnswer({ projectId, prompt, steps });
        if (fallback) {
          return fallback;
        }
        throw error;
      }
    }
    const action = decision.action;

    if (action === 'read_file') {
      const targetPath = decision.path?.trim();
      if (!targetPath) {
        throw createAgentError('read_file action missing path');
      }
      steps.push({
        type: 'action',
        action: 'read_file',
        target: targetPath,
        reason: decision.reason || ''
      });

      try {
        const content = await readProjectFile(projectId, targetPath);
        steps.push({
          type: 'observation',
          action: 'read_file',
          target: targetPath,
          summary: summarizeContent(content)
        });
      } catch (error) {
        steps.push({
          type: 'observation',
          action: 'read_file',
          target: targetPath,
          error: error.message || 'Failed to read file'
        });
      }

      continue;
    }

    if (action === 'list_goals') {
      steps.push({
        type: 'action',
        action: 'list_goals',
        target: 'agent_goals',
        reason: decision.reason || 'Load stored goals'
      });

      try {
        const goals = await listStoredGoals(projectId);
        steps.push({
          type: 'observation',
          action: 'list_goals',
          target: 'agent_goals',
          summary: goals.length ? summarizeGoalsForPrompt(goals) : 'No stored goals found for this project.'
        });
      } catch (error) {
        steps.push({
          type: 'observation',
          action: 'list_goals',
          target: 'agent_goals',
          error: error?.message || 'Failed to list goals'
        });
      }

      continue;
    }

    if (action === 'answer') {
      const answer = decision.answer?.trim();
      if (!answer) {
        throw createAgentError('Answer action missing answer text');
      }
      steps.push({ type: 'answer', content: answer });
      return { answer, steps };
    }

    if (action === 'unable') {
      const fallback = await tryFallbackAnswer({ projectId, prompt, steps });
      if (fallback) {
        return fallback;
      }
      throw createAgentError(decision.explanation || 'Agent reported it cannot answer the question.');
    }

    throw createAgentError(`Unknown agent action: ${action}`);
  }

  const fallback = await tryFallbackAnswer({ projectId, prompt, steps });
  if (fallback) {
    return fallback;
  }
  throw createAgentError('The agent was unable to answer the question within the step limit.');
};

export const __testUtils = {
  formatStepsForPrompt,
  summarizeContent,
  coerceJsonObject,
  shouldIncludeGoalsContext
};

export default {
  answerProjectQuestion
};
