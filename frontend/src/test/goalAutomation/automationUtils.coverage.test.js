import { describe, test, expect } from 'vitest';
import {
  buildFallbackBranchNameFromPrompt,
  isBranchNameRelevantToPrompt
} from '../../services/goalAutomation/automationUtils.js';

describe('automationUtils coverage helpers', () => {
  test('buildFallbackBranchNameFromPrompt returns fallback when prompt is empty', () => {
    expect(buildFallbackBranchNameFromPrompt('', 'feature-123')).toBe('feature-123');
    expect(buildFallbackBranchNameFromPrompt('   ', 'feature-123')).toBe('feature-123');
  });

  test('buildFallbackBranchNameFromPrompt tolerates missing fallbackName', () => {
    expect(buildFallbackBranchNameFromPrompt('', undefined)).toBe('');
  });

  test('buildFallbackBranchNameFromPrompt returns fallback when prompt yields too few usable tokens', () => {
    expect(buildFallbackBranchNameFromPrompt('12345 67890', 'feature-xyz')).toBe('feature-xyz');
    expect(buildFallbackBranchNameFromPrompt('Refactor', 'feature-xyz')).toBe('feature-xyz');
  });

  test('isBranchNameRelevantToPrompt returns true when tokenization yields no signal', () => {
    expect(isBranchNameRelevantToPrompt('feature/something', '')).toBe(true);
    expect(isBranchNameRelevantToPrompt('', 'some prompt')).toBe(true);
    expect(isBranchNameRelevantToPrompt('feature/something', 'refactor')).toBe(true);
  });

  test('isBranchNameRelevantToPrompt checks for token overlap when prompt is specific', () => {
    expect(isBranchNameRelevantToPrompt('feature/added-login-button', 'Add login button to header')).toBe(true);
    expect(isBranchNameRelevantToPrompt('feature/updated-readme', 'Add login button to header')).toBe(false);
  });
});
