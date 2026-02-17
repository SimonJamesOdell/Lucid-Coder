import { describe, test, expect, vi } from 'vitest';
import {
  automationLog,
  buildFallbackBranchNameFromPrompt,
  extractBranchPromptContext,
  isBranchNameRelevantToPrompt
} from '../../services/goalAutomation/automationUtils.js';

describe('automationUtils coverage helpers', () => {
  test('extractBranchPromptContext uses direct user answer when no current request exists', () => {
    const prompt = [
      'Original request: Improve dashboard clarity',
      'User answer:   tighten spacing around cards',
      '  and align icon labels  '
    ].join('\n');

    expect(extractBranchPromptContext(prompt)).toBe('tighten spacing around cards');
  });

  test('extractBranchPromptContext unwraps nested original request current request content', () => {
    const prompt = [
      'Original request: Current request:',
      '  make footer links more compact',
      'Clarification questions:',
      '- none'
    ].join('\n');

    expect(extractBranchPromptContext(prompt)).toBe('make footer links more compact');
  });

  test('extractBranchPromptContext falls back to original request text when nested context is not extractable', () => {
    const prompt = [
      'Original request: Current request:',
      'Clarification questions:',
      '- none'
    ].join('\n');

    expect(extractBranchPromptContext(prompt)).toBe('Current request:');
  });

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

  test('automationLog emits empty banner text for blank labels', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    automationLog('   ', { sample: true });

    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'lucidcoder:automation-log',
      detail: expect.objectContaining({ bannerText: '' })
    }));

    dispatchSpy.mockRestore();
  });

  test('automationLog treats non-string labels as empty banner text', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    automationLog(null, { sample: true });

    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'lucidcoder:automation-log',
      detail: expect.objectContaining({ bannerText: '' })
    }));

    dispatchSpy.mockRestore();
  });

  test('automationLog tolerates missing window.dispatchEvent', () => {
    const originalDispatch = window.dispatchEvent;
    Object.defineProperty(window, 'dispatchEvent', {
      configurable: true,
      writable: true,
      value: undefined
    });

    expect(() => automationLog('label', { sample: true })).not.toThrow();

    Object.defineProperty(window, 'dispatchEvent', {
      configurable: true,
      writable: true,
      value: originalDispatch
    });
  });
});
