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
let advanceGoalPhase;
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
    advanceGoalPhase,
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

  it('ignores child prompt metadata when a non-object is provided', async () => {
    const projectId = 921;
    const result = await createMetaGoalWithChildren({
      projectId,
      prompt: 'Plan refactor',
      childPrompts: ['Add docs'],
      childPromptMetadata: 'nope'
    });

    expect(result.children).toHaveLength(1);
    expect(result.children[0].prompt).toBe('Add docs');
  });

  it('filters child prompt metadata keys and applies matching overrides', async () => {
    const projectId = 922;
    const result = await createMetaGoalWithChildren({
      projectId,
      prompt: 'Plan refactor',
      childPrompts: ['Add docs', 'Ship UI'],
      childPromptMetadata: {
        'Add docs': { acceptanceCriteria: ['  Ship docs  '] },
        123: { acceptanceCriteria: ['Ignore this'] },
        '   ': { acceptanceCriteria: ['Ignore this too'] }
      }
    });

    const docsChild = result.children.find((child) => child.prompt === 'Add docs');
    expect(docsChild?.metadata?.acceptanceCriteria).toEqual(['Ship docs']);
  });

  it('drops metadata entries with empty prompt keys', async () => {
    const projectId = 923;
    const result = await createMetaGoalWithChildren({
      projectId,
      prompt: 'Plan refactor',
      childPrompts: ['Add docs'],
      childPromptMetadata: {
        '   ': { acceptanceCriteria: ['Ignore'] }
      }
    });

    const docsChild = result.children.find((child) => child.prompt === 'Add docs');
    expect(docsChild?.metadata?.acceptanceCriteria).toBeUndefined();
  });

  it('matches metadata keys after trimming whitespace', async () => {
    const projectId = 924;
    const result = await createMetaGoalWithChildren({
      projectId,
      prompt: 'Plan refactor',
      childPrompts: ['Add docs'],
      childPromptMetadata: {
        '  Add docs  ': { acceptanceCriteria: ['Ship docs'] }
      }
    });

    const docsChild = result.children.find((child) => child.prompt === 'Add docs');
    expect(docsChild?.metadata?.acceptanceCriteria).toEqual(['Ship docs']);
  });

  it('returns existing child goals when a parent already has children', async () => {
    const projectId = 925;
    const { goal: parent } = await createGoalFromPrompt({
      projectId,
      prompt: 'Parent goal with existing child'
    });

    await createChildGoal({
      projectId,
      parentGoalId: parent.id,
      prompt: 'Existing child'
    });

    const result = await createMetaGoalWithChildren({
      projectId,
      prompt: 'Plan refactor',
      parentGoalId: parent.id,
      childPrompts: ['New child (ignored)']
    });

    expect(result.parent.id).toBe(parent.id);
    expect(result.children).toHaveLength(1);
    expect(result.children[0].prompt).toBe('Existing child');
  });

  it('inherits styleOnly metadata from parent to children', async () => {
    const projectId = 926;
    const result = await createMetaGoalWithChildren({
      projectId,
      prompt: 'make the site background blue',
      childPrompts: ['Update the page background styles in existing CSS files']
    });

    expect(result.parent.metadata?.styleOnly).toBe(true);
    expect(result.children).toHaveLength(1);
    expect(result.children[0].metadata?.styleOnly).toBe(true);
  });

  it('preserves explicit child styleOnly=false when parent is styleOnly', async () => {
    const projectId = 927;
    const result = await createMetaGoalWithChildren({
      projectId,
      prompt: 'make the site background blue',
      childPrompts: ['Update the page background styles in existing CSS files'],
      childPromptMetadata: {
        'Update the page background styles in existing CSS files': {
          styleOnly: false,
          acceptanceCriteria: ['Keep this scoped to the specified target']
        }
      }
    });

    expect(result.parent.metadata?.styleOnly).toBe(true);
    expect(result.children).toHaveLength(1);
    expect(result.children[0].metadata?.styleOnly).toBe(false);
    expect(result.children[0].metadata?.acceptanceCriteria).toEqual(['Keep this scoped to the specified target']);
  });

  it('merges child metadata and enforces styleOnly=true when parent is styleOnly', async () => {
    const projectId = 928;
    const childPrompt = 'Update the page background styles in existing CSS files';
    const result = await createMetaGoalWithChildren({
      projectId,
      prompt: 'make the site background blue',
      childPrompts: [childPrompt],
      childPromptMetadata: {
        [childPrompt]: {
          acceptanceCriteria: ['Preserve spacing'],
          tags: ['ui', 'style']
        }
      }
    });

    expect(result.parent.metadata?.styleOnly).toBe(true);
    expect(result.children).toHaveLength(1);
    expect(result.children[0].metadata?.styleOnly).toBe(true);
    expect(result.children[0].metadata?.acceptanceCriteria).toEqual(['Preserve spacing']);
    expect(result.children[0].metadata?.tags).toEqual(['ui', 'style']);
  });
});

describe('mergeGoalMetadata suppression', () => {
  it('suppresses clarifying questions when testFailure metadata is provided', async () => {
    const projectId = 930;
    const { goal, tasks } = await createGoalFromPrompt({
      projectId,
      prompt: 'Investigate failing test',
      extraClarifyingQuestions: ['What should happen?'],
      metadataOverrides: {
        testFailure: { id: 'test-1' },
        clarifyingQuestions: ['Do not keep this'],
        acceptanceCriteria: ['Fix the failing test']
      }
    });

    expect(tasks.some((task) => task.type === 'clarification')).toBe(false);
    expect(tasks.some((task) => task.type === 'analysis')).toBe(true);
    expect(goal.metadata).toEqual(expect.objectContaining({ testFailure: { id: 'test-1' } }));
  });

  it('filters non-string and blank metadata values in acceptance criteria', async () => {
    const projectId = 931;
    const { goal } = await createGoalFromPrompt({
      projectId,
      prompt: 'Ship dashboard',
      metadataOverrides: {
        acceptanceCriteria: ['  Valid  ', 123, '   ']
      }
    });

    expect(goal.metadata?.acceptanceCriteria).toEqual(['Valid']);
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

describe('normalizePromptKey helper', () => {
  it('returns an empty string for non-string values', () => {
    const { normalizePromptKey } = __testExports__;
    expect(normalizePromptKey(42)).toBe('');
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

describe('planning heuristics helpers', () => {
  it('detects compound prompts and non-compound prompts', () => {
    const { isCompoundPrompt } = __testExports__;
    expect(isCompoundPrompt('Add login and signup pages')).toBe(true);
    expect(isCompoundPrompt('Add login page')).toBe(false);
    expect(isCompoundPrompt(42)).toBe(false);
  });

  it('classifies low-information plans via near-duplicate or compound prompts', () => {
    const { isLowInformationPlan } = __testExports__;

    const nearDuplicate = isLowInformationPlan('Implement audit logging', [
      { prompt: 'Implement audit logging' }
    ]);
    expect(nearDuplicate).toBe(true);

    const compound = isLowInformationPlan('Add login and signup pages', [
      { prompt: 'Implement login page' }
    ]);
    expect(compound).toBe(true);

    const notLowInfo = isLowInformationPlan('Add analytics dashboard', [
      { prompt: 'Create audit report view' }
    ]);
    expect(notLowInfo).toBe(false);

    const titleFallback = isLowInformationPlan('Draft spec', [
      { title: 'Draft spec' }
    ]);
    expect(titleFallback).toBe(true);
  });

  it('handles empty or non-array plan inputs as low-information', () => {
    const { isLowInformationPlan } = __testExports__;
    expect(isLowInformationPlan('Any prompt', [])).toBe(true);
    expect(isLowInformationPlan('Any prompt', null)).toBe(true);
  });

  it('returns false when multiple plans are provided', () => {
    const { isLowInformationPlan } = __testExports__;
    const result = isLowInformationPlan('Add dashboards', [
      { prompt: 'Implement dashboard' },
      { prompt: 'Document dashboard' }
    ]);
    expect(result).toBe(false);
  });

  it('returns false when the single plan has nested children', () => {
    const { isLowInformationPlan } = __testExports__;
    const result = isLowInformationPlan('Improve settings', [
      { prompt: 'Implement settings page', children: [{ prompt: 'Add profile section' }] }
    ]);
    expect(result).toBe(false);
  });

  it('handles empty child prompt/title fallback values', () => {
    const { isLowInformationPlan } = __testExports__;
    const result = isLowInformationPlan('Add dashboards', [
      { prompt: '', title: '' }
    ]);
    expect(result).toBe(false);
  });

  it('handles null plan entries when deriving child prompts', () => {
    const { isLowInformationPlan } = __testExports__;
    const result = isLowInformationPlan('Add dashboards', [null]);
    expect(result).toBe(false);
  });

  it('builds heuristic plans with fallback subject for non-string prompts', () => {
    const { buildHeuristicChildPlans } = __testExports__;
    const plans = buildHeuristicChildPlans(null);

    expect(plans.map((plan) => plan.prompt)).toEqual([
      'Identify the components, routes, and behaviors needed for the requested feature.',
      'Build the UI components required for the requested feature, including any reusable pieces.',
      'Wire the new components into the app and ensure the behavior matches the request for the requested feature.'
    ]);
  });
});

describe('planGoalFromPrompt', () => {
  it('routes style-only prompts through normal LLM planning', async () => {
    const prompt = 'Please switch the app background to bright green';

    llmClient.generateResponse.mockResolvedValueOnce(
      JSON.stringify({
        childGoals: [
          { prompt: 'Update app background styling to use the requested look.' },
          { prompt: 'Apply style changes in the relevant frontend styles/components.' },
          { prompt: 'Verify the resulting background presentation matches the request.' }
        ]
      })
    );

    const result = await planGoalFromPrompt({ projectId: 900, prompt });

    expect(llmClient.generateResponse).toHaveBeenCalled();
    const prompts = result.children.map((child) => child.prompt);
    expect(prompts[0]).toContain('background');
  });

  it('plans background styling prompts via LLM when no explicit color is detected', async () => {
    llmClient.generateResponse.mockResolvedValueOnce(
      JSON.stringify({
        childGoals: [
          { prompt: 'Identify affected app background styling surfaces.' },
          { prompt: 'Implement the requested background styling update.' },
          { prompt: 'Confirm the final styling behavior is correct.' }
        ]
      })
    );

    const result = await planGoalFromPrompt({ projectId: 901, prompt: 'Tweak the background styling across the app' });

    const prompts = result.children.map((child) => child.prompt);
    expect(llmClient.generateResponse).toHaveBeenCalled();
    expect(prompts[0]).toContain('background');
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

  it('parses clarification questions when NODE_ENV is not test', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    llmClient.generateResponse
      .mockResolvedValueOnce(
        JSON.stringify({
          childPrompts: ['Implement API', 'Document results']
        })
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          needsClarification: true,
          questions: ['Which API surface?', 'Any constraints?']
        })
      );

    try {
      const result = await planGoalFromPrompt({ projectId: 906, prompt: 'Add reporting' });

      expect(llmClient.generateResponse).toHaveBeenCalledTimes(2);
      expect(result.questions).toEqual(['Which API surface?', 'Any constraints?']);
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });


  it('falls back to heuristic plans when strict planning fails', async () => {
    llmClient.generateResponse
      .mockResolvedValueOnce(
        JSON.stringify({
          parentTitle: 'Profile Plan',
          questions: ['Need profile details?'],
          childGoals: [{ title: 'Add profile page', prompt: 'Add profile page' }]
        })
      )
      .mockRejectedValueOnce(new Error('strict planning failed'));

    const result = await planGoalFromPrompt({ projectId: 907, prompt: 'Add profile page' });

    expect(result.questions).toEqual(['Need profile details?']);
    const prompts = result.children.map((child) => child.prompt);
    expect(prompts[0]).toMatch(/^Identify the components/);
    expect(prompts).toHaveLength(3);
  });

  it('falls back to heuristic plans for compound prompts when strict planning fails', async () => {
    llmClient.generateResponse
      .mockResolvedValueOnce(
        JSON.stringify({
          parentTitle: 'Compound Plan',
          childGoals: [{ title: 'Build dashboard', prompt: 'Build dashboard' }]
        })
      )
      .mockRejectedValueOnce(new Error('strict planning failed'));

    const result = await planGoalFromPrompt({ projectId: 908, prompt: 'Build dashboard and settings' });

    const prompts = result.children.map((child) => child.prompt);
    expect(prompts[0]).toMatch(/^Identify the components/);
    expect(prompts).toHaveLength(3);
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

  it('throws when the LLM returns an empty childGoals array', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    llmClient.generateResponse.mockResolvedValueOnce(JSON.stringify({ childGoals: [] }));

    await expect(planGoalFromPrompt({ projectId: 908, prompt: 'Plan backlog' })).rejects.toThrow(
      'LLM planning response has empty childGoals array'
    );

    errorSpy.mockRestore();
  });

  it('throws when no usable prompts remain after filtering', async () => {
    llmClient.generateResponse.mockResolvedValueOnce(
      JSON.stringify({ childPrompts: ['   ', 9001] })
    );

    await expect(planGoalFromPrompt({ projectId: 906, prompt: 'Plan cleanup' })).rejects.toThrow(
      'LLM planning produced no usable child prompts'
    );
  });

  it('does not retry strict planning when multiple child goals are provided', async () => {
    llmClient.generateResponse.mockResolvedValueOnce(
      JSON.stringify({
        childGoals: [
          { prompt: 'Implement API layer' },
          { prompt: 'Document API usage' }
        ]
      })
    );

    const result = await planGoalFromPrompt({ projectId: 910, prompt: 'Add API support' });

    expect(llmClient.generateResponse).toHaveBeenCalledTimes(1);
    expect(result.children.map((child) => child.prompt)).toEqual([
      'Implement API layer',
      'Document API usage'
    ]);
  });

  it('uses the latest current request for planning when prompt includes conversation wrappers', async () => {
    const wrappedPrompt = [
      'Conversation context:',
      'User: make the page yellow',
      'Assistant: sure',
      '',
      'Current request: Use the image as the site background'
    ].join('\n');

    llmClient.generateResponse.mockResolvedValueOnce(
      JSON.stringify({
        childGoals: [{ prompt: 'Implement background image usage from selected assets' }]
      })
    );

    const result = await planGoalFromPrompt({ projectId: 911, prompt: wrappedPrompt });

    const plannerMessages = llmClient.generateResponse.mock.calls[0]?.[0] || [];
    const userMessage = plannerMessages.find((message) => message?.role === 'user');

    expect(userMessage?.content || '').toContain('Use the image as the site background');
    expect(userMessage?.content || '').not.toContain('Conversation context:');
    expect(result.parent.prompt).toBe('Use the image as the site background');
  });

  it('includes selected project assets in planner context when present', async () => {
    const wrappedPrompt = [
      'Conversation context:',
      'User: use the image',
      '',
      'Selected project assets:',
      '- uploads/bg.png',
      '',
      'Current request: Use the image as the site background'
    ].join('\n');

    llmClient.generateResponse.mockResolvedValueOnce(
      JSON.stringify({
        childGoals: [{ prompt: 'Apply the provided image asset as page background' }]
      })
    );

    await planGoalFromPrompt({ projectId: 912, prompt: wrappedPrompt });

    const plannerMessages = llmClient.generateResponse.mock.calls[0]?.[0] || [];
    const userMessage = plannerMessages.find((message) => message?.role === 'user');

    expect(userMessage?.content || '').toContain('Selected project assets:');
    expect(userMessage?.content || '').toContain('uploads/bg.png');
  });

  it('falls back to the original prompt when extractLatestRequest returns a non-string', async () => {
    const promptHeuristics = await import('../services/promptHeuristics.js');
    const latestRequestSpy = vi.spyOn(promptHeuristics, 'extractLatestRequest').mockReturnValueOnce({ value: 'invalid' });

    llmClient.generateResponse.mockResolvedValueOnce(
      JSON.stringify({
        childGoals: [{ prompt: 'Use fallback prompt for planning context' }]
      })
    );

    const rawPrompt = 'Build dashboard widgets';
    const result = await planGoalFromPrompt({ projectId: 917, prompt: rawPrompt });

    const plannerMessages = llmClient.generateResponse.mock.calls[0]?.[0] || [];
    const userMessage = plannerMessages.find((message) => message?.role === 'user');

    expect(userMessage?.content || '').toContain(rawPrompt);
    expect(result.parent.prompt).toBe(rawPrompt);

    latestRequestSpy.mockRestore();
  });

  it('retries planning for compound prompts even without near-duplicate child goals', async () => {
    llmClient.generateResponse
      .mockResolvedValueOnce(
        JSON.stringify({
          childGoals: [{ prompt: 'Implement login page' }]
        })
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          childGoals: [
            { prompt: 'Implement login page' },
            { prompt: 'Implement signup page' }
          ]
        })
      );

    const result = await planGoalFromPrompt({
      projectId: 911,
      prompt: 'Add login and signup pages'
    });

    expect(llmClient.generateResponse).toHaveBeenCalledTimes(2);
    expect(result.children.map((child) => child.prompt)).toEqual([
      'Implement login page',
      'Implement signup page'
    ]);
  });

  it('does not retry when prompt is not compound and child is not near-duplicate', async () => {
    llmClient.generateResponse.mockResolvedValueOnce(
      JSON.stringify({
        childGoals: [{ prompt: 'Create audit report view' }]
      })
    );

    const result = await planGoalFromPrompt({
      projectId: 913,
      prompt: 'Add analytics dashboard'
    });

    expect(llmClient.generateResponse).toHaveBeenCalledTimes(1);
    expect(result.children.map((child) => child.prompt)).toEqual(['Create audit report view']);
  });

  it('treats empty-normalized prompts as not compound', async () => {
    llmClient.generateResponse.mockResolvedValueOnce(
      JSON.stringify({
        childGoals: [{ prompt: 'Capture audit metrics' }]
      })
    );

    const result = await planGoalFromPrompt({
      projectId: 915,
      prompt: '   '
    });

    expect(llmClient.generateResponse).toHaveBeenCalledTimes(1);
    expect(result.children.map((child) => child.prompt)).toEqual(['Capture audit metrics']);
  });

  it('retries planning when the child goal is a near-duplicate of the prompt', async () => {
    llmClient.generateResponse
      .mockResolvedValueOnce(
        JSON.stringify({
          childGoals: [{ prompt: 'Implement audit logging' }]
        })
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          childGoals: [
            { prompt: 'Implement audit logging' },
            { prompt: 'Document audit logging usage' }
          ]
        })
      );

    const result = await planGoalFromPrompt({
      projectId: 916,
      prompt: 'Implement audit logging'
    });

    expect(llmClient.generateResponse).toHaveBeenCalledTimes(2);
    expect(result.children.map((child) => child.prompt)).toEqual([
      'Implement audit logging',
      'Document audit logging usage'
    ]);
  });

  it('avoids strict retry when the single child goal includes nested children', async () => {
    llmClient.generateResponse.mockResolvedValueOnce(
      JSON.stringify({
        childGoals: [
          {
            prompt: 'Implement settings page',
            children: [{ prompt: 'Add profile section' }]
          }
        ]
      })
    );

    const result = await planGoalFromPrompt({
      projectId: 914,
      prompt: 'Improve settings UI'
    });

    expect(llmClient.generateResponse).toHaveBeenCalledTimes(1);
    expect(result.children.map((child) => child.prompt)).toEqual(['Implement settings page']);
    expect(result.children[0].children.map((child) => child.prompt)).toEqual(['Add profile section']);
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

  it('falls back to heuristic child plans when strict retry fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    llmClient.generateResponse
      .mockResolvedValueOnce(
        JSON.stringify({
          childGoals: [{ prompt: 'Add login and signup pages' }]
        })
      )
      .mockResolvedValueOnce('invalid json');

    const result = await planGoalFromPrompt({
      projectId: 909,
      prompt: 'Add login and signup pages'
    });

    expect(warnSpy).toHaveBeenCalled();
    expect(result.children.map((child) => child.prompt)).toEqual([
      'Identify the components, routes, and behaviors needed for Add login and signup pages.',
      'Build the UI components required for Add login and signup pages, including any reusable pieces.',
      'Wire the new components into the app and ensure the behavior matches the request for Add login and signup pages.'
    ]);

    warnSpy.mockRestore();
  });

  it('logs non-error strict retry failures and falls back to heuristics', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    llmClient.generateResponse
      .mockResolvedValueOnce(
        JSON.stringify({
          childGoals: [{ prompt: 'Update sidebar' }]
        })
      )
      .mockImplementationOnce(() => {
        throw { code: 'boom' };
      });

    const result = await planGoalFromPrompt({
      projectId: 912,
      prompt: 'Update sidebar'
    });

    expect(warnSpy).toHaveBeenCalled();
    expect(result.children.map((child) => child.prompt)).toEqual([
      'Identify the components, routes, and behaviors needed for Update sidebar.',
      'Build the UI components required for Update sidebar, including any reusable pieces.',
      'Wire the new components into the app and ensure the behavior matches the request for Update sidebar.'
    ]);

    warnSpy.mockRestore();
  });
});

describe('advanceGoalPhase coverage', () => {
  it('updates the goal phase via stored status helper', async () => {
    const projectId = 920;
    const { goal } = await createGoalFromPrompt({ projectId, prompt: 'Create phase coverage' });

    const updated = await advanceGoalPhase(goal.id, 'testing', { note: 'phase update' });

    expect(updated.status).toBe('testing');
    expect(updated.metadata).toEqual(expect.objectContaining({ note: 'phase update' }));
  });
});
