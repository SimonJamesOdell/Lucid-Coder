import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('axios', () => {
  const post = vi.fn(() => Promise.resolve({ data: {} }));
  const get = vi.fn(() => Promise.resolve({ data: { files: [] } }));
  return { default: { post, get } };
});

import axios from 'axios';
import { processGoal, __processGoalTestHooks } from '../../services/goalAutomation/processGoal.js';

const goalsApiMock = vi.hoisted(() => ({
  fetchGoals: vi.fn(),
  advanceGoalPhase: vi.fn()
}));
vi.mock('../../utils/goalsApi', () => goalsApiMock);

const automationModuleMock = vi.hoisted(() => ({
  automationLog: vi.fn(),
  resolveAttemptSequence: vi.fn(),
  flattenFileTree: vi.fn(),
  buildEditsPrompt: vi.fn(),
  parseEditsFromLLM: vi.fn(),
  buildRelevantFilesContext: vi.fn(),
  applyEdits: vi.fn(),
  buildReplacementRetryContext: vi.fn(),
  isReplacementResolutionError: vi.fn(),
  notifyGoalsUpdated: vi.fn(),
  normalizeRepoPath: vi.fn(),
  buildScopeReflectionPrompt: vi.fn(),
  parseScopeReflectionResponse: vi.fn(),
  validateEditsAgainstReflection: vi.fn()
}));
vi.mock('../../services/goalAutomation/automationUtils.js', () => automationModuleMock);

const mockedAxios = axios;

const goal = { id: 1, prompt: 'Add CTA' };
const defaultArgs = () => ({
  goal,
  projectId: 7,
  projectPath: '/project',
  projectInfo: 'Project info',
  setPreviewPanelTab: vi.fn(),
  setGoalCount: vi.fn(),
  createMessage: vi.fn((role, text, meta) => ({ role, text, meta })),
  setMessages: vi.fn((update) => {
    if (typeof update === 'function') {
      update([]);
    }
  })
});

const baseOptions = {
  implementationAttemptSequence: [1, 2],
  testsAttemptSequence: [1],
  enableScopeReflection: true
};

const getStagePromptPayloads = (stage) =>
  automationModuleMock.buildEditsPrompt.mock.calls
    .map(([payload]) => payload)
    .filter((payload) => payload?.stage === stage);

beforeEach(() => {
  vi.clearAllMocks();
  goalsApiMock.fetchGoals.mockResolvedValue([]);
  goalsApiMock.advanceGoalPhase.mockResolvedValue();

  automationModuleMock.resolveAttemptSequence.mockImplementation((sequence) =>
    Array.isArray(sequence) && sequence.length ? sequence : [1, 2]
  );
  automationModuleMock.flattenFileTree.mockReturnValue([]);
  automationModuleMock.buildEditsPrompt.mockReturnValue({});
  automationModuleMock.parseEditsFromLLM.mockReturnValue([
    {
      type: 'modify',
      path: 'frontend/src/App.jsx',
      replacements: [{ search: 'const value = 1;', replace: 'const value = 2;' }]
    }
  ]);
  automationModuleMock.buildRelevantFilesContext.mockResolvedValue('');
  automationModuleMock.applyEdits.mockResolvedValue({ applied: 1, skipped: 0 });
  automationModuleMock.buildReplacementRetryContext.mockReturnValue({ path: 'frontend/src/App.jsx', message: 'retry' });
  automationModuleMock.isReplacementResolutionError.mockReturnValue(false);
  automationModuleMock.notifyGoalsUpdated.mockReturnValue();
  automationModuleMock.normalizeRepoPath.mockImplementation((value) => value);
  automationModuleMock.buildScopeReflectionPrompt.mockReturnValue({});
  automationModuleMock.parseScopeReflectionResponse.mockReturnValue({ testsNeeded: false });
  automationModuleMock.validateEditsAgainstReflection.mockReturnValue(null);

  mockedAxios.post.mockResolvedValue({ data: {} });
  mockedAxios.get.mockResolvedValue({ data: { files: [] } });
});

describe('processGoal instruction-only goals', () => {
  test('skips automation work for branch-only prompts', async () => {
    const args = defaultArgs();
    const branchGoal = { ...goal, prompt: 'Please create a branch for QA validation' };

    const result = await processGoal(
      branchGoal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      baseOptions
    );

    expect(result).toEqual({ success: true, skippedReason: 'branch-only' });
    expect(goalsApiMock.advanceGoalPhase).toHaveBeenCalledTimes(4);
    expect(args.setPreviewPanelTab).toHaveBeenCalledWith('goals', { source: 'automation' });
    expect(automationModuleMock.buildEditsPrompt).not.toHaveBeenCalled();
    expect(args.createMessage).toHaveBeenCalledWith(
      'assistant',
      expect.stringContaining('Branch setup handled automatically'),
      { variant: 'status' }
    );
  });

  test('skips automation work for stage-only prompts', async () => {
    const args = defaultArgs();
    const stageGoal = { ...goal, prompt: 'Stage the updated files for review' };

    const result = await processGoal(
      stageGoal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      baseOptions
    );

    expect(result).toEqual({ success: true, skippedReason: 'stage-only' });
    expect(goalsApiMock.advanceGoalPhase).toHaveBeenCalledTimes(4);
    expect(args.setPreviewPanelTab).toHaveBeenCalledWith('goals', { source: 'automation' });
    expect(automationModuleMock.buildEditsPrompt).not.toHaveBeenCalled();
    expect(args.createMessage).toHaveBeenCalledWith(
      'assistant',
      expect.stringContaining('Files are already staged after edits'),
      { variant: 'status' }
    );
  });

  test('falls back to zero goal count when fetchGoals returns a non-array value', async () => {
    const args = defaultArgs();
    const branchGoal = { ...goal, prompt: 'Create a branch for documentation only' };
    goalsApiMock.fetchGoals.mockResolvedValueOnce(null);

    const result = await processGoal(
      branchGoal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      baseOptions
    );

    expect(result).toEqual({ success: true, skippedReason: 'branch-only' });
    expect(args.setGoalCount).toHaveBeenCalledWith(0);
  });
});

describe('processGoal scope reflection handling', () => {
  test('logs and continues when the reflection request fails', async () => {
    const args = defaultArgs();
    const reflectionError = new Error('reflection unavailable');
    mockedAxios.post.mockRejectedValueOnce(reflectionError);

    const result = await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      baseOptions
    );

    expect(result).toEqual({ success: true });
    expect(automationModuleMock.automationLog).toHaveBeenCalledWith(
      'processGoal:scopeReflection:error',
      expect.objectContaining({ message: reflectionError.message })
    );
  });
});

describe('processGoal implementation retries', () => {
  test('retries when replacement resolution errors occur', async () => {
    const replacementError = new Error('Replacement search text not found');
    replacementError.__replacement = true;

    automationModuleMock.isReplacementResolutionError.mockImplementation((error) => error === replacementError);
    automationModuleMock.applyEdits
      .mockRejectedValueOnce(replacementError)
      .mockResolvedValueOnce({ applied: 1, skipped: 0 });

    const args = defaultArgs();

    const result = await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      baseOptions
    );

    expect(result).toEqual({ success: true });
    expect(automationModuleMock.buildReplacementRetryContext).toHaveBeenCalledWith(replacementError);
    expect(automationModuleMock.applyEdits).toHaveBeenCalledTimes(2);
    const secondPrompt = automationModuleMock.buildEditsPrompt.mock.calls[1][0];
    expect(secondPrompt.retryContext).toEqual({ path: 'frontend/src/App.jsx', message: 'retry' });
  });

  test('retries when scope violations are reported', async () => {
    const violation = { message: 'Stay in file', path: 'frontend/src/App.jsx' };
    automationModuleMock.validateEditsAgainstReflection
      .mockReturnValueOnce(violation)
      .mockReturnValue(null);

    const args = defaultArgs();
    const result = await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      baseOptions
    );

    expect(result).toEqual({ success: true });
    expect(automationModuleMock.applyEdits).toHaveBeenCalledTimes(1);
    const retryContext = automationModuleMock.buildEditsPrompt.mock.calls[1][0].retryContext;
    expect(retryContext).toMatchObject({
      path: violation.path,
      scopeWarning: violation.message,
      message: violation.message
    });
  });

  test('retries when the LLM returns zero edits', async () => {
    automationModuleMock.parseEditsFromLLM
      .mockReturnValueOnce([])
      .mockReturnValue([
        {
          type: 'modify',
          path: 'frontend/src/App.jsx',
          replacements: [{ search: 'const value = 1;', replace: 'const value = 2;' }]
        }
      ]);

    const args = defaultArgs();
    const result = await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      baseOptions
    );

    expect(result).toEqual({ success: true });
    const retryContext = automationModuleMock.buildEditsPrompt.mock.calls[1][0].retryContext;
    expect(retryContext.message).toMatch(/zero edits/i);
  });
});

describe('processGoal stage error handling', () => {
  test('retries the tests stage when applyEdits throws scope violations', async () => {
    const violationError = new Error('Scope limit');
    violationError.__lucidcoderScopeViolation = { message: 'Stay in App.jsx', path: 'frontend/src/App.jsx' };

    let testFailures = 0;
    automationModuleMock.applyEdits.mockImplementation(async ({ stage }) => {
      if (stage === 'tests') {
        if (testFailures === 0) {
          testFailures += 1;
          throw violationError;
        }
        return { applied: 1, skipped: 0 };
      }
      return { applied: 1, skipped: 0 };
    });

    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({ testsNeeded: true });

    const args = defaultArgs();
    const result = await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      { ...baseOptions, testsAttemptSequence: [1, 2] }
    );

    expect(result).toEqual({ success: true });
    const testCalls = getStagePromptPayloads('tests');
    expect(testCalls).toHaveLength(2);
    expect(testCalls[1].retryContext).toMatchObject({
      path: 'frontend/src/App.jsx',
      scopeWarning: 'Stay in App.jsx',
      message: 'Stay in App.jsx'
    });
  });

  test('retries the tests stage when empty edit errors are thrown', async () => {
    const emptyError = new Error('No edits');
    emptyError.__lucidcoderEmptyEditsStage = 'tests';

    let testFailures = 0;
    automationModuleMock.applyEdits.mockImplementation(async ({ stage }) => {
      if (stage === 'tests') {
        if (testFailures === 0) {
          testFailures += 1;
          throw emptyError;
        }
        return { applied: 1, skipped: 0 };
      }
      return { applied: 1, skipped: 0 };
    });

    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({ testsNeeded: true });

    const args = defaultArgs();
    const result = await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      { ...baseOptions, testsAttemptSequence: [1, 2] }
    );

    expect(result).toEqual({ success: true });
    const testCalls = getStagePromptPayloads('tests');
    expect(testCalls[1].retryContext.message).toMatch(/provide at least one edit/i);
  });

  test('retries the implementation stage when scope violations occur', async () => {
    const violationError = new Error('Implementation scope');
    violationError.__lucidcoderScopeViolation = { message: 'Stay scoped', path: 'frontend/src/App.jsx' };

    let implFailures = 0;
    automationModuleMock.applyEdits.mockImplementation(async ({ stage }) => {
      if (stage === 'tests') {
        return { applied: 1, skipped: 0 };
      }
      if (stage === 'implementation') {
        if (implFailures === 0) {
          implFailures += 1;
          throw violationError;
        }
        return { applied: 1, skipped: 0 };
      }
      return { applied: 1, skipped: 0 };
    });

    const args = defaultArgs();
    const result = await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      baseOptions
    );

    expect(result).toEqual({ success: true });
    const implCalls = getStagePromptPayloads('implementation');
    expect(implCalls).toHaveLength(2);
    expect(implCalls[1].retryContext).toMatchObject({
      path: 'frontend/src/App.jsx',
      scopeWarning: 'Stay scoped',
      message: 'Stay scoped'
    });
  });

  test('retries the implementation stage when empty edit errors occur', async () => {
    const emptyError = new Error('Implementation empty');
    emptyError.__lucidcoderEmptyEditsStage = 'implementation';

    let implFailures = 0;
    automationModuleMock.applyEdits.mockImplementation(async ({ stage }) => {
      if (stage === 'tests') {
        return { applied: 1, skipped: 0 };
      }
      if (stage === 'implementation') {
        if (implFailures === 0) {
          implFailures += 1;
          throw emptyError;
        }
        return { applied: 1, skipped: 0 };
      }
      return { applied: 1, skipped: 0 };
    });

    const args = defaultArgs();
    const result = await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      baseOptions
    );

    expect(result).toEqual({ success: true });
    const implCalls = getStagePromptPayloads('implementation');
    expect(implCalls[1].retryContext.message).toMatch(/provide the exact modifications/i);
  });

  test('retries the tests stage when scope violations omit path info', async () => {
    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({ testsNeeded: true });

    const violationError = new Error('Scope limit');
    violationError.__lucidcoderScopeViolation = { message: 'Stay constrained' };

    let testAttempts = 0;
    automationModuleMock.applyEdits.mockImplementation(async ({ stage }) => {
      if (stage === 'tests') {
        testAttempts += 1;
        if (testAttempts === 1) {
          throw violationError;
        }
        return { applied: 1, skipped: 0 };
      }
      return { applied: 1, skipped: 0 };
    });

    const args = defaultArgs();
    const result = await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      { ...baseOptions, testsAttemptSequence: [1, 2], implementationAttemptSequence: [1] }
    );

    expect(result).toEqual({ success: true });
    const testCalls = getStagePromptPayloads('tests');
    expect(testCalls).toHaveLength(2);
    expect(testCalls[1].retryContext.path).toBeNull();
  });

  test('reuses tests retry context when empty edits follow scope violations', async () => {
    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({ testsNeeded: true });

    const violationError = new Error('Scope limit');
    violationError.__lucidcoderScopeViolation = { message: 'Stay in App.jsx', path: 'frontend/src/App.jsx' };
    const emptyError = new Error('tests empty');
    emptyError.__lucidcoderEmptyEditsStage = 'tests';

    let testAttempts = 0;
    automationModuleMock.applyEdits.mockImplementation(async ({ stage }) => {
      if (stage === 'tests') {
        testAttempts += 1;
        if (testAttempts === 1) {
          throw violationError;
        }
        if (testAttempts === 2) {
          throw emptyError;
        }
        return { applied: 1, skipped: 0 };
      }
      return { applied: 1, skipped: 0 };
    });

    const args = defaultArgs();
    const result = await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      { ...baseOptions, testsAttemptSequence: [1, 2, 3], implementationAttemptSequence: [1] }
    );

    expect(result).toEqual({ success: true });
    const testCalls = getStagePromptPayloads('tests');
    expect(testCalls).toHaveLength(3);
    expect(testCalls[2].retryContext.path).toBe('frontend/src/App.jsx');
    expect(testCalls[2].retryContext.scopeWarning).toBe('Stay in App.jsx');
  });

  test('retries the implementation stage when scope violations omit path info', async () => {
    const violationError = new Error('Implementation scope');
    violationError.__lucidcoderScopeViolation = { message: 'Stay scoped' };

    let implAttempts = 0;
    automationModuleMock.applyEdits.mockImplementation(async ({ stage }) => {
      if (stage === 'tests') {
        return { applied: 1, skipped: 0 };
      }
      if (stage === 'implementation') {
        implAttempts += 1;
        if (implAttempts === 1) {
          throw violationError;
        }
        return { applied: 1, skipped: 0 };
      }
      return { applied: 1, skipped: 0 };
    });

    const args = defaultArgs();
    const result = await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      baseOptions
    );

    expect(result).toEqual({ success: true });
    const implCalls = getStagePromptPayloads('implementation');
    expect(implCalls).toHaveLength(2);
    expect(implCalls[1].retryContext.path).toBeNull();
  });

  test('reuses implementation retry context when empty edits follow scope violations', async () => {
    const violationError = new Error('Implementation scope');
    violationError.__lucidcoderScopeViolation = { message: 'Stay scoped', path: 'frontend/src/App.jsx' };
    const emptyError = new Error('Implementation empty');
    emptyError.__lucidcoderEmptyEditsStage = 'implementation';

    let implAttempts = 0;
    automationModuleMock.applyEdits.mockImplementation(async ({ stage }) => {
      if (stage === 'tests') {
        return { applied: 1, skipped: 0 };
      }
      if (stage === 'implementation') {
        implAttempts += 1;
        if (implAttempts === 1) {
          throw violationError;
        }
        if (implAttempts === 2) {
          throw emptyError;
        }
        return { applied: 1, skipped: 0 };
      }
      return { applied: 1, skipped: 0 };
    });

    const args = defaultArgs();
    const result = await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      { ...baseOptions, implementationAttemptSequence: [1, 2, 3] }
    );

    expect(result).toEqual({ success: true });
    const implCalls = getStagePromptPayloads('implementation');
    expect(implCalls).toHaveLength(3);
    expect(implCalls[2].retryContext.path).toBe('frontend/src/App.jsx');
    expect(implCalls[2].retryContext.scopeWarning).toBe('Stay scoped');
  });
});

describe('processGoal edit accounting', () => {
  test('handles implementation stage summaries that report zero applied edits', async () => {
    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({ testsNeeded: true });

    automationModuleMock.applyEdits.mockImplementation(async ({ stage }) => {
      if (stage === 'tests') {
        return { applied: 1, skipped: 0 };
      }
      if (stage === 'implementation') {
        return { applied: 0, skipped: 1 };
      }
      return { applied: 1, skipped: 0 };
    });

    const args = defaultArgs();
    const result = await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      baseOptions
    );

    expect(result).toEqual({ success: true });
  });
});

describe('processGoal tests stage preprocessing', () => {
  test('captures retry context when validation blocks tests edits', async () => {
    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({ testsNeeded: true });
    automationModuleMock.parseEditsFromLLM.mockReturnValue([
      {
        type: 'modify',
        path: 'frontend/src/App.jsx',
        replacements: [{ search: 'const value = 1;', replace: 'const value = 2;' }]
      }
    ]);
    automationModuleMock.validateEditsAgainstReflection
      .mockReturnValueOnce({ message: 'Stay in tests', path: 'frontend/src/App.jsx' })
      .mockReturnValue(null);
    automationModuleMock.resolveAttemptSequence
      .mockImplementationOnce(() => [1, 2])
      .mockImplementationOnce(() => [1]);

    const args = defaultArgs();
    const result = await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      { ...baseOptions, testsAttemptSequence: [1, 2], implementationAttemptSequence: [1] }
    );

    expect(result).toEqual({ success: true });
    const testPrompts = getStagePromptPayloads('tests');
    expect(testPrompts).toHaveLength(2);
    expect(testPrompts[1].retryContext).toMatchObject({
      path: 'frontend/src/App.jsx',
      scopeWarning: 'Stay in tests',
      message: 'Stay in tests'
    });
  });

  test('captures retry context when the tests LLM returns empty edits', async () => {
    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({ testsNeeded: true });
    automationModuleMock.parseEditsFromLLM
      .mockImplementationOnce(() => [])
      .mockReturnValue([
        {
          type: 'modify',
          path: 'frontend/src/App.jsx',
          replacements: [{ search: 'const value = 1;', replace: 'const value = 2;' }]
        }
      ]);
    automationModuleMock.resolveAttemptSequence
      .mockImplementationOnce(() => [1, 2])
      .mockImplementationOnce(() => [1]);

    const args = defaultArgs();
    const result = await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      { ...baseOptions, testsAttemptSequence: [1, 2], implementationAttemptSequence: [1] }
    );

    expect(result).toEqual({ success: true });
    const testPrompts = getStagePromptPayloads('tests');
    expect(testPrompts).toHaveLength(2);
    expect(testPrompts[1].retryContext.message).toMatch(/Provide at least one edit/i);
  });
});

describe('processGoal implementation preprocessing', () => {
  test('applies implementation edits when tests are skipped', async () => {
    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({ testsNeeded: false });

    const args = defaultArgs();
    const result = await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      { ...baseOptions, testsAttemptSequence: [], implementationAttemptSequence: [1] }
    );

    expect(result).toEqual({ success: true });
    expect(automationModuleMock.applyEdits).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'implementation' })
    );
  });

  test('captures implementation retry context when validation blocks edits', async () => {
    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({ testsNeeded: false });
    automationModuleMock.validateEditsAgainstReflection
      .mockReturnValueOnce({ message: 'Stay in implementation', path: 'frontend/src/App.jsx' })
      .mockReturnValue(null);
    automationModuleMock.resolveAttemptSequence
      .mockImplementationOnce(() => [])
      .mockImplementationOnce(() => [1, 2]);

    const args = defaultArgs();
    const result = await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      { ...baseOptions, testsAttemptSequence: [], implementationAttemptSequence: [1, 2] }
    );

    expect(result).toEqual({ success: true });
    const implPrompts = getStagePromptPayloads('implementation');
    expect(implPrompts).toHaveLength(2);
    expect(implPrompts[1].retryContext).toMatchObject({
      path: 'frontend/src/App.jsx',
      scopeWarning: 'Stay in implementation',
      message: 'Stay in implementation'
    });
  });

  test('captures implementation retry context when empty edits are returned', async () => {
    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({ testsNeeded: false });
    automationModuleMock.parseEditsFromLLM
      .mockImplementationOnce(() => [])
      .mockReturnValue([
        {
          type: 'modify',
          path: 'frontend/src/App.jsx',
          replacements: [{ search: 'const value = 1;', replace: 'const value = 2;' }]
        }
      ]);
    automationModuleMock.resolveAttemptSequence
      .mockImplementationOnce(() => [])
      .mockImplementationOnce(() => [1, 2]);

    const args = defaultArgs();
    const result = await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      { ...baseOptions, testsAttemptSequence: [], implementationAttemptSequence: [1, 2] }
    );

    expect(result).toEqual({ success: true });
    const implPrompts = getStagePromptPayloads('implementation');
    expect(implPrompts).toHaveLength(2);
    expect(implPrompts[1].retryContext.message).toMatch(/exact modifications needed/i);
  });
});

describe('processGoal final-attempt failures', () => {
  test('propagates tests scope violations when no retries remain', async () => {
    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({ testsNeeded: true });
    automationModuleMock.validateEditsAgainstReflection
      .mockReturnValueOnce({ message: 'Respect scope', path: 'frontend/src/App.jsx' })
      .mockReturnValue(null);

    const args = defaultArgs();
    const result = await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      { ...baseOptions, testsAttemptSequence: [1], implementationAttemptSequence: [1] }
    );

    expect(result).toEqual({ success: false, error: 'Respect scope' });
    expect(automationModuleMock.applyEdits).not.toHaveBeenCalled();
  });

  test('propagates tests empty edit errors when retries are exhausted', async () => {
    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({ testsNeeded: true });
    automationModuleMock.parseEditsFromLLM.mockReturnValue([]);

    const args = defaultArgs();
    const result = await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      { ...baseOptions, testsAttemptSequence: [1], implementationAttemptSequence: [1] }
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/LLM returned no edits for the tests stage/i);
    expect(automationModuleMock.applyEdits).not.toHaveBeenCalled();
  });

  test('propagates implementation scope violations when retries are exhausted', async () => {
    automationModuleMock.validateEditsAgainstReflection.mockReturnValue({ message: 'Stay scoped', path: 'frontend/src/App.jsx' });

    const args = defaultArgs();
    const result = await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      { ...baseOptions, implementationAttemptSequence: [1] }
    );

    expect(result).toEqual({ success: false, error: 'Stay scoped' });
    expect(automationModuleMock.applyEdits).not.toHaveBeenCalled();
  });

  test('propagates implementation empty edit errors when retries are exhausted', async () => {
    automationModuleMock.parseEditsFromLLM.mockReturnValue([]);

    const args = defaultArgs();
    const result = await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      { ...baseOptions, implementationAttemptSequence: [1] }
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/LLM returned no edits for the implementation stage/i);
    expect(automationModuleMock.applyEdits).not.toHaveBeenCalled();
  });
});

describe('__processGoalTestHooks helpers', () => {
  test('classifyInstructionOnlyGoal detects branch and stage prompts', () => {
    const { classifyInstructionOnlyGoal } = __processGoalTestHooks;

    expect(classifyInstructionOnlyGoal('Please create a branch for me')).toBe('branch-only');
    expect(classifyInstructionOnlyGoal('stage the updated files')).toBe('stage-only');
    expect(classifyInstructionOnlyGoal('do regular automation')).toBeNull();
  });

  test('describeInstructionOnlyOutcome falls back to the default message', () => {
    const { describeInstructionOnlyOutcome } = __processGoalTestHooks;

    expect(describeInstructionOnlyOutcome('unknown-type')).toBe('No edits required');
  });

  test('buildScopeViolationError flags errors for scope enforcement', () => {
    const { buildScopeViolationError, isScopeViolationError } = __processGoalTestHooks;
    const violation = { message: 'Stay scoped', path: 'frontend/src/App.jsx' };

    const error = buildScopeViolationError(violation);

    expect(error.message).toBe('Stay scoped');
    expect(isScopeViolationError(error)).toBe(true);
    expect(error.__lucidcoderScopeViolation).toBe(violation);
  });

  test('buildScopeViolationError falls back to the default message when details are missing', () => {
    const { buildScopeViolationError } = __processGoalTestHooks;

    const error = buildScopeViolationError({});

    expect(error.message).toBe('Proposed edits exceeded the requested scope.');
  });

  test('buildEmptyEditsError annotates the failing stage', () => {
    const { buildEmptyEditsError, isEmptyEditsError } = __processGoalTestHooks;

    const error = buildEmptyEditsError('tests');

    expect(error.message).toMatch(/tests stage/i);
    expect(isEmptyEditsError(error)).toBe(true);
  });
});
