import { describe, it, expect, beforeEach } from 'vitest';
import { initializeDatabase } from '../database.js';
import { createGoalFromPrompt } from '../services/agentOrchestrator.js';

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

describe('agentOrchestrator clarification gating (integration coverage)', () => {
  beforeEach(async () => {
    await initializeDatabase();
    await resetAgentTables();
  });

  it('covers clarification gating helper branches via createGoalFromPrompt', async () => {
    const whitespacePrompt = '   ';
    const { tasks: whitespaceTasks } = await createGoalFromPrompt({
      projectId: 1,
      prompt: whitespacePrompt
    });
    expect(whitespaceTasks[0].type).toBe('clarification');

    const genericBuildPrompt = 'Build a thing';
    const { tasks: genericBuildTasks } = await createGoalFromPrompt({
      projectId: 1,
      prompt: genericBuildPrompt
    });
    expect(genericBuildTasks[0].type).toBe('clarification');

    const specificBuildPrompt = 'Build a todo system';
    const { tasks: specificBuildTasks } = await createGoalFromPrompt({
      projectId: 1,
      prompt: specificBuildPrompt
    });
    expect(specificBuildTasks[0].type).toBe('analysis');
  });
});
