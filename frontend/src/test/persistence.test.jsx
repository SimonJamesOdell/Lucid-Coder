import { describe, test, expect, beforeEach, vi } from 'vitest';
import {
  loadGitSettingsFromStorage,
  loadGitConnectionStatusFromStorage,
  defaultGitSettings,
  defaultGitConnectionStatus
} from '../context/appState/persistence.js';

describe('persistence helpers', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  test('loadGitSettingsFromStorage strips deprecated fields', () => {
    localStorage.setItem('gitSettings', JSON.stringify({
      ...defaultGitSettings,
      autoPush: true,
      useCommitTemplate: true,
      commitTemplate: 'feat: {title}'
    }));

    const loaded = loadGitSettingsFromStorage();
    expect(loaded.autoPush).toBeUndefined();
    expect(loaded.useCommitTemplate).toBeUndefined();
    expect(loaded.commitTemplate).toBeUndefined();
  });

  test('loadGitConnectionStatusFromStorage returns defaults on missing or invalid data', () => {
    const missing = loadGitConnectionStatusFromStorage();
    expect(missing).toEqual(defaultGitConnectionStatus);

    localStorage.setItem('gitConnectionStatus', '{not-json');
    const invalid = loadGitConnectionStatusFromStorage();
    expect(invalid).toEqual(defaultGitConnectionStatus);
  });

  test('loadGitConnectionStatusFromStorage merges stored values', () => {
    localStorage.setItem('gitConnectionStatus', JSON.stringify({
      provider: 'github',
      account: { login: 'octo' },
      message: 'Connected',
      testedAt: '2026-01-01T00:00:00.000Z'
    }));

    const loaded = loadGitConnectionStatusFromStorage();

    expect(loaded).toMatchObject({
      provider: 'github',
      account: { login: 'octo' },
      message: 'Connected',
      testedAt: '2026-01-01T00:00:00.000Z'
    });
  });

  test('loadGitConnectionStatusFromStorage returns defaults when window is undefined', () => {
    const originalWindow = global.window;
    global.window = undefined;

    const loaded = loadGitConnectionStatusFromStorage();
    expect(loaded).toEqual(defaultGitConnectionStatus);

    global.window = originalWindow;
  });
});
