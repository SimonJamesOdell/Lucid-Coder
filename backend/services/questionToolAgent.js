import { llmClient } from '../llm-client.js';
import { listProjectDirectory, readProjectFile } from './projectTools.js';
import { listGoals as listStoredGoals } from './goalStore.js';
import JSON5 from 'json5';

const MAX_AGENT_STEPS = 4;
const CONTENT_SNIPPET_LIMIT = 1200;

/* c8 ignore start */
const SYSTEM_PROMPT = `You are an autonomous software engineer with access to developer tools.
You must figure out answers about a project by reasoning step-by-step and using tools when needed.

IMPORTANT:
- You must respond with a SINGLE JSON object and nothing else (no prose, no Markdown, no code fences).
- You may request tools by returning either a JSON action object or a tool call. Tool calls will be converted into JSON actions automatically.
- Return complete answers (no truncation). If you format with Markdown, ensure it is fully closed and complete.
- This repo often uses a workspace layout. Frontend files usually live under frontend/ and backend files under backend/. Check those folders first for UI questions.
 - Output MUST be plain text JSON in the assistant message content. Do NOT use tool_calls/function_call.

TOOLS AVAILABLE:
- read_file(path): returns the contents of the project file at the given relative path.
- list_dir(path?): lists files and folders at a relative path (root if omitted).
- list_goals(): returns the persisted goals for the current project (from the DB).

RESPONSE FORMAT:
Always respond with a strict JSON object containing:
{
  "action": "read_file" | "list_dir" | "list_goals" | "answer" | "unable",
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

const summarizeDirectory = (entries = []) => {
  if (!Array.isArray(entries) || entries.length === 0) {
    return 'Directory is empty.';
  }
  const lines = entries.map((entry) => `${entry.type === 'dir' ? 'dir' : 'file'}: ${entry.name}`);
  return summarizeContent(lines.join('\n'));
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
    if (typeof raw === 'string' && raw.trim()) {
      return { action: 'answer', answer: raw.trim() };
    }
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
      '{"action":"read_file"|"list_dir"|"list_goals"|"answer"|"unable","path"?:string,"reason"?:string,"answer"?:string,"explanation"?:string}.'
  };

  const repaired = await llmClient.generateResponse(
    [...messages, repairSystem, assistantDraft, repairUser],
    {
      max_tokens: 600,
      temperature: 0,
      __lucidcoderDisableToolBridge: false,
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
      __lucidcoderDisableToolBridge: false,
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

    if (action === 'list_dir') {
      const targetPath = decision.path?.trim() || '';
      steps.push({
        type: 'action',
        action: 'list_dir',
        target: targetPath || '.',
        reason: decision.reason || 'List files and folders'
      });

      try {
        const entries = await listProjectDirectory(projectId, targetPath);
        steps.push({
          type: 'observation',
          action: 'list_dir',
          target: targetPath || '.',
          summary: summarizeDirectory(entries)
        });
      } catch (error) {
        steps.push({
          type: 'observation',
          action: 'list_dir',
          target: targetPath || '.',
          error: error.message || 'Failed to list directory'
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
      throw createAgentError(decision.explanation || 'Agent reported it cannot answer the question.');
    }

    throw createAgentError(`Unknown agent action: ${action}`);
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
