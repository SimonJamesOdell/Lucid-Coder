import { describe, test, expect } from 'vitest';
import {
  extractBranchName,
  parseBranchNameFromLLMText,
  extractBranchPromptContext
} from '../../services/goalAutomation/automationUtils/branchNames.js';

describe('branchNames coverage', () => {
  test('extractBranchPromptContext returns empty string for blank input', () => {
    expect(extractBranchPromptContext('   ')).toBe('');
  });

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

  test('extractBranchPromptContext prioritizes a specific current request', () => {
    const prompt = [
      'Current request: Improve login validation UX',
      'Original request: retry'
    ].join('\n');

    expect(extractBranchPromptContext(prompt)).toBe('Improve login validation UX');
  });

  test('extractBranchPromptContext resolves nested original context when current request is retry-only', () => {
    const prompt = [
      'Current request: retry',
      'Original request: Current request: Fix checkout totals rounding',
      'Clarification questions: none'
    ].join('\n');

    expect(extractBranchPromptContext(prompt)).toBe('Fix checkout totals rounding');
  });

  test('extractBranchName keeps meaningful verb-prefixed kebab names', () => {
    const value = extractBranchName('use branch "added-login-validation" please', 'fallback-branch');
    expect(value).toBe('added-login-validation');
  });

  test('extractBranchPromptContext falls back to direct user answer when current request is retry-only with no original request', () => {
    const prompt = [
      'Current request: retry',
      'User answer: Tighten card spacing in the dashboard header'
    ].join('\n');

    expect(extractBranchPromptContext(prompt)).toBe('Tighten card spacing in the dashboard header');
  });
});
