import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as goalHandlers from './goalHandlers';
import * as goalsApi from '../../utils/goalsApi';
import * as ensureBranchModule from './ensureBranch';

vi.mock('./processGoal', () => ({
  processGoal: vi.fn().mockResolvedValue({ success: true })
}));

vi.mock('../../utils/goalsApi', () => ({
  fetchGoals: vi.fn(),
  planMetaGoal: vi.fn()
}));

vi.mock('./ensureBranch', () => ({
  ensureBranch: vi.fn()
}));

const mockProject = {
  id: 42,
  name: 'Test Project',
  path: '/test/path',
  framework: 'react',
  language: 'javascript'
};

const mockSetPreviewPanelTab = vi.fn();
const mockSetGoalCount = vi.fn();
const mockCreateMessage = vi.fn();
const mockSetMessages = vi.fn();

const buildTree = () => [
  {
    id: 1,
    prompt: 'Parent goal',
    children: [
      { id: 2, prompt: 'Child goal', children: [] }
    ]
  }
];

describe('goalHandlers processGoals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips parent goals by default when children exist', async () => {
    const result = await goalHandlers.processGoals(
      buildTree(),
      42,
      mockProject,
      mockSetPreviewPanelTab,
      mockSetGoalCount,
      mockCreateMessage,
      mockSetMessages
    );

    const { processGoal } = await import('./processGoal');

    expect(processGoal).toHaveBeenCalledTimes(1);
    expect(processGoal).toHaveBeenCalledWith(
      expect.objectContaining({ id: 2 }),
      42,
      mockProject.path,
      expect.stringContaining('Project: Test Project'),
      mockSetPreviewPanelTab,
      mockSetGoalCount,
      mockCreateMessage,
      mockSetMessages,
      expect.any(Object)
    );
    expect(result).toEqual({ success: true, processed: 1 });
  });

  it('returns immediately when no child goals are provided', async () => {
    const result = await goalHandlers.processGoals(
      [],
      42,
      mockProject,
      mockSetPreviewPanelTab,
      mockSetGoalCount,
      mockCreateMessage,
      mockSetMessages
    );

    expect(result).toEqual({ success: true, processed: 0 });
  });

  it('returns immediately when child goals are not an array', async () => {
    const result = await goalHandlers.processGoals(
      null,
      42,
      mockProject,
      mockSetPreviewPanelTab,
      mockSetGoalCount,
      mockCreateMessage,
      mockSetMessages
    );

    expect(result).toEqual({ success: true, processed: 0 });
  });

  it('processes parent goals when processParentGoals is enabled', async () => {
    const result = await goalHandlers.processGoals(
      buildTree(),
      42,
      mockProject,
      mockSetPreviewPanelTab,
      mockSetGoalCount,
      mockCreateMessage,
      mockSetMessages,
      { processParentGoals: true }
    );

    const { processGoal } = await import('./processGoal');

    expect(processGoal).toHaveBeenCalledTimes(2);
    expect(processGoal).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: 2 }),
      42,
      mockProject.path,
      expect.stringContaining('Project: Test Project'),
      mockSetPreviewPanelTab,
      mockSetGoalCount,
      mockCreateMessage,
      mockSetMessages,
      expect.any(Object)
    );
    expect(processGoal).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: 1 }),
      42,
      mockProject.path,
      expect.stringContaining('Project: Test Project'),
      mockSetPreviewPanelTab,
      mockSetGoalCount,
      mockCreateMessage,
      mockSetMessages,
      expect.any(Object)
    );
    expect(result).toEqual({ success: true, processed: 2 });
  });

  it('waits while paused before processing goals', async () => {
    vi.useFakeTimers();
    const shouldPause = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const shouldCancel = vi.fn().mockReturnValue(false);

    const resultPromise = goalHandlers.processGoals(
      buildTree(),
      42,
      mockProject,
      mockSetPreviewPanelTab,
      mockSetGoalCount,
      mockCreateMessage,
      mockSetMessages,
      { shouldPause, shouldCancel }
    );

    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(shouldPause).toHaveBeenCalled();
    expect(result).toEqual({ success: true, processed: 1 });
  });

  it('continues when a child goal is skipped', async () => {
    const { processGoal } = await import('./processGoal');
    processGoal.mockResolvedValueOnce({ success: true, skipped: true });

    const result = await goalHandlers.processGoals(
      buildTree(),
      42,
      mockProject,
      mockSetPreviewPanelTab,
      mockSetGoalCount,
      mockCreateMessage,
      mockSetMessages
    );

    expect(result).toEqual({ success: true, processed: 0 });
  });

  it('cancels processing when paused and cancelled', async () => {
    const result = await goalHandlers.processGoals(
      buildTree(),
      42,
      mockProject,
      mockSetPreviewPanelTab,
      mockSetGoalCount,
      mockCreateMessage,
      mockSetMessages,
      {
        shouldPause: () => true,
        shouldCancel: () => true
      }
    );

    expect(result).toEqual({ success: false, processed: 0, cancelled: true });
  });

  it('returns failure when a goal fails to process', async () => {
    const { processGoal } = await import('./processGoal');
    processGoal.mockResolvedValueOnce({ success: false });

    const result = await goalHandlers.processGoals(
      [{ id: 5, prompt: 'Solo', children: [] }],
      42,
      mockProject,
      mockSetPreviewPanelTab,
      mockSetGoalCount,
      mockCreateMessage,
      mockSetMessages
    );

    expect(result).toEqual({ success: false, processed: 0 });
  });

  it('returns cancelled when pause checks detect a cancel request', async () => {
    const result = await goalHandlers.processGoals(
      buildTree(),
      42,
      mockProject,
      mockSetPreviewPanelTab,
      mockSetGoalCount,
      mockCreateMessage,
      mockSetMessages,
      {
        shouldPause: () => true,
        shouldCancel: () => true
      }
    );

    expect(result).toEqual({ success: false, processed: 0, cancelled: true });
  });
});

describe('goalHandlers clarification paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses planned parent metadata clarifying questions in plan-only flow', async () => {
    vi.useFakeTimers();
    goalsApi.planMetaGoal.mockResolvedValue({
      parent: { metadata: { clarifyingQuestions: ['Need more detail'] } },
      children: [{ id: 1, prompt: 'Child goal' }]
    });
    goalsApi.fetchGoals.mockResolvedValue([]);
    ensureBranchModule.ensureBranch.mockResolvedValue();

    const setMessages = vi.fn((updater) => {
      if (typeof updater === 'function') {
        updater([]);
      }
    });
    const createMessage = vi.fn((role, text) => ({ role, text }));
    const processGoalsSpy = vi.spyOn(goalHandlers, 'processGoals');

    await goalHandlers.handlePlanOnlyFeature(
      101,
      mockProject,
      'Plan only request',
      mockSetPreviewPanelTab,
      mockSetGoalCount,
      createMessage,
      setMessages
    );

    await vi.runAllTimersAsync();

    expect(goalsApi.planMetaGoal).toHaveBeenCalled();
    expect(ensureBranchModule.ensureBranch).toHaveBeenCalled();
    expect(processGoalsSpy).not.toHaveBeenCalled();
    expect(createMessage).toHaveBeenCalledWith(
      'assistant',
      'I need clarification before proceeding:',
      { variant: 'status' }
    );
  });

  it('uses planned questions array in plan-only flow', async () => {
    vi.useFakeTimers();
    goalsApi.planMetaGoal.mockResolvedValue({
      questions: ['Which layout should we use?'],
      children: [{ id: 2, prompt: 'Child goal' }]
    });
    goalsApi.fetchGoals.mockResolvedValue([]);
    ensureBranchModule.ensureBranch.mockResolvedValue();

    const setMessages = vi.fn((updater) => {
      if (typeof updater === 'function') {
        updater([]);
      }
    });
    const createMessage = vi.fn((role, text) => ({ role, text }));

    await goalHandlers.handlePlanOnlyFeature(
      103,
      mockProject,
      'Plan only request',
      mockSetPreviewPanelTab,
      mockSetGoalCount,
      createMessage,
      setMessages
    );

    await vi.runAllTimersAsync();

    expect(createMessage).toHaveBeenCalledWith(
      'assistant',
      'Which layout should we use?',
      { variant: 'status' }
    );
  });

  it('uses result parent metadata clarifying questions in regular flow', async () => {
    vi.useFakeTimers();
    goalsApi.fetchGoals.mockResolvedValue([]);
    ensureBranchModule.ensureBranch.mockResolvedValue();

    const setMessages = vi.fn((updater) => {
      if (typeof updater === 'function') {
        updater([]);
      }
    });
    const createMessage = vi.fn((role, text) => ({ role, text }));

    const promise = goalHandlers.handleRegularFeature(
      202,
      mockProject,
      'Regular request',
      { parent: { metadata: { clarifyingQuestions: ['Clarify scope'] } } },
      mockSetPreviewPanelTab,
      mockSetGoalCount,
      createMessage,
      setMessages
    );

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({
      success: true,
      processed: 0,
      needsClarification: true,
      clarifyingQuestions: ['Clarify scope']
    });
    expect(ensureBranchModule.ensureBranch).toHaveBeenCalled();
  });

  it('uses result questions array in regular flow', async () => {
    vi.useFakeTimers();
    goalsApi.fetchGoals.mockResolvedValue([]);
    ensureBranchModule.ensureBranch.mockResolvedValue();

    const setMessages = vi.fn((updater) => {
      if (typeof updater === 'function') {
        updater([]);
      }
    });
    const createMessage = vi.fn((role, text) => ({ role, text }));

    const promise = goalHandlers.handleRegularFeature(
      204,
      mockProject,
      'Regular request',
      { questions: ['Confirm edge cases'] },
      mockSetPreviewPanelTab,
      mockSetGoalCount,
      createMessage,
      setMessages
    );

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({
      success: true,
      processed: 0,
      needsClarification: true,
      clarifyingQuestions: ['Confirm edge cases']
    });
    expect(createMessage).toHaveBeenCalledWith(
      'assistant',
      'Confirm edge cases',
      { variant: 'status' }
    );
  });
});
