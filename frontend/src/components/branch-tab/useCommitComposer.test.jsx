import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import axios from 'axios';
import { useAppState } from '../../context/AppStateContext';
import { useCommitComposer, fetchCommitContextForProject } from './useCommitComposer';

vi.mock('../../context/AppStateContext', () => ({
  useAppState: vi.fn()
}));

const mockedAxios = axios;

const baseProject = { id: 'proj-1', name: 'Demo Project' };

const createAppState = (overrides = {}) => ({
  isLLMConfigured: true,
  ...overrides
});

const temporarilyRemoveWindow = () => {
  const originalWindow = globalThis.window;
  globalThis.window = undefined;
  return () => {
    globalThis.window = originalWindow;
  };
};

describe('useCommitComposer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useAppState.mockReturnValue(createAppState());
  });

  afterEach(() => {
    useCommitComposer.__testHooks?.resetCommitTextParser?.();
  });

  const renderComposer = (props = {}) => renderHook(() => useCommitComposer({ project: baseProject, ...props }));

  test('loads persisted drafts and composes commit text', async () => {
    localStorage.setItem('commitMessageDrafts:proj-1', JSON.stringify({ 'feature/login': { subject: 'Initial', body: 'Body' } }));

    const { result } = renderComposer();

    await waitFor(() => {
      expect(result.current.getCommitSubjectForBranch('feature/login')).toBe('Initial');
    });
    expect(result.current.getCommitBodyForBranch('feature/login')).toBe('Body');
    expect(result.current.getCommitMessageForBranch('feature/login')).toContain('Initial');
  });

  test('returns empty commit drafts when branch has no entry', () => {
    const { result } = renderComposer();
    expect(result.current.getCommitMessageForBranch('missing-branch')).toBe('');
    expect(result.current.getCommitSubjectForBranch('missing-branch')).toBe('');
  });

  test('handles draft updates, clearing, and persistence lifecycle', async () => {
    const { result } = renderComposer();

    act(() => {
      result.current.handleCommitMessageChange('feature/login', { subject: 'Add auth', body: 'Implement login form' });
    });
    expect(result.current.getCommitSubjectForBranch('feature/login')).toBe('Add auth');

    act(() => {
      result.current.handleCommitMessageChange('feature/login', { subject: '' });
    });
    expect(result.current.getCommitBodyForBranch('feature/login')).toBe('Implement login form');

    act(() => {
      result.current.clearCommitMessageForBranch('feature/login');
    });
    expect(result.current.getCommitSubjectForBranch('feature/login')).toBe('');
  });

  test('handleCommitMessageAutofill bails when requirements are not met', async () => {
    const { result } = renderComposer();

    await act(async () => {
      await result.current.handleCommitMessageAutofill('feature/login', []);
    });
    expect(mockedAxios.post).not.toHaveBeenCalled();

    useAppState.mockReturnValue(createAppState({ isLLMConfigured: false }));
    const { result: disabledLLM } = renderComposer();
    await act(async () => {
      await disabledLLM.current.handleCommitMessageAutofill('feature/login', [{ path: 'src/App.jsx' }]);
    });
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  test('handleCommitMessageAutofill populates drafts when LLM responds with candidate', async () => {
    mockedAxios.get.mockResolvedValue({ data: { success: true, context: { files: [] } } });
    mockedAxios.post.mockResolvedValue({ data: { response: 'Implement login guard\n\nAdd routing checks' } });

    const { result } = renderComposer();

    await act(async () => {
      await result.current.handleCommitMessageAutofill('feature/login', [{ path: 'src/App.jsx' }]);
    });

    expect(mockedAxios.post).toHaveBeenCalledWith('/api/llm/generate', expect.any(Object));
    await waitFor(() => {
      expect(result.current.getCommitSubjectForBranch('feature/login')).toBe('Implement login guard');
      expect(result.current.getCommitBodyForBranch('feature/login')).toBe('Add routing checks');
    });
  });

  test('handleCommitMessageAutofill labels unnamed projects as workspace', async () => {
    mockedAxios.get.mockResolvedValue({ data: { success: true, context: { files: [] } } });
    mockedAxios.post.mockResolvedValue({ data: { response: 'Subject only' } });

    const { result } = renderComposer({ project: { id: 'proj-unnamed' } });

    await act(async () => {
      await result.current.handleCommitMessageAutofill('feature/login', [{ path: 'src/App.jsx' }]);
    });

    const [, payload] = mockedAxios.post.mock.calls[0];
    expect(payload.messages[1].content).toContain('Project: workspace');
  });

  test('handleCommitMessageAutofill includes diff excerpts and note lines in prompt when context warrants it', async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        success: true,
        context: {
          aggregateDiff: 'diff --git a/src/App.jsx b/src/App.jsx',
          isGitAvailable: false,
          truncated: true
        }
      }
    });
    mockedAxios.post.mockResolvedValue({ data: { response: 'Ship feature\n\nDescribe changes' } });

    const { result } = renderComposer();

    await act(async () => {
      await result.current.handleCommitMessageAutofill('feature/login', [{ path: 'src/App.jsx' }]);
    });

    const [, payload] = mockedAxios.post.mock.calls[0];
    const summaryPrompt = payload.messages[1].content;
    expect(summaryPrompt).toMatch(/Diff excerpts:/);
    expect(summaryPrompt).toMatch(/Notes: Git diff unavailable; rely on file summaries\. Some diff excerpts were truncated for brevity\./);
  });

  test('handleCommitMessageAutofill stores error when AI reply unusable after retries', async () => {
    mockedAxios.get.mockResolvedValue({ data: { success: true, context: { files: [] } } });
    mockedAxios.post.mockResolvedValue({ data: { response: '' } });

    const { result } = renderComposer();

    await act(async () => {
      await result.current.handleCommitMessageAutofill('feature/login', [{ path: 'src/App.jsx' }]);
    });

    expect(result.current.commitMessageError).toMatch(/usable commit message/i);
    expect(result.current.commitMessageRequest).toBe(null);
  });

  test('handleCommitMessageAutofill records API error details', async () => {
    const error = { response: { data: { error: 'LLM offline' } } };
    mockedAxios.get.mockResolvedValue({ data: { context: {} } });
    mockedAxios.post.mockRejectedValue(error);

    const { result } = renderComposer();

    await act(async () => {
      await result.current.handleCommitMessageAutofill('feature/login', [{ path: 'src/App.jsx' }]);
    });

    expect(result.current.commitMessageError).toBe('LLM offline');
  });

  test('handleCommitMessageAutofill falls back to generic error copy when API does not supply details', async () => {
    mockedAxios.get.mockResolvedValue({ data: { context: {} } });
    mockedAxios.post.mockRejectedValue(new Error('network unavailable'));

    const { result } = renderComposer();

    await act(async () => {
      await result.current.handleCommitMessageAutofill('feature/login', [{ path: 'src/App.jsx' }]);
    });

    expect(result.current.commitMessageError).toBe('Failed to generate commit message');
  });

  test('handleCommitMessageAutofill respects concurrent request guard', async () => {
    mockedAxios.get.mockResolvedValue({ data: { context: {} } });
    mockedAxios.post.mockResolvedValue({ data: { response: 'Fix docs' } });

    const { result } = renderComposer();

    let resolveAutofill;
    mockedAxios.post.mockImplementation(() => new Promise((resolve) => {
      resolveAutofill = () => resolve({ data: { response: 'Improve docs' } });
    }));

    await act(async () => {
      result.current.handleCommitMessageAutofill('feature/login', [{ path: 'src/main.js' }]);
    });

    await act(async () => {
      result.current.handleCommitMessageAutofill('feature/login', [{ path: 'src/app.js' }]);
    });
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveAutofill();
    });
  });

  test('handleCommitMessageAutofill honors NO_COMMIT sentinel', async () => {
    mockedAxios.get.mockResolvedValue({ data: { success: true, context: { files: [] } } });
    mockedAxios.post.mockResolvedValue({ data: { response: 'NO_COMMIT' } });

    const { result } = renderComposer();

    await act(async () => {
      await result.current.handleCommitMessageAutofill('feature/login', [{ path: 'src/App.jsx' }]);
    });

    expect(result.current.commitMessageError).toBe('AI could not produce a commit message. Please write one manually.');
    expect(result.current.commitMessageRequest).toBe(null);
  });

  test('handleCommitMessageAutofill retries unusable output and surfaces final warning', async () => {
    mockedAxios.get.mockResolvedValue({ data: { success: true, context: { files: [] } } });
    mockedAxios.post
      .mockResolvedValueOnce({ data: { response: ' - bullet list' } })
      .mockResolvedValueOnce({ data: { response: 'Fix' } });

    const { result } = renderComposer();

    await act(async () => {
      await result.current.handleCommitMessageAutofill('feature/login', [{ path: 'src/App.jsx' }]);
    });

    await waitFor(() => {
      expect(typeof result.current.commitMessageError).toBe('string');
      expect(result.current.commitMessageError).toMatch(/commit message/i);
    });
    expect(result.current.getCommitSubjectForBranch('feature/login')).toBe('');
  });

  test('handleCommitMessageAutofill references previous unusable attempt in follow-up prompt', async () => {
    mockedAxios.get.mockResolvedValue({ data: { success: true, context: { files: [] } } });
    mockedAxios.post
      .mockResolvedValueOnce({ data: { response: '- bullet list item' } })
      .mockResolvedValueOnce({ data: { response: '' } });

    const { result } = renderComposer();

    await act(async () => {
      await result.current.handleCommitMessageAutofill('feature/login', [{ path: 'src/app.js' }]);
    });

    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    const secondPrompt = mockedAxios.post.mock.calls[1][1].messages[1].content;
    expect(secondPrompt).toMatch(/Previous attempt was unusable/);
    expect(result.current.commitMessageError).toMatch(/commit message/i);
  });

  test('handleCommitMessageChange ignores invalid updates and prunes empty drafts', async () => {
    const { result } = renderComposer();

    act(() => {
      result.current.handleCommitMessageChange(undefined, { subject: 'ignored' });
    });
    expect(result.current.getCommitSubjectForBranch('')).toBe('');

    act(() => {
      result.current.handleCommitMessageChange('feature/login', 'invalid');
    });
    expect(result.current.getCommitSubjectForBranch('feature/login')).toBe('');

    act(() => {
      result.current.handleCommitMessageChange('feature/login', { subject: 'Ready', body: 'Details' });
    });
    expect(result.current.getCommitMessageForBranch('feature/login')).toBe('Ready\n\nDetails');

    act(() => {
      result.current.handleCommitMessageChange('feature/login', { subject: '', body: '' });
    });

    await waitFor(() => {
      expect(result.current.getCommitMessageForBranch('feature/login')).toBe('');
    });
  });

  test('handleCommitMessageChange coerces non-string updates to empty strings', () => {
    const { result } = renderComposer();

    act(() => {
      result.current.handleCommitMessageChange('feature/login', { subject: 42, body: ['details'] });
    });

    expect(result.current.getCommitSubjectForBranch('feature/login')).toBe('');
    expect(result.current.getCommitBodyForBranch('feature/login')).toBe('');
  });

  test('clearCommitMessageForBranch skips falsy names and missing drafts', async () => {
    const { result } = renderComposer();

    act(() => {
      result.current.handleCommitMessageChange('feature/login', { subject: 'Keep me' });
    });

    act(() => {
      result.current.clearCommitMessageForBranch('');
    });
    expect(result.current.getCommitSubjectForBranch('feature/login')).toBe('Keep me');

    act(() => {
      result.current.clearCommitMessageForBranch('unknown');
    });
    expect(result.current.getCommitSubjectForBranch('feature/login')).toBe('Keep me');

    act(() => {
      result.current.clearCommitMessageForBranch('feature/login');
    });

    await waitFor(() => {
      expect(result.current.getCommitSubjectForBranch('feature/login')).toBe('');
    });
  });

  test('persistDraftsToStorage logs a warning when storage write fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setItemSpy = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('persist fail');
    });

    const { result } = renderComposer();

    act(() => {
      result.current.handleCommitMessageChange('feature/login', { subject: 'Snapshot' });
    });

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith('Failed to persist commit message drafts', expect.any(Error));
    });

    setItemSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test('loadDraftsFromStorage guards windowless environments and parse failures', () => {
    const { loadDraftsFromStorage } = useCommitComposer.__testHooks;
    const restoreWindow = temporarilyRemoveWindow();
    expect(loadDraftsFromStorage('proj-1')).toEqual({});
    restoreWindow();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const getSpy = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => '{invalid json');
    expect(loadDraftsFromStorage('proj-1')).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith('Failed to parse commit message drafts from storage', expect.any(Error));
    getSpy.mockRestore();
    warnSpy.mockRestore();

    const guardSpy = vi.spyOn(window.localStorage, 'getItem');
    expect(loadDraftsFromStorage(null)).toEqual({});
    expect(guardSpy).not.toHaveBeenCalled();
    guardSpy.mockRestore();
  });

  test('persistDraftsToStorage no-ops when window or project id are missing', () => {
    const { persistDraftsToStorage } = useCommitComposer.__testHooks;
    const setItemSpy = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {});
    const removeItemSpy = vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => {});

    const restoreWindow = temporarilyRemoveWindow();
    persistDraftsToStorage('proj-1', { main: { subject: 'Add tests' } });
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(removeItemSpy).not.toHaveBeenCalled();
    restoreWindow();

    persistDraftsToStorage(null, { main: { subject: 'Add tests' } });
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(removeItemSpy).not.toHaveBeenCalled();

    setItemSpy.mockRestore();
    removeItemSpy.mockRestore();
  });

  test('parseCommitText normalizes empty inputs', () => {
    const { parseCommitText } = useCommitComposer.__testHooks;
    expect(parseCommitText()).toEqual({ subject: '', body: '' });
    expect(parseCommitText('\n   ')).toEqual({ subject: '', body: '' });
  });

  test('normalizeDraft helpers sanitize string entries and reject non-object maps', () => {
    const { normalizeDraftValue, normalizeDraftMap } = useCommitComposer.__testHooks;
    expect(normalizeDraftValue('Subject only')).toEqual({ subject: 'Subject only', body: '' });
    expect(normalizeDraftMap(null)).toEqual({});
    expect(normalizeDraftMap({ keep: { subject: 'Keep', body: '' }, drop: '' })).toEqual({
      keep: { subject: 'Keep', body: '' }
    });
  });

  test('normalizeDraftValue strips non-string subject and body fields', () => {
    const { normalizeDraftValue } = useCommitComposer.__testHooks;
    expect(normalizeDraftValue({ subject: 123, body: { text: 'body' } })).toEqual({ subject: '', body: '' });
  });

  test('buildDiffExcerpt falls back to per-file diffs when aggregate diff is missing', () => {
    const { buildDiffExcerpt } = useCommitComposer.__testHooks;
    const commitContext = {
      files: [
        { path: 'src/app.js', diff: 'diff chunk' },
        { path: 'src/ignore.js', diff: '' }
      ]
    };
    const { summaryBlock, diffBlock } = buildDiffExcerpt(commitContext, [{ path: 'src/app.js' }]);
    expect(summaryBlock).toContain('- src/app.js');
    expect(diffBlock).toContain('File: src/app.js');
    expect(diffBlock).toContain('diff chunk');
  });

  test('buildDiffExcerpt uses placeholder summary when no files are available', () => {
    const { buildDiffExcerpt } = useCommitComposer.__testHooks;
    const { summaryBlock } = buildDiffExcerpt({}, []);
    expect(summaryBlock).toBe('No staged files listed.');
  });

  test('buildDiffExcerpt prefers commitContext summary text when provided', () => {
    const { buildDiffExcerpt } = useCommitComposer.__testHooks;
    const commitContext = { summaryText: '  Updated feature summary  ' };
    const { summaryBlock } = buildDiffExcerpt(commitContext, [{ path: 'src/app.js' }]);
    expect(summaryBlock).toBe('Updated feature summary');
  });

  test('handleCommitMessageChange ignores empty updates for untouched branches', () => {
    const { result } = renderComposer();
    const initialDrafts = result.current.commitMessageDrafts;

    act(() => {
      result.current.handleCommitMessageChange('feature/empty', { subject: '', body: '' });
    });

    expect(result.current.commitMessageDrafts).toBe(initialDrafts);
    expect(result.current.getCommitSubjectForBranch('feature/empty')).toBe('');
  });

  test('handleCommitMessageChange preserves previous fields when updates omit them', () => {
    const { result } = renderComposer();

    act(() => {
      result.current.handleCommitMessageChange('feature/login', { subject: 'Initial subject', body: 'Initial body' });
    });

    act(() => {
      result.current.handleCommitMessageChange('feature/login', { body: 'Body only update' });
    });

    expect(result.current.getCommitSubjectForBranch('feature/login')).toBe('Initial subject');
    expect(result.current.getCommitBodyForBranch('feature/login')).toBe('Body only update');
  });

  test('handleCommitMessageAutofill truncates oversized diff excerpts', async () => {
    const longDiff = 'diff --git a/file b/file\n' + 'x'.repeat(9000);
    mockedAxios.get.mockResolvedValue({ data: { success: true, context: { aggregateDiff: longDiff } } });
    mockedAxios.post.mockResolvedValue({ data: { response: 'Subject line\n\nBody text' } });

    const { result } = renderComposer();

    await act(async () => {
      await result.current.handleCommitMessageAutofill('feature/login', [{ path: 'src/App.jsx' }]);
    });

    const [, payload] = mockedAxios.post.mock.calls[0];
    expect(payload.messages[1].content).toMatch(/…diff truncated…/);
  });

  test('handleCommitMessageAutofill reports missing subject line replies', async () => {
    mockedAxios.get.mockResolvedValue({ data: { success: true, context: { files: [] } } });
    mockedAxios.post
      .mockResolvedValueOnce({ data: { response: '\nBody only' } })
      .mockResolvedValueOnce({ data: { response: '\nStill no subject' } });

    useCommitComposer.__testHooks?.setCommitTextParser?.(() => ({
      subject: '',
      body: 'Only body text'
    }));

    const { result } = renderComposer();

    await act(async () => {
      await result.current.handleCommitMessageAutofill('feature/login', [{ path: 'src/app.js' }]);
    });

    await waitFor(() => {
      expect(result.current.commitMessageError).toBe('AI response did not include a subject line. Please edit manually.');
    });
  });

  test('fetchCommitContextForProject validates inputs and logs failures', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(fetchCommitContextForProject(null, 'branch')).resolves.toBeNull();
    await expect(fetchCommitContextForProject('proj-1', '')).resolves.toBeNull();

    mockedAxios.get.mockRejectedValueOnce(new Error('ctx fail'));
    await expect(fetchCommitContextForProject('proj-1', 'feature/login')).resolves.toBeNull();

    expect(warnSpy).toHaveBeenCalledWith('Failed to load commit context', expect.any(Error));

    warnSpy.mockRestore();
  });

  test('fetchCommitContextForProject returns context when API omits success flag', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { context: { summary: 'details' } } });
    await expect(fetchCommitContextForProject('proj-1', 'feature/login')).resolves.toEqual({ summary: 'details' });
  });

  test('fetchCommitContextForProject returns context when success flag is false but payload is present', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { success: false, context: { summary: 'fallback' } } });
    await expect(fetchCommitContextForProject('proj-1', 'feature/login')).resolves.toEqual({ summary: 'fallback' });
  });

  test('fetchCommitContextForProject falls back to null when success flag is false and payload missing', async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { success: false } });
    await expect(fetchCommitContextForProject('proj-1', 'feature/login')).resolves.toBeNull();
  });

  test('setCommitTextParser falls back to default when override is not a function', async () => {
    const { setCommitTextParser } = useCommitComposer.__testHooks;
    setCommitTextParser('not-a-function');

    mockedAxios.get.mockResolvedValue({ data: { success: true, context: { files: [] } } });
    mockedAxios.post.mockResolvedValue({ data: { response: 'Subject from AI' } });

    const { result } = renderComposer();

    await act(async () => {
      await result.current.handleCommitMessageAutofill('feature/login', [{ path: 'src/app.js' }]);
    });

    await waitFor(() => {
      expect(result.current.getCommitSubjectForBranch('feature/login')).toBe('Subject from AI');
    });
  });
});
