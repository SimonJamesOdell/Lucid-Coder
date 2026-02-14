const SCOPE_REFLECTION_DEFAULT = Object.freeze({
  reasoning: '',
  mustChange: [],
  mustAvoid: [],
  mustHave: [],
  testsNeeded: true
});

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
