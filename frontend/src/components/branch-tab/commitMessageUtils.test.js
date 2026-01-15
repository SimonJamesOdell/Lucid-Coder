import { describe, test, expect } from 'vitest';
import {
  isDescriptiveCommitMessage,
  extractCommitCandidateFromText,
  looksLikeCommitMessage,
  isLikelyPlaceholderCommitMessage,
  hasMeaningfulWordSignal,
  coerceMessageString,
  extractLLMText,
  stripListPrefix,
  __testHooks
} from './commitMessageUtils';

const { containsInstructionalLanguage } = __testHooks;

describe('containsInstructionalLanguage', () => {
  test('treats falsy text as non-instructional', () => {
    expect(containsInstructionalLanguage()).toBe(false);
  });

  test('detects instruction keywords in phrases', () => {
    expect(containsInstructionalLanguage('Ensure the subject line stays short.')).toBe(true);
  });
});

describe('isDescriptiveCommitMessage', () => {
  test('rejects instruction-style prompts', () => {
    const prompt = 'Update demo paragraph and mention file. Ensure lines ≤72 chars.';
    expect(isDescriptiveCommitMessage(prompt)).toBe(false);
  });

  test('accepts descriptive commit summaries', () => {
    const message = 'Update demo paragraph copy to exercise HMR workflow';
    expect(isDescriptiveCommitMessage(message)).toBe(true);
  });

  test('rejects empty strings outright', () => {
    expect(isDescriptiveCommitMessage('')).toBe(false);
  });

  test('rejects placeholder-style summaries', () => {
    expect(isDescriptiveCommitMessage('WIP: stuff')).toBe(false);
  });
});

describe('looksLikeCommitMessage', () => {
  test('accepts single line subject without instructions', () => {
    expect(looksLikeCommitMessage('Trim nav spacing to avoid wrapping')).toBe(true);
  });

  test('rejects multiline body with instructional keywords', () => {
    const payload = 'Refine nav spacing\nEnsure the commit subject line is 72 characters or less';
    expect(looksLikeCommitMessage(payload)).toBe(false);
  });

  test('returns false for empty or whitespace payloads', () => {
    expect(looksLikeCommitMessage('')).toBe(false);
    expect(looksLikeCommitMessage('   ')).toBe(false);
  });

  test('rejects subjects that contain instructional language', () => {
    expect(looksLikeCommitMessage('Ensure the commit message describes the change')).toBe(false);
  });

  test('rejects overly long subjects', () => {
    expect(looksLikeCommitMessage('a'.repeat(121))).toBe(false);
  });

  test('ignores blank lines in the body when evaluating content', () => {
    const payload = 'Refine nav spacing\n\nAdd breathing room between nav buttons';
    expect(looksLikeCommitMessage(payload)).toBe(true);
  });

  test('rejects multiline bodies with lines longer than 120 characters', () => {
    const payload = `Refine nav spacing for tablets\n${'a'.repeat(121)}`;
    expect(looksLikeCommitMessage(payload)).toBe(false);
  });
});

describe('isLikelyPlaceholderCommitMessage', () => {
  test('detects classic WIP placeholders regardless of case', () => {
    expect(isLikelyPlaceholderCommitMessage('WIP: stuff')).toBe(true);
    expect(isLikelyPlaceholderCommitMessage('update')).toBe(true);
    expect(isLikelyPlaceholderCommitMessage('  TEST  ')).toBe(true);
  });

  test('allows descriptive text', () => {
    expect(isLikelyPlaceholderCommitMessage('Improve nav spacing')).toBe(false);
  });

  test('treats empty strings as placeholders', () => {
    expect(isLikelyPlaceholderCommitMessage('   ')).toBe(true);
  });
});

describe('hasMeaningfulWordSignal', () => {
  test('passes when at least three words are present', () => {
    expect(hasMeaningfulWordSignal('Add nav spacing tweak')).toBe(true);
  });

  test('falls back to alphabetic character count when words are scarce', () => {
    expect(hasMeaningfulWordSignal('a'.repeat(15))).toBe(true);
    expect(hasMeaningfulWordSignal('ab')).toBe(false);
  });

  test('ignores numeric-only payloads', () => {
    expect(hasMeaningfulWordSignal('1234 5678')).toBe(false);
  });
});

describe('extractCommitCandidateFromText', () => {
  test('returns trimmed descriptive text', () => {
    const payload = '  Update demo copy to mention HMR behavior.  ';
    expect(extractCommitCandidateFromText(payload)).toBe('Update demo copy to mention HMR behavior.');
  });

  test('handles quoted responses', () => {
    const payload = '"Adjust App.jsx text to validate hot reload works"';
    expect(extractCommitCandidateFromText(payload)).toBe('Adjust App.jsx text to validate hot reload works');
  });

  test('extracts subject after colon directives', () => {
    const payload = 'Ensure subject line is descriptive. commit message: Fix nav spacing for compact layout';
    expect(extractCommitCandidateFromText(payload)).toBe('Fix nav spacing for compact layout');
  });

  test('scans segmented paragraphs for the first descriptive candidate', () => {
    const payload = 'We should do X. Update nav spacing on tablets. Ensure the commit subject line describes the change.';
    expect(extractCommitCandidateFromText(payload)).toBe('Update nav spacing on tablets.');
  });

  test('skips undersized segments when scanning lists', () => {
    const payload = '- fix\n- Expand nav spacing on tablets for consistency.';
    expect(extractCommitCandidateFromText(payload)).toBe('Expand nav spacing on tablets for consistency.');
  });

  test('falls back to first viable segment when none are descriptive enough', () => {
    const payload = 'Update\nCleanup';
    expect(extractCommitCandidateFromText(payload)).toBe('Update');
  });

  test('returns empty string when no input or only whitespace is provided', () => {
    expect(extractCommitCandidateFromText()).toBe('');
    expect(extractCommitCandidateFromText('   ')).toBe('');
  });

  test('extracts quoted candidates embedded inside longer responses', () => {
    const payload = 'Respond with summary: "Tighten nav spacing on compact layouts". Follow-up soon.';
    expect(extractCommitCandidateFromText(payload)).toBe('Tighten nav spacing on compact layouts');
  });

  test('skips segments that contain instruction keywords before selecting a candidate', () => {
    const payload = 'Ensure lines stay short. Update nav spacing on tablets for readability.';
    expect(extractCommitCandidateFromText(payload)).toBe('Update nav spacing on tablets for readability.');
  });

  test('returns empty string when every segment is filtered out', () => {
    expect(extractCommitCandidateFromText('Fix')).toBe('');
  });
});

describe('coerceMessageString', () => {
  test('returns strings verbatim', () => {
    expect(coerceMessageString('hello world')).toBe('hello world');
  });

  test('unwinds nested content arrays and entries', () => {
    const message = {
      content: [
        'first line',
        { text: 'second line' },
        null,
        42
      ]
    };
    expect(coerceMessageString(message)).toBe('first line\nsecond line');
  });

  test('falls back to reasoning text structures', () => {
    const message = {
      reasoning: {
        output_text: '',
        steps: [{ text: 'Step A' }, { text: 'Step B' }]
      }
    };
    expect(coerceMessageString(message)).toBe('Step A\nStep B');
  });

  test('prefers reasoning.output_text when available', () => {
    const message = {
      reasoning: {
        output_text: 'Final reasoning summary'
      }
    };
    expect(coerceMessageString(message)).toBe('Final reasoning summary');
  });

  test('uses reasoning string when provided directly', () => {
    const message = {
      reasoning: 'Explicit reasoning'
    };
    expect(coerceMessageString(message)).toBe('Explicit reasoning');
  });

  test('returns empty string when message payload is missing', () => {
    expect(coerceMessageString()).toBe('');
  });

  test('uses trimmed string content fields when present', () => {
    expect(coerceMessageString({ content: '  summarized change  ' })).toBe('summarized change');
  });

  test('ignores reasoning steps that lack textual entries', () => {
    const message = {
      reasoning: {
        output_text: '',
        steps: [{ text: 'Step A' }, { note: 'Step B' }]
      }
    };
    expect(coerceMessageString(message)).toBe('Step A');
  });
});

describe('extractLLMText', () => {
  test('prefers choice message content when present', () => {
    const payload = {
      choices: [
        {
          message: { content: 'Write nav spacing summary' },
          text: 'fallback text'
        }
      ]
    };
    expect(extractLLMText(payload)).toBe('Write nav spacing summary');
  });

  test('falls back to choice text, payload content, and message object', () => {
    const payload = {
      choices: [{ message: {}, text: 'choice text' }]
    };
    expect(extractLLMText(payload)).toBe('choice text');

    expect(extractLLMText({ content: 'direct content' })).toBe('direct content');

    expect(extractLLMText({ message: { content: 'message content' } })).toBe('message content');
  });

  test('returns empty string for falsy payloads', () => {
    expect(extractLLMText()).toBe('');
  });

  test('returns raw payload strings directly', () => {
    expect(extractLLMText('commit summary')).toBe('commit summary');
  });

  test('returns empty string when no usable data exists', () => {
    expect(extractLLMText({ message: {} })).toBe('');
  });
});

describe('stripListPrefix', () => {
  test('removes bullet characters and whitespace', () => {
    expect(stripListPrefix(' - fix bug')).toBe('fix bug');
    expect(stripListPrefix('*   improve logging')).toBe('improve logging');
    expect(stripListPrefix('• tighten tests')).toBe('tighten tests');
  });
});
