import { describe, expect, test } from 'vitest';
import { deriveStyleScopeContract, validateEditsAgainstReflection } from './reflection';

const normalizeRepoPath = (value) => String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');

describe('reflection style scope contract', () => {
  test('derives targeted style scope for element-scoped prompt', () => {
    const contract = deriveStyleScopeContract('make the navigation bar have a black background with white text');

    expect(contract).toEqual(
      expect.objectContaining({
        mode: 'targeted',
        enforceTargetScoping: true,
        forbidGlobalSelectors: true,
        targetHints: expect.arrayContaining(['navbar', 'navigation', 'nav'])
      })
    );
  });

  test('flags edits that touch global selectors for targeted style scope', () => {
    const reflection = {
      testsNeeded: true,
      mustAvoid: [],
      styleScope: {
        mode: 'targeted',
        enforceTargetScoping: true,
        forbidGlobalSelectors: true
      }
    };

    const violation = validateEditsAgainstReflection({
      reflection,
      normalizeRepoPath,
      edits: [
        {
          type: 'modify',
          path: 'frontend/src/index.css',
          replacements: [
            {
              search: 'body {\n  color: #111;\n}',
              replace: 'body {\n  background: #000;\n  color: #fff;\n}'
            }
          ]
        }
      ]
    });

    expect(violation).toEqual(
      expect.objectContaining({
        type: 'style-scope-global-selector',
        rule: 'targeted-style-scope'
      })
    );
  });

  test('flags broad global stylesheet edits when target hints are missing', () => {
    const reflection = {
      testsNeeded: true,
      mustAvoid: [],
      styleScope: {
        mode: 'targeted',
        enforceTargetScoping: true,
        forbidGlobalSelectors: true,
        targetHints: ['navbar', 'navigation', 'nav']
      }
    };

    const violation = validateEditsAgainstReflection({
      reflection,
      normalizeRepoPath,
      edits: [
        {
          type: 'modify',
          path: 'frontend/src/index.css',
          replacements: [
            {
              search: '--background-primary: #ffffff;',
              replace: '--background-primary: #000000;'
            }
          ]
        }
      ]
    });

    expect(violation).toEqual(
      expect.objectContaining({
        type: 'style-scope-target-missing',
        rule: 'targeted-style-scope'
      })
    );
  });

  test('allows global stylesheet edits when target hints are present in selectors', () => {
    const reflection = {
      testsNeeded: true,
      mustAvoid: [],
      styleScope: {
        mode: 'targeted',
        enforceTargetScoping: true,
        forbidGlobalSelectors: true,
        targetHints: ['navbar', 'navigation', 'nav']
      }
    };

    const violation = validateEditsAgainstReflection({
      reflection,
      normalizeRepoPath,
      edits: [
        {
          type: 'modify',
          path: 'frontend/src/index.css',
          replacements: [
            {
              search: '.navbar { color: #111; }',
              replace: '.navbar { background: #000; color: #fff; }'
            }
          ]
        }
      ]
    });

    expect(violation).toBeNull();
  });

  test('derives target hints for navigation bar requests', () => {
    const contract = deriveStyleScopeContract('make the navigation bar have a black background with white text');
    expect(contract?.mode).toBe('targeted');
    expect(contract?.targetHints).toEqual(expect.arrayContaining(['navbar', 'navigation', 'nav']));
  });

  test('allows global selector edits when prompt is explicitly global', () => {
    const reflection = {
      testsNeeded: true,
      mustAvoid: [],
      styleScope: {
        mode: 'global',
        enforceTargetScoping: false,
        forbidGlobalSelectors: false
      }
    };

    const violation = validateEditsAgainstReflection({
      reflection,
      normalizeRepoPath,
      edits: [
        {
          type: 'upsert',
          path: 'frontend/src/index.css',
          content: 'body { background: #000; color: #fff; }'
        }
      ]
    });

    expect(violation).toBeNull();
  });

  test('derives global style scope when prompt explicitly requests app-wide changes', () => {
    const contract = deriveStyleScopeContract('apply a global theme across the entire app');

    expect(contract).toEqual({
      mode: 'global',
      enforceTargetScoping: false,
      forbidGlobalSelectors: false,
      targetHints: []
    });
  });

  test('ignores unsupported edit types for global selector checks', () => {
    const reflection = {
      testsNeeded: true,
      mustAvoid: [],
      styleScope: {
        mode: 'targeted',
        enforceTargetScoping: true,
        forbidGlobalSelectors: true,
        targetHints: ['navbar']
      }
    };

    const violation = validateEditsAgainstReflection({
      reflection,
      normalizeRepoPath,
      edits: [
        {
          type: 'delete',
          path: 'frontend/src/index.css'
        }
      ]
    });

    expect(violation).toEqual(
      expect.objectContaining({
        type: 'style-scope-target-missing',
        rule: 'targeted-style-scope'
      })
    );
  });

  test('filters stop words from extracted target hints', () => {
    const contract = deriveStyleScopeContract('make the white card have blue text');

    expect(contract?.mode).toBe('targeted');
    expect(contract?.targetHints).toContain('card');
    expect(contract?.targetHints).not.toContain('white');
  });

  test('flags upsert edits in global stylesheet when target hints are missing', () => {
    const reflection = {
      testsNeeded: true,
      mustAvoid: [],
      styleScope: {
        mode: 'targeted',
        enforceTargetScoping: true,
        forbidGlobalSelectors: true,
        targetHints: ['navbar']
      }
    };

    const violation = validateEditsAgainstReflection({
      reflection,
      normalizeRepoPath,
      edits: [
        {
          type: 'upsert',
          path: 'frontend/src/index.css',
          content: '.button { color: #fff; }'
        }
      ]
    });

    expect(violation).toEqual(
      expect.objectContaining({
        type: 'style-scope-target-missing',
        rule: 'targeted-style-scope'
      })
    );
  });

  test('flags missing target hints when style scope has no extracted hints', () => {
    const reflection = {
      testsNeeded: true,
      mustAvoid: [],
      styleScope: {
        mode: 'targeted',
        enforceTargetScoping: true,
        forbidGlobalSelectors: true,
        targetHints: []
      }
    };

    const violation = validateEditsAgainstReflection({
      reflection,
      normalizeRepoPath,
      edits: [
        {
          type: 'modify',
          path: 'frontend/src/index.css',
          replacements: [
            {
              search: '.button { color: #111; }',
              replace: '.button { color: #eee; }'
            }
          ]
        }
      ]
    });

    expect(violation).toEqual(
      expect.objectContaining({
        type: 'style-scope-target-missing',
        rule: 'targeted-style-scope'
      })
    );
  });

  test('accepts global stylesheet edit when target hint appears in replacement text', () => {
    const reflection = {
      testsNeeded: true,
      mustAvoid: [],
      styleScope: {
        mode: 'targeted',
        enforceTargetScoping: true,
        forbidGlobalSelectors: true,
        targetHints: ['navbar']
      }
    };

    const violation = validateEditsAgainstReflection({
      reflection,
      normalizeRepoPath,
      edits: [
        {
          type: 'modify',
          path: 'frontend/src/index.css',
          replacements: [
            {
              search: '.header { color: #111; }',
              replace: '.header .navbar { color: #eee; }'
            }
          ]
        }
      ]
    });

    expect(violation).toBeNull();
  });

  test('accepts targeted edit when target hint appears in file path', () => {
    const reflection = {
      testsNeeded: true,
      mustAvoid: [],
      styleScope: {
        mode: 'targeted',
        enforceTargetScoping: true,
        forbidGlobalSelectors: true,
        targetHints: ['navbar']
      }
    };

    const violation = validateEditsAgainstReflection({
      reflection,
      normalizeRepoPath,
      edits: [
        {
          type: 'upsert',
          path: 'frontend/src/navbar.css',
          content: '.shell { color: #eee; }'
        }
      ]
    });

    expect(violation).toBeNull();
  });

  test('falls back safely when modify replacements contain non-string fields', () => {
    const reflection = {
      testsNeeded: true,
      mustAvoid: [],
      styleScope: {
        mode: 'targeted',
        enforceTargetScoping: true,
        forbidGlobalSelectors: true,
        targetHints: ['navbar']
      }
    };

    const violation = validateEditsAgainstReflection({
      reflection,
      normalizeRepoPath,
      edits: [
        {
          type: 'modify',
          path: 'frontend/src/index.css',
          replacements: [
            {
              search: null,
              replace: undefined
            }
          ]
        }
      ]
    });

    expect(violation).toEqual(
      expect.objectContaining({
        type: 'style-scope-target-missing'
      })
    );
  });

  test('falls back safely when upsert content is non-string', () => {
    const reflection = {
      testsNeeded: true,
      mustAvoid: [],
      styleScope: {
        mode: 'targeted',
        enforceTargetScoping: true,
        forbidGlobalSelectors: true,
        targetHints: ['navbar']
      }
    };

    const violation = validateEditsAgainstReflection({
      reflection,
      normalizeRepoPath,
      edits: [
        {
          type: 'upsert',
          path: 'frontend/src/index.css',
          content: { value: '.navbar { color: #fff; }' }
        }
      ]
    });

    expect(violation).toEqual(
      expect.objectContaining({
        type: 'style-scope-target-missing'
      })
    );
  });

  test('handles targeted style scope without targetHints field', () => {
    const reflection = {
      testsNeeded: true,
      mustAvoid: [],
      styleScope: {
        mode: 'targeted',
        enforceTargetScoping: true,
        forbidGlobalSelectors: true
      }
    };

    const violation = validateEditsAgainstReflection({
      reflection,
      normalizeRepoPath,
      edits: [
        {
          type: 'modify',
          path: 'frontend/src/index.css',
          replacements: [
            {
              search: '.button { color: #111; }',
              replace: '.button { color: #eee; }'
            }
          ]
        }
      ]
    });

    expect(violation).toEqual(
      expect.objectContaining({
        type: 'style-scope-target-missing'
      })
    );
  });
});
