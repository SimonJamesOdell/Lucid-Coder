import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

import { initializeDatabase } from '../database.js';

vi.mock('../llm-client.js', () => ({
  llmClient: {
    generateResponse: vi.fn()
  }
}));

let agentModule;
let createGoalFromPrompt;
let createChildGoal;
let createMetaGoalWithChildren;
let planGoalFromPrompt;
let __testExports__;
let llmClient;

const resetAgentTables = async () => {
  const { default: db } = await import('../database.js');
  await new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('DELETE FROM agent_tasks', (err) => {
        if (err && !/no such table/i.test(err.message)) return reject(err);
        db.run('DELETE FROM agent_goals', (err2) => {
          if (err2 && !/no such table/i.test(err2.message)) return reject(err2);
          resolve();
        });
      });
    });
  });
};

beforeAll(async () => {
  await initializeDatabase();
  agentModule = await import('../services/agentOrchestrator.js');
  ({
    planGoalFromPrompt,
    createGoalFromPrompt,
    createChildGoal,
    createMetaGoalWithChildren,
    __testExports__
  } = agentModule);
  ({ llmClient } = await import('../llm-client.js'));
});

beforeEach(async () => {
  await resetAgentTables();
});

afterEach(() => {
  llmClient.generateResponse.mockReset();
});

describe('deriveGoalTitle helper', () => {
  it('strips filler prefixes and preserves uppercase acronyms', () => {
    const { deriveGoalTitle } = __testExports__;
    const title = deriveGoalTitle('Please add API docs for admin area');
    expect(title).toBe('Add API Docs for Admin Area');
  });

  it('falls back to the provided default when the content is empty after sanitizing', () => {
    const { deriveGoalTitle } = __testExports__;
    expect(deriveGoalTitle('""')).toBe('Goal');
  });

  it('returns the fallback immediately when the raw prompt is blank', () => {
    const { deriveGoalTitle } = __testExports__;
    expect(deriveGoalTitle('   ')).toBe('Goal');
  });

  it('coerces non-string inputs and still returns a usable fallback', () => {
    const { deriveGoalTitle } = __testExports__;
    expect(deriveGoalTitle({ unexpected: true })).toBe('Goal');
  });

  it('wraps extremely long prompts without splitting the trailing word', () => {
    const { deriveGoalTitle } = __testExports__;
    const noisyPrompt = 'Please' + ' add more descriptive context'.repeat(15);
    const title = deriveGoalTitle(noisyPrompt);
    expect(title.length).toBeLessThanOrEqual(96);
    expect(title.endsWith(' ')).toBe(false);
  });
});

describe('createChildGoal input validation', () => {
  it('rejects non-string prompts before trimming', async () => {
    const projectId = 910;
    const { goal } = await createGoalFromPrompt({ projectId, prompt: 'Create child parent goal' });

    await expect(
      createChildGoal({ projectId, parentGoalId: goal.id, prompt: { text: 'invalid' } })
    ).rejects.toThrow('prompt is required');
  });

  it('rejects prompts that become empty after trimming whitespace', async () => {
    const projectId = 911;
    const { goal } = await createGoalFromPrompt({ projectId, prompt: 'Parent goal for blanks' });

    await expect(
      createChildGoal({ projectId, parentGoalId: goal.id, prompt: '    ' })
    ).rejects.toThrow('prompt is required');
  });
});

describe('createMetaGoalWithChildren helper', () => {
  it('normalizes string-based child prompts alongside explicit objects', async () => {
    const projectId = 920;
    const result = await createMetaGoalWithChildren({
      projectId,
      prompt: 'Plan refactor',
      childPrompts: [
        '  tighten up the API types  ',
        { prompt: 'Improve docs', title: 'Docs Refresh' },
        { prompt: 'Add backend tests' },
        123
      ]
    });

    expect(result.children).toHaveLength(3);
    expect(result.children[0].prompt).toBe('tighten up the API types');
    expect(result.children[0].title).toBe('Tighten Up the API Types');
    expect(result.children[1].title).toBe('Docs Refresh');
    expect(result.children[2].title).toBe('Add Backend Tests');
  });
});

describe('normalizePlannerPrompt helper', () => {
  it('trims valid strings', () => {
    const { normalizePlannerPrompt } = __testExports__;
    expect(normalizePlannerPrompt('  spaced  ')).toBe('spaced');
  });

  it('returns an empty string for non-string values', () => {
    const { normalizePlannerPrompt } = __testExports__;
    expect(normalizePlannerPrompt({})).toBe('');
  });
});

describe('normalizeChildPlans helper', () => {
  it('skips invalid entries from both object and string sources', () => {
    const { normalizeChildPlans } = __testExports__;
    const plans = normalizeChildPlans([
      { prompt: '  Implement auth flow  ', title: 'Existing Title' },
      { prompt: '   ' },
      'Improve docs',
      '   ',
      { prompt: null, title: 'Missing prompt' },
      'Refactor API'
    ]);

    expect(plans.map((plan) => plan.prompt)).toEqual([
      'Implement auth flow',
      'Improve docs',
      'Refactor API'
    ]);
    expect(plans[0].title).toBe('Existing Title');
    expect(plans[1].title).toBe('Improve Docs');
    expect(plans[2].title).toBe('Refactor API');
  });
});

describe('planGoalFromPrompt', () => {
  it('routes style-only prompts through the CSS-only path and propagates colors', async () => {
    const prompt = 'Please switch the background to bright green for the hero section';

    const result = await planGoalFromPrompt({ projectId: 900, prompt });

    expect(llmClient.generateResponse).not.toHaveBeenCalled();
    const prompts = result.children.map((child) => child.prompt);
    expect(prompts).toEqual([
      'Create a branch for this change if needed.',
      'Change the background color to bright green (CSS-only change; no tests required).',
      'Stage the updated file(s).'
    ]);
  });

  it('falls back to a generic background description when color is not detected', async () => {
    const result = await planGoalFromPrompt({ projectId: 901, prompt: 'Tweak the background styling across the app' });

    const prompts = result.children.map((child) => child.prompt);
    expect(prompts[1]).toBe('Update the background color as requested (CSS-only change; no tests required).');
  });

  it('parses structured childGoals objects and filters unusable prompts', async () => {
    llmClient.generateResponse.mockResolvedValueOnce(
      JSON.stringify({
        parentTitle: 'Refine navigation',
        childGoals: [
          { title: 'Audit navigation', prompt: '  Analyse nav experience  ' },
          { title: 'Missing prompt', prompt: 42 },
          { title: 404, prompt: 'Document navigation decisions' }
        ]
      })
    );

    const result = await planGoalFromPrompt({ projectId: 902, prompt: 'Improve navigation' });

    expect(llmClient.generateResponse).toHaveBeenCalledTimes(1);
    expect(result.parent.title).toBe('Refine navigation');
    expect(result.children.map((child) => child.prompt)).toEqual([
      'Analyse nav experience',
      'Document navigation decisions'
    ]);
  });

  it('accepts childPrompts arrays and drops invalid or duplicate entries', async () => {
    llmClient.generateResponse.mockResolvedValueOnce(
      JSON.stringify({
        childPrompts: [
          'Implement API',
          '  ',
          123,
          'Document results',
          'Implement API'
        ]
      })
    );

    const result = await planGoalFromPrompt({ projectId: 903, prompt: 'Add reporting' });
    expect(result.children.map((child) => child.prompt)).toEqual([
      'Implement API',
      'Document results'
    ]);
  });

  it('throws when the LLM response cannot be parsed as JSON', async () => {
    llmClient.generateResponse.mockResolvedValueOnce('totally invalid json');

    await expect(planGoalFromPrompt({ projectId: 904, prompt: 'Plan something' })).rejects.toThrow(
      'LLM planning response was not valid JSON'
    );
  });

  it('throws when the LLM payload does not include child goals', async () => {
    llmClient.generateResponse.mockResolvedValueOnce(JSON.stringify({ parentTitle: 'Missing plans' }));

    await expect(planGoalFromPrompt({ projectId: 905, prompt: 'Plan onboarding' })).rejects.toThrow(
      'LLM planning response missing childGoals array'
    );
  });

  it('throws when no usable prompts remain after filtering', async () => {
    llmClient.generateResponse.mockResolvedValueOnce(
      JSON.stringify({ childPrompts: ['   ', 9001] })
    );

    await expect(planGoalFromPrompt({ projectId: 906, prompt: 'Plan cleanup' })).rejects.toThrow(
      'LLM planning produced no usable child prompts'
    );
  });

  it('filters out programmatic verification instructions from the LLM response', async () => {
    llmClient.generateResponse.mockResolvedValueOnce(
      JSON.stringify({
        childPrompts: [
          'Run unit tests before shipping',
          'Implement telemetry hooks',
          'Re-run coverage once done'
        ]
      })
    );

    const result = await planGoalFromPrompt({ projectId: 907, prompt: 'Add observability' });
    expect(result.children.map((child) => child.prompt)).toEqual(['Implement telemetry hooks']);
  });
});
