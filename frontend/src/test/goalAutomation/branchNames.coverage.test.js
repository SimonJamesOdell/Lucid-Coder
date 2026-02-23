import { describe, test, expect } from 'vitest';
import {
  extractBranchName,
  parseBranchNameFromLLMText,
  extractBranchPromptContext
} from '../../services/goalAutomation/automationUtils/branchNames.js';

describe('branchNames coverage', () => {
  test('extractBranchName falls back for non-kebab single-word input', () => {
    const value = extractBranchName('dashboard', 'fallback-branch');
    expect(value).toBe('fallback-branch');
  });

  test('extractBranchName falls back when slugification removes all characters', () => {
    const value = extractBranchName('!!!', 'fallback-branch');
    expect(value).toBe('fallback-branch');
  });

  test('extractBranchName falls back when quoted candidate is invalid and no token matches', () => {
    const value = extractBranchName('Use "one-two-three-four-five-six" please', 'fallback-branch');
    expect(value).toBe('fallback-branch');
  });

  test('extractBranchName accepts quoted kebab names and trims to slug constraints', () => {
    const value = extractBranchName('Please use "feature-login-flow" now', 'fallback-branch');
    expect(value).toBe('feature-login-flow');
  });

  test('parseBranchNameFromLLMText returns plain phrase fallback for alphanumeric text', () => {
    expect(parseBranchNameFromLLMText('Create branch for login form')).toBe('Create branch for login form');
  });

  test('parseBranchNameFromLLMText returns empty when JSON branch field is non-string', () => {
    expect(parseBranchNameFromLLMText('{"branch":42}')).toBe('');
  });

  test('extractBranchPromptContext falls back to first trimmed line when markers are absent', () => {
    const prompt = '   tighten header spacing\nsecond line';
    expect(extractBranchPromptContext(prompt)).toBe('tighten header spacing');
  });
});
