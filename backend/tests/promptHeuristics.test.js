import { describe, it, expect } from 'vitest';
import { extractLatestRequest, hasResolvedClarificationAnswers } from '../services/promptHeuristics.js';

describe('promptHeuristics.extractLatestRequest', () => {
  it('preserves resolved multiline clarification answers for planning', () => {
    const prompt = [
      'Original request: Add a fixed top navbar with pages and products dropdown',
      'Current request: Add a fixed top navbar with pages and products dropdown',
      'Clarification questions:',
      '- Should the dropdown open on hover, click, or both?',
      '- Should routing use React Router v6?',
      'User answer: Q: Should the dropdown open on hover, click, or both?',
      'A: both',
      '',
      'Q: Should routing use React Router v6?',
      'A: yes'
    ].join('\n');

    const latest = extractLatestRequest(prompt);

    expect(latest).toContain('Add a fixed top navbar with pages and products dropdown');
    expect(latest).toContain('Resolved clarification answers: both; yes');
  });

  it('returns current request when no clarification transcript is present', () => {
    const prompt = 'Current request: Build a landing page hero';
    expect(extractLatestRequest(prompt)).toBe('Build a landing page hero');
  });

  it('extracts inline Q/A clarification answers from a single-line user answer', () => {
    const prompt = [
      'Original request: Add top nav with dropdown categories',
      'Current request: Add top nav with dropdown categories',
      'User answer: Q: Do you prefer hover or click? A: both Q: Should routing use react-router-dom? A: yes'
    ].join('\n');

    const latest = extractLatestRequest(prompt);
    expect(latest).toContain('Add top nav with dropdown categories');
    expect(latest).toContain('Resolved clarification answers: both; yes');
  });

  it('does not treat single-line non-transcript answers as clarification blocks', () => {
    const prompt = [
      'Original request: Add nav links',
      'User answer: Include Home and Contact'
    ].join('\n');

    expect(extractLatestRequest(prompt)).toBe('Add nav links');
  });

  it('detects resolved clarification answers for multiline and inline transcripts', () => {
    const multiline = [
      'Original request: Build nav',
      'User answer: Q: Hover or click?',
      'A: both'
    ].join('\n');

    const inline = 'Original request: Build nav\nUser answer: Q: Hover or click? A: both';
    const unresolved = 'Original request: Build nav\nUser answer: still thinking';

    expect(hasResolvedClarificationAnswers(multiline)).toBe(true);
    expect(hasResolvedClarificationAnswers(inline)).toBe(true);
    expect(hasResolvedClarificationAnswers(unresolved)).toBe(false);
  });
});
