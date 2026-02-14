import { describe, expect, test } from 'vitest';
import {
  resolveFrontendFrameworks,
  resolveBackendFrameworks,
  sanitizeImportTab,
  guessProjectName
} from '../components/importProject/utils.js';

describe('import project utils', () => {
  test('resolves framework lists and fallback values', () => {
    expect(resolveFrontendFrameworks('javascript')).toContain('react');
    expect(resolveBackendFrameworks('python')).toContain('flask');
    expect(resolveFrontendFrameworks('unknown')).toEqual(['none']);
    expect(resolveBackendFrameworks('unknown')).toEqual(['none']);
  });

  test('sanitizes unsupported tabs to local', () => {
    expect(sanitizeImportTab('local')).toBe('local');
    expect(sanitizeImportTab('git')).toBe('git');
    expect(sanitizeImportTab('other')).toBe('local');
  });

  test('guessProjectName derives names from path-like values', () => {
    expect(guessProjectName('https://github.com/acme/repo.git')).toBe('repo');
    expect(guessProjectName('C:/Projects/demo')).toBe('demo');
    expect(guessProjectName('')).toBe('');
    expect(guessProjectName('path:')).toBe('');
  });
});
