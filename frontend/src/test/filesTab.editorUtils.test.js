import { describe, expect, test } from 'vitest';
import {
  DEFAULT_EXPLORER_WIDTH,
  MIN_EXPLORER_WIDTH,
  MAX_EXPLORER_WIDTH,
  clampExplorerWidth,
  getLanguageFromFile
} from '../components/filesTab/editorUtils';

describe('files tab editor utils', () => {
  test('clampExplorerWidth handles bounds and invalid values', () => {
    expect(clampExplorerWidth(undefined)).toBe(DEFAULT_EXPLORER_WIDTH);
    expect(clampExplorerWidth(MIN_EXPLORER_WIDTH - 50)).toBe(MIN_EXPLORER_WIDTH);
    expect(clampExplorerWidth(MAX_EXPLORER_WIDTH + 50)).toBe(MAX_EXPLORER_WIDTH);
    expect(clampExplorerWidth(300)).toBe(300);
  });

  test('getLanguageFromFile resolves known extensions and fallback', () => {
    expect(getLanguageFromFile({ name: 'main.tsx' })).toBe('typescript');
    expect(getLanguageFromFile({ name: 'README.md' })).toBe('markdown');
    expect(getLanguageFromFile({ name: 'unknown.zzz' })).toBe('plaintext');
    expect(getLanguageFromFile(null)).toBe('plaintext');
  });
});
