import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensureBranch } from '../../services/goalAutomation/ensureBranch.js';
import axios from 'axios';
import { automationLog, requestBranchNameFromLLM, isBranchNameRelevantToPrompt } from '../../services/goalAutomation/automationUtils.js';

vi.mock('../../services/goalAutomation/automationUtils.js', () => ({
  automationLog: vi.fn(),
  requestBranchNameFromLLM: vi.fn(),
  buildFallbackBranchNameFromPrompt: vi.fn((prompt, fallbackName) => fallbackName),
  isBranchNameRelevantToPrompt: vi.fn(() => true)
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

  it('omits the description when the prompt is blank', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(123456);

    axios.get.mockResolvedValueOnce({ data: { workingBranches: [] } });
    axios.post.mockResolvedValueOnce({ data: { branch: { name: 'feature-blank' } } });
    requestBranchNameFromLLM.mockResolvedValueOnce('feature-blank');

    const result = await ensureBranch(20, '   ', setPreviewPanelTab, createMessage, setMessages);

    expect(result).toEqual({ name: 'feature-blank' });
    expect(axios.post).toHaveBeenCalledWith(
      '/api/projects/20/branches',
      expect.objectContaining({
        name: 'feature-blank',
        description: undefined
      })
    );

    nowSpy.mockRestore();
  });

  it('treats an undefined prompt as empty and omits the description', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(999999);

    axios.get.mockResolvedValueOnce({ data: { workingBranches: [] } });
    axios.post.mockResolvedValueOnce({ data: { branch: { name: 'feature-undef' } } });
    requestBranchNameFromLLM.mockResolvedValueOnce('feature-undef');

    const result = await ensureBranch(30, undefined, null, createMessage, setMessages);

    expect(result).toEqual({ name: 'feature-undef' });
    expect(axios.post).toHaveBeenCalledWith(
      '/api/projects/30/branches',
      expect.objectContaining({
        name: 'feature-undef',
        description: undefined
      })
    );

    expect(automationLog).toHaveBeenCalledWith(
      'ensureBranch:start',
      expect.objectContaining({ projectId: 30, prompt: '' })
    );

    nowSpy.mockRestore();
  });

  it('creates a new branch when none exist and syncs overview', async () => {
    axios.get
      .mockResolvedValueOnce({ data: { workingBranches: [] } })
      .mockResolvedValueOnce({ data: { workingBranches: [{ name: 'build-something' }] } });
    axios.post.mockResolvedValueOnce({ data: { branch: { name: 'build-something' } } });
    requestBranchNameFromLLM.mockResolvedValueOnce('build-something');

    const syncBranchOverview = vi.fn();

    const result = await ensureBranch(
      11,
      'Build something',
      setPreviewPanelTab,
      createMessage,
      setMessages,
      { syncBranchOverview }
    );

    expect(result).toEqual({ name: 'build-something' });
    expect(setPreviewPanelTab).toHaveBeenCalledWith('branches', { source: 'automation' });
    expect(syncBranchOverview).toHaveBeenCalledWith(11, { workingBranches: [{ name: 'build-something' }] });
    expect(createMessage).toHaveBeenCalledWith('assistant', 'Branch build-something created', { variant: 'status' });
  });

  it('treats the overview refresh as best-effort when refresh returns no data', async () => {
    axios.get
      .mockResolvedValueOnce({ data: { workingBranches: [] } })
      .mockResolvedValueOnce({ data: null });
    axios.post.mockResolvedValueOnce({ data: { branch: { name: 'feature-refresh' } } });
    requestBranchNameFromLLM.mockResolvedValueOnce('feature-refresh');

    const syncBranchOverview = vi.fn();

    const result = await ensureBranch(
      21,
      'Refresh without data',
      setPreviewPanelTab,
      createMessage,
      setMessages,
      { syncBranchOverview }
    );

    expect(result).toEqual({ name: 'feature-refresh' });
    expect(syncBranchOverview).not.toHaveBeenCalled();
  });

  it('treats the overview refresh as best-effort when refresh throws', async () => {
    axios.get
      .mockResolvedValueOnce({ data: { workingBranches: [] } })
      .mockRejectedValueOnce(new Error('refresh fail'));
    axios.post.mockResolvedValueOnce({ data: { branch: { name: 'feature-refresh-fail' } } });
    requestBranchNameFromLLM.mockResolvedValueOnce('feature-refresh-fail');

    const syncBranchOverview = vi.fn();

    const result = await ensureBranch(
      22,
      'Refresh throws',
      setPreviewPanelTab,
      createMessage,
      setMessages,
      { syncBranchOverview }
    );

    expect(result).toEqual({ name: 'feature-refresh-fail' });
    expect(syncBranchOverview).not.toHaveBeenCalled();
  });

  it('falls back to the generated fallback name when the LLM name is not relevant', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(424242);

    axios.get.mockResolvedValueOnce({ data: { workingBranches: [] } });
    axios.post.mockResolvedValueOnce({ data: {} });
    requestBranchNameFromLLM.mockResolvedValueOnce('nonsense-branch');
    isBranchNameRelevantToPrompt.mockReturnValueOnce(false);

    const result = await ensureBranch(16, 'Add login button', setPreviewPanelTab, createMessage, setMessages);

    expect(result).toEqual({ name: 'feature-424242' });
    expect(axios.post).toHaveBeenCalledWith(
      '/api/projects/16/branches',
      expect.objectContaining({ name: 'feature-424242' })
    );

    nowSpy.mockRestore();
  });

  it('creates a branch when workingBranches is not an array', async () => {
    axios.get.mockResolvedValueOnce({ data: { workingBranches: 'nope' } });
    axios.post.mockResolvedValueOnce({ data: { branch: { name: 'prompt-fallback' } } });
    requestBranchNameFromLLM.mockResolvedValueOnce('prompt-fallback');

    const result = await ensureBranch(15, 'Prompt', setPreviewPanelTab, createMessage, setMessages);

    expect(result).toEqual({ name: 'prompt-fallback' });
    expect(axios.post).toHaveBeenCalledWith(
      '/api/projects/15/branches',
      expect.objectContaining({ name: 'prompt-fallback', description: 'Prompt' })
    );
  });

  it('returns null on errors and logs automation errors', async () => {
    axios.get.mockRejectedValueOnce(new Error('boom'));

    const result = await ensureBranch(12, 'Prompt', setPreviewPanelTab, createMessage, setMessages);

    expect(result).toBeNull();
    expect(automationLog).toHaveBeenCalledWith('ensureBranch:error', expect.any(Object));
  });

  it('logs status codes when the error includes a response status', async () => {
    axios.get.mockRejectedValueOnce({ message: 'boom', response: { status: 500 } });

    const result = await ensureBranch(40, 'Prompt', setPreviewPanelTab, createMessage, setMessages);

    expect(result).toBeNull();
    expect(automationLog).toHaveBeenCalledWith(
      'ensureBranch:error',
      expect.objectContaining({ message: 'boom', status: 500 })
    );
  });

  it('tolerates null errors when logging failure details', async () => {
    axios.get.mockRejectedValueOnce(null);

    const result = await ensureBranch(41, 'Prompt', setPreviewPanelTab, createMessage, setMessages);

    expect(result).toBeNull();
    expect(automationLog).toHaveBeenCalledWith(
      'ensureBranch:error',
      expect.objectContaining({ message: undefined, status: undefined })
    );
  });
});
