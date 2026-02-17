import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getAssistantAssetContextPaths,
  setAssistantAssetContextPaths,
  clearAssistantAssetContextPaths,
  ASSISTANT_ASSET_CONTEXT_CHANGED_EVENT
} from '../../utils/assistantAssetContext.js';

const STORAGE_KEY = 'lucidcoder:assistantAssetContextByProject';

describe('assistantAssetContext utils', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.clear();
    }
  });

  it('returns an empty list when project id is missing', () => {
    expect(getAssistantAssetContextPaths(undefined)).toEqual([]);
    expect(setAssistantAssetContextPaths(null, ['frontend/src/App.jsx'])).toEqual([]);
    expect(clearAssistantAssetContextPaths('')).toEqual([]);
  });

  it('returns an empty list when stored JSON is malformed', () => {
    window.localStorage.setItem(STORAGE_KEY, '{not-json');

    expect(getAssistantAssetContextPaths('project-1')).toEqual([]);
  });

  it('returns an empty list when stored JSON parses to a non-object value', () => {
    window.localStorage.setItem(STORAGE_KEY, 'null');

    expect(getAssistantAssetContextPaths('project-1')).toEqual([]);
  });

  it('handles environments where localStorage is unavailable', () => {
    vi.spyOn(window, 'localStorage', 'get').mockReturnValue(undefined);

    expect(getAssistantAssetContextPaths('project-1')).toEqual([]);
    expect(setAssistantAssetContextPaths('project-1', [' b ', 'a', 'a'])).toEqual(['a', 'b']);
  });

  it('dispatches a changed event with normalized paths', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    const paths = setAssistantAssetContextPaths('project-2', [' src/App.jsx ', 'src/App.jsx']);

    expect(paths).toEqual(['src/App.jsx']);
    expect(dispatchSpy).toHaveBeenCalled();

    const event = dispatchSpy.mock.calls.at(-1)?.[0];
    expect(event.type).toBe(ASSISTANT_ASSET_CONTEXT_CHANGED_EVENT);
    expect(event.detail).toEqual({
      projectId: 'project-2',
      paths: ['src/App.jsx']
    });
  });
});