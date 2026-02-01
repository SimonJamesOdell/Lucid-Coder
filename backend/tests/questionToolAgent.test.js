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
  readProjectFile: vi.fn(),
  listProjectDirectory: vi.fn()
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

  it('throws when the loop hits the iteration limit without an answer', async () => {
    mockSteps([
      { action: 'read_file', path: 'README.md', reason: 'Need info' },
      { action: 'read_file', path: 'package.json', reason: 'Double check' },
      { action: 'read_file', path: 'frontend/package.json', reason: 'More info' },
      { action: 'read_file', path: 'backend/package.json', reason: 'Still unsure' }
    ]);

    projectTools.readProjectFile.mockResolvedValue('sample context');

    await expect(
      answerProjectQuestion({ projectId: 1, prompt: 'What frameworks are used?' })
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

    const result = await answerProjectQuestion({ projectId: 2, prompt: 'Describe the project' });

    expect(result.answer).toMatch(/just a string/i);
    expect(result.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'answer', content: expect.stringMatching(/just a string/i) })
      ])
    );
  });

  it('accepts plain-text answers when planner does not return JSON', async () => {
    mockSteps(['The project is named LSML Composer.']);

    const result = await answerProjectQuestion({ projectId: 2, prompt: 'Describe the project' });

    expect(result.answer).toMatch(/lsml composer/i);
    expect(result.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'answer', content: expect.stringMatching(/lsml composer/i) })
      ])
    );
  });

  it('throws when planner returns invalid JSON without repair', async () => {
    mockSteps(['not json']);

    const result = await answerProjectQuestion({ projectId: 9, prompt: 'What is this?' });
    expect(result.answer).toBe('not json');
  });

  it('skips planner repair in test env and throws on invalid JSON', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';

    try {
      llmClient.generateResponse.mockReset();
      llmClient.generateResponse.mockResolvedValueOnce({ bad: 'payload' });

      await expect(
        answerProjectQuestion({ projectId: 19, prompt: 'What is this?' })
      ).rejects.toThrow(/invalid json/i);

      expect(llmClient.generateResponse).toHaveBeenCalledTimes(1);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
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
      expect(result.answer).toBe('not json');
      expect(llmClient.generateResponse).toHaveBeenCalledTimes(1);
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

  it('builds an empty assistant draft when repairing non-string output (stubbed env)', async () => {
    vi.stubEnv('NODE_ENV', 'development');

    llmClient.generateResponse.mockReset();
    llmClient.generateResponse
      .mockResolvedValueOnce({ not: 'a string' })
      .mockResolvedValueOnce('{"action":"answer","answer":"Ok."}');

    const result = await answerProjectQuestion({ projectId: 16, prompt: 'What is this?' });
    expect(result.answer).toMatch(/ok/i);

    const secondCallMessages = llmClient.generateResponse.mock.calls?.[1]?.[0];
    const assistantDraft = Array.isArray(secondCallMessages)
      ? secondCallMessages.find((message) => message.role === 'assistant')
      : null;
    expect(assistantDraft?.content).toBe('');

    vi.unstubAllEnvs();
  });

  it('includes the raw decision text in the repair assistant draft', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    try {
      llmClient.generateResponse.mockReset();
      llmClient.generateResponse
        .mockResolvedValueOnce('{"foo":"bar"}')
        .mockResolvedValueOnce('{"action":"answer","answer":"Ok."}');

      const result = await answerProjectQuestion({ projectId: 20, prompt: 'What is this?' });
      expect(result.answer).toMatch(/ok/i);

      const secondCallMessages = llmClient.generateResponse.mock.calls?.[1]?.[0];
      const assistantDraft = Array.isArray(secondCallMessages)
        ? secondCallMessages.find((message) => message.role === 'assistant')
        : null;
      expect(assistantDraft?.content).toBe('{"foo":"bar"}');
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('passes an empty assistant draft to the repair prompt for non-string decisions', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    try {
      llmClient.generateResponse.mockReset();
      llmClient.generateResponse
        .mockResolvedValueOnce({ not: 'a string' })
        .mockResolvedValueOnce('{"action":"answer","answer":"Ok."}');

      const result = await answerProjectQuestion({ projectId: 14, prompt: 'What is this?' });
      expect(result.answer).toMatch(/ok/i);

      const secondCallMessages = llmClient.generateResponse.mock.calls?.[1]?.[0];
      const assistantDraft = Array.isArray(secondCallMessages)
        ? secondCallMessages.find((message) => message.role === 'assistant')
        : null;
      expect(assistantDraft?.content).toBe('');
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('throws when planner self-repair still returns invalid JSON', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    try {
      mockSteps(['not json', 'still not json']);

      const result = await answerProjectQuestion({ projectId: 11, prompt: 'What is this?' });
      expect(result.answer).toBe('not json');
      expect(llmClient.generateResponse).toHaveBeenCalledTimes(1);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('throws when repair returns invalid JSON payloads outside test env', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    try {
      llmClient.generateResponse.mockReset();
      llmClient.generateResponse
        .mockResolvedValueOnce({ bad: 'planner output' })
        .mockResolvedValueOnce({ still: 'bad' });

      await expect(
        answerProjectQuestion({ projectId: 15, prompt: 'What is this?' })
      ).rejects.toThrow(/invalid json/i);

      expect(llmClient.generateResponse).toHaveBeenCalledTimes(2);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('handles list_dir actions inside the planning loop', async () => {
    mockSteps([
      { action: 'list_dir', path: '', reason: 'Scan root' },
      { action: 'read_file', path: 'README.md' },
      { action: 'answer', answer: 'Project name found.' }
    ]);

    projectTools.listProjectDirectory.mockResolvedValueOnce([
      { name: 'README.md', type: 'file' },
      { name: 'frontend', type: 'dir' }
    ]);
    projectTools.readProjectFile.mockResolvedValueOnce('Project README');

    const result = await answerProjectQuestion({ projectId: 7, prompt: 'What is the name?' });

    expect(result.answer).toMatch(/project name found/i);
    expect(result.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'action', action: 'list_dir', target: '.' }),
        expect.objectContaining({ type: 'observation', action: 'list_dir', target: '.' })
      ])
    );
  });

  it('uses a default reason for list_dir actions when none is provided', async () => {
    mockSteps([
      { action: 'list_dir', path: '' },
      { action: 'answer', answer: 'Ok.' }
    ]);

    projectTools.listProjectDirectory.mockResolvedValueOnce([{ name: 'README.md', type: 'file' }]);

    const result = await answerProjectQuestion({ projectId: 18, prompt: 'What files exist?' });

    expect(result.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'action', action: 'list_dir', reason: 'List files and folders' })
      ])
    );
  });

  it('records empty directory summaries for list_dir actions', async () => {
    mockSteps([
      { action: 'list_dir', path: 'src', reason: 'Check src' },
      { action: 'answer', answer: 'Ok.' }
    ]);

    projectTools.listProjectDirectory.mockResolvedValueOnce([]);

    const result = await answerProjectQuestion({ projectId: 21, prompt: 'What files exist?' });

    const observation = result.steps.find((step) => step.type === 'observation' && step.action === 'list_dir');
    expect(observation?.summary).toBe('Directory is empty.');
  });

  it('captures list_dir errors as observations and continues planning', async () => {
    mockSteps([
      { action: 'list_dir', path: 'src', reason: 'Check src' },
      { action: 'answer', answer: 'Ok.' }
    ]);

    projectTools.listProjectDirectory.mockRejectedValueOnce(new Error('no access'));

    const result = await answerProjectQuestion({ projectId: 22, prompt: 'What files exist?' });

    expect(result.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'observation', action: 'list_dir', error: 'no access' })
      ])
    );
  });

  it('records list_dir errors with default target and message', async () => {
    mockSteps([
      { action: 'list_dir' },
      { action: 'answer', answer: 'Ok.' }
    ]);

    projectTools.listProjectDirectory.mockRejectedValueOnce({});

    const result = await answerProjectQuestion({ projectId: 24, prompt: 'What files exist?' });

    expect(result.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'observation',
          action: 'list_dir',
          target: '.',
          error: 'Failed to list directory'
        })
      ])
    );
  });

  it('uses the default list_dir error message when error has no message', async () => {
    mockSteps([
      { action: 'list_dir', path: 'src' },
      { action: 'answer', answer: 'Ok.' }
    ]);

    projectTools.listProjectDirectory.mockRejectedValueOnce({});

    const result = await answerProjectQuestion({ projectId: 23, prompt: 'What files exist?' });

    expect(result.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'observation', action: 'list_dir', error: 'Failed to list directory' })
      ])
    );
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

    await expect(
      answerProjectQuestion({ projectId: 4, prompt: 'Summarize the project' })
    ).rejects.toThrow(/need direct context/i);
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

    await expect(
      answerProjectQuestion({ projectId: 11, prompt: 'list goals' })
    ).rejects.toThrow(/need context/i);
  });

  it('does not include agent_goals fallback section when no stored goals exist', async () => {
    mockSteps([
      { action: 'unable', explanation: 'Need context' },
      'Fallback answer without goals.'
    ]);

    goalStore.listGoals.mockResolvedValue([]);
    projectTools.readProjectFile.mockResolvedValue('# README\nDetails');

    await expect(
      answerProjectQuestion({ projectId: 11, prompt: 'resume goals' })
    ).rejects.toThrow(/need context/i);
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

    await expect(
      answerProjectQuestion({ projectId: 11, prompt: 'resume goals' })
    ).rejects.toThrow(/need context/i);
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
