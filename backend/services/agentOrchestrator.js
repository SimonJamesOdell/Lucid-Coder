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

const MAX_PLAN_DEPTH = 4;
const MAX_PLAN_NODES = 40;

const readJsonFile = async (filePath) => {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const readTextFile = async (filePath) => {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
};

const normalizeDeps = (pkg) => ({
  ...(pkg?.dependencies || {}),
  ...(pkg?.devDependencies || {})
});

const detectFrontendFramework = (pkg) => {
  const deps = normalizeDeps(pkg);
  if (deps.react || deps['react-dom']) return 'react';
  if (deps.next) return 'nextjs';
  if (deps.vue) return 'vue';
  if (deps.nuxt) return 'nuxt';
  if (deps['@angular/core']) return 'angular';
  if (deps.svelte || deps['@sveltejs/kit']) return 'svelte';
  if (deps['solid-js']) return 'solid';
  if (deps.gatsby) return 'gatsby';
  if (deps.astro) return 'astro';
  return '';
};

const detectBackendFramework = (pkg) => {
  const deps = normalizeDeps(pkg);
  if (deps.express) return 'express';
  if (deps.fastify) return 'fastify';
  if (deps.koa) return 'koa';
  if (deps['@nestjs/core']) return 'nestjs';
  if (deps['@hapi/hapi']) return 'hapi';
  if (deps['@adonisjs/core']) return 'adonisjs';
  return '';
};

const detectPythonFramework = (requirementsText = '') => {
  const normalized = requirementsText.toLowerCase();
  if (/(^|\n)flask\b/.test(normalized)) return 'flask';
  if (/(^|\n)django\b/.test(normalized)) return 'django';
  if (/(^|\n)fastapi\b/.test(normalized)) return 'fastapi';
  if (/(^|\n)quart\b/.test(normalized)) return 'quart';
  return '';
};

const resolveProjectStackContext = async (projectId) => {
  const project = await getProject(projectId).catch(() => null);
  if (!project) {
    return null;
  }

  const projectPath = typeof project.path === 'string' && project.path.trim()
    ? project.path.trim()
    : '';

  let frontendFramework = project.frontend_framework || project.framework || '';
  let backendFramework = project.backend_framework || '';
  let frontendLanguage = project.frontend_language || project.language || '';
  let backendLanguage = project.backend_language || '';

  if (projectPath) {
    const frontendPackage = await readJsonFile(path.join(projectPath, 'frontend', 'package.json'));
    if (!frontendFramework) {
      frontendFramework = detectFrontendFramework(frontendPackage);
    }
    if (!frontendLanguage && frontendPackage) {
      frontendLanguage = 'javascript';
    }

    const backendPackage = await readJsonFile(path.join(projectPath, 'backend', 'package.json'));
    if (!backendFramework) {
      backendFramework = detectBackendFramework(backendPackage);
    }
    if (!backendLanguage && backendPackage) {
      backendLanguage = 'javascript';
    }

    if (!backendFramework || !backendLanguage) {
      const requirementsText = await readTextFile(path.join(projectPath, 'backend', 'requirements.txt'));
      const pythonFramework = detectPythonFramework(requirementsText);
      if (pythonFramework) {
        backendFramework = backendFramework || pythonFramework;
        backendLanguage = backendLanguage || 'python';
      }
    }
  }

  const normalizeValue = (value) => (typeof value === 'string' ? value.trim() : '');
  const summary = [
    `frontend: ${normalizeValue(frontendFramework) || 'unknown'} (${normalizeValue(frontendLanguage) || 'unknown'})`,
    `backend: ${normalizeValue(backendFramework) || 'unknown'} (${normalizeValue(backendLanguage) || 'unknown'})`
  ];

  if (projectPath) {
    summary.push(`path: ${projectPath}`);
  }

  return summary.join('\n');
};

const truncateSection = (value = '', limit = 2000) => {
  if (!value) {
    return '';
  }
  return value.length > limit ? `${value.slice(0, limit)}\n…truncated…` : value;
};

const SNAPSHOT_MAX_FILES = 200;
const SNAPSHOT_IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'coverage-tmp',
  '.cache',
  '.next',
  '.turbo',
  '.vite',
  '.idea',
  '.vscode'
]);
const SNAPSHOT_IGNORED_FILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  '.DS_Store'
]);

const collectProjectFileList = async (rootPath, limit = SNAPSHOT_MAX_FILES) => {
  const results = [];
  const queue = [''];

  while (queue.length && results.length < limit) {
    const relative = queue.shift();
    const absolute = path.join(rootPath, relative);
    let entries = [];

    try {
      entries = await fs.readdir(absolute, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (results.length >= limit) break;
      const entryName = entry.name;
      if (SNAPSHOT_IGNORED_FILES.has(entryName)) {
        continue;
      }
      const relPath = path.posix.join(relative.replace(/\\/g, '/'), entryName).replace(/^\//, '');
      if (entry.isDirectory()) {
        if (SNAPSHOT_IGNORED_DIRS.has(entryName)) {
          continue;
        }
        results.push(`${relPath}/`);
        queue.push(path.join(relative, entryName));
      } else {
        results.push(relPath);
      }
    }
  }

  return results;
};

const buildPlannerProjectSnapshot = async (projectId) => {
  const project = await getProject(projectId).catch(() => null);
  if (!project?.path) {
    return '';
  }

  const projectRoot = project.path;
  const sections = [];

  const pushFileSection = async (label, relativePath, limit = 2000) => {
    const content = await readTextFile(path.join(projectRoot, relativePath));
    if (content) {
      sections.push(`${label} (${relativePath}):\n${truncateSection(content, limit)}`);
    }
  };

  await pushFileSection('README', 'README.md', 1800);
  await pushFileSection('Root package.json', 'package.json', 1800);
  await pushFileSection('Frontend package.json', path.join('frontend', 'package.json'), 1800);
  await pushFileSection('Backend package.json', path.join('backend', 'package.json'), 1800);

  const commonFrontendEntries = [
    path.join('frontend', 'src', 'App.jsx'),
    path.join('frontend', 'src', 'App.tsx'),
    path.join('frontend', 'src', 'App.js'),
    path.join('frontend', 'src', 'main.jsx'),
    path.join('frontend', 'src', 'main.tsx'),
    path.join('frontend', 'src', 'main.js'),
    path.join('frontend', 'src', 'index.jsx'),
    path.join('frontend', 'src', 'index.tsx'),
    path.join('frontend', 'src', 'index.js')
  ];

  for (const entry of commonFrontendEntries) {
    await pushFileSection('Frontend entry', entry, 1400);
  }

  const fileList = await collectProjectFileList(projectRoot, SNAPSHOT_MAX_FILES);
  if (fileList.length > 0) {
    sections.push(`Project file list (truncated):\n${fileList.join('\n')}`);
  }

  return sections.join('\n\n');
};

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

const requestClarificationQuestions = async (prompt, projectContext) => {
  const systemMessage = {
    role: 'system',
    content:
      'You are a senior product engineer. Given a user request and project context, ' +
      'return ONLY JSON in the shape { "needsClarification": boolean, "questions": [string] }. ' +
      'Ask short, specific questions only if required to implement the request correctly. ' +
      'If the request is sufficiently specified, return {"needsClarification": false, "questions": []}. '
  };

  const userMessage = {
    role: 'user',
    content: [
      'Project context:',
      projectContext || 'Unavailable',
      '',
      `User request: "${prompt}"`
    ].join('\n')
  };

  const raw = await llmClient.generateResponse([systemMessage, userMessage], {
    max_tokens: 300,
    temperature: 0.2,
    __lucidcoderPhase: 'meta_goal_clarification',
    __lucidcoderRequestType: 'clarification_questions'
  });

  const parsed = extractJsonObject(raw) || {};
  const needsClarification = Boolean(parsed.needsClarification);
  const questions = normalizeClarifyingQuestions(parsed.questions || []);
  return needsClarification ? questions : [];
};

const normalizeClarifyingQuestions = (questions = []) => {
  if (!Array.isArray(questions)) return [];
  const cleaned = questions
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
  return Array.from(new Set(cleaned));
};

const buildGoalMetadataFromPrompt = ({ prompt, extraClarifyingQuestions = [] } = {}) => {
  const rawPrompt = typeof prompt === 'string' ? prompt : '';
  const acceptanceCriteria = extractAcceptanceCriteria(rawPrompt);
  const autoQuestions = extractClarifyingQuestions({ prompt: rawPrompt, acceptanceCriteria });
  const clarifyingQuestions = normalizeClarifyingQuestions([...autoQuestions, ...extraClarifyingQuestions]);
  const styleOnly = isStyleOnlyPrompt(rawPrompt);

  const metadata = {
    ...(acceptanceCriteria.length > 0 ? { acceptanceCriteria } : {}),
    ...(clarifyingQuestions.length > 0 ? { clarifyingQuestions } : {}),
    ...(styleOnly ? { styleOnly: true } : {})
  };

  return {
    metadata: Object.keys(metadata).length > 0 ? metadata : null,
    acceptanceCriteria,
    clarifyingQuestions,
    styleOnly
  };
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

const createGoalWithTasks = async ({
  projectId,
  prompt,
  title = null,
  parentGoalId = null,
  extraClarifyingQuestions = []
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

  const goalTitle = typeof title === 'string' && title.trim()
    ? title.trim()
    : deriveGoalTitle(normalizedPrompt, { fallback: 'Goal' });

  const goal = await createStoredGoal({
    projectId,
    prompt: rawPrompt,
    title: goalTitle,
    status: 'planning',
    parentGoalId,
    metadata
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

export const createGoalFromPrompt = async ({ projectId, prompt, title = null, extraClarifyingQuestions = [] }) => {
  return createGoalWithTasks({ projectId, prompt, title, extraClarifyingQuestions });
};

export const createChildGoal = async ({
  projectId,
  parentGoalId,
  prompt,
  title = null,
  extraClarifyingQuestions = []
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
    extraClarifyingQuestions
  });

  return goal;
};

const isProgrammaticVerificationStep = (value) => {
  const text = normalizePlannerPrompt(value);
  if (!text) return false;

  const looksLikeCommand = /(\bnpm\b|\byarn\b|\bpnpm\b)\s+run\s+\btest\b/i.test(text);
  if (looksLikeCommand) return true;

  const verb = /^(run|re-?run|execute|verify|check)\b/i;
  if (!verb.test(text)) return false;

  return /(\bunit\s+tests\b|\bintegration\s+tests\b|\btests\b|\bvitest\b|\bcoverage\b)/i.test(text);
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

const sortGoalsForTree = (items = []) => items.slice().sort((a, b) => {
  const aTime = a?.createdAt ? Date.parse(a.createdAt) : NaN;
  const bTime = b?.createdAt ? Date.parse(b.createdAt) : NaN;
  if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
    return aTime - bTime;
  }
  return Number(a?.id || 0) - Number(b?.id || 0);
});

const normalizeGoalPlanTree = (
  entries = [],
  { depth = 1, maxDepth = MAX_PLAN_DEPTH, maxNodes = MAX_PLAN_NODES, stats = { count: 0 } } = {}
) => {
  if (!Array.isArray(entries) || entries.length === 0 || depth > maxDepth) {
    return [];
  }

  const nodes = [];
  const seen = new Set();

  for (const entry of entries) {
    if (stats.count >= maxNodes) break;

    let prompt = '';
    let title = '';
    let childEntries = [];

    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      prompt = typeof entry.prompt === 'string' ? entry.prompt.trim() : '';
      title = typeof entry.title === 'string' ? entry.title.trim() : '';
      if (Array.isArray(entry.children)) {
        childEntries = entry.children;
      } else if (Array.isArray(entry.childGoals)) {
        childEntries = entry.childGoals;
      }
    } else if (typeof entry === 'string') {
      prompt = entry.trim();
    }

    const normalizedPrompt = normalizePlannerPrompt(prompt);
    const normalizedChildren = normalizeGoalPlanTree(childEntries, {
      depth: depth + 1,
      maxDepth,
      maxNodes,
      stats
    });

    if (!normalizedPrompt && normalizedChildren.length === 0) {
      continue;
    }

    if (normalizedPrompt && isProgrammaticVerificationStep(normalizedPrompt)) {
      if (normalizedChildren.length > 0) {
        nodes.push(...normalizedChildren);
      }
      continue;
    }

    if (!normalizedPrompt) {
      nodes.push(...normalizedChildren);
      continue;
    }

    if (seen.has(normalizedPrompt)) {
      if (normalizedChildren.length > 0) {
        nodes.push(...normalizedChildren);
      }
      continue;
    }

    seen.add(normalizedPrompt);
    stats.count += 1;

    const fallbackTitle = title || `Goal ${stats.count}`;
    nodes.push({
      prompt: normalizedPrompt,
      title: title || deriveGoalTitle(normalizedPrompt, { fallback: fallbackTitle }),
      children: normalizedChildren
    });
  }

  return nodes;
};

const normalizePlanComparison = (value) => (
  typeof value === 'string'
    ? value.toLowerCase().replace(/[^a-z0-9\s]/gi, ' ').replace(/\s+/g, ' ').trim()
    : ''
);

const isNearDuplicatePlan = (parentPrompt, childPrompt) => {
  const parent = normalizePlanComparison(parentPrompt);
  const child = normalizePlanComparison(childPrompt);
  if (!parent || !child) return false;
  if (parent.includes(child) || child.includes(parent)) {
    const minLength = Math.min(parent.length, child.length);
    const maxLength = Math.max(parent.length, child.length);
    return maxLength > 0 && minLength / maxLength >= 0.6;
  }
  return false;
};

const isCompoundPrompt = (prompt) => {
  const normalized = normalizePlanComparison(prompt);
  if (!normalized) return false;
  return /(\band\b|\bwith\b|\bplus\b|\balso\b|\bincluding\b|\binclude\b|,|;)/i.test(normalized);
};

const isLowInformationPlan = (prompt, plans = []) => {
  if (!Array.isArray(plans) || plans.length === 0) return true;
  if (plans.length > 1) return false;

  const plan = plans[0] || {};
  const childPrompt = plan.prompt || plan.title || '';
  const hasChildren = Array.isArray(plan.children) && plan.children.length > 0;
  if (hasChildren) return false;

  return isNearDuplicatePlan(prompt, childPrompt) || isCompoundPrompt(prompt);
};

const buildHeuristicChildPlans = (prompt) => {
  const subject = typeof prompt === 'string' && prompt.trim()
    ? prompt.trim()
    : 'the requested feature';
  const prompts = [
    `Identify the components, routes, and behaviors needed for ${subject}.`,
    `Build the UI components required for ${subject}, including any reusable pieces.`,
    `Wire the new components into the app and ensure the behavior matches the request for ${subject}.`
  ];

  return prompts.map((planPrompt, index) => ({
    prompt: planPrompt,
    title: deriveGoalTitle(planPrompt, { fallback: `Child Goal ${index + 1}` })
  }));
};


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

const createGoalTreeWithChildren = async ({
  projectId,
  prompt,
  childPrompts = [],
  parentGoalId = null,
  parentTitle = null,
  parentExtraClarifyingQuestions = []
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

  const createNode = async (plan, parentId) => {
    const childGoal = await createChildGoal({
      projectId,
      parentGoalId: parentId,
      prompt: plan.prompt,
      title: plan.title
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
  parentTitle = null
}) => {
  return createGoalTreeWithChildren({
    projectId,
    prompt,
    childPrompts,
    parentGoalId,
    parentTitle
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
