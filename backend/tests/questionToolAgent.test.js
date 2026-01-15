import { describe, it, expect, vi, beforeEach } from 'vitest';
import { answerProjectQuestion, __testUtils } from '../services/questionToolAgent.js';
import { llmClient } from '../llm-client.js';
import * as projectTools from '../services/projectTools.js';
import * as goalStore from '../services/goalStore.js';

vi.mock('../llm-client.js', () => ({
  llmClient: {
    generateResponse: vi.fn()
  }
}));

vi.mock('../services/projectTools.js', () => ({
  readProjectFile: vi.fn()
}));

vi.mock('../services/goalStore.js', () => ({
  listGoals: vi.fn()
}));

const mockSteps = (responses = []) => {
  llmClient.generateResponse.mockReset();
  responses.forEach((value) => {
    llmClient.generateResponse.mockResolvedValueOnce(
      typeof value === 'string' ? value : JSON.stringify(value)
    );
  });
};

describe('questionToolAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    goalStore.listGoals.mockResolvedValue([]);
  });

  it('requires a projectId', async () => {
    await expect(answerProjectQuestion({ prompt: 'hello' })).rejects.toThrow(/projectid is required/i);
  });

  it('requires a non-empty prompt', async () => {
    await expect(answerProjectQuestion({ projectId: 1, prompt: '   ' })).rejects.toThrow(/prompt is required/i);
  });

  it('reads project files and returns an answer', async () => {
    mockSteps([
      { action: 'read_file', path: 'README.md', reason: 'Need project overview' },
      { action: 'answer', answer: 'The project is called LSML Composer.' }
    ]);

    projectTools.readProjectFile.mockResolvedValue('# LSML Composer\nA full-stack web application');

    const result = await answerProjectQuestion({
      projectId: 99,
      prompt: 'What is the name of this project?'
    });

    expect(projectTools.readProjectFile).toHaveBeenCalledWith(99, 'README.md');
    expect(result.answer).toMatch(/lsml composer/i);
    expect(result.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'action', action: 'read_file', target: 'README.md' }),
        expect.objectContaining({ type: 'observation', action: 'read_file', target: 'README.md' }),
        expect.objectContaining({ type: 'answer' })
      ])
    );
  });

  it('preloads stored goals for goal-related prompts', async () => {
    mockSteps([{ action: 'answer', answer: 'Here are your current goals.' }]);

    goalStore.listGoals.mockResolvedValue([
      {
        id: 123,
        parentGoalId: null,
        prompt: 'Remove the title card on the homepage',
        status: 'planning',
        lifecycleState: 'draft',
        createdAt: '2025-12-30 00:00:00',
        updatedAt: '2025-12-30 00:00:00'
      }
    ]);

    const result = await answerProjectQuestion({ projectId: 42, prompt: 'continue goals' });

    expect(goalStore.listGoals).toHaveBeenCalledWith(42);
    expect(result.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'action', action: 'list_goals', target: 'agent_goals' }),
        expect.objectContaining({ type: 'observation', action: 'list_goals', target: 'agent_goals' })
      ])
    );
  });

  it('records an empty-goals preload observation when no goals are stored', async () => {
    mockSteps([{ action: 'answer', answer: 'Ok.' }]);

    // default beforeEach listGoals resolves to [], but keep this explicit.
    goalStore.listGoals.mockResolvedValueOnce([]);

    const result = await answerProjectQuestion({ projectId: 42, prompt: 'show goals' });

    expect(goalStore.listGoals).toHaveBeenCalledWith(42);
    expect(result.answer).toMatch(/ok/i);
    expect(result.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'action', action: 'list_goals', target: 'agent_goals' }),
        expect.objectContaining({
          type: 'observation',
          action: 'list_goals',
          target: 'agent_goals',
          summary: 'No stored goals found for this project.'
        })
      ])
    );
  });

  it('captures goal preloading failures as observations and continues', async () => {
    mockSteps([{ action: 'answer', answer: 'Ok.' }]);

    goalStore.listGoals.mockRejectedValueOnce(new Error('db down'));

    const result = await answerProjectQuestion({ projectId: 101, prompt: 'show goals' });

    expect(result.answer).toMatch(/ok/i);
    expect(result.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'action', action: 'list_goals', target: 'agent_goals' }),
        expect.objectContaining({ type: 'observation', action: 'list_goals', target: 'agent_goals', error: 'db down' })
      ])
    );
  });

  it('falls back to a generic goal preload error message when no details are provided', async () => {
    mockSteps([{ action: 'answer', answer: 'Ok.' }]);

    goalStore.listGoals.mockRejectedValueOnce({});

    const result = await answerProjectQuestion({ projectId: 101, prompt: 'show goals' });

    expect(result.answer).toMatch(/ok/i);
    expect(result.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'action', action: 'list_goals', target: 'agent_goals' }),
        expect.objectContaining({
          type: 'observation',
          action: 'list_goals',
          target: 'agent_goals',
          error: 'Failed to list goals'
        })
      ])
    );
  });

  it('parses planner actions even when wrapped in prose', async () => {
    mockSteps([
      'Sure thing! {"action":"read_file","path":"README.md","reason":"Find stack info"}\nLet me grab that.',
      { action: 'answer', answer: 'It uses React and Express.' }
    ]);

    projectTools.readProjectFile.mockResolvedValue('Uses React on frontend and Express on backend.');

    const result = await answerProjectQuestion({ projectId: 5, prompt: 'What tech stack does it use?' });

    expect(projectTools.readProjectFile).toHaveBeenCalledWith(5, 'README.md');
    expect(result.answer).toMatch(/react/i);
  });

  it('falls back to context aggregation when the loop hits the iteration limit', async () => {
    mockSteps([
      { action: 'read_file', path: 'README.md', reason: 'Need info' },
      { action: 'read_file', path: 'package.json', reason: 'Double check' },
      { action: 'read_file', path: 'frontend/package.json', reason: 'More info' },
      { action: 'read_file', path: 'backend/package.json', reason: 'Still unsure' },
      'The project uses React on the frontend and Express on the backend.'
    ]);

    projectTools.readProjectFile.mockResolvedValue('sample context');

    const result = await answerProjectQuestion({ projectId: 1, prompt: 'What frameworks are used?' });

    expect(result.answer).toMatch(/react/i);
    expect(result.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'fallback_context' }),
        expect.objectContaining({ action: 'read_file', target: 'README.md' })
      ])
    );
    expect(llmClient.generateResponse).toHaveBeenCalledTimes(5);
  });

  it('throws when no fallback context can be gathered', async () => {
    mockSteps([
      { action: 'read_file', path: 'README.md', reason: 'Need info' },
      { action: 'read_file', path: 'package.json', reason: 'Double check' },
      { action: 'read_file', path: 'frontend/package.json', reason: 'More info' },
      { action: 'read_file', path: 'backend/package.json', reason: 'Still unsure' }
    ]);

    projectTools.readProjectFile.mockRejectedValue(new Error('missing'));

    await expect(
      answerProjectQuestion({ projectId: 1, prompt: 'What is this?' })
    ).rejects.toThrow(/unable to answer the question/i);
  });

  it('throws when planner output omits the action field', async () => {
    mockSteps([{ path: 'README.md' }]);

    await expect(
      answerProjectQuestion({ projectId: 2, prompt: 'Describe the project' })
    ).rejects.toThrow(/invalid json/i);
  });

  it('throws when planner returns non-object JSON', async () => {
    mockSteps(['"just a string"']);

    await expect(
      answerProjectQuestion({ projectId: 2, prompt: 'Describe the project' })
    ).rejects.toThrow(/invalid json/i);
  });

  it('returns a fallback answer when planner returns invalid JSON and fallback context exists', async () => {
    mockSteps(['not json', 'Fallback answer.']);

    projectTools.readProjectFile.mockImplementation(async (_projectId, relativePath) => {
      if (relativePath === 'README.md') {
        return 'Hello from README';
      }
      throw new Error('missing');
    });

    const result = await answerProjectQuestion({ projectId: 9, prompt: 'What is this?' });
    expect(result.answer).toMatch(/fallback answer/i);
    expect(result.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'action', action: 'fallback_context' }),
        expect.objectContaining({ type: 'observation', action: 'read_file', target: 'README.md' })
      ])
    );
  });

  it('uses the planner self-repair path outside of test env', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    try {
      mockSteps([
        'not json',
        { action: 'answer', answer: 'Repaired answer.' }
      ]);

      const result = await answerProjectQuestion({ projectId: 10, prompt: 'What is this?' });
      expect(result.answer).toMatch(/repaired answer/i);
      expect(llmClient.generateResponse).toHaveBeenCalledTimes(2);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('uses an empty repair draft when rawDecision is non-string', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    try {
      llmClient.generateResponse.mockReset();
      llmClient.generateResponse
        .mockResolvedValueOnce({ not: 'a string' })
        .mockResolvedValueOnce('{"action":"answer","answer":"Ok."}');

      const result = await answerProjectQuestion({ projectId: 12, prompt: 'What is this?' });
      expect(result.answer).toMatch(/ok/i);
      expect(llmClient.generateResponse).toHaveBeenCalledTimes(2);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('falls back when planner self-repair still returns invalid JSON', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    try {
      mockSteps(['not json', 'still not json', 'Fallback answer after failed repair.']);

      projectTools.readProjectFile.mockImplementation(async (_projectId, relativePath) => {
        if (relativePath === 'README.md') {
          return 'Hello from README';
        }
        throw new Error('missing');
      });

      const result = await answerProjectQuestion({ projectId: 11, prompt: 'What is this?' });
      expect(result.answer).toMatch(/fallback answer after failed repair/i);
      expect(llmClient.generateResponse).toHaveBeenCalledTimes(3);
      expect(result.steps).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'action', action: 'fallback_context' })])
      );
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('throws when read_file action lacks a path', async () => {
    mockSteps([{ action: 'read_file' }]);

    await expect(
      answerProjectQuestion({ projectId: 2, prompt: 'Describe the project' })
    ).rejects.toThrow(/missing path/i);
    expect(projectTools.readProjectFile).not.toHaveBeenCalled();
  });

  it('throws when answer action lacks text', async () => {
    mockSteps([{ action: 'answer', answer: '   ' }]);

    await expect(
      answerProjectQuestion({ projectId: 3, prompt: 'Describe the project' })
    ).rejects.toThrow(/answer action missing answer text/i);
  });

  it('captures read_file errors as observations and continues planning', async () => {
    mockSteps([
      { action: 'read_file', path: 'README.md' },
      { action: 'answer', answer: 'Done.' }
    ]);

    projectTools.readProjectFile.mockRejectedValueOnce(new Error('boom'));

    const result = await answerProjectQuestion({ projectId: 7, prompt: 'Summarize it' });

    expect(result.answer).toMatch(/done/i);
    expect(result.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'observation', error: 'boom' })
      ])
    );
  });

  it('handles list_goals actions inside the planning loop', async () => {
    mockSteps([
      { action: 'list_goals' },
      { action: 'answer', answer: 'No goals.' }
    ]);

    goalStore.listGoals.mockResolvedValueOnce([]);

    const result = await answerProjectQuestion({ projectId: 9, prompt: 'What is the current status?' });

    expect(goalStore.listGoals).toHaveBeenCalledWith(9);
    expect(result.answer).toMatch(/no goals/i);
    expect(result.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'action', action: 'list_goals', target: 'agent_goals' }),
        expect.objectContaining({ type: 'observation', action: 'list_goals', target: 'agent_goals', summary: 'No stored goals found for this project.' })
      ])
    );
  });

  it('records list_goals failures during the planning loop and continues', async () => {
    mockSteps([
      { action: 'list_goals' },
      { action: 'answer', answer: 'Proceeding.' }
    ]);

    goalStore.listGoals.mockRejectedValueOnce({});

    const result = await answerProjectQuestion({ projectId: 10, prompt: 'What is the current status?' });

    expect(result.answer).toMatch(/proceeding/i);
    expect(result.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'action', action: 'list_goals', target: 'agent_goals' }),
        expect.objectContaining({ type: 'observation', action: 'list_goals', target: 'agent_goals', error: 'Failed to list goals' })
      ])
    );
  });

  it('prefers error.message when list_goals throws an Error instance', async () => {
    mockSteps([
      { action: 'list_goals' },
      { action: 'answer', answer: 'Proceeding.' }
    ]);

    goalStore.listGoals.mockRejectedValueOnce(new Error('db exploded'));

    const result = await answerProjectQuestion({ projectId: 13, prompt: 'Give me a status update' });

    expect(result.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'observation', action: 'list_goals', target: 'agent_goals', error: 'db exploded' })
      ])
    );
  });

  it('records non-empty stored goals during list_goals actions in the planning loop', async () => {
    mockSteps([
      { action: 'list_goals' },
      { action: 'answer', answer: 'Loaded goals.' }
    ]);

    goalStore.listGoals.mockResolvedValueOnce([
      {
        id: 2,
        parentGoalId: null,
        prompt: 'Tighten tests',
        status: 'planning',
        lifecycleState: 'draft',
        createdAt: '2025-12-30 00:00:00',
        updatedAt: '2025-12-30 00:00:00'
      }
    ]);

    const result = await answerProjectQuestion({ projectId: 12, prompt: 'status?' });

    expect(result.answer).toMatch(/loaded goals/i);
    expect(result.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'observation', action: 'list_goals', target: 'agent_goals' })
      ])
    );
    const goalObservation = result.steps.find((step) => step.type === 'observation' && step.action === 'list_goals');
    expect(goalObservation.summary).toContain('Tighten tests');
  });

  it('falls back to a generic read_file error message when no details are provided', async () => {
    mockSteps([
      { action: 'read_file', path: 'README.md' },
      { action: 'answer', answer: 'Done.' }
    ]);

    projectTools.readProjectFile.mockRejectedValueOnce({});

    const result = await answerProjectQuestion({ projectId: 71, prompt: 'Summarize it' });

    expect(result.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'observation', error: 'Failed to read file' })
      ])
    );
  });

  it('returns fallback content when planner replies unable', async () => {
    mockSteps([
      { action: 'unable', explanation: 'Need direct context' },
      'Fallback answer based on files.'
    ]);

    projectTools.readProjectFile.mockResolvedValue('# README\nDetails');

    const result = await answerProjectQuestion({ projectId: 4, prompt: 'Summarize the project' });

    expect(result.answer).toMatch(/fallback answer/i);
    expect(result.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'fallback_context' }),
        expect.objectContaining({ action: 'read_file', target: 'README.md' })
      ])
    );
    expect(llmClient.generateResponse).toHaveBeenCalledTimes(2);
  });

  it('includes stored goals in fallback context when prompt is goal-related', async () => {
    mockSteps([
      { action: 'unable', explanation: 'Need context' },
      'Fallback answer including goals.'
    ]);

    goalStore.listGoals.mockResolvedValue([
      {
        id: 1,
        parentGoalId: null,
        prompt: 'Ship v1',
        status: 'planning',
        lifecycleState: 'draft',
        createdAt: '2025-12-30 00:00:00',
        updatedAt: '2025-12-30 00:00:00'
      }
    ]);

    projectTools.readProjectFile.mockImplementation(async (_projectId, relativePath) => {
      return `content for ${relativePath}`;
    });

    const result = await answerProjectQuestion({ projectId: 11, prompt: 'list goals' });

    expect(result.answer).toMatch(/including goals/i);
    expect(result.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'fallback_context' }),
        expect.objectContaining({ type: 'observation', action: 'read_file', target: 'agent_goals' })
      ])
    );
  });

  it('does not include agent_goals fallback section when no stored goals exist', async () => {
    mockSteps([
      { action: 'unable', explanation: 'Need context' },
      'Fallback answer without goals.'
    ]);

    goalStore.listGoals.mockResolvedValue([]);
    projectTools.readProjectFile.mockResolvedValue('# README\nDetails');

    const result = await answerProjectQuestion({ projectId: 11, prompt: 'resume goals' });

    expect(result.answer).toMatch(/without goals/i);
    const hasAgentGoalsSection = result.steps.some(
      (step) => step.type === 'observation' && step.action === 'read_file' && step.target === 'agent_goals'
    );
    expect(hasAgentGoalsSection).toBe(false);
  });

  it('can answer via fallback using only stored goals when fallback files are missing', async () => {
    mockSteps([
      { action: 'unable', explanation: 'Need context' },
      'Fallback answer from goals only.'
    ]);

    goalStore.listGoals.mockResolvedValue([
      {
        id: 1,
        parentGoalId: null,
        prompt: 'Ship v1',
        status: 'planning',
        lifecycleState: 'draft',
        createdAt: '2025-12-30 00:00:00',
        updatedAt: '2025-12-30 00:00:00'
      }
    ]);

    // Force all fallback file reads to fail so the only section comes from agent_goals.
    projectTools.readProjectFile.mockRejectedValue(new Error('missing'));

    const result = await answerProjectQuestion({ projectId: 11, prompt: 'resume goals' });

    expect(result.answer).toMatch(/goals only/i);
    expect(result.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'fallback_context' }),
        expect.objectContaining({ type: 'observation', action: 'read_file', target: 'agent_goals' })
      ])
    );
  });

  it('throws when unable fallback produces no answer', async () => {
    mockSteps([
      { action: 'unable', explanation: 'Not enough info' },
      '   '
    ]);

    projectTools.readProjectFile.mockResolvedValue('# README\nDetails');

    await expect(
      answerProjectQuestion({ projectId: 5, prompt: 'Summarize the project' })
    ).rejects.toThrow(/not enough info/i);
  });

  it('throws default error when unable action lacks explanation and fallback fails', async () => {
    mockSteps([{ action: 'unable' }]);
    projectTools.readProjectFile.mockRejectedValue(new Error('missing'));

    await expect(
      answerProjectQuestion({ projectId: 8, prompt: 'Summarize the project' })
    ).rejects.toThrow(/cannot answer the question/i);
  });

  it('throws for unknown agent actions', async () => {
    mockSteps([{ action: 'dance' }]);

    await expect(
      answerProjectQuestion({ projectId: 6, prompt: 'Summarize the project' })
    ).rejects.toThrow(/unknown agent action/i);
  });
});

describe('questionToolAgent helpers', () => {
  const { formatStepsForPrompt, summarizeContent, coerceJsonObject, shouldIncludeGoalsContext } = __testUtils;

  it('formats action, observation, answer, and fallback entries', () => {
    const steps = [
      { type: 'action', action: 'read_file', target: 'README.md', reason: 'Need overview' },
      { type: 'observation', action: 'read_file', target: 'README.md', summary: 'Project summary' },
      { type: 'observation', action: 'read_file', target: 'missing.md', error: 'Not found' },
      { type: 'answer', content: 'All set' },
      { type: 'note', foo: 'bar' }
    ];

    const output = formatStepsForPrompt(steps);
    expect(output).toMatch(/Step 1 ACTION: read_file README.md \(Need overview\)/);
    expect(output).toMatch(/Step 2 OBSERVATION: read_file README.md -> Project summary/);
    expect(output).toMatch(/Step 3 OBSERVATION: Failed to read_file missing.md -> Not found/);
    expect(output).toMatch(/Step 4 ANSWER: All set/);
    expect(output).toMatch(/Step 5 NOTE:/);
  });

  it('summarizes content for empty, short, and long inputs', () => {
    expect(summarizeContent('')).toBe('No content returned.');
    expect(summarizeContent('short text')).toBe('short text');
    const long = 'x'.repeat(1300);
    const result = summarizeContent(long, 50);
    expect(result).toContain('…content truncated…');
    expect(result.startsWith('x'.repeat(50))).toBe(true);
  });

  it('coerces JSON embedded within text and rejects invalid payloads', () => {
    const embedded = 'noise before {"action":"answer","answer":"done"} trailing';
    expect(coerceJsonObject(embedded)).toMatchObject({ action: 'answer', answer: 'done' });
    expect(coerceJsonObject('')).toBeNull();
    expect(coerceJsonObject('   ')).toBeNull();
    expect(coerceJsonObject('not json')).toBeNull();
    expect(coerceJsonObject({})).toBeNull();
  });

  it('omits optional target and reason text when formatting steps', () => {
    const steps = [
      { type: 'action', action: 'plan' },
      { type: 'observation', action: 'read_file', summary: '' }
    ];

    const output = formatStepsForPrompt(steps);
    expect(output).toContain('Step 1 ACTION: plan');
    expect(output).toContain('Step 2 OBSERVATION: read_file  ->');
  });

  it('returns "None" when no steps have been recorded yet', () => {
    expect(formatStepsForPrompt()).toBe('None');
    expect(formatStepsForPrompt([])).toBe('None');
  });

  it('formats failed observations without target hints', () => {
    const steps = [{ type: 'observation', action: 'read_file', error: 'boom' }];
    const output = formatStepsForPrompt(steps);
    expect(output).toContain('Failed to read_file  -> boom');
  });

  it('detects goal-related prompts for stored-goal preloading', () => {
    expect(shouldIncludeGoalsContext('continue goals')).toBe(true);
    expect(shouldIncludeGoalsContext('show goals')).toBe(true);
    expect(shouldIncludeGoalsContext('list goal')).toBe(true);
    expect(shouldIncludeGoalsContext('resume goals')).toBe(true);
    expect(shouldIncludeGoalsContext('My goals are to ship v1')).toBe(true);
    expect(shouldIncludeGoalsContext('   ')).toBe(false);
    expect(shouldIncludeGoalsContext(123)).toBe(false);
    expect(shouldIncludeGoalsContext('What frameworks are used?')).toBe(false);
  });
});
