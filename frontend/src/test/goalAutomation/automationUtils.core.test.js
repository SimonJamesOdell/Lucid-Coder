import { describe, it, expect, beforeEach, vi } from 'vitest';
import axios from 'axios';
import * as automationUtils from '../../services/goalAutomation/automationUtils.js';

const {
  resolveAttemptSequence,
  flattenFileTree,
  requestBranchNameFromLLM,
  parseTextFromLLMResponse,
  extractJsonObject,
  tryParseLooseJson,
  parseEditsFromLLM,
  notifyGoalsUpdated,
  buildEditsPrompt,
  upsertProjectFile,
  __automationUtilsTestHooks
} = automationUtils;

beforeEach(() => {
  axios.post.mockReset();
  axios.put = axios.put || vi.fn();
  axios.put.mockReset();
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

  it('uses an example-based prompt that avoids numeric-range parroting', async () => {
    const payloads = [];
    axios.post.mockImplementation((url, payload) => {
      payloads.push(payload);
      throw new Error('offline');
    });

    const result = await requestBranchNameFromLLM({
      prompt: 'Turn the background of the project blue',
      fallbackName: 'fallback-name'
    });

    expect(result).toBe('fallback-name');
    expect(payloads.length).toBeGreaterThanOrEqual(1);

    const systemContent = payloads[0]?.messages?.[0]?.content || '';
    expect(systemContent).toContain('Return ONLY a single JSON object');
    expect(systemContent).toContain('changed-background-blue');
    expect(systemContent).toContain('Prefer using words');
    expect(systemContent).not.toMatch(/\b2-5\b/);
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

  it('normalizes unicode escapes and curly quotes', () => {
    const { normalizeJsonLikeText } = __automationUtilsTestHooks;
    const transformed = normalizeJsonLikeText('{"note":"\u00a0“hello”"}');

    expect(transformed).toContain(' "hello"');
  });


describe('extractJsonObjectFromIndex', () => {
  it('returns null when inputs are invalid', () => {
    const { extractJsonObjectFromIndex } = __automationUtilsTestHooks;

    expect(extractJsonObjectFromIndex(null, 0)).toBeNull();
    expect(extractJsonObjectFromIndex('{"ok":true}', -1)).toBeNull();
  });

  it('captures a JSON object that contains quoted strings', () => {
    const { extractJsonObjectFromIndex } = __automationUtilsTestHooks;

    expect(extractJsonObjectFromIndex('{"note":"hi"}', 0)).toBe('{"note":"hi"}');
  });
});
  it('replaces curly single quotes with ASCII equivalents', () => {
    const { normalizeJsonLikeText } = __automationUtilsTestHooks;
    const transformed = normalizeJsonLikeText("{'note':'\u2018hi\u2019'}");

    expect(transformed).toContain("'hi'");
  });
});

describe('extractJsonObject', () => {
  it('returns null when a line comment never terminates', () => {
    const text = '{"note":1 // unterminated';

    expect(extractJsonObject(text)).toBeNull();
  });

  it('returns null when a block comment never terminates', () => {
    const text = '{"note":1 /* unterminated';

    expect(extractJsonObject(text)).toBeNull();
  });

  it('extracts objects that contain line and block comments', () => {
    const text = '{"note":1, // keep\n"next":2 /* ok */ }';

    expect(extractJsonObject(text)).toBe(text);
  });

  it('handles escaped quotes inside string values', () => {
    const text = '{"note":"value with \\\"quotes\\\" inside"}';

    expect(extractJsonObject(text)).toBe(text);
  });
});

describe('extractJsonArrayFromIndex', () => {
  it('returns null for non-string inputs or negative starts', () => {
    const { extractJsonArrayFromIndex } = __automationUtilsTestHooks;

    expect(extractJsonArrayFromIndex(null, 0)).toBeNull();
    expect(extractJsonArrayFromIndex('[1,2]', -1)).toBeNull();
  });

  it('handles escaped quotes while scanning strings', () => {
    const { extractJsonArrayFromIndex } = __automationUtilsTestHooks;
    const text = '["a\\"b"]';

    expect(extractJsonArrayFromIndex(text, 0)).toBe('["a\\"b"]');
  });

  it('skips line comments while scanning arrays', () => {
    const { extractJsonArrayFromIndex } = __automationUtilsTestHooks;
    const text = '[1, // note\n2]';

    expect(extractJsonArrayFromIndex(text, 0)).toBe('[1, // note\n2]');
  });

  it('handles line comments that terminate with a newline', () => {
    const { extractJsonArrayFromIndex } = __automationUtilsTestHooks;
    const text = '["a", // comment\n"b"]';

    expect(extractJsonArrayFromIndex(text, 0)).toBe('["a", // comment\n"b"]');
  });

  it('handles arrays that use single-quoted strings', () => {
    const { extractJsonArrayFromIndex } = __automationUtilsTestHooks;
    const text = "['a', 'b']";

    expect(extractJsonArrayFromIndex(text, 0)).toBe("['a', 'b']");
  });

  it('handles escaped backslashes inside string values', () => {
    const { extractJsonArrayFromIndex } = __automationUtilsTestHooks;
    const text = '["a\\\\b"]';

    expect(extractJsonArrayFromIndex(text, 0)).toBe(text);
  });

  it('returns the full array when nested arrays are present', () => {
    const { extractJsonArrayFromIndex } = __automationUtilsTestHooks;
    const text = '[1, [2, 3], 4]';

    expect(extractJsonArrayFromIndex(text, 0)).toBe(text);
  });

  it('returns null for unterminated block comments', () => {
    const { extractJsonArrayFromIndex } = __automationUtilsTestHooks;
    const text = '[1, /* missing end]';

    expect(extractJsonArrayFromIndex(text, 0)).toBeNull();
  });

  it('skips block comments when scanning arrays', () => {
    const { extractJsonArrayFromIndex } = __automationUtilsTestHooks;
    const text = '[1, /* note */ 2]';

    expect(extractJsonArrayFromIndex(text, 0)).toBe('[1, /* note */ 2]');
  });

  it('returns null when a line comment has no newline terminator', () => {
    const { extractJsonArrayFromIndex } = __automationUtilsTestHooks;
    const text = '[1, // trailing comment';

    expect(extractJsonArrayFromIndex(text, 0)).toBeNull();
  });
});

describe('upsertProjectFile', () => {
  it('falls back to PUT when create-file returns a conflict', async () => {
    axios.post.mockRejectedValueOnce({ response: { status: 409 } });
    axios.put.mockResolvedValueOnce({ data: { success: true } });

    const knownPathsSet = new Set(['frontend/src/Other.jsx']);
    const result = await upsertProjectFile({
      projectId: 5,
      filePath: 'frontend/src/App.jsx',
      content: 'export default 1;',
      knownPathsSet
    });

    expect(result).toEqual({ success: true });
    expect(axios.put).toHaveBeenCalledWith('/api/projects/5/files/frontend/src/App.jsx', { content: 'export default 1;' });
    expect(knownPathsSet.has('frontend/src/App.jsx')).toBe(true);
  });

  it('creates a file after a 404 PUT and wraps create failures', async () => {
    axios.put.mockRejectedValueOnce({ response: { status: 404 } });
    axios.post.mockRejectedValueOnce({ response: { status: 400 } });

    await expect(
      upsertProjectFile({
        projectId: 6,
        filePath: 'frontend/src/Missing.jsx',
        content: 'export default 2;'
      })
    ).rejects.toMatchObject({
      __lucidcoderFileOpFailure: expect.objectContaining({ status: 400, operation: 'create' })
    });
  });

  it('rethrows create-file errors that do not match handled statuses', async () => {
    const failure = { response: { status: 500 } };
    axios.put.mockRejectedValueOnce({ response: { status: 404 } });
    axios.post.mockRejectedValueOnce(failure);

    await expect(
      upsertProjectFile({
        projectId: 7,
        filePath: 'frontend/src/Fail.jsx',
        content: 'export default 3;'
      })
    ).rejects.toBe(failure);
  });
});

describe('formatTestFailureJobSection', () => {
  it('includes uncovered lines, failure reports, and recent logs', () => {
    const { formatTestFailureJobSection } = __automationUtilsTestHooks;
    const section = formatTestFailureJobSection(
      {
        label: 'Frontend',
        type: 'frontend',
        uncoveredLines: [{ workspace: 'frontend', file: 'src/App.jsx', lines: [] }],
        failureReport: 'Boom',
        recentLogs: ['Line 1', 'Line 2']
      },
      0
    );

    expect(section).toContain('Uncovered lines: frontend/src/App.jsx');
    expect(section).toContain('Failure report:\nBoom');
    expect(section).toContain('Recent logs:\nLine 1\nLine 2');
  });

  it('includes coverage summaries and detailed uncovered line previews', () => {
    const { formatTestFailureJobSection } = __automationUtilsTestHooks;
    const coverage = { total: 98 };
    const section = formatTestFailureJobSection(
      {
        label: 'Backend',
        type: 'backend',
        coverage,
        uncoveredLines: [
          { workspace: 'backend', file: 'src/App.jsx', lines: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
          { workspace: '', file: '', lines: [10] }
        ]
      },
      1
    );

    expect(section).toContain(`Coverage summary: ${JSON.stringify(coverage)}`);
    expect(section).toContain('Uncovered lines: backend/src/App.jsx (1, 2, 3, 4, 5, 6, 7, 8, …)');
  });

  it('ignores coverage serialization failures', () => {
    const { formatTestFailureJobSection } = __automationUtilsTestHooks;
    const coverage = {};
    coverage.self = coverage;

    const section = formatTestFailureJobSection(
      {
        label: 'Frontend',
        type: 'frontend',
        coverage
      },
      0
    );

    expect(section).toContain('Job: Frontend');
    expect(section).not.toContain('Coverage summary');
  });

  it('filters non-finite uncovered line values', () => {
    const { formatTestFailureJobSection } = __automationUtilsTestHooks;
    const section = formatTestFailureJobSection(
      {
        label: 'Frontend',
        type: 'frontend',
        uncoveredLines: [
          { workspace: 'frontend', file: 'src/App.jsx', lines: [1, 'x', 2, Infinity] }
        ]
      },
      0
    );

    expect(section).toContain('Uncovered lines: frontend/src/App.jsx (1, 2)');
  });

  it('includes uncovered entries without line arrays', () => {
    const { formatTestFailureJobSection } = __automationUtilsTestHooks;
    const section = formatTestFailureJobSection(
      {
        label: 'Frontend',
        type: 'frontend',
        uncoveredLines: [
          null,
          { workspace: '', file: '', lines: [1] },
          { workspace: 'frontend', file: 'src/App.jsx' }
        ]
      },
      0
    );

    expect(section).toContain('Uncovered lines: frontend/src/App.jsx');
  });

  it('omits uncovered line summaries when all entries are invalid', () => {
    const { formatTestFailureJobSection } = __automationUtilsTestHooks;
    const section = formatTestFailureJobSection(
      {
        label: 'Frontend',
        type: 'frontend',
        uncoveredLines: [null, { workspace: '', file: '', lines: [1] }]
      },
      0
    );

    expect(section).toContain('Job: Frontend');
    expect(section).not.toContain('Uncovered lines:');
  });

  it('formats uncovered line summaries when lines are present', () => {
    const { formatTestFailureJobSection } = __automationUtilsTestHooks;
    const section = formatTestFailureJobSection(
      {
        label: 'Frontend',
        type: 'frontend',
        uncoveredLines: [
          { workspace: 'frontend', file: 'src/App.jsx', lines: [1, 2, 'x'] }
        ]
      },
      0
    );

    expect(section).toContain('Uncovered lines: frontend/src/App.jsx (1, 2)');
  });

  it('adds a suffix when more than eight uncovered lines are present', () => {
    const { formatTestFailureJobSection } = __automationUtilsTestHooks;
    const section = formatTestFailureJobSection(
      {
        label: 'Frontend',
        type: 'frontend',
        uncoveredLines: [
          { workspace: 'frontend', file: 'src/App.jsx', lines: [1, 2, 3, 4, 5, 6, 7, 8, 9] }
        ]
      },
      0
    );

    expect(section).toContain('Uncovered lines: frontend/src/App.jsx (1, 2, 3, 4, 5, 6, 7, 8, …)');
  });

  it('trims workspace and file values when formatting uncovered lines', () => {
    const { formatTestFailureJobSection } = __automationUtilsTestHooks;
    const section = formatTestFailureJobSection(
      {
        label: 'Frontend',
        type: 'frontend',
        uncoveredLines: [
          { workspace: ' frontend ', file: ' src/App.jsx ', lines: [1] }
        ]
      },
      0
    );

    expect(section).toContain('Uncovered lines: frontend/src/App.jsx (1)');
  });

  it('limits uncovered line summaries to four entries', () => {
    const { formatTestFailureJobSection } = __automationUtilsTestHooks;
    const section = formatTestFailureJobSection(
      {
        label: 'Frontend',
        type: 'frontend',
        uncoveredLines: [
          { workspace: 'frontend', file: 'src/One.jsx', lines: [1] },
          { workspace: 'frontend', file: 'src/Two.jsx', lines: [2] },
          { workspace: 'frontend', file: 'src/Three.jsx', lines: [3] },
          { workspace: 'frontend', file: 'src/Four.jsx', lines: [4] },
          { workspace: 'frontend', file: 'src/Five.jsx', lines: [5] }
        ]
      },
      0
    );

    expect(section).toContain('frontend/src/One.jsx');
    expect(section).toContain('frontend/src/Four.jsx');
    expect(section).not.toContain('frontend/src/Five.jsx');
  });

  it('formats uncovered lines when workspace is non-string', () => {
    const { formatTestFailureJobSection } = __automationUtilsTestHooks;
    const section = formatTestFailureJobSection(
      {
        label: 'Frontend',
        type: 'frontend',
        uncoveredLines: [
          { workspace: 123, file: 'src/App.jsx', lines: [1] }
        ]
      },
      0
    );

    expect(section).toContain('Uncovered lines: src/App.jsx (1)');
  });

  it('uses workspace-only summaries when file is not a string', () => {
    const { formatTestFailureJobSection } = __automationUtilsTestHooks;
    const section = formatTestFailureJobSection(
      {
        label: 'Frontend',
        type: 'frontend',
        uncoveredLines: [
          { workspace: 'frontend', file: null, lines: [1] }
        ]
      },
      0
    );

    expect(section).toContain('Uncovered lines: frontend');
  });

  it('trims file strings even when workspace is empty', () => {
    const { formatTestFailureJobSection } = __automationUtilsTestHooks;
    const section = formatTestFailureJobSection(
      {
        label: 'Frontend',
        type: 'frontend',
        uncoveredLines: [
          { workspace: '', file: ' src/App.jsx ', lines: [1] }
        ]
      },
      0
    );

    expect(section).toContain('Uncovered lines: src/App.jsx (1)');
  });
});

describe('tryParseLooseJson', () => {
  it('handles unterminated line and block comments', () => {
    const withLineComment = "{foo: 'bar'} // comment";
    const withBlockComment = "{foo: 'bar'} /*";

    expect(tryParseLooseJson(withLineComment)).toEqual({ foo: 'bar' });
    expect(tryParseLooseJson(withBlockComment)).toEqual({ foo: 'bar' });
  });

  it('parses unquoted keys with trailing commas', () => {
    expect(tryParseLooseJson('{edits:[{path:"src/a.js",}],}')).toEqual({ edits: [{ path: 'src/a.js' }] });
  });
});

describe('parseEditsFromLLM', () => {
  it('returns pre-parsed arrays and edits objects', () => {
    const arrayResponse = { data: { response: [{ type: 'modify', path: 'a.js' }] } };
    const objectResponse = { data: { response: { edits: [{ type: 'upsert', path: 'b.js' }] } } };

    expect(parseEditsFromLLM(arrayResponse)).toEqual([{ type: 'modify', path: 'a.js' }]);
    expect(parseEditsFromLLM(objectResponse)).toEqual([{ type: 'upsert', path: 'b.js' }]);
  });
});

describe('notifyGoalsUpdated', () => {
  it('no-ops without a projectId or dispatchEvent', () => {
    notifyGoalsUpdated(null);

    const originalDispatch = globalThis.window?.dispatchEvent;
    if (globalThis.window) {
      globalThis.window.dispatchEvent = null;
    } else {
      vi.stubGlobal('window', { dispatchEvent: null });
    }

    notifyGoalsUpdated(123);

    if (globalThis.window) {
      globalThis.window.dispatchEvent = originalDispatch;
    }
  });
});

describe('buildEditsPrompt', () => {
  it('includes uncovered line summaries and recent logs', () => {
    const prompt = buildEditsPrompt({
      projectInfo: 'Project: Demo',
      fileTreeContext: '',
      goalPrompt: 'Add tests',
      stage: 'tests',
      testFailureContext: {
        jobs: [
          {
            label: 'Frontend tests',
            uncoveredLines: [
              { workspace: 'frontend', file: 'src/App.jsx', lines: [1, 2, 3, 4, 5, 6, 7, 8, 9] }
            ],
            recentLogs: ['line 1', 'line 2']
          }
        ]
      }
    });

    const userContent = prompt.messages.find((msg) => msg.role === 'user')?.content || '';
    expect(userContent).toContain('Uncovered lines: frontend/src/App.jsx (1, 2, 3, 4, 5, 6, 7, 8, …)');
    expect(userContent).toContain('Recent logs:');
  });

  it('includes retry notices for ambiguous matches and suggested paths', () => {
    const prompt = buildEditsPrompt({
      projectInfo: 'Project: Demo',
      fileTreeContext: '',
      goalPrompt: 'Add tests',
      stage: 'tests',
      attempt: 2,
      retryContext: {
        message: 'Ambiguous match',
        path: 'frontend/src/App.jsx',
        scopeWarning: 'Stay in test folders',
        suggestedPaths: ['frontend/src/test/App.test.jsx']
      }
    });

    const systemContent = prompt.messages.find((msg) => msg.role === 'system')?.content || '';
    const userContent = prompt.messages.find((msg) => msg.role === 'user')?.content || '';

    expect(systemContent).toContain('Previous response was not valid JSON');
    expect(userContent).toContain('The previous search snippet matched multiple locations');
    expect(userContent).toContain('Scope reminder: Stay in test folders');
    expect(userContent).toContain('Existing paths with similar names: frontend/src/test/App.test.jsx');
  });

  it('includes retry notices for not-found snippets and search context', () => {
    const prompt = buildEditsPrompt({
      projectInfo: 'Project: Demo',
      fileTreeContext: '',
      goalPrompt: 'Add tests',
      stage: 'tests',
      attempt: 1,
      retryContext: {
        message: 'Search snippet not found',
        path: 'frontend/src/App.jsx',
        searchSnippet: 'const missing = true;'
      }
    });

    const userContent = prompt.messages.find((msg) => msg.role === 'user')?.content || '';

    expect(userContent).toContain('The previous search snippet did not match the file');
    expect(userContent).toContain('Problematic search snippet: const missing = true;');
  });

  it('falls back to a default retry notice when only a search snippet is present', () => {
    const prompt = buildEditsPrompt({
      projectInfo: 'Project: Demo',
      fileTreeContext: '',
      goalPrompt: 'Add tests',
      stage: 'tests',
      attempt: 1,
      retryContext: {
        searchSnippet: 'const retry = true;'
      }
    });

    const userContent = prompt.messages.find((msg) => msg.role === 'user')?.content || '';

    expect(userContent).toContain('the replacement snippet did not match the current file');
    expect(userContent).toContain('Problematic search snippet: const retry = true;');
  });

  it('includes default framework guidance when decision details are missing', () => {
    const prompt = buildEditsPrompt({
      projectInfo: 'Project: Demo',
      fileTreeContext: '',
      goalPrompt: 'Build a navbar',
      stage: 'implementation',
      frameworkProfile: { detected: {} },
      frameworkDecision: undefined,
      frameworkSafeguards: {}
    });

    const userContent = prompt.messages.find((msg) => msg.role === 'user')?.content || '';

    expect(userContent).toContain('## FRAMEWORK CONTEXT (UNKNOWN)');
    expect(userContent).toContain('Framework: unknown');
    expect(userContent).toContain('Decision Confidence: 0%');
    expect(userContent).toContain('Generation Guidance: Follow standard practices');
  });
});
