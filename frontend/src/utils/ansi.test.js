import { describe, test, expect } from 'vitest';
import { stripAnsi } from './ansi';

describe('stripAnsi', () => {
  test('removes ANSI escape sequences from text', () => {
    const colorful = '\u001b[31mError: something broke\u001b[39m';
    expect(stripAnsi(colorful)).toBe('Error: something broke');
  });

  test('returns non-string inputs unchanged', () => {
    const input = { message: 'noop' };
    expect(stripAnsi(input)).toBe(input);
    expect(stripAnsi(42)).toBe(42);
    expect(stripAnsi(null)).toBeNull();
  });
});
