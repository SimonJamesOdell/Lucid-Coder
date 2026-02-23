import { beforeEach, describe, expect, test, vi } from 'vitest';

const goalsApiMock = vi.hoisted(() => ({
  fetchGoals: vi.fn(),
  planMetaGoal: vi.fn()
}));
vi.mock('../../utils/goalsApi', () => goalsApiMock);

const ensureBranchMock = vi.hoisted(() => ({
  ensureBranch: vi.fn()
}));
vi.mock('../../services/goalAutomation/ensureBranch', () => ensureBranchMock);

const processGoalMock = vi.hoisted(() => ({
  processGoal: vi.fn()
}));
vi.mock('../../services/goalAutomation/processGoal', () => processGoalMock);

const automationUtilsMock = vi.hoisted(() => ({
  notifyGoalsUpdated: vi.fn()
}));
vi.mock('../../services/goalAutomation/automationUtils', () => automationUtilsMock);

import { processGoals } from '../../services/goalAutomation/goalHandlers';

describe('goalHandlers preview-tab guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    processGoalMock.processGoal.mockResolvedValue({ success: true });
  });

  test('skips preview tab updates when preservePreviewTab is enabled', async () => {
    const setPreviewPanelTab = vi.fn();
    const setGoalCount = vi.fn();
    const setMessages = vi.fn();
    const createMessage = vi.fn((sender, text, options) => ({ sender, text, options }));

    const result = await processGoals(
      [{ id: 1, prompt: 'Apply style change' }],
      123,
      { name: 'Demo', path: '/repo/demo', framework: 'react', language: 'javascript' },
      setPreviewPanelTab,
      setGoalCount,
      createMessage,
      setMessages,
      { preservePreviewTab: true }
    );

    expect(result).toEqual({ success: true, processed: 1, styleShortcutChangeApplied: false });
    expect(setPreviewPanelTab).not.toHaveBeenCalled();
  });

  test('updates preview tab to goals when preservePreviewTab is not enabled', async () => {
    const setPreviewPanelTab = vi.fn();
    const setGoalCount = vi.fn();
    const setMessages = vi.fn();
    const createMessage = vi.fn((sender, text, options) => ({ sender, text, options }));

    const result = await processGoals(
      [{ id: 2, prompt: 'Apply feature change' }],
      123,
      { name: 'Demo', path: '/repo/demo', framework: 'react', language: 'javascript' },
      setPreviewPanelTab,
      setGoalCount,
      createMessage,
      setMessages,
      {}
    );

    expect(result).toEqual({ success: true, processed: 1, styleShortcutChangeApplied: false });
    expect(setPreviewPanelTab).toHaveBeenCalledWith('goals', { source: 'automation' });
  });

  test('stops processing remaining goals after first applied shortcut change in preserve mode', async () => {
    const setPreviewPanelTab = vi.fn();
    const setGoalCount = vi.fn();
    const setMessages = vi.fn();
    const createMessage = vi.fn((sender, text, options) => ({ sender, text, options }));

    processGoalMock.processGoal.mockImplementationOnce(async (_goal, _projectId, _projectPath, _projectInfo, _setPreviewPanelTab, _setGoalCount, _createMessage, _setMessages, options) => {
      options.__styleShortcutChangeApplied = true;
      return { success: true };
    });

    const result = await processGoals(
      [
        { id: 10, prompt: 'Apply style change' },
        { id: 11, prompt: 'Follow-up housekeeping goal' }
      ],
      123,
      { name: 'Demo', path: '/repo/demo', framework: 'react', language: 'javascript' },
      setPreviewPanelTab,
      setGoalCount,
      createMessage,
      setMessages,
      { preservePreviewTab: true }
    );

    expect(result).toEqual({ success: true, processed: 1, styleShortcutChangeApplied: true });
    expect(processGoalMock.processGoal).toHaveBeenCalledTimes(1);
    expect(setPreviewPanelTab).not.toHaveBeenCalled();
  });

  test('reports styleShortcutChangeApplied=false when preserve-mode goals finish without applied edits', async () => {
    const setPreviewPanelTab = vi.fn();
    const setGoalCount = vi.fn();
    const setMessages = vi.fn();
    const createMessage = vi.fn((sender, text, options) => ({ sender, text, options }));

    processGoalMock.processGoal.mockResolvedValueOnce({ success: true, skipped: true, skippedReason: 'style-shortcut-scope' });

    const result = await processGoals(
      [{ id: 20, prompt: 'Try style-only change' }],
      123,
      { name: 'Demo', path: '/repo/demo', framework: 'react', language: 'javascript' },
      setPreviewPanelTab,
      setGoalCount,
      createMessage,
      setMessages,
      { preservePreviewTab: true }
    );

    expect(result).toEqual({ success: true, processed: 0, styleShortcutChangeApplied: false });
    expect(setPreviewPanelTab).not.toHaveBeenCalled();
  });
});
