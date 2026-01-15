import { describe, it, expect } from 'vitest';

import { isStyleOnlyPrompt, extractStyleColor } from '../services/promptHeuristics.js';

describe('promptHeuristics', () => {
  it('returns false for empty/undefined prompts (covers default arg branches)', () => {
    expect(isStyleOnlyPrompt()).toBe(false);
    expect(isStyleOnlyPrompt('')).toBe(false);
  });

  it('returns true for a style-only prompt with core signals and no non-style signals', () => {
    expect(isStyleOnlyPrompt('Change the background color')).toBe(true);
  });

  it('returns false when a prompt mixes style keywords with non-style signals', () => {
    // Has a core style signal (background/color) but also includes a non-style signal (api/fix).
    expect(isStyleOnlyPrompt('Change the background color and fix the API endpoint')).toBe(false);
  });

  it('returns false when no core style keywords are present', () => {
    expect(isStyleOnlyPrompt('Refine the onboarding workflow for authentication')).toBe(false);
  });

  describe('extractStyleColor', () => {
    it('returns null when the prompt is undefined or blank', () => {
      expect(extractStyleColor()).toBeNull();
      expect(extractStyleColor('   ')).toBeNull();
    });

    it('extracts and normalizes hex codes', () => {
      expect(extractStyleColor('Use #ABC as the accent color')).toBe('#abc');
    });

    it('returns rgb/rgba values verbatim', () => {
      expect(extractStyleColor('Try rgba(120, 80, 40, 0.5) for the overlay')).toBe('rgba(120, 80, 40, 0.5)');
    });

    it('matches adjective + color names and lowercases them', () => {
      expect(extractStyleColor('Switch to a Light Teal hero background')).toBe('light teal');
    });

    it('extracts plain color names when no adjective is present', () => {
      expect(extractStyleColor('Use a cyan accent')).toBe('cyan');
    });

    it('returns null when no color details are found', () => {
      expect(extractStyleColor('Make things look nicer')).toBeNull();
    });
  });
});
