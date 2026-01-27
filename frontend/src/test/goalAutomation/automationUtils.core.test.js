import { describe, it, expect, beforeEach, vi } from 'vitest';
import axios from 'axios';
import * as automationUtils from '../../services/goalAutomation/automationUtils.js';

const {
  resolveAttemptSequence,
  flattenFileTree,
  requestBranchNameFromLLM,
  parseTextFromLLMResponse,
  __automationUtilsTestHooks
} = automationUtils;

beforeEach(() => {
  axios.post.mockReset();
});

describe('resolveAttemptSequence', () => {
  it('returns a single attempt array when provided a positive integer', () => {
    expect(resolveAttemptSequence(7)).toEqual([7]);
  });

  it('deduplicates array inputs while ignoring invalid entries', () => {
    expect(resolveAttemptSequence(['1', 2, '2', null, -4, 'abc'])).toEqual([1, 2]);
  });
});

describe('flattenFileTree', () => {
  it('skips falsy nodes while collecting normalized paths', () => {
    const nodes = [null, undefined, { path: 'frontend/src/App.jsx' }];

    expect(flattenFileTree(nodes)).toEqual(['frontend/src/App.jsx']);
  });

  it('recursively flattens children using fallback identifiers', () => {
    const nodes = [
      {
        name: 'frontend',
        children: [
          { filePath: 'frontend/src/components/NavBar.jsx' },
          { path: 'frontend/src/components/Footer.jsx' }
        ]
      }
    ];

    expect(flattenFileTree(nodes)).toEqual([
      'frontend',
      'frontend/src/components/NavBar.jsx',
      'frontend/src/components/Footer.jsx'
    ]);
  });

  it('ignores nodes that lack identifying fields while still exploring their children', () => {
    const nodes = [
      {
        children: [{ path: 'frontend/src/components/Sidebar.jsx' }]
      }
    ];

    expect(flattenFileTree(nodes)).toEqual(['frontend/src/components/Sidebar.jsx']);
  });
});

describe('requestBranchNameFromLLM', () => {
  it('falls back to the provided branch name when the LLM call fails', async () => {
    const fallback = 'fallback-branch';
    axios.post.mockRejectedValue(new Error('offline'));

    const result = await requestBranchNameFromLLM({ prompt: 'Add nav', fallbackName: fallback });

    expect(result).toBe(fallback);
    expect(axios.post).toHaveBeenCalled();
  });

  it('returns the first valid branch name from a successful response', async () => {
    axios.post.mockResolvedValue({
      data: {
        response: '{"branch":"added-search-bar"}'
      }
    });
    const logSpy = vi.spyOn(automationUtils, 'automationLog').mockImplementation(() => {});

    try {
      const result = await requestBranchNameFromLLM({ prompt: 'Add search bar', fallbackName: 'fallback' });

      expect(result).toBe('added-search-bar');
      expect(axios.post).toHaveBeenCalledTimes(1);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('logs an empty preview when the LLM payload is not textual', async () => {
    axios.post.mockResolvedValue({
      data: {
        response: { branch: 'ignored' }
      }
    });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const result = await requestBranchNameFromLLM({ prompt: 'Add footer', fallbackName: 'fallback-name' });

      expect(result).toBe('fallback-name');
      const rawLogs = consoleSpy.mock.calls.filter(([label]) =>
        typeof label === 'string' && label.includes('[automation] ensureBranch:llm:raw')
      );
      expect(rawLogs.length).toBeGreaterThan(0);
      expect(rawLogs[0][1].preview).toBe('');
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

describe('parseTextFromLLMResponse', () => {
  it('returns the raw response payload when present', () => {
    const payload = { data: { response: { branch: 'raw-object' }, content: 'ignored' } };

    expect(parseTextFromLLMResponse(payload)).toEqual({ branch: 'raw-object' });
  });

  it('falls back to data.content when response is undefined', () => {
    const payload = { data: { content: 'secondary-channel' } };

    expect(parseTextFromLLMResponse(payload)).toBe('secondary-channel');
  });

  it('returns an empty string when the LLM response is missing data', () => {
    expect(parseTextFromLLMResponse({})).toBe('');
  });
});

describe('normalizeJsonLikeText', () => {
  it('escapes carriage returns that appear inside quoted text', () => {
    const { normalizeJsonLikeText } = __automationUtilsTestHooks;
    const transformed = normalizeJsonLikeText('{"note":"line\rreturn"}');

    expect(transformed).toContain('line\\rreturn');
  });
});
