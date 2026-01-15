import {
  createGoal as createStoredGoal,
  getGoal as getStoredGoal,
  listGoals as listStoredGoals,
  updateGoalStatus as updateStoredGoalStatus,
  updateGoalLifecycleState as updateStoredGoalLifecycleState,
  deleteGoal as deleteStoredGoal,
  createGoalTask,
  listGoalTasks,
  updateGoalTaskStatus
} from './goalStore.js';
import { startJob, waitForJobCompletion, JOB_STATUS } from './jobRunner.js';
import { llmClient } from '../llm-client.js';
import { ensureGitRepository, runGitCommand } from '../utils/git.js';
import { assertGoalTransition, isGoalState } from './goalLifecycle.js';
import { isStyleOnlyPrompt, extractStyleColor } from './promptHeuristics.js';

const PHASES = ['planning', 'testing', 'implementing', 'verifying', 'ready', 'failed'];

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

    if (ch === '"' && !escapeNext) {
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
  if (raw == null) {
    return null;
  }

  const trimmed = stripCodeFences(raw);
  if (!trimmed || typeof trimmed !== 'string') {
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

const isValidPhase = (phase) => PHASES.includes(phase);

const getNextAllowedPhases = (current) => {
  switch (current) {
    case 'planning':
      return ['testing'];
    case 'testing':
      return ['implementing', 'failed'];
    case 'implementing':
      return ['verifying', 'failed'];
    case 'verifying':
      return ['ready', 'failed'];
    case 'ready':
    case 'failed':
    default:
      return [];
  }
};

const extractAcceptanceCriteria = (prompt = '') => {
  const lines = prompt.split(/\r?\n/);
  let sectionStart = -1;
  const criteria = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] || '';
    const match = line.match(/^\s*(acceptance\s*criteria|ac)\s*:\s*(.*)$/i);
    if (match) {
      const inline = (match[2] || '').trim();
      if (inline) {
        criteria.push(inline);
      }
      sectionStart = i + 1;
      break;
    }
  }

  if (sectionStart === -1) return [];

  for (let i = sectionStart; i < lines.length; i += 1) {
    const raw = lines[i] || '';
    const trimmed = raw.trim();

    if (!trimmed) {
      if (criteria.length > 0) break;
      continue;
    }

    // Stop when a new section header begins.
    if (/^[A-Za-z][A-Za-z0-9 _-]{0,40}:\s*$/.test(trimmed)) {
      break;
    }

    const bulletMatch = trimmed.match(/^(?:[-*•]|\d+[.)])\s+(.+?)\s*$/);
    if (bulletMatch) {
      criteria.push(bulletMatch[1].trim());
    }
  }

  return Array.from(new Set(criteria)).filter(Boolean);
};

const DONE_QUESTION = 'What should "done" look like? Please provide acceptance criteria.';
const EXPECTED_ACTUAL_QUESTION = 'What is the expected behavior, and what is currently happening?';

const looksUnderspecified = (prompt) => {
  const normalized = prompt.trim().toLowerCase();
  if (!normalized) return true;

  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  if (wordCount <= 2) return true;

  if (/^(build|make|create)\b/.test(normalized) && /\b(something|anything|stuff|thing)\b/.test(normalized)) {
    return true;
  }

  return false;
};

const looksLikeBugFix = (prompt) => /\b(fix|bug|broken|error|issue|crash)\b/i.test(prompt);

const hasExpectedActualContext = (prompt) =>
  /\b(expected|actual|currently|steps to reproduce|repro)\b/i.test(prompt);

const extractClarifyingQuestions = ({ prompt, acceptanceCriteria = [] }) => {
  if (acceptanceCriteria.length > 0) return [];

  const questions = [];
  if (looksUnderspecified(prompt) || looksLikeBugFix(prompt)) {
    questions.push(DONE_QUESTION);
  }

  if (looksLikeBugFix(prompt) && !hasExpectedActualContext(prompt)) {
    questions.push(EXPECTED_ACTUAL_QUESTION);
  }

  return Array.from(new Set(questions)).filter(Boolean);
};

const TITLE_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'at',
  'but',
  'for',
  'from',
  'in',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with'
]);

const TITLE_PREFIX_PATTERN = /^(?:please|can you|could you|would you|let['\u2019]?s|lets|we need to|i need to|need to|make sure to|ensure)[\s,:-]*/i;
const MAX_TITLE_LENGTH = 96;

const deriveGoalTitle = (value, { fallback = 'Goal' } = {}) => {
  const raw = typeof value === 'string' ? value : '';
  const trimmed = raw.trim();
  if (!trimmed) {
    return fallback;
  }

  const [firstLine] = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .concat(trimmed);

  const sanitized = firstLine
    .replace(/^['"`]+/, '')
    .replace(/['"`]+$/, '');

  const withoutPrefix = sanitized.replace(TITLE_PREFIX_PATTERN, '').trim();
  if (!withoutPrefix) {
    return fallback;
  }

  const collapsed = withoutPrefix.replace(/\s+/g, ' ');
  const limited =
    collapsed.length > MAX_TITLE_LENGTH
      ? collapsed.slice(0, MAX_TITLE_LENGTH).replace(/\s+\S*$/, '')
      : collapsed;

  const words = limited.split(' ');
  const titled = words
    .map((word, index) => {
      const lower = word.toLowerCase();
      const preserveUpper =
        word === word.toUpperCase() && /[A-Z]/.test(word) && word.length <= 5 && !TITLE_STOPWORDS.has(lower);
      if (preserveUpper) {
        return word;
      }
      if (index > 0 && TITLE_STOPWORDS.has(lower)) {
        return lower;
      }
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');

  return titled;
};

const normalizePlannerPrompt = (value) => (typeof value === 'string' ? value.trim() : '');

export const createGoalFromPrompt = async ({ projectId, prompt, title = null }) => {
  if (!projectId) {
    throw new Error('projectId is required');
  }
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('prompt is required');
  }

  const rawPrompt = prompt;
  const normalizedPrompt = rawPrompt.trim();

  const acceptanceCriteria = extractAcceptanceCriteria(rawPrompt);
  const clarifyingQuestions = extractClarifyingQuestions({ prompt: rawPrompt, acceptanceCriteria });

  const styleOnly = isStyleOnlyPrompt(rawPrompt);
  const metadata = {
    ...(acceptanceCriteria.length > 0 ? { acceptanceCriteria } : {}),
    ...(clarifyingQuestions.length > 0 ? { clarifyingQuestions } : {}),
    ...(styleOnly ? { styleOnly: true } : {})
  };
  const metadataOrNull = Object.keys(metadata).length > 0 ? metadata : null;

  const goalTitle = typeof title === 'string' && title.trim() ? title.trim() : deriveGoalTitle(normalizedPrompt);

  // Initial phase is planning for all new goals.
  const goal = await createStoredGoal({
    projectId,
    prompt: rawPrompt,
    title: goalTitle,
    status: 'planning',
    metadata: metadataOrNull
  });

  if (clarifyingQuestions.length > 0) {
    await createGoalTask(goal.id, {
      type: 'clarification',
      title: 'Clarify goal requirements',
      payload: {
        prompt: rawPrompt,
        questions: clarifyingQuestions
      }
    });
  } else {
    // Seed an initial analysis task; later this will run real planning.
    await createGoalTask(goal.id, {
      type: 'analysis',
      title: 'Analyse goal and propose plan',
      payload: {
        prompt: rawPrompt,
        ...(acceptanceCriteria.length > 0 ? { acceptanceCriteria } : {})
      }
    });
  }

  const tasks = await listGoalTasks(goal.id);
  return { goal, tasks };
};

export const createChildGoal = async ({ projectId, parentGoalId, prompt, title = null }) => {
  if (!parentGoalId) {
    throw new Error('parentGoalId is required');
  }
  const parent = await getStoredGoal(parentGoalId);
  if (!parent) {
    throw new Error('Parent goal not found');
  }
  if (parent.projectId !== projectId) {
    throw new Error('Child goal must use same projectId as parent');
  }

  if (!prompt || typeof prompt !== 'string') {
    throw new Error('prompt is required');
  }

  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) {
    throw new Error('prompt is required');
  }

  const childTitle = typeof title === 'string' && title.trim() ? title.trim() : deriveGoalTitle(normalizedPrompt);

  const goal = await createStoredGoal({
    projectId,
    prompt: normalizedPrompt,
    title: childTitle,
    status: 'planning',
    parentGoalId
  });

  return goal;
};

const normalizeChildPlans = (entries = []) => {
  const plans = [];
  entries.forEach((entry, index) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const prompt = typeof entry.prompt === 'string' ? entry.prompt.trim() : '';
      if (!prompt) {
        return;
      }
      const providedTitle = typeof entry.title === 'string' ? entry.title.trim() : '';
      const titleFallback = providedTitle || `Child Goal ${index + 1}`;
      plans.push({
        prompt,
        title: providedTitle || deriveGoalTitle(prompt, { fallback: titleFallback })
      });
      return;
    }

    const prompt = typeof entry === 'string' ? entry.trim() : '';
    if (!prompt) {
      return;
    }
    plans.push({
      prompt,
      title: deriveGoalTitle(prompt, { fallback: `Child Goal ${index + 1}` })
    });
  });
  return plans;
};

export const createMetaGoalWithChildren = async ({
  projectId,
  prompt,
  childPrompts = [],
  parentGoalId = null,
  parentTitle = null
}) => {
  if (!Array.isArray(childPrompts)) {
    throw new Error('childPrompts must be an array');
  }

  const normalizedChildPlans = normalizeChildPlans(childPrompts);

  const resolveExistingChildren = async (parent) => {
    const allGoals = await listStoredGoals(projectId);
    const children = allGoals
      .filter((goal) => goal.parentGoalId && String(goal.parentGoalId) === String(parent.id))
      .sort((a, b) => {
        const aTime = a.createdAt ? Date.parse(a.createdAt) : NaN;
        const bTime = b.createdAt ? Date.parse(b.createdAt) : NaN;
        if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
          return aTime - bTime;
        }
        return Number(a.id) - Number(b.id);
      });
    return children;
  };

  const ensureParentGoal = async (parentGoalId) => {
    const parent = await getStoredGoal(parentGoalId);
    if (!parent) {
      throw new Error('Parent goal not found');
    }
    if (String(parent.projectId) !== String(projectId)) {
      throw new Error('Parent goal must use same projectId');
    }
    return parent;
  };

  const parent = parentGoalId
    ? await ensureParentGoal(parentGoalId)
    : (await createGoalFromPrompt({ projectId, prompt, title: parentTitle })).goal;

  const existingChildren = await resolveExistingChildren(parent);
  if (existingChildren.length > 0) {
    return { parent, children: existingChildren };
  }

  const children = [];
  for (const childPlan of normalizedChildPlans) {
    const child = await createChildGoal({
      projectId,
      parentGoalId: parent.id,
      prompt: childPlan.prompt,
      title: childPlan.title
    });
    children.push(child);
  }

  return { parent, children };
};

export const planGoalFromPrompt = async ({ projectId, prompt, goalId = null }) => {
  if (!projectId) {
    throw new Error('projectId is required');
  }
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('prompt is required');
  }

  if (goalId != null) {
    const parent = await getStoredGoal(goalId);
    if (!parent) {
      throw new Error('Parent goal not found');
    }
    if (String(parent.projectId) !== String(projectId)) {
      throw new Error('Parent goal must use same projectId');
    }

    const allGoals = await listStoredGoals(projectId);
    const existingChildren = allGoals
      .filter((goal) => goal.parentGoalId && String(goal.parentGoalId) === String(parent.id))
      .sort((a, b) => {
        const aTime = a.createdAt ? Date.parse(a.createdAt) : NaN;
        const bTime = b.createdAt ? Date.parse(b.createdAt) : NaN;
        if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
          return aTime - bTime;
        }
        return Number(a.id) - Number(b.id);
      });

    if (existingChildren.length > 0) {
      return { parent, children: existingChildren };
    }
  }

  if (isStyleOnlyPrompt(prompt)) {
    const colorDescriptor = extractStyleColor(prompt);
    const backgroundPrompt = colorDescriptor
      ? `Change the background color to ${colorDescriptor} (CSS-only change; no tests required).`
      : 'Update the background color as requested (CSS-only change; no tests required).';

    const childPrompts = [
      'Create a branch for this change if needed.',
      backgroundPrompt,
      'Stage the updated file(s).'
    ];

    return createMetaGoalWithChildren({ projectId, prompt, childPrompts, parentGoalId: goalId });
  }

  // The executor runs tests/coverage programmatically, so planning should not include
  // "run tests"/"run coverage"/"rerun tests" steps (but it may include "add tests"/"update tests").
  const isProgrammaticVerificationStep = (value) => {
    const text = normalizePlannerPrompt(value);
    if (!text) return false;

    // Matches phrases like:
    // - Run unit tests...
    // - Re-run integration tests...
    // - Run coverage / check coverage / ensure coverage thresholds...
    // - npm run test / yarn test / pnpm test
    const looksLikeCommand = /(\bnpm\b|\byarn\b|\bpnpm\b)\s+run\s+\btest\b/i.test(text);
    if (looksLikeCommand) return true;

    const verb = /^(run|re-?run|execute|verify|check)\b/i;
    if (!verb.test(text)) return false;

    return /(\bunit\s+tests\b|\bintegration\s+tests\b|\btests\b|\bvitest\b|\bcoverage\b)/i.test(text);
  };

  const systemMessage = {
    role: 'system',
    content:
      'You are a software planning assistant. Given a high-level user request, ' +
      'decompose it into the smallest list of concrete development goals needed to satisfy the request. ' +
      'Do NOT include steps about running tests, running coverage, or re-running tests/coverage (those happen automatically). ' +
      'You MAY include steps that add/update tests as part of the work. ' +
      'Respond with JSON shaped exactly like ' +
      '{ "parentTitle": "Short summary (<=10 words)", ' +
      '  "childGoals": [ { "title": "Short label (<=8 words)", "prompt": "Detailed implementation instructions" } ] }.'
  };

  const userMessage = {
    role: 'user',
    content: `Plan work for this request: "${prompt}"`
  };

  const raw = await llmClient.generateResponse([systemMessage, userMessage], {
    max_tokens: 400,
    temperature: 0.4,
    __lucidcoderPhase: 'meta_goal_planning',
    __lucidcoderRequestType: 'plan_meta_goals'
  });

  console.log('[DEBUG] LLM raw response:', raw);
  const parsed = extractJsonObject(raw);
  console.log('[DEBUG] Parsed JSON:', parsed);
  
  if (!parsed) {
    console.error('[ERROR] Failed to parse JSON from LLM response');
    throw new Error('LLM planning response was not valid JSON');
  }

  const parentTitle = typeof parsed.parentTitle === 'string' ? parsed.parentTitle.trim() : '';

  let childEntries = [];
  if (Array.isArray(parsed.childGoals)) {
    childEntries = parsed.childGoals
      .map((entry) => ({
        title: typeof entry?.title === 'string' ? entry.title.trim() : '',
        prompt: typeof entry?.prompt === 'string' ? entry.prompt.trim() : ''
      }));
  } else if (Array.isArray(parsed.childPrompts)) {
    childEntries = parsed.childPrompts
      .map((candidate) => ({
        title: '',
        prompt: typeof candidate === 'string' ? candidate.trim() : ''
      }));
  } else {
    console.error('[ERROR] LLM response missing child goals:', parsed);
    throw new Error('LLM planning response missing childGoals array');
  }

  if (childEntries.length === 0) {
    console.error('[ERROR] LLM response returned no child goals');
    throw new Error('LLM planning response has empty childGoals array');
  }

  const unique = new Set();
  const childPlans = [];
  for (const entry of childEntries) {
    if (isProgrammaticVerificationStep(entry.prompt)) continue;
    const text = normalizePlannerPrompt(entry.prompt);
    if (!text) continue;
    if (unique.has(text)) continue;
    unique.add(text);
    childPlans.push({ prompt: text, title: entry.title });
  }

  if (childPlans.length === 0) {
    throw new Error('LLM planning produced no usable child prompts');
  }

  return createMetaGoalWithChildren({
    projectId,
    prompt,
    childPrompts: childPlans,
    parentGoalId: goalId,
    parentTitle: parentTitle || null
  });
};

export const getGoalWithTasks = async (goalId) => {
  const goal = await getStoredGoal(goalId);
  if (!goal) return null;
  const tasks = await listGoalTasks(goalId);
  return { goal, tasks };
};

export const listGoalsForProject = async (projectId, { includeArchived = false } = {}) => {
  const goals = await listStoredGoals(projectId, { includeArchived });
  return goals;
};

export const deleteGoalById = async (goalId, options = undefined) => {
  return deleteStoredGoal(goalId, options);
};

export const advanceGoalState = async (goalId, targetState, metadataUpdates = {}) => {
  if (!isGoalState(targetState)) {
    throw new Error(`Unknown state: ${targetState}`);
  }

  const goal = await getStoredGoal(goalId);
  if (!goal) {
    throw new Error('Goal not found');
  }

  const fromState = goal.lifecycleState || 'draft';
  assertGoalTransition(fromState, targetState);

  const existingMeta = goal.metadata && typeof goal.metadata === 'object' ? goal.metadata : {};
  const nextMeta = { ...existingMeta, ...metadataUpdates };

  return updateStoredGoalLifecycleState(goalId, targetState, nextMeta);
};

export const advanceGoalPhase = async (goalId, targetPhase, metadataUpdates = {}) => {
  if (!isValidPhase(targetPhase)) {
    throw new Error(`Unknown phase: ${targetPhase}`);
  }

  const goal = await getStoredGoal(goalId);
  if (!goal) {
    throw new Error('Goal not found');
  }

  const allowed = getNextAllowedPhases(goal.status || 'planning');
  if (!allowed.includes(targetPhase)) {
    throw new Error('Invalid phase transition');
  }

  // Note: We intentionally do not enforce TDD/test ordering here.
  // The executor is responsible for running tests/coverage with hard retry limits.

  const existingMeta = goal.metadata && typeof goal.metadata === 'object' ? goal.metadata : {};
  const nextMeta = { ...existingMeta, ...metadataUpdates };

  const updated = await updateStoredGoalStatus(goalId, targetPhase, nextMeta);
  return updated;
};

export const recordTestRunForGoal = async (goalId, { status, summary, logs } = {}) => {
  if (!goalId) {
    throw new Error('goalId is required');
  }
  if (!status) {
    throw new Error('status is required');
  }

  const goal = await getStoredGoal(goalId);
  if (!goal) {
    throw new Error('Goal not found');
  }

  const task = await createGoalTask(goalId, {
    type: 'test-run',
    title: 'Automated test run',
    payload: null
  });

  const updatedTask = await updateGoalTaskStatus(task.id, status, {
    summary: summary || null,
    logs: logs || []
  });

  return updatedTask;
};

export const runTestsForGoal = async (goalId, { cwd, command, args = [], env = {} } = {}) => {
  if (!goalId) {
    throw new Error('goalId is required');
  }

  const goal = await getStoredGoal(goalId);
  if (!goal) {
    throw new Error('Goal not found');
  }

  if (!cwd || !command) {
    throw new Error('cwd and command are required to run tests');
  }

  const job = startJob({
    projectId: goal.projectId,
    type: 'test-run',
    displayName: 'Agent test run',
    command,
    args,
    cwd,
    env
  });

  const completed = await waitForJobCompletion(job.id);
  const logs = (completed.logs || []).map((entry) => `${entry.stream}: ${entry.message}`);
  const status = completed.status === JOB_STATUS.SUCCEEDED ? 'passed' : 'failed';

  const task = await recordTestRunForGoal(goalId, {
    status,
    summary: status === 'passed' ? 'Tests passed' : 'Tests failed',
    logs
  });

  return task;
};

export const ensureGoalBranch = async (goalId, { projectPath, defaultBranch = 'main' } = {}) => {
  if (!goalId) {
    throw new Error('goalId is required');
  }
  if (!projectPath) {
    throw new Error('projectPath is required');
  }

  const goal = await getStoredGoal(goalId);
  if (!goal) {
    throw new Error('Goal not found');
  }

  if (goal.branchName) {
    return goal.branchName;
  }

  await ensureGitRepository(projectPath, { defaultBranch });

  const refreshedGoal = await getStoredGoal(goalId);
  const branchName = refreshedGoal?.branchName || goal.branchName;
  if (!branchName) {
    throw new Error('Goal branch name unavailable');
  }

  await runGitCommand(projectPath, ['checkout', '-B', branchName]);

  return branchName;
};

export const __testExports__ = {
  normalizeJsonLikeText,
  deriveGoalTitle,
  normalizeChildPlans,
  normalizePlannerPrompt
};

export default {
  createGoalFromPrompt,
  createChildGoal,
  createMetaGoalWithChildren,
  planGoalFromPrompt,
  getGoalWithTasks,
  listGoalsForProject,
  advanceGoalPhase,
  recordTestRunForGoal,
  runTestsForGoal
};
