import fs from 'fs/promises';
import path from 'path';
import { llmClient } from '../llm-client.js';
import { getProjectRoot, readProjectFile, writeProjectFile } from './projectTools.js';

const SYSTEM_PROMPT = `You are an autonomous software engineer that edits a repository on behalf of the user.
Always respond with a SINGLE JSON object describing your next action.

Supported actions:
- {"action":"read_file","path":"relative/path","reason":"why"}
- {"action":"list_dir","path":"relative/dir","reason":"why"}
- {"action":"write_file","path":"relative/file","content":"FULL FILE CONTENT"}
- {"action":"plan","note":"short plan"}
- {"action":"finalize","summary":"concise status"}

Rules:
1. Paths must be relative to the repository root. Do not use absolute paths or traverse outside the workspace.
2. For write_file you must provide the entire desired file content, not a diff.
3. Keep interactions focused on the current goal. Avoid unrelated refactors.
4. Finalize when the requested change is complete or blocked.`;

const MAX_ACTIONS = 40;
const MAX_WRITES = 12;
const MAX_FILE_TREE_ENTRIES = 400;
const MAX_LIST_ENTRIES = 200;
const MAX_OBSERVATION_CHARS = 20_000;
const MAX_FILE_CHARS = 200_000;
const LOOP_WINDOW = 6;

const STYLE_REQUEST_REGEX = /\b(css|style|styling|theme|color|background|foreground|text|font|typography|navbar|navigation bar|header|footer|sidebar|card|modal|button|input|form)\b/i;
const GLOBAL_STYLE_REQUEST_REGEX = /\b(global|app-wide|site-wide|entire app|whole app|across the app|entire page|whole page|page-wide|every page|all pages|entire site|whole site|all screens)\b/i;
const GLOBAL_SELECTOR_REGEX = /\b(body|html)\s*[{,]|:root\s*[{,]|(^|\n)\s*\*\s*[{,]|#root\s*[{,]|:global\(\s*(body|html|:root|\*)\s*\)/i;
const GLOBAL_STYLE_FILE_REGEX = /(^|\/)(index|app|styles|theme|globals?)\.(css|scss|sass|less)$/i;
const TARGET_STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'for', 'with', 'in', 'on', 'at', 'by',
  'make', 'set', 'change', 'update', 'turn', 'give', 'use', 'have', 'has', 'be', 'as',
  'black', 'white', 'red', 'green', 'blue', 'yellow', 'orange', 'purple', 'pink', 'gray', 'grey'
]);

const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  '.next',
  '.turbo',
  '.gradle',
  '.idea',
  '.vscode',
  'dist',
  'build',
  'coverage',
  'coverage-tmp',
  '.cache'
]);

const IGNORED_FILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  '.DS_Store'
]);

const normalizeRelativePath = (value = '') => value.replace(/\\/g, '/').replace(/^\/+/g, '').trim();

const normalizeHint = (value = '') => String(value || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').trim();

const extractStyleTargetHints = (prompt = '') => {
  const lower = String(prompt || '').toLowerCase();
  if (!lower) {
    return [];
  }

  const hints = new Set();
  const addHint = (value) => {
    const normalized = normalizeHint(value);
    if (!normalized || normalized.length < 3 || TARGET_STOP_WORDS.has(normalized)) {
      return;
    }
    hints.add(normalized);
  };

  if (/\b(navbar|navigation\s+bar|nav\s+bar)\b/.test(lower)) {
    ['navbar', 'navigation', 'nav', 'bar'].forEach(addHint);
  }

  const targetPhraseMatch = lower.match(/\b(?:the|a|an)\s+([a-z0-9_-]+(?:\s+[a-z0-9_-]+){0,3})\s+(?:have|has|with|to|should|needs|need|be)\b/);
  if (targetPhraseMatch?.[1]) {
    targetPhraseMatch[1].split(/\s+/).forEach(addHint);
  }

  const selectorMatches = lower.match(/[.#][a-z0-9_-]+/g) || [];
  selectorMatches.forEach((selector) => addHint(selector.slice(1)));

  return Array.from(hints).slice(0, 8);
};

const deriveStyleScopeContract = (prompt = '') => {
  const text = String(prompt || '').trim();
  if (!text || !STYLE_REQUEST_REGEX.test(text)) {
    return null;
  }
  if (GLOBAL_STYLE_REQUEST_REGEX.test(text)) {
    return {
      mode: 'global',
      targetHints: []
    };
  }
  return {
    mode: 'targeted',
    targetHints: extractStyleTargetHints(text)
  };
};

const writeMentionsTarget = ({ path: filePath, content, targetHints = [] } = {}) => {
  if (!Array.isArray(targetHints) || targetHints.length === 0) {
    return false;
  }
  const haystack = `${String(filePath || '').toLowerCase()}\n${String(content || '').toLowerCase()}`;
  return targetHints.some((hint) => haystack.includes(hint));
};

const validateStyleWriteScope = ({ contract, path: filePath, content } = {}) => {
  if (!contract || contract.mode !== 'targeted') {
    return null;
  }

  const normalizedPath = normalizeRelativePath(filePath || '').toLowerCase();
  const text = String(content || '');

  if (GLOBAL_SELECTOR_REGEX.test(text)) {
    return 'Targeted style request cannot change global selectors (body/html/:root/*/#root).';
  }

  if (GLOBAL_STYLE_FILE_REGEX.test(normalizedPath) && !writeMentionsTarget({ path: normalizedPath, content: text, targetHints: contract.targetHints })) {
    return 'Targeted style request must include target-specific selectors/components; broad global stylesheet edits are not allowed.';
  }

  return null;
};

const ensureSafeRelativePath = (value = '') => {
  const normalized = normalizeRelativePath(value || '');
  if (!normalized) {
    throw new Error('Path is required');
  }
  if (normalized.includes('..')) {
    throw new Error('Path must stay within the project workspace');
  }
  return normalized;
};

const truncateForObservation = (text) => {
  if (typeof text !== 'string') {
    return '';
  }
  if (text.length <= MAX_OBSERVATION_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_OBSERVATION_CHARS)}\n…truncated…`;
};

const stripCodeFences = (value) => {
  if (typeof value !== 'string') {
    return '';
  }
  const fenced = value.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced && typeof fenced[1] === 'string') {
    return fenced[1].trim();
  }
  return value.trim();
};

const extractFirstJsonObject = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escape = false;
  let start = -1;
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index];
    if (inString) {
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
      continue;
    }
    if (ch === '{') {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        return value.slice(start, index + 1);
      }
    }
  }
  return null;
};

const parseActionResponse = (raw) => {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = stripCodeFences(raw);
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const recovered = extractFirstJsonObject(trimmed);
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

const createActionStep = (action, target, meta) => ({
  type: 'action',
  action,
  target: target || null,
  meta: meta || null,
  timestamp: Date.now()
});

const createObservationStep = (action, target, summary) => ({
  type: 'observation',
  action,
  target: target || null,
  summary,
  timestamp: Date.now()
});

const buildInitialUserMessage = ({ prompt, fileTree }) => {
  const parts = [
    'Repository snapshot (truncated):',
    fileTree || '(file tree unavailable)',
    'User goal:',
    prompt.trim()
  ];
  return parts.join('\n\n');
};

const queueAsyncWalk = async (root, limit) => {
  const results = [];
  const queue = [''];

  while (queue.length && results.length < limit) {
    const relative = queue.shift();
    const absolute = path.join(root, relative);
    let entries;
    try {
      entries = await fs.readdir(absolute, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (results.length >= limit) {
        break;
      }

      const entryName = entry.name;
      if (IGNORED_FILES.has(entryName)) {
        continue;
      }

      const relPath = path.posix.join(relative.replace(/\\/g, '/'), entryName).replace(/^\//, '');
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entryName)) {
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

const buildFileTreeSnapshot = async (projectRoot) => {
  try {
    const entries = await queueAsyncWalk(projectRoot, MAX_FILE_TREE_ENTRIES);
    if (!entries.length) {
      return '(empty directory)';
    }
    return entries.map((entry) => `- ${entry || '.'}`).join('\n');
  } catch (error) {
    return `(unable to build file tree: ${error.message})`;
  }
};

const listDirectoryForAgent = async (projectRoot, candidate) => {
  const relative = normalizeRelativePath(candidate || '.');
  const absolute = path.resolve(projectRoot, relative);
  const resolvedRoot = path.resolve(projectRoot);
  if (!(absolute === resolvedRoot || absolute.startsWith(`${resolvedRoot}${path.sep}`))) {
    throw new Error('Directory access outside of project root is not allowed');
  }

  try {
    const entries = await fs.readdir(absolute, { withFileTypes: true });
    const mapped = entries
      .filter((entry) => {
        if (entry.isDirectory()) {
          return !IGNORED_DIRECTORIES.has(entry.name);
        }
        return !IGNORED_FILES.has(entry.name);
      })
      .map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'dir' : 'file'
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_LIST_ENTRIES);

    return { path: relative === '' ? '.' : relative, entries: mapped };
  } catch (error) {
    return {
      path: relative === '' ? '.' : relative,
      entries: [],
      error: error.message
    };
  }
};

const readFileForAgent = async (projectId, relativePath) => {
  const normalized = ensureSafeRelativePath(relativePath);
  try {
    const content = await readProjectFile(projectId, normalized);
    return {
      path: normalized,
      content,
      truncated: truncateForObservation(content),
      status: 'ok'
    };
  } catch (error) {
    return {
      path: normalized,
      content: null,
      truncated: '',
      status: 'error',
      error: error.message || 'Unable to read file'
    };
  }
};

const writeFileForAgent = async (projectId, relativePath, content) => {
  if (typeof content !== 'string') {
    throw new Error('write_file content must be a string');
  }
  if (content.length > MAX_FILE_CHARS) {
    throw new Error(`write_file content exceeds ${MAX_FILE_CHARS} characters`);
  }
  const normalized = ensureSafeRelativePath(relativePath);
  await writeProjectFile(projectId, normalized, content);
  return {
    path: normalized,
    bytesWritten: content.length
  };
};

class LoopDetector {
  constructor(limit = LOOP_WINDOW) {
    this.limit = limit;
    this.history = [];
  }

  record(action, target) {
    this.history.push({ action, target });
    if (this.history.length > this.limit) {
      this.history.shift();
    }
  }

  isLooping() {
    if (this.history.length < this.limit) {
      return false;
    }
    const actions = this.history.map((entry) => entry.action);
    const uniqueActions = new Set(actions);
    if (uniqueActions.size === 1) {
      return true;
    }
    const writes = this.history.filter((entry) => entry.action === 'write_file').length;
    return writes === 0;
  }
}

export const applyCodeChange = async ({ projectId, prompt, ui } = {}) => {
  if (!projectId) {
    throw new Error('projectId is required');
  }
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('prompt is required');
  }

  const projectRoot = await getProjectRoot(projectId);
  const fileTree = await buildFileTreeSnapshot(projectRoot);
  const styleScopeContract = deriveStyleScopeContract(prompt);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildInitialUserMessage({ prompt, fileTree }) }
  ];

  if (styleScopeContract?.mode === 'targeted') {
    messages.push({
      role: 'user',
      content:
        'Style scope contract: this request is element-scoped. Do NOT edit global selectors (body/html/:root/*/#root). ' +
        'Do NOT satisfy the request by changing app-wide theme/background tokens. Update only selectors/components tied to the requested target.'
    });
  }

  const steps = [];
  const loopDetector = new LoopDetector();
  let writes = 0;
  let summary = '';

  for (let iteration = 0; iteration < MAX_ACTIONS; iteration += 1) {
    const response = await llmClient.generateResponse(messages, {
      max_tokens: 800,
      temperature: 0,
      __lucidcoderPhase: 'autopilot-edit',
      __lucidcoderRequestType: 'code_edit'
    });

    const actionPayload = parseActionResponse(response);
    if (!actionPayload || typeof actionPayload !== 'object') {
      messages.push({
        role: 'user',
        content: 'Your previous reply was invalid. Respond with a single JSON object describing the next action.'
      });
      continue;
    }

    const actionName = typeof actionPayload.action === 'string' ? actionPayload.action.trim().toLowerCase() : '';
    if (!actionName) {
      messages.push({
        role: 'user',
        content: 'Each response must include an "action" field.'
      });
      continue;
    }

    loopDetector.record(actionName, actionPayload.path || null);
    messages.push({ role: 'assistant', content: JSON.stringify(actionPayload) });

    if (loopDetector.isLooping()) {
      throw new Error('Code edit agent detected a potential infinite loop.');
    }

    if (actionName === 'read_file') {
      const result = await readFileForAgent(projectId, actionPayload.path);
      steps.push(createActionStep('read_file', result.path, actionPayload.reason || null));
      if (result.status === 'ok') {
        steps.push(createObservationStep('read_file', result.path, `Read ${result.content.length} characters`));
        messages.push({
          role: 'user',
          content: JSON.stringify({ action: 'read_file', path: result.path, content: result.truncated })
        });
      } else {
        steps.push(createObservationStep('read_file', result.path, `Error: ${result.error}`));
        messages.push({
          role: 'user',
          content: JSON.stringify({ action: 'read_file', path: result.path, error: result.error })
        });
      }
      continue;
    }

    if (actionName === 'list_dir') {
      const listing = await listDirectoryForAgent(projectRoot, actionPayload.path || '.');
      steps.push(createActionStep('list_dir', listing.path, actionPayload.reason || null));
      if (listing.error) {
        steps.push(createObservationStep('list_dir', listing.path, `Error: ${listing.error}`));
        messages.push({
          role: 'user',
          content: JSON.stringify({ action: 'list_dir', path: listing.path, error: listing.error })
        });
      } else {
        steps.push(createObservationStep('list_dir', listing.path, `Listed ${listing.entries.length} entries`));
        messages.push({
          role: 'user',
          content: JSON.stringify({ action: 'list_dir', path: listing.path, entries: listing.entries })
        });
      }
      continue;
    }

    if (actionName === 'write_file') {
      if (writes >= MAX_WRITES) {
        throw new Error('Write limit reached while attempting to apply changes.');
      }
      const content = typeof actionPayload.content === 'string' ? actionPayload.content : null;
      if (content == null) {
        messages.push({
          role: 'user',
          content: 'write_file actions must include a "content" field with the full file contents.'
        });
        continue;
      }

      const styleScopeViolation = validateStyleWriteScope({
        contract: styleScopeContract,
        path: actionPayload.path,
        content
      });
      if (styleScopeViolation) {
        const targetPath = normalizeRelativePath(actionPayload.path || '') || null;
        steps.push(createActionStep('write_file', targetPath, actionPayload.reason || null));
        steps.push(createObservationStep('write_file', targetPath, `Rejected: ${styleScopeViolation}`));
        messages.push({
          role: 'user',
          content: JSON.stringify({
            action: 'write_file',
            path: targetPath,
            status: 'rejected',
            error: styleScopeViolation
          })
        });
        continue;
      }

      const result = await writeFileForAgent(projectId, actionPayload.path, content);
      writes += 1;
      const summaryText = `Wrote ${result.bytesWritten} characters`;
      steps.push(createActionStep('write_file', result.path, actionPayload.reason || null));
      steps.push(createObservationStep('write_file', result.path, summaryText));
      messages.push({
        role: 'user',
        content: JSON.stringify({ action: 'write_file', path: result.path, status: 'ok', summary: summaryText })
      });
      continue;
    }

    if (actionName === 'plan') {
      const note = typeof actionPayload.note === 'string' ? actionPayload.note.trim() : '';
      steps.push(createActionStep('plan', null, note || 'Updated plan.'));
      messages.push({
        role: 'user',
        content: JSON.stringify({ action: 'plan_ack', note: note || 'Plan acknowledged.' })
      });
      continue;
    }

    if (actionName === 'finalize' || actionName === 'answer') {
      summary = typeof actionPayload.summary === 'string' && actionPayload.summary.trim()
        ? actionPayload.summary.trim()
        : (typeof actionPayload.answer === 'string' ? actionPayload.answer.trim() : 'Completed edit session.');
      steps.push(createActionStep('finalize', null, summary));
      return {
        steps,
        summary
      };
    }

    steps.push(createActionStep(actionName, actionPayload.path || null, 'Unsupported action'));
    steps.push(createObservationStep(actionName, actionPayload.path || null, 'Action rejected.'));
    messages.push({
      role: 'user',
      content: JSON.stringify({ error: `Action "${actionName}" is not supported.` })
    });
  }

  throw new Error('Code edit agent exceeded the maximum number of steps without finalizing.');
};

export default {
  applyCodeChange
};

export const __testing = {
  normalizeRelativePath,
  normalizeHint,
  extractStyleTargetHints,
  ensureSafeRelativePath,
  truncateForObservation,
  stripCodeFences,
  extractFirstJsonObject,
  parseActionResponse,
  buildInitialUserMessage,
  queueAsyncWalk,
  buildFileTreeSnapshot,
  listDirectoryForAgent,
  readFileForAgent,
  writeFileForAgent,
  LoopDetector,
  deriveStyleScopeContract,
  writeMentionsTarget,
  validateStyleWriteScope
};
