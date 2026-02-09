import fs from 'fs/promises';
import path from 'path';
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
import { getProject } from '../database.js';
import { assertGoalTransition, isGoalState } from './goalLifecycle.js';
import { isStyleOnlyPrompt, extractStyleColor } from './promptHeuristics.js';
import {
  extractJsonObject,
  extractFirstJsonObjectSubstring,
  normalizeJsonLikeText,
  stripCodeFences
} from './agentOrchestrator/jsonParsing.js';
import {
  createBuildGoalMetadataFromPrompt,
  createRequestClarificationQuestions,
  extractAcceptanceCriteria,
  normalizeClarifyingQuestions
} from './agentOrchestrator/goalMetadata.js';
import { deriveGoalTitle } from './agentOrchestrator/goalTitle.js';
import {
  buildHeuristicChildPlans,
  isCompoundPrompt,
  isLowInformationPlan,
  isProgrammaticVerificationStep,
  normalizeChildPlans,
  normalizeGoalPlanTree,
  normalizePlannerPrompt
} from './agentOrchestrator/planningHeuristics.js';
import {
  createReadJsonFile,
  createReadTextFile,
  createResolveProjectStackContext,
  detectBackendFramework,
  detectFrontendFramework,
  detectPythonFramework,
  normalizeDeps,
  truncateSection
} from './agentOrchestrator/projectStackContext.js';
import {
  createBuildPlannerProjectSnapshot,
  createCollectProjectFileList
} from './agentOrchestrator/projectSnapshot.js';

const PHASES = ['planning', 'testing', 'implementing', 'verifying', 'ready', 'failed'];

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

const DONE_QUESTION = 'What should "done" look like? Please provide acceptance criteria.';
const EXPECTED_ACTUAL_QUESTION = 'What is the expected behavior, and what is currently happening?';

const readJsonFile = createReadJsonFile(fs);
const readTextFile = createReadTextFile(fs);
const resolveProjectStackContext = createResolveProjectStackContext({
  getProject: (...args) => getProject(...args),
  path,
  readJsonFile,
  readTextFile
});
const collectProjectFileList = createCollectProjectFileList({ fs, path });
const buildPlannerProjectSnapshot = createBuildPlannerProjectSnapshot({
  getProject: (...args) => getProject(...args),
  path,
  readTextFile,
  truncateSection,
  collectProjectFileList
});

const requestClarificationQuestions = createRequestClarificationQuestions({
  llmClient,
  extractJsonObject
});
const buildGoalMetadataFromPrompt = createBuildGoalMetadataFromPrompt({ isStyleOnlyPrompt });

const mergeStringArray = (base = [], extra = []) => {
  const normalized = [];
  const addValue = (value) => {
    if (typeof value !== 'string') {
      return;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    normalized.push(trimmed);
  };

  base.forEach(addValue);
  extra.forEach(addValue);

  return Array.from(new Set(normalized));
};

const mergeGoalMetadata = ({ baseMetadata, extraMetadata, acceptanceCriteria, clarifyingQuestions }) => {
  const normalizedExtra = extraMetadata && typeof extraMetadata === 'object'
    ? { ...extraMetadata }
    : null;
  const suppressClarifyingQuestions = normalizedExtra?.suppressClarifyingQuestions === true
    || Boolean(normalizedExtra?.testFailure)
    || Boolean(normalizedExtra?.uncoveredLines);
  if (normalizedExtra) {
    delete normalizedExtra.suppressClarifyingQuestions;
    if (suppressClarifyingQuestions) {
      delete normalizedExtra.clarifyingQuestions;
    }
  }

  const mergedAcceptanceCriteria = mergeStringArray(
    acceptanceCriteria,
    normalizedExtra?.acceptanceCriteria || []
  );
  const mergedClarifyingQuestions = suppressClarifyingQuestions
    ? []
    : mergeStringArray(
      clarifyingQuestions,
      normalizedExtra?.clarifyingQuestions || []
    );

  const merged = {
    ...(baseMetadata || {}),
    ...(normalizedExtra || {}),
    ...(mergedAcceptanceCriteria.length > 0 ? { acceptanceCriteria: mergedAcceptanceCriteria } : {}),
    ...(mergedClarifyingQuestions.length > 0 ? { clarifyingQuestions: mergedClarifyingQuestions } : {})
  };

  return {
    metadata: Object.keys(merged).length > 0 ? merged : null,
    acceptanceCriteria: mergedAcceptanceCriteria,
    clarifyingQuestions: mergedClarifyingQuestions
  };
};

const createGoalWithTasks = async ({
  projectId,
  prompt,
  title = null,
  parentGoalId = null,
  branchName = null,
  extraClarifyingQuestions = [],
  metadataOverrides = null
}) => {
  if (!projectId) {
    throw new Error('projectId is required');
  }
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('prompt is required');
  }

  const rawPrompt = prompt;
  const normalizedPrompt = rawPrompt.trim();

  const { metadata, acceptanceCriteria, clarifyingQuestions } = buildGoalMetadataFromPrompt({
    prompt: rawPrompt,
    extraClarifyingQuestions
  });
  const mergedMetadata = mergeGoalMetadata({
    baseMetadata: metadata,
    extraMetadata: metadataOverrides && typeof metadataOverrides === 'object' ? metadataOverrides : null,
    acceptanceCriteria,
    clarifyingQuestions
  });

  const goalTitle = typeof title === 'string' && title.trim()
    ? title.trim()
    : deriveGoalTitle(normalizedPrompt, { fallback: 'Goal' });

  const goal = await createStoredGoal({
    projectId,
    prompt: rawPrompt,
    title: goalTitle,
    status: 'planning',
    parentGoalId,
    branchName,
    metadata: mergedMetadata.metadata
  });

  if (mergedMetadata.clarifyingQuestions.length > 0) {
    await createGoalTask(goal.id, {
      type: 'clarification',
      title: 'Clarify goal requirements',
      payload: {
        prompt: rawPrompt,
        questions: mergedMetadata.clarifyingQuestions
      }
    });
  } else {
    await createGoalTask(goal.id, {
      type: 'analysis',
      title: 'Analyse goal and propose plan',
      payload: {
        prompt: rawPrompt,
        ...(mergedMetadata.acceptanceCriteria.length > 0 ? { acceptanceCriteria: mergedMetadata.acceptanceCriteria } : {})
      }
    });
  }

  const tasks = await listGoalTasks(goal.id);
  return { goal, tasks };
};

export const createGoalFromPrompt = async ({
  projectId,
  prompt,
  title = null,
  branchName = null,
  extraClarifyingQuestions = [],
  metadataOverrides = null
}) => {
  return createGoalWithTasks({
    projectId,
    prompt,
    title,
    branchName,
    extraClarifyingQuestions,
    metadataOverrides
  });
};

export const createChildGoal = async ({
  projectId,
  parentGoalId,
  prompt,
  title = null,
  branchName = null,
  extraClarifyingQuestions = [],
  metadataOverrides = null
}) => {
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

  const normalizedPrompt = typeof prompt === 'string' ? prompt.trim() : '';
  if (!normalizedPrompt) {
    throw new Error('prompt is required');
  }

  const { goal } = await createGoalWithTasks({
    projectId,
    prompt: normalizedPrompt,
    title,
    parentGoalId,
    branchName: branchName || parent.branchName,
    extraClarifyingQuestions,
    metadataOverrides
  });

  return goal;
};

const sortGoalsForTree = (items = []) => items.slice().sort((a, b) => {
  const aTime = a?.createdAt ? Date.parse(a.createdAt) : NaN;
  const bTime = b?.createdAt ? Date.parse(b.createdAt) : NaN;
  if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
    return aTime - bTime;
  }
  return Number(a?.id || 0) - Number(b?.id || 0);
});


const buildGoalTreeFromList = (goals = [], parentId = null) => {
  const map = new Map();
  goals.forEach((goal) => {
    map.set(goal.id, { ...goal, children: [] });
  });

  map.forEach((node) => {
    if (node.parentGoalId && map.has(node.parentGoalId)) {
      map.get(node.parentGoalId).children.push(node);
    }
  });

  const roots = parentId == null
    ? Array.from(map.values()).filter((node) => !node.parentGoalId || !map.has(node.parentGoalId))
    : (map.get(parentId)?.children || []);

  const sortTree = (nodes) => {
    const sorted = sortGoalsForTree(nodes);
    sorted.forEach((node) => {
      if (Array.isArray(node.children) && node.children.length > 0) {
        node.children = sortGoalsForTree(node.children);
        sortTree(node.children);
      }
    });
    return sorted;
  };

  return sortTree(roots);
};

const normalizePromptKey = (value) => (typeof value === 'string' ? value.trim() : '');

const createGoalTreeWithChildren = async ({
  projectId,
  prompt,
  childPrompts = [],
  parentGoalId = null,
  parentTitle = null,
  parentExtraClarifyingQuestions = [],
  childPromptMetadata = null
}) => {
  if (!Array.isArray(childPrompts)) {
    throw new Error('childPrompts must be an array');
  }

  const normalizedChildPlans = normalizeGoalPlanTree(childPrompts);

  const ensureParentGoal = async (parentId) => {
    const parent = await getStoredGoal(parentId);
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
    : (await createGoalFromPrompt({
      projectId,
      prompt,
      title: parentTitle,
      extraClarifyingQuestions: parentExtraClarifyingQuestions
    })).goal;

  const allGoals = await listStoredGoals(projectId);
  const existingChildren = allGoals.filter((goal) =>
    goal.parentGoalId && String(goal.parentGoalId) === String(parent.id)
  );

  if (existingChildren.length > 0) {
    const tree = buildGoalTreeFromList(allGoals, parent.id);
    return { parent, children: tree };
  }

  const metadataMap = (() => {
    if (!childPromptMetadata || typeof childPromptMetadata !== 'object') {
      return new Map();
    }
    const entries = Object.entries(childPromptMetadata)
      .map(([key, value]) => [normalizePromptKey(key), value])
      .filter(([key]) => key);
    return new Map(entries);
  })();

  const createNode = async (plan, parentId) => {
    const metadataOverrides = metadataMap.get(normalizePromptKey(plan.prompt)) || null;
    const childGoal = await createChildGoal({
      projectId,
      parentGoalId: parentId,
      prompt: plan.prompt,
      title: plan.title,
      metadataOverrides
    });

    const nestedChildren = [];
    const childPlans = plan.children;
    for (const childPlan of childPlans) {
      const nested = await createNode(childPlan, childGoal.id);
      nestedChildren.push(nested);
    }

    return { ...childGoal, children: nestedChildren };
  };

  const children = [];
  for (const plan of normalizedChildPlans) {
    const node = await createNode(plan, parent.id);
    children.push(node);
  }

  return { parent, children };
};

export const createMetaGoalWithChildren = async ({
  projectId,
  prompt,
  childPrompts = [],
  parentGoalId = null,
  parentTitle = null,
  childPromptMetadata = null
}) => {
  return createGoalTreeWithChildren({
    projectId,
    prompt,
    childPrompts,
    parentGoalId,
    parentTitle,
    childPromptMetadata
  });
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

  const projectContext = await resolveProjectStackContext(projectId);
  const projectSnapshot = await buildPlannerProjectSnapshot(projectId);

  const buildPlannerMessages = (strict = false) => {
    const strictInstructions = strict
      ? 'Return 3-7 child goals unless the request is truly trivial. ' +
        'Each child goal must be actionable and include concrete implementation details. ' +
        'Do NOT restate the user prompt verbatim. ' +
        'Prefer generic, implementation-oriented steps that would apply to any web app unless project context is essential. '
      : '';

    const systemMessage = {
      role: 'system',
      content:
        'You are a software planning assistant. Given a high-level user request, ' +
        'decompose it into the smallest list of concrete development goals needed to satisfy the request. ' +
        'If any goal can be broken into subgoals, nest them under a "children" array. ' +
        'Do NOT include steps about running tests, running coverage, or re-running tests/coverage (those happen automatically). ' +
        'You MAY include steps that add/update tests as part of the work. ' +
        'If key details are missing, include a "questions" array with short clarifying questions. ' +
        'NEVER copy or paste the user request into any goal title or prompt. ' +
        'Avoid phrasing like "Implement the primary feature described in: <request>" or "Outline the main components needed for: <request>". ' +
        'If the request mentions placement (e.g., "top of the screen", "header", "sidebar"), include a goal to integrate into the app layout and apply minimal styling so the placement is honored. ' +
        'For navigation requests, avoid placing links inline in page content; prefer a dedicated navigation component mounted in the layout/header. ' +
        'Assume UI code lives under frontend/ and server code under backend/ unless the project context says otherwise. ' +
        'Preferred structure: one top-level goal with 3-5 sub-goals (children) that describe concrete steps. ' +
        'Example of good goal structure (do not copy, follow the style): ' +
        'For a nav bar request, good goals would be: ' +
        'Goal: Implement navigation bar. ' +
        'Sub-goal: Create or reuse a navigation bar component. ' +
        'Sub-goal: Create or reuse a dropdown menu component. ' +
        'Sub-goal: Mount the dropdown component within the navigation bar. ' +
        'Sub-goal: Mount the navigation bar within the main layout. ' +
        (projectContext
          ? `Project context:\n${projectContext}\n` +
            'Use the project context above only to refine or map generic goals when helpful. '
          : 'Project context is unavailable. ') +
        (projectSnapshot
          ? `Project snapshot:\n${projectSnapshot}\n` +
            'Use the snapshot to map generic goals to concrete files/components only when it clearly improves accuracy. '
          : '') +
        strictInstructions +
        ' Respond with JSON shaped like ' +
        '{ "parentTitle": "Short summary (<=10 words)", ' +
        '  "questions": ["Optional clarifying question"], ' +
        '  "childGoals": [ { "title": "Short label (<=8 words)", "prompt": "Detailed implementation instructions", "children": [ ... ] } ] }.'
    };

    const userMessage = {
      role: 'user',
      content: `Plan work for this request: "${prompt}"`
    };

    return [systemMessage, userMessage];
  };

  const requestPlannerResult = async (strict = false) => {
    const raw = await llmClient.generateResponse(buildPlannerMessages(strict), {
      max_tokens: 900,
      temperature: 0.3,
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
    const clarifyingQuestions = normalizeClarifyingQuestions(
      parsed?.questions || parsed?.clarifyingQuestions || []
    );

    let rawChildEntries = [];
    if (Array.isArray(parsed.childGoals)) {
      rawChildEntries = parsed.childGoals;
    } else if (Array.isArray(parsed.childPrompts)) {
      rawChildEntries = parsed.childPrompts;
    } else {
      console.error('[ERROR] LLM response missing child goals:', parsed);
      throw new Error('LLM planning response missing childGoals array');
    }

    if (rawChildEntries.length === 0) {
      console.error('[ERROR] LLM response returned no child goals');
      throw new Error('LLM planning response has empty childGoals array');
    }

    const normalizedChildPlans = normalizeGoalPlanTree(rawChildEntries);
    if (normalizedChildPlans.length === 0) {
      throw new Error('LLM planning produced no usable child prompts');
    }

    return { parentTitle, clarifyingQuestions, normalizedChildPlans };
  };

  let plan = await requestPlannerResult(false);
  if (isLowInformationPlan(prompt, plan.normalizedChildPlans)) {
    try {
      plan = await requestPlannerResult(true);
    } catch (retryError) {
      console.warn('[WARN] Strict planning retry failed:', retryError?.message || retryError);
      plan = {
        parentTitle: plan.parentTitle || null,
        clarifyingQuestions: plan.clarifyingQuestions,
        normalizedChildPlans: buildHeuristicChildPlans(prompt)
      };
    }
  }

  const shouldRequestClarifications = process.env.NODE_ENV !== 'test';
  if (shouldRequestClarifications && (!plan.clarifyingQuestions || plan.clarifyingQuestions.length === 0)) {
    try {
      plan.clarifyingQuestions = await requestClarificationQuestions(prompt, projectContext);
    } catch (error) {
      console.warn('[WARN] Clarification question generation failed:', error?.message || error);
    }
  }

  const normalizedChildPlans = plan.normalizedChildPlans;


  const result = await createGoalTreeWithChildren({
    projectId,
    prompt,
    childPrompts: normalizedChildPlans,
    parentGoalId: goalId,
    parentTitle: plan.parentTitle || null,
    parentExtraClarifyingQuestions: plan.clarifyingQuestions
  });

  return { ...result, questions: plan.clarifyingQuestions };
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
  stripCodeFences,
  extractFirstJsonObjectSubstring,
  extractJsonObject,
  extractAcceptanceCriteria,
  normalizeDeps,
  detectFrontendFramework,
  detectBackendFramework,
  detectPythonFramework,
  readJsonFile,
  readTextFile,
  deriveGoalTitle,
  normalizePromptKey,
  normalizeChildPlans,
  normalizeClarifyingQuestions,
  normalizePlannerPrompt,
  normalizeGoalPlanTree,
  buildGoalTreeFromList,
  buildGoalMetadataFromPrompt,
  buildHeuristicChildPlans,
  collectProjectFileList,
  buildPlannerProjectSnapshot,
  resolveProjectStackContext,
  truncateSection,
  isProgrammaticVerificationStep,
  isCompoundPrompt,
  isLowInformationPlan
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
