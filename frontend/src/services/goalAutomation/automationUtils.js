import axios from 'axios';

import { createApplyEditsModule } from './automationUtils/applyEdits.js';
import {
  extractJsonArray,
  extractJsonArrayFromIndex,
  extractJsonObject,
  extractJsonObjectFromIndex,
  extractJsonObjectWithKey,
  normalizeJsonLikeText,
  tryParseLooseJson
} from './automationUtils/jsonParsing.js';
import {
  buildScopeReflectionPrompt,
  deriveStyleScopeContract,
  deriveReflectionPathPrefixes as deriveReflectionPathPrefixesFromModule,
  formatScopeReflectionContext,
  isTestFilePath,
  normalizeReflectionList,
  parseScopeReflectionResponse as parseScopeReflectionResponseFromModule,
  validateEditsAgainstReflection as validateEditsAgainstReflectionFromModule
} from './automationUtils/reflection.js';
import {
  buildFallbackBranchNameFromPrompt,
  extractBranchPromptContext,
  extractBranchName,
  isBranchNameRelevantToPrompt,
  isValidBranchName,
  parseBranchNameFromLLMText
} from './automationUtils/branchNames.js';

export {
  buildFallbackBranchNameFromPrompt,
  buildScopeReflectionPrompt,
  deriveStyleScopeContract,
  extractBranchPromptContext,
  extractBranchName,
  extractJsonObject,
  isBranchNameRelevantToPrompt,
  isValidBranchName,
  parseBranchNameFromLLMText,
  tryParseLooseJson
};

export const AUTOMATION_LOG_EVENT = 'lucidcoder:automation-log';

const buildAutomationBannerText = (label) => {
  const normalizedLabel = typeof label === 'string' ? label.trim() : '';
  if (!normalizedLabel) {
    return '';
  }
  return normalizedLabel;
};

export const automationLog = (label, details) => {
  const bannerText = buildAutomationBannerText(label);

  try {
    console.log(`[automation] ${label}`, details);
  } catch {
    // Ignore environments where console is restricted.
  }

  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent(AUTOMATION_LOG_EVENT, {
        detail: {
          label,
          details,
          bannerText
        }
      }));
    }
  } catch {
    // Ignore environments where window/custom events are unavailable.
  }
};

export const DEFAULT_ATTEMPT_SEQUENCE = Object.freeze([1, 2]);

export const resolveAttemptSequence = (input) => {
  if (Array.isArray(input)) {
    const sequence = input
      .map((value) => (Number.isInteger(value) ? value : parseInt(value, 10)))
      .filter((value) => Number.isInteger(value) && value > 0);
    return sequence.length > 0 ? Array.from(new Set(sequence)) : [];
  }

  const numeric = Number.isInteger(input) ? input : parseInt(input, 10);
  if (Number.isInteger(numeric) && numeric > 0) {
    return [numeric];
  }

  return DEFAULT_ATTEMPT_SEQUENCE;
};

export const flattenFileTree = (nodes, acc = []) => {
  if (!Array.isArray(nodes)) {
    return acc;
  }

  for (const node of nodes) {
    if (!node) {
      continue;
    }

    const nodePath = normalizeRepoPath(node?.path || node?.filePath || node?.name || '');
    if (nodePath) {
      acc.push(nodePath);
    }

    if (Array.isArray(node?.children) && node.children.length > 0) {
      flattenFileTree(node.children, acc);
    }
  }

  return acc;
};

export const normalizeRepoPath = (value) => {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/\\/g, '/').replace(/^\/+/g, '');
};

export const parseTextFromLLMResponse = (response) => {
  if (response?.data && response.data.response !== undefined) {
    return response.data.response;
  }
  if (response?.data && response.data.content !== undefined) {
    return response.data.content;
  }
  return '';
};

export const requestBranchNameFromLLM = async ({ prompt, fallbackName }) => {
  const buildMessages = (attempt) => {
    if (attempt === 2) {
      return [
        {
          role: 'system',
          content:
            'You generate a git branch name for the user request. ' +
            'Return ONLY a single JSON object with one key: {"branch":"..."}. No extra keys, no prose, no code fences. ' +
            'The branch value must be a short, human-meaningful change description (not meta text), written in lowercase kebab-case. ' +
            'It MUST start with one verb: added, changed, fixed, updated, refactored, removed. ' +
            'It MUST contain at least two words and at most five words total. ' +
            'Each word MUST contain at least one letter a-z (no numeric-only words; no ranges; no constraint text). ' +
            'Prefer using words/nouns that appear in the user request (plus minimal glue words like "modal"/"color" if needed). ' +
            'Do NOT use meta/instructional words like: rules, json, schema, key, chars, words, tokens, prompt, requirement, branch.'
        },
        { role: 'user', content: `User request: "${prompt}"` }
      ];
    }

    return [
      {
        role: 'system',
        content:
          'You generate a git branch name for the user request. ' +
          'Return ONLY a single JSON object with one key: {"branch":"..."}. No extra keys, no prose, no code fences. ' +
          'The branch value must be a short, human-meaningful change description, written in lowercase kebab-case. ' +
          'Start with one verb: added, changed, fixed, updated, refactored, removed. ' +
          'Use at least two words and at most five words total. Each word must contain at least one letter a-z.' +
          ' Prefer using words/nouns from the user request; avoid meta words like rules/json/schema/prompt/requirement/branch.' +
          '\n\nExamples (format only):' +
          '\nUser request: "Turn the background blue" -> {"branch":"changed-background-blue"}' +
          '\nUser request: "Fix the settings modal width" -> {"branch":"fixed-settings-modal-width"}' +
          '\nUser request: "Remove dedup panels" -> {"branch":"removed-dedup-panels"}'
      },
      { role: 'user', content: `User request: "${prompt}"` }
    ];
  };

  for (const attempt of DEFAULT_ATTEMPT_SEQUENCE) {
    try {
      const response = await axios.post('/api/llm/generate', {
        messages: buildMessages(attempt),
        max_tokens: 80,
        temperature: 0,
        __lucidcoderDisableToolBridge: true,
        __lucidcoderPurpose: 'goal-branch-name'
      });

      const rawText = parseTextFromLLMResponse(response);
      const normalizedRawText = typeof rawText === 'string' ? rawText : '';
      automationLog('ensureBranch:llm:raw', {
        attempt,
        responseType: typeof rawText,
        preview: normalizedRawText.slice(0, 200)
      });

      const parsed = parseBranchNameFromLLMText(normalizedRawText);
      const extracted = extractBranchName(parsed, fallbackName);
      automationLog('ensureBranch:llm:parsed', { attempt, parsed, extracted });

      if (isValidBranchName(extracted)) {
        return extracted;
      }
    } catch (error) {
      automationLog('ensureBranch:llm:error', { attempt, message: error?.message });
    }
  }

  return fallbackName;
};

export const readProjectFile = async ({ projectId, filePath }) => {
  try {
    const response = await axios.get(`/api/projects/${projectId}/files/${filePath}`);
    return typeof response.data?.content === 'string' ? response.data.content : '';
  } catch (error) {
    if (error?.response?.status === 404) {
      return null;
    }
    throw error;
  }
};

export const applyReplacements = (original, replacements) => {
  if (!Array.isArray(replacements) || replacements.length === 0) {
    return original;
  }

  const stripWhitespaceWithMap = (text) => {
    const map = [];
    let stripped = '';
    for (let index = 0; index < text.length; index += 1) {
      const ch = text[index];
      if (!/\s/.test(ch)) {
        stripped += ch;
        map.push(index);
      }
    }
    return { stripped, map };
  };

  const findUniqueIndex = (haystack, needle) => {
    const firstIndex = haystack.indexOf(needle);
    if (firstIndex < 0) {
      return { index: -1, ambiguous: false };
    }
    const secondIndex = haystack.indexOf(needle, firstIndex + 1);
    return { index: firstIndex, ambiguous: secondIndex >= 0 };
  };

  let updated = original;
  for (const replacement of replacements) {
    const search = replacement?.search;
    const replace = replacement?.replace;
    if (typeof search !== 'string' || typeof replace !== 'string') {
      throw new Error('Invalid replacement entry');
    }

    const exact = findUniqueIndex(updated, search);
    if (exact.index >= 0) {
      if (exact.ambiguous) {
        throw new Error('Replacement search text is ambiguous');
      }
      updated = updated.slice(0, exact.index) + replace + updated.slice(exact.index + search.length);
      continue;
    }

    const haystack = stripWhitespaceWithMap(updated);
    const needle = stripWhitespaceWithMap(search);
    if (!needle.stripped) {
      throw new Error('Replacement search text not found');
    }

    const loose = findUniqueIndex(haystack.stripped, needle.stripped);
    if (loose.index < 0) {
      throw new Error('Replacement search text not found');
    }
    if (loose.ambiguous) {
      throw new Error('Replacement search text is ambiguous');
    }

    const startOriginalIndex = haystack.map[loose.index];
    const endOriginalIndex = haystack.map[loose.index + needle.stripped.length - 1] + 1;
    updated = updated.slice(0, startOriginalIndex) + replace + updated.slice(endOriginalIndex);
  }

  return updated;
};

export const isReplacementResolutionError = (error) => {
  const message = error?.message;
  return message === 'Replacement search text not found' || message === 'Replacement search text is ambiguous';
};

export const buildReplacementRetryContext = (error) => (
  error?.__lucidcoderReplacementFailure || {
    path: null,
    message: error?.message || 'Replacement search text not found'
  }
);

export const buildModifyRepairPrompt = ({ goalPrompt, stage, filePath, fileContent, failedEdit, errorMessage, attempt = 1 }) => {
  const stageLabel = stage === 'tests' ? 'tests' : 'implementation';
  const replacementsPreview = []
    .concat(failedEdit?.replacements)
    .filter(Boolean)
    .slice(0, 3)
    .map((r) => ({ search: r?.search, replace: r?.replace }));

  const limitedContent =
    fileContent.length > 8000 ? `${fileContent.slice(0, 8000)}\n\n/* ...truncated... */` : fileContent;

  return {
    messages: [
      {
        role: 'system',
        content:
          attempt === 2
            ? 'Return ONLY valid JSON. Do not use code fences. Do not include explanations. Output must start with { and end with }. ' +
              'Schema: {"edits":[{"type":"modify","path":"<exact filePath>","replacements":[{"search":"<matches exactly once>","replace":"..."}]}]}. ' +
              'The search MUST match exactly once in the provided file content.'
            : 'You are an automated code editor. Return ONLY valid JSON. Output format: {"edits":[...]} using only type="modify". ' +
              'Each replacement.search MUST match exactly once in the provided file content (no 0 matches, no multiple matches). ' +
              'Use a longer, more specific snippet with surrounding lines if needed.'
      },
      {
        role: 'user',
        content:
          `Goal (stage: ${stageLabel}): ${String(goalPrompt).slice(0, 400)}\n\n` +
          (stageLabel === 'tests'
            ? 'Use Vitest (vi) APIs and @testing-library for React tests. Do not use Jest globals or jest.*.\n\n'
            : '') +
          `File path: ${filePath}\n` +
          `Previous modify edit failed with: ${errorMessage}\n\n` +
          `Failed replacements (for reference):\n${JSON.stringify(replacementsPreview, null, 2)}\n\n` +
          `File content (read-only):\n\n${limitedContent}\n\n` +
          'Return JSON edits only.'
      }
    ],
    max_tokens: 1200,
    temperature: 0,
    __lucidcoderDisableToolBridge: true
  };
};

export const buildRewriteFilePrompt = ({ goalPrompt, stage, filePath, fileContent, errorMessage, attempt = 1 }) => {
  const stageLabel = stage === 'tests' ? 'tests' : 'implementation';
  const limitedContent =
    fileContent.length > 8000 ? `${fileContent.slice(0, 8000)}\n\n/* ...truncated... */` : fileContent;

  const systemInstruction =
    attempt === 2
      ? 'Return ONLY valid JSON. Schema: {"edits":[{"type":"upsert","path":"<exact filePath>","content":"..."}]}. ' +
        'The content MUST be the full file after applying the requested change. Do not omit context or use ellipses.'
      : 'You are an automated code editor. Return ONLY valid JSON describing the entire updated file as a single upsert edit. ' +
        'The edit path must exactly match the provided file path, and the content must include the full file after applying the goal.';

  return {
    messages: [
      {
        role: 'system',
        content: systemInstruction
      },
      {
        role: 'user',
        content:
          `Goal (stage: ${stageLabel}): ${String(goalPrompt).slice(0, 400)}\n\n` +
          (stageLabel === 'tests'
            ? 'Use Vitest (vi) APIs and @testing-library for React tests. Do not use Jest globals or jest.*.\n\n'
            : '') +
          `File path: ${filePath}\n` +
          `Previous edit failed with: ${errorMessage}\n\n` +
          `File content (read-only):\n\n${limitedContent}\n\n` +
          'Return JSON edits only.'
      }
    ],
    max_tokens: 2000,
    temperature: 0,
    __lucidcoderDisableToolBridge: true
  };
};

export const pathsAreEquivalent = (a, b) => {
  const left = normalizeRepoPath(a);
  const right = normalizeRepoPath(b);
  if (left === right) return true;
  if (left.endsWith(`/${right}`) || right.endsWith(`/${left}`)) return true;
  return false;
};

export const pickRepairEditForPath = ({ edits, filePath }) => {
  if (edits.length === 0) return null;

  const normalizedTarget = normalizeRepoPath(filePath);

  const normalizeEditPath = (edit) => normalizeRepoPath(edit?.path);
  const normalizeEditType = (edit) => (typeof edit?.type === 'string' ? edit.type.toLowerCase() : '');

  const modifyEdits = edits.filter((e) => normalizeEditType(e) === 'modify' && Array.isArray(e?.replacements) && normalizeEditPath(e));
  const upsertEdits = edits.filter(
    (e) => normalizeEditType(e) === 'upsert' && typeof e?.content === 'string' && normalizeEditPath(e)
  );

  const equivalentModify = modifyEdits.filter((e) => pathsAreEquivalent(normalizeEditPath(e), normalizedTarget));
  const exactModify = equivalentModify.find((e) => normalizeEditPath(e) === normalizedTarget);
  if (exactModify) return exactModify;
  if (equivalentModify.length === 1) {
    return { ...equivalentModify[0], path: normalizedTarget };
  }

  const equivalentUpserts = upsertEdits.filter((e) => pathsAreEquivalent(normalizeEditPath(e), normalizedTarget));
  const exactUpsert = equivalentUpserts.find((e) => normalizeEditPath(e) === normalizedTarget);
  if (exactUpsert) return exactUpsert;
  if (equivalentUpserts.length === 1) {
    return { ...equivalentUpserts[0], path: normalizedTarget };
  }

  const validEdits = [...modifyEdits, ...upsertEdits];
  if (validEdits.length === 1) {
    return { ...validEdits[0], path: normalizedTarget };
  }

  return null;
};

export const tryRepairModifyEdit = async ({ projectId, goalPrompt, stage, filePath, originalContent, failedEdit, error }) => {
  automationLog('applyEdits:modify:repair:start', {
    path: filePath,
    stage,
    message: error?.message
  });

  for (const attempt of [1, 2]) {
    try {
      const response = await axios.post(
        '/api/llm/generate',
        buildModifyRepairPrompt({
          goalPrompt,
          stage,
          filePath,
          fileContent: originalContent,
          failedEdit,
          errorMessage: error?.message,
          attempt
        })
      );

      const edits = parseEditsFromLLM(response);
      const first = pickRepairEditForPath({ edits, filePath });

      automationLog('applyEdits:modify:repair:response', {
        path: filePath,
        attempt,
        editsCount: edits.length,
        hasCandidate: Boolean(first),
        candidateType: first?.type || null,
        sample: edits.slice(0, 2).map((e) => ({ type: e?.type, path: e?.path }))
      });

      if (first) {
        return first;
      }
    } catch (repairError) {
      const isSyntax = repairError instanceof SyntaxError;
      automationLog('applyEdits:modify:repair:error', {
        path: filePath,
        attempt,
        message: repairError?.message,
        status: repairError?.response?.status,
        kind: isSyntax ? 'parse' : 'other'
      });

      if (!isSyntax) {
        return null;
      }
    }
  }

  return null;
};

export const tryRewriteFileWithLLM = async ({ goalPrompt, stage, filePath, originalContent, errorMessage }) => {
  automationLog('applyEdits:modify:rewrite:start', {
    path: filePath,
    stage,
    message: errorMessage
  });

  const preferUpsert = stage === 'tests';

  for (const attempt of [1, 2]) {
    try {
      const response = await axios.post(
        '/api/llm/generate',
        buildRewriteFilePrompt({
          goalPrompt,
          stage,
          filePath,
          fileContent: originalContent,
          errorMessage,
          attempt
        })
      );

      const edits = parseEditsFromLLM(response);
      const candidate = pickRepairEditForPath({ edits, filePath });

      automationLog('applyEdits:modify:rewrite:response', {
        path: filePath,
        attempt,
        editsCount: edits.length,
        hasCandidate: Boolean(candidate),
        candidateType: candidate?.type || null
      });

      if (candidate?.type === 'upsert' && typeof candidate?.content === 'string') {
        return candidate;
      }

      if (candidate?.type === 'modify' && Array.isArray(candidate?.replacements)) {
        if (preferUpsert && attempt < 2) {
          continue;
        }
        return candidate;
      }
    } catch (rewriteError) {
      const isSyntax = rewriteError instanceof SyntaxError;
      automationLog('applyEdits:modify:rewrite:error', {
        path: filePath,
        attempt,
        message: rewriteError?.message,
        status: rewriteError?.response?.status,
        kind: isSyntax ? 'parse' : 'other'
      });

      if (!isSyntax) {
        return null;
      }
    }
  }

  return null;
};

export const upsertProjectFile = async ({ projectId, filePath, content, knownPathsSet }) => {
  const useKnownPaths = knownPathsSet instanceof Set && knownPathsSet.size > 0;

  if (useKnownPaths && !knownPathsSet.has(filePath)) {
    try {
      const createResponse = await axios.post(`/api/projects/${projectId}/files-ops/create-file`, {
        filePath,
        content
      });
      knownPathsSet.add(filePath);
      return createResponse.data;
    } catch (error) {
      if (error?.response?.status !== 409) {
        throw error;
      }
    }
  }

  try {
    const response = await axios.put(`/api/projects/${projectId}/files/${filePath}`, { content });
    if (useKnownPaths) {
      knownPathsSet.add(filePath);
    }
    return response.data;
  } catch (error) {
    if (error?.response?.status !== 404) {
      throw error;
    }
  }

  try {
    const createResponse = await axios.post(`/api/projects/${projectId}/files-ops/create-file`, {
      filePath,
      content
    });
    if (useKnownPaths) {
      knownPathsSet.add(filePath);
    }
    return createResponse.data;
  } catch (error) {
    if (!error?.__lucidcoderFileOpFailure) {
      const status = error?.response?.status;
      if (status === 404 || status === 400) {
        const wrapped = new Error(`Failed to create file: ${filePath}`);
        wrapped.__lucidcoderFileOpFailure = {
          path: filePath,
          status,
          message: wrapped.message,
          operation: 'create'
        };
        throw wrapped;
      }
    }
    throw error;
  }
};

export const deleteProjectPath = async ({ projectId, targetPath, recursive = false }) => {
  const response = await axios.post(`/api/projects/${projectId}/files-ops/delete`, {
    targetPath,
    recursive: Boolean(recursive),
    confirm: true
  });
  return response.data;
};

export const stageProjectFile = async ({ projectId, filePath, source = 'ai' }) => {
  const response = await axios.post(`/api/projects/${projectId}/branches/stage`, {
    filePath,
    source
  });
  return response.data;
};

export const notifyGoalsUpdated = (projectId) => {
  if (!projectId) return;
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') {
    return;
  }

  try {
    window.dispatchEvent(
      new CustomEvent('lucidcoder:goals-updated', {
        detail: { projectId }
      })
    );
  } catch {
    // Ignore environments that disallow CustomEvent (older browsers / test runtimes).
  }
};

export const parseScopeReflectionResponse = (llmResponse) => parseScopeReflectionResponseFromModule({
  llmResponse,
  parseTextFromLLMResponse,
  extractJsonObject,
  tryParseLooseJson,
  automationLog
});

const deriveReflectionPathPrefixes = (entries) => deriveReflectionPathPrefixesFromModule(entries, normalizeRepoPath);

export const validateEditsAgainstReflection = (edits, reflection) => validateEditsAgainstReflectionFromModule({
  edits,
  reflection,
  normalizeRepoPath
});


export const parseEditsFromLLM = (llmResponse) => {
  const responseContent = llmResponse?.data?.response || llmResponse?.data?.content || '';
  const jsonText =
    extractJsonObjectWithKey(responseContent, 'edits') ||
    extractJsonArray(responseContent) ||
    extractJsonObject(responseContent);
  if (!jsonText) {
    const fallback = tryParseLooseJson(responseContent);
    if (Array.isArray(fallback)) {
      return fallback;
    }
    if (fallback && Array.isArray(fallback?.edits)) {
      return fallback.edits;
    }
    return [];
  }

  try {
    const parsed = JSON.parse(jsonText);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return Array.isArray(parsed?.edits) ? parsed.edits : [];
  } catch (error) {
    const loose = tryParseLooseJson(jsonText) || tryParseLooseJson(responseContent);
    if (Array.isArray(loose)) {
      return loose;
    }
    if (loose && Array.isArray(loose?.edits)) {
      return loose.edits;
    }
    throw error;
  }
};

const FAILURE_CONTEXT_PATH_REGEX = /(frontend|backend|src|tests|app|server|lib|config)\/[A-Za-z0-9._/\-]+/gi;

const formatTestFailureJobSection = (job, index) => {
  if (!job || typeof job !== 'object') {
    return '';
  }

  const label = job?.label || job?.type || job?.kind || `Job ${index + 1}`;
  const details = [];

  if (job?.status) {
    details.push(`Status: ${job.status}`);
  }
  if (job?.duration) {
    details.push(`Duration: ${job.duration}`);
  }
  if (job?.command) {
    const args = Array.isArray(job?.args) && job.args.length > 0 ? ` ${job.args.join(' ')}` : '';
    details.push(`Command: ${job.command}${args}`.trim());
  }
  if (job?.cwd) {
    details.push(`CWD: ${job.cwd}`);
  }
  if (Array.isArray(job?.testFailures) && job.testFailures.length > 0) {
    details.push(`Failing tests:\n- ${job.testFailures.join('\n- ')}`);
  }
  if (job?.error) {
    details.push(`Error: ${job.error}`);
  }
  if (job?.coverage) {
    try {
      details.push(`Coverage summary: ${JSON.stringify(job.coverage)}`);
    } catch {
      /* ignore JSON issues */
    }
  }
  if (Array.isArray(job?.uncoveredLines) && job.uncoveredLines.length > 0) {
    const lineSummary = job.uncoveredLines
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return null;
        }
        const workspace = typeof entry.workspace === 'string' ? entry.workspace.trim() : '';
        const file = typeof entry.file === 'string' ? entry.file.trim() : '';
        const normalizedFile = [workspace, file].filter(Boolean).join('/');
        if (!normalizedFile) {
          return null;
        }
        const lines = Array.isArray(entry.lines)
          ? entry.lines.map((value) => Number(value)).filter(Number.isFinite)
          : [];
        if (lines.length > 0) {
          const preview = lines.slice(0, 8).join(', ');
          const suffix = lines.length > 8 ? ', …' : '';
          return `${normalizedFile} (${preview}${suffix})`;
        }
        return normalizedFile;
      })
      .filter(Boolean)
      .slice(0, 4);

    if (lineSummary.length > 0) {
      details.push(`Uncovered lines: ${lineSummary.join('; ')}`);
    }
  }
  if (job?.failureReport) {
    details.push(`Failure report:\n${job.failureReport}`);
  }
  if (Array.isArray(job?.recentLogs) && job.recentLogs.length > 0) {
    details.push(`Recent logs:\n${job.recentLogs.join('\n')}`);
  }

  return `Job: ${label}${job?.type ? ` (${job.type})` : ''}${details.length ? `\n${details.join('\n')}` : ''}`.trim();
};

const formatTestFailureContext = (context) => {
  if (!context || !Array.isArray(context.jobs) || context.jobs.length === 0) {
    return '';
  }

  const sections = context.jobs.map((job, index) => formatTestFailureJobSection(job, index)).filter(Boolean);
  if (sections.length === 0) {
    return '';
  }

  return `\n\nTest failure context:\n\n${sections.join('\n\n')}`;
};

export const buildEditsPrompt = ({
  projectInfo,
  fileTreeContext,
  goalPrompt,
  stage,
  attempt = 1,
  retryContext = null,
  testFailureContext = null,
  scopeReflection = null,
  // [FAILURE PREVENTION] Framework context for informed code generation
  frameworkProfile = null,
  frameworkDecision = null,
  frameworkSafeguards = null
}) => {
  const stageLabel = stage === 'tests' ? 'tests' : 'implementation';
  const focusInstructions =
    stage === 'tests'
      ? 'Focus only on adding/updating tests first (TDD). Do not implement the feature beyond minimal scaffolding needed for tests to compile. Do not stub or remove required functionality just to satisfy tests.'
      : 'Now implement the feature so the tests pass. Keep edits minimal and localized. Do not weaken or remove required functionality to make tests pass.';
  const testRunnerGuidance =
    stage === 'tests'
      ? 'Use Vitest (vi) APIs and @testing-library for React tests. Do not use Jest globals or jest.*. If you are unsure about precise replacements in test files, prefer returning a full-file upsert.'
      : '';

  const retryNotices = [];
  if (retryContext?.message || retryContext?.path || retryContext?.searchSnippet) {
    const retryMessage = typeof retryContext?.message === 'string' ? retryContext.message.toLowerCase() : '';
    retryNotices.push(
      `Previous attempt failed while editing ${retryContext.path || 'the target file'} because ${
        retryContext.message || 'the replacement snippet did not match the current file.'
      } ` +
        'Provide replacements that exactly match the latest file contents. If you are unsure, output the entire updated file using type="upsert".' +
        (typeof retryContext.searchSnippet === 'string' && retryContext.searchSnippet.trim()
          ? ` Problematic search snippet: ${retryContext.searchSnippet.slice(0, 200)}`
          : '')
    );
    if (retryMessage.includes('ambiguous')) {
      retryNotices.push('The previous search snippet matched multiple locations. Use a longer, unique snippet with surrounding lines or return a full-file upsert.');
    } else if (retryMessage.includes('not found')) {
      retryNotices.push('The previous search snippet did not match the file. Copy an exact, current snippet from the file content or return a full-file upsert.');
    }
  }
  if (typeof retryContext?.scopeWarning === 'string' && retryContext.scopeWarning.trim()) {
    retryNotices.push(`Scope reminder: ${retryContext.scopeWarning.trim()}`);
  }
  if (Array.isArray(retryContext?.suggestedPaths) && retryContext.suggestedPaths.length > 0) {
    retryNotices.push(`Existing paths with similar names: ${retryContext.suggestedPaths.join(', ')}`);
  }

  const retryNotice = retryNotices.length ? `\n\n${retryNotices.join('\n\n')}` : '';

  const strictJsonWarning =
    attempt > 1
      ? 'Previous response was not valid JSON. Reply again using ONLY a single JSON object that matches the required schema. '
      : '';

  const failureContextBlock = formatTestFailureContext(testFailureContext);
  const reflectionBlock = formatScopeReflectionContext(scopeReflection);

  // [FAILURE PREVENTION] Build framework guidance for LLM
  const buildFrameworkContextBlock = (profile, decision, safeguards) => {
    if (!profile) {
      return '';
    }
    
    const framework = profile.detected?.framework || 'unknown';
    const hasRouter = profile.detected?.routerDependency;
    const confidence = decision?.normalized || 0;
    const decisionType = decision?.decision || 'unknown';
    
    let block = `\n\n## FRAMEWORK CONTEXT (${framework.toUpperCase()})\n`;
    block += `Framework: ${framework}\n`;
    block += `Router Library Available: ${hasRouter ? 'YES (react-router-dom installed)' : 'NO - do NOT use router imports'}\n`;
    block += `Decision Confidence: ${(confidence * 100).toFixed(0)}%\n`;
    block += `Generation Guidance: ${decision?.recommendation || 'Follow standard practices'}\n`;
    
    if (safeguards) {
      const safeToGenerateWithRouter = safeguards?.safeToGenerate?.withRouter;
      if (safeToGenerateWithRouter === false && hasRouter === false) {
        block += `\n⚠️ CRITICAL: Router dependency not installed. Use standard HTML navigation (<a> tags), not react-router-dom imports.\n`;
      } else if (safeToGenerateWithRouter === true) {
        block += `✓ Safe to use router API (react-router-dom Link, useNavigate, etc.) for internal navigation.\n`;
      }
    }
    
    return block;
  };

  const frameworkBlock = buildFrameworkContextBlock(frameworkProfile, frameworkDecision, frameworkSafeguards);

  let userContent = `${projectInfo}${fileTreeContext}\n\nTask: ${goalPrompt}\n\nStage: ${stageLabel}. ${focusInstructions} ` +
    'Honor layout/placement constraints in the task (e.g., top of page, full-width).';
  if (testRunnerGuidance) {
    userContent += `\n\n${testRunnerGuidance}`;
  }
  if (reflectionBlock) {
    userContent += reflectionBlock;
  }
  if (failureContextBlock) {
    userContent += failureContextBlock;
  }
  if (frameworkBlock) {
    userContent += frameworkBlock;
  }
  userContent += '\n\nReturn edits JSON only.';
  userContent += retryNotice;

  return {
    messages: [
      {
        role: 'system',
        content:
          `${strictJsonWarning}` +
          'You are an automated code editor. Return ONLY valid JSON. Output format: {"edits":[...]} where each edit is one of: ' +
          '{"type":"modify","path":"...","replacements":[{"search":"<exact unique snippet>","replace":"<replacement>"}]}, ' +
          '{"type":"upsert","path":"...","content":"<full file content>"}, ' +
          '{"type":"delete","path":"...","recursive":false}. ' +
          'Prefer type="modify" with replacements. Each search MUST match exactly once. Use repo-relative POSIX paths. ' +
            'For styling requests, scope changes to the explicitly requested element/component/selector. ' +
            'Do NOT change global selectors (body, html, :root, *, or app-wide wrappers) unless the request explicitly asks for page-wide/app-wide/global styling. ' +
          'IMPORTANT: Never wrap a component in <BrowserRouter> (or <HashRouter>, <MemoryRouter>) if the app already has a router in App.jsx or main.jsx. ' +
          'Adding a second router causes a "Cannot read properties of null (reading \'useRef\')" React crash. ' +
          'New route-aware components should use <Link>, useNavigate, etc. without their own Router provider.'
      },
      {
        role: 'user',
        content: userContent
      }
    ],
    max_tokens: 4000,
    temperature: 0,
    __lucidcoderDisableToolBridge: true,
    __lucidcoderPurpose: `goal-edits:${stageLabel}`
  };
};

export const normalizeMentionPath = (mention) => {
  let normalizedMention = normalizeRepoPath(mention);
  if (!normalizedMention) {
    return null;
  }
  if (!normalizedMention.startsWith('frontend/') && !normalizedMention.startsWith('backend/')) {
    normalizedMention = `frontend/${normalizedMention}`;
  }
  return normalizedMention;
};

const extractPathsFromTestFailureContext = (context) => {
  if (!context || !Array.isArray(context.jobs)) {
    return [];
  }

  const collected = new Set();

  for (const job of context.jobs) {
    const failureIds = Array.isArray(job?.testFailures) ? job.testFailures : [];
    for (const id of failureIds) {
      if (typeof id !== 'string') {
        continue;
      }
      const prefix = id.split('>')[0]?.trim();
      if (!prefix) {
        continue;
      }
      const normalized = normalizeMentionPath(prefix);
      if (normalized) {
        collected.add(normalized);
      }
    }

    const logLines = Array.isArray(job?.recentLogs) ? job.recentLogs : [];
    for (const line of logLines) {
      if (typeof line !== 'string' || line.length === 0) {
        continue;
      }
      const matches = line.match(FAILURE_CONTEXT_PATH_REGEX);
      if (!matches) {
        continue;
      }
      matches.forEach((match) => {
        const normalized = normalizeMentionPath(match);
        if (normalized) {
          collected.add(normalized);
        }
      });
    }
  }

  return Array.from(collected);
};

const LARGE_FILE_CHAR_LIMIT = 30000;
const LARGE_FILE_HEAD_CHARS = 8000;
const LARGE_FILE_TAIL_CHARS = 4000;

export const buildRelevantFilesContext = async ({
  projectId,
  goalPrompt,
  fileTreePaths,
  testFailureContext = null,
  testFailurePathsOverride = null
}) => {
  if (!projectId) {
    return '';
  }

  const normalizedTreePaths = []
    .concat(fileTreePaths)
    .map((p) => normalizeRepoPath(p))
    .filter(Boolean);
  const existingPaths = normalizedTreePaths.length > 0 ? new Set(normalizedTreePaths) : null;
  const failureMentionPaths = Array.isArray(testFailurePathsOverride)
    ? testFailurePathsOverride
    : extractPathsFromTestFailureContext(testFailureContext);
  const allowMissingPaths = new Set(failureMentionPaths);

  const promptText = typeof goalPrompt === 'string' ? goalPrompt : '';
  const lower = promptText.toLowerCase();
  const mentionsNavBar = /\b(navbar|navigation bar|nav bar)\b/i.test(promptText);
  const mentionsStyle = /\b(css|style|styling|stylesheet|theme)\b/i.test(promptText);
  const mentionsRouting = /\b(route|router|routing)\b/i.test(promptText);
  const mentionedPaths = new Set();

  if (promptText) {
    const pathRegex = /(frontend\/[A-Za-z0-9._/\-]+|src\/[A-Za-z0-9._/\-]+)/gi;
    let match;
    while ((match = pathRegex.exec(promptText))) {
      let mention = match[0]
        .replace(/^[^A-Za-z0-9]+/, '')
        .replace(/[^A-Za-z0-9._/\-]+$/u, '');

      const normalizedMention = normalizeMentionPath(mention);
      if (!normalizedMention) {
        continue;
      }
      mentionedPaths.add(normalizedMention);
    }
  }

  const candidates = [
    'frontend/package.json',
    'frontend/src/main.jsx',
    'frontend/src/main.tsx',
    'frontend/src/App.jsx',
    'frontend/src/App.tsx',
    'frontend/src/index.css',
    'frontend/src/App.css'
  ];

  if (existingPaths) {
    const pickFirst = (regex) => normalizedTreePaths.find((p) => regex.test(p));

    const main = pickFirst(/^frontend\/src\/main\.(js|jsx|ts|tsx)$/);
    const app = pickFirst(/^frontend\/src\/App\.(js|jsx|ts|tsx)$/);
    const indexCss = existingPaths.has('frontend/src/index.css') ? 'frontend/src/index.css' : null;
    const appCss = existingPaths.has('frontend/src/App.css') ? 'frontend/src/App.css' : null;

    if (main) candidates.push(main);
    if (app) candidates.push(app);
    if (indexCss) candidates.push(indexCss);
    if (appCss) candidates.push(appCss);

    if (mentionsNavBar || lower.includes('nav')) {
      const navCandidates = normalizedTreePaths.filter((p) => /NavBar\.(jsx|tsx|js|ts)$/.test(p));
      candidates.push(...navCandidates.slice(0, 4));
      const navStyles = normalizedTreePaths.filter((p) => /NavBar\.(module\.)?css$/.test(p));
      candidates.push(...navStyles.slice(0, 4));
    }

    if (mentionsRouting) {
      const routingFiles = normalizedTreePaths.filter((p) => /(\/router\/|\/routes\/|router\.|routes\.).*\.(js|jsx|ts|tsx)$/.test(p));
      candidates.push(...routingFiles.slice(0, 6));
    }
  }

  if (mentionedPaths.size > 0) {
    candidates.push(...mentionedPaths);
  }

  if (mentionsNavBar || lower.includes('nav')) {
    candidates.push(
      'frontend/src/components/NavBar.jsx',
      'frontend/src/components/NavBar.tsx',
      'frontend/src/components/NavBar.module.css'
    );
  }

  if (mentionsStyle) {
    candidates.push(
      'frontend/src/components/NavBar.module.css',
      'frontend/src/components/NavBar.css',
      'frontend/src/styles.css'
    );
  }

  if (failureMentionPaths.length > 0) {
    candidates.push(...failureMentionPaths);
  }

  const unique = Array.from(new Set(candidates));
  const sections = [];

  for (const filePath of unique) {
    const normalized = normalizeRepoPath(filePath);

    if (existingPaths && !existingPaths.has(normalized) && !allowMissingPaths.has(normalized)) {
      continue;
    }

    let content;
    try {
      content = await readProjectFile({ projectId, filePath: normalized });
    } catch {
      continue;
    }

    if (content === null) {
      if (allowMissingPaths.has(normalized)) {
        sections.push(`--- ${normalized} ---\n/* referenced in failure context but file content could not be loaded */`);
      }
      continue;
    }

    const trimmed = content.trim();
    if (!trimmed) {
      if (allowMissingPaths.has(normalized)) {
        sections.push(`--- ${normalized} ---\n/* referenced in failure context but file is empty */`);
      }
      continue;
    }

    let limited = trimmed;
    if (trimmed.length > LARGE_FILE_CHAR_LIMIT) {
      const head = trimmed.slice(0, LARGE_FILE_HEAD_CHARS);
      const tail = trimmed.slice(-LARGE_FILE_TAIL_CHARS);
      const omitted = trimmed.length - (head.length + tail.length);
      limited = `${head}\n\n/* ...${omitted} chars omitted... */\n\n${tail}`;
    }
    sections.push(`--- ${normalized} ---\n${limited}`);
  }

  if (sections.length === 0) {
    return '';
  }

  return `\n\nRelevant file contents (read-only context):\n\n${sections.join('\n\n')}`;
};

const { applyEdits, __setApplyEditsTestDeps } = createApplyEditsModule({
  readProjectFile,
  applyReplacements,
  tryRepairModifyEdit,
  tryRewriteFileWithLLM,
  upsertProjectFile,
  deleteProjectPath,
  stageProjectFile,
  automationLog,
  normalizeRepoPath,
  isReplacementResolutionError
});

export const __automationUtilsTestHooks = {
  formatTestFailureContext,
  formatTestFailureJobSection,
  extractJsonObjectFromIndex,
  formatScopeReflectionContext,
  extractJsonArrayFromIndex,
  extractPathsFromTestFailureContext,
  normalizeJsonLikeText,
  normalizeReflectionList,
  deriveReflectionPathPrefixes,
  isTestFilePath
};

export { applyEdits, __setApplyEditsTestDeps };
