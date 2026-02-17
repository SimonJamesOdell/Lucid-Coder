import { describe, it, expect } from 'vitest';

import {
  isStyleOnlyPrompt,
  extractStyleColor,
  extractLatestRequest,
  extractSelectedProjectAssets
} from '../services/promptHeuristics.js';

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

  it('returns false for targeted component style prompts', () => {
    expect(isStyleOnlyPrompt('Make the navigation bar have a black background with white text')).toBe(false);
    expect(isStyleOnlyPrompt('Set .navbar background to black and text to white')).toBe(false);
  });

  it('ignores style-only context when a non-style current request is provided', () => {
    const prompt = [
      'Conversation context:',
      'User: Change the background color to blue',
      'Assistant: Sure, updating styles.',
      '',
      'Current request: Make a contact form on the contact page'
    ].join('\n');

    expect(isStyleOnlyPrompt(prompt)).toBe(false);
  });

  it('uses the current request line for style-only detection', () => {
    const prompt = [
      'Conversation context:',
      'User: Add a contact form',
      '',
      'Current request: Change the background color to teal'
    ].join('\n');

    expect(isStyleOnlyPrompt(prompt)).toBe(true);
    expect(extractStyleColor(prompt)).toBe('teal');
  });

  it('extracts user answer when no current request is present', () => {
    const prompt = [
      'Previous context:',
      'Assistant: What color would you like?',
      '',
      'User answer: Change font color to blue'
    ].join('\n');

    expect(isStyleOnlyPrompt(prompt)).toBe(true);
  });

  it('extracts original request when neither current request nor user answer is present', () => {
    const prompt = [
      'Context:',
      'Some background information',
      '',
      'Original request: Update the theme colors'
    ].join('\n');

    expect(isStyleOnlyPrompt(prompt)).toBe(true);
  });

  it('unwraps nested request labels', () => {
    const prompt = 'Original request: Current request: Use the image as the site background';
    expect(extractLatestRequest(prompt)).toBe('Use the image as the site background');
  });

  it('stops unwrapping nested request labels after max depth', () => {
    const prompt = 'Original request: User answer: Current request: Original request: Current request: Keep this text';
    expect(extractLatestRequest(prompt)).toBe('Current request: Keep this text');
  });

  it('returns empty string for whitespace-only latest request payloads', () => {
    expect(extractLatestRequest('   ')).toBe('');
  });

  it('extracts selected project assets from wrapped prompts', () => {
    const prompt = [
      'Conversation context:',
      'User: hello',
      '',
      'Selected project assets:',
      '- uploads/hero.png',
      '- uploads/logo.svg',
      '',
      'Current request: Use the image as the site background'
    ].join('\n');

    expect(extractSelectedProjectAssets(prompt)).toEqual(['uploads/hero.png', 'uploads/logo.svg']);
  });

  it('returns empty selected assets when no asset section exists', () => {
    expect(extractSelectedProjectAssets('Current request: update header')).toEqual([]);
  });

  it('returns empty selected assets for blank prompts', () => {
    expect(extractSelectedProjectAssets('')).toEqual([]);
  });

  it('skips leading blank lines and stops at section-style headers', () => {
    const prompt = [
      'Selected project assets:',
      '',
      '- uploads/hero.png',
      'Current request:',
      '- uploads/should-not-be-read.png'
    ].join('\n');

    expect(extractSelectedProjectAssets(prompt)).toEqual(['uploads/hero.png']);
  });

  it('accepts selected asset lines without bullet prefixes', () => {
    const prompt = [
      'Selected project assets:',
      'uploads/hero.png',
      '',
      'Current request: use the hero image'
    ].join('\n');

    expect(extractSelectedProjectAssets(prompt)).toEqual(['uploads/hero.png']);
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
