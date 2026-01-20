import { getProject } from '../../database.js';
import { runGitCommand } from '../../utils/git.js';
import {
  extractFailingTestsFromWorkspaceRuns,
  summarizeWorkspaceRunsForPayload
} from './runs.js';

export const EDIT_DIFF_LIMIT = 25_000;

export const DEFAULT_THRESHOLDS = Object.freeze({ lines: 100, statements: 100, functions: 100, branches: 100 });

export const CANCELLED_ERROR_CODE = 'AUTOPILOT_CANCELLED';

export const isConflictError = (error) => {
  const code = error?.statusCode;
  const message = String(error?.message || '');
  return code === 409 || /already exists/i.test(message);
};

export const createCancelledError = () => {
  const error = new Error('Autopilot cancelled');
  error.code = CANCELLED_ERROR_CODE;
  return error;
};

export const safeAppendEvent = (appendEvent, event) => {
  if (typeof appendEvent !== 'function') {
    return;
  }
  try {
    appendEvent(event);
  } catch {
    // Ignore timeline failures; autopilot behavior should continue.
  }
};

export const extractEditPatchFiles = (steps) => {
  if (!Array.isArray(steps) || steps.length === 0) {
    return [];
  }

  const files = new Map();

  for (const step of steps) {
    if (!step || typeof step !== 'object') {
      continue;
    }

    if (step.type === 'action' && step.action === 'write_file' && typeof step.target === 'string' && step.target.trim()) {
      const path = step.target.trim();
      if (!files.has(path)) {
        files.set(path, { path, chars: null });
      }
      continue;
    }

    if (step.type === 'observation' && step.action === 'write_file' && typeof step.target === 'string' && step.target.trim()) {
      const path = step.target.trim();
      const match = typeof step.summary === 'string' ? step.summary.match(/\bWrote\s+(\d+)\s+characters\b/i) : null;
      const chars = match ? Number(match[1]) : null;
      const existing = files.get(path);
      if (existing) {
        if (Number.isFinite(chars)) {
          existing.chars = chars;
        }
      } else {
        files.set(path, { path, chars: Number.isFinite(chars) ? chars : null });
      }
    }
  }

  return Array.from(files.values());
};

export const normalizeEditPatchPath = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.includes('..') || trimmed.startsWith('/') || /^[a-zA-Z]:\\/.test(trimmed)) {
    return null;
  }
  return trimmed;
};

export const defaultGetDiffForFiles = async ({ projectId, files } = {}) => {
  const normalizedFiles = Array.isArray(files)
    ? files
        .map((file) => normalizeEditPatchPath(file?.path))
        .filter(Boolean)
    : [];

  if (!projectId || normalizedFiles.length === 0) {
    return null;
  }

  const project = await getProject(projectId);
  const projectPath = project?.path;
  if (!projectPath) {
    return null;
  }

  const result = await runGitCommand(projectPath, ['diff', '--cached', '--', ...normalizedFiles], { allowFailure: true });
  const diffText = (result?.stdout || '').toString();
  if (!diffText.trim()) {
    return null;
  }
  return diffText;
};

export const appendEditPatchEvent = async ({
  appendEvent,
  phase,
  branchName,
  stepPrompt,
  editResult,
  projectId,
  getDiffForFiles
} = {}) => {
  const files = extractEditPatchFiles(editResult?.steps);
  if (files.length === 0) {
    return;
  }

  let diff = null;
  let diffTruncated = false;
  let diffOriginalChars = null;

  const diffFn = typeof getDiffForFiles === 'function' ? getDiffForFiles : defaultGetDiffForFiles;
  try {
    const rawDiff = await diffFn({ projectId, files });
    if (typeof rawDiff === 'string' && rawDiff.trim()) {
      diffOriginalChars = rawDiff.length;
      if (rawDiff.length > EDIT_DIFF_LIMIT) {
        diff = `${rawDiff.slice(0, EDIT_DIFF_LIMIT)}\n…diff truncated…`;
        diffTruncated = true;
      } else {
        diff = rawDiff;
      }
    }
  } catch {
    // Diff artifacts should never break the main autopilot loop.
  }

  safeAppendEvent(appendEvent, {
    type: 'edit:patch',
    message: 'Applied file edits',
    payload: {
      phase,
      branchName,
      prompt: stepPrompt,
      files,
      diff,
      diffTruncated,
      diffOriginalChars
    },
    meta: null
  });
};

export const appendRunEvents = ({ appendEvent, phase, branchName, stepPrompt, run } = {}) => {
  const workspaceRuns = Array.isArray(run?.workspaceRuns) ? run.workspaceRuns : [];
  const output = summarizeWorkspaceRunsForPayload(workspaceRuns);
  const failingTests = run?.status === 'failed' ? extractFailingTestsFromWorkspaceRuns(workspaceRuns) : [];

  safeAppendEvent(appendEvent, {
    type: 'test:run',
    message: 'Test run completed',
    payload: {
      phase,
      branchName,
      prompt: stepPrompt,
      status: run?.status ?? null,
      summary: run?.summary ?? null,
      output,
      failingTests
    },
    meta: null
  });

  const coverageGate = run?.summary?.coverage ?? null;
  safeAppendEvent(appendEvent, {
    type: 'coverage:run',
    message: 'Coverage evaluated',
    payload: {
      phase,
      branchName,
      prompt: stepPrompt,
      passed: Boolean(coverageGate?.passed),
      coverage: coverageGate
    },
    meta: null
  });
};

export const appendRollbackEvents = async ({ appendEvent, rollback, projectId, branchName, stepPrompt, reason } = {}) => {
  if (typeof rollback !== 'function') {
    return;
  }

  safeAppendEvent(appendEvent, {
    type: 'rollback:planned',
    message: 'Rollback planned',
    payload: {
      projectId,
      branchName,
      prompt: stepPrompt,
      reason
    },
    meta: null
  });

  let result = null;
  let errorMessage = null;

  try {
    result = await rollback({ projectId, branchName, prompt: stepPrompt, reason });
  } catch (error) {
    errorMessage = error ? String(error.message || error) : 'Unknown error';
  }

  safeAppendEvent(appendEvent, {
    type: 'rollback:applied',
    message: 'Rollback applied',
    payload: {
      projectId,
      branchName,
      prompt: stepPrompt,
      reason,
      ok: errorMessage ? false : true,
      result: errorMessage ? null : result,
      error: errorMessage
    },
    meta: null
  });

  safeAppendEvent(appendEvent, {
    type: 'rollback:complete',
    message: 'Rollback complete',
    payload: {
      projectId,
      branchName,
      prompt: stepPrompt,
      reason
    },
    meta: null
  });
};

export const updateToPrompt = (update) => {
  if (typeof update === 'string') {
    return update.trim();
  }
  if (update && typeof update === 'object') {
    if (
      update.kind === 'stop' ||
      update.kind === 'pause' ||
      update.kind === 'resume' ||
      update.kind === 'rollback' ||
      update.kind === 'goal-update' ||
      update.kind === 'new-goal'
    ) {
      return '';
    }
    const maybeMessage = update.message ?? update.text ?? update.prompt;
    if (typeof maybeMessage === 'string') {
      return maybeMessage.trim();
    }
    return String(maybeMessage ?? '').trim();
  }
  return String(update ?? '').trim();
};

export const consumeUserUpdatesSafe = (consumeUserUpdates) => {
  try {
    const updates = consumeUserUpdates();
    if (!Array.isArray(updates)) {
      return [];
    }
    return updates;
  } catch {
    return [];
  }
};

export const consumeUpdatesAsPrompts = (consumeUserUpdates) => consumeUserUpdatesSafe(consumeUserUpdates)
  .map(updateToPrompt)
  .filter(Boolean);

export const extractRollbackMessage = (update) => {
  if (!update || typeof update !== 'object') {
    return '';
  }
  const maybe = update.message ?? update.text ?? update.prompt;
  if (typeof maybe === 'string') {
    return maybe.trim();
  }
  return String(maybe ?? '').trim();
};

export const isReplanUpdate = (update) =>
  update && typeof update === 'object' && (update.kind === 'goal-update' || update.kind === 'new-goal');

export const drainUserUpdates = async ({
  consumeUserUpdates,
  appendEvent,
  label,
  rollback,
  projectId,
  branchName
} = {}) => {
  const rawUpdates = consumeUserUpdatesSafe(consumeUserUpdates);

  const rollbackUpdates = rawUpdates.filter((update) => update && typeof update === 'object' && update.kind === 'rollback');
  for (const update of rollbackUpdates) {
    await appendRollbackEvents({
      appendEvent,
      rollback,
      projectId,
      branchName,
      stepPrompt: extractRollbackMessage(update) || 'Rollback requested',
      reason: 'user_requested'
    });
  }

  const prompts = rawUpdates
    .map(updateToPrompt)
    .filter(Boolean);

  const replanCandidate = rawUpdates.filter(isReplanUpdate).slice(-1)[0];
  const replan = replanCandidate
    ? {
        kind: replanCandidate.kind,
        message: extractRollbackMessage(replanCandidate)
      }
    : null;

  if (prompts.length > 0) {
    safeAppendEvent(appendEvent, {
      type: 'plan',
      message: label ? `Plan updated (${label})` : 'Plan updated',
      payload: { addedPrompts: prompts },
      meta: null
    });
  }

  if (replan) {
    // Attach metadata without changing the return shape.
    prompts.replan = replan;
  }

  return prompts;
};

export const formatPlanSummary = ({ prompt, steps }) => {
  const goal = typeof prompt === 'string' ? prompt.trim() : '';
  const normalizedSteps = Array.isArray(steps)
    ? steps
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter(Boolean)
    : [];

  const title = goal ? `Plan for: ${goal}` : 'Plan';
  if (normalizedSteps.length === 0) {
    return title;
  }

  const lines = normalizedSteps.map((step, idx) => `${idx + 1}. ${step}`);
  return [title, ...lines].join('\n');
};
