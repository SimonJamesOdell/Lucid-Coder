import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ASSISTANT_ELEMENT_CONTEXT_CHANGED_EVENT,
  clearAssistantElementContextPath,
  getAssistantElementContextPath,
  setAssistantElementContextPath
} from '../../utils/assistantElementContext.js';

const STORAGE_KEY = 'lucidcoder:assistantElementContextByProject';

describe('assistantElementContext utils', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.clear();
    }
  });

  it('returns empty string when project id is missing', () => {
    expect(getAssistantElementContextPath(undefined)).toBe('');
    expect(setAssistantElementContextPath(null, 'main > button')).toBe('');
    expect(clearAssistantElementContextPath('')).toBe('');
  });

  it('returns empty string when stored JSON is malformed', () => {
    window.localStorage.setItem(STORAGE_KEY, '{not-json');

    expect(getAssistantElementContextPath('project-1')).toBe('');
  });

  it('returns empty string when stored JSON parses to a non-object value', () => {
    window.localStorage.setItem(STORAGE_KEY, 'null');

    expect(getAssistantElementContextPath('project-1')).toBe('');
  });

  it('handles environments where localStorage is unavailable', () => {
    vi.spyOn(window, 'localStorage', 'get').mockReturnValue(undefined);

    expect(getAssistantElementContextPath('project-1')).toBe('');
    expect(setAssistantElementContextPath('project-1', ' main > section ')).toBe('main > section');
    expect(clearAssistantElementContextPath('project-1')).toBe('');
  });

  it('stores and reads a trimmed element path for a project', () => {
    const nextPath = setAssistantElementContextPath('project-2', '  body > main:nth-of-type(1)  ');

    expect(nextPath).toBe('body > main:nth-of-type(1)');
    expect(getAssistantElementContextPath('project-2')).toBe('body > main:nth-of-type(1)');
  });

  it('clears stored element path when path normalizes to empty', () => {
    setAssistantElementContextPath('project-3', 'app > div:nth-of-type(2)');
    expect(getAssistantElementContextPath('project-3')).toBe('app > div:nth-of-type(2)');

    const cleared = setAssistantElementContextPath('project-3', '   ');
    expect(cleared).toBe('');
    expect(getAssistantElementContextPath('project-3')).toBe('');
  });

  it('dispatches changed event with normalized detail', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    const path = setAssistantElementContextPath('project-4', ' main > button.primary ');

    expect(path).toBe('main > button.primary');
    expect(dispatchSpy).toHaveBeenCalled();

    const event = dispatchSpy.mock.calls.at(-1)?.[0];
    expect(event.type).toBe(ASSISTANT_ELEMENT_CONTEXT_CHANGED_EVENT);
    expect(event.detail).toEqual({
      projectId: 'project-4',
      path: 'main > button.primary'
    });
  });
});
