import { describe, expect, test } from 'vitest';
import { deriveStyleScopeContract, validateEditsAgainstReflection } from './reflection';

const normalizeRepoPath = (value) => String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');

describe('reflection style scope contract', () => {
  test('derives targeted style scope for element-scoped prompt', () => {
    const contract = deriveStyleScopeContract('make the navigation bar have a black background with white text');

    expect(contract).toEqual({
      mode: 'targeted',
      enforceTargetScoping: true,
      forbidGlobalSelectors: true
    });
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
