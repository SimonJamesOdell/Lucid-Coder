import { applyCodeChange } from './codeEditAgent.js';
import { planGoalFromPrompt } from './agentOrchestrator.js';
import {
  createWorkingBranch,
  checkoutBranch,
  runTestsForBranch,
  commitBranchChanges,
  mergeBranch,
  rollbackBranchChanges
} from './branchWorkflow.js';
import { getProject } from '../database.js';
import { runGitCommand } from '../utils/git.js';
import {
  buildFailingTestsPrompt,
  buildImplementationPrompt,
  buildUserGuidanceFixPrompt,
  buildVerificationFixPrompt
} from './agentAutopilot/prompts.js';
import {
  extractFailingTestsFromWorkspaceRuns,
  splitLogsByStream,
  summarizeTestRunForPrompt,
  summarizeWorkspaceRunsForPayload
} from './agentAutopilot/runs.js';

const EDIT_DIFF_LIMIT = 25_000;

const DEFAULT_THRESHOLDS = Object.freeze({ lines: 100, statements: 100, functions: 100, branches: 100 });

const isConflictError = (error) => {
  const code = error?.statusCode;
  const message = String(error?.message || '');
  return code === 409 || /already exists/i.test(message);
};

const CANCELLED_ERROR_CODE = 'AUTOPILOT_CANCELLED';

const createCancelledError = () => {
  const error = new Error('Autopilot cancelled');
  error.code = CANCELLED_ERROR_CODE;
  return error;
};

const safeAppendEvent = (appendEvent, event) => {
  if (typeof appendEvent !== 'function') {
    return;
  }
  try {
    appendEvent(event);
  } catch {
    // Ignore timeline failures; autopilot behavior should continue.
  }
};


const extractEditPatchFiles = (steps) => {
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

const normalizeEditPatchPath = (value) => {
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

const defaultGetDiffForFiles = async ({ projectId, files } = {}) => {
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

const appendEditPatchEvent = async ({
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

const appendRunEvents = ({ appendEvent, phase, branchName, stepPrompt, run } = {}) => {
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

const appendRollbackEvents = async ({ appendEvent, rollback, projectId, branchName, stepPrompt, reason } = {}) => {
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

const updateToPrompt = (update) => {
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

const consumeUserUpdatesSafe = (consumeUserUpdates) => {
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

const consumeUpdatesAsPrompts = (consumeUserUpdates) => consumeUserUpdatesSafe(consumeUserUpdates)
  .map(updateToPrompt)
  .filter(Boolean);

const extractRollbackMessage = (update) => {
  if (!update || typeof update !== 'object') {
    return '';
  }
  const maybe = update.message ?? update.text ?? update.prompt;
  if (typeof maybe === 'string') {
    return maybe.trim();
  }
  return String(maybe ?? '').trim();
};

const isReplanUpdate = (update) =>
  update && typeof update === 'object' && (update.kind === 'goal-update' || update.kind === 'new-goal');

const drainUserUpdates = async ({
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

export const __testing = {
  consumeUpdatesAsPrompts,
  drainUserUpdates,
  extractRollbackMessage,
  summarizeTestRunForPrompt,
  splitLogsByStream,
  summarizeWorkspaceRunsForPayload,
  extractFailingTestsFromWorkspaceRuns,
  normalizeEditPatchPath,
  defaultGetDiffForFiles,
  extractEditPatchFiles,
  appendEditPatchEvent,
  appendRollbackEvents
};

const formatPlanSummary = ({ prompt, steps }) => {
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

__testing.formatPlanSummary = formatPlanSummary;

export const autopilotFeatureRequest = async ({ projectId, prompt, options = {}, deps = {} }) => {
  if (!projectId) {
    throw new Error('projectId is required');
  }
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('prompt is required');
  }

  const plan = deps.plan || planGoalFromPrompt;
  const edit = deps.edit || applyCodeChange;
  const createBranch = deps.createBranch || createWorkingBranch;
  const checkout = deps.checkout || checkoutBranch;
  const runTests = deps.runTests || runTestsForBranch;
  const commit = deps.commit || commitBranchChanges;
  const merge = deps.merge || mergeBranch;
  const rollback = typeof deps.rollback === 'function'
    ? deps.rollback
    : async ({ projectId: rollbackProjectId, branchName: rollbackBranchName } = {}) =>
        rollbackBranchChanges(rollbackProjectId, rollbackBranchName);
  const getDiffForFiles = deps.getDiffForFiles;
  const hasUserUpdateChannel = typeof deps.consumeUserUpdates === 'function';
  const consumeUserUpdates = hasUserUpdateChannel ? deps.consumeUserUpdates : () => [];
  const shouldCancel = typeof deps.shouldCancel === 'function' ? deps.shouldCancel : () => false;
  const shouldPause = typeof deps.shouldPause === 'function' ? deps.shouldPause : () => false;
  const reportStatus = typeof deps.reportStatus === 'function' ? deps.reportStatus : () => {};
  const waitForUserGuidance = deps.waitForUserGuidance === true;
  const ui = deps.ui && typeof deps.ui === 'object' ? deps.ui : null;
  const appendEvent = typeof deps.appendEvent === 'function' ? deps.appendEvent : null;

  const thresholds = {
    ...DEFAULT_THRESHOLDS,
    ...(options.coverageThresholds && typeof options.coverageThresholds === 'object' ? options.coverageThresholds : {})
  };

  const verificationFixRetriesRaw = options?.verificationFixRetries;
  const verificationFixRetries = Number.isFinite(verificationFixRetriesRaw)
    ? Math.max(0, Math.min(5, Math.floor(verificationFixRetriesRaw)))
    : 2;

  reportStatus('Planning goal…');
  const { parent, children } = await plan({ projectId, prompt });

  safeAppendEvent(appendEvent, {
    type: 'plan',
    message: 'Plan created',
    payload: {
      prompt,
      steps: Array.isArray(children) ? children.map((child) => child?.prompt).filter(Boolean) : [],
      summary: formatPlanSummary({
        prompt,
        steps: Array.isArray(children) ? children.map((child) => child?.prompt).filter(Boolean) : []
      })
    },
    meta: null
  });

  const branchName = parent?.branchName;
  if (!branchName) {
    throw new Error('Planned goal missing branch name');
  }

  try {
    reportStatus(`Creating branch ${branchName}…`);
    await createBranch(projectId, {
      name: branchName,
      description: `Autopilot: ${prompt}`,
      type: 'feature'
    });
  } catch (error) {
    if (!isConflictError(error)) {
      throw error;
    }
    reportStatus(`Branch ${branchName} already exists. Checking it out…`);
    await checkout(projectId, branchName);
  }

  const childList = Array.isArray(children) && children.length ? children : [{ prompt }];

  const queue = childList
    .map((child) => (typeof child?.prompt === 'string' ? child.prompt : String(child || '')))
    .map((childPrompt) => childPrompt.trim())
    .filter(Boolean);

  // Always append any early updates after branch creation, before starting work.
  const earlyUpdates = await drainUserUpdates({
    consumeUserUpdates,
    appendEvent,
    label: 'after branch creation',
    rollback,
    projectId,
    branchName
  });
  if (earlyUpdates?.replan) {
    reportStatus('Received goal update. Replanning…');

    const msg = earlyUpdates.replan.message.trim();
    const updateLabel = earlyUpdates.replan.kind === 'new-goal' ? 'New goal' : 'Goal update';
    const replannedPrompt = msg ? `${prompt}\n\n${updateLabel}:\n${msg}` : prompt;

    const replanned = await plan({ projectId, prompt: replannedPrompt });
    const replannedSteps = Array.isArray(replanned?.children)
      ? replanned.children.map((child) => child?.prompt).filter(Boolean)
      : [];

    queue.splice(0, queue.length, ...replannedSteps);

    safeAppendEvent(appendEvent, {
      type: 'plan',
      message: 'Plan replanned (after branch creation)',
      payload: { prompt: replannedPrompt, steps: replannedSteps, update: earlyUpdates.replan },
      meta: null
    });
  }
  if (earlyUpdates.length) {
    reportStatus('Applying user updates…');
    queue.push(...earlyUpdates);
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const waitWhilePaused = async (label) => {
    if (!shouldPause()) {
      return;
    }

    reportStatus('Paused. Waiting for resume…');
    safeAppendEvent(appendEvent, {
      type: 'lifecycle',
      message: 'Paused',
      payload: { label },
      meta: null
    });

    while (shouldPause()) {
      if (shouldCancel()) {
        throw createCancelledError();
      }

      // Allow non-control user updates (plan changes) to be recorded while paused.
      await drainUserUpdates({
        consumeUserUpdates,
        appendEvent,
        label: 'while paused',
        rollback,
        projectId,
        branchName
      });

      await wait(250);
    }

    reportStatus('Resuming…');
    safeAppendEvent(appendEvent, {
      type: 'lifecycle',
      message: 'Resumed',
      payload: { label },
      meta: null
    });
  };

  const awaitUserGuidance = async ({ reason, stepPrompt, latestRun } = {}) => {
    const guidanceHeader = 'Needs user input: tests/coverage still failing.';

    reportStatus(`${guidanceHeader} Please provide guidance to proceed.`);
    safeAppendEvent(appendEvent, {
      type: 'lifecycle',
      message: 'Needs user input',
        payload: {
          reason,
          prompt: stepPrompt,
          testRun: latestRun?.status ? { status: latestRun.status, summary: latestRun.summary ?? null } : null
        },
      meta: null
    });

    if (waitForUserGuidance) {
      while (true) {
        if (shouldCancel()) {
          throw createCancelledError();
        }

        const prompts = consumeUpdatesAsPrompts(consumeUserUpdates);
        if (prompts.length > 0) {
          safeAppendEvent(appendEvent, {
            type: 'lifecycle',
            message: 'User guidance received',
            payload: { prompt: stepPrompt },
            meta: null
          });
          return prompts[0];
        }

        await wait(250);
      }
    }

    if (shouldCancel()) {
      throw createCancelledError();
    }

    const prompts = consumeUpdatesAsPrompts(consumeUserUpdates);
    if (prompts.length > 0) {
      safeAppendEvent(appendEvent, {
        type: 'lifecycle',
        message: 'User guidance received',
        payload: { prompt: stepPrompt },
        meta: null
      });
      return prompts[0];
    }

    safeAppendEvent(appendEvent, {
      type: 'lifecycle',
      message: 'User guidance missing',
      payload: { prompt: stepPrompt },
      meta: null
    });

    return '';
  };

  const processQueue = async () => {
    let pendingReplan = null;

    const buildReplanPrompt = ({ basePrompt, update }) => {
      const base = basePrompt.trim();
      const msg = update.message.trim();
      const label = update.kind === 'new-goal' ? 'New goal' : 'Goal update';
      if (!msg) {
        return base;
      }
      return `${base}\n\n${label}:\n${msg}`;
    };

    const applyPendingReplan = async (reasonLabel) => {
      if (!pendingReplan) {
        return;
      }

      reportStatus('Replanning…');
      const replannedPrompt = buildReplanPrompt({ basePrompt: prompt, update: pendingReplan });
      const replanned = await plan({ projectId, prompt: replannedPrompt });

      const replannedSteps = Array.isArray(replanned?.children)
        ? replanned.children.map((child) => child?.prompt).filter(Boolean)
        : [];

      queue.splice(0, queue.length, ...replannedSteps);

      safeAppendEvent(appendEvent, {
        type: 'plan',
        message: `Plan replanned (${reasonLabel})`,
        payload: {
          prompt: replannedPrompt,
          steps: replannedSteps,
          update: pendingReplan
        },
        meta: null
      });

      pendingReplan = null;
    };

    while (queue.length > 0) {
      if (shouldCancel()) {
        throw createCancelledError();
      }

      await waitWhilePaused('before next step');

      // Safe boundary: before starting a new step.
      const preStepUpdates = await drainUserUpdates({
        consumeUserUpdates,
        appendEvent,
        label: 'before next step',
        rollback,
        projectId,
        branchName
      });

      if (preStepUpdates?.replan) {
        pendingReplan = preStepUpdates.replan;
      }
      if (preStepUpdates.length) {
        reportStatus('Received new instructions. Adjusting plan…');
        queue.push(...preStepUpdates);
      }

      // Safe boundary: before starting a new step.
      await applyPendingReplan('before next step');

      const childPrompt = queue.shift();

      const stepStartedAt = Date.now();

      safeAppendEvent(appendEvent, {
        type: 'step:start',
        message: 'Starting step',
        payload: { prompt: childPrompt, startedAt: stepStartedAt },
        meta: null
      });

      reportStatus('Writing failing tests…');

      if (ui?.navigateTab) {
        try {
          ui.navigateTab('files');
        } catch {
          // Ignore UI navigation failures.
        }
      }

      // 1) Write failing tests.
      const failingEditResult = await edit({ projectId, prompt: buildFailingTestsPrompt(childPrompt), ui });
      await appendEditPatchEvent({
        appendEvent,
        phase: 'tests',
        branchName,
        stepPrompt: childPrompt,
        editResult: failingEditResult,
        projectId,
        getDiffForFiles
      });

      // Safe boundary: after tests are written.
      const afterTestsUpdates = await drainUserUpdates({
        consumeUserUpdates,
        appendEvent,
        label: 'after tests',
        rollback,
        projectId,
        branchName
      });
      if (afterTestsUpdates?.replan) {
        pendingReplan = afterTestsUpdates.replan;
      }
      if (afterTestsUpdates.length) {
        reportStatus('Received new instructions. Adjusting plan…');
        queue.push(...afterTestsUpdates);
      }

      await waitWhilePaused('after tests');

      if (shouldCancel()) {
        throw createCancelledError();
      }

      await waitWhilePaused('before failing run');

      reportStatus('Running tests/coverage (expecting failure)…');

      if (ui?.navigateTab) {
        try {
          ui.navigateTab('tests');
        } catch {
          // Ignore UI navigation failures.
        }
      }
      const failingRun = await runTests(projectId, branchName, {
        real: true,
        coverageThresholds: thresholds
      });

      appendRunEvents({ appendEvent, phase: 'failing', branchName, stepPrompt: childPrompt, run: failingRun });

      if (failingRun?.status === 'passed') {
        await appendRollbackEvents({
          appendEvent,
          rollback,
          projectId,
          branchName,
          stepPrompt: childPrompt,
          reason: 'tdd_violation'
        });
        throw new Error('Autopilot expected failing tests, but tests passed. Refusing to proceed without a failing test run.');
      }

      if (shouldCancel()) {
        throw createCancelledError();
      }

      // Safe boundary: after the expected failing run.
      const afterFailingRunUpdates = await drainUserUpdates({
        consumeUserUpdates,
        appendEvent,
        label: 'after failing test run',
        rollback,
        projectId,
        branchName
      });
      if (afterFailingRunUpdates?.replan) {
        pendingReplan = afterFailingRunUpdates.replan;
      }
      if (afterFailingRunUpdates.length) {
        reportStatus('Received new instructions. Adjusting plan…');
        queue.push(...afterFailingRunUpdates);
      }

      await waitWhilePaused('after failing run');

      reportStatus('Implementing change…');
      // 2) Implement.
      const implementationEditResult = await edit({
        projectId,
        prompt: buildImplementationPrompt(childPrompt, summarizeTestRunForPrompt(failingRun)),
        ui
      });
      await appendEditPatchEvent({
        appendEvent,
        phase: 'implementation',
        branchName,
        stepPrompt: childPrompt,
        editResult: implementationEditResult,
        projectId,
        getDiffForFiles
      });

      // Safe boundary: after implementation edits.
      const afterImplementationUpdates = await drainUserUpdates({
        consumeUserUpdates,
        appendEvent,
        label: 'after implementation',
        rollback,
        projectId,
        branchName
      });
      if (afterImplementationUpdates?.replan) {
        pendingReplan = afterImplementationUpdates.replan;
      }
      if (afterImplementationUpdates.length) {
        reportStatus('Received new instructions. Adjusting plan…');
        queue.push(...afterImplementationUpdates);
      }

      await waitWhilePaused('after implementation');

      if (shouldCancel()) {
        throw createCancelledError();
      }

      // 3) Verify.
      reportStatus('Running tests/coverage…');

      if (ui?.navigateTab) {
        try {
          ui.navigateTab('tests');
        } catch {
          // Ignore UI navigation failures.
        }
      }
      const passingRun = await runTests(projectId, branchName, {
        real: true,
        coverageThresholds: thresholds
      });

      appendRunEvents({ appendEvent, phase: 'passing', branchName, stepPrompt: childPrompt, run: passingRun });

      let verifiedRun = passingRun;
      if (verifiedRun?.status !== 'passed') {
        let latestRun = verifiedRun;
        let passed = false;

        for (let attempt = 1; attempt <= verificationFixRetries; attempt += 1) {
          if (shouldCancel()) {
            throw createCancelledError();
          }

          reportStatus(`Tests/coverage failed. Attempting fix (${attempt}/${verificationFixRetries})…`);
          safeAppendEvent(appendEvent, {
            type: 'error',
            message: 'Verification failed; attempting auto-fix',
            payload: {
              projectId,
              branchName,
              prompt: childPrompt,
              attempt,
              maxAttempts: verificationFixRetries
            },
            meta: null
          });

          const fixEditResult = await edit({
            projectId,
            prompt: buildVerificationFixPrompt(childPrompt, summarizeTestRunForPrompt(latestRun), attempt, verificationFixRetries),
            ui
          });
          await appendEditPatchEvent({
            appendEvent,
            phase: 'verification-fix',
            branchName,
            stepPrompt: childPrompt,
            editResult: fixEditResult,
            projectId,
            getDiffForFiles
          });

          const afterFixUpdates = await drainUserUpdates({
            consumeUserUpdates,
            appendEvent,
            label: 'after verification fix',
            rollback,
            projectId,
            branchName
          });
          if (afterFixUpdates.length) {
            reportStatus('Received new instructions. Adjusting plan…');
            queue.push(...afterFixUpdates);
          }

          await waitWhilePaused('after verification fix');

          if (shouldCancel()) {
            throw createCancelledError();
          }

          reportStatus('Re-running tests/coverage…');
          const retryRun = await runTests(projectId, branchName, {
            real: true,
            coverageThresholds: thresholds
          });
          appendRunEvents({ appendEvent, phase: `verification-retry-${attempt}`, branchName, stepPrompt: childPrompt, run: retryRun });

          if (retryRun?.status === 'passed') {
            verifiedRun = retryRun;
            passed = true;
            break;
          }

          latestRun = retryRun;
        }

        if (!passed) {
          if (!hasUserUpdateChannel) {
            await appendRollbackEvents({
              appendEvent,
              rollback,
              projectId,
              branchName,
              stepPrompt: childPrompt,
              reason: 'verification_failed'
            });
            throw new Error('Autopilot implementation did not pass tests/coverage.');
          }

          // Auto-fixes are exhausted; request user guidance instead of hard failing.
          const maxGuidanceAttempts = 3;
          for (let guidanceAttempt = 1; guidanceAttempt <= maxGuidanceAttempts; guidanceAttempt += 1) {
            if (shouldCancel()) {
              throw createCancelledError();
            }

            await waitWhilePaused('needs user input');

            const guidance = await awaitUserGuidance({
              reason: 'verification_failed',
              stepPrompt: childPrompt,
              latestRun
            });

            if (!guidance) {
              break;
            }

            reportStatus(`Applying user guidance (${guidanceAttempt}/${maxGuidanceAttempts})…`);
            const guidedEditResult = await edit({
              projectId,
              prompt: buildUserGuidanceFixPrompt(childPrompt, summarizeTestRunForPrompt(latestRun), guidance),
              ui
            });
            await appendEditPatchEvent({
              appendEvent,
              phase: 'user-guidance',
              branchName,
              stepPrompt: childPrompt,
              editResult: guidedEditResult,
              projectId,
              getDiffForFiles
            });

            await waitWhilePaused('after user guidance');

            if (shouldCancel()) {
              throw createCancelledError();
            }

            reportStatus('Re-running tests/coverage…');
            const guidanceRun = await runTests(projectId, branchName, {
              real: true,
              coverageThresholds: thresholds
            });
            appendRunEvents({
              appendEvent,
              phase: `user-guidance-${guidanceAttempt}`,
              branchName,
              stepPrompt: childPrompt,
              run: guidanceRun
            });

            if (guidanceRun?.status === 'passed') {
              verifiedRun = guidanceRun;
              passed = true;
              break;
            }

            latestRun = guidanceRun;
            reportStatus('Guidance applied but tests still failing.');
          }

          if (!passed) {
            await appendRollbackEvents({
              appendEvent,
              rollback,
              projectId,
              branchName,
              stepPrompt: childPrompt,
              reason: 'verification_failed'
            });
            throw new Error('Autopilot implementation did not pass tests/coverage.');
          }
        }
      }

      const durationMs = Math.max(0, Date.now() - stepStartedAt);

      safeAppendEvent(appendEvent, {
        type: 'step:done',
        message: 'Step completed',
        payload: {
          prompt: childPrompt,
          status: 'passed',
          durationMs,
          artifacts: {
            failingRun: failingRun ? { status: failingRun.status ?? null, summary: failingRun.summary ?? null } : null,
            passingRun: { status: 'passed', summary: verifiedRun?.summary ?? null }
          }
        },
        meta: null
      });

      // If the user sends new instructions mid-run, treat them as additional child tasks.
      const updates = await drainUserUpdates({
        consumeUserUpdates,
        appendEvent,
        label: 'after step completion',
        rollback,
        projectId,
        branchName
      });
      if (updates?.replan) {
        pendingReplan = updates.replan;
      }
      if (updates.length) {
        reportStatus('Received new instructions. Adjusting plan…');
        queue.push(...updates);
      }

      // Safe boundary: after finishing a step.
      await applyPendingReplan('after step completion');

      await waitWhilePaused('after step completion');
    }
  };

  while (true) {
    await processQueue();

    if (shouldCancel()) {
      throw createCancelledError();
    }

    await waitWhilePaused('before commit');

    const beforeCommitUpdates = await drainUserUpdates({
      consumeUserUpdates,
      appendEvent,
      label: 'before commit',
      rollback,
      projectId,
      branchName
    });
    if (beforeCommitUpdates?.replan) {
      reportStatus('Received goal update. Adjusting plan…');
      const replannedPrompt = (() => {
        const msg = beforeCommitUpdates.replan.message.trim();
        const label = beforeCommitUpdates.replan.kind === 'new-goal' ? 'New goal' : 'Goal update';
        return msg ? `${prompt}\n\n${label}:\n${msg}` : prompt;
      })();

      const replanned = await plan({ projectId, prompt: replannedPrompt });
      const replannedSteps = Array.isArray(replanned?.children)
        ? replanned.children.map((child) => child?.prompt).filter(Boolean)
        : [];

      safeAppendEvent(appendEvent, {
        type: 'plan',
        message: 'Plan replanned (before commit)',
        payload: { prompt: replannedPrompt, steps: replannedSteps, update: beforeCommitUpdates.replan },
        meta: null
      });

      queue.push(...replannedSteps);
      continue;
    }
    if (beforeCommitUpdates.length) {
      reportStatus('Received new instructions. Adjusting plan…');
      queue.push(...beforeCommitUpdates);
      continue;
    }

    reportStatus('Committing changes…');

    if (ui?.navigateTab) {
      try {
        ui.navigateTab('commits');
      } catch {
        // Ignore UI navigation failures.
      }
    }

    const commitMessage = `feat(autopilot): ${prompt}`;
    const commitResult = await commit(projectId, branchName, {
      message: commitMessage
    });

    safeAppendEvent(appendEvent, {
      type: 'git:commit',
      message: 'Committed changes',
      payload: {
        branchName,
        message: commitMessage,
        commit: commitResult?.commit ?? null
      },
      meta: null
    });

    const beforeMergeUpdates = await drainUserUpdates({
      consumeUserUpdates,
      appendEvent,
      label: 'before merge',
      rollback,
      projectId,
      branchName
    });
    if (beforeMergeUpdates?.replan) {
      reportStatus('Received goal update. Adjusting plan…');
      const replannedPrompt = (() => {
        const msg = beforeMergeUpdates.replan.message.trim();
        const label = beforeMergeUpdates.replan.kind === 'new-goal' ? 'New goal' : 'Goal update';
        return msg ? `${prompt}\n\n${label}:\n${msg}` : prompt;
      })();

      const replanned = await plan({ projectId, prompt: replannedPrompt });
      const replannedSteps = Array.isArray(replanned?.children)
        ? replanned.children.map((child) => child?.prompt).filter(Boolean)
        : [];

      safeAppendEvent(appendEvent, {
        type: 'plan',
        message: 'Plan replanned (before merge)',
        payload: { prompt: replannedPrompt, steps: replannedSteps, update: beforeMergeUpdates.replan },
        meta: null
      });

      queue.push(...replannedSteps);
      continue;
    }
    if (beforeMergeUpdates.length) {
      reportStatus('Received new instructions. Adjusting plan…');
      queue.push(...beforeMergeUpdates);
      continue;
    }

    await waitWhilePaused('before merge');

    reportStatus('Merging to main…');

    if (ui?.navigateTab) {
      try {
        ui.navigateTab('commits');
      } catch {
        // Ignore UI navigation failures.
      }
    }

    const mergeResult = await merge(projectId, branchName);

    safeAppendEvent(appendEvent, {
      type: 'git:merge',
      message: 'Merged branch',
      payload: {
        mergedBranch: mergeResult?.mergedBranch ?? null,
        current: mergeResult?.current ?? null
      },
      meta: null
    });

    return {
      kind: 'feature',
      parent,
      children,
      branchName,
      merge: mergeResult
    };
  }
};

export default {
  autopilotFeatureRequest
};
