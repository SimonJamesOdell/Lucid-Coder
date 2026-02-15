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
});
