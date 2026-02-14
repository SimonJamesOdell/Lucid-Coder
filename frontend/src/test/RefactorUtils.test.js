import { describe, expect, test } from 'vitest';
import {
  guessProjectName,
  normalizeServerProgress,
  isEmptyProgressSnapshot
} from '../components/create-project/progressUtils';
import {
  normalizeHostname,
  normalizeBrowserProtocol,
  getDevServerOriginFromWindow
} from '../components/preview-tab/originUtils';

describe('refactor utility modules', () => {
  test('guessProjectName derives expected names from git-like paths', () => {
    expect(guessProjectName('https://github.com/org/repo.git')).toBe('repo');
    expect(guessProjectName('git@github.com:org/repo.git')).toBe('repo');
    expect(guessProjectName('')).toBe('');
  });

  test('normalizeServerProgress falls back and clamps completion', () => {
    const pending = normalizeServerProgress(null);
    expect(pending.status).toBe('pending');
    expect(pending.completion).toBe(0);

    const clamped = normalizeServerProgress({ completion: 1000, status: 'in-progress', steps: [] });
    expect(clamped.completion).toBe(100);
  });

  test('isEmptyProgressSnapshot only marks truly empty snapshots', () => {
    expect(isEmptyProgressSnapshot(null)).toBe(true);
    expect(isEmptyProgressSnapshot({ steps: [], status: null, completion: null, statusMessage: '', error: '' })).toBe(true);
    expect(isEmptyProgressSnapshot({ steps: [{ name: 'x', completed: false }] })).toBe(false);
  });

  test('origin helpers normalize host/protocol and build dev origin', () => {
    expect(normalizeHostname(' 0.0.0.0 ')).toBe('localhost');
    expect(normalizeBrowserProtocol('ftp:')).toBe('http:');

    const origin = getDevServerOriginFromWindow({ port: 5173, hostnameOverride: '0.0.0.0' });
    expect(origin).toMatch(/http:\/\/localhost:5173|https:\/\/localhost:5173/);
  });
});
