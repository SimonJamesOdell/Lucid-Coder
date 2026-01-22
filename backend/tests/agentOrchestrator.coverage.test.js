import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initializeDatabase } from '../database.js';
import {
  createGoalFromPrompt,
  createChildGoal,
  planGoalFromPrompt,
  advanceGoalPhase,
  __testExports__
} from '../services/agentOrchestrator.js';

vi.mock('../llm-client.js', () => ({
  llmClient: {
    generateResponse: vi.fn()
  }
}));

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

describe('agentOrchestrator coverage (tests suite)', () => {
  beforeEach(async () => {
    await initializeDatabase();
    await resetAgentTables();
  });

  afterEach(async () => {
    const { llmClient } = await import('../llm-client.js');
    llmClient.generateResponse.mockReset();
  });

  it('updates the goal phase using stored status helper', async () => {
    const { goal } = await createGoalFromPrompt({ projectId: 1200, prompt: 'Create phase coverage' });

    const updated = await advanceGoalPhase(goal.id, 'testing', { note: 'phase update' });

    expect(updated.status).toBe('testing');
    expect(updated.metadata).toEqual(expect.objectContaining({ note: 'phase update' }));
  });

  it('parses clarification questions from the planner response', async () => {
    const { llmClient } = await import('../llm-client.js');
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
      const result = await planGoalFromPrompt({ projectId: 1201, prompt: 'Add reporting' });

      expect(llmClient.generateResponse).toHaveBeenCalledTimes(2);
      expect(result.questions).toEqual(['Which API surface?', 'Any constraints?']);
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it('falls back to heuristic plans when strict planning fails', async () => {
    const { llmClient } = await import('../llm-client.js');

    llmClient.generateResponse
      .mockResolvedValueOnce(
        JSON.stringify({
          parentTitle: 'Profile Plan',
          questions: ['Need profile details?'],
          childGoals: [{ title: 'Add profile page', prompt: 'Add profile page' }]
        })
      )
      .mockRejectedValueOnce(new Error('strict planning failed'));

    const result = await planGoalFromPrompt({ projectId: 1202, prompt: 'Add profile page' });

    expect(result.questions).toEqual(['Need profile details?']);
    const prompts = result.children.map((child) => child.prompt);
    expect(prompts[0]).toMatch(/^Identify the components/);
    expect(prompts).toHaveLength(3);
  });

  it('plans CSS-only prompts with detected colors', async () => {
    const { llmClient } = await import('../llm-client.js');

    const result = await planGoalFromPrompt({
      projectId: 1204,
      prompt: 'Change the background color to bright green'
    });

    expect(llmClient.generateResponse).not.toHaveBeenCalled();
    const prompts = result.children.map((child) => child.prompt);
    expect(prompts).toEqual([
      'Create a branch for this change if needed.',
      'Change the background color to bright green (CSS-only change; no tests required).',
      'Stage the updated file(s).'
    ]);
  });

  it('plans CSS-only prompts with a generic background description when color is missing', async () => {
    const { llmClient } = await import('../llm-client.js');

    const result = await planGoalFromPrompt({
      projectId: 1205,
      prompt: 'Tweak the background styling across the app'
    });

    expect(llmClient.generateResponse).not.toHaveBeenCalled();
    const prompts = result.children.map((child) => child.prompt);
    expect(prompts[1]).toBe('Update the background color as requested (CSS-only change; no tests required).');
  });

  it('falls back to heuristic plans with null parent title when strict retry fails', async () => {
    const { llmClient } = await import('../llm-client.js');

    llmClient.generateResponse
      .mockResolvedValueOnce(
        JSON.stringify({
          childGoals: [{ prompt: 'Add login and signup pages' }]
        })
      )
      .mockRejectedValueOnce(new Error('strict planning failed'));

    const result = await planGoalFromPrompt({
      projectId: 1206,
      prompt: 'Add login and signup pages'
    });

    expect(result.questions).toEqual([]);
    const prompts = result.children.map((child) => child.prompt);
    expect(prompts[0]).toMatch(/^Identify the components/);
    expect(prompts).toHaveLength(3);
  });

  it('logs strict planning retry failures for low-information plans', async () => {
    const { llmClient } = await import('../llm-client.js');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    llmClient.generateResponse
      .mockResolvedValueOnce(
        JSON.stringify({
          childGoals: [{ title: 'Implement audit logging', prompt: 'Implement audit logging' }]
        })
      )
      .mockRejectedValueOnce({ code: 'retry-failed' });

    const result = await planGoalFromPrompt({ projectId: 1207, prompt: 'Implement audit logging' });

    expect(warnSpy).toHaveBeenCalledWith(
      '[WARN] Strict planning retry failed:',
      { code: 'retry-failed' }
    );
    expect(result.questions).toEqual([]);
    const prompts = result.children.map((child) => child.prompt);
    expect(prompts[0]).toMatch(/^Identify the components/);
    expect(prompts).toHaveLength(3);

    warnSpy.mockRestore();
  });

  it('returns the fallback title when the prompt collapses to empty after prefix removal', () => {
    const { deriveGoalTitle } = __testExports__;

    const title = deriveGoalTitle('Please', { fallback: 'Goal' });

    expect(title).toBe('Goal');
  });

  it('rejects child goal prompts that trim to empty', async () => {
    const { goal } = await createGoalFromPrompt({ projectId: 1203, prompt: 'Parent goal' });

    await expect(
      createChildGoal({ projectId: 1203, parentGoalId: goal.id, prompt: '   ' })
    ).rejects.toThrow('prompt is required');
  });

  it('evaluates compound prompts in low-information plan detection', () => {
    const { isLowInformationPlan } = __testExports__;

    const lowInfo = isLowInformationPlan('Add login and signup pages', [{ prompt: 'Implement settings page' }]);
    expect(lowInfo).toBe(true);

    const notLowInfo = isLowInformationPlan('Add login and signup pages', [
      { prompt: 'Implement settings page' },
      { prompt: 'Document settings page' }
    ]);
    expect(notLowInfo).toBe(false);
  });

  it('builds heuristic plans with a fallback subject for non-string prompts', () => {
    const { buildHeuristicChildPlans } = __testExports__;

    const plans = buildHeuristicChildPlans(null);
    expect(plans).toHaveLength(3);
    expect(plans[0].prompt).toMatch(/the requested feature/);
  });

  it('exercises low-information plan helpers for compound prompts', () => {
    const { isLowInformationPlan, buildHeuristicChildPlans } = __testExports__;

    const plans = [{ prompt: 'Implement settings page' }];
    expect(isLowInformationPlan('Add login and signup pages', plans)).toBe(true);

    const heuristics = buildHeuristicChildPlans('Add login and signup pages');
    expect(heuristics).toHaveLength(3);
  });

  it('logs strict retry failures when compound prompt triggers low-information retry', async () => {
    const { llmClient } = await import('../llm-client.js');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    llmClient.generateResponse
      .mockResolvedValueOnce(
        JSON.stringify({
          childGoals: [{ prompt: 'Implement settings page' }]
        })
      )
      .mockRejectedValueOnce(new Error('strict retry failed'));

    const result = await planGoalFromPrompt({ projectId: 1208, prompt: 'Add login and signup pages' });

    expect(warnSpy).toHaveBeenCalledWith(
      '[WARN] Strict planning retry failed:',
      'strict retry failed'
    );
    expect(result.questions).toEqual([]);
    const prompts = result.children.map((child) => child.prompt);
    expect(prompts[0]).toMatch(/^Identify the components/);
    expect(prompts).toHaveLength(3);

    warnSpy.mockRestore();
  });
});
