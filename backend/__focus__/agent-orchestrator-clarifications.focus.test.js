import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initializeDatabase, createProject } from '../database.js';
import {
  createGoalFromPrompt,
  getGoalWithTasks,
  planGoalFromPrompt,
  __testExports__
} from '../services/agentOrchestrator.js';
import { llmClient } from '../llm-client.js';

vi.mock('../llm-client.js', () => {
  const originalModule = vi.importActual('../llm-client.js');
  return {
    ...originalModule,
    llmClient: {
      generateResponse: vi.fn()
    }
  };
});

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

describe('agentOrchestrator clarification behavior', () => {
  beforeEach(async () => {
    await initializeDatabase();
    await resetAgentTables();
  });

  afterEach(() => {
    llmClient.generateResponse.mockReset();
  });

  it('creates analysis tasks when no clarifying questions exist', async () => {
    const { tasks } = await createGoalFromPrompt({ projectId: 1, prompt: '   ' });

    expect(tasks).toHaveLength(1);
    expect(tasks[0].type).toBe('analysis');
  });

  it('normalizes extra clarifying questions without injecting defaults', () => {
    const { buildGoalMetadataFromPrompt } = __testExports__;

    const result = buildGoalMetadataFromPrompt({
      prompt: null,
      extraClarifyingQuestions: ['  Needs detail ', '', 'Needs detail']
    });

    expect(result).toMatchObject({
      metadata: { clarifyingQuestions: ['Needs detail'] },
      clarifyingQuestions: ['Needs detail'],
      styleOnly: false
    });
  });

  it('stores planner clarifying questions on the parent goal', async () => {
    const project = await createProject({
      name: 'Focus Project',
      description: 'Testing clarifications',
      framework: '',
      language: '',
      path: ''
    });

    llmClient.generateResponse.mockResolvedValue(
      JSON.stringify({
        parentTitle: 'Add dashboards',
        questions: ['Which dashboard layout should we use?'],
        childGoals: [{ title: 'Sketch layout', prompt: 'Create a dashboard layout draft.' }]
      })
    );

    const result = await planGoalFromPrompt({ projectId: project.id, prompt: 'Add dashboards' });

    expect(result.questions).toEqual(['Which dashboard layout should we use?']);
    const snapshot = await getGoalWithTasks(result.parent.id);
    expect(snapshot.goal.metadata.clarifyingQuestions).toEqual(['Which dashboard layout should we use?']);
    expect(snapshot.tasks[0].type).toBe('clarification');
  });
});
