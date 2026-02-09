import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { initializeDatabase, createProject } from '../database.js';
import {
  createGoalFromPrompt,
  createChildGoal,
  createMetaGoalWithChildren,
  getGoalWithTasks,
  listGoalsForProject,
  deleteGoalById,
  advanceGoalState,
  advanceGoalPhase,
  recordTestRunForGoal,
  planGoalFromPrompt,
  ensureGoalBranch,
  __testExports__
} from '../services/agentOrchestrator.js';
import { llmClient } from '../llm-client.js';
import * as goalStore from '../services/goalStore.js';
import * as gitUtils from '../utils/git.js';

vi.mock('../llm-client.js', () => {
  const originalModule = vi.importActual('../llm-client.js');
  return {
    ...originalModule,
    llmClient: {
      generateResponse: vi.fn()
    }
  };
});
import * as jobRunner from '../services/jobRunner.js';

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

const forceGoalStatus = async (goalId, status) => {
  const { default: db } = await import('../database.js');
  await new Promise((resolve, reject) => {
    db.run(
      'UPDATE agent_goals SET status = ?, metadata = ? WHERE id = ?',
      [status, JSON.stringify(null), goalId],
      (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      }
    );
  });
};

const forceGoalCreatedAt = async (goalId, createdAt) => {
  const { default: db } = await import('../database.js');
  await new Promise((resolve, reject) => {
    db.run(
      'UPDATE agent_goals SET created_at = ? WHERE id = ?',
      [createdAt, goalId],
      (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      }
    );
  });
};

describe('agentOrchestrator', () => {
  beforeEach(async () => {
    await initializeDatabase();
    await resetAgentTables();
  });

  afterEach(() => {
    llmClient.generateResponse.mockReset();
  });

  it('creates a goal with initial analysis task and planning status', async () => {
    const { goal, tasks } = await createGoalFromPrompt({
      projectId: 1,
      prompt: 'Build a todo system'
    });

    expect(goal).toMatchObject({
      projectId: 1,
      prompt: 'Build a todo system',
      status: 'planning',
      parentGoalId: null
    });
    expect(goal.title).toBe('Build a Todo System');
    expect(Array.isArray(tasks)).toBe(true);
    expect(tasks[0]).toMatchObject({
      goalId: goal.id,
      type: 'analysis',
      status: 'pending'
    });
  });

  it('derives readable titles by trimming filler phrases from prompts', async () => {
    const { goal } = await createGoalFromPrompt({
      projectId: 2,
      prompt: 'Please add a sticky header for docs pages'
    });

    expect(goal.title).toBe('Add a Sticky Header for Docs Pages');
  });

  it('createGoalFromPrompt validates required fields', async () => {
    await expect(createGoalFromPrompt({ prompt: 'Missing project' })).rejects.toThrow('projectId is required');
    await expect(createGoalFromPrompt({ projectId: 1 })).rejects.toThrow('prompt is required');
    await expect(createGoalFromPrompt({ projectId: 1, prompt: 123 })).rejects.toThrow('prompt is required');
  });

  it('treats whitespace-only prompts as analysis tasks', async () => {
    const { tasks } = await createGoalFromPrompt({ projectId: 1, prompt: '   ' });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].type).toBe('analysis');
  });

  it('creates an analysis task when the prompt has no clarifying questions', async () => {
    const prompt = 'Build something';

    const { goal, tasks } = await createGoalFromPrompt({ projectId: 1, prompt });

    expect(goal.metadata).toBeNull();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      goalId: goal.id,
      type: 'analysis',
      status: 'pending',
      payload: {
        prompt
      }
    });
  });

  it('treats generic build prompts as analysis tasks when no clarifications exist', async () => {
    const prompt = 'Build a thing';

    const { goal, tasks } = await createGoalFromPrompt({ projectId: 1, prompt });

    expect(goal.metadata).toBeNull();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      type: 'analysis',
      payload: {
        prompt
      }
    });
  });

  it('does not auto-request clarifications for bug fix prompts', async () => {
    const prompt = 'Fix login bug';

    const { goal, tasks } = await createGoalFromPrompt({ projectId: 1, prompt });

    expect(goal.metadata).toBeNull();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      type: 'analysis',
      payload: {
        prompt
      }
    });
  });

  it('extracts acceptance criteria from prompt into goal metadata and analysis task payload', async () => {
    const prompt =
      'Build a login form.\n' +
      '\n' +
      'Acceptance criteria:\n' +
      '- Email is required\n' +
      '- Password is required\n' +
      '1. Submit is disabled until valid\n';

    const { goal, tasks } = await createGoalFromPrompt({
      projectId: 1,
      prompt
    });

    expect(goal.metadata).toMatchObject({
      acceptanceCriteria: ['Email is required', 'Password is required', 'Submit is disabled until valid']
    });

    expect(tasks[0].payload).toMatchObject({
      prompt,
      acceptanceCriteria: ['Email is required', 'Password is required', 'Submit is disabled until valid']
    });
  });

  it('extracts inline acceptance criteria and stops when criteria section ends', async () => {
    const prompt =
      'Build a login form.\n' +
      'Acceptance criteria: Users can log in\n' +
      '\n' +
      '- This bullet should be ignored because the section ended';

    const { goal, tasks } = await createGoalFromPrompt({ projectId: 1, prompt });

    expect(goal.metadata).toMatchObject({ acceptanceCriteria: ['Users can log in'] });
    expect(tasks[0].payload).toMatchObject({ acceptanceCriteria: ['Users can log in'] });
  });

  it('skips blank lines inside acceptance criteria section and stops on new header', async () => {
    const prompt =
      'Build a login form.\n' +
      'Acceptance criteria:\n' +
      '\n' +
      '1) Email is required\n' +
      'Notes:\n' +
      '- This bullet should not be treated as acceptance criteria';

    const { goal, tasks } = await createGoalFromPrompt({ projectId: 1, prompt });

    expect(goal.metadata).toMatchObject({ acceptanceCriteria: ['Email is required'] });
    expect(tasks[0].payload).toMatchObject({ acceptanceCriteria: ['Email is required'] });
  });

  it('does not attach acceptance criteria when prompt omits a criteria section', async () => {
    const prompt = 'Build a login form with email + password.';

    const { goal, tasks } = await createGoalFromPrompt({ projectId: 1, prompt });

    expect(goal.metadata).toBeNull();
    expect(tasks[0].payload).toEqual({ prompt });
  });

  it('marks style-only prompts in goal metadata', async () => {
    const { goal, tasks } = await createGoalFromPrompt({
      projectId: 1,
      prompt: 'Change the background color to blue (CSS only)'
    });

    expect(goal.metadata).toMatchObject({ styleOnly: true });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].type).toBe('analysis');
  });

  it('ignores non-bullet lines inside acceptance criteria section', async () => {
    const prompt =
      'Build a login form.\n' +
      'Acceptance criteria:\n' +
      'This line is not a bullet and should be ignored\n' +
      '- Email is required\n';

    const { goal, tasks } = await createGoalFromPrompt({ projectId: 1, prompt });

    expect(goal.metadata).toMatchObject({ acceptanceCriteria: ['Email is required'] });
    expect(tasks[0].payload).toMatchObject({ acceptanceCriteria: ['Email is required'] });
  });

  it('can create a child goal linked to a parent goal', async () => {
    const { goal: parent } = await createGoalFromPrompt({
      projectId: 2,
      prompt: 'Secure login system'
    });

    const child = await createChildGoal({
      projectId: parent.projectId,
      parentGoalId: parent.id,
      prompt: 'Implement password reset flow'
    });

    expect(child).toMatchObject({
      projectId: parent.projectId,
      parentGoalId: parent.id,
      prompt: 'Implement password reset flow'
    });
    expect(child.title).toBe('Implement Password Reset Flow');

    const snapshot = await getGoalWithTasks(parent.id);
    expect(snapshot.goal.parentGoalId).toBeNull();
  });

  it('requires a parentGoalId when creating a child goal', async () => {
    await expect(
      createChildGoal({ projectId: 3, prompt: 'Child without parent' })
    ).rejects.toThrow('parentGoalId is required');
  });

  it('rejects child goal creation when parent does not exist', async () => {
    await expect(
      createChildGoal({ projectId: 4, parentGoalId: 9999, prompt: 'Ghost parent' })
    ).rejects.toThrow('Parent goal not found');
  });

  it('enforces matching projectId between parent and child goals', async () => {
    const { goal: parent } = await createGoalFromPrompt({ projectId: 6, prompt: 'Parent goal' });

    await expect(
      createChildGoal({ projectId: 7, parentGoalId: parent.id, prompt: 'Mismatched child' })
    ).rejects.toThrow('Child goal must use same projectId as parent');
  });

  it('rejects child goals when the prompt is not a string', async () => {
    const { goal: parent } = await createGoalFromPrompt({ projectId: 8, prompt: 'Parent goal' });

    await expect(
      createChildGoal({ projectId: parent.projectId, parentGoalId: parent.id, prompt: 123 })
    ).rejects.toThrow('prompt is required');
  });

  it('can create a meta-goal with multiple child goals', async () => {
    const childPrompts = [
      'Design user model and schema',
      'Implement login and logout endpoints',
      'Add UI for login form'
    ];

    const { parent, children } = await createMetaGoalWithChildren({
      projectId: 5,
      prompt: 'Add a secure login system',
      childPrompts
    });

    expect(parent).toMatchObject({
      projectId: 5,
      prompt: 'Add a secure login system',
      parentGoalId: null
    });

    expect(children).toHaveLength(childPrompts.length);
    children.forEach((child, index) => {
      expect(child.projectId).toBe(5);
      expect(child.parentGoalId).toBe(parent.id);
      expect(child.prompt).toBe(childPrompts[index]);
    });

    const goals = await listGoalsForProject(5);
    const parentFromList = goals.find((g) => g.id === parent.id);
    const childIds = new Set(children.map((c) => c.id));
    const childrenFromList = goals.filter((g) => childIds.has(g.id));

    expect(parentFromList.parentGoalId).toBeNull();
    childrenFromList.forEach((g) => {
      expect(g.parentGoalId).toBe(parent.id);
    });
  });

  it('preserves provided parent and child titles when creating meta-goals', async () => {
    const { parent, children } = await createMetaGoalWithChildren({
      projectId: 10,
      prompt: 'Refresh navigation experience',
      parentTitle: 'Refresh Navigation Experience',
      childPrompts: [
        {
          title: 'Audit navigation UX',
          prompt: 'Review the current navigation experience and document pain points.'
        },
        'Refactor navigation component to use CSS variables'
      ]
    });

    expect(parent.title).toBe('Refresh Navigation Experience');
    expect(children[0].title).toBe('Audit navigation UX');
    expect(children[0].prompt).toBe(
      'Review the current navigation experience and document pain points.'
    );
    expect(children[1].title).toBe('Refactor Navigation Component to Use CSS Variables');
  });

  it('creates nested child goals when plan includes children', async () => {
    const { parent, children } = await createMetaGoalWithChildren({
      projectId: 12,
      prompt: 'Nested goal tree',
      childPrompts: [
        {
          title: 'Parent child',
          prompt: 'Ship parent child',
          children: [
            { title: 'Nested leaf', prompt: 'Ship nested leaf' }
          ]
        }
      ]
    });

    expect(parent.projectId).toBe(12);
    expect(children).toHaveLength(1);
    expect(children[0].prompt).toBe('Ship parent child');
    expect(children[0].children).toHaveLength(1);
    expect(children[0].children[0].prompt).toBe('Ship nested leaf');
  });

  it('requires childPrompts to be an array when creating meta goals', async () => {
    await expect(
      createMetaGoalWithChildren({ projectId: 8, prompt: 'Invalid children', childPrompts: 'oops' })
    ).rejects.toThrow('childPrompts must be an array');
  });

  it('rejects meta-goal creation when parentGoalId does not exist', async () => {
    await expect(
      createMetaGoalWithChildren({
        projectId: 60,
        prompt: 'Use missing parent',
        parentGoalId: 999999,
        childPrompts: ['Child 1']
      })
    ).rejects.toThrow('Parent goal not found');
  });

  it('rejects meta-goal creation when parentGoalId projectId mismatches', async () => {
    const { goal: parent } = await createGoalFromPrompt({ projectId: 61, prompt: 'Parent for meta' });

    await expect(
      createMetaGoalWithChildren({
        projectId: 62,
        prompt: 'Wrong projectId',
        parentGoalId: parent.id,
        childPrompts: ['Child 1']
      })
    ).rejects.toThrow('Parent goal must use same projectId');
  });

  it('reuses and orders existing children by createdAt when parentGoalId is provided', async () => {
    const childPrompts = ['First child', 'Second child'];

    const first = await createMetaGoalWithChildren({
      projectId: 63,
      prompt: 'Create meta',
      childPrompts
    });

    // Force parseable, distinct timestamps so the timestamp comparator branch runs.
    await forceGoalCreatedAt(first.children[0].id, '2020-01-03T00:00:00.000Z');
    await forceGoalCreatedAt(first.children[1].id, '2020-01-01T00:00:00.000Z');

    const beforeGoals = await listGoalsForProject(63);

    const second = await createMetaGoalWithChildren({
      projectId: 63,
      prompt: 'Create meta again',
      parentGoalId: first.parent.id,
      childPrompts: ['Should not be created']
    });

    const afterGoals = await listGoalsForProject(63);
    expect(afterGoals.length).toBe(beforeGoals.length);

    // Should short-circuit to the existing children, ordered by createdAt.
    expect(second.parent.id).toBe(first.parent.id);
    expect(second.children.map((c) => c.id).sort()).toEqual(first.children.map((c) => c.id).sort());

    const createdAts = second.children.map((child) => child.createdAt);
    expect(createdAts).toEqual([...createdAts].sort((a, b) => Date.parse(a) - Date.parse(b)));
  });

  it('falls back to ordering existing children by id when createdAt ties or is not parseable', async () => {
    const childPrompts = ['Alpha child', 'Beta child'];

    const first = await createMetaGoalWithChildren({
      projectId: 64,
      prompt: 'Meta with id ordering',
      childPrompts
    });

    // Force a tie on created_at so the comparator hits the id fallback branch.
    await forceGoalCreatedAt(first.children[0].id, '2020-01-01T00:00:00.000Z');
    await forceGoalCreatedAt(first.children[1].id, '2020-01-01T00:00:00.000Z');

    const second = await createMetaGoalWithChildren({
      projectId: 64,
      prompt: 'Meta with id ordering again',
      parentGoalId: first.parent.id,
      childPrompts: ['Should not be created']
    });

    const ids = second.children.map((child) => Number(child.id));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it('falls back to id ordering when existing children have no createdAt values', async () => {
    const childPrompts = ['Null createdAt child A', 'Null createdAt child B'];

    const first = await createMetaGoalWithChildren({
      projectId: 65,
      prompt: 'Meta with null createdAt',
      childPrompts
    });

    // Set created_at to NULL so the ternary `a.createdAt ? ... : NaN` takes the falsy branch.
    await forceGoalCreatedAt(first.children[0].id, null);
    await forceGoalCreatedAt(first.children[1].id, null);

    const second = await createMetaGoalWithChildren({
      projectId: 65,
      prompt: 'Meta again (should reuse)',
      parentGoalId: first.parent.id,
      childPrompts: ['Should not be created']
    });

    const ids = second.children.map((child) => Number(child.id));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it('lists goals for a project via orchestrator facade', async () => {
    await createGoalFromPrompt({ projectId: 7, prompt: 'First' });
    await createGoalFromPrompt({ projectId: 7, prompt: 'Second' });

    const goals = await listGoalsForProject(7);
    expect(goals.length).toBe(2);
    expect(goals[0].projectId).toBe(7);
  });

  it('deletes a goal via orchestrator facade', async () => {
    const { goal } = await createGoalFromPrompt({ projectId: 71, prompt: 'Delete me' });

    const result = await deleteGoalById(goal.id);
    expect(result).toMatchObject({ deleted: true });

    const snapshot = await getGoalWithTasks(goal.id);
    expect(snapshot).toBeNull();
  });

  it('returns a goal with its tasks', async () => {
    const { goal } = await createGoalFromPrompt({ projectId: 3, prompt: 'Inspect' });
    const snapshot = await getGoalWithTasks(goal.id);

    expect(snapshot.goal.id).toBe(goal.id);
    expect(snapshot.tasks.length).toBeGreaterThanOrEqual(1);
  });

  it('returns null from getGoalWithTasks when the goal does not exist', async () => {
    const snapshot = await getGoalWithTasks(99999);
    expect(snapshot).toBeNull();
  });

  it('advanceGoalState rejects unknown lifecycle states', async () => {
    await expect(advanceGoalState(1, 'warp-drive')).rejects.toThrow('Unknown state: warp-drive');
  });

  it('advanceGoalState rejects when the goal does not exist', async () => {
    await expect(advanceGoalState(99999, 'planned')).rejects.toThrow('Goal not found');
  });

  it('advanceGoalState updates lifecycle state and applies metadata updates when metadata is empty', async () => {
    const { goal } = await createGoalFromPrompt({ projectId: 11, prompt: 'Lifecycle state happy path' });

    const updated = await advanceGoalState(goal.id, 'planned', { note: 'planned by test' });
    expect(updated.lifecycleState).toBe('planned');
    expect(updated.metadata).toMatchObject({ note: 'planned by test' });
  });

  it('advanceGoalState merges existing metadata with updates', async () => {
    const { goal } = await createGoalFromPrompt({ projectId: 12, prompt: 'Lifecycle meta merge' });

    await goalStore.updateGoalLifecycleState(goal.id, 'draft', { existing: true });

    const updated = await advanceGoalState(goal.id, 'planned', { added: 123 });
    expect(updated.lifecycleState).toBe('planned');
    expect(updated.metadata).toMatchObject({ existing: true, added: 123 });
  });

  it('advanceGoalState falls back to draft when stored lifecycle state is falsy', async () => {
    const { goal } = await createGoalFromPrompt({ projectId: 13, prompt: 'Lifecycle fallback' });

    const { default: db } = await import('../database.js');
    await new Promise((resolve, reject) => {
      db.run(
        'UPDATE agent_goals SET lifecycle_state = ? WHERE id = ?',
        ['', goal.id],
        (err) => {
          if (err) return reject(err);
          resolve();
        }
      );
    });

    const updated = await advanceGoalState(goal.id, 'planned');
    expect(updated.lifecycleState).toBe('planned');
  });

  it('enforces valid phase transitions and rejects invalid ones', async () => {
    const { goal } = await createGoalFromPrompt({ projectId: 9, prompt: 'TDD flow' });

    const planning = await getGoalWithTasks(goal.id);
    expect(planning.goal.status).toBe('planning');

    const testing = await advanceGoalPhase(goal.id, 'testing', { note: 'Wrote failing tests' });
    expect(testing.status).toBe('testing');
    expect(testing.metadata.note).toBe('Wrote failing tests');

    // Record a failing test run to satisfy TDD enforcement before implementation
    await recordTestRunForGoal(goal.id, {
      status: 'failed',
      summary: 'Tests failing as expected before implementation',
      logs: ['1 failing']
    });

    const implementing = await advanceGoalPhase(goal.id, 'implementing');
    expect(implementing.status).toBe('implementing');

    const verifying = await advanceGoalPhase(goal.id, 'verifying');
    expect(verifying.status).toBe('verifying');

    const ready = await advanceGoalPhase(goal.id, 'ready');
    expect(ready.status).toBe('ready');

    await expect(advanceGoalPhase(goal.id, 'planning')).rejects.toThrow(/Invalid phase transition/i);
  });

  it('defaults to planning phase when a stored goal has no status', async () => {
    const { goal } = await createGoalFromPrompt({ projectId: 25, prompt: 'Legacy migration' });

    await forceGoalStatus(goal.id, '');

    const updated = await advanceGoalPhase(goal.id, 'testing');
    expect(updated.status).toBe('testing');
  });

  it('rejects phase transitions when the stored goal phase is failed', async () => {
    const { goal } = await createGoalFromPrompt({ projectId: 26, prompt: 'Recoverable goal' });

    await forceGoalStatus(goal.id, 'failed');

    await expect(
      advanceGoalPhase(goal.id, 'planning', { note: 'Retry after failure' })
    ).rejects.toThrow(/Invalid phase transition/i);
  });

  it('rejects unknown stored phases via the default transition table', async () => {
    const { goal } = await createGoalFromPrompt({ projectId: 27, prompt: 'Unknown phase test' });
    await forceGoalStatus(goal.id, 'mystery-phase');

    await expect(advanceGoalPhase(goal.id, 'testing')).rejects.toThrow(/Invalid phase transition/i);
  });

  it('advanceGoalPhase rejects unknown phases before fetching the goal', async () => {
    const { goal } = await createGoalFromPrompt({ projectId: 28, prompt: 'Unknown target phase' });

    await expect(advanceGoalPhase(goal.id, 'not-a-phase')).rejects.toThrow('Unknown phase: not-a-phase');
  });

  it('advanceGoalPhase rejects when the goal does not exist', async () => {
    await expect(advanceGoalPhase(999999, 'testing')).rejects.toThrow('Goal not found');
  });

  it('allows moving from testing to implementing without a failing test run requirement', async () => {
    const { goal } = await createGoalFromPrompt({ projectId: 21, prompt: 'No TDD enforcement' });

    // Move from planning -> testing
    const testing = await advanceGoalPhase(goal.id, 'testing');
    expect(testing.status).toBe('testing');

    const implementing = await advanceGoalPhase(goal.id, 'implementing');
    expect(implementing.status).toBe('implementing');
  });

  it('records a test run task for a goal', async () => {
    const { goal } = await createGoalFromPrompt({ projectId: 11, prompt: 'Run tests' });

    const task = await recordTestRunForGoal(goal.id, {
      status: 'failed',
      summary: 'Tests failed as expected',
      logs: ['1 failing, 0 passing']
    });

    expect(task.type).toBe('test-run');
    expect(task.status).toBe('failed');
    expect(task.metadata.summary).toContain('Tests failed as expected');
    expect(task.metadata.logs[0]).toContain('1 failing');

    const snapshot = await getGoalWithTasks(goal.id);
    const testTasks = snapshot.tasks.filter((t) => t.type === 'test-run');
    expect(testTasks.length).toBe(1);
  });

  it('recordTestRunForGoal fills default summary and logs when omitted', async () => {
    const { goal } = await createGoalFromPrompt({ projectId: 12, prompt: 'Defaults coverage' });

    const task = await recordTestRunForGoal(goal.id, { status: 'passed' });

    expect(task.metadata.summary).toBeNull();
    expect(task.metadata.logs).toEqual([]);
  });

  it('recordTestRunForGoal validates required fields', async () => {
    await expect(recordTestRunForGoal()).rejects.toThrow('goalId is required');
    await expect(recordTestRunForGoal(123, {})).rejects.toThrow('status is required');
  });

  it('recordTestRunForGoal rejects when the goal does not exist', async () => {
    await expect(recordTestRunForGoal(999999, { status: 'passed' })).rejects.toThrow('Goal not found');
  });

  it('runTestsForGoal validates required inputs', async () => {
    const { runTestsForGoal } = await import('../services/agentOrchestrator.js');

    await expect(runTestsForGoal()).rejects.toThrow('goalId is required');
    await expect(
      runTestsForGoal(9999, { cwd: process.cwd(), command: 'npm', args: ['test'] })
    ).rejects.toThrow('Goal not found');

    const { goal } = await createGoalFromPrompt({ projectId: 57, prompt: 'Validate args' });

    await expect(runTestsForGoal(goal.id, { command: 'npm' })).rejects.toThrow(
      'cwd and command are required to run tests'
    );
    await expect(runTestsForGoal(goal.id, { cwd: process.cwd() })).rejects.toThrow(
      'cwd and command are required to run tests'
    );
  });

  it('can start a test run job for a goal and record its outcome', async () => {
    const { runTestsForGoal, getGoalWithTasks: getWithTasks } = await import('../services/agentOrchestrator.js');

    const { goal } = await createGoalFromPrompt({ projectId: 15, prompt: 'Run backend tests' });

    const startJobSpy = vi.spyOn(jobRunner, 'startJob').mockReturnValue({
      id: 'job-1',
      projectId: goal.projectId,
      status: jobRunner.JOB_STATUS.RUNNING,
      logs: []
    });

    const waitSpy = vi.spyOn(jobRunner, 'waitForJobCompletion').mockResolvedValue({
      id: 'job-1',
      projectId: goal.projectId,
      status: jobRunner.JOB_STATUS.SUCCEEDED,
      logs: [{ stream: 'stdout', message: 'All tests passed', timestamp: new Date().toISOString() }]
    });

    try {
      const result = await runTestsForGoal(goal.id, {
        cwd: process.cwd(),
        command: 'npm',
        args: ['test']
      });

      expect(startJobSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: goal.projectId,
          type: 'test-run',
          command: 'npm',
          args: ['test']
        })
      );

      expect(waitSpy).toHaveBeenCalledWith('job-1');

      expect(result).toMatchObject({
        goalId: goal.id,
        type: 'test-run'
      });

      const snapshot = await getWithTasks(goal.id);
      const testTasks = snapshot.tasks.filter((t) => t.type === 'test-run');
      expect(testTasks.length).toBe(1);
    } finally {
      startJobSpy.mockRestore();
      waitSpy.mockRestore();
    }
  });

  it('records failure summaries and log output when the job fails', async () => {
    const { runTestsForGoal } = await import('../services/agentOrchestrator.js');
    const { goal } = await createGoalFromPrompt({ projectId: 17, prompt: 'Failing run' });

    const startJobSpy = vi.spyOn(jobRunner, 'startJob').mockReturnValue({
      id: 'job-fail-1',
      projectId: goal.projectId,
      status: jobRunner.JOB_STATUS.RUNNING,
      logs: []
    });

    const waitSpy = vi.spyOn(jobRunner, 'waitForJobCompletion').mockResolvedValue({
      id: 'job-fail-1',
      projectId: goal.projectId,
      status: jobRunner.JOB_STATUS.FAILED,
      logs: [
        { stream: 'stdout', message: 'Running tests' },
        { stream: 'stderr', message: 'Tests failed' }
      ]
    });

    try {
      const result = await runTestsForGoal(goal.id, {
        cwd: process.cwd(),
        command: 'npm',
        args: ['test']
      });

      expect(result.metadata.summary).toBe('Tests failed');
      expect(result.metadata.logs).toEqual([
        'stdout: Running tests',
        'stderr: Tests failed'
      ]);
    } finally {
      startJobSpy.mockRestore();
      waitSpy.mockRestore();
    }
  });

  it('maps job logs even when runner omits log entries', async () => {
    const { runTestsForGoal } = await import('../services/agentOrchestrator.js');
    const { goal } = await createGoalFromPrompt({ projectId: 18, prompt: 'Silent logs' });

    const startJobSpy = vi.spyOn(jobRunner, 'startJob').mockReturnValue({
      id: 'job-3',
      projectId: goal.projectId,
      status: jobRunner.JOB_STATUS.RUNNING,
      logs: []
    });

    const waitSpy = vi.spyOn(jobRunner, 'waitForJobCompletion').mockResolvedValue({
      id: 'job-3',
      projectId: goal.projectId,
      status: jobRunner.JOB_STATUS.SUCCEEDED,
      logs: undefined
    });

    try {
      const task = await runTestsForGoal(goal.id, {
        cwd: process.cwd(),
        command: 'npm',
        args: ['test']
      });

      expect(task.metadata.logs).toEqual([]);
      expect(task.metadata.summary).toBe('Tests passed');
    } finally {
      startJobSpy.mockRestore();
      waitSpy.mockRestore();
    }
  });

  describe('ensureGoalBranch', () => {
    let getGoalSpy;
    let ensureRepoSpy;
    let runGitSpy;

    beforeEach(() => {
      getGoalSpy = vi.spyOn(goalStore, 'getGoal');
      ensureRepoSpy = vi.spyOn(gitUtils, 'ensureGitRepository').mockResolvedValue();
      runGitSpy = vi.spyOn(gitUtils, 'runGitCommand').mockResolvedValue();
    });

    afterEach(() => {
      getGoalSpy.mockRestore();
      ensureRepoSpy.mockRestore();
      runGitSpy.mockRestore();
    });

    it('requires goalId and projectPath', async () => {
      await expect(ensureGoalBranch()).rejects.toThrow('goalId is required');
      await expect(ensureGoalBranch(5)).rejects.toThrow('projectPath is required');
    });

    it('throws when the goal cannot be found', async () => {
      getGoalSpy.mockResolvedValue(null);

      await expect(ensureGoalBranch(6, { projectPath: '/repo' })).rejects.toThrow('Goal not found');
      expect(ensureRepoSpy).not.toHaveBeenCalled();
    });

    it('returns the existing branch when already set', async () => {
      getGoalSpy.mockResolvedValue({ id: 7, projectId: 1, branchName: 'agent/existing' });

      const branch = await ensureGoalBranch(7, { projectPath: '/repo' });

      expect(branch).toBe('agent/existing');
      expect(ensureRepoSpy).not.toHaveBeenCalled();
      expect(runGitSpy).not.toHaveBeenCalled();
    });

    it('ensures the repository and checks out a branch when missing', async () => {
      getGoalSpy
        .mockResolvedValueOnce({ id: 8, projectId: 2, branchName: null })
        .mockResolvedValueOnce({ id: 8, projectId: 2, branchName: 'agent/new-feature' });

      const branch = await ensureGoalBranch(8, { projectPath: '/repo', defaultBranch: 'develop' });

      expect(ensureRepoSpy).toHaveBeenCalledWith('/repo', { defaultBranch: 'develop' });
      expect(runGitSpy).toHaveBeenCalledWith('/repo', ['checkout', '-B', 'agent/new-feature']);
      expect(branch).toBe('agent/new-feature');
    });

    it('throws when branch name remains unavailable after ensuring repository', async () => {
      getGoalSpy
        .mockResolvedValueOnce({ id: 9, projectId: 3, branchName: null })
        .mockResolvedValueOnce({ id: 9, projectId: 3, branchName: null });

      await expect(ensureGoalBranch(9, { projectPath: '/repo' })).rejects.toThrow(
        'Goal branch name unavailable'
      );

      expect(ensureRepoSpy).toHaveBeenCalledWith('/repo', { defaultBranch: 'main' });
      expect(runGitSpy).not.toHaveBeenCalled();
    });
  });

  describe('planGoalFromPrompt validation', () => {
    it('requires a projectId', async () => {
      await expect(planGoalFromPrompt({ prompt: 'Missing project' })).rejects.toThrow(
        'projectId is required'
      );
    });

    it('requires a non-empty prompt string', async () => {
      await expect(planGoalFromPrompt({ projectId: 41 })).rejects.toThrow('prompt is required');
      await expect(planGoalFromPrompt({ projectId: 41, prompt: 123 })).rejects.toThrow('prompt is required');
    });

    it('surfaces invalid JSON from the LLM', async () => {
      llmClient.generateResponse.mockResolvedValue('not json');

      await expect(
        planGoalFromPrompt({ projectId: 42, prompt: 'Plan login flow' })
      ).rejects.toThrow('LLM planning response was not valid JSON');
    });

    it('treats whitespace-only LLM responses as invalid JSON', async () => {
      llmClient.generateResponse.mockResolvedValue('   ');

      await expect(
        planGoalFromPrompt({ projectId: 423, prompt: 'Plan login flow' })
      ).rejects.toThrow('LLM planning response was not valid JSON');
    });

    it('surfaces invalid JSON even when the response contains a JSON-like object substring', async () => {
      llmClient.generateResponse.mockResolvedValue('Prefix {"childPrompts":[oops]} suffix');

      await expect(
        planGoalFromPrompt({ projectId: 422, prompt: 'Plan login flow' })
      ).rejects.toThrow('LLM planning response was not valid JSON');
    });

    it('treats non-string LLM responses as invalid JSON', async () => {
      llmClient.generateResponse.mockResolvedValue({ childPrompts: ['Nope'] });

      await expect(
        planGoalFromPrompt({ projectId: 420, prompt: 'Plan login flow' })
      ).rejects.toThrow('LLM planning response was not valid JSON');
    });

    it('treats null LLM responses as invalid JSON', async () => {
      llmClient.generateResponse.mockResolvedValue(null);

      await expect(
        planGoalFromPrompt({ projectId: 425, prompt: 'Plan login flow' })
      ).rejects.toThrow('LLM planning response was not valid JSON');
    });

    it('requires child goals to be an array', async () => {
      llmClient.generateResponse.mockResolvedValue(JSON.stringify({ childPrompts: 'not-an-array' }));

      await expect(
        planGoalFromPrompt({ projectId: 421, prompt: 'Plan login flow' })
      ).rejects.toThrow('LLM planning response missing childGoals array');
    });

    it('requires a non-empty child goals array', async () => {
      llmClient.generateResponse.mockResolvedValue(JSON.stringify({ childPrompts: [] }));

      await expect(
        planGoalFromPrompt({ projectId: 43, prompt: 'Plan logout flow' })
      ).rejects.toThrow('LLM planning response has empty childGoals array');
    });

    it('honors structured childGoals objects from the planner', async () => {
      llmClient.generateResponse.mockResolvedValue(
        JSON.stringify({
          parentTitle: 'Modernize Authentication',
          childGoals: [
            {
              title: 'Audit authentication UX',
              prompt: 'Review the current auth experience and capture friction points.'
            },
            {
              title: 'Ship new login flow',
              prompt: 'Implement the redesigned login form and connect it to the API.'
            }
          ]
        })
      );

      const result = await planGoalFromPrompt({ projectId: 999, prompt: 'Modernize auth flow' });

      expect(result.parent.title).toBe('Modernize Authentication');
      expect(result.children.map((child) => child.title)).toEqual([
        'Audit authentication UX',
        'Ship new login flow'
      ]);
    });

    it('accepts code-fenced JSON responses from the LLM', async () => {
      llmClient.generateResponse.mockResolvedValue(
        '```json\n' +
          '{"childPrompts":["Implement login","Write docs"]}' +
          '\n```'
      );

      const result = await planGoalFromPrompt({ projectId: 424, prompt: 'Add login page' });
      const prompts = result.children.map((child) => child.prompt);
      expect(prompts).toEqual(['Implement login', 'Write docs']);
    });

    it('parses smart-quote JSON emitted by the LLM', async () => {
      llmClient.generateResponse.mockResolvedValue(`{
  \u201CchildPrompts\u201D: [
    \u201CImplement navigation\u201D,
    \u201CAdd tests\u201D
  ]
}`);

      const result = await planGoalFromPrompt({ projectId: 437, prompt: 'Add NavBar' });
      const prompts = result.children.map((child) => child.prompt);
      expect(prompts).toEqual(['Implement navigation', 'Add tests']);
    });

    it('includes project snapshots in planner prompts when available', async () => {
      const projectRoot = path.resolve(process.cwd(), '..');
      const project = await createProject({
        name: 'Snapshot Project',
        description: 'snapshot test',
        path: projectRoot
      });

      llmClient.generateResponse.mockResolvedValue(
        JSON.stringify({
          childPrompts: ['Implement snapshot-driven plan']
        })
      );

      await planGoalFromPrompt({ projectId: project.id, prompt: 'Plan with snapshot' });

      const messages = llmClient.generateResponse.mock.calls[0][0];
      const systemMessage = messages.find((message) => message.role === 'system');
      expect(systemMessage?.content).toContain('Project snapshot:');
    });

    it('rejects responses that trim to zero usable prompts', async () => {
      llmClient.generateResponse.mockResolvedValue(
        JSON.stringify({ childPrompts: ['   ', 99, ''] })
      );

      await expect(
        planGoalFromPrompt({ projectId: 44, prompt: 'Plan settings page' })
      ).rejects.toThrow('LLM planning produced no usable child prompts');
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

      const result = await planGoalFromPrompt({ projectId: 600, prompt: 'Add profile page' });

      expect(result.questions).toEqual(['Need profile details?']);
      const prompts = result.children.map((child) => child.prompt);
      expect(prompts[0]).toMatch(/^Identify the components/);
      expect(prompts).toHaveLength(3);
    });

    it('logs strict retry failures when low-information plans trigger a retry', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      llmClient.generateResponse
        .mockResolvedValueOnce(
          JSON.stringify({
            childGoals: [{ prompt: 'Implement audit logging' }]
          })
        )
        .mockRejectedValueOnce({ code: 'retry-failed' });

      const result = await planGoalFromPrompt({ projectId: 606, prompt: 'Implement audit logging' });

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

    it('falls back to the raw retry error when no message is provided', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      llmClient.generateResponse
        .mockResolvedValueOnce(
          JSON.stringify({
            childGoals: [{ prompt: 'Add login and signup pages' }]
          })
        )
        .mockRejectedValueOnce(null);

      const result = await planGoalFromPrompt({ projectId: 607, prompt: 'Add login and signup pages' });

      expect(warnSpy).toHaveBeenCalledWith(
        '[WARN] Strict planning retry failed:',
        null
      );
      expect(result.questions).toEqual([]);

      warnSpy.mockRestore();
    });

    it('creates nested goal trees when child goals include subgoals', async () => {
      llmClient.generateResponse.mockResolvedValue(
        JSON.stringify({
          parentTitle: 'Starfield Background',
          childGoals: [
            {
              title: 'Render starfield',
              prompt: 'Add a canvas-backed starfield renderer to the UI.',
              children: [
                { title: 'Canvas setup', prompt: 'Add a canvas element and hook it into layout.' },
                { title: 'Animation loop', prompt: 'Implement the starfield animation loop.' }
              ]
            }
          ]
        })
      );

      const result = await planGoalFromPrompt({ projectId: 501, prompt: 'Implement a 3D starfield animation' });

      expect(result.children).toHaveLength(1);
      expect(result.children[0].prompt).toBe('Add a canvas-backed starfield renderer to the UI.');
      expect(result.children[0].children).toHaveLength(2);

      const child = result.children[0];
      const grandchildIds = child.children.map((node) => node.parentGoalId);
      grandchildIds.forEach((parentId) => {
        expect(parentId).toBe(child.id);
      });
    });

    it('returns clarifying questions when the planner requests them', async () => {
      llmClient.generateResponse.mockResolvedValue(
        JSON.stringify({
          parentTitle: 'Add dashboards',
          questions: ['Which dashboard layout should we use?'],
          childGoals: [
            { title: 'Sketch layout', prompt: 'Create a dashboard layout draft.' }
          ]
        })
      );

      const result = await planGoalFromPrompt({ projectId: 502, prompt: 'Add dashboards' });

      expect(result.questions).toEqual(['Which dashboard layout should we use?']);
      const snapshot = await getGoalWithTasks(result.parent.id);
      expect(snapshot.goal.metadata.clarifyingQuestions).toEqual(['Which dashboard layout should we use?']);
      expect(snapshot.tasks[0].type).toBe('clarification');
    });

    it('requests clarifying questions when NODE_ENV is not test', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      llmClient.generateResponse
        .mockResolvedValueOnce(
          JSON.stringify({
            childPrompts: ['Implement profile page', 'Add tests']
          })
        )
        .mockResolvedValueOnce(
          JSON.stringify({
            needsClarification: true,
            questions: ['Which layout should we use?']
          })
        );

      try {
        const result = await planGoalFromPrompt({ projectId: 503, prompt: 'Add profile page' });

        expect(llmClient.generateResponse).toHaveBeenCalledTimes(2);
        expect(result.questions).toEqual(['Which layout should we use?']);
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    it('falls back to empty clarifications when clarification JSON is invalid', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      llmClient.generateResponse
        .mockResolvedValueOnce(
          JSON.stringify({
            childPrompts: ['Implement profile page']
          })
        )
        .mockResolvedValueOnce('not json');

      try {
        const result = await planGoalFromPrompt({ projectId: 504, prompt: 'Add profile page' });

        expect(result.questions).toEqual([]);
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    it('swallows clarification generation failures when NODE_ENV is not test', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      llmClient.generateResponse
        .mockResolvedValueOnce(
          JSON.stringify({
            childPrompts: ['Implement billing page']
          })
        )
        .mockRejectedValueOnce(new Error('llm unavailable'));

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const result = await planGoalFromPrompt({ projectId: 504, prompt: 'Add billing page' });

        expect(result.questions).toEqual([]);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Clarification question generation failed:'),
          expect.any(String)
        );
      } finally {
        warnSpy.mockRestore();
        process.env.NODE_ENV = originalEnv;
      }
    });

    it('logs clarification failures when errors lack a message', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      llmClient.generateResponse
        .mockResolvedValueOnce(
          JSON.stringify({
            childPrompts: ['Implement account settings']
          })
        )
        .mockRejectedValueOnce(null);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const result = await planGoalFromPrompt({ projectId: 505, prompt: 'Add account settings' });

        expect(result.questions).toEqual([]);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Clarification question generation failed:'),
          null
        );
      } finally {
        warnSpy.mockRestore();
        process.env.NODE_ENV = originalEnv;
      }
    });
  });

  describe('normalizeJsonLikeText helper', () => {
    it('returns non-string inputs unchanged', () => {
      const { normalizeJsonLikeText } = __testExports__;
      const sentinel = { ok: true };

      expect(normalizeJsonLikeText(null)).toBeNull();
      expect(normalizeJsonLikeText(sentinel)).toBe(sentinel);
      expect(normalizeJsonLikeText(42)).toBe(42);
    });
  });

  describe('internal helper edge cases', () => {
    it('builds metadata with non-string prompts and normalizes clarifications', () => {
      const { buildGoalMetadataFromPrompt } = __testExports__;

      const result = buildGoalMetadataFromPrompt({
        prompt: null,
        extraClarifyingQuestions: ['  Needs detail ', '', 'Needs detail']
      });

      expect(result).toMatchObject({
        metadata: {
          clarifyingQuestions: ['Needs detail']
        },
        clarifyingQuestions: ['Needs detail'],
        styleOnly: false
      });
    });

    it('normalizes clarifying questions when the input is not an array', () => {
      const { normalizeClarifyingQuestions } = __testExports__;

      expect(normalizeClarifyingQuestions('not-an-array')).toEqual([]);
    });

    it('filters non-string clarification items', () => {
      const { normalizeClarifyingQuestions } = __testExports__;

      expect(normalizeClarifyingQuestions(['  Keep me  ', 123, null])).toEqual(['Keep me']);
    });

    it('returns false for empty verification prompts', () => {
      const { isProgrammaticVerificationStep } = __testExports__;

      expect(isProgrammaticVerificationStep('')).toBe(false);
    });

    it('derives fallback titles when the prompt is not a string', () => {
      const { deriveGoalTitle } = __testExports__;

      expect(deriveGoalTitle(null, { fallback: 'Goal' })).toBe('Goal');
    });

    it('stops acceptance criteria at the next section header', () => {
      const { extractAcceptanceCriteria } = __testExports__;

      const criteria = extractAcceptanceCriteria(
        'Acceptance criteria:\n- First item\nNotes:\n- Should be ignored'
      );

      expect(criteria).toEqual(['First item']);
    });

    it('uses unknown stack labels when framework details are missing', async () => {
      const { resolveProjectStackContext } = __testExports__;

      const project = await createProject({
        name: 'Unknown stack',
        description: 'Missing stack metadata',
        framework: '',
        language: '',
        path: ''
      });

      const summary = await resolveProjectStackContext(project.id);

      expect(summary).toContain('frontend: unknown (unknown)');
      expect(summary).toContain('backend: unknown (unknown)');
    });

    it('detects python frameworks from requirements text', () => {
      const { detectPythonFramework } = __testExports__;

      expect(detectPythonFramework('flask\n')).toBe('flask');
      expect(detectPythonFramework('quart\n')).toBe('quart');
    });

    it('detects additional frontend and backend frameworks', () => {
      const { detectFrontendFramework, detectBackendFramework } = __testExports__;

      expect(detectFrontendFramework({ dependencies: { react: '^18.0.0' } })).toBe('react');
      expect(detectFrontendFramework({ dependencies: { next: '^14.0.0' } })).toBe('nextjs');
      expect(detectFrontendFramework({ dependencies: { vue: '^3.0.0' } })).toBe('vue');
      expect(detectFrontendFramework({ dependencies: { nuxt: '^3.0.0' } })).toBe('nuxt');
      expect(detectFrontendFramework({ dependencies: { '@angular/core': '^16.0.0' } })).toBe('angular');
      expect(detectFrontendFramework({ dependencies: { svelte: '^4.0.0' } })).toBe('svelte');
      expect(detectFrontendFramework({ dependencies: { 'solid-js': '^1.0.0' } })).toBe('solid');
      expect(detectFrontendFramework({ dependencies: { gatsby: '^5.0.0' } })).toBe('gatsby');
      expect(detectFrontendFramework({ dependencies: { astro: '^1.0.0' } })).toBe('astro');
      expect(detectBackendFramework({ dependencies: { fastify: '^4.0.0' } })).toBe('fastify');
      expect(detectBackendFramework({ dependencies: { '@nestjs/core': '^10.0.0' } })).toBe('nestjs');
      expect(detectBackendFramework({ dependencies: { '@hapi/hapi': '^21.0.0' } })).toBe('hapi');
      expect(detectBackendFramework({ dependencies: { '@adonisjs/core': '^6.0.0' } })).toBe('adonisjs');
    });

    it('uses preconfigured backend framework values when present', async () => {
      const { resolveProjectStackContext } = __testExports__;
      const baseDir = process.env.PROJECTS_DIR || process.cwd();
      fs.mkdirSync(baseDir, { recursive: true });
      const tempDir = fs.mkdtempSync(path.join(baseDir, 'stack-'));

      try {
        const project = await createProject({
          name: 'Backend preset',
          description: 'Preset backend stack',
          framework: 'react',
          language: 'javascript',
          path: tempDir
        });

        const { default: db } = await import('../database.js');
        await new Promise((resolve, reject) => {
          db.run(
            'UPDATE projects SET backend_framework = ?, backend_language = ? WHERE id = ?',
            ['express', 'javascript', project.id],
            (err) => (err ? reject(err) : resolve())
          );
        });

        const summary = await resolveProjectStackContext(project.id);

        expect(summary).toContain('backend: express (javascript)');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('normalizes non-string framework values in stack summaries', async () => {
      const { resolveProjectStackContext } = __testExports__;
      const dbModule = await import('../database.js');
      const getProjectSpy = vi.spyOn(dbModule, 'getProject').mockResolvedValue({
        id: 999,
        name: 'Numeric stack',
        description: 'Non-string framework values',
        framework: 123,
        language: 456,
        path: ''
      });

      try {
        const summary = await resolveProjectStackContext(999);

        expect(summary).toContain('frontend: unknown (unknown)');
      } finally {
        getProjectSpy.mockRestore();
      }
    });

    it('returns null stack context when loading the project fails', async () => {
      const { resolveProjectStackContext } = __testExports__;
      const dbModule = await import('../database.js');
      const getProjectSpy = vi.spyOn(dbModule, 'getProject').mockRejectedValueOnce(new Error('db down'));

      try {
        const summary = await resolveProjectStackContext(12345);

        expect(summary).toBeNull();
      } finally {
        getProjectSpy.mockRestore();
      }
    });

    it('returns an empty snapshot when the project has no readable files', async () => {
      const { buildPlannerProjectSnapshot } = __testExports__;
      const baseDir = process.env.PROJECTS_DIR || process.cwd();
      fs.mkdirSync(baseDir, { recursive: true });
      const tempDir = fs.mkdtempSync(path.join(baseDir, 'snapshot-'));

      try {
        const project = await createProject({
          name: 'Snapshot empty',
          description: 'Empty project',
          framework: '',
          language: '',
          path: tempDir
        });

        const snapshot = await buildPlannerProjectSnapshot(project.id);

        expect(snapshot).toBe('');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('returns an empty snapshot when project lookup fails', async () => {
      const { buildPlannerProjectSnapshot } = __testExports__;
      const dbModule = await import('../database.js');
      const getProjectSpy = vi.spyOn(dbModule, 'getProject').mockRejectedValueOnce(new Error('db down'));

      try {
        const snapshot = await buildPlannerProjectSnapshot(12345);

        expect(snapshot).toBe('');
      } finally {
        getProjectSpy.mockRestore();
      }
    });

    it('detects low-information plan inputs for empty and compound prompts', () => {
      const { isLowInformationPlan, isCompoundPrompt } = __testExports__;

      expect(isLowInformationPlan('Add logging', null)).toBe(true);
      expect(isLowInformationPlan('Add login and signup pages', [{ prompt: 'Implement settings page' }])).toBe(true);
      expect(isCompoundPrompt('')).toBe(false);
      expect(isCompoundPrompt(42)).toBe(false);
    });

    it('covers low-information plan fallbacks for missing child prompt fields', () => {
      const { isLowInformationPlan } = __testExports__;
      const compoundPrompt = 'Add login and signup pages';

      expect(isLowInformationPlan(compoundPrompt, [null])).toBe(true);
      expect(isLowInformationPlan(compoundPrompt, [{ title: 'Login steps' }])).toBe(true);
      expect(isLowInformationPlan(compoundPrompt, [{}])).toBe(true);
    });

    it('sorts goal trees when ids are missing', () => {
      const { buildGoalTreeFromList } = __testExports__;

      const result = buildGoalTreeFromList([
        { id: 5, projectId: 1, parentGoalId: null, title: 'Second', prompt: 'Second' },
        { id: null, projectId: 1, parentGoalId: null, title: 'First', prompt: 'First' }
      ]);

      expect(result).toHaveLength(2);
    });

    it('normalizes planner prompts with non-string values', () => {
      const { normalizePlannerPrompt } = __testExports__;

      expect(normalizePlannerPrompt(123)).toBe('');
      expect(normalizePlannerPrompt('  Trim me  ')).toBe('Trim me');
    });

    it('normalizes child plan strings and skips empty entries', () => {
      const { normalizeChildPlans } = __testExports__;

      const plans = normalizeChildPlans(['  Write docs  ', '', 'Ship it']);
      expect(plans.map((plan) => plan.prompt)).toEqual(['Write docs', 'Ship it']);
    });

    it('preserves provided child plan titles when objects are supplied', () => {
      const { normalizeChildPlans } = __testExports__;

      const plans = normalizeChildPlans([
        { title: 'Custom title', prompt: 'Implement flow' }
      ]);

      expect(plans).toEqual([
        { title: 'Custom title', prompt: 'Implement flow' }
      ]);
    });

    it('derives titles for object entries without valid titles and skips non-string prompts', () => {
      const { normalizeChildPlans, deriveGoalTitle } = __testExports__;

      const plans = normalizeChildPlans([
        { prompt: 'Draft spec', title: '   ' },
        { prompt: 'Outline API', title: 123 },
        { prompt: 123, title: 'Ignored' },
        '  Ship it  ',
        42
      ]);

      expect(plans).toEqual([
        {
          prompt: 'Draft spec',
          title: deriveGoalTitle('Draft spec', { fallback: 'Child Goal 1' })
        },
        {
          prompt: 'Outline API',
          title: deriveGoalTitle('Outline API', { fallback: 'Child Goal 2' })
        },
        {
          prompt: 'Ship it',
          title: deriveGoalTitle('Ship it', { fallback: 'Child Goal 4' })
        }
      ]);
    });
  });

  describe('goal plan tree helpers', () => {
    it('normalizes nested plans, childGoals, duplicates, and verification steps', () => {
      const { normalizeGoalPlanTree } = __testExports__;

      const plans = [
        {
          prompt: 'Run tests',
          children: [{ prompt: 'Implement feature' }]
        },
        {
          childGoals: [{ prompt: 'Child via childGoals' }]
        },
        {
          prompt: 'Set up API',
          children: [{ prompt: 'Child A' }]
        },
        {
          prompt: 'Set up API',
          children: [{ prompt: 'Child B' }]
        }
      ];

      const result = normalizeGoalPlanTree(plans);
      const prompts = result.map((node) => node.prompt);

      expect(prompts).toEqual([
        'Implement feature',
        'Child via childGoals',
        'Set up API',
        'Child B'
      ]);

      const apiNode = result.find((node) => node.prompt === 'Set up API');
      expect(apiNode.children.map((node) => node.prompt)).toEqual(['Child A']);
    });

    it('builds a nested goal tree from a flat list and includes orphans at root', () => {
      const { buildGoalTreeFromList } = __testExports__;

      const tree = buildGoalTreeFromList([
        { id: 3, parentGoalId: 2, createdAt: '2026-01-02T00:00:00.000Z' },
        { id: 1, parentGoalId: null, createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 2, parentGoalId: 1, createdAt: '2026-01-01T01:00:00.000Z' },
        { id: 4, parentGoalId: 999, createdAt: '2026-01-03T00:00:00.000Z' }
      ]);

      expect(tree.map((node) => node.id)).toEqual([1, 4]);
      expect(tree[0].children.map((node) => node.id)).toEqual([2]);
      expect(tree[0].children[0].children.map((node) => node.id)).toEqual([3]);
    });

    it('returns a subtree when a parentId is provided and sorts by id fallback', () => {
      const { buildGoalTreeFromList } = __testExports__;

      const tree = buildGoalTreeFromList(
        [
          { id: 9, parentGoalId: 1 },
          { id: 7, parentGoalId: 1 },
          { id: 1, parentGoalId: null }
        ],
        1
      );

      expect(tree.map((node) => node.id)).toEqual([7, 9]);
    });

    it('returns an empty subtree when the parentId is missing', () => {
      const { buildGoalTreeFromList } = __testExports__;

      const tree = buildGoalTreeFromList([
        { id: 1, parentGoalId: null },
        { id: 2, parentGoalId: 1 }
      ], 9999);

      expect(tree).toEqual([]);
    });

    it('sorts roots by id when createdAt is not parseable', () => {
      const { buildGoalTreeFromList } = __testExports__;

      const tree = buildGoalTreeFromList([
        { id: 4, parentGoalId: null, createdAt: 'invalid' },
        { id: 2, parentGoalId: null, createdAt: 'invalid' }
      ]);

      expect(tree.map((node) => node.id)).toEqual([2, 4]);
    });

    it('falls back to zero when goal ids are missing in sort order', () => {
      const { buildGoalTreeFromList } = __testExports__;

      const tree = buildGoalTreeFromList([
        { id: null, parentGoalId: null, createdAt: 'invalid' },
        { id: 3, parentGoalId: null, createdAt: 'invalid' }
      ]);

      expect(tree.map((node) => node.id)).toEqual([null, 3]);
    });

    it('honors maxNodes when normalizing plans', () => {
      const { normalizeGoalPlanTree } = __testExports__;

      const result = normalizeGoalPlanTree(['First', 'Second'], { maxNodes: 0 });
      expect(result).toEqual([]);
    });
  });

  it('recovers the first JSON object when the LLM wraps it in prose', async () => {
    llmClient.generateResponse.mockResolvedValue(
      'Here is the plan:\n' +
        '{"childPrompts":["Implement \\\"quoted\\\" feature","Handle braces {like this}","Write docs"]}\n' +
        'Thanks!'
    );

    const result = await planGoalFromPrompt({
      projectId: 123,
      prompt: 'Add a new feature'
    });

    const prompts = result.children.map((child) => child.prompt);
    expect(prompts).toEqual([
      'Implement "quoted" feature',
      'Handle braces {like this}',
      'Write docs'
    ]);
  });

  it('recovers JSON with nested objects from prose (depth tracking)', async () => {
    llmClient.generateResponse.mockResolvedValue(
      'Some preface...\n' +
        '{"childPrompts":["Top level"],"meta":{"note":"Nested"}}\n' +
        '...and some trailing text'
    );

    const result = await planGoalFromPrompt({ projectId: 126, prompt: 'Add nested parsing' });
    const prompts = result.children.map((child) => child.prompt);
    expect(prompts).toEqual(['Top level']);
  });

  it('can plan a meta-goal from a prompt using the LLM', async () => {
    llmClient.generateResponse.mockResolvedValue(
      JSON.stringify({
        childPrompts: [
          'Analyse current authentication module',
          'Design new login flow',
          'Implement password reset endpoints'
        ]
      })
    );

    const { parent, children } = await planGoalFromPrompt({
      projectId: 31,
      prompt: 'Add a secure login system'
    });

    expect(llmClient.generateResponse).toHaveBeenCalled();
    expect(parent).toMatchObject({
      projectId: 31,
      prompt: 'Add a secure login system',
      parentGoalId: null
    });
    expect(children.length).toBe(3);
    children.forEach((child) => {
      expect(child.projectId).toBe(31);
      expect(child.parentGoalId).toBe(parent.id);
    });

    const prompts = children.map((c) => c.prompt);
    expect(prompts).toEqual([
      'Analyse current authentication module',
      'Design new login flow',
      'Implement password reset endpoints'
    ]);
  });

  it('plans CSS/style-only prompts without LLM or verification steps', async () => {
    llmClient.generateResponse.mockClear();

    const { parent, children } = await planGoalFromPrompt({
      projectId: 77,
      prompt: 'Turn the background blue (CSS only)'
    });

    expect(llmClient.generateResponse).not.toHaveBeenCalled();
    expect(parent).toMatchObject({ projectId: 77, prompt: 'Turn the background blue (CSS only)' });

    const prompts = children.map((c) => c.prompt);
    expect(prompts).toEqual([
      'Create a branch for this change if needed.',
      'Change the background color to blue (CSS-only change; no tests required).',
      'Stage the updated file(s).'
    ]);
  });

  it('propagates the requested color when planning style-only prompts', async () => {
    llmClient.generateResponse.mockClear();

    const { children } = await planGoalFromPrompt({
      projectId: 78,
      prompt: 'Please switch the background to bright green for the hero section'
    });

    const prompts = children.map((c) => c.prompt);
    expect(prompts[1]).toBe('Change the background color to bright green (CSS-only change; no tests required).');
  });

  it('reuses an existing parent goal when goalId is provided (no duplicate goals)', async () => {
    const { goal: parent } = await createGoalFromPrompt({
      projectId: 55,
      prompt: 'Add search'
    });

    llmClient.generateResponse.mockResolvedValueOnce(
      JSON.stringify({
        childPrompts: ['Implement search endpoint']
      })
    );

    const first = await planGoalFromPrompt({
      projectId: 55,
      prompt: 'Add search',
      goalId: parent.id
    });

    expect(first.parent.id).toBe(parent.id);
    expect(first.children.length).toBeGreaterThan(0);

    const goalsAfterFirst = await listGoalsForProject(55);
    expect(goalsAfterFirst.filter((g) => g.parentGoalId == null).length).toBe(1);

    llmClient.generateResponse.mockClear();
    const second = await planGoalFromPrompt({
      projectId: 55,
      prompt: 'Add search',
      goalId: parent.id
    });

    // Second call short-circuits to existing children.
    expect(llmClient.generateResponse).not.toHaveBeenCalled();
    expect(second.parent.id).toBe(parent.id);
    expect(second.children.map((c) => c.id)).toEqual(first.children.map((c) => c.id));

    const goalsAfterSecond = await listGoalsForProject(55);
    expect(goalsAfterSecond.length).toBe(goalsAfterFirst.length);
  });

  it('throws when goalId parent does not exist', async () => {
    await expect(
      planGoalFromPrompt({ projectId: 56, prompt: 'Plan with missing parent', goalId: 999999 })
    ).rejects.toThrow('Parent goal not found');
  });

  it('throws when goalId parent has mismatched projectId', async () => {
    const { goal: parent } = await createGoalFromPrompt({ projectId: 57, prompt: 'Parent for mismatch' });

    await expect(
      planGoalFromPrompt({ projectId: 58, prompt: 'Plan with mismatched project', goalId: parent.id })
    ).rejects.toThrow('Parent goal must use same projectId');
  });

  it('orders existing child goals by createdAt timestamps when goalId is provided', async () => {
    const { goal: parent } = await createGoalFromPrompt({ projectId: 59, prompt: 'Timestamp ordering' });

    llmClient.generateResponse.mockResolvedValueOnce(
      JSON.stringify({
        childPrompts: ['Implement alpha', 'Implement beta']
      })
    );

    const first = await planGoalFromPrompt({
      projectId: 59,
      prompt: 'Timestamp ordering',
      goalId: parent.id
    });

    // Ensure created_at values are parseable and distinct so the timestamp comparator path runs.
    const timestamps = [
      '2020-01-01T00:00:00.000Z',
      '2020-01-02T00:00:00.000Z',
      '2020-01-03T00:00:00.000Z',
      '2020-01-04T00:00:00.000Z'
    ];
    for (let index = 0; index < first.children.length; index += 1) {
      await forceGoalCreatedAt(first.children[index].id, timestamps[index % timestamps.length]);
    }

    // Second call should short-circuit to existing children and sort by createdAt ascending.
    llmClient.generateResponse.mockClear();
    const second = await planGoalFromPrompt({
      projectId: 59,
      prompt: 'Timestamp ordering',
      goalId: parent.id
    });

    expect(llmClient.generateResponse).not.toHaveBeenCalled();

    const createdAts = second.children.map((child) => child.createdAt);
    expect(createdAts).toEqual([...createdAts].sort((a, b) => Date.parse(a) - Date.parse(b)));
  });

  it('falls back to id ordering when existing children have null createdAt values (goalId path)', async () => {
    const { goal: parent } = await createGoalFromPrompt({ projectId: 66, prompt: 'Null createdAt ordering' });

    const child1 = await createChildGoal({
      projectId: 66,
      parentGoalId: parent.id,
      prompt: 'Child one'
    });

    const child2 = await createChildGoal({
      projectId: 66,
      parentGoalId: parent.id,
      prompt: 'Child two'
    });

    await forceGoalCreatedAt(child1.id, null);
    await forceGoalCreatedAt(child2.id, null);

    llmClient.generateResponse.mockClear();
    const result = await planGoalFromPrompt({
      projectId: 66,
      prompt: 'Should short-circuit to existing children',
      goalId: parent.id
    });

    expect(llmClient.generateResponse).not.toHaveBeenCalled();

    const ids = result.children.map((child) => Number(child.id));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it('preserves LLM prompt ordering without injecting tests-first or verification steps', async () => {
    llmClient.generateResponse.mockResolvedValue(
      JSON.stringify({
        childPrompts: [
          'Implement payment endpoint.',
          'Write tests for payment endpoint',
          'Document the API usage',
          'Analyse existing payments module',
          123,
          '   '
        ]
      })
    );

    const { children } = await planGoalFromPrompt({
      projectId: 32,
      prompt: 'Add payments'
    });

    const prompts = children.map((c) => c.prompt);
    expect(prompts).toEqual([
      'Implement payment endpoint.',
      'Write tests for payment endpoint',
      'Document the API usage',
      'Analyse existing payments module'
    ]);
  });

  it('filters out programmatic verification steps (run tests/coverage) from the LLM plan', async () => {
    llmClient.generateResponse.mockResolvedValue(
      JSON.stringify({
        childPrompts: [
          'Analyse existing auth module',
          'Write tests for password reset',
          'Implement password reset endpoints',
          'Run unit tests and fix any failures.',
          'npm run test -- src/services/auth.test.js',
          'Run integration tests and fix any failures.',
          'Run coverage and ensure thresholds are met.',
          'Document the API usage',
          'Document the API usage'
        ]
      })
    );

    const { children } = await planGoalFromPrompt({
      projectId: 33,
      prompt: 'Add password reset'
    });

    const prompts = children.map((c) => c.prompt);
    expect(prompts).toEqual([
      'Analyse existing auth module',
      'Write tests for password reset',
      'Implement password reset endpoints',
      'Document the API usage'
    ]);
  });
});
