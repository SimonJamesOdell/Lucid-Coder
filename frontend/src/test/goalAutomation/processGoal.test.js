import { describe, test, expect, vi, beforeEach } from 'vitest';
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
  deriveStyleScopeContract: vi.fn(),
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
  automationModuleMock.applyEdits.mockReset();
  automationModuleMock.applyEdits.mockResolvedValue({ applied: 1, skipped: 0 });
  automationModuleMock.buildReplacementRetryContext.mockReturnValue({ path: 'frontend/src/App.jsx', message: 'retry' });
  automationModuleMock.isReplacementResolutionError.mockReturnValue(false);
  automationModuleMock.notifyGoalsUpdated.mockReturnValue();
  automationModuleMock.normalizeRepoPath.mockImplementation((value) => value);
  automationModuleMock.buildScopeReflectionPrompt.mockReturnValue({});
  automationModuleMock.deriveStyleScopeContract.mockReturnValue(null);
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

  test('skips automation work for verification-only prompts', async () => {
    const args = defaultArgs();
    const verifyGoal = {
      ...goal,
      prompt: 'Run the frontend dev server and verify visual integration with the new background'
    };

    const result = await processGoal(
      verifyGoal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      baseOptions
    );

    expect(result).toEqual({ success: true, skippedReason: 'verification-only' });
    expect(goalsApiMock.advanceGoalPhase).toHaveBeenCalledTimes(4);
    expect(automationModuleMock.buildEditsPrompt).not.toHaveBeenCalled();
    expect(args.createMessage).toHaveBeenCalledWith(
      'assistant',
      expect.stringContaining('Manual verification step acknowledged'),
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

  test('refreshes goal count when advanceGoalPhase returns 404 for instruction-only goals', async () => {
    const args = defaultArgs();
    const branchGoal = { ...goal, prompt: 'Create a branch for release testing' };
    goalsApiMock.advanceGoalPhase.mockImplementation(() => Promise.reject({ response: { status: 404 } }));
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

  test('uses Original request line when formatting completion label', async () => {
    const args = defaultArgs();
    const branchGoal = {
      ...goal,
      prompt: 'Please create a branch for QA validation\nOriginal request: Update button color'
    };

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
    expect(args.createMessage).toHaveBeenCalledWith(
      'assistant',
      expect.stringContaining('Update button color'),
      { variant: 'status' }
    );
  });

  test('uses User answer line when formatting completion label', async () => {
    const args = defaultArgs();
    const stageGoal = {
      ...goal,
      prompt: 'Stage the updated files for review\nUser answer: Add a footer link'
    };

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
    expect(args.createMessage).toHaveBeenCalledWith(
      'assistant',
      expect.stringContaining('Add a footer link'),
      { variant: 'status' }
    );
  });

  test('falls back to Goal label when title is whitespace', async () => {
    const args = defaultArgs();
    const branchGoal = {
      ...goal,
      title: '   ',
      prompt: 'Please create a branch for QA validation'
    };

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
    expect(args.createMessage).toHaveBeenCalledWith(
      'assistant',
      expect.stringContaining('Goal'),
      { variant: 'status' }
    );
  });
});

describe('processGoal pause and cancel paths', () => {
  test('returns cancelled before refreshing repo context when cancelled', async () => {
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
      {
        ...baseOptions,
        testsAttemptSequence: [1],
        implementationAttemptSequence: [1],
        shouldPause: () => false,
        shouldCancel: () => true
      }
    );

    expect(result).toEqual({ success: false, cancelled: true });
  });

  test('cancels after parsing tests edits but before applying them', async () => {
    const args = defaultArgs();
    automationModuleMock.parseScopeReflectionResponse.mockReturnValueOnce({ testsNeeded: true });

    let cancelNext = false;
    automationModuleMock.parseEditsFromLLM.mockImplementationOnce(() => {
      cancelNext = true;
      return [
        {
          type: 'modify',
          path: 'frontend/src/App.jsx',
          replacements: [{ search: 'const value = 1;', replace: 'const value = 2;' }]
        }
      ];
    });

    const result = await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      {
        ...baseOptions,
        testsAttemptSequence: [1],
        implementationAttemptSequence: [1],
        shouldPause: () => false,
        shouldCancel: () => cancelNext
      }
    );

    expect(result).toEqual({ success: false, cancelled: true });
    expect(automationModuleMock.applyEdits).not.toHaveBeenCalled();
  });

  test('cancels during tests stage before applying edits', async () => {
    const args = defaultArgs();
    automationModuleMock.parseScopeReflectionResponse.mockReturnValueOnce({ testsNeeded: true });

    let cancelCalls = 0;
    const shouldCancel = () => {
      cancelCalls += 1;
      return cancelCalls >= 3;
    };

    const result = await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      {
        ...baseOptions,
        testsAttemptSequence: [1, 2],
        implementationAttemptSequence: [1],
        shouldPause: () => false,
        shouldCancel
      }
    );

    expect(result).toEqual({ success: false, cancelled: true });
    expect(automationModuleMock.applyEdits).not.toHaveBeenCalled();
  });

  test('cancels before requesting test edits when cancelled early in the tests loop', async () => {
    const args = defaultArgs();
    automationModuleMock.parseScopeReflectionResponse.mockReturnValueOnce({ testsNeeded: true });

    let cancelCalls = 0;
    const shouldCancel = () => {
      cancelCalls += 1;
      return cancelCalls >= 2;
    };

    const result = await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      {
        ...baseOptions,
        testsAttemptSequence: [1],
        implementationAttemptSequence: [1],
        shouldPause: () => false,
        shouldCancel
      }
    );

    expect(result).toEqual({ success: false, cancelled: true });
  });

  test('cancels during implementation before applying edits', async () => {
    const args = defaultArgs();

    let cancelCalls = 0;
    const shouldCancel = () => {
      cancelCalls += 1;
      return cancelCalls >= 4;
    };

    const result = await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      {
        ...baseOptions,
        testsAttemptSequence: [1],
        implementationAttemptSequence: [1],
        shouldPause: () => false,
        shouldCancel
      }
    );

    expect(result).toEqual({ success: false, cancelled: true });
  });

  test('cancels after edits are applied but before verification', async () => {
    const args = defaultArgs();

    let cancelCalls = 0;
    const shouldCancel = () => {
      cancelCalls += 1;
      return cancelCalls >= 5;
    };

    const result = await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      {
        ...baseOptions,
        testsAttemptSequence: [1],
        implementationAttemptSequence: [1],
        shouldPause: () => false,
        shouldCancel
      }
    );

    expect(result).toEqual({ success: false, cancelled: true });
  });
});

describe('processGoal retries and context handling', () => {
  test('uses object touchTracker option and marks touched suites from applied files', async () => {
    const args = defaultArgs();
    const touchTracker = { frontend: false, backend: false, __observed: false };

    automationModuleMock.applyEdits.mockImplementation(async ({ onFileApplied, stage }) => {
      if (typeof onFileApplied === 'function' && stage === 'implementation') {
        await onFileApplied('shared/version.mjs');
      }
      return { applied: 1, skipped: 0 };
    });

    const result = await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      {
        ...baseOptions,
        testsAttemptSequence: [1],
        implementationAttemptSequence: [1],
        touchTracker
      }
    );

    expect(result).toEqual({ success: true });
    expect(touchTracker).toEqual({ frontend: true, backend: true, __observed: true });
  });

  test('normalizes requiredAssetPaths entries for implementation retry messaging', async () => {
    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({
      testsNeeded: false,
      requiredAssetPaths: [' uploads/hero.png ', null, '', 'uploads/banner.jpg']
    });
    automationModuleMock.parseEditsFromLLM
      .mockReturnValueOnce([])
      .mockReturnValueOnce([
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
      { ...baseOptions, implementationAttemptSequence: [1, 2] }
    );

    expect(result).toEqual({ success: true });
    const retryContext = automationModuleMock.buildEditsPrompt.mock.calls[1][0].retryContext;
    expect(retryContext.message).toContain('uploads/hero.png, uploads/banner.jpg');
    expect(retryContext.message).not.toContain('null');
  });

  test('uses required-asset retry guidance when implementation returns zero edits before last attempt', async () => {
    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({
      testsNeeded: false,
      requiredAssetPaths: ['uploads/background.png']
    });
    automationModuleMock.parseEditsFromLLM
      .mockReturnValueOnce([])
      .mockReturnValueOnce([
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
      { ...baseOptions, implementationAttemptSequence: [1, 2] }
    );

    expect(result).toEqual({ success: true });
    const retryContext = automationModuleMock.buildEditsPrompt.mock.calls[1][0].retryContext;
    expect(retryContext.message).toMatch(/selected asset paths/i);
    expect(retryContext.message).toContain('uploads/background.png');
  });

  test('retries tests stage after file operation failures', async () => {
    const args = defaultArgs();
    automationModuleMock.parseScopeReflectionResponse.mockReturnValueOnce({ testsNeeded: true });
    automationModuleMock.parseEditsFromLLM
      .mockReturnValueOnce([
        {
          type: 'modify',
          path: 'frontend/src/test/Goal.test.jsx',
          replacements: [{ search: 'a', replace: 'b' }]
        }
      ])
      .mockReturnValueOnce([
        {
          type: 'modify',
          path: 'frontend/src/test/Goal.test.jsx',
          replacements: [{ search: 'a', replace: 'b' }]
        }
      ]);

    const fileOpError = new Error('file op failed');
    fileOpError.__lucidcoderFileOpFailure = { path: 'frontend/src/App.jsx', status: 404 };
    automationModuleMock.applyEdits
      .mockRejectedValueOnce(fileOpError)
      .mockResolvedValueOnce({ applied: 1, skipped: 0 })
      .mockResolvedValueOnce({ applied: 1, skipped: 0 });

    const coverageGoal = {
      ...args.goal,
      metadata: { uncoveredLines: [{ workspace: 'frontend', file: 'src/App.jsx', lines: [10] }] }
    };

    const result = await processGoal(
      coverageGoal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      {
        ...baseOptions,
        testsAttemptSequence: [1, 2],
        implementationAttemptSequence: [1],
        shouldPause: () => false,
        shouldCancel: () => false
      }
    );

    expect(result).toEqual({ success: true });
    expect(automationModuleMock.applyEdits).toHaveBeenCalledTimes(2);
  });

  test('handles absolute paths when merging known directories', async () => {
    const args = defaultArgs();
    automationModuleMock.flattenFileTree.mockReturnValueOnce(['/foo']);

    const result = await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      {
        ...baseOptions,
        testsAttemptSequence: [1],
        implementationAttemptSequence: [1],
        shouldPause: () => false,
        shouldCancel: () => false
      }
    );

    expect(result).toEqual({ success: true });
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

  test('forces testsNeeded true when test failure context exists', async () => {
    const args = defaultArgs();

    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({ testsNeeded: false });

    const result = await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      {
        ...baseOptions,
        testFailureContext: { jobs: [] }
      }
    );

    expect(result).toEqual({ success: true });

    const scopeLog = automationModuleMock.automationLog.mock.calls.find(
      ([key]) => key === 'processGoal:scopeReflection'
    );
    expect(scopeLog?.[1]?.testsNeeded).toBe(true);
  });

  test('handles non-string prompts when evaluating test-fix heuristics', async () => {
    const args = defaultArgs();
    const numericGoal = { ...args.goal, prompt: 123 };

    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({ testsNeeded: false });

    const result = await processGoal(
      numericGoal,
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

    const scopeLog = automationModuleMock.automationLog.mock.calls.find(
      ([key]) => key === 'processGoal:scopeReflection'
    );
    expect(scopeLog?.[1]?.testsNeeded).toBe(false);
  });

  test('disables tests stage for style-only goals without test failure context', async () => {
    const args = defaultArgs();
    const styleOnlyGoal = {
      ...args.goal,
      metadata: { styleOnly: true }
    };

    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({ testsNeeded: true });

    const result = await processGoal(
      styleOnlyGoal,
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
    expect(getStagePromptPayloads('testing')).toEqual([]);
    expect(getStagePromptPayloads('implementation').length).toBeGreaterThan(0);
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

  test('retries when file operations fail to write a target file', async () => {
    const fileOpError = new Error('Failed to write file: backend/health.js');
    fileOpError.__lucidcoderFileOpFailure = {
      path: 'backend/health.js',
      status: 404,
      message: 'Failed to write file: backend/health.js',
      operation: 'upsert'
    };

    automationModuleMock.flattenFileTree.mockReturnValue(['backend/routes/health.js']);

    automationModuleMock.applyEdits
      .mockRejectedValueOnce(fileOpError)
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
    expect(automationModuleMock.applyEdits).toHaveBeenCalledTimes(2);
    const retryContext = automationModuleMock.buildEditsPrompt.mock.calls[1][0].retryContext;
    expect(retryContext).toMatchObject({ path: 'backend/health.js' });
    expect(retryContext.message).toMatch(/status 404/);
    expect(retryContext.scopeWarning).toMatch(/existing path/i);
    expect(retryContext.suggestedPaths).toEqual(['backend/routes/health.js']);
  });

  test('logs implementation file-op retries with a populated path', async () => {
    const args = defaultArgs();
    const fileOpError = new Error('write failed');
    fileOpError.__lucidcoderFileOpFailure = { path: 'frontend/src/App.jsx', status: 500 };

    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({ testsNeeded: false });
    automationModuleMock.applyEdits
      .mockRejectedValueOnce(fileOpError)
      .mockResolvedValueOnce({ applied: 1, skipped: 0 });

    const result = await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      { ...baseOptions, implementationAttemptSequence: [1, 2] }
    );

    expect(result).toEqual({ success: true });
    expect(automationModuleMock.automationLog).toHaveBeenCalledWith(
      'processGoal:llm:impl:fileOpRetry',
      expect.objectContaining({ path: 'frontend/src/App.jsx' })
    );
  });

  test('logs file-op retry with a null path when failure payload is empty', async () => {
    const fileOpError = new Error('write failed');
    fileOpError.__lucidcoderFileOpFailure = {};

    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({ testsNeeded: false });
    automationModuleMock.applyEdits
      .mockRejectedValueOnce(fileOpError)
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
      { ...baseOptions, implementationAttemptSequence: [1, 2] }
    );

    expect(result).toEqual({ success: true });
    expect(automationModuleMock.automationLog).toHaveBeenCalledWith(
      'processGoal:llm:impl:fileOpRetry',
      expect.objectContaining({ path: null })
    );
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

describe('processGoal coverage scope enforcement', () => {
  test('retries coverage goals when upserting into missing test folders', async () => {
    const args = defaultArgs();
    const coverageGoal = {
      ...args.goal,
      prompt: 'Add tests to cover uncovered line 1 in frontend/src/App.jsx',
      metadata: {
        uncoveredLines: [{ workspace: 'frontend', file: 'src/App.jsx', line: 1 }]
      }
    };

    automationModuleMock.flattenFileTree.mockReturnValue([
      'frontend/src/App.jsx',
      'frontend/src/__tests__/existing.test.jsx'
    ]);
    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({ testsNeeded: true });

    automationModuleMock.parseEditsFromLLM
      .mockReturnValueOnce([
        {
          type: 'upsert',
          path: 'frontend/src/test/App.test.jsx',
          content: 'test("stub", () => {});'
        }
      ])
      .mockReturnValueOnce([
        {
          type: 'upsert',
          path: 'frontend/src/__tests__/App.test.jsx',
          content: 'test("stub", () => {});'
        }
      ]);

    automationModuleMock.applyEdits.mockResolvedValue({ applied: 1, skipped: 0 });

    const result = await processGoal(
      coverageGoal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      {
        ...baseOptions,
        testsAttemptSequence: [1, 2]
      }
    );

    expect(result).toEqual({ success: true });
    expect(automationModuleMock.applyEdits).toHaveBeenCalledTimes(1);
    const retryContext = automationModuleMock.buildEditsPrompt.mock.calls[1][0].retryContext;
    expect(retryContext.path).toBe('frontend/src/test/App.test.jsx');
    expect(retryContext.message).toMatch(/existing test directories/i);
  });

  test('rejects coverage edits that modify non-test files', async () => {
    const args = defaultArgs();
    const coverageGoal = {
      ...args.goal,
      metadata: {
        uncoveredLines: [{ workspace: 'frontend', file: 'src/App.jsx', line: 1 }]
      }
    };

    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({ testsNeeded: true });
    automationModuleMock.parseEditsFromLLM.mockReturnValue([
      {
        type: 'modify',
        path: 'frontend/src/App.jsx',
        replacements: [{ search: 'const value = 1;', replace: 'const value = 2;' }]
      }
    ]);

    const result = await processGoal(
      coverageGoal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      { ...baseOptions, testsAttemptSequence: [1], implementationAttemptSequence: [1] }
    );

    expect(result).toEqual({ success: false, error: 'Coverage fixes are limited to test files only.' });
    expect(automationModuleMock.applyEdits).not.toHaveBeenCalled();
  });

  test('allows coverage edits within non-frontend workspaces that match the workspace prefix', async () => {
    const args = defaultArgs();
    const coverageGoal = {
      ...args.goal,
      metadata: {
        uncoveredLines: [{ workspace: 'shared', file: 'tests/sample.test.js', line: 1 }]
      }
    };

    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({ testsNeeded: true });
    automationModuleMock.parseEditsFromLLM.mockReturnValue([
      {
        type: 'modify',
        path: 'shared/__tests__/sample.test.js',
        replacements: [{ search: 'const value = 1;', replace: 'const value = 2;' }]
      }
    ]);
    automationModuleMock.applyEdits.mockResolvedValue({ applied: 1, skipped: 0 });

    const result = await processGoal(
      coverageGoal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      { ...baseOptions, testsAttemptSequence: [1], implementationAttemptSequence: [1] }
    );

    expect(result).toEqual({ success: true });
    expect(automationModuleMock.applyEdits).toHaveBeenCalledTimes(1);
  });

  test('allows upsert coverage edits in allowed prefixes when knownDirsSet is empty', async () => {
    const args = defaultArgs();
    const coverageGoal = {
      ...args.goal,
      metadata: {
        uncoveredLines: [{ workspace: 'frontend', file: 'src/App.jsx', line: 1 }]
      }
    };

    automationModuleMock.flattenFileTree.mockReturnValueOnce([]);
    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({ testsNeeded: true });
    automationModuleMock.parseEditsFromLLM.mockReturnValue([
      {
        type: 'upsert',
        path: 'frontend/src/__tests__/NewCoverage.test.jsx',
        content: 'test("ok", () => {});'
      }
    ]);
    automationModuleMock.applyEdits.mockResolvedValue({ applied: 1, skipped: 0 });

    const result = await processGoal(
      coverageGoal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      { ...baseOptions, testsAttemptSequence: [1], implementationAttemptSequence: [1] }
    );

    expect(result).toEqual({ success: true });
    expect(automationModuleMock.applyEdits).toHaveBeenCalledTimes(1);
  });

  test('allows coverage edits in test files under a workspace prefix outside allowed folders', async () => {
    const args = defaultArgs();
    const coverageGoal = {
      ...args.goal,
      metadata: {
        uncoveredLines: [{ workspace: 'backend', file: 'server.js', line: 1 }]
      }
    };

    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({ testsNeeded: true });
    automationModuleMock.parseEditsFromLLM.mockReturnValue([
      {
        type: 'modify',
        path: 'backend/custom/foo.test.js',
        replacements: [{ search: 'const value = 1;', replace: 'const value = 2;' }]
      }
    ]);
    automationModuleMock.applyEdits.mockResolvedValue({ applied: 1, skipped: 0 });

    const result = await processGoal(
      coverageGoal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      { ...baseOptions, testsAttemptSequence: [1], implementationAttemptSequence: [1] }
    );

    expect(result).toEqual({
      success: false,
      error: 'Coverage fixes must stay within dedicated test folders for the target workspace.'
    });
    expect(automationModuleMock.applyEdits).not.toHaveBeenCalled();
  });

  test('skips coverage validation when edit paths normalize to empty', async () => {
    const args = defaultArgs();
    const coverageGoal = {
      ...args.goal,
      metadata: {
        uncoveredLines: [{ workspace: 'frontend', file: 'src/App.jsx', line: 1 }]
      }
    };

    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({ testsNeeded: true });
    automationModuleMock.parseEditsFromLLM.mockReturnValue([
      {
        type: 'modify',
        path: '',
        replacements: [{ search: 'const value = 1;', replace: 'const value = 2;' }]
      }
    ]);
    automationModuleMock.applyEdits.mockResolvedValue({ applied: 1, skipped: 0 });

    const result = await processGoal(
      coverageGoal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      { ...baseOptions, testsAttemptSequence: [1], implementationAttemptSequence: [1] }
    );

    expect(result).toEqual({ success: true });
    expect(automationModuleMock.applyEdits).toHaveBeenCalledTimes(1);
    expect(automationModuleMock.applyEdits).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'tests' })
    );
  });

  test('retries file-op failures with empty basename paths and no suggestions', async () => {
    const args = defaultArgs();
    automationModuleMock.parseScopeReflectionResponse.mockReturnValueOnce({ testsNeeded: true });
    automationModuleMock.parseEditsFromLLM.mockReturnValue([
      {
        type: 'modify',
        path: 'frontend/src/test/Example.test.jsx',
        replacements: [{ search: 'const value = 1;', replace: 'const value = 2;' }]
      }
    ]);

    const fileOpError = new Error('write failed');
    fileOpError.__lucidcoderFileOpFailure = { path: 'backend/', status: 404 };

    automationModuleMock.applyEdits
      .mockRejectedValueOnce(fileOpError)
      .mockResolvedValueOnce({ applied: 1, skipped: 0 })
      .mockResolvedValueOnce({ applied: 1, skipped: 0 });

    const coverageGoal = {
      ...args.goal,
      metadata: { uncoveredLines: [{ workspace: 'frontend', file: 'src/App.jsx', lines: [10] }] }
    };

    const result = await processGoal(
      coverageGoal,
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
    const retryContext = automationModuleMock.buildEditsPrompt.mock.calls[1][0].retryContext;
    expect(retryContext.path).toBe('backend/');
    expect(retryContext.suggestedPaths).toEqual([]);
  });

  test('retries file-op failures with suggested paths from known files', async () => {
    const args = defaultArgs();
    automationModuleMock.parseScopeReflectionResponse.mockReturnValueOnce({ testsNeeded: true });
    automationModuleMock.flattenFileTree.mockReturnValueOnce([
      'frontend/src/test/one/foo.test.jsx',
      'frontend/src/test/two/foo.test.jsx',
      'frontend/src/test/three/foo.test.jsx',
      'frontend/src/test/four/foo.test.jsx',
      'frontend/src/test/five/foo.test.jsx'
    ]);
    automationModuleMock.parseEditsFromLLM.mockReturnValue([
      {
        type: 'modify',
        path: 'frontend/src/test/one/foo.test.jsx',
        replacements: [{ search: 'const value = 1;', replace: 'const value = 2;' }]
      }
    ]);

    const fileOpError = new Error('write failed');
    fileOpError.__lucidcoderFileOpFailure = { path: 'frontend/src/foo.test.jsx', status: 500 };

    automationModuleMock.applyEdits
      .mockRejectedValueOnce(fileOpError)
      .mockResolvedValueOnce({ applied: 1, skipped: 0 })
      .mockResolvedValueOnce({ applied: 1, skipped: 0 });

    const coverageGoal = {
      ...args.goal,
      metadata: { uncoveredLines: [{ workspace: 'frontend', file: 'src/App.jsx', lines: [10] }] }
    };

    const result = await processGoal(
      coverageGoal,
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
    const retryContext = automationModuleMock.buildEditsPrompt.mock.calls[1][0].retryContext;
    expect(retryContext.suggestedPaths.length).toBe(4);
  });

  test('retries file-op failures when the basename is missing', async () => {
    const args = defaultArgs();
    automationModuleMock.parseScopeReflectionResponse.mockReturnValueOnce({ testsNeeded: true });
    automationModuleMock.flattenFileTree.mockReturnValueOnce(['frontend/src/test/foo.test.jsx']);
    automationModuleMock.parseEditsFromLLM.mockReturnValue([
      {
        type: 'modify',
        path: 'frontend/src/test/foo.test.jsx',
        replacements: [{ search: 'const value = 1;', replace: 'const value = 2;' }]
      }
    ]);

    const fileOpError = new Error('write failed');
    fileOpError.__lucidcoderFileOpFailure = { path: '/', status: 500 };

    automationModuleMock.applyEdits
      .mockRejectedValueOnce(fileOpError)
      .mockResolvedValueOnce({ applied: 1, skipped: 0 })
      .mockResolvedValueOnce({ applied: 1, skipped: 0 });

    const coverageGoal = {
      ...args.goal,
      metadata: { uncoveredLines: [{ workspace: 'frontend', file: 'src/App.jsx', lines: [10] }] }
    };

    const result = await processGoal(
      coverageGoal,
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
    const retryContext = automationModuleMock.buildEditsPrompt.mock.calls[1][0].retryContext;
    expect(retryContext.suggestedPaths).toEqual([]);
  });

  test('retries file-op failures when known paths include non-strings', async () => {
    const args = defaultArgs();
    automationModuleMock.parseScopeReflectionResponse.mockReturnValueOnce({ testsNeeded: true });
    const nonStringPath = { includes: () => false };
    automationModuleMock.normalizeRepoPath.mockImplementation((value) => value);
    automationModuleMock.flattenFileTree.mockReturnValueOnce([
      nonStringPath,
      'frontend/src/test/foo.test.jsx'
    ]);
    automationModuleMock.parseEditsFromLLM.mockReturnValue([
      {
        type: 'modify',
        path: 'frontend/src/test/foo.test.jsx',
        replacements: [{ search: 'const value = 1;', replace: 'const value = 2;' }]
      }
    ]);

    const fileOpError = new Error('write failed');
    fileOpError.__lucidcoderFileOpFailure = { path: 'frontend/src/foo.test.jsx', status: 500 };

    automationModuleMock.applyEdits
      .mockRejectedValueOnce(fileOpError)
      .mockResolvedValueOnce({ applied: 1, skipped: 0 })
      .mockResolvedValueOnce({ applied: 1, skipped: 0 });

    const coverageGoal = {
      ...args.goal,
      metadata: { uncoveredLines: [{ workspace: 'frontend', file: 'src/App.jsx', lines: [10] }] }
    };

    const result = await processGoal(
      coverageGoal,
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
    const retryContext = automationModuleMock.buildEditsPrompt.mock.calls[1][0].retryContext;
    expect(retryContext.suggestedPaths).toContain('frontend/src/test/foo.test.jsx');
  });

  test('retries file-op failures without a path', async () => {
    const args = defaultArgs();
    automationModuleMock.parseScopeReflectionResponse.mockReturnValueOnce({ testsNeeded: true });
    automationModuleMock.flattenFileTree.mockReturnValueOnce(['frontend/src/test/foo.test.jsx']);
    automationModuleMock.parseEditsFromLLM.mockReturnValue([
      {
        type: 'modify',
        path: 'frontend/src/test/foo.test.jsx',
        replacements: [{ search: 'const value = 1;', replace: 'const value = 2;' }]
      }
    ]);

    const fileOpError = new Error('write failed');
    fileOpError.__lucidcoderFileOpFailure = { status: 500 };

    automationModuleMock.applyEdits
      .mockRejectedValueOnce(fileOpError)
      .mockResolvedValueOnce({ applied: 1, skipped: 0 })
      .mockResolvedValueOnce({ applied: 1, skipped: 0 });

    const coverageGoal = {
      ...args.goal,
      metadata: { uncoveredLines: [{ workspace: 'frontend', file: 'src/App.jsx', lines: [10] }] }
    };

    const result = await processGoal(
      coverageGoal,
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
    const retryContext = automationModuleMock.buildEditsPrompt.mock.calls[1][0].retryContext;
    expect(retryContext.scopeWarning).toBe('Use existing paths and directories from the repo tree.');
  });

  test('includes status in file-op retry messages', async () => {
    const args = defaultArgs();
    automationModuleMock.parseScopeReflectionResponse.mockReturnValueOnce({ testsNeeded: true });
    automationModuleMock.flattenFileTree.mockReturnValueOnce(['frontend/src/test/foo.test.jsx']);
    automationModuleMock.parseEditsFromLLM.mockReturnValue([
      {
        type: 'modify',
        path: 'frontend/src/test/foo.test.jsx',
        replacements: [{ search: 'const value = 1;', replace: 'const value = 2;' }]
      }
    ]);

    const fileOpError = new Error('write failed');
    fileOpError.__lucidcoderFileOpFailure = { path: 'frontend/src/foo.test.jsx', status: 418 };

    automationModuleMock.applyEdits
      .mockRejectedValueOnce(fileOpError)
      .mockResolvedValueOnce({ applied: 1, skipped: 0 })
      .mockResolvedValueOnce({ applied: 1, skipped: 0 });

    const coverageGoal = {
      ...args.goal,
      metadata: { uncoveredLines: [{ workspace: 'frontend', file: 'src/App.jsx', lines: [10] }] }
    };

    const result = await processGoal(
      coverageGoal,
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
    const retryContext = automationModuleMock.buildEditsPrompt.mock.calls[1][0].retryContext;
    expect(retryContext.message).toContain('status 418');
  });

  test('does not suggest paths when known path set is empty', async () => {
    const args = defaultArgs();
    automationModuleMock.parseScopeReflectionResponse.mockReturnValueOnce({ testsNeeded: true });
    automationModuleMock.flattenFileTree.mockReturnValueOnce([]);
    automationModuleMock.parseEditsFromLLM.mockReturnValue([
      {
        type: 'modify',
        path: 'frontend/src/test/foo.test.jsx',
        replacements: [{ search: 'const value = 1;', replace: 'const value = 2;' }]
      }
    ]);

    const fileOpError = new Error('write failed');
    fileOpError.__lucidcoderFileOpFailure = { path: 'frontend/src/foo.test.jsx', status: 500 };

    automationModuleMock.applyEdits
      .mockRejectedValueOnce(fileOpError)
      .mockResolvedValueOnce({ applied: 1, skipped: 0 })
      .mockResolvedValueOnce({ applied: 1, skipped: 0 });

    const coverageGoal = {
      ...args.goal,
      metadata: { uncoveredLines: [{ workspace: 'frontend', file: 'src/App.jsx', lines: [10] }] }
    };

    const result = await processGoal(
      coverageGoal,
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
    const retryContext = automationModuleMock.buildEditsPrompt.mock.calls[1][0].retryContext;
    expect(retryContext.suggestedPaths).toEqual([]);
  });

  test('uses basename-only suggestions for file-op retries', async () => {
    const args = defaultArgs();
    automationModuleMock.parseScopeReflectionResponse.mockReturnValueOnce({ testsNeeded: true });
    automationModuleMock.flattenFileTree.mockReturnValueOnce([
      'frontend/src/test/foo.test.jsx',
      'frontend/src/test/other.test.jsx'
    ]);
    automationModuleMock.parseEditsFromLLM.mockReturnValue([
      {
        type: 'modify',
        path: 'frontend/src/test/foo.test.jsx',
        replacements: [{ search: 'const value = 1;', replace: 'const value = 2;' }]
      }
    ]);

    const fileOpError = new Error('write failed');
    fileOpError.__lucidcoderFileOpFailure = { path: 'foo.test.jsx', status: 500 };

    automationModuleMock.applyEdits
      .mockRejectedValueOnce(fileOpError)
      .mockResolvedValueOnce({ applied: 1, skipped: 0 })
      .mockResolvedValueOnce({ applied: 1, skipped: 0 });

    const coverageGoal = {
      ...args.goal,
      metadata: { uncoveredLines: [{ workspace: 'frontend', file: 'src/App.jsx', lines: [10] }] }
    };

    const result = await processGoal(
      coverageGoal,
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
    const retryContext = automationModuleMock.buildEditsPrompt.mock.calls[1][0].retryContext;
    expect(retryContext.suggestedPaths).toContain('frontend/src/test/foo.test.jsx');
  });

  test('uses default retry message when status is not a number', async () => {
    const args = defaultArgs();
    automationModuleMock.parseScopeReflectionResponse.mockReturnValueOnce({ testsNeeded: true });
    automationModuleMock.flattenFileTree.mockReturnValueOnce(['frontend/src/test/foo.test.jsx']);
    automationModuleMock.parseEditsFromLLM.mockReturnValue([
      {
        type: 'modify',
        path: 'frontend/src/test/foo.test.jsx',
        replacements: [{ search: 'const value = 1;', replace: 'const value = 2;' }]
      }
    ]);

    const fileOpError = new Error('write failed');
    fileOpError.__lucidcoderFileOpFailure = { path: 'frontend/src/foo.test.jsx', status: 'oops' };

    automationModuleMock.applyEdits
      .mockRejectedValueOnce(fileOpError)
      .mockResolvedValueOnce({ applied: 1, skipped: 0 })
      .mockResolvedValueOnce({ applied: 1, skipped: 0 });

    const coverageGoal = {
      ...args.goal,
      metadata: { uncoveredLines: [{ workspace: 'frontend', file: 'src/App.jsx', lines: [10] }] }
    };

    const result = await processGoal(
      coverageGoal,
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
    const retryContext = automationModuleMock.buildEditsPrompt.mock.calls[1][0].retryContext;
    expect(retryContext.message).toBe('write failed');
  });

  test('treats null uncovered line entries as non-coverage goals', async () => {
    const args = defaultArgs();
    const goalWithNullCoverage = {
      ...args.goal,
      metadata: { uncoveredLines: [null] }
    };

    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({ testsNeeded: true });
    automationModuleMock.applyEdits.mockResolvedValue({ applied: 1, skipped: 0 });

    const result = await processGoal(
      goalWithNullCoverage,
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

  test('clones mustAvoid even when mustChange is not an array', async () => {
    const args = defaultArgs();
    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({
      mustChange: 'do-not-change',
      mustAvoid: ['avoid']
    });

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
    const payload = automationModuleMock.buildEditsPrompt.mock.calls[0][0];
    expect(payload.scopeReflection.mustAvoid).toEqual(['avoid']);
    expect(payload.scopeReflection.mustChange).toBe('do-not-change');
  });

  test('logs implementation file-op retries when they occur', async () => {
    const args = defaultArgs();
    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({ testsNeeded: false });
    automationModuleMock.applyEdits
      .mockRejectedValueOnce(Object.assign(new Error('write failed'), {
        __lucidcoderFileOpFailure: { path: 'frontend/src/App.jsx', status: 500 }
      }))
      .mockResolvedValueOnce({ applied: 1, skipped: 0 });

    const result = await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      { ...baseOptions, implementationAttemptSequence: [1, 2] }
    );

    expect(result).toEqual({ success: true });
    expect(automationModuleMock.automationLog).toHaveBeenCalledWith(
      'processGoal:llm:impl:fileOpRetry',
      expect.objectContaining({ path: 'frontend/src/App.jsx' })
    );
  });

  test('logs scope reflection details when tests are needed', async () => {
    const args = defaultArgs();
    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({ testsNeeded: true });

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
      'processGoal:scopeReflection',
      expect.objectContaining({ testsNeeded: true })
    );
  });

  test('clones scope reflection arrays for mustChange and mustAvoid', async () => {
    const args = defaultArgs();
    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({
      mustChange: ['a'],
      mustAvoid: ['b']
    });
    automationModuleMock.applyEdits.mockResolvedValue({ applied: 1, skipped: 0 });

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
    const payload = automationModuleMock.buildEditsPrompt.mock.calls[0][0];
    expect(payload.scopeReflection.mustChange).toEqual(['a']);
    expect(payload.scopeReflection.mustAvoid).toEqual(['b']);
  });

  test('retries file-op failures during implementation stage', async () => {
    const args = defaultArgs();
    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({ testsNeeded: true });
    automationModuleMock.applyEdits
      .mockResolvedValueOnce({ applied: 1, skipped: 0 })
      .mockRejectedValueOnce(Object.assign(new Error('write failed'), {
        __lucidcoderFileOpFailure: { path: 'frontend/src/App.jsx', status: 500 }
      }))
      .mockResolvedValueOnce({ applied: 1, skipped: 0 });

    const result = await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      { ...baseOptions, implementationAttemptSequence: [1, 2] }
    );

    expect(result).toEqual({ success: true });
    const retryContext = automationModuleMock.buildEditsPrompt.mock.calls[1][0].retryContext;
    expect(retryContext).toBeNull();
  });

  test('uses refreshed goals to update goal counts after a 404', async () => {
    const args = defaultArgs();
    goalsApiMock.advanceGoalPhase.mockImplementation(() => Promise.reject({ response: { status: 404 } }));
    goalsApiMock.fetchGoals.mockResolvedValueOnce([{ id: 1 }]);

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

    expect(result).toEqual({ success: false, skipped: true });
    expect(args.setGoalCount).toHaveBeenCalledWith(1);
  });

  test('sets goal count to zero when refreshed goals are not an array after 404', async () => {
    const args = defaultArgs();
    goalsApiMock.advanceGoalPhase.mockImplementation(() => Promise.reject({ response: { status: 404 } }));
    goalsApiMock.fetchGoals.mockResolvedValueOnce(null);

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

    expect(result).toEqual({ success: false, skipped: true });
    expect(args.setGoalCount).toHaveBeenCalledWith(0);
  });

  test('handles non-array uncovered lines metadata when computing coverage scope', async () => {
    const args = defaultArgs();
    const goalWithBadCoverage = {
      ...args.goal,
      metadata: { uncoveredLines: 'not-an-array' }
    };

    const result = await processGoal(
      goalWithBadCoverage,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      { ...baseOptions, enableScopeReflection: false }
    );

    expect(result).toEqual({ success: true });
  });

  test('trims workspace and file values when building coverage scope', async () => {
    const args = defaultArgs();
    const coverageGoal = {
      ...args.goal,
      metadata: {
        uncoveredLines: [{ workspace: ' frontend ', file: ' src/App.jsx ', line: 1 }]
      }
    };

    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({ testsNeeded: true });
    automationModuleMock.normalizeRepoPath.mockImplementation((value) => value);
    automationModuleMock.parseEditsFromLLM.mockReturnValue([
      {
        type: 'modify',
        path: 'frontend/src/test/App.test.jsx',
        replacements: [{ search: 'a', replace: 'b' }]
      }
    ]);
    automationModuleMock.applyEdits.mockResolvedValue({ applied: 1, skipped: 0 });

    const result = await processGoal(
      coverageGoal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      { ...baseOptions, testsAttemptSequence: [1], implementationAttemptSequence: [1] }
    );

    expect(result).toEqual({ success: true });
    expect(automationModuleMock.normalizeRepoPath).toHaveBeenCalledWith('frontend/src/App.jsx');
  });

  test('buildFileOpRetryContext defaults to empty failure info', () => {
    const retryContext = __processGoalTestHooks.buildFileOpRetryContext(new Error('oops'), new Set());

    expect(retryContext.path).toBeNull();
    expect(retryContext.suggestedPaths).toEqual([]);
    expect(retryContext.message).toBe('oops');
  });

  test('buildCoverageScope trims workspace and file values', () => {
    const coverageScope = __processGoalTestHooks.buildCoverageScope([
      { workspace: ' frontend ', file: ' src/App.jsx ' }
    ]);

    expect(coverageScope.workspacePrefixes.has('frontend/')).toBe(true);
  });

  test('buildCoverageScope handles non-string workspace and file values', () => {
    const coverageScope = __processGoalTestHooks.buildCoverageScope([
      { workspace: 123, file: 456 }
    ]);

    expect(coverageScope.workspacePrefixes.size).toBe(0);
  });

  test('buildCoverageScope returns null for empty or invalid inputs', () => {
    expect(__processGoalTestHooks.buildCoverageScope()).toBeNull();
    expect(__processGoalTestHooks.buildCoverageScope([])).toBeNull();
  });

  test('advances goal count when a missing goal is refreshed', async () => {
    const args = defaultArgs();
    goalsApiMock.advanceGoalPhase.mockImplementation(() => Promise.reject({ response: { status: 404 } }));
    goalsApiMock.fetchGoals.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);

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

    expect(result).toEqual({ success: false, skipped: true });
    expect(args.setGoalCount).toHaveBeenCalledWith(2);
  });

  test('treats non-array uncovered lines metadata as non-coverage goals', async () => {
    const args = defaultArgs();
    const goalWithBadCoverage = {
      ...args.goal,
      metadata: { uncoveredLines: 'not-an-array' }
    };

    const result = await processGoal(
      goalWithBadCoverage,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      { ...baseOptions, enableScopeReflection: false }
    );

    expect(result).toEqual({ success: true });
  });

  test('waits while paused before continuing', async () => {
    vi.useFakeTimers();
    const args = defaultArgs();
    const pauseSequence = [true, false];

    const resultPromise = processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      {
        ...baseOptions,
        enableScopeReflection: false,
        shouldPause: () => pauseSequence.shift() ?? false,
        shouldCancel: () => false
      }
    );

    await vi.advanceTimersByTimeAsync(200);
    const result = await resultPromise;
    vi.useRealTimers();

    expect(result).toEqual({ success: true });
  });

  test('cancels immediately when not paused but cancellation is requested', async () => {
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
      {
        ...baseOptions,
        shouldPause: () => false,
        shouldCancel: () => true
      }
    );

    expect(result).toEqual({ success: false, cancelled: true });
  });

  test('logs refresh errors when goal is missing and refresh fails', async () => {
    const args = defaultArgs();
    goalsApiMock.advanceGoalPhase.mockImplementation(() => Promise.reject({ response: { status: 404 } }));
    goalsApiMock.fetchGoals.mockRejectedValueOnce(new Error('refresh failed'));

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

    expect(result).toEqual({ success: false, skipped: true });
    expect(automationModuleMock.automationLog).toHaveBeenCalledWith(
      'processGoal:goalMissing:refreshError',
      expect.objectContaining({ message: 'refresh failed' })
    );
  });

  test('allows coverage edits when workspace prefixes are empty', async () => {
    const args = defaultArgs();
    const coverageGoal = {
      ...args.goal,
      metadata: {
        uncoveredLines: [{ workspace: '', file: 'src/App.jsx', line: 1 }]
      }
    };

    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({ testsNeeded: true });
    automationModuleMock.parseEditsFromLLM.mockReturnValue([
      {
        type: 'modify',
        path: 'frontend/src/test/Example.test.jsx',
        replacements: [{ search: 'const value = 1;', replace: 'const value = 2;' }]
      }
    ]);
    automationModuleMock.applyEdits.mockResolvedValue({ applied: 1, skipped: 0 });

    const result = await processGoal(
      coverageGoal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      { ...baseOptions, testsAttemptSequence: [1], implementationAttemptSequence: [1] }
    );

    expect(result).toEqual({ success: true });
    expect(automationModuleMock.applyEdits).toHaveBeenCalledTimes(1);
  });

  test('rejects new upsert test folders with suggested directories', async () => {
    const args = defaultArgs();
    const coverageGoal = {
      ...args.goal,
      metadata: {
        uncoveredLines: [{ workspace: 'frontend', file: 'src/App.jsx', line: 1 }]
      }
    };

    automationModuleMock.flattenFileTree.mockReturnValueOnce([
      'frontend/src/test/one/sample.test.jsx',
      'frontend/src/test/two/sample.test.jsx',
      'frontend/src/test/three/sample.test.jsx',
      'frontend/src/test/four/sample.test.jsx',
      'frontend/src/test/five/sample.test.jsx',
      'frontend/src/test/six/sample.test.jsx',
      'frontend/src/test/seven/sample.test.jsx'
    ]);
    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({ testsNeeded: true });
    automationModuleMock.parseEditsFromLLM.mockReturnValue([
      {
        type: 'upsert',
        path: 'frontend/src/test/new-folder/NewCoverage.test.jsx',
        content: 'test("ok", () => {});'
      }
    ]);

    const result = await processGoal(
      coverageGoal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      { ...baseOptions, testsAttemptSequence: [1], implementationAttemptSequence: [1] }
    );

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining('Suggested test folders')
    });
  });

  test('cancels when paused and cancellation is requested', async () => {
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
      {
        ...baseOptions,
        shouldPause: () => true,
        shouldCancel: () => true
      }
    );

    expect(result).toEqual({ success: false, cancelled: true });
  });

  test('returns early when scope reflection response is not an object', async () => {
    const args = defaultArgs();
    const coverageGoal = {
      ...args.goal,
      metadata: {
        uncoveredLines: [{ workspace: 'frontend', file: 'src/App.jsx', line: 1 }]
      }
    };

    automationModuleMock.parseScopeReflectionResponse.mockReturnValue('oops');
    automationModuleMock.parseEditsFromLLM.mockReturnValue([
      {
        type: 'modify',
        path: 'frontend/src/test/Example.test.jsx',
        replacements: [{ search: 'const value = 1;', replace: 'const value = 2;' }]
      }
    ]);
    automationModuleMock.applyEdits.mockResolvedValue({ applied: 1, skipped: 0 });

    const result = await processGoal(
      coverageGoal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      { ...baseOptions, testsAttemptSequence: [1], implementationAttemptSequence: [1] }
    );

    expect(result).toEqual({ success: true });
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

describe('processGoal implementation guards', () => {
  test('returns skipped when testing phase cannot advance', async () => {
    goalsApiMock.advanceGoalPhase.mockImplementation((goalId, phase) => {
      if (phase === 'testing') {
        return Promise.reject({ response: { status: 404 } });
      }
      return Promise.resolve();
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

    expect(result).toEqual({ success: false, skipped: true });
  });

  test('returns skipped when implementing phase cannot advance', async () => {
    goalsApiMock.advanceGoalPhase.mockImplementation((goalId, phase) => {
      if (phase === 'implementing') {
        return Promise.reject({ response: { status: 404 } });
      }
      return Promise.resolve();
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

    expect(result).toEqual({ success: false, skipped: true });
  });

  test('cancels before implementation when paused', async () => {
    let pauseCalls = 0;
    const shouldPause = () => {
      pauseCalls += 1;
      return pauseCalls >= 3;
    };
    const shouldCancel = () => pauseCalls >= 3;

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
      { ...baseOptions, shouldPause, shouldCancel }
    );

    expect(result).toEqual({ success: false, cancelled: true });
  });

  test('forces coverage scope validation during implementation', async () => {
    const args = defaultArgs();
    const coverageGoal = {
      ...args.goal,
      metadata: {
        uncoveredLines: [{ workspace: 'frontend', file: 'src/App.jsx', line: 1 }]
      }
    };

    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({ testsNeeded: false });
    automationModuleMock.parseEditsFromLLM
      .mockReturnValueOnce([
        {
          type: 'modify',
          path: 'frontend/src/App.jsx',
          replacements: [{ search: 'const value = 1;', replace: 'const value = 2;' }]
        }
      ])
      .mockReturnValueOnce([
        {
          type: 'upsert',
          path: 'frontend/src/__tests__/App.test.jsx',
          content: 'test("ok", () => {});'
        }
      ]);

    const result = await processGoal(
      coverageGoal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      { ...baseOptions, implementationAttemptSequence: [1, 2], __forceImplementationStage: true }
    );

    expect(result).toEqual({ success: true });
  });

  test('cancels after validation before applying implementation edits', async () => {
    let pauseCalls = 0;
    const shouldPause = () => {
      pauseCalls += 1;
      return pauseCalls >= 4;
    };
    const shouldCancel = () => pauseCalls >= 4;

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
      { ...baseOptions, shouldPause, shouldCancel }
    );

    expect(result).toEqual({ success: false, cancelled: true });
  });

  test('cancels after edits are applied', async () => {
    let pauseCalls = 0;
    const shouldPause = () => {
      pauseCalls += 1;
      return pauseCalls >= 5;
    };
    const shouldCancel = () => pauseCalls >= 5;

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
      { ...baseOptions, shouldPause, shouldCancel }
    );

    expect(result).toEqual({ success: false, cancelled: true });
  });

  test('cancels after parsing implementation edits but before applying them', async () => {
    const args = defaultArgs();
    automationModuleMock.parseScopeReflectionResponse.mockReturnValueOnce({ testsNeeded: false });

    let cancelNext = false;
    automationModuleMock.parseEditsFromLLM.mockImplementationOnce(() => {
      cancelNext = true;
      return [
        {
          type: 'modify',
          path: 'frontend/src/App.jsx',
          replacements: [{ search: 'const value = 1;', replace: 'const value = 2;' }]
        }
      ];
    });

    const result = await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      {
        ...baseOptions,
        testsAttemptSequence: [],
        implementationAttemptSequence: [1],
        shouldPause: () => false,
        shouldCancel: () => cancelNext
      }
    );

    expect(result).toEqual({ success: false, cancelled: true });
    expect(automationModuleMock.applyEdits).not.toHaveBeenCalled();
  });

  test('cancels after applying implementation edits but before verification', async () => {
    const args = defaultArgs();
    automationModuleMock.parseScopeReflectionResponse.mockReturnValueOnce({ testsNeeded: false });

    let cancelNext = false;
    automationModuleMock.applyEdits.mockImplementation(async ({ stage }) => {
      if (stage === 'implementation') {
        cancelNext = true;
      }
      return { applied: 1, skipped: 0 };
    });

    const result = await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      {
        ...baseOptions,
        testsAttemptSequence: [],
        implementationAttemptSequence: [1],
        shouldPause: () => false,
        shouldCancel: () => cancelNext
      }
    );

    expect(result).toEqual({ success: false, cancelled: true });
  });

  test('returns skipped when verifying phase cannot advance', async () => {
    goalsApiMock.advanceGoalPhase.mockImplementation((goalId, phase) => {
      if (phase === 'verifying') {
        return Promise.reject({ response: { status: 404 } });
      }
      return Promise.resolve();
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

    expect(result).toEqual({ success: false, skipped: true });
  });

  test('returns skipped when ready phase cannot advance', async () => {
    goalsApiMock.advanceGoalPhase.mockImplementation((goalId, phase) => {
      if (phase === 'ready') {
        return Promise.reject({ response: { status: 404 } });
      }
      return Promise.resolve();
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

    expect(result).toEqual({ success: false, skipped: true });
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
    expect(result.error).toContain('No repo edits were applied');
    expect(automationModuleMock.applyEdits).not.toHaveBeenCalled();
  });

  test('propagates implementation empty edits thrown during apply on the last attempt', async () => {
    const { buildEmptyEditsError } = __processGoalTestHooks;
    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({ testsNeeded: false });
    automationModuleMock.parseEditsFromLLM.mockReturnValue([
      {
        type: 'modify',
        path: 'frontend/src/App.jsx',
        replacements: [{ search: 'const value = 1;', replace: 'const value = 2;' }]
      }
    ]);
    automationModuleMock.applyEdits.mockRejectedValueOnce(buildEmptyEditsError('implementation'));

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
    expect(result.error).toMatch(/implementation stage/i);
    expect(automationModuleMock.applyEdits).toHaveBeenCalledTimes(1);
  });

  test('propagates implementation empty edits when required files must change on the last attempt', async () => {
    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({
      testsNeeded: false,
      mustChange: ['frontend/src/App.jsx']
    });
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
    expect(result.error).toMatch(/implementation stage/i);
    expect(automationModuleMock.applyEdits).not.toHaveBeenCalled();
  });

  test('does not allow implementation empty-edits fallback when selected assets are required', async () => {
    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({
      testsNeeded: false,
      mustChange: [],
      requiredAssetPaths: ['uploads/background.png']
    });
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
    expect(result.error).toMatch(/implementation stage/i);
    expect(automationModuleMock.applyEdits).not.toHaveBeenCalled();
  });
});

describe('processGoal guard coverage', () => {
  test('returns cancelled when pause guard fails after tests stage', async () => {
    let pauseCalls = 0;
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
      {
        ...baseOptions,
        enableScopeReflection: false,
        shouldPause: () => {
          pauseCalls += 1;
          return pauseCalls > 1;
        },
        shouldCancel: () => true
      }
    );

    expect(result).toEqual({ success: false, cancelled: true });
  });

  test('skips implementation when advancing phases fails with goal not found', async () => {
    goalsApiMock.advanceGoalPhase
      .mockResolvedValueOnce()
      .mockRejectedValueOnce({ response: { status: 404 } });

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
      { ...baseOptions, enableScopeReflection: false }
    );

    expect(result).toEqual({ success: false, skipped: true });
  });

  test('retries implementation edits after scope violations', async () => {
    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({ testsNeeded: true });
    automationModuleMock.validateEditsAgainstReflection
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ message: 'Stay scoped', path: 'frontend/src/App.jsx' })
      .mockReturnValueOnce(null);

    const args = defaultArgs();
    await processGoal(
      args.goal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      { ...baseOptions, implementationAttemptSequence: [1, 2] }
    );

    expect(automationModuleMock.buildEditsPrompt).toHaveBeenCalledTimes(3);
  });

  test('reports an error when no edits are applied across stages', async () => {
    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({ testsNeeded: true });
    automationModuleMock.applyEdits.mockResolvedValue({ applied: 0, skipped: 1 });

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
    expect(result.error).toMatch(/no repo edits were applied/i);
  });

  test('reports selected-asset specific error when no edits are applied for asset-backed style goals', async () => {
    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({
      testsNeeded: true,
      requiredAssetPaths: ['uploads/background.png']
    });
    automationModuleMock.applyEdits.mockResolvedValue({ applied: 0, skipped: 1 });

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
    expect(result.error).toMatch(/selected asset paths/i);
    expect(result.error).toContain('uploads/background.png');
  });

  test('injects selected project assets from goal prompt into scope reflection when present', async () => {
    automationModuleMock.parseScopeReflectionResponse.mockReturnValue({
      testsNeeded: true,
      mustChange: [],
      mustAvoid: []
    });

    const args = defaultArgs();
    const assetGoal = {
      ...args.goal,
      prompt: [
        'Update the site background image.',
        '',
        'Selected project assets:',
        '- uploads/hero-background.png',
        '- uploads/hero-background.png',
        '',
        'Current request: apply it to the main layout'
      ].join('\n')
    };

    await processGoal(
      assetGoal,
      args.projectId,
      args.projectPath,
      args.projectInfo,
      args.setPreviewPanelTab,
      args.setGoalCount,
      args.createMessage,
      args.setMessages,
      { ...baseOptions, implementationAttemptSequence: [1] }
    );

    const implementationPayload = getStagePromptPayloads('implementation')[0];
    expect(implementationPayload.scopeReflection.requiredAssetPaths).toEqual(['uploads/hero-background.png']);
  });

  test('removes approval listener in finally when processing fails', async () => {
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');

    goalsApiMock.advanceGoalPhase.mockImplementation((_, phase) => {
      if (phase === 'testing') {
        return Promise.reject(new Error('phase failure'));
      }
      return Promise.resolve();
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
      { ...baseOptions, implementationAttemptSequence: [1] }
    );

    expect(result.success).toBe(false);
    expect(addEventListenerSpy).toHaveBeenCalledWith('approval:decision', expect.any(Function));
    expect(removeEventListenerSpy).toHaveBeenCalledWith('approval:decision', expect.any(Function));

    addEventListenerSpy.mockRestore();
    removeEventListenerSpy.mockRestore();
  });
});

describe('__processGoalTestHooks helpers', () => {
  test('classifyInstructionOnlyGoal detects branch and stage prompts', () => {
    const { classifyInstructionOnlyGoal } = __processGoalTestHooks;

    expect(classifyInstructionOnlyGoal('Please create a branch for me')).toBe('branch-only');
    expect(classifyInstructionOnlyGoal('stage the updated files')).toBe('stage-only');
    expect(classifyInstructionOnlyGoal('Run the frontend dev server and verify visual integration')).toBe('verification-only');
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

  test('extractSelectedProjectAssets returns unique selected asset paths from prompt blocks', () => {
    const { extractSelectedProjectAssets } = __processGoalTestHooks;
    const prompt = [
      'Make the background match the selected image.',
      'Selected project assets:',
      '- uploads/background-one.png',
      '- uploads/background-one.png',
      '- uploads/background-two.jpg',
      '',
      'Current request: apply to shell'
    ].join('\n');

    expect(extractSelectedProjectAssets(prompt)).toEqual([
      'uploads/background-one.png',
      'uploads/background-two.jpg'
    ]);
    expect(extractSelectedProjectAssets(null)).toEqual([]);
  });

  test('extractSelectedProjectAssets skips pre-list noise and stops after the first completed list block', () => {
    const { extractSelectedProjectAssets } = __processGoalTestHooks;
    const prompt = [
      'Selected project assets:',
      '',
      'notes before the list should be ignored',
      '- uploads/hero.png',
      'end of list marker',
      '- uploads/ignored.png'
    ].join('\n');

    expect(extractSelectedProjectAssets(prompt)).toEqual(['uploads/hero.png']);
  });

  test('markTouchTrackerForPath marks frontend/backend/shared paths and ignores invalid values', () => {
    const { markTouchTrackerForPath } = __processGoalTestHooks;

    const tracker = { frontend: false, backend: false, __observed: false };
    markTouchTrackerForPath(tracker, 'frontend/src/App.jsx');
    expect(tracker).toEqual({ frontend: true, backend: false, __observed: true });

    markTouchTrackerForPath(tracker, 'backend/server.js');
    expect(tracker).toEqual({ frontend: true, backend: true, __observed: true });

    const sharedTracker = { frontend: false, backend: false, __observed: false };
    markTouchTrackerForPath(sharedTracker, 'shared/version.mjs');
    expect(sharedTracker).toEqual({ frontend: true, backend: true, __observed: true });

    const unchangedTracker = { frontend: false, backend: false, __observed: false };
    markTouchTrackerForPath(unchangedTracker, null);
    markTouchTrackerForPath(unchangedTracker, '');
    markTouchTrackerForPath(unchangedTracker, 'docs/README.md');
    expect(unchangedTracker).toEqual({ frontend: false, backend: false, __observed: false });
  });
});
