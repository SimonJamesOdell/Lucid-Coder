import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensureBranch } from '../../services/goalAutomation/ensureBranch.js';
import axios from 'axios';
import { automationLog, requestBranchNameFromLLM } from '../../services/goalAutomation/automationUtils.js';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn()
  }
}));

vi.mock('../../services/goalAutomation/automationUtils.js', () => ({
  automationLog: vi.fn(),
  requestBranchNameFromLLM: vi.fn()
}));

const createMessage = vi.fn((sender, text) => ({ sender, text }));
const setMessages = vi.fn((updater) => updater([]));
const setPreviewPanelTab = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  createMessage.mockClear();
  setMessages.mockClear();
  setPreviewPanelTab.mockClear();
});

describe('ensureBranch', () => {
  it('returns the existing working branch when present', async () => {
    axios.get.mockResolvedValueOnce({ data: { workingBranches: [{ name: 'feature/existing' }] } });

    const result = await ensureBranch(10, 'Prompt', setPreviewPanelTab, createMessage, setMessages);

    expect(result).toEqual({ name: 'feature/existing' });
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('creates a new branch when none exist and syncs overview', async () => {
    axios.get
      .mockResolvedValueOnce({ data: { workingBranches: [] } })
      .mockResolvedValueOnce({ data: { workingBranches: [{ name: 'feature/new' }] } });
    axios.post.mockResolvedValueOnce({ data: { branch: { name: 'feature/new' } } });
    requestBranchNameFromLLM.mockResolvedValueOnce('feature/new');

    const syncBranchOverview = vi.fn();

    const result = await ensureBranch(
      11,
      'Build something',
      setPreviewPanelTab,
      createMessage,
      setMessages,
      { syncBranchOverview }
    );

    expect(result).toEqual({ name: 'feature/new' });
    expect(setPreviewPanelTab).toHaveBeenCalledWith('branches', { source: 'automation' });
    expect(syncBranchOverview).toHaveBeenCalledWith(11, { workingBranches: [{ name: 'feature/new' }] });
    expect(createMessage).toHaveBeenCalledWith('assistant', 'Branch feature/new created', { variant: 'status' });
  });

  it('creates a branch when workingBranches is not an array', async () => {
    axios.get.mockResolvedValueOnce({ data: { workingBranches: 'nope' } });
    axios.post.mockResolvedValueOnce({ data: { branch: { name: 'feature/fallback' } } });
    requestBranchNameFromLLM.mockResolvedValueOnce('feature/fallback');

    const result = await ensureBranch(15, 'Prompt', setPreviewPanelTab, createMessage, setMessages);

    expect(result).toEqual({ name: 'feature/fallback' });
    expect(axios.post).toHaveBeenCalledWith('/api/projects/15/branches', { name: 'feature/fallback' });
  });

  it('returns null on errors and logs automation errors', async () => {
    axios.get.mockRejectedValueOnce(new Error('boom'));

    const result = await ensureBranch(12, 'Prompt', setPreviewPanelTab, createMessage, setMessages);

    expect(result).toBeNull();
    expect(automationLog).toHaveBeenCalledWith('ensureBranch:error', expect.any(Object));
  });
});
