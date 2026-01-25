import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../database.js', async () => {
  const actual = await vi.importActual('../database.js');
  return {
    ...actual,
    getProject: vi.fn()
  };
});

vi.mock('../utils/git.js', async () => {
  const actual = await vi.importActual('../utils/git.js');
  return {
    ...actual,
    runGitCommand: vi.fn()
  };
});

vi.mock('../services/branchWorkflow.js', () => ({
  createWorkingBranch: vi.fn(),
  checkoutBranch: vi.fn(),
  runTestsForBranch: vi.fn(),
  commitBranchChanges: vi.fn(),
  mergeBranch: vi.fn(),
  rollbackBranchChanges: vi.fn()
}));

import { autopilotFeatureRequest, __testing } from '../services/agentAutopilot.js';
import * as agentOrchestrator from '../services/agentOrchestrator.js';
import {
  createWorkingBranch,
  checkoutBranch,
  runTestsForBranch,
  commitBranchChanges,
  mergeBranch,
  rollbackBranchChanges
} from '../services/branchWorkflow.js';
import { getProject } from '../database.js';
import { runGitCommand } from '../utils/git.js';

const createEditResult = () => ({
  steps: [
    { type: 'action', action: 'write_file', target: 'src/app.js' },
    { type: 'observation', action: 'write_file', target: 'src/app.js', summary: 'Wrote 120 characters' }
  ]
});

const runResult = (status) => ({
  status,
  workspaceRuns: [],
  summary: { coverage: { passed: status === 'passed' }, status }
});

const createAppendEvent = () => {
  const events = [];
  const handler = vi.fn((event) => events.push(event));
  handler.events = events;
  return handler;
};

const createStackTargetedShouldCancel = (line) => {
  let triggered = false;
  return vi.fn(() => {
    const stack = new Error().stack || '';
    if (!triggered && stack.includes(`agentAutopilot.js:${line}`)) {
      triggered = true;
      return true;
    }
    return false;
  });
};

const defaultPlan = (childPrompts = ['Ship autopilot feature']) => ({
  parent: { branchName: 'feat/autopilot', id: 'parent-1' },
  children: childPrompts.map((prompt) => ({ prompt }))
});

describe('agentAutopilot helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('buildChangelogEntryFromPrompt returns trimmed first line', () => {
    const { buildChangelogEntryFromPrompt } = __testing;

    expect(buildChangelogEntryFromPrompt('  Ship autopilot  \nMore details')).toBe('Ship autopilot');
  });

  test('buildChangelogEntryFromPrompt falls back when first line is blank', () => {
    const { buildChangelogEntryFromPrompt } = __testing;

    expect(buildChangelogEntryFromPrompt('\nSecond line')).toBe('autopilot updates');
  });

  test('buildChangelogEntryFromPrompt falls back for non-string prompts', () => {
    const { buildChangelogEntryFromPrompt } = __testing;

    expect(buildChangelogEntryFromPrompt(null)).toBe('autopilot updates');
  });

  test('normalizeEditPatchPath filters unsafe entries', () => {
    const { normalizeEditPatchPath } = __testing;

    expect(normalizeEditPatchPath('src/utils/file.js')).toBe('src/utils/file.js');
    expect(normalizeEditPatchPath('../secrets.env')).toBeNull();
    expect(normalizeEditPatchPath('/etc/passwd')).toBeNull();
    expect(normalizeEditPatchPath('C:\\temp\\bad.txt')).toBeNull();
    expect(normalizeEditPatchPath('   ')).toBeNull();
  });

  test('normalizeEditPatchPath returns null for non-string values', () => {
    const { normalizeEditPatchPath } = __testing;

    expect(normalizeEditPatchPath(101)).toBeNull();
  });

  test('defaultGetDiffForFiles returns git diff for normalized paths', async () => {
    const { defaultGetDiffForFiles } = __testing;
    getProject.mockResolvedValue({ path: '/tmp/project' });
    runGitCommand.mockResolvedValue({ stdout: 'diff chunk' });

    const diff = await defaultGetDiffForFiles({
      projectId: 42,
      files: [{ path: 'src/app.js' }, { path: '../ignored.js' }]
    });

    expect(getProject).toHaveBeenCalledWith(42);
    expect(runGitCommand).toHaveBeenCalledWith(
      '/tmp/project',
      ['diff', '--cached', '--', 'src/app.js'],
      { allowFailure: true }
    );
    expect(diff).toBe('diff chunk');
  });

  test('defaultGetDiffForFiles returns null when git diff empty', async () => {
    const { defaultGetDiffForFiles } = __testing;
    getProject.mockResolvedValue({ path: '/tmp/project' });
    runGitCommand.mockResolvedValue({ stdout: '\n' });

    const diff = await defaultGetDiffForFiles({ projectId: 7, files: [{ path: 'src/app.js' }] });

    expect(diff).toBeNull();
  });

  test('defaultGetDiffForFiles returns null when no normalized files provided', async () => {
    const { defaultGetDiffForFiles } = __testing;
    runGitCommand.mockClear();
    getProject.mockClear();

    const diff = await defaultGetDiffForFiles({ projectId: 9, files: ['   '] });

    expect(diff).toBeNull();
    expect(getProject).not.toHaveBeenCalled();
    expect(runGitCommand).not.toHaveBeenCalled();
  });

  test('defaultGetDiffForFiles returns null when files is not an array', async () => {
    const { defaultGetDiffForFiles } = __testing;
    runGitCommand.mockClear();
    getProject.mockClear();

    const diff = await defaultGetDiffForFiles({ projectId: 10, files: null });

    expect(diff).toBeNull();
    expect(getProject).not.toHaveBeenCalled();
    expect(runGitCommand).not.toHaveBeenCalled();
  });

  test('defaultGetDiffForFiles returns null when project path missing', async () => {
    const { defaultGetDiffForFiles } = __testing;
    getProject.mockResolvedValue({});

    const diff = await defaultGetDiffForFiles({ projectId: 8, files: [{ path: 'src/app.js' }] });

    expect(diff).toBeNull();
    expect(runGitCommand).not.toHaveBeenCalled();
  });

  test('defaultGetDiffForFiles returns null when git diff stdout missing', async () => {
    const { defaultGetDiffForFiles } = __testing;
    getProject.mockResolvedValue({ path: '/tmp/project' });
    runGitCommand.mockResolvedValue({});

    const diff = await defaultGetDiffForFiles({ projectId: 11, files: [{ path: 'src/app.js' }] });

    expect(diff).toBeNull();
  });

  test('extractEditPatchFiles returns empty array for invalid steps', () => {
    const { extractEditPatchFiles } = __testing;

    expect(extractEditPatchFiles(undefined)).toEqual([]);
  });

  test('extractEditPatchFiles captures observation-only entries', () => {
    const { extractEditPatchFiles } = __testing;

    const files = extractEditPatchFiles([
      null,
      {
        type: 'observation',
        action: 'write_file',
        target: '  src/app.js  ',
        summary: 'Wrote 55 characters'
      }
    ]);

    expect(files).toEqual([{ path: 'src/app.js', chars: 55 }]);
  });

  test('extractEditPatchFiles updates existing action entries with chars', () => {
    const { extractEditPatchFiles } = __testing;

    const files = extractEditPatchFiles([
      { type: 'action', action: 'write_file', target: 'src/app.js' },
      { type: 'observation', action: 'write_file', target: 'src/app.js', summary: 'Wrote 12 characters' }
    ]);

    expect(files).toEqual([{ path: 'src/app.js', chars: 12 }]);
  });

  test('extractEditPatchFiles handles non-string summaries', () => {
    const { extractEditPatchFiles } = __testing;

    const files = extractEditPatchFiles([
      { type: 'observation', action: 'write_file', target: 'src/app.js', summary: 123 }
    ]);

    expect(files).toEqual([{ path: 'src/app.js', chars: null }]);
  });

  test('extractEditPatchFiles ignores duplicate action entries', () => {
    const { extractEditPatchFiles } = __testing;

    const files = extractEditPatchFiles([
      { type: 'action', action: 'write_file', target: 'src/app.js' },
      { type: 'action', action: 'write_file', target: 'src/app.js' }
    ]);

    expect(files).toEqual([{ path: 'src/app.js', chars: null }]);
  });

  test('extractEditPatchFiles ignores non-matching observation steps', () => {
    const { extractEditPatchFiles } = __testing;

    const files = extractEditPatchFiles([
      { type: 'observation', action: 'read_file', target: 'src/app.js' },
      { type: 'observation', action: 'write_file', target: '   ' }
    ]);

    expect(files).toEqual([]);
  });

  test('extractEditPatchFiles keeps existing chars when summary missing', () => {
    const { extractEditPatchFiles } = __testing;

    const files = extractEditPatchFiles([
      { type: 'action', action: 'write_file', target: 'src/app.js' },
      { type: 'observation', action: 'write_file', target: 'src/app.js', summary: null }
    ]);

    expect(files).toEqual([{ path: 'src/app.js', chars: null }]);
  });

  test('appendEditPatchEvent returns early when no files changed', async () => {
    const { appendEditPatchEvent } = __testing;
    const appendEvent = createAppendEvent();
    const getDiffForFiles = vi.fn();

    await appendEditPatchEvent({ appendEvent, editResult: { steps: [] }, getDiffForFiles });

    expect(appendEvent).not.toHaveBeenCalled();
    expect(getDiffForFiles).not.toHaveBeenCalled();
  });

  test('appendRollbackEvents no-ops when rollback helper missing', async () => {
    const { appendRollbackEvents } = __testing;
    const appendEvent = createAppendEvent();

    await appendRollbackEvents({ appendEvent, projectId: 1, branchName: 'feat/noop' });

    expect(appendEvent).not.toHaveBeenCalled();
  });

  test('appendRollbackEvents captures non-error rollback failures', async () => {
    const { appendRollbackEvents } = __testing;
    const appendEvent = createAppendEvent();
    const rollback = vi.fn().mockRejectedValue({ code: 'boom' });

    await appendRollbackEvents({
      appendEvent,
      rollback,
      projectId: 2,
      branchName: 'feat/rollback',
      stepPrompt: 'Step',
      reason: 'verification_failed'
    });

    const appliedEvent = appendEvent.events.find((event) => event.type === 'rollback:applied');
    expect(appliedEvent.payload.ok).toBe(false);
    expect(appliedEvent.payload.error).toBe('[object Object]');
  });

  test('appendRollbackEvents uses unknown error fallback when rollback throws null', async () => {
    const { appendRollbackEvents } = __testing;
    const appendEvent = createAppendEvent();
    const rollback = vi.fn().mockRejectedValue(null);

    await appendRollbackEvents({
      appendEvent,
      rollback,
      projectId: 3,
      branchName: 'feat/rollback-null',
      stepPrompt: 'Step',
      reason: 'verification_failed'
    });

    const appliedEvent = appendEvent.events.find((event) => event.type === 'rollback:applied');
    expect(appliedEvent.payload.ok).toBe(false);
    expect(appliedEvent.payload.error).toBe('Unknown error');
  });

  test('consumeUpdatesAsPrompts trims updates and drops control events', () => {
    const { consumeUpdatesAsPrompts } = __testing;
    const updates = [
      '  build UI ',
      { message: 'Refine tests ' },
      { kind: 'pause', message: 'ignored' },
      { text: 'Ship docs' },
      { message: 404 },
      42
    ];

    const prompts = consumeUpdatesAsPrompts(() => updates);

    expect(prompts).toEqual(['build UI', 'Refine tests', 'Ship docs', '404', '42']);
  });

  test('consumeUpdatesAsPrompts returns empty array when updates are not an array', () => {
    const { consumeUpdatesAsPrompts } = __testing;

    const prompts = consumeUpdatesAsPrompts(() => 'not-list');

    expect(prompts).toEqual([]);
  });

  test('consumeUpdatesAsPrompts ignores errors from update channel', () => {
    const { consumeUpdatesAsPrompts } = __testing;

    const prompts = consumeUpdatesAsPrompts(() => {
      throw new Error('boom');
    });

    expect(prompts).toEqual([]);
  });

  test('consumeUpdatesAsPrompts drops updates with no prompt fields', () => {
    const { consumeUpdatesAsPrompts } = __testing;

    const prompts = consumeUpdatesAsPrompts(() => [{ kind: 'note' }, null]);

    expect(prompts).toEqual([]);
  });

  test('drainUserUpdates handles rollbacks and replans', async () => {
    const { drainUserUpdates } = __testing;
    const appendEvent = createAppendEvent();
    const rollback = vi.fn().mockResolvedValue({ ok: true });
    const consumeUserUpdates = () => [
      '  add tests ',
      { message: 'Update docs' },
      { kind: 'rollback', message: 'Undo change' },
      { kind: 'goal-update', message: 'New info' }
    ];

    const prompts = await drainUserUpdates({
      consumeUserUpdates,
      appendEvent,
      label: 'unit-test',
      rollback,
      projectId: 5,
      branchName: 'feat/autopilot'
    });

    expect([...prompts]).toEqual(['add tests', 'Update docs']);
    expect(prompts.replan).toEqual({ kind: 'goal-update', message: 'New info' });
    expect(rollback).toHaveBeenCalledWith({
      projectId: 5,
      branchName: 'feat/autopilot',
      prompt: 'Undo change',
      reason: 'user_requested'
    });
    const eventTypes = appendEvent.events.map((event) => event.type);
    expect(eventTypes).toContain('rollback:planned');
    expect(eventTypes).toContain('plan');
  });

  test('drainUserUpdates reports rollback errors', async () => {
    const { drainUserUpdates } = __testing;
    const appendEvent = createAppendEvent();
    const rollback = vi.fn().mockRejectedValue(new Error('rollback failed'));
    const consumeUserUpdates = () => [{ kind: 'rollback', message: 'Undo it' }];

    const prompts = await drainUserUpdates({
      consumeUserUpdates,
      appendEvent,
      label: 'unit-test',
      rollback,
      projectId: 6,
      branchName: 'feat/autopilot'
    });

    expect(prompts).toEqual([]);
    const appliedEvent = appendEvent.events.find((event) => event.type === 'rollback:applied');
    expect(appliedEvent.payload.ok).toBe(false);
    expect(appliedEvent.payload.error).toContain('rollback failed');
  });

  test('drainUserUpdates uses fallback message for rollback', async () => {
    const { drainUserUpdates } = __testing;
    const appendEvent = createAppendEvent();
    const rollback = vi.fn().mockResolvedValue({ ok: true });
    const consumeUserUpdates = () => [{ kind: 'rollback', message: '   ' }];

    const prompts = await drainUserUpdates({
      consumeUserUpdates,
      appendEvent,
      label: 'unit-test',
      rollback,
      projectId: 9,
      branchName: 'feat/autopilot'
    });

    expect(prompts).toEqual([]);
    expect(rollback).toHaveBeenCalledWith({
      projectId: 9,
      branchName: 'feat/autopilot',
      prompt: 'Rollback requested',
      reason: 'user_requested'
    });
  });

  test('extractRollbackMessage handles invalid updates', () => {
    const { extractRollbackMessage } = __testing;

    expect(extractRollbackMessage(null)).toBe('');
    expect(extractRollbackMessage({ message: 123 })).toBe('123');
  });

  test('extractRollbackMessage handles missing fields', () => {
    const { extractRollbackMessage } = __testing;

    expect(extractRollbackMessage({ foo: 'bar' })).toBe('');
  });

  test('extractRollbackMessage prefers text and prompt fields', () => {
    const { extractRollbackMessage } = __testing;

    expect(extractRollbackMessage({ text: '  Use text ' })).toBe('Use text');
    expect(extractRollbackMessage({ prompt: '  Use prompt ' })).toBe('Use prompt');
  });

  test('formatPlanSummary builds readable summary', () => {
    const { formatPlanSummary } = __testing;

    expect(formatPlanSummary({ prompt: 'Ship autopilot', steps: [] })).toBe('Plan for: Ship autopilot');
    expect(
      formatPlanSummary({ prompt: 'Ship autopilot', steps: [' Write failing tests ', 'Implement feature'] })
    ).toBe(['Plan for: Ship autopilot', '1. Write failing tests', '2. Implement feature'].join('\n'));
  });

  test('formatPlanSummary returns Plan when prompt blank and no steps', () => {
    const { formatPlanSummary } = __testing;

    expect(formatPlanSummary({ prompt: '   ', steps: ['  ', null] })).toBe('Plan');
  });

  test('formatPlanSummary handles non-string prompt values', () => {
    const { formatPlanSummary } = __testing;

    expect(formatPlanSummary({ prompt: 42, steps: [] })).toBe('Plan');
  });

  test('formatPlanSummary handles non-array steps', () => {
    const { formatPlanSummary } = __testing;

    expect(formatPlanSummary({ prompt: 'Ship', steps: null })).toBe('Plan for: Ship');
  });

  test('consumeUpdatesAsPrompts uses prompt fields', () => {
    const { consumeUpdatesAsPrompts } = __testing;

    const prompts = consumeUpdatesAsPrompts(() => [{ prompt: '  Ship docs ' }, { prompt: 404 }]);

    expect(prompts).toEqual(['Ship docs', '404']);
  });

  test('drainUserUpdates reports plan update without label', async () => {
    const { drainUserUpdates } = __testing;
    const appendEvent = createAppendEvent();
    const rollback = vi.fn();
    const consumeUserUpdates = () => ['Add docs', { kind: 'goal-update', message: 'Extra info' }];

    const prompts = await drainUserUpdates({
      consumeUserUpdates,
      appendEvent,
      rollback,
      projectId: 8,
      branchName: 'feat/autopilot'
    });

    expect([...prompts]).toEqual(['Add docs']);
    const planEvent = appendEvent.events.find((event) => event.type === 'plan');
    expect(planEvent.message).toBe('Plan updated');
  });
});

describe('autopilotFeatureRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('throws when projectId missing', async () => {
    await expect(autopilotFeatureRequest({ projectId: null, prompt: 'Needs project' })).rejects.toThrow(
      'projectId is required'
    );
  });

  test('throws when prompt missing', async () => {
    await expect(autopilotFeatureRequest({ projectId: 1, prompt: '' })).rejects.toThrow('prompt is required');
  });

  test('throws when plan response omits branch name', async () => {
    const plan = vi.fn().mockResolvedValue({ parent: { id: 'parent-only' }, children: [] });

    await expect(
      autopilotFeatureRequest({ projectId: 2, prompt: 'Missing branch', deps: { plan } })
    ).rejects.toThrow('Planned goal missing branch name');
  });

  test('uses default planner when deps.plan is missing', async () => {
    const planner = vi.spyOn(agentOrchestrator, 'planGoalFromPrompt');
    planner.mockResolvedValue(defaultPlan(['Default planned step']));

    const runQueue = [runResult('failed'), runResult('passed')];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));

    const deps = {
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'default-plan' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates: vi.fn(() => []),
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent: createAppendEvent()
    };

    const result = await autopilotFeatureRequest({ projectId: 3, prompt: 'Default planner', deps });

    expect(result.merge).toEqual({ mergedBranch: 'main', current: 'main' });
    expect(planner).toHaveBeenCalled();
    planner.mockRestore();
  });

  test('continues when appendEvent throws', async () => {
    const plan = vi.fn().mockResolvedValue(defaultPlan());
    const runQueue = [runResult('failed'), runResult('passed')];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'append-throws' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates: vi.fn(() => []),
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent: vi.fn(() => {
        throw new Error('append failed');
      })
    };

    const result = await autopilotFeatureRequest({ projectId: 6, prompt: 'Append event error', deps });

    expect(result.merge).toEqual({ mergedBranch: 'main', current: 'main' });
  });

  test('continues when appendEvent is not a function', async () => {
    const plan = vi.fn().mockResolvedValue(defaultPlan());
    const runQueue = [runResult('failed'), runResult('passed')];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'append-none' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates: vi.fn(() => []),
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent: 'not-a-function'
    };

    const result = await autopilotFeatureRequest({ projectId: 7, prompt: 'Append event missing', deps });

    expect(result.merge).toEqual({ mergedBranch: 'main', current: 'main' });
  });

  test('executes happy path and merges branch', async () => {
    vi.useFakeTimers();
    const appendEvent = createAppendEvent();
    const plan = vi.fn().mockResolvedValue(defaultPlan());
    const getDiffForFiles = vi
      .fn()
      .mockResolvedValueOnce('x'.repeat(26_000))
      .mockResolvedValue('diff ok');
    const runTests = vi
      .fn()
      .mockResolvedValueOnce(runResult('failed'))
      .mockResolvedValue(runResult('passed'));
    let pauseCallCount = 0;
    const shouldPause = vi.fn(() => {
      pauseCallCount += 1;
      return pauseCallCount <= 2;
    });

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'abc123' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates: vi.fn(() => []),
      shouldCancel: vi.fn(() => false),
      shouldPause,
      reportStatus: vi.fn(),
      getDiffForFiles,
      appendEvent
    };

    let result;
    try {
      const autopilotPromise = autopilotFeatureRequest({ projectId: 11, prompt: 'Ship autopilot', deps });
      await vi.advanceTimersByTimeAsync(250);
      result = await autopilotPromise;
    } finally {
      vi.useRealTimers();
    }

    expect(result).toEqual({
      kind: 'feature',
      parent: expect.objectContaining({ branchName: 'feat/autopilot' }),
      children: [{ prompt: 'Ship autopilot feature' }],
      branchName: 'feat/autopilot',
      merge: { mergedBranch: 'main', current: 'main' }
    });
    expect(deps.createBranch).toHaveBeenCalledWith(11, expect.objectContaining({ name: 'feat/autopilot' }));
    expect(runTests).toHaveBeenCalledTimes(2);
    const lifecycleEvents = appendEvent.events.filter((event) => event.type === 'lifecycle');
    expect(lifecycleEvents.some((event) => event.message === 'Paused')).toBe(true);
    const editEvents = appendEvent.events.filter((event) => event.type === 'edit:patch');
    expect(editEvents[0].payload.diffTruncated).toBe(true);
  });

  test('uses default workflow dependencies when omitted', async () => {
    const plan = vi.fn().mockResolvedValue(defaultPlan(['Default step']));
    const runQueue = [runResult('failed'), runResult('passed')];
    runTestsForBranch.mockImplementation(() => Promise.resolve(runQueue.shift()));
    commitBranchChanges.mockResolvedValue({ commit: { sha: 'default-deps' } });
    mergeBranch.mockResolvedValue({ mergedBranch: 'main', current: 'main' });
    createWorkingBranch.mockResolvedValue({});
    checkoutBranch.mockResolvedValue({});

    const result = await autopilotFeatureRequest({
      projectId: 15,
      prompt: 'Use defaults',
      deps: {
        plan,
        edit: vi.fn().mockResolvedValue(createEditResult())
      }
    });

    expect(result.merge).toEqual({ mergedBranch: 'main', current: 'main' });
    expect(runTestsForBranch).toHaveBeenCalledTimes(2);
    expect(commitBranchChanges).toHaveBeenCalled();
  });

  test('uses custom coverage thresholds when provided', async () => {
    const plan = vi.fn().mockResolvedValue(defaultPlan(['Coverage step']));
    const runQueue = [runResult('failed'), runResult('passed')];
    let capturedThresholds;
    const runTests = vi.fn((projectId, branchName, options) => {
      capturedThresholds = options.coverageThresholds;
      return Promise.resolve(runQueue.shift());
    });

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'thresholds' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates: vi.fn(() => []),
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent: createAppendEvent()
    };

    const result = await autopilotFeatureRequest({
      projectId: 16,
      prompt: 'Coverage overrides',
      deps,
      options: { coverageThresholds: { lines: 90, branches: 85 } }
    });

    expect(result.merge).toEqual({ mergedBranch: 'main', current: 'main' });
    expect(capturedThresholds.lines).toBe(90);
    expect(capturedThresholds.branches).toBe(85);
  });

  test('normalizes non-string child prompts in the queue', async () => {
    const plan = vi.fn().mockResolvedValue({
      parent: { branchName: 'feat/autopilot' },
      children: [42, { prompt: 'Ship feature' }]
    });
    const runQueue = [runResult('failed'), runResult('passed'), runResult('failed'), runResult('passed')];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));
    const appendEvent = createAppendEvent();

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'queue' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates: vi.fn(() => []),
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    const result = await autopilotFeatureRequest({ projectId: 17, prompt: 'Queue prompts', deps });

    expect(result.merge).toEqual({ mergedBranch: 'main', current: 'main' });
    const stepStarts = appendEvent.events.filter((event) => event.type === 'step:start');
    expect(stepStarts.map((event) => event.payload.prompt)).toEqual(['42', 'Ship feature']);
  });

  test('drops empty child entries when prompt is missing', async () => {
    const plan = vi.fn().mockResolvedValue({
      parent: { branchName: 'feat/autopilot' },
      children: [null, { prompt: 'Ship feature' }]
    });
    const runQueue = [runResult('failed'), runResult('passed')];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));
    const appendEvent = createAppendEvent();

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'queue-empty' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates: vi.fn(() => []),
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    const result = await autopilotFeatureRequest({ projectId: 18, prompt: 'Drop empty child', deps });

    expect(result.merge).toEqual({ mergedBranch: 'main', current: 'main' });
    const stepStarts = appendEvent.events.filter((event) => event.type === 'step:start');
    expect(stepStarts.map((event) => event.payload.prompt)).toEqual(['Ship feature']);
  });

  test('runs without update channel or status callbacks', async () => {
    const plan = vi.fn().mockResolvedValue(defaultPlan(['Minimal step']));
    const runQueue = [runResult('failed'), runResult('passed')];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'minimal' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' })
    };

    const result = await autopilotFeatureRequest({ projectId: 14, prompt: 'Default handlers', deps });

    expect(result.merge).toEqual({ mergedBranch: 'main', current: 'main' });
    expect(runTests).toHaveBeenCalledTimes(2);
  });

  test('falls back to prompt when plan returns no children', async () => {
    const plan = vi.fn().mockResolvedValue({ parent: { branchName: 'feat/fallback' }, children: [] });
    const runQueue = [runResult('failed'), runResult('passed')];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'fallback' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates: vi.fn(() => []),
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent: createAppendEvent()
    };

    const result = await autopilotFeatureRequest({ projectId: 22, prompt: 'Fallback plan', deps });

    expect(result.branchName).toBe('feat/fallback');
    expect(runTests).toHaveBeenCalledTimes(2);
    expect(plan).toHaveBeenCalledTimes(1);
  });

  test('falls back to prompt when plan children are null', async () => {
    const plan = vi.fn().mockResolvedValue({ parent: { branchName: 'feat/autopilot' }, children: null });
    const runQueue = [runResult('failed'), runResult('passed')];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));
    const appendEvent = createAppendEvent();

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'null-children' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates: vi.fn(() => []),
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    const result = await autopilotFeatureRequest({ projectId: 31, prompt: 'Null children', deps });

    expect(result.merge).toEqual({ mergedBranch: 'main', current: 'main' });
    const stepStart = appendEvent.events.find((event) => event.type === 'step:start');
    expect(stepStart.payload.prompt).toBe('Null children');
  });

  test('replans from new goal updates immediately after branch creation', async () => {
    const planQueue = [
      {
        parent: { branchName: 'feat/autopilot' },
        children: [{ prompt: 'Initial plan step' }]
      },
      {
        parent: { branchName: 'feat/autopilot' },
        children: [{ prompt: 'New goal step' }]
      }
    ];
    const plan = vi.fn(() => {
      const next = planQueue.shift();
      if (!next) {
        return { parent: { branchName: 'feat/autopilot' }, children: [] };
      }
      return next;
    });

    const scriptedUpdates = new Map([[1, [{ kind: 'new-goal', message: 'Expand scope' }]]]);
    let updateCall = 0;
    const consumeUserUpdates = vi.fn(() => scriptedUpdates.get(++updateCall) ?? []);

    const runQueue = [runResult('failed'), runResult('passed'), runResult('failed'), runResult('passed')];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'new-goal' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates,
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent: createAppendEvent()
    };

    const result = await autopilotFeatureRequest({ projectId: 23, prompt: 'New goal request', deps });

    expect(result.merge).toEqual({ mergedBranch: 'main', current: 'main' });
    expect(plan).toHaveBeenCalledTimes(2);
    expect(plan.mock.calls[1][0].prompt).toContain('New goal');
  });

  test('replans after branch creation with blank update message', async () => {
    const planQueue = [
      defaultPlan(['Initial step']),
      { parent: { branchName: 'feat/autopilot' }, children: [{ prompt: 'Replanned step' }] }
    ];
    const plan = vi.fn(({ prompt }) => {
      const next = planQueue.shift();
      if (!next) {
        return { parent: { branchName: 'feat/autopilot' }, children: [] };
      }
      next.promptUsed = prompt;
      return next;
    });

    const scriptedUpdates = new Map([[1, [{ kind: 'goal-update', message: '   ' }]]]);
    let updateCall = 0;
    const consumeUserUpdates = vi.fn(() => scriptedUpdates.get(++updateCall) ?? []);

    const runQueue = [runResult('failed'), runResult('passed')];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'early-blank' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates,
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent: createAppendEvent()
    };

    const result = await autopilotFeatureRequest({ projectId: 24, prompt: 'Blank update', deps });

    expect(result.merge).toEqual({ mergedBranch: 'main', current: 'main' });
    expect(plan).toHaveBeenCalledTimes(2);
    expect(plan.mock.calls[1][0].prompt).toBe('Blank update');
  });

  test('replans after branch creation with non-array steps', async () => {
    const plan = vi.fn(() => {
      if (plan.mock.calls.length > 0) {
        return { parent: { branchName: 'feat/autopilot' }, children: null };
      }
      return defaultPlan(['Initial step']);
    });

    const scriptedUpdates = new Map([[1, [{ kind: 'new-goal', message: 'Refine early plan' }]]]);
    let updateCall = 0;
    const consumeUserUpdates = vi.fn(() => scriptedUpdates.get(++updateCall) ?? []);

    const runQueue = [runResult('failed'), runResult('passed')];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));
    const appendEvent = createAppendEvent();

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'early-non-array' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates,
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    const result = await autopilotFeatureRequest({ projectId: 25, prompt: 'Early non-array', deps });

    expect(result.merge).toEqual({ mergedBranch: 'main', current: 'main' });
    const replanEvent = appendEvent.events.find(
      (event) => event.type === 'plan' && event.message?.includes('after branch creation')
    );
    expect(replanEvent.payload.steps).toEqual([]);
  });

  test('checks out branch when creation conflicts with existing branch', async () => {
    const appendEvent = createAppendEvent();
    const plan = vi.fn().mockResolvedValue(defaultPlan());
    const conflictError = Object.assign(new Error('exists'), { statusCode: 409 });
    const createBranch = vi.fn().mockRejectedValue(conflictError);
    const checkout = vi.fn().mockResolvedValue();
    const runQueue = [runResult('failed'), runResult('passed')];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch,
      checkout,
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'conflict1' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates: vi.fn(() => []),
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    const result = await autopilotFeatureRequest({ projectId: 30, prompt: 'Handle conflicts', deps });

    expect(result.branchName).toBe('feat/autopilot');
    expect(checkout).toHaveBeenCalledWith(30, 'feat/autopilot');
  });

  test('checks out branch when conflict message indicates existing branch', async () => {
    const appendEvent = createAppendEvent();
    const plan = vi.fn().mockResolvedValue(defaultPlan());
    const conflictError = new Error('Branch already exists');
    const createBranch = vi.fn().mockRejectedValue(conflictError);
    const checkout = vi.fn().mockResolvedValue();
    const runQueue = [runResult('failed'), runResult('passed')];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch,
      checkout,
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'conflict-msg' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates: vi.fn(() => []),
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    const result = await autopilotFeatureRequest({ projectId: 31, prompt: 'Conflict message', deps });

    expect(result.branchName).toBe('feat/autopilot');
    expect(checkout).toHaveBeenCalledWith(31, 'feat/autopilot');
  });

  test('propagates non-conflict branch creation errors', async () => {
    const appendEvent = createAppendEvent();
    const plan = vi.fn().mockResolvedValue(defaultPlan());
    const createBranch = vi.fn().mockRejectedValue(new Error('infra down'));

    await expect(
      autopilotFeatureRequest({
        projectId: 31,
        prompt: 'Handle branch failure',
        deps: {
          plan,
          edit: vi.fn(),
          createBranch,
          checkout: vi.fn(),
          runTests: vi.fn(),
          commit: vi.fn(),
          merge: vi.fn(),
          rollback: vi.fn(),
          consumeUserUpdates: vi.fn(() => []),
          shouldCancel: vi.fn(() => false),
          shouldPause: vi.fn(() => false),
          reportStatus: vi.fn(),
          getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
          appendEvent
        }
      })
    ).rejects.toThrow('infra down');
  });

  test('propagates branch creation errors without a message', async () => {
    const appendEvent = createAppendEvent();
    const plan = vi.fn().mockResolvedValue(defaultPlan());
    const error = { statusCode: 500 };
    const createBranch = vi.fn().mockRejectedValue(error);

    await expect(
      autopilotFeatureRequest({
        projectId: 32,
        prompt: 'Branch error no message',
        deps: {
          plan,
          edit: vi.fn(),
          createBranch,
          checkout: vi.fn(),
          runTests: vi.fn(),
          commit: vi.fn(),
          merge: vi.fn(),
          rollback: vi.fn(),
          consumeUserUpdates: vi.fn(() => []),
          shouldCancel: vi.fn(() => false),
          shouldPause: vi.fn(() => false),
          reportStatus: vi.fn(),
          getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
          appendEvent
        }
      })
    ).rejects.toBe(error);
  });

  test('falls back when project path missing for default git diff', async () => {
    const appendEvent = createAppendEvent();
    const plan = vi.fn().mockResolvedValue(defaultPlan());
    getProject.mockResolvedValue({});
    runGitCommand.mockClear();

    const runQueue = [runResult('failed'), runResult('passed')];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'missing-path' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates: vi.fn(() => []),
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      appendEvent
    };

    const result = await autopilotFeatureRequest({ projectId: 32, prompt: 'Diff fallback', deps });

    expect(result.branchName).toBe('feat/autopilot');
    expect(runGitCommand).not.toHaveBeenCalled();
    const patchEvent = appendEvent.events.find((event) => event.type === 'edit:patch');
    expect(patchEvent?.payload?.diff).toBeNull();
  });

  test('applies verification retries and user guidance before succeeding', async () => {
    const appendEvent = createAppendEvent();
    const plan = vi.fn().mockResolvedValue(defaultPlan());
    const runQueue = [
      runResult('failed'),
      runResult('failed'),
      runResult('failed'),
      runResult('failed'),
      runResult('passed')
    ];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));
    const guidanceState = { awaiting: false, provided: false };
    const reportStatus = vi.fn((message) => {
      if (message.includes('Needs user input')) {
        guidanceState.awaiting = true;
      }
    });
    const consumeUserUpdates = vi.fn(() => {
      if (guidanceState.awaiting && !guidanceState.provided) {
        guidanceState.provided = true;
        guidanceState.awaiting = false;
        return [{ message: 'Apply manual fix' }];
      }
      return [];
    });

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'def456' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates,
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus,
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    const result = await autopilotFeatureRequest({
      projectId: 13,
      prompt: 'Handle verification failures',
      deps,
      options: { verificationFixRetries: 2 }
    });

    expect(result.branchName).toBe('feat/autopilot');
    expect(runTests).toHaveBeenCalledTimes(5);
    expect(consumeUserUpdates).toHaveBeenCalled();
    const guidanceRuns = appendEvent.events.filter(
      (event) => event.type === 'test:run' && event.payload.phase.startsWith('user-guidance')
    );
    expect(guidanceRuns).toHaveLength(1);
  });

  test('cancels during user guidance when cancellation is requested', async () => {
    const appendEvent = createAppendEvent();
    const plan = vi.fn().mockResolvedValue(defaultPlan());
    let allowCancel = false;
    const runTests = vi.fn(() => {
      allowCancel = true;
      return Promise.resolve(runResult('failed'));
    });

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'cancel-guidance' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates: vi.fn(() => []),
      shouldCancel: vi.fn(() => allowCancel),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    await expect(
      autopilotFeatureRequest({
        projectId: 47,
        prompt: 'Cancel during guidance',
        deps,
        options: { verificationFixRetries: 0 }
      })
    ).rejects.toMatchObject({ code: 'AUTOPILOT_CANCELLED' });

    expect(runTests).toHaveBeenCalled();
  });

  test('cancels immediately at start of guidance loop', async () => {
    const appendEvent = createAppendEvent();
    const plan = vi.fn().mockResolvedValue(defaultPlan());
    const runTests = vi.fn(() => Promise.resolve(runResult('failed')));

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'cancel-guidance-start' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates: vi.fn(() => []),
      shouldCancel: createStackTargetedShouldCancel(608),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    await expect(
      autopilotFeatureRequest({
        projectId: 48,
        prompt: 'Cancel at guidance start',
        deps,
        options: { verificationFixRetries: 0 }
      })
    ).rejects.toMatchObject({ code: 'AUTOPILOT_CANCELLED' });

    expect(runTests).toHaveBeenCalled();
  });

  test('applies early user updates without replans', async () => {
    const plan = vi.fn().mockResolvedValue(defaultPlan(['Initial work']));
    const scriptedUpdates = new Map([[1, ['Add docs']]]);
    let updateCall = 0;
    const consumeUserUpdates = vi.fn(() => scriptedUpdates.get(++updateCall) ?? []);

    const runQueue = [runResult('failed'), runResult('passed'), runResult('failed'), runResult('passed')];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));
    const appendEvent = createAppendEvent();

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'early' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates,
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    const result = await autopilotFeatureRequest({ projectId: 26, prompt: 'Early updates', deps });

    expect(result.merge).toEqual({ mergedBranch: 'main', current: 'main' });
    expect(runTests).toHaveBeenCalledTimes(4);
    const planEvent = appendEvent.events.find((event) => event.type === 'plan' && event.message?.includes('after branch creation'));
    expect(planEvent.payload.addedPrompts).toEqual(['Add docs']);
    const stepDone = appendEvent.events.find((event) => event.type === 'step:done');
    expect(stepDone.payload.artifacts.failingRun.status).toBe('failed');
  });

  test('includes latest run in guidance event when status available', async () => {
    const plan = vi.fn().mockResolvedValue(defaultPlan(['Needs help']));
    const runQueue = [runResult('failed'), runResult('failed'), runResult('passed')];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));
    let updateCall = 0;
    const consumeUserUpdates = vi.fn(() => {
      updateCall += 1;
      if (updateCall === 6) {
        return ['Provide guidance'];
      }
      return [];
    });
    const appendEvent = createAppendEvent();

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'guided' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates,
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    const result = await autopilotFeatureRequest({
      projectId: 40,
      prompt: 'Guidance run',
      deps,
      options: { verificationFixRetries: 0 }
    });

    expect(result.merge).toEqual({ mergedBranch: 'main', current: 'main' });
    const guidanceEvent = appendEvent.events.find(
      (event) => event.type === 'lifecycle' && event.message === 'Needs user input'
    );
    expect(guidanceEvent.payload.testRun.status).toBe('failed');
  });

  test('includes null summary when guidance run lacks summary', async () => {
    const appendEvent = createAppendEvent();
    const plan = vi.fn().mockResolvedValue(defaultPlan(['Needs summary']));
    const runQueue = [runResult('failed'), { status: 'failed' }, runResult('passed')];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));
    let awaitingGuidance = false;
    const reportStatus = vi.fn((message) => {
      if (message.startsWith('Needs user input')) {
        awaitingGuidance = true;
      }
    });
    let guidanceProvided = false;
    const consumeUserUpdates = vi.fn(() => {
      if (awaitingGuidance && !guidanceProvided) {
        guidanceProvided = true;
        return [{ message: 'Manual steps' }];
      }
      return [];
    });

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'guidance-summary' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates,
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus,
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    const result = await autopilotFeatureRequest({
      projectId: 41,
      prompt: 'Guidance missing summary',
      deps,
      options: { verificationFixRetries: 0 }
    });

    expect(result.merge).toEqual({ mergedBranch: 'main', current: 'main' });
    const guidanceEvent = appendEvent.events.find(
      (event) => event.type === 'lifecycle' && event.message === 'Needs user input'
    );
    expect(guidanceEvent.payload.testRun.status).toBe('failed');
    expect(guidanceEvent.payload.testRun.summary).toBeNull();
  });

  test('handles replans and user updates before commit/merge', async () => {
    const appendEvent = createAppendEvent();
    const planQueue = [
      defaultPlan(['Initial feature step']),
      defaultPlan(['Replanned before commit']),
      defaultPlan(['Replanned before merge'])
    ];
    const plan = vi.fn(() => planQueue.shift());
    const edit = vi.fn().mockResolvedValue(createEditResult());
    const runQueue = [];
    for (let i = 0; i < 5; i += 1) {
      runQueue.push(runResult('failed'));
      runQueue.push(runResult('passed'));
    }
    const runTests = vi.fn(() => {
      const next = runQueue.shift();
      if (!next) {
        throw new Error('runQueue exhausted');
      }
      return Promise.resolve(next);
    });

    const scriptedUpdates = new Map([
      [7, [{ kind: 'goal-update', message: 'Replan before commit' }]],
      [13, ['User-provided follow-up']],
      [20, [{ kind: 'new-goal', message: 'Replan before merge' }]],
      [27, ['Final polish']]
    ]);
    let updateCall = 0;
    const consumeUserUpdates = vi.fn(() => {
      updateCall += 1;
      const value = scriptedUpdates.get(updateCall);
      if (!value) {
        return [];
      }
      return Array.isArray(value) ? value : value();
    });

    const ui = {
      navigateTab: vi.fn(() => {
        throw new Error('nav failure');
      })
    };

    const deps = {
      plan,
      edit,
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'ghi789' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates,
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent,
      ui
    };

    const result = await autopilotFeatureRequest({ projectId: 21, prompt: 'Complex updates', deps });

    expect(result.merge).toEqual({ mergedBranch: 'main', current: 'main' });
    expect(plan).toHaveBeenCalledTimes(3);
    expect(runTests).toHaveBeenCalledTimes(10);

    const replanEvents = appendEvent.events.filter(
      (event) => event.type === 'plan' && event.message?.startsWith('Plan replanned')
    );
    expect(replanEvents.some((event) => event.message?.includes('before commit'))).toBe(true);
    expect(replanEvents.some((event) => event.message?.includes('before merge'))).toBe(true);

    const planUpdateMessages = appendEvent.events
      .filter((event) => event.type === 'plan' && event.message?.startsWith('Plan updated'))
      .map((event) => event.message);
    expect(planUpdateMessages).toEqual(
      expect.arrayContaining(['Plan updated (before commit)', 'Plan updated (before merge)'])
    );

    expect(ui.navigateTab).toHaveBeenCalled();
  });

  test('replans before commit with new-goal message', async () => {
    const plan = vi.fn(() => {
      if (plan.mock.calls.length > 0) {
        return { parent: { branchName: 'feat/autopilot' }, children: [{ prompt: 'Replanned work' }] };
      }
      return defaultPlan(['Initial work']);
    });

    const scriptedUpdates = new Map([[7, [{ kind: 'new-goal', message: 'Add analytics' }]]]);
    let updateCall = 0;
    const consumeUserUpdates = vi.fn(() => scriptedUpdates.get(++updateCall) ?? []);

    const runQueue = [runResult('failed'), runResult('passed'), runResult('failed'), runResult('passed')];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));
    const appendEvent = createAppendEvent();

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'replan' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates,
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    const result = await autopilotFeatureRequest({ projectId: 28, prompt: 'Before commit new goal', deps });

    expect(result.merge).toEqual({ mergedBranch: 'main', current: 'main' });
    expect(plan).toHaveBeenCalledTimes(2);
    const replanEvent = appendEvent.events.find(
      (event) => event.type === 'plan' && event.message?.includes('before commit')
    );
    expect(replanEvent.payload.prompt).toContain('New goal');
  });

  test('replans before commit with non-array steps', async () => {
    const plan = vi.fn(() => {
      if (plan.mock.calls.length > 0) {
        return { parent: { branchName: 'feat/autopilot' }, children: null };
      }
      return defaultPlan(['Initial work']);
    });

    const scriptedUpdates = new Map([[7, [{ kind: 'goal-update', message: 'Adjust scope' }]]]);
    let updateCall = 0;
    const consumeUserUpdates = vi.fn(() => scriptedUpdates.get(++updateCall) ?? []);

    const runQueue = [runResult('failed'), runResult('passed')];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));
    const appendEvent = createAppendEvent();

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'replan-empty' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates,
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    const result = await autopilotFeatureRequest({ projectId: 28, prompt: 'Commit replan empty', deps });

    expect(result.merge).toEqual({ mergedBranch: 'main', current: 'main' });
    const replanEvent = appendEvent.events.find(
      (event) => event.type === 'plan' && event.message?.includes('before commit')
    );
    expect(replanEvent.payload.steps).toEqual([]);
  });

  test('handles blank before-commit replan and missing commit metadata', async () => {
    const plan = vi.fn(() => {
      if (plan.mock.calls.length > 0) {
        return { parent: { branchName: 'feat/autopilot' }, children: [] };
      }
      return defaultPlan(['Initial work']);
    });

    const scriptedUpdates = new Map([[7, [{ kind: 'goal-update', message: '   ' }]]]);
    let updateCall = 0;
    const consumeUserUpdates = vi.fn(() => scriptedUpdates.get(++updateCall) ?? []);

    const runQueue = [runResult('failed'), runResult('passed')];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));
    const appendEvent = createAppendEvent();

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({}),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates,
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    const result = await autopilotFeatureRequest({ projectId: 25, prompt: 'Blank before commit', deps });

    expect(result.merge).toEqual({ mergedBranch: 'main', current: 'main' });
    const commitEvent = appendEvent.events.find((event) => event.type === 'git:commit');
    expect(commitEvent.payload.commit).toBeNull();
  });

  test('replans before merge with new goal and missing merge metadata', async () => {
    const plan = vi.fn(({ prompt }) => {
      if (prompt.includes('New goal')) {
        return defaultPlan(['Replan merge step']);
      }
      return defaultPlan(['Initial merge prep']);
    });

    let readyForMergeUpdate = false;
    let providedUpdate = false;
    const consumeUserUpdates = vi.fn(() => {
      if (readyForMergeUpdate && !providedUpdate) {
        providedUpdate = true;
        return [{ kind: 'new-goal', message: 'Polish before merge' }];
      }
      return [];
    });

    const runQueue = [runResult('failed'), runResult('passed'), runResult('failed'), runResult('passed')];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));
    const appendEvent = createAppendEvent();

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockImplementation(async () => {
        readyForMergeUpdate = true;
        return { commit: { sha: 'before-merge' } };
      }),
      merge: vi.fn().mockResolvedValue({}),
      rollback: vi.fn(),
      consumeUserUpdates,
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    const result = await autopilotFeatureRequest({ projectId: 27, prompt: 'Before merge new goal', deps });

    expect(result.merge).toEqual({});
    expect(plan).toHaveBeenCalledTimes(2);
    const mergeEvent = appendEvent.events.find((event) => event.type === 'git:merge');
    expect(mergeEvent.payload.mergedBranch).toBeNull();
    expect(mergeEvent.payload.current).toBeNull();
  });

  test('replans before merge with blank goal update', async () => {
    const plan = vi.fn(() => {
      if (plan.mock.calls.length > 0) {
        return { parent: { branchName: 'feat/autopilot' }, children: [{ prompt: 'Revised merge prep' }] };
      }
      return defaultPlan(['Initial merge prep']);
    });

    const scriptedUpdates = new Map([[8, [{ kind: 'goal-update', message: '   ' }]]]);
    let updateCall = 0;
    const consumeUserUpdates = vi.fn(() => scriptedUpdates.get(++updateCall) ?? []);

    const runQueue = [runResult('failed'), runResult('passed'), runResult('failed'), runResult('passed')];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));
    const appendEvent = createAppendEvent();

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'merge-replan' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates,
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    const result = await autopilotFeatureRequest({ projectId: 29, prompt: 'Merge blank update', deps });

    expect(result.merge).toEqual({ mergedBranch: 'main', current: 'main' });
    const replanEvent = appendEvent.events.find(
      (event) => event.type === 'plan' && event.message?.includes('before merge')
    );
    expect(replanEvent.payload.prompt).toBe('Merge blank update');
  });

  test('replans before merge with non-array steps', async () => {
    const plan = vi.fn(() => {
      if (plan.mock.calls.length > 0) {
        return { parent: { branchName: 'feat/autopilot' }, children: null };
      }
      return defaultPlan(['Initial merge prep']);
    });

    const scriptedUpdates = new Map([[8, [{ kind: 'new-goal', message: 'Refresh merge scope' }]]]);
    let updateCall = 0;
    const consumeUserUpdates = vi.fn(() => scriptedUpdates.get(++updateCall) ?? []);

    const runQueue = [runResult('failed'), runResult('passed')];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));
    const appendEvent = createAppendEvent();

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'merge-replan-empty' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates,
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    const result = await autopilotFeatureRequest({ projectId: 30, prompt: 'Merge replan empty', deps });

    expect(result.merge).toEqual({ mergedBranch: 'main', current: 'main' });
    const replanEvent = appendEvent.events.find(
      (event) => event.type === 'plan' && event.message?.includes('before merge')
    );
    expect(replanEvent.payload.steps).toEqual([]);
  });

  test('applies replan and queued work after step completion updates', async () => {
    const appendEvent = createAppendEvent();
    const planQueue = [
      defaultPlan(['Initial step']),
      defaultPlan(['Replanned mid-run'])
    ];
    const plan = vi.fn(() => planQueue.shift());
    const edit = vi.fn().mockResolvedValue(createEditResult());
    const runQueue = [runResult('failed'), runResult('passed'), runResult('failed'), runResult('passed')];
    const runTests = vi.fn(() => {
      const next = runQueue.shift();
      if (!next) {
        throw new Error('runQueue exhausted');
      }
      return Promise.resolve(next);
    });

    const scriptedUpdates = new Map([
      [6, [{ kind: 'goal-update', message: 'Adjust goal' }, 'User follow-up']]
    ]);
    let updateCall = 0;
    const consumeUserUpdates = vi.fn(() => {
      updateCall += 1;
      const value = scriptedUpdates.get(updateCall);
      if (!value) {
        return [];
      }
      return value;
    });

    const deps = {
      plan,
      edit,
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'mid123' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates,
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    const result = await autopilotFeatureRequest({ projectId: 17, prompt: 'Mid-run update', deps });

    expect(result.merge.mergedBranch).toBe('main');
    expect(plan).toHaveBeenCalledTimes(2);
    expect(
      appendEvent.events.some(
        (event) => event.type === 'plan' && event.message === 'Plan replanned (after step completion)'
      )
    ).toBe(true);
  });

  test('applies pending new-goal replan with empty replanned steps', async () => {
    const plan = vi.fn(({ prompt }) => {
      if (prompt.includes('New goal')) {
        return { parent: { branchName: 'feat/autopilot' }, children: null };
      }
      return defaultPlan(['Initial queue step']);
    });

    const scriptedUpdates = new Map([[2, [{ kind: 'new-goal', message: 'Expand objectives' }]]]);
    let updateCall = 0;
    const consumeUserUpdates = vi.fn(() => scriptedUpdates.get(++updateCall) ?? []);

    const runQueue = [runResult('failed'), runResult('passed')];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'pending-new-goal' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates,
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent: createAppendEvent()
    };

    const result = await autopilotFeatureRequest({ projectId: 24, prompt: 'Pending new goal replan', deps });

    expect(result.merge).toEqual({ mergedBranch: 'main', current: 'main' });
    expect(plan).toHaveBeenCalledTimes(2);
    expect(runTests).toHaveBeenCalledTimes(2);
  });

  test('throws cancellation error before commit when shouldCancel fires late', async () => {
    const appendEvent = createAppendEvent();
    let allowCancel = false;
    const trackingAppendEvent = (event) => {
      appendEvent(event);
      if (event.type === 'step:done') {
        allowCancel = true;
      }
    };

    const plan = vi.fn().mockResolvedValue(defaultPlan(['Cancelable step']));
    const edit = vi.fn().mockResolvedValue(createEditResult());
    const runQueue = [runResult('failed'), runResult('passed')];
    const runTests = vi.fn(() => {
      const next = runQueue.shift();
      if (!next) {
        throw new Error('runQueue exhausted');
      }
      return Promise.resolve(next);
    });
    const shouldCancel = vi.fn(() => (allowCancel ? true : false));

    await expect(
      autopilotFeatureRequest({
        projectId: 33,
        prompt: 'Cancel the run',
        deps: {
          plan,
          edit,
          createBranch: vi.fn(),
          checkout: vi.fn(),
          runTests,
          commit: vi.fn(),
          merge: vi.fn(),
          rollback: vi.fn(),
          consumeUserUpdates: vi.fn(() => []),
          shouldCancel,
          shouldPause: vi.fn(() => false),
          reportStatus: vi.fn(),
          getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
          appendEvent: trackingAppendEvent
        }
      })
    ).rejects.toMatchObject({ code: 'AUTOPILOT_CANCELLED' });

    expect(shouldCancel).toHaveReturnedWith(true);
  });

  test('replans from after-implementation updates and cancels before verification', async () => {
    const appendEvent = createAppendEvent();
    const plan = vi.fn().mockResolvedValue(defaultPlan());
    const runQueue = [runResult('failed')];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));
    let updateCall = 0;
    let cancelAfterImplementation = false;
    const consumeUserUpdates = vi.fn(() => {
      updateCall += 1;
      if (updateCall === 5) {
        cancelAfterImplementation = true;
        return [{ kind: 'goal-update', message: 'Adjust mid-step' }, 'Cover new edge'];
      }
      return [];
    });

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn(),
      merge: vi.fn(),
      rollback: vi.fn(),
      consumeUserUpdates,
      shouldCancel: vi.fn(() => cancelAfterImplementation),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    await expect(
      autopilotFeatureRequest({ projectId: 55, prompt: 'Cancel after implementation', deps })
    ).rejects.toMatchObject({ code: 'AUTOPILOT_CANCELLED' });

    expect(runTests).toHaveBeenCalledTimes(1);
    expect(
      appendEvent.events.some(
        (event) => event.type === 'plan' && event.message === 'Plan updated (after implementation)'
      )
    ).toBe(true);
  });

  test('queues updates after verification fix and succeeds on retry', async () => {
    const appendEvent = createAppendEvent();
    const plan = vi.fn().mockResolvedValue(defaultPlan());
    const runQueue = [
      runResult('failed'),
      runResult('failed'),
      runResult('passed'),
      runResult('failed'),
      runResult('passed')
    ];
    const runTests = vi.fn(() => {
      const next = runQueue.shift();
      if (!next) {
        throw new Error('runQueue depleted');
      }
      return Promise.resolve(next);
    });

    const scriptedUpdates = new Map([[6, ['Follow-up step']]]);
    let updateCall = 0;
    const consumeUserUpdates = vi.fn(() => scriptedUpdates.get(++updateCall) ?? []);

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'queue1' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates,
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    const result = await autopilotFeatureRequest({ projectId: 56, prompt: 'Handle verification updates', deps });

    expect(result.merge).toEqual({ mergedBranch: 'main', current: 'main' });
    expect(runTests).toHaveBeenCalledTimes(5);
    expect(
      appendEvent.events.some(
        (event) => event.type === 'plan' && event.message === 'Plan updated (after verification fix)'
      )
    ).toBe(true);
  });

  test('records null failing run artifacts when initial tests return no data', async () => {
    const appendEvent = createAppendEvent();
    const plan = vi.fn().mockResolvedValue(defaultPlan());
    const runQueue = [null, runResult('passed')];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'null-failing-run' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates: vi.fn(() => []),
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    const result = await autopilotFeatureRequest({ projectId: 72, prompt: 'Missing failing run data', deps });

    expect(result.merge).toEqual({ mergedBranch: 'main', current: 'main' });
    const stepDone = appendEvent.events.find((event) => event.type === 'step:done');
    expect(stepDone.payload.artifacts.failingRun).toBeNull();
  });

  test('records null status when failing run is missing metadata', async () => {
    const appendEvent = createAppendEvent();
    const plan = vi.fn().mockResolvedValue(defaultPlan());
    const runQueue = [{ workspaceRuns: [] }, runResult('passed')];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'missing-meta' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates: vi.fn(() => []),
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    const result = await autopilotFeatureRequest({ projectId: 73, prompt: 'Missing run status', deps });

    expect(result.merge).toEqual({ mergedBranch: 'main', current: 'main' });
    const stepDone = appendEvent.events.find((event) => event.type === 'step:done');
    expect(stepDone.payload.artifacts.failingRun.status).toBeNull();
    expect(stepDone.payload.artifacts.failingRun.summary).toBeNull();
  });

  test('records null summary when passing run omits details', async () => {
    const appendEvent = createAppendEvent();
    const plan = vi.fn().mockResolvedValue(defaultPlan());
    const runQueue = [runResult('failed'), { status: 'passed' }];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'passing-null' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates: vi.fn(() => []),
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    const result = await autopilotFeatureRequest({ projectId: 74, prompt: 'Passing summary null', deps });

    expect(result.merge).toEqual({ mergedBranch: 'main', current: 'main' });
    const stepDone = appendEvent.events.find((event) => event.type === 'step:done');
    expect(stepDone.payload.artifacts.passingRun.summary).toBeNull();
  });

  test('cancels during verification fix loop', async () => {
    const appendEvent = createAppendEvent();
    const plan = vi.fn().mockResolvedValue(defaultPlan());
    const runQueue = [runResult('failed'), runResult('failed')];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn(),
      merge: vi.fn(),
      rollback: vi.fn(),
      consumeUserUpdates: vi.fn(() => []),
      shouldCancel: createStackTargetedShouldCancel(524),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    await expect(
      autopilotFeatureRequest({ projectId: 57, prompt: 'Cancel during verification fix', deps })
    ).rejects.toMatchObject({ code: 'AUTOPILOT_CANCELLED' });
  });

  test('cancels after verification fix pause before retrying', async () => {
    const appendEvent = createAppendEvent();
    const plan = vi.fn().mockResolvedValue(defaultPlan());
    const runQueue = [runResult('failed'), runResult('failed')];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn(),
      merge: vi.fn(),
      rollback: vi.fn(),
      consumeUserUpdates: vi.fn(() => []),
      shouldCancel: createStackTargetedShouldCancel(572),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    await expect(
      autopilotFeatureRequest({ projectId: 58, prompt: 'Cancel after verification pause', deps })
    ).rejects.toMatchObject({ code: 'AUTOPILOT_CANCELLED' });
  });

  test('rolls back when verification retries fail without user updates', async () => {
    const appendEvent = createAppendEvent();
    const plan = vi.fn().mockResolvedValue(defaultPlan());
    const runQueue = [runResult('failed'), runResult('failed'), runResult('failed')];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));
    const rollback = vi.fn().mockResolvedValue({ ok: true });

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn(),
      merge: vi.fn(),
      rollback,
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    await expect(
      autopilotFeatureRequest({
        projectId: 59,
        prompt: 'Rollback when verification never passes',
        deps,
        options: { verificationFixRetries: 1 }
      })
    ).rejects.toThrow('Autopilot implementation did not pass tests/coverage.');

    expect(rollback).toHaveBeenCalled();
    expect(
      appendEvent.events.filter((event) => event.type === 'rollback:planned').length
    ).toBeGreaterThanOrEqual(1);
  });

  test('uses default rollback helper when dependency missing', async () => {
    const appendEvent = createAppendEvent();
    rollbackBranchChanges.mockResolvedValue({ ok: true });
    const plan = vi.fn().mockResolvedValue(defaultPlan());
    const runQueue = [runResult('failed'), runResult('failed')];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn(),
      merge: vi.fn(),
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    await expect(
      autopilotFeatureRequest({
        projectId: 71,
        prompt: 'Fallback rollback',
        deps,
        options: { verificationFixRetries: 0 }
      })
    ).rejects.toThrow('Autopilot implementation did not pass tests/coverage.');

    expect(rollbackBranchChanges).toHaveBeenCalledWith(71, 'feat/autopilot');
  });

  test('cancels while awaiting user guidance', async () => {
    const appendEvent = createAppendEvent();
    const plan = vi.fn().mockResolvedValue(defaultPlan());
    const runQueue = [runResult('failed'), runResult('failed'), runResult('failed')];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn(),
      merge: vi.fn(),
      rollback: vi.fn(),
      consumeUserUpdates: vi.fn(() => []),
      shouldCancel: createStackTargetedShouldCancel(257),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(() => {}),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    await expect(
      autopilotFeatureRequest({ projectId: 60, prompt: 'Cancel awaiting guidance', deps, options: { verificationFixRetries: 1 } })
    ).rejects.toMatchObject({ code: 'AUTOPILOT_CANCELLED' });
  });

  test('cancels after applying user guidance edit', async () => {
    const appendEvent = createAppendEvent();
    const plan = vi.fn().mockResolvedValue(defaultPlan());
    const runQueue = [runResult('failed'), runResult('failed'), runResult('failed')];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));
    let guidanceRequests = 0;
    let respondedGuidanceAttempt = 0;
    const guidanceResponses = new Map([[1, [{ message: 'Manual tweak' }]]]);

    const reportStatus = vi.fn((message) => {
      if (message.startsWith('Needs user input')) {
        guidanceRequests += 1;
      }
    });

    const consumeUserUpdates = vi.fn(() => {
      if (guidanceRequests && respondedGuidanceAttempt !== guidanceRequests) {
        respondedGuidanceAttempt = guidanceRequests;
        return guidanceResponses.get(guidanceRequests) ?? [];
      }
      return [];
    });

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn(),
      merge: vi.fn(),
      rollback: vi.fn(),
      consumeUserUpdates,
      shouldCancel: createStackTargetedShouldCancel(642),
      shouldPause: vi.fn(() => false),
      reportStatus,
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    await expect(
      autopilotFeatureRequest({ projectId: 61, prompt: 'Cancel after guidance edit', deps, options: { verificationFixRetries: 1 } })
    ).rejects.toMatchObject({ code: 'AUTOPILOT_CANCELLED' });
  });

  test('reports failed guidance attempts and rolls back when no further guidance provided', async () => {
    const appendEvent = createAppendEvent();
    const plan = vi.fn().mockResolvedValue(defaultPlan());
    const runQueue = [
      runResult('failed'),
      runResult('failed'),
      runResult('failed'),
      runResult('failed')
    ];
    const runTests = vi.fn(() => {
      const next = runQueue.shift();
      if (!next) {
        throw new Error('runQueue exhausted');
      }
      return Promise.resolve(next);
    });

    let guidanceRequests = 0;
    let respondedGuidanceAttempt = 0;
    const guidanceResponses = new Map([
      [1, [{ message: 'Try manual fix' }]],
      [2, []]
    ]);

    const reportStatus = vi.fn((message) => {
      if (message.startsWith('Needs user input')) {
        guidanceRequests += 1;
      }
    });

    const consumeUserUpdates = vi.fn(() => {
      if (guidanceRequests && respondedGuidanceAttempt !== guidanceRequests) {
        respondedGuidanceAttempt = guidanceRequests;
        return guidanceResponses.get(guidanceRequests) ?? [];
      }
      return [];
    });

    const rollback = vi.fn().mockResolvedValue({ ok: true });

    await expect(
      autopilotFeatureRequest({
        projectId: 62,
        prompt: 'Guidance exhausted rollback',
        deps: {
          plan,
          edit: vi.fn().mockResolvedValue(createEditResult()),
          createBranch: vi.fn(),
          checkout: vi.fn(),
          runTests,
          commit: vi.fn(),
          merge: vi.fn(),
          rollback,
          consumeUserUpdates,
          shouldCancel: vi.fn(() => false),
          shouldPause: vi.fn(() => false),
          reportStatus,
          getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
          appendEvent
        },
        options: { verificationFixRetries: 1 }
      })
    ).rejects.toThrow('Autopilot implementation did not pass tests/coverage.');

    expect(reportStatus).toHaveBeenCalledWith('Guidance applied but tests still failing.');
    expect(
      appendEvent.events.filter((event) => event.type === 'rollback:planned').length
    ).toBeGreaterThanOrEqual(1);
  });

  test('cancels while paused before starting the first step', async () => {
    const appendEvent = createAppendEvent();
    const plan = vi.fn().mockResolvedValue(defaultPlan());
    const runTests = vi.fn();
    let allowCancel = false;
    let pauseChecks = 0;

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn(),
      merge: vi.fn(),
      rollback: vi.fn(),
      consumeUserUpdates: vi.fn(() => []),
      shouldCancel: vi.fn(() => allowCancel),
      shouldPause: vi.fn(() => {
        pauseChecks += 1;
        if (pauseChecks > 1) {
          allowCancel = true;
        }
        return true;
      }),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    await expect(
      autopilotFeatureRequest({ projectId: 63, prompt: 'Pause then cancel', deps })
    ).rejects.toMatchObject({ code: 'AUTOPILOT_CANCELLED' });

    expect(runTests).not.toHaveBeenCalled();
  });

  test('cancels before starting the next step when requested', async () => {
    const appendEvent = createAppendEvent();
    const plan = vi.fn().mockResolvedValue(defaultPlan(['Queued step']));

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests: vi.fn(),
      commit: vi.fn(),
      merge: vi.fn(),
      rollback: vi.fn(),
      consumeUserUpdates: vi.fn(() => []),
      shouldCancel: createStackTargetedShouldCancel(325),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    await expect(
      autopilotFeatureRequest({ projectId: 64, prompt: 'Cancel before step boundary', deps })
    ).rejects.toMatchObject({ code: 'AUTOPILOT_CANCELLED' });

    expect(deps.runTests).not.toHaveBeenCalled();
  });

  test('waits for user guidance until prompts arrive when blocking is enabled', async () => {
    vi.useFakeTimers();

    const appendEvent = createAppendEvent();
    const plan = vi.fn().mockResolvedValue(defaultPlan());
    const runQueue = [runResult('failed'), runResult('failed'), runResult('passed')];
    let runCallCount = 0;
    let awaitingGuidance = false;
    const runTests = vi.fn(() => {
      const next = runQueue.shift();
      if (!next) {
        throw new Error('runQueue depleted');
      }
      runCallCount += 1;
      if (runCallCount === 2 && next.status === 'failed') {
        awaitingGuidance = true;
      }
      return Promise.resolve(next);
    });
    let guidanceReady = false;
    const reportStatus = vi.fn();
    const consumeUserUpdates = vi.fn(() => {
      if (!awaitingGuidance) {
        return [];
      }
      if (!guidanceReady) {
        guidanceReady = true;
        return [];
      }
      awaitingGuidance = false;
      return [{ message: 'Incorporate manual feedback' }];
    });

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'guidance-block' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates,
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus,
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent,
      waitForUserGuidance: true
    };

    let result;
    try {
      const autopilotPromise = autopilotFeatureRequest({
        projectId: 64,
        prompt: 'Block until guidance arrives',
        deps,
        options: { verificationFixRetries: 0 }
      });
      await vi.advanceTimersByTimeAsync(1000);
      result = await autopilotPromise;
    } finally {
      vi.useRealTimers();
    }

    expect(result.merge).toEqual({ mergedBranch: 'main', current: 'main' });
    expect(runTests).toHaveBeenCalledTimes(3);
    expect(consumeUserUpdates).toHaveBeenCalled();
    const guidanceEvent = appendEvent.events.find(
      (event) => event.type === 'lifecycle' && event.message === 'Needs user input'
    );
    expect(guidanceEvent.payload.testRun.status).toBe('failed');
  });

  test('cancels while blocking for user guidance when requested', async () => {
    const appendEvent = createAppendEvent();
    const plan = vi.fn().mockResolvedValue(defaultPlan());
    const runQueue = [runResult('failed'), runResult('failed')];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));

    await expect(
      autopilotFeatureRequest({
        projectId: 76,
        prompt: 'Cancel blocking guidance',
        deps: {
          plan,
          edit: vi.fn().mockResolvedValue(createEditResult()),
          createBranch: vi.fn(),
          checkout: vi.fn(),
          runTests,
          commit: vi.fn(),
          merge: vi.fn(),
          rollback: vi.fn(),
          consumeUserUpdates: vi.fn(() => []),
          shouldCancel: createStackTargetedShouldCancel(238),
          shouldPause: vi.fn(() => false),
          reportStatus: vi.fn(),
          getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
          appendEvent,
          waitForUserGuidance: true
        },
        options: { verificationFixRetries: 0 }
      })
    ).rejects.toMatchObject({ code: 'AUTOPILOT_CANCELLED' });
  });

  test('cancels when awaiting non-blocking user guidance', async () => {
    const appendEvent = createAppendEvent();
    const plan = vi.fn().mockResolvedValue(defaultPlan());
    const runQueue = [runResult('failed'), runResult('failed')];
    const runTests = vi.fn(() => {
      const next = runQueue.shift();
      if (!next) {
        throw new Error('runQueue depleted');
      }
      return Promise.resolve(next);
    });
    let awaitingGuidance = false;
    const reportStatus = vi.fn((message) => {
      if (message.startsWith('Needs user input')) {
        awaitingGuidance = true;
      }
    });

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn(),
      merge: vi.fn(),
      rollback: vi.fn(),
      consumeUserUpdates: vi.fn(() => []),
      shouldCancel: vi.fn(() => awaitingGuidance),
      shouldPause: vi.fn(() => false),
      reportStatus,
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    await expect(
      autopilotFeatureRequest({
        projectId: 65,
        prompt: 'Cancel before guidance fallback',
        deps,
        options: { verificationFixRetries: 0 }
      })
    ).rejects.toMatchObject({ code: 'AUTOPILOT_CANCELLED' });
  });

  test('applies user guidance when verification run lacks status information', async () => {
    const appendEvent = createAppendEvent();
    const plan = vi.fn().mockResolvedValue(defaultPlan());
    const runQueue = [runResult('failed'), { summary: { coverage: { passed: false } } }, runResult('passed')];
    const runTests = vi.fn(() => Promise.resolve(runQueue.shift()));

    let awaitingGuidance = false;
    const reportStatus = vi.fn((message) => {
      if (message.startsWith('Needs user input')) {
        awaitingGuidance = true;
      }
    });
    let guidanceProvided = false;
    const consumeUserUpdates = vi.fn(() => {
      if (awaitingGuidance && !guidanceProvided) {
        guidanceProvided = true;
        return [{ message: 'Manual correction' }];
      }
      return [];
    });

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'guidance-missing-status' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates,
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus,
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    const result = await autopilotFeatureRequest({
      projectId: 73,
      prompt: 'Guidance without status',
      deps,
      options: { verificationFixRetries: 0 }
    });

    expect(result.merge).toEqual({ mergedBranch: 'main', current: 'main' });
    expect(runTests).toHaveBeenCalledTimes(3);
    expect(consumeUserUpdates).toHaveBeenCalled();
  });

  test('replans from blank goal updates before the first step runs', async () => {
    const appendEvent = createAppendEvent();
    const planQueue = [defaultPlan(['Initial step']), defaultPlan(['Replanned step'])];
    const plan = vi.fn(() => {
      const next = planQueue.shift();
      return next ?? defaultPlan(['Fallback step']);
    });

    let updateCall = 0;
    const consumeUserUpdates = vi.fn(() => {
      updateCall += 1;
      if (updateCall === 1) {
        return [{ kind: 'goal-update', message: '   ' }, 'Refine acceptance criteria'];
      }
      return [];
    });

    const runQueue = [runResult('failed'), runResult('passed'), runResult('failed'), runResult('passed')];
    const runTests = vi.fn(() => {
      const next = runQueue.shift();
      if (!next) {
        throw new Error('runQueue depleted');
      }
      return Promise.resolve(next);
    });

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'blank-replan' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates,
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    const result = await autopilotFeatureRequest({ projectId: 66, prompt: 'Blank replan', deps });

    expect(result.merge).toEqual({ mergedBranch: 'main', current: 'main' });
    expect(plan).toHaveBeenCalledTimes(2);
    expect(plan.mock.calls[1][0].prompt).toBe('Blank replan');
  });

  test('applies pending blank replans inside the process queue', async () => {
    const appendEvent = createAppendEvent();
    const planQueue = [defaultPlan(['Initial queued step']), defaultPlan(['Replanned step'])];
    const plan = vi.fn(() => planQueue.shift());

    let updateCall = 0;
    const consumeUserUpdates = vi.fn(() => {
      updateCall += 1;
      if (updateCall === 2) {
        return [{ kind: 'goal-update', message: '   ' }];
      }
      return [];
    });

    const runQueue = [runResult('failed'), runResult('passed')];
    const runTests = vi.fn(() => {
      const next = runQueue.shift();
      if (!next) {
        throw new Error('runQueue depleted');
      }
      return Promise.resolve(next);
    });

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'pending-blank' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates,
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    const result = await autopilotFeatureRequest({ projectId: 74, prompt: 'Pending blank replan', deps });

    expect(result.merge).toEqual({ mergedBranch: 'main', current: 'main' });
    expect(plan).toHaveBeenCalledTimes(2);
    expect(plan.mock.calls[1][0].prompt).toBe('Pending blank replan');
  });

  test('queues updates after tests and after the failing run boundaries', async () => {
    const appendEvent = createAppendEvent();
    const planQueue = [defaultPlan(['Initial change']), defaultPlan(['Post-replan step'])];
    const plan = vi.fn(() => {
      const next = planQueue.shift();
      return next ?? defaultPlan(['Fallback step']);
    });

    let updateCall = 0;
    const consumeUserUpdates = vi.fn(() => {
      updateCall += 1;
      if (updateCall === 2) {
        return [
          { kind: 'goal-update', message: 'Expand scope after tests' },
          'Queue from tests'
        ];
      }
      if (updateCall === 3) {
        return [
          { kind: 'goal-update', message: 'Adjust after failing run' },
          'Queue after failing run'
        ];
      }
      return [];
    });

    const runQueue = [runResult('failed'), runResult('passed'), runResult('failed'), runResult('passed')];
    const runTests = vi.fn(() => {
      const next = runQueue.shift();
      if (!next) {
        throw new Error('runQueue depleted');
      }
      return Promise.resolve(next);
    });

    const reportStatus = vi.fn();

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'after-tests-updates' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates,
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus,
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    const result = await autopilotFeatureRequest({ projectId: 67, prompt: 'Handle queued updates', deps });

    const adjustmentMessages = reportStatus.mock.calls.filter(
      ([message]) => message === 'Received new instructions. Adjusting plan…'
    );
    expect(adjustmentMessages.length).toBeGreaterThanOrEqual(2);
    expect(result.merge).toEqual({ mergedBranch: 'main', current: 'main' });
  });

  test('queues updates after the failing run and flags replans', async () => {
    const appendEvent = createAppendEvent();
    const planQueue = [defaultPlan(['Initial change']), defaultPlan(['Replanned change'])];
    const plan = vi.fn(() => planQueue.shift());

    const runQueue = [runResult('failed'), runResult('passed'), runResult('failed'), runResult('passed')];
    const runTests = vi.fn(() => {
      const next = runQueue.shift();
      if (!next) {
        throw new Error('runQueue depleted');
      }
      return Promise.resolve(next);
    });

    let updateCall = 0;
    const consumeUserUpdates = vi.fn(() => {
      updateCall += 1;
      if (updateCall === 4) {
        return [{ kind: 'goal-update', message: 'Adjust scope' }, 'Queue after failing run'];
      }
      return [];
    });

    const reportStatus = vi.fn();

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn().mockResolvedValue({ commit: { sha: 'after-failing-boundary' } }),
      merge: vi.fn().mockResolvedValue({ mergedBranch: 'main', current: 'main' }),
      rollback: vi.fn(),
      consumeUserUpdates,
      shouldCancel: vi.fn(() => false),
      shouldPause: vi.fn(() => false),
      reportStatus,
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    const result = await autopilotFeatureRequest({ projectId: 75, prompt: 'After failing updates', deps });

    expect(result.merge).toEqual({ mergedBranch: 'main', current: 'main' });
    expect(plan).toHaveBeenCalledTimes(2);
    const failingUpdates = appendEvent.events.filter(
      (event) => event.type === 'plan' && event.message === 'Plan updated (after failing test run)'
    );
    expect(failingUpdates).toHaveLength(1);
    const adjustmentMessages = reportStatus.mock.calls.filter(
      ([message]) => message === 'Received new instructions. Adjusting plan…'
    );
    expect(adjustmentMessages.length).toBeGreaterThanOrEqual(1);
  });

  test('cancels after tests boundary before retrying the failing run', async () => {
    const appendEvent = createAppendEvent();
    const plan = vi.fn().mockResolvedValue(defaultPlan());
    const runTests = vi.fn();
    let updateCall = 0;
    let readyToCancel = false;
    const consumeUserUpdates = vi.fn(() => {
      updateCall += 1;
      if (updateCall === 2) {
        readyToCancel = true;
      }
      return [];
    });

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn(),
      merge: vi.fn(),
      rollback: vi.fn(),
      consumeUserUpdates,
      shouldCancel: vi.fn(() => readyToCancel),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    await expect(
      autopilotFeatureRequest({ projectId: 68, prompt: 'Cancel after tests boundary', deps })
    ).rejects.toMatchObject({ code: 'AUTOPILOT_CANCELLED' });

    expect(runTests).not.toHaveBeenCalled();
  });

  test('throws when expected failing tests already pass', async () => {
    const appendEvent = createAppendEvent();
    const plan = vi.fn().mockResolvedValue(defaultPlan());
    const runTests = vi.fn(() => Promise.resolve(runResult('passed')));
    const rollback = vi.fn().mockResolvedValue({ ok: true });

    await expect(
      autopilotFeatureRequest({
        projectId: 69,
        prompt: 'Failing tests unexpectedly pass',
        deps: {
          plan,
          edit: vi.fn().mockResolvedValue(createEditResult()),
          createBranch: vi.fn(),
          checkout: vi.fn(),
          runTests,
          commit: vi.fn(),
          merge: vi.fn(),
          rollback,
          consumeUserUpdates: vi.fn(() => []),
          shouldCancel: vi.fn(() => false),
          shouldPause: vi.fn(() => false),
          reportStatus: vi.fn(),
          getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
          appendEvent
        }
      })
    ).rejects.toThrow('Autopilot expected failing tests, but tests passed. Refusing to proceed without a failing test run.');

    expect(rollback).toHaveBeenCalled();
  });

  test('cancels after the failing run before implementation begins', async () => {
    const appendEvent = createAppendEvent();
    const plan = vi.fn().mockResolvedValue(defaultPlan());
    const runQueue = [runResult('failed')];
    let readyToCancel = false;
    const runTests = vi.fn(() => {
      const next = runQueue.shift();
      if (!next) {
        throw new Error('runQueue depleted');
      }
      readyToCancel = true;
      return Promise.resolve(next);
    });

    const deps = {
      plan,
      edit: vi.fn().mockResolvedValue(createEditResult()),
      createBranch: vi.fn(),
      checkout: vi.fn(),
      runTests,
      commit: vi.fn(),
      merge: vi.fn(),
      rollback: vi.fn(),
      consumeUserUpdates: vi.fn(() => []),
      shouldCancel: vi.fn(() => readyToCancel),
      shouldPause: vi.fn(() => false),
      reportStatus: vi.fn(),
      getDiffForFiles: vi.fn().mockResolvedValue('diff ok'),
      appendEvent
    };

    await expect(
      autopilotFeatureRequest({ projectId: 70, prompt: 'Cancel after failing run', deps })
    ).rejects.toMatchObject({ code: 'AUTOPILOT_CANCELLED' });

    expect(runTests).toHaveBeenCalledTimes(1);
  });
});
