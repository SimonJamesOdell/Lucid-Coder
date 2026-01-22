import { describe, it, expect } from 'vitest';
import * as automationUtils from '../../services/goalAutomation/automationUtils.js';

const {
  tryParseLooseJson,
  buildScopeReflectionPrompt,
  buildEditsPrompt,
  parseScopeReflectionResponse,
  validateEditsAgainstReflection,
  parseEditsFromLLM,
  normalizeMentionPath,
  __automationUtilsTestHooks
} = automationUtils;

describe('tryParseLooseJson', () => {
  it('returns null for non-string inputs', () => {
    expect(tryParseLooseJson(null)).toBeNull();
    expect(tryParseLooseJson(42)).toBeNull();
  });

  it('repairs loosely formatted JSON with unquoted keys and trailing commas', () => {
    const raw = "{ foo: 'bar', nested_item: { value: '42' }, trailing: [1, 2,], }";

    const parsed = tryParseLooseJson(raw);

    expect(parsed).toEqual({
      foo: 'bar',
      nested_item: { value: '42' },
      trailing: [1, 2]
    });
  });
});

describe('buildScopeReflectionPrompt', () => {
  it('builds a scoped reflection conversation with context and goal details', () => {
    const prompt = buildScopeReflectionPrompt({
      projectInfo: '  Frontend is React based with a proxy layer.  ',
      goalPrompt: '  ensure the modal validates input  '
    });

    expect(prompt.__lucidcoderPurpose).toBe('goal-scope-reflection');
    expect(prompt.max_tokens).toBe(600);
    expect(prompt.temperature).toBe(0);
    expect(prompt.messages).toHaveLength(2);
    expect(prompt.messages[1].content).toContain('Project context:\nFrontend is React based');
    expect(prompt.messages[1].content).toContain('User goal:\nensure the modal validates input');
  });

  it('falls back to a generic user goal placeholder when no context is provided', () => {
    const prompt = buildScopeReflectionPrompt({ projectInfo: null, goalPrompt: undefined });

    expect(prompt.messages[1].content).toContain('User goal provided above.');
  });
});

describe('parseScopeReflectionResponse', () => {
  it('normalizes reasoning fields and reflection lists based on LLM output', () => {
    const llmResponse = {
      data: {
        response:
          "{reasoning:'  tighten scope  ', mustChange:[' src/api ', 'frontend/components ', ''], mustAvoid:[' backend ', ' tests '], testsNeeded:false}"
      }
    };

    const reflection = parseScopeReflectionResponse(llmResponse);

    expect(reflection).toEqual({
      reasoning: 'tighten scope',
      mustChange: ['src/api', 'frontend/components'],
      mustAvoid: ['backend', 'tests'],
      mustHave: [],
      testsNeeded: false
    });
  });

  it('treats non-string payloads as empty text and returns defaults', () => {
    const llmResponse = {
      data: {
        response: { reasoning: 'object payload' }
      }
    };

    const reflection = parseScopeReflectionResponse(llmResponse);

    expect(reflection).toEqual({
      reasoning: '',
      mustChange: [],
      mustAvoid: [],
      mustHave: [],
      testsNeeded: true
    });
  });

  it('falls back to the default scope reflection when parsing fails', () => {
    const llmResponse = {
      data: {
        response: ''
      }
    };

    const reflection = parseScopeReflectionResponse(llmResponse);

    expect(reflection).toEqual({
      reasoning: '',
      mustChange: [],
      mustAvoid: [],
      mustHave: [],
      testsNeeded: true
    });
  });

  it('returns the default scope reflection when JSON parses to a non-object value', () => {
    const llmResponse = {
      data: {
        response: '["unexpected"]'
      }
    };

    const reflection = parseScopeReflectionResponse(llmResponse);

    expect(reflection).toEqual({
      reasoning: '',
      mustChange: [],
      mustAvoid: [],
      mustHave: [],
      testsNeeded: true
    });
  });

  it('returns the default scope reflection when JSON parses to a primitive value', () => {
    const llmResponse = {
      data: {
        response: '"just text"'
      }
    };

    const reflection = parseScopeReflectionResponse(llmResponse);

    expect(reflection).toEqual({
      reasoning: '',
      mustChange: [],
      mustAvoid: [],
      mustHave: [],
      testsNeeded: true
    });
  });

  it('returns the default scope reflection when parsing throws unexpectedly', () => {
    const llmResponse = {};
    Object.defineProperty(llmResponse, 'data', {
      get() {
        throw new Error('kaboom');
      }
    });

    const reflection = parseScopeReflectionResponse(llmResponse);

    expect(reflection).toEqual({
      reasoning: '',
      mustChange: [],
      mustAvoid: [],
      mustHave: [],
      testsNeeded: true
    });
  });

  it('normalizes mustHave entries and defaults testsNeeded when non-boolean', () => {
    const llmResponse = {
      data: {
        response: JSON.stringify({
          reasoning: 123,
          mustHave: ['  A ', '', 'B'],
          testsNeeded: 'maybe'
        })
      }
    };

    const reflection = parseScopeReflectionResponse(llmResponse);

    expect(reflection).toEqual({
      reasoning: '',
      mustChange: [],
      mustAvoid: [],
      mustHave: ['A', 'B'],
      testsNeeded: true
    });
  });
});

describe('formatScopeReflectionContext', () => {
  it('formats must-have lists and tests-needed flag', () => {
    const { formatScopeReflectionContext } = __automationUtilsTestHooks;

    const context = formatScopeReflectionContext({
      reasoning: '  Keep it tight ',
      mustChange: ['src/app.js'],
      mustAvoid: [],
      mustHave: ['A', 'B'],
      testsNeeded: false
    });

    expect(context).toContain('Summary: Keep it tight');
    expect(context).toContain('Must have: A, B');
    expect(context).toContain('Tests required: No');
  });

  it('uses defaults when mustHave is empty', () => {
    const { formatScopeReflectionContext } = __automationUtilsTestHooks;

    const context = formatScopeReflectionContext({
      reasoning: '',
      mustChange: [],
      mustAvoid: [],
      mustHave: [],
      testsNeeded: true
    });

    expect(context).toContain('Must have: None noted');
  });
});

describe('validateEditsAgainstReflection', () => {
  it('rejects edits to test files when tests are unnecessary', () => {
    const reflection = { testsNeeded: false, mustAvoid: [] };
    const edits = [{ path: 'frontend/src/__tests__/GoalPanel.test.jsx' }];

    const result = validateEditsAgainstReflection(edits, reflection);

    expect(result).toMatchObject({
      type: 'tests-not-needed',
      path: 'frontend/src/__tests__/GoalPanel.test.jsx'
    });
  });

  it('rejects edits that touch forbidden prefixes derived from reflection text', () => {
    const reflection = {
      testsNeeded: true,
      mustAvoid: ['backend/services']
    };
    const edits = [{ path: 'backend/services/jobRunner.js' }];

    const result = validateEditsAgainstReflection(edits, reflection);

    expect(result).toMatchObject({
      type: 'forbidden-area',
      path: 'backend/services/jobRunner.js',
      rule: 'backend/services/'
    });
  });

  it('allows edits that respect the guidance', () => {
    const reflection = {
      testsNeeded: true,
      mustAvoid: ['frontend/hooks']
    };
    const edits = [{ path: 'frontend/components/App.jsx' }];

    expect(validateEditsAgainstReflection(edits, reflection)).toBeNull();
  });

  it('skips edits that do not include a valid path', () => {
    const reflection = {
      testsNeeded: true,
      mustAvoid: []
    };
    const edits = [{ path: '' }];

    expect(validateEditsAgainstReflection(edits, reflection)).toBeNull();
  });

  it('returns null when reflection data or edits are missing', () => {
    expect(validateEditsAgainstReflection(null, null)).toBeNull();
    expect(validateEditsAgainstReflection([], { testsNeeded: true })).toBeNull();
  });

  it('handles reflections that omit mustAvoid guidance', () => {
    const reflection = { testsNeeded: true };
    const edits = [{ path: 'frontend/src/components/App.jsx' }];

    expect(validateEditsAgainstReflection(edits, reflection)).toBeNull();
  });
});

describe('buildEditsPrompt', () => {
  it('fills in default scope reflection guidance when details are empty', () => {
    const prompt = buildEditsPrompt({
      projectInfo: 'Repo info',
      fileTreeContext: '',
      goalPrompt: 'Ship feature',
      stage: 'implementation',
      scopeReflection: {
        reasoning: '',
        mustChange: [],
        mustAvoid: [],
        testsNeeded: true
      }
    });

    const userMessage = prompt.messages[1].content;
    expect(userMessage).toContain('Scope reflection:');
    expect(userMessage).toContain('Must change: None noted');
    expect(userMessage).toContain('Avoid changing: None noted');
    expect(userMessage).toContain('Tests required: Yes');
  });
});

describe('parseEditsFromLLM', () => {
  it('returns parsed edits when JSON is well-formed', () => {
    const edits = parseEditsFromLLM({
      data: {
        response: '{"edits":[{"type":"modify","path":"frontend/src/App.jsx"}]}'
      }
    });

    expect(edits).toEqual([{ type: 'modify', path: 'frontend/src/App.jsx' }]);
  });

  it('falls back to the loose JSON parser when strict parsing fails', () => {
    const edits = parseEditsFromLLM({
      data: {
        response: '{edits:[{type:"modify",path:"frontend/src/App.jsx"}]}'
      }
    });

    expect(edits).toEqual([{ type: 'modify', path: 'frontend/src/App.jsx' }]);
  });

  it('returns an empty array when no JSON payload can be extracted', () => {
    const edits = parseEditsFromLLM({ data: { response: 'No structured content here.' } });

    expect(edits).toEqual([]);
  });

  it('rethrows parse errors when the payload cannot be repaired', () => {
    expect(() =>
      parseEditsFromLLM({ data: { response: '{"edits": invalid }' } })
    ).toThrow();
  });
});

describe('normalizeMentionPath', () => {
  it('prefixes frontend/ when a mention lacks a root directory', () => {
    expect(normalizeMentionPath('src/components/App.jsx')).toBe('frontend/src/components/App.jsx');
  });

  it('returns null when the mention cannot be normalized', () => {
    expect(normalizeMentionPath('')).toBeNull();
  });
});

describe('__automationUtilsTestHooks helpers', () => {
  it('normalizes non-string JSON-like input to an empty string', () => {
    const { normalizeJsonLikeText } = __automationUtilsTestHooks;

    expect(normalizeJsonLikeText(undefined)).toBe('');
  });

  it('normalizes reflection lists when value is not an array', () => {
    const { normalizeReflectionList } = __automationUtilsTestHooks;

    expect(normalizeReflectionList('not a list')).toEqual([]);
  });

  it('trims reflection entries and drops invalid list values', () => {
    const { normalizeReflectionList } = __automationUtilsTestHooks;

    expect(normalizeReflectionList(['  src/api.js  ', 42, '', 'frontend/App.jsx'])).toEqual([
      'src/api.js',
      'frontend/App.jsx'
    ]);
  });

  it('derives reflection prefixes from textual hints', () => {
    const { deriveReflectionPathPrefixes } = __automationUtilsTestHooks;

    const syntheticEntry = { toLowerCase: () => 'backend frontend tests area' };
    const prefixes = deriveReflectionPathPrefixes([syntheticEntry]);

    expect(prefixes).toEqual(expect.arrayContaining([
      'backend/',
      'frontend/',
      'frontend/src/__tests__/',
      'backend/tests/',
      'tests/'
    ]));
  });

  it('normalizes explicit repo paths and ensures a trailing slash prefix', () => {
    const { deriveReflectionPathPrefixes } = __automationUtilsTestHooks;

    const prefixes = deriveReflectionPathPrefixes(['frontend/src/components/Panel.jsx']);

    expect(prefixes).toContain('frontend/src/components/Panel.jsx/');
  });

  it('preserves prefixes that already include a trailing slash', () => {
    const { deriveReflectionPathPrefixes } = __automationUtilsTestHooks;

    const prefixes = deriveReflectionPathPrefixes(['frontend/src/utils/']);

    expect(prefixes).toContain('frontend/src/utils/');
  });

  it('treats falsy values as non-test paths', () => {
    const { isTestFilePath } = __automationUtilsTestHooks;

    expect(isTestFilePath('')).toBe(false);
    expect(isTestFilePath(null)).toBe(false);
  });

  it('detects canonical test filename patterns', () => {
    const { isTestFilePath } = __automationUtilsTestHooks;

    expect(isTestFilePath('frontend/src/__tests__/GoalPanel.test.jsx')).toBe(true);
    expect(isTestFilePath('backend/routes/spec/userRoutes.spec.ts')).toBe(true);
  });
});

describe('formatScopeReflectionContext helper', () => {
  it('returns an empty string when no reflection is provided', () => {
    expect(__automationUtilsTestHooks.formatScopeReflectionContext(null)).toBe('');
  });

  it('formats reasoning and default notes for scope reflections', () => {
    const block = __automationUtilsTestHooks.formatScopeReflectionContext({
      reasoning: '  tighten navigation scope  ',
      mustChange: ['frontend/src/components/NavBar.jsx'],
      mustAvoid: [],
      testsNeeded: false
    });

    expect(block).toContain('Scope reflection:');
    expect(block).toContain('Summary: tighten navigation scope');
    expect(block).toContain('Must change: frontend/src/components/NavBar.jsx');
    expect(block).toContain('Avoid changing: None noted');
    expect(block).toContain('Tests required: No');
  });

  it('omits the summary line when reasoning is unavailable', () => {
    const block = __automationUtilsTestHooks.formatScopeReflectionContext({
      reasoning: null,
      mustChange: [],
      mustAvoid: [],
      testsNeeded: true
    });

    expect(block).not.toContain('Summary:');
    expect(block).toContain('Tests required: Yes');
  });
});

describe('formatTestFailureJobSection helper', () => {
  it('serializes job metadata including command args and cwd', () => {
    const block = __automationUtilsTestHooks.formatTestFailureJobSection(
      {
        status: 'failed',
        duration: '12s',
        command: 'npm',
        args: ['run', 'test', '--', 'scope'],
        cwd: '/repo/frontend',
        type: 'integration'
      },
      0
    );

    expect(block).toContain('Job: integration (integration)');
    expect(block).toContain('Command: npm run test -- scope');
    expect(block).toContain('CWD: /repo/frontend');
  });

  it('falls back to a numbered label when no identifiers exist', () => {
    const block = __automationUtilsTestHooks.formatTestFailureJobSection({}, 2);

    expect(block).toContain('Job: Job 3');
  });

  it('skips command args when none are provided', () => {
    const block = __automationUtilsTestHooks.formatTestFailureJobSection(
      {
        command: 'npm',
        args: [],
        type: 'unit'
      },
      0
    );

    expect(block).toContain('Command: npm');
    expect(block).not.toContain('Command: npm ');
  });
});

describe('extractPathsFromTestFailureContext helper', () => {
  it('collects normalized paths from failures and logs', () => {
    const context = {
      jobs: [
        {
          testFailures: ['frontend/src/components/App.jsx > renders CTA'],
          recentLogs: ['ReferenceError at frontend/src/utils/api.js:10'],
          label: 'Frontend tests'
        }
      ]
    };

    const paths = __automationUtilsTestHooks.extractPathsFromTestFailureContext(context);

    expect(paths).toEqual(expect.arrayContaining([
      'frontend/src/components/App.jsx',
      'frontend/src/utils/api.js'
    ]));
  });

  it('returns an empty array when the context lacks jobs', () => {
    expect(__automationUtilsTestHooks.extractPathsFromTestFailureContext(null)).toEqual([]);
  });

  it('falls back to an empty failure list when jobs omit explicit failure ids', () => {
    const context = {
      jobs: [
        {
          recentLogs: ['panic: backend/routes/health.js:42']
        }
      ]
    };

    const paths = __automationUtilsTestHooks.extractPathsFromTestFailureContext(context);

    expect(paths).toEqual(['backend/routes/health.js']);
  });
});
