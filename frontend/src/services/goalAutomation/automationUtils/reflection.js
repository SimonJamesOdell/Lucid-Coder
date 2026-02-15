const SCOPE_REFLECTION_DEFAULT = Object.freeze({
  reasoning: '',
  mustChange: [],
  mustAvoid: [],
  mustHave: [],
  testsNeeded: true
});

const STYLE_REQUEST_REGEX = /\b(css|style|styling|theme|color|background|foreground|text color|font|typography|palette|button color|navbar|navigation bar|header|footer|sidebar|card|modal|form|input)\b/i;
const GLOBAL_STYLE_REGEX = /\b(global|app-wide|site-wide|entire app|whole app|across the app|entire page|whole page|page-wide|every page|all pages|entire site|whole site|all screens|body|html|:root)\b/i;
const GLOBAL_SELECTOR_REGEX = /\b(body|html)\s*[{,]|:root\s*[{,]|(^|\n)\s*\*\s*[{,]|#root\s*[{,]|:global\(\s*(body|html|:root|\*)\s*\)/i;

export const deriveStyleScopeContract = (goalPrompt) => {
  const prompt = typeof goalPrompt === 'string' ? goalPrompt.trim() : '';
  if (!prompt) {
    return null;
  }

  if (!STYLE_REQUEST_REGEX.test(prompt)) {
    return null;
  }

  const globalRequested = GLOBAL_STYLE_REGEX.test(prompt);
  if (globalRequested) {
    return {
      mode: 'global',
      enforceTargetScoping: false,
      forbidGlobalSelectors: false
    };
  }

  return {
    mode: 'targeted',
    enforceTargetScoping: true,
    forbidGlobalSelectors: true
  };
};

const editTouchesGlobalSelectors = (edit = {}) => {
  if (edit?.type === 'upsert') {
    return typeof edit?.content === 'string' && GLOBAL_SELECTOR_REGEX.test(edit.content);
  }

  if (edit?.type === 'modify' && Array.isArray(edit?.replacements)) {
    return edit.replacements.some((replacement) => {
      const search = typeof replacement?.search === 'string' ? replacement.search : '';
      const replace = typeof replacement?.replace === 'string' ? replacement.replace : '';
      return GLOBAL_SELECTOR_REGEX.test(`${search}\n${replace}`);
    });
  }

  return false;
};

export const normalizeReflectionList = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean)
    .slice(0, 12);
};

export const deriveReflectionPathPrefixes = (entries, normalizeRepoPath) => {
  const prefixes = new Set();
  for (const entry of entries) {
    const normalized = normalizeRepoPath(entry);
    if (normalized) {
      prefixes.add(normalized.endsWith('/') ? normalized : `${normalized}/`);
      continue;
    }

    const lowered = entry.toLowerCase();
    if (lowered.includes('backend')) {
      prefixes.add('backend/');
    }
    if (lowered.includes('frontend')) {
      prefixes.add('frontend/');
    }
    if (lowered.includes('test')) {
      prefixes.add('frontend/src/__tests__/');
      prefixes.add('backend/tests/');
      prefixes.add('tests/');
    }
  }
  return Array.from(prefixes);
};

export const buildScopeReflectionPrompt = ({ projectInfo, goalPrompt }) => {
  const trimmedProjectInfo = typeof projectInfo === 'string' ? projectInfo.trim() : '';
  const trimmedGoal = typeof goalPrompt === 'string' ? goalPrompt.trim() : '';

  const contextParts = [];
  if (trimmedProjectInfo) {
    contextParts.push(`Project context:\n${trimmedProjectInfo}`);
  }
  if (trimmedGoal) {
    contextParts.push(`User goal:\n${trimmedGoal}`);
  }

  const context = contextParts.join('\n\n');

  return {
    messages: [
      {
        role: 'system',
        content:
          'You are a careful planning assistant. Think step-by-step about what the user actually requested. ' +
          'Return ONLY valid JSON with keys: reasoning (string), mustChange (array of repo paths or areas that must change), ' +
          'mustAvoid (array of paths/areas that should remain untouched), mustHave (array of required behaviors or UI outcomes), ' +
          'and testsNeeded (boolean). ' +
          'For style requests targeting specific elements/components, include global selectors (body/html/:root/*/app-wide wrappers) in mustAvoid unless the user explicitly asks for global/page-wide theming. ' +
          'Mention only work that is strictly required to satisfy the request. Leave arrays empty when uncertain.'
      },
      {
        role: 'user',
        content: `${context || 'User goal provided above.'}\n\nDescribe the smallest set of changes that satisfy the goal and list areas that should remain untouched.`
      }
    ],
    max_tokens: 600,
    temperature: 0,
    __lucidcoderDisableToolBridge: true,
    __lucidcoderPurpose: 'goal-scope-reflection'
  };
};

export const parseScopeReflectionResponse = ({
  llmResponse,
  parseTextFromLLMResponse,
  extractJsonObject,
  tryParseLooseJson,
  automationLog
}) => {
  try {
    const rawText = parseTextFromLLMResponse(llmResponse);
    const text = typeof rawText === 'string' ? rawText : '';
    const jsonText = extractJsonObject(text) || text;
    if (!jsonText) {
      return SCOPE_REFLECTION_DEFAULT;
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      parsed = tryParseLooseJson(jsonText);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return SCOPE_REFLECTION_DEFAULT;
    }

    return {
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.trim() : '',
      mustChange: normalizeReflectionList(parsed.mustChange),
      mustAvoid: normalizeReflectionList(parsed.mustAvoid),
      mustHave: normalizeReflectionList(parsed.mustHave),
      testsNeeded: typeof parsed.testsNeeded === 'boolean' ? parsed.testsNeeded : true
    };
  } catch (error) {
    automationLog('scopeReflection:parse:error', { message: error?.message });
    return SCOPE_REFLECTION_DEFAULT;
  }
};

export const formatScopeReflectionContext = (reflection) => {
  if (!reflection) {
    return '';
  }

  const reasoning = typeof reflection.reasoning === 'string' ? reflection.reasoning.trim() : '';
  const mustChange = Array.isArray(reflection.mustChange) && reflection.mustChange.length
    ? reflection.mustChange.join(', ')
    : 'None noted';
  const mustAvoid = Array.isArray(reflection.mustAvoid) && reflection.mustAvoid.length
    ? reflection.mustAvoid.join(', ')
    : 'None noted';
  const mustHave = Array.isArray(reflection.mustHave) && reflection.mustHave.length
    ? reflection.mustHave.join(', ')
    : 'None noted';
  const testsNote = reflection.testsNeeded === false ? 'No' : 'Yes';

  const summaryLine = reasoning ? `Summary: ${reasoning}` : null;
  const parts = [
    summaryLine,
    `Must change: ${mustChange}`,
    `Avoid changing: ${mustAvoid}`,
    `Must have: ${mustHave}`,
    `Tests required: ${testsNote}`
  ]
    .filter(Boolean)
    .join('\n');

  return `\n\nScope reflection:\n${parts}`;
};

export const isTestFilePath = (path) => {
  if (!path) {
    return false;
  }
  return /__tests__\//.test(path) || /\.(test|spec)\.[jt]sx?$/.test(path);
};

export const validateEditsAgainstReflection = ({ edits, reflection, normalizeRepoPath }) => {
  if (!reflection || !Array.isArray(edits) || edits.length === 0) {
    return null;
  }

  const avoidPrefixes = deriveReflectionPathPrefixes(reflection.mustAvoid || [], normalizeRepoPath);
  const styleScope = reflection?.styleScope && typeof reflection.styleScope === 'object'
    ? reflection.styleScope
    : null;

  for (const edit of edits) {
    const normalizedPath = normalizeRepoPath(edit?.path);
    if (!normalizedPath) {
      continue;
    }

    if (reflection.testsNeeded === false && isTestFilePath(normalizedPath)) {
      return {
        type: 'tests-not-needed',
        path: normalizedPath,
        message: 'Scope reasoning determined new or updated tests are unnecessary for this goal.'
      };
    }

    if (styleScope?.forbidGlobalSelectors && editTouchesGlobalSelectors(edit)) {
      return {
        type: 'style-scope-global-selector',
        path: normalizedPath,
        rule: 'targeted-style-scope',
        message: 'Style request appears element-scoped; avoid changing global selectors (body/html/:root/*/#root). Apply styles only to the requested target.'
      };
    }

    const violatingPrefix = avoidPrefixes.find((prefix) => normalizedPath.startsWith(prefix));
    if (violatingPrefix) {
      return {
        type: 'forbidden-area',
        path: normalizedPath,
        rule: violatingPrefix,
        message: `Edit to ${normalizedPath} conflicts with scope guidance to avoid ${violatingPrefix}.`
      };
    }
  }

  return null;
};
