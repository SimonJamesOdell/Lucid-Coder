const SCOPE_REFLECTION_DEFAULT = Object.freeze({
  reasoning: '',
  mustChange: [],
  mustAvoid: [],
  mustHave: [],
  testsNeeded: true
});

const GLOBAL_SELECTOR_REGEX = /\b(body|html)\s*[{,]|:root\s*[{,]|(^|\n)\s*\*\s*[{,]|#root\s*[{,]|:global\(\s*(body|html|:root|\*)\s*\)/i;
const GLOBAL_STYLE_FILE_REGEX = /(^|\/)(index|app|styles|theme|globals?)\.(css|scss|sass|less)$/i;
const PAGE_SCOPE_SELECTOR_REGEX = /\b(body|html)\b|:root|#root|\.app\b|\.app-container\b|\.app-shell\b|:global\(\s*(body|html|:root|#root|\.app)\s*\)/i;

const readEditText = (edit = {}) => {
  if (edit?.type === 'upsert') {
    return typeof edit?.content === 'string' ? edit.content.toLowerCase() : '';
  }
  if (edit?.type === 'modify' && Array.isArray(edit?.replacements)) {
    return edit.replacements
      .map((replacement) => `${replacement?.search || ''}\n${replacement?.replace || ''}`)
      .join('\n')
      .toLowerCase();
  }
  return '';
};

const editMentionsTargetHints = (edit = {}, targetHints = []) => {
  if (!Array.isArray(targetHints) || targetHints.length === 0) {
    return false;
  }

  const path = String(edit?.path).toLowerCase();
  const text = readEditText(edit);
  return targetHints.some((hint) => path.includes(hint) || text.includes(hint));
};

const normalizeAssetPathForMatch = (value) => {
  return String(value || '').trim().replace(/^\/+/, '').toLowerCase();
};

const editMentionsRequiredAssetPaths = (edit = {}, requiredAssetPaths = []) => {
  if (!Array.isArray(requiredAssetPaths) || requiredAssetPaths.length === 0) {
    return false;
  }

  const text = readEditText(edit);
  const path = String(edit?.path || '').toLowerCase();
  return requiredAssetPaths.some((assetPath) => {
    const normalizedAssetPath = normalizeAssetPathForMatch(assetPath);
    if (!normalizedAssetPath) {
      return false;
    }
    return (
      text.includes(normalizedAssetPath)
      || text.includes(`/${normalizedAssetPath}`)
      || path.includes(normalizedAssetPath)
    );
  });
};

export const deriveStyleScopeContract = (_goalPrompt) => {
  return null;
};

const hasRequiredExecutionContractShape = (reflection) => (
  reflection
  && typeof reflection === 'object'
  && !Array.isArray(reflection)
  && Array.isArray(reflection.mustChange)
  && Array.isArray(reflection.mustAvoid)
  && Array.isArray(reflection.mustHave)
  && typeof reflection.testsNeeded === 'boolean'
);

export const validateExecutionContractGate = ({
  reflection,
  stage = 'implementation'
}) => {
  if (stage !== 'implementation') {
    return null;
  }

  if (!hasRequiredExecutionContractShape(reflection)) {
    return {
      type: 'execution-contract-invalid',
      path: null,
      rule: 'execution-contract-required-fields',
      message:
        'Execution contract is missing required structured fields (mustChange, mustAvoid, mustHave, testsNeeded). Regenerate scope reflection before implementation edits.'
    };
  }

  return null;
};

const classifyWorkspaceFromPath = (normalizedPath) => {
  if (typeof normalizedPath !== 'string' || !normalizedPath) {
    return null;
  }
  if (normalizedPath.startsWith('frontend/')) {
    return 'frontend';
  }
  if (normalizedPath.startsWith('backend/')) {
    return 'backend';
  }
  if (normalizedPath.startsWith('shared/')) {
    return 'shared';
  }
  return null;
};

const deriveSingleRequiredWorkspace = (mustChangePrefixes = []) => {
  const workspaces = new Set(
    mustChangePrefixes
      .map((prefix) => classifyWorkspaceFromPath(prefix))
      .filter(Boolean)
      .filter((workspace) => workspace !== 'shared')
  );
  return workspaces.size === 1 ? Array.from(workspaces)[0] : null;
};

export const scoreEditPlanConfidence = ({ edits, reflection, normalizeRepoPath, stage = 'implementation' }) => {
  if (!Array.isArray(edits) || edits.length === 0) {
    return {
      score: 0,
      label: 'low',
      metrics: {
        touchedFiles: 0,
        mustChangeSatisfied: false,
        forbiddenTouches: 0,
        mixedWorkspaceTouches: 0,
        stage
      }
    };
  }

  const normalizedPaths = edits
    .map((edit) => normalizeRepoPath(edit?.path))
    .filter(Boolean);

  const touchedFiles = new Set(normalizedPaths).size;
  const mustChangePrefixes = stage === 'implementation'
    ? deriveReflectionPathPrefixes(reflection?.mustChange || [], normalizeRepoPath)
    : [];
  const avoidPrefixes = deriveReflectionPathPrefixes(reflection?.mustAvoid || [], normalizeRepoPath);

  const mustChangeSatisfied = mustChangePrefixes.length === 0 || normalizedPaths.some((path) => (
    mustChangePrefixes.some((prefix) => path.startsWith(prefix))
  ));

  const forbiddenTouches = normalizedPaths.filter((path) => (
    avoidPrefixes.some((prefix) => path.startsWith(prefix))
  )).length;

  const requiredWorkspace = deriveSingleRequiredWorkspace(mustChangePrefixes);
  const mixedWorkspaceTouches = requiredWorkspace
    ? normalizedPaths.filter((path) => {
      const workspace = classifyWorkspaceFromPath(path);
      return workspace && workspace !== 'shared' && workspace !== requiredWorkspace;
    }).length
    : 0;

  let score = 1;
  if (touchedFiles > 6) {
    score -= 0.45;
  } else if (touchedFiles > 3) {
    score -= 0.2;
  }
  if (!mustChangeSatisfied) {
    score -= 0.35;
  }
  if (forbiddenTouches > 0) {
    score -= 0.35;
  }
  if (mixedWorkspaceTouches > 0) {
    score -= 0.25;
  }

  const normalizedScore = Math.max(0, Math.min(1, Number(score.toFixed(2))));
  const label = normalizedScore >= 0.75 ? 'high' : normalizedScore >= 0.5 ? 'medium' : 'low';

  return {
    score: normalizedScore,
    label,
    metrics: {
      touchedFiles,
      mustChangeSatisfied,
      forbiddenTouches,
      mixedWorkspaceTouches,
      stage
    }
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

const editTouchesPageScopeSelectors = (edit = {}) => {
  if (edit?.type === 'upsert') {
    return typeof edit?.content === 'string' && PAGE_SCOPE_SELECTOR_REGEX.test(edit.content);
  }

  if (edit?.type === 'modify' && Array.isArray(edit?.replacements)) {
    return edit.replacements.some((replacement) => {
      const search = typeof replacement?.search === 'string' ? replacement.search : '';
      const replace = typeof replacement?.replace === 'string' ? replacement.replace : '';
      return PAGE_SCOPE_SELECTOR_REGEX.test(`${search}\n${replace}`);
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

  const sanitizePathEntry = (value) => {
    if (typeof value !== 'string') {
      return value;
    }

    return value
      .trim()
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/\s*\((?:[^)]*?(?:if\s+missing|or\s+create)[^)]*)\)\s*/gi, ' ')
      .replace(/[.;:,]+$/g, '')
      .replace(/\/+\.$/, '')
      .trim();
  };

  for (const entry of entries) {
    const normalized = normalizeRepoPath(sanitizePathEntry(entry));
    if (normalized) {
      const trimmedPath = normalized.replace(/\/+$/g, '');
      if (trimmedPath) {
        prefixes.add(trimmedPath);
        if (!/\.[a-z0-9]+$/i.test(trimmedPath)) {
          prefixes.add(`${trimmedPath}/`);
        }
      }
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
          'testsNeeded (boolean), and optional styleScope (object or null). ' +
          'If styleScope is provided, use shape: { "mode": "targeted"|"global", "targetLevel": "global"|"page"|"component"|"element", "enforceTargetScoping": boolean, "forbidGlobalSelectors": boolean, "targetHints": string[] }. ' +
          'Only set styleScope when you are confident the goal is primarily style-related; otherwise set styleScope to null. ' +
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
  const normalizeStyleScope = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const mode = value.mode === 'global' ? 'global' : value.mode === 'targeted' ? 'targeted' : null;
    if (!mode) {
      return null;
    }
    const targetLevel =
      value.targetLevel === 'global'
      || value.targetLevel === 'page'
      || value.targetLevel === 'component'
      || value.targetLevel === 'element'
        ? value.targetLevel
        : (mode === 'global' ? 'global' : 'component');

    const isGlobalLevel = targetLevel === 'global';
    const isPageLevel = targetLevel === 'page';
    const targetHints = normalizeReflectionList(value.targetHints || []);
    const hasUsableTargetHints = targetHints.length > 0;
    return {
      mode: isGlobalLevel ? 'global' : mode,
      targetLevel,
      enforceTargetScoping: (isGlobalLevel || !hasUsableTargetHints)
        ? false
        : value.enforceTargetScoping === true,
      forbidGlobalSelectors: (isGlobalLevel || isPageLevel || !hasUsableTargetHints)
        ? false
        : value.forbidGlobalSelectors === true,
      targetHints
    };
  };

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

    const styleScope = normalizeStyleScope(parsed.styleScope);

    return {
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.trim() : '',
      mustChange: normalizeReflectionList(parsed.mustChange),
      mustAvoid: normalizeReflectionList(parsed.mustAvoid),
      mustHave: normalizeReflectionList(parsed.mustHave),
      testsNeeded: typeof parsed.testsNeeded === 'boolean' ? parsed.testsNeeded : true,
      ...(styleScope ? { styleScope } : {})
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

export const validateEditsAgainstReflection = ({ edits, reflection, normalizeRepoPath, stage = 'implementation' }) => {
  if (!reflection || !Array.isArray(edits) || edits.length === 0) {
    return null;
  }

  const avoidPrefixes = deriveReflectionPathPrefixes(reflection.mustAvoid || [], normalizeRepoPath);
  const mustChangePrefixes = stage === 'implementation'
    ? deriveReflectionPathPrefixes(reflection.mustChange || [], normalizeRepoPath)
    : [];
  let hasRequiredMustChangeEdit = mustChangePrefixes.length === 0;
  const styleScope = reflection?.styleScope && typeof reflection.styleScope === 'object'
    ? reflection.styleScope
    : null;
  const requiredAssetPaths = normalizeReflectionList(reflection?.requiredAssetPaths || []);
  let hasRequiredAssetReference = requiredAssetPaths.length === 0;
  const touchedPaths = edits
    .map((edit) => normalizeRepoPath(edit?.path))
    .filter(Boolean);
  const touchedFilesCount = new Set(touchedPaths).size;
  const MAX_TOUCHED_FILES_PER_STAGE = stage === 'tests' ? 10 : 6;
  if (stage === 'implementation' && touchedFilesCount > MAX_TOUCHED_FILES_PER_STAGE) {
    return {
      type: 'overscoped-edit-plan',
      path: touchedPaths[0],
      rule: 'execution-contract-max-touched-files',
      message: `Implementation edit plan touches ${touchedFilesCount} files. Keep implementation edits focused to ${MAX_TOUCHED_FILES_PER_STAGE} or fewer files per attempt.`
    };
  }

  const requiredWorkspace = deriveSingleRequiredWorkspace(mustChangePrefixes);
  if (stage === 'implementation' && requiredWorkspace) {
    const crossWorkspacePath = touchedPaths.find((path) => {
      const workspace = classifyWorkspaceFromPath(path);
      return workspace && workspace !== 'shared' && workspace !== requiredWorkspace;
    });
    if (crossWorkspacePath) {
      return {
        type: 'mixed-workspace-edit-plan',
        path: crossWorkspacePath,
        rule: 'execution-contract-single-workspace',
        message: `Execution contract targets ${requiredWorkspace} scope, but edits also touched ${crossWorkspacePath}. Keep this attempt within one workspace.`
      };
    }
  }

  for (const edit of edits) {
    const normalizedPath = normalizeRepoPath(edit?.path);
    if (!normalizedPath) {
      continue;
    }

    if (!hasRequiredAssetReference && editMentionsRequiredAssetPaths(edit, requiredAssetPaths)) {
      hasRequiredAssetReference = true;
    }

    if (!hasRequiredMustChangeEdit) {
      hasRequiredMustChangeEdit = mustChangePrefixes.some((prefix) => normalizedPath.startsWith(prefix));
    }

    if (reflection.testsNeeded === false && isTestFilePath(normalizedPath)) {
      return {
        type: 'tests-not-needed',
        path: normalizedPath,
        message: 'Scope reasoning determined new or updated tests are unnecessary for this goal.'
      };
    }

    const pageLevelScope = styleScope?.targetLevel === 'page';

    if (styleScope?.forbidGlobalSelectors && !pageLevelScope && editTouchesGlobalSelectors(edit)) {
      return {
        type: 'style-scope-global-selector',
        path: normalizedPath,
        rule: 'targeted-style-scope',
        message: 'Style request appears element-scoped; avoid changing global selectors (body/html/:root/*/#root). Apply styles only to the requested target.'
      };
    }

    if (styleScope?.enforceTargetScoping && GLOBAL_STYLE_FILE_REGEX.test(normalizedPath)) {
      const targetHints = normalizeReflectionList(styleScope?.targetHints || []);
      const mentionsTarget = editMentionsTargetHints(edit, targetHints);
      const pageScopeMatch = styleScope?.targetLevel === 'page' && editTouchesPageScopeSelectors(edit);
      if (!mentionsTarget) {
        if (pageScopeMatch) {
          continue;
        }
        return {
          type: 'style-scope-target-missing',
          path: normalizedPath,
          rule: 'targeted-style-scope',
          message: 'Targeted style request must include target-specific selectors/components. Avoid broad edits in global stylesheet files unless the request is explicitly global.'
        };
      }
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

  if (!hasRequiredMustChangeEdit) {
    const requiredLabel = mustChangePrefixes.slice(0, 3).join(', ');
    return {
      type: 'execution-contract-must-change-missing',
      path: mustChangePrefixes[0],
      rule: 'execution-contract-must-change',
      message: `Execution contract requires implementation edits in: ${requiredLabel}.`
    };
  }

  if (styleScope && requiredAssetPaths.length > 0 && !hasRequiredAssetReference) {
    return {
      type: 'required-asset-reference-missing',
      path: requiredAssetPaths[0],
      rule: 'selected-asset-required',
      message: 'Selected project asset was not referenced in proposed edits. Ensure the requested selected image path is applied in code/CSS (for example /uploads/<file>).'
    };
  }

  return null;
};

export const __reflectionTestHooks = {
  normalizeAssetPathForMatch,
  editMentionsRequiredAssetPaths,
  scoreEditPlanConfidence,
  hasRequiredExecutionContractShape
};
