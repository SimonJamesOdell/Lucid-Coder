import axios from 'axios';

export const automationLog = (label, details) => {
  try {
    console.log(`[automation] ${label}`, details);
  } catch {
    // Ignore environments where console is restricted.
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

export const extractBranchName = (raw, fallbackName) => {
  const fallback = String(fallbackName).trim();

  const slugify = (value) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '')
      .slice(0, 40);

  const text = String(raw).trim();
  if (!text) {
    return fallback;
  }

  const quoted = text.match(/['"]([a-z0-9]+(?:-[a-z0-9]+)+)['"]/i);
  if (quoted?.[1]) {
    const candidate = slugify(quoted[1]);
    if (candidate) return candidate;
  }

  const tokens = text.match(/[a-z0-9]+(?:-[a-z0-9]+)+/gi) || [];
  const token = tokens.map((t) => slugify(t)).find(Boolean);
  if (token) return token;

  return slugify(text) || fallback;
};

export const parseBranchNameFromLLMText = (text) => {
  const trimmed = text.trim();
  if (!trimmed) return '';

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const candidate = parsed?.branch ?? parsed?.name;
      return typeof candidate === 'string' ? candidate.trim() : '';
    } catch {
      // Fall through to treat it as plain text.
    }
  }

  return trimmed;
};

export const isValidBranchName = (name) => {
  const trimmed = String(name).trim();
  if (trimmed === 'kebab-case') return false;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(trimmed)) return false;
  const parts = trimmed.split('-');
  return parts.length >= 2 && parts.length <= 5;
};

export const buildFallbackBranchNameFromPrompt = (prompt, fallbackName) => {
  const fallback = String(fallbackName || '').trim();
  const raw = String(prompt || '').toLowerCase();
  if (!raw.trim()) {
    return fallback;
  }

  const stopwords = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by',
    'can', 'could', 'do', 'does', 'for', 'from', 'have', 'has', 'had',
    'how', 'i', 'if', 'in', 'into', 'is', 'it', "it's", 'its',
    'let', "let's", 'make', 'of', 'on', 'or', 'our', 'please',
    'should', 'so', 'some', 'that', 'the', 'their', 'then', 'there',
    'this', 'to', 'up', 'we', 'with', 'would', 'you', 'your'
  ]);

  const words = raw
    .replace(/[^a-z0-9\s-]+/g, ' ')
    .split(/[\s-]+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .filter((w) => !stopwords.has(w))
    .filter((w) => !/^\d+$/.test(w));

  const picked = [];
  for (const word of words) {
    picked.push(word);
    if (picked.length >= 4) {
      break;
    }
  }

  if (picked.length < 2) {
    return fallback;
  }

  const candidate = picked.join('-');
  return extractBranchName(candidate, fallback);
};

export const isBranchNameRelevantToPrompt = (branchName, prompt) => {
  const normalize = (value) => String(value || '')
    .toLowerCase()
    .replace(/\//g, ' ')
    .replace(/[^a-z0-9\s-]+/g, ' ');

  const stopwords = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by',
    'can', 'could', 'do', 'does', 'for', 'from', 'have', 'has', 'had',
    'how', 'i', 'if', 'in', 'into', 'is', 'it', "it's", 'its',
    'let', "let's", 'make', 'of', 'on', 'or', 'our', 'please',
    'should', 'so', 'some', 'that', 'the', 'their', 'then', 'there',
    'this', 'to', 'up', 'we', 'with', 'would', 'you', 'your'
  ]);

  const tokenize = (value) => normalize(value)
    .split(/[\s-]+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .filter((w) => !stopwords.has(w))
    .filter((w) => !/^\d+$/.test(w));

  const promptTokens = new Set(tokenize(prompt));
  const branchTokens = new Set(tokenize(branchName));

  if (promptTokens.size === 0 || branchTokens.size === 0) {
    return true;
  }

  // If the prompt is too short (e.g. just "test" or "refactor"), we don't have
  // enough signal to reliably judge relevance.
  if (promptTokens.size < 2) {
    return true;
  }

  for (const token of branchTokens) {
    if (promptTokens.has(token)) {
      return true;
    }
  }
  return false;
};

export const requestBranchNameFromLLM = async ({ prompt, fallbackName }) => {
  const buildMessages = (attempt) => {
    if (attempt === 2) {
      return [
        {
          role: 'system',
          content:
            'Return ONLY valid JSON with a single key "branch". Example: {"branch":"added-navigation-bar"}. ' +
            'The value must be a concise change description using a verb like "added", "changed", "fixed", or "updated" (two to five words), lowercase, hyphen-separated, max 40 chars. ' +
            'Do NOT mention rules/constraints, do NOT output examples, and do NOT echo any numbers from the prompt (invalid: {"branch":"2-5"}). ' +
            'Each hyphen-separated word must contain at least one letter a-z.'
        },
        { role: 'user', content: `User request: "${prompt}"` }
      ];
    }

    return [
      {
        role: 'system',
        content:
          'Return ONLY valid JSON with a single key "branch". ' +
          'The value must be a concise change description using a verb like "added", "changed", "fixed", or "updated". ' +
          'Examples: {"branch":"added-navigation-bar"}, {"branch":"changed-background-color"}, {"branch":"refactoring-simplification"}. ' +
          'Rules: two to five words, lowercase, words separated by hyphens, max 40 chars. ' +
          'Do NOT output the rules themselves (invalid: {"branch":"2-5"}). Each word must contain at least one letter a-z.'
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

const escapeControlCharsInStrings = (text) => {
  let result = '';
  let inString = false;
  let stringChar = '';
  let escape = false;

  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];

    if (inString) {
      if (escape) {
        result += ch;
        escape = false;
        continue;
      }

      if (ch === '\\') {
        result += ch;
        escape = true;
        continue;
      }

      if (ch === stringChar) {
        inString = false;
        stringChar = '';
        result += ch;
        continue;
      }

      if (ch === '\n') {
        result += '\\n';
        continue;
      }

      if (ch === '\r') {
        result += '\\r';
        continue;
      }

      result += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      result += ch;
      continue;
    }

    result += ch;
  }

  return result;
};

const normalizeJsonLikeText = (input) => {
  if (typeof input !== 'string') {
    return '';
  }

  const decoded = input.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

  const unifiedQuotes = decoded
    .replace(/\u00a0/gi, ' ')
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'");

  return escapeControlCharsInStrings(unifiedQuotes);
};

export const extractJsonObject = (value) => {
  if (typeof value !== 'string') {
    return null;
  }

  const text = normalizeJsonLikeText(value);
  const start = text.indexOf('{');
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let stringChar = '"';
  let escape = false;

  for (let index = start; index < text.length; index += 1) {
    const ch = text[index];

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === stringChar) {
        inString = false;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      continue;
    }

    if (ch === '{') {
      depth += 1;
      continue;
    }

    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
};

export const tryParseLooseJson = (value) => {
  if (typeof value !== 'string') {
    return null;
  }

  let text = normalizeJsonLikeText(value).trim();

  while (/^\{\s*\{/.test(text) && /\}\s*\}$/.test(text)) {
    text = text.slice(1, -1).trim();
  }

  text = text.replace(/'/g, '"');

  const quoteUnquotedKeysOutsideStrings = (input) => {
    let output = '';
    let inString = false;
    let escape = false;

    for (let index = 0; index < input.length; index += 1) {
      const ch = input[index];

      if (inString) {
        output += ch;
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === '\\') {
          escape = true;
          continue;
        }
        if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        output += ch;
        continue;
      }

      if (ch === '{' || ch === ',') {
        output += ch;
        let lookahead = index + 1;

        while (lookahead < input.length && /\s/.test(input[lookahead])) {
          output += input[lookahead];
          lookahead += 1;
        }

        if (input[lookahead] === '"') {
          index = lookahead - 1;
          continue;
        }

        if (/[A-Za-z_]/.test(input[lookahead] || '')) {
          const start = lookahead;
          lookahead += 1;
          while (lookahead < input.length && /[A-Za-z0-9_]/.test(input[lookahead])) {
            lookahead += 1;
          }
          const key = input.slice(start, lookahead);

          let ws = lookahead;
          while (ws < input.length && /\s/.test(input[ws])) {
            ws += 1;
          }

          if (input[ws] === ':') {
            output += `"${key}"`;
            output += input.slice(lookahead, ws);
            output += ':';
            index = ws;
            continue;
          }
        }

        index = lookahead - 1;
        continue;
      }

      output += ch;
    }

    return output;
  };

  const removeTrailingCommasOutsideStrings = (input) => {
    let output = '';
    let inString = false;
    let escape = false;

    for (let index = 0; index < input.length; index += 1) {
      const ch = input[index];

      if (inString) {
        output += ch;
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === '\\') {
          escape = true;
          continue;
        }
        if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        output += ch;
        continue;
      }

      if (ch === ',') {
        let lookahead = index + 1;
        while (lookahead < input.length && /\s/.test(input[lookahead])) {
          lookahead += 1;
        }
        const next = input[lookahead];
        if (next === '}' || next === ']') {
          continue;
        }
      }

      output += ch;
    }

    return output;
  };

  text = quoteUnquotedKeysOutsideStrings(text);
  text = removeTrailingCommasOutsideStrings(text);

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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

  const createResponse = await axios.post(`/api/projects/${projectId}/files-ops/create-file`, {
    filePath,
    content
  });
  if (useKnownPaths) {
    knownPathsSet.add(filePath);
  }
  return createResponse.data;
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

const normalizeReflectionList = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean)
    .slice(0, 12);
};

const deriveReflectionPathPrefixes = (entries) => {
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

const SCOPE_REFLECTION_DEFAULT = Object.freeze({
  reasoning: '',
  mustChange: [],
  mustAvoid: [],
  mustHave: [],
  testsNeeded: true
});

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

export const parseScopeReflectionResponse = (llmResponse) => {
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
    } catch (error) {
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

const formatScopeReflectionContext = (reflection) => {
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

const isTestFilePath = (path) => {
  if (!path) {
    return false;
  }
  return /__tests__\//.test(path) || /\.(test|spec)\.[jt]sx?$/.test(path);
};

export const validateEditsAgainstReflection = (edits, reflection) => {
  if (!reflection || !Array.isArray(edits) || edits.length === 0) {
    return null;
  }

  const avoidPrefixes = deriveReflectionPathPrefixes(reflection.mustAvoid || []);

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


export const parseEditsFromLLM = (llmResponse) => {
  const responseContent = llmResponse?.data?.response || llmResponse?.data?.content || '';
  const jsonText = extractJsonObject(responseContent);
  if (!jsonText) {
    return [];
  }

  try {
    const parsed = JSON.parse(jsonText);
    return Array.isArray(parsed?.edits) ? parsed.edits : [];
  } catch (error) {
    const loose = tryParseLooseJson(jsonText);
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
  scopeReflection = null
}) => {
  const stageLabel = stage === 'tests' ? 'tests' : 'implementation';
  const focusInstructions =
    stage === 'tests'
      ? 'Focus only on adding/updating tests first (TDD). Do not implement the feature beyond minimal scaffolding needed for tests to compile. Do not stub or remove required functionality just to satisfy tests.'
      : 'Now implement the feature so the tests pass. Keep edits minimal and localized. Do not weaken or remove required functionality to make tests pass.';

  const retryNotices = [];
  if (retryContext?.message || retryContext?.path || retryContext?.searchSnippet) {
    retryNotices.push(
      `Previous attempt failed while editing ${retryContext.path || 'the target file'} because ${
        retryContext.message || 'the replacement snippet did not match the current file.'
      } ` +
        'Provide replacements that exactly match the latest file contents. If you are unsure, output the entire updated file using type="upsert".' +
        (typeof retryContext.searchSnippet === 'string' && retryContext.searchSnippet.trim()
          ? ` Problematic search snippet: ${retryContext.searchSnippet.slice(0, 200)}`
          : '')
    );
  }
  if (typeof retryContext?.scopeWarning === 'string' && retryContext.scopeWarning.trim()) {
    retryNotices.push(`Scope reminder: ${retryContext.scopeWarning.trim()}`);
  }

  const retryNotice = retryNotices.length ? `\n\n${retryNotices.join('\n\n')}` : '';

  const strictJsonWarning =
    attempt > 1
      ? 'Previous response was not valid JSON. Reply again using ONLY a single JSON object that matches the required schema. '
      : '';

  const failureContextBlock = formatTestFailureContext(testFailureContext);
  const reflectionBlock = formatScopeReflectionContext(scopeReflection);

  let userContent = `${projectInfo}${fileTreeContext}\n\nTask: ${goalPrompt}\n\nStage: ${stageLabel}. ${focusInstructions} ` +
    'Honor layout/placement constraints in the task (e.g., top of page, full-width).';
  if (reflectionBlock) {
    userContent += reflectionBlock;
  }
  if (failureContextBlock) {
    userContent += failureContextBlock;
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
          'Prefer type="modify" with replacements. Each search MUST match exactly once. Use repo-relative POSIX paths.'
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

const applyEditsDeps = {
  readProjectFile,
  applyReplacements,
  tryRepairModifyEdit,
  tryRewriteFileWithLLM,
  upsertProjectFile,
  deleteProjectPath,
  stageProjectFile
};

export const __setApplyEditsTestDeps = (overrides = {}) => {
  const restore = {};
  Object.entries(overrides).forEach(([key, value]) => {
    if (typeof value === 'function' && applyEditsDeps[key]) {
      restore[key] = applyEditsDeps[key];
      applyEditsDeps[key] = value;
    }
  });
  return () => {
    Object.entries(restore).forEach(([key, value]) => {
      applyEditsDeps[key] = value;
    });
  };
};

export const __automationUtilsTestHooks = {
  formatTestFailureContext,
  formatTestFailureJobSection,
  formatScopeReflectionContext,
  extractPathsFromTestFailureContext,
  normalizeJsonLikeText,
  normalizeReflectionList,
  deriveReflectionPathPrefixes,
  isTestFilePath
};

export const applyEdits = async ({
  projectId,
  edits,
  source = 'ai',
  knownPathsSet,
  goalPrompt,
  stage,
  onFileApplied,
  syncBranchOverview
}) => {
  if (!projectId || !Array.isArray(edits) || edits.length === 0) {
    return { applied: 0, skipped: 0 };
  }

  const useKnownPaths = knownPathsSet instanceof Set && knownPathsSet.size > 0;

  let applied = 0;
  let skipped = 0;

  for (const edit of edits) {
    const rawPath = edit?.path;
    const type = edit?.type;
    const normalizedPath = normalizeRepoPath(rawPath);

    if (!normalizedPath) {
      skipped += 1;
      automationLog('skipping edit (missing/invalid path)', { type, path: rawPath });
      continue;
    }

    if (type === 'modify') {
      const original = await applyEditsDeps.readProjectFile({ projectId, filePath: normalizedPath });
      if (original === null) {
        throw new Error('File not found');
      }

      let updated;
      try {
        updated = applyEditsDeps.applyReplacements(original, edit?.replacements);
      } catch (error) {
        const fallbackMessage =
          typeof error?.message === 'string' && error.message.trim().length > 0
            ? error.message
            : String(error || 'Replacement failed');
        const replacementError = error instanceof Error ? error : new Error(fallbackMessage);
        if (replacementError && !replacementError.message) {
          replacementError.message = fallbackMessage;
        }
        const replacementPreview = []
          .concat(edit?.replacements)
          .filter((r) => r && typeof r === 'object')
          .slice(0, 2)
          .map((r) => ({
            searchPreview: typeof r?.search === 'string' ? r.search.slice(0, 160) : null
          }));

        replacementError.__lucidcoderReplacementFailure = {
          path: normalizedPath,
          stage,
          message: replacementError.message,
          searchSnippet: replacementPreview[0]?.searchPreview || null
        };

        automationLog('applyEdits:modify:replacementError', {
          path: normalizedPath,
          message: replacementError?.message,
          preview: replacementPreview
        });

        if (isReplacementResolutionError(replacementError) && typeof goalPrompt === 'string' && goalPrompt.trim().length > 0) {
          const repaired = await applyEditsDeps.tryRepairModifyEdit({
            projectId,
            goalPrompt,
            stage,
            filePath: normalizedPath,
            originalContent: original,
            failedEdit: edit,
            error: replacementError
          });

          if (repaired?.type === 'modify' && repaired?.replacements) {
            try {
              updated = applyEditsDeps.applyReplacements(original, repaired.replacements);
              edit.replacements = repaired.replacements;
            } catch (repairApplyError) {
              automationLog('applyEdits:modify:repair:applyError', {
                path: normalizedPath,
                message: repairApplyError?.message
              });
              throw replacementError;
            }
          } else if (repaired?.type === 'upsert' && typeof repaired?.content === 'string') {
            updated = repaired.content;
          } else {
              const rewriteEdit = await applyEditsDeps.tryRewriteFileWithLLM({
              goalPrompt,
              stage,
              filePath: normalizedPath,
              originalContent: original,
              errorMessage: replacementError?.message || 'Unknown replacement failure'
            });

            if (rewriteEdit?.type === 'upsert' && typeof rewriteEdit?.content === 'string') {
              updated = rewriteEdit.content;
              edit.replacements = undefined;
            } else if (rewriteEdit?.type === 'modify' && rewriteEdit?.replacements) {
              try {
                updated = applyEditsDeps.applyReplacements(original, rewriteEdit.replacements);
                edit.replacements = rewriteEdit.replacements;
              } catch (rewriteApplyError) {
                automationLog('applyEdits:modify:rewrite:applyError', {
                  path: normalizedPath,
                  message: rewriteApplyError?.message
                });
                throw replacementError;
              }
            } else {
              throw replacementError;
            }
          }
        } else {
          throw replacementError;
        }
      }
      if (updated === original) {
        skipped += 1;
        automationLog('skipping edit (no-op modify)', { type, path: normalizedPath });
        continue;
      }

      await applyEditsDeps.upsertProjectFile({
        projectId,
        filePath: normalizedPath,
        content: updated,
        knownPathsSet: useKnownPaths ? knownPathsSet : undefined
      });
      const stagePayload = await applyEditsDeps.stageProjectFile({ projectId, filePath: normalizedPath, source });
      if (typeof syncBranchOverview === 'function' && stagePayload?.overview) {
        syncBranchOverview(projectId, stagePayload.overview);
      }
      if (typeof onFileApplied === 'function') {
        await onFileApplied(normalizedPath, { type: 'modify' });
      }
      applied += 1;
      continue;
    }

    if (type === 'delete') {
      await applyEditsDeps.deleteProjectPath({ projectId, targetPath: normalizedPath, recursive: edit?.recursive === true });
      const stagePayload = await applyEditsDeps.stageProjectFile({ projectId, filePath: normalizedPath, source });
      if (typeof syncBranchOverview === 'function' && stagePayload?.overview) {
        syncBranchOverview(projectId, stagePayload.overview);
      }
      applied += 1;
      continue;
    }

    const content = edit?.content;
    if (typeof content !== 'string') {
      skipped += 1;
      automationLog('skipping edit (upsert content not a string)', { type, path: normalizedPath });
      continue;
    }

    await applyEditsDeps.upsertProjectFile({
      projectId,
      filePath: normalizedPath,
      content,
      knownPathsSet: useKnownPaths ? knownPathsSet : undefined
    });
    const stagePayload = await applyEditsDeps.stageProjectFile({ projectId, filePath: normalizedPath, source });
    if (typeof syncBranchOverview === 'function' && stagePayload?.overview) {
      syncBranchOverview(projectId, stagePayload.overview);
    }
    if (typeof onFileApplied === 'function') {
      await onFileApplied(normalizedPath, { type: 'upsert' });
    }
    applied += 1;
  }

  return { applied, skipped };
};
