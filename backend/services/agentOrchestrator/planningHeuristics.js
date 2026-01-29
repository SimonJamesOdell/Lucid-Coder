import { deriveGoalTitle } from './goalTitle.js';

const MAX_PLAN_DEPTH = 4;
const MAX_PLAN_NODES = 40;

const normalizePlannerPrompt = (value) => (typeof value === 'string' ? value.trim() : '');

const isProgrammaticVerificationStep = (value) => {
  const text = normalizePlannerPrompt(value);
  if (!text) return false;

  const looksLikeCommand = /(\bnpm\b|\byarn\b|\bpnpm\b)\s+run\s+\btest\b/i.test(text);
  if (looksLikeCommand) return true;

  const verb = /^(run|re-?run|execute|verify|check)\b/i;
  if (!verb.test(text)) return false;

  return /(\bunit\s+tests\b|\bintegration\s+tests\b|\btests\b|\bvitest\b|\bcoverage\b)/i.test(
    text
  );
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

const normalizePlanComparison = (value) =>
  typeof value === 'string'
    ? value.toLowerCase().replace(/[^a-z0-9\s]/gi, ' ').replace(/\s+/g, ' ').trim()
    : '';

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
  const subject = typeof prompt === 'string' && prompt.trim() ? prompt.trim() : 'the requested feature';
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

export {
  buildHeuristicChildPlans,
  isCompoundPrompt,
  isLowInformationPlan,
  isProgrammaticVerificationStep,
  normalizeChildPlans,
  normalizeGoalPlanTree,
  normalizePlannerPrompt
};
