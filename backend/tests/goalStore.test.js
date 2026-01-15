import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import db, { initializeDatabase } from '../database.js';
import {
  createGoal,
  getGoal,
  listGoals,
  updateGoalStatus,
  updateGoalLifecycleState,
  createGoalTask,
  getGoalTask,
  listGoalTasks,
  updateGoalTaskStatus,
  deleteGoal,
  __testing as goalStoreTesting
} from '../services/goalStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbEnvPath = process.env.DATABASE_PATH || 'test-lucidcoder.db';
const dbPath = path.isAbsolute(dbEnvPath)
  ? dbEnvPath
  : path.join(__dirname, '..', dbEnvPath);

const resetTables = () => {
  const client = new sqlite3.Database(dbPath);
  const tables = ['agent_tasks', 'agent_goals'];
  return new Promise((resolve, reject) => {
    client.serialize(() => {
      tables.reduce((promise, table) => (
        promise.then(() => new Promise((innerResolve, innerReject) => {
          client.run(`DELETE FROM ${table}`, (err) => {
            if (err && !/no such table/i.test(err.message)) {
              innerReject(err);
              return;
            }
            innerResolve();
          });
        }))
      ), Promise.resolve())
        .then(() => {
          client.close(() => resolve());
        })
        .catch((error) => {
          client.close(() => reject(error));
        });
    });
  });
};

const runRaw = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, (err) => {
    if (err) {
      reject(err);
      return;
    }
    resolve();
  });
});

describe('goalStore', () => {
  beforeEach(async () => {
    await initializeDatabase();
    await resetTables();
  });

  afterEach(async () => {
    await resetTables();
  });

  test('creates and retrieves goal records with default metadata', async () => {
    const goal = await createGoal({
      projectId: 42,
      prompt: 'Implement todo system'
    });

    expect(goal).toMatchObject({
      projectId: 42,
      prompt: 'Implement todo system',
      status: 'planning',
      branchName: expect.stringContaining('agent/')
    });

    const stored = await getGoal(goal.id);
    expect(stored).toMatchObject({
      id: goal.id,
      projectId: 42,
      prompt: 'Implement todo system',
      status: 'planning'
    });
    expect(new Date(stored.createdAt)).toBeInstanceOf(Date);
  });

  test('buildBranchName handles empty prompts', () => {
    const branch = goalStoreTesting.buildBranchName('');
    expect(branch).toMatch(/^agent\//);
    expect(branch).toMatch(/-([a-f0-9]+)$/i);
  });

  test('lists goals for a project ordered by recency', async () => {
    const first = await createGoal({ projectId: 7, prompt: 'First goal' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await createGoal({ projectId: 7, prompt: 'Second goal' });

    const goals = await listGoals(7);
    expect(goals).toHaveLength(2);
    expect(goals[0].id).toBe(second.id);
    expect(goals[1].id).toBe(first.id);
  });

  test('listGoals can exclude archived/completed goals', async () => {
    const active = await createGoal({ projectId: 31, prompt: 'Active goal' });
    const completed = await createGoal({ projectId: 31, prompt: 'Completed goal' });
    const merged = await createGoal({ projectId: 31, prompt: 'Merged goal' });

    await updateGoalStatus(completed.id, 'ready');
    await updateGoalLifecycleState(merged.id, 'merged');

    const allGoals = await listGoals(31);
    expect(allGoals.map((g) => g.id)).toEqual(expect.arrayContaining([active.id, completed.id, merged.id]));

    const activeOnly = await listGoals(31, { includeArchived: false });
    expect(activeOnly.map((g) => g.id)).toEqual([active.id]);
  });

  test('builds branch names with sanitized fallback when prompt has no tokens', async () => {
    const goal = await createGoal({ projectId: 8, prompt: '!!! /// ???' });
    expect(goal.branchName).toMatch(/^agent\/goal-[a-f0-9]+/);
  });

  test('builds concise branch names by stripping filler words', async () => {
    const goal = await createGoal({ projectId: 8, prompt: "let's have a navigation bar at the top" });
    expect(goal.branchName).toMatch(/^agent\/navigation-bar-top-[a-f0-9]+/);
  });

  test('stores null metadata when createGoal receives non-object metadata', async () => {
    const goal = await createGoal({ projectId: 9, prompt: 'Non-object metadata', metadata: 'nope' });
    expect(goal.metadata).toBe(null);
  });

  test('stores object metadata when createGoal receives a metadata object', async () => {
    const goal = await createGoal({ projectId: 10, prompt: 'Object metadata', metadata: { tag: 'x', count: 1 } });
    expect(goal.metadata).toEqual({ tag: 'x', count: 1 });
  });

  test('updates goal status and metadata', async () => {
    const goal = await createGoal({ projectId: 3, prompt: 'Add auth' });
    const updated = await updateGoalStatus(goal.id, 'implementing', {
      activePhase: 'write-tests',
      notes: 'Generated initial test plan'
    });

    expect(updated.status).toBe('implementing');
    expect(updated.metadata).toEqual({
      activePhase: 'write-tests',
      notes: 'Generated initial test plan'
    });
  });

  test('updates goal lifecycle state with default null metadata', async () => {
    const goal = await createGoal({ projectId: 16, prompt: 'Lifecycle update' });
    const updated = await updateGoalLifecycleState(goal.id, 'planned');

    expect(updated.lifecycleState).toBe('planned');
    expect(updated.metadata).toBeNull();
  });

  test('updates goal lifecycle state with metadata', async () => {
    const goal = await createGoal({ projectId: 17, prompt: 'Lifecycle meta update' });
    const updated = await updateGoalLifecycleState(goal.id, 'executing', { phase: 'run-tests' });

    expect(updated.lifecycleState).toBe('executing');
    expect(updated.metadata).toEqual({ phase: 'run-tests' });
  });

  test('handles null metadata paths for goals and tasks', async () => {
    const goal = await createGoal({ projectId: 14, prompt: 'Null meta coverage' });
    const task = await createGoalTask(goal.id, { type: 'analysis', title: 'Null meta task' });

    const goalWithoutMeta = await updateGoalStatus(goal.id, 'review');
    expect(goalWithoutMeta.metadata).toBeNull();

    const taskWithoutMeta = await updateGoalTaskStatus(task.id, 'in-progress');
    expect(taskWithoutMeta.metadata).toBeNull();

    await runRaw('UPDATE agent_goals SET metadata = NULL WHERE id = ?', [goal.id]);
    const sanitized = await getGoal(goal.id);
    expect(sanitized.metadata).toBeNull();
  });

  test('creates tasks tied to a goal and returns them chronologically', async () => {
    const goal = await createGoal({ projectId: 5, prompt: 'Add search feature' });
    const taskA = await createGoalTask(goal.id, {
      type: 'analysis',
      title: 'Generate plan',
      payload: { section: 'overview' }
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const taskB = await createGoalTask(goal.id, {
      type: 'test',
      title: 'Create failing tests',
      payload: { files: ['tests/todo.test.js'] }
    });

    expect(taskA.status).toBe('pending');

    const tasks = await listGoalTasks(goal.id);
    expect(tasks.map((task) => task.id)).toEqual([taskA.id, taskB.id]);
  });

  test('updates task status with results', async () => {
    const goal = await createGoal({ projectId: 9, prompt: 'Refactor preview panel' });
    const task = await createGoalTask(goal.id, {
      type: 'test',
      title: 'Ensure failing test exists'
    });

    const updated = await updateGoalTaskStatus(task.id, 'failed', {
      logs: ['Test run failed as expected'],
      error: null
    });

    expect(updated.status).toBe('failed');
    expect(updated.metadata.logs).toContain('Test run failed as expected');
  });

  test('propagates database errors when goal creation fails', async () => {
    const forcedError = new Error('forced goal failure');
    const runSpy = vi.spyOn(db, 'run').mockImplementation((sql, params, callback) => {
      callback(forcedError);
      return null;
    });

    await expect(
      createGoal({ projectId: 13, prompt: 'should bubble error' })
    ).rejects.toThrow(/forced goal failure/i);

    runSpy.mockRestore();
  });

  test('returns null when loading a missing goal', async () => {
    await expect(getGoal(99999)).resolves.toBeNull();
  });

  test('returns null when loading a missing task', async () => {
    await expect(getGoalTask(99999)).resolves.toBeNull();
  });

  test('validates goal and task inputs', async () => {
    await expect(createGoal({ prompt: 'Missing project' })).rejects.toThrow(/projectId is required/i);
    await expect(createGoal({ projectId: 11 })).rejects.toThrow(/prompt is required/i);

    await expect(listGoals()).rejects.toThrow(/projectId is required/i);

    const goal = await createGoal({ projectId: 12, prompt: 'Validation goal' });

    await expect(createGoalTask(goal.id, { title: 'No type' })).rejects.toThrow(/type is required/i);
    await expect(createGoalTask(goal.id, { type: 'analysis' })).rejects.toThrow(/title is required/i);

    await expect(updateGoalStatus(goal.id, '')).rejects.toThrow(/status is required/i);

    await expect(updateGoalLifecycleState(goal.id, '')).rejects.toThrow(/lifecycleState is required/i);

    const task = await createGoalTask(goal.id, { type: 'analysis', title: 'Valid task' });
    await expect(updateGoalTaskStatus(task.id, '')).rejects.toThrow(/status is required/i);

    const fetched = await getGoalTask(task.id);
    expect(fetched.title).toBe('Valid task');
  });

  test('deletes a goal and its tasks (and optionally child goals)', async () => {
    const parent = await createGoal({ projectId: 22, prompt: 'Parent goal' });
    const child = await createGoal({ projectId: 22, prompt: 'Child goal', parentGoalId: parent.id });

    await createGoalTask(parent.id, { type: 'analysis', title: 'Parent task' });
    await createGoalTask(child.id, { type: 'analysis', title: 'Child task' });

    const result = await deleteGoal(parent.id, { includeChildren: true });
    expect(result.deleted).toBe(true);
    expect(result.deletedGoalIds).toEqual(expect.arrayContaining([parent.id, child.id]));

    await expect(getGoal(parent.id)).resolves.toBeNull();
    await expect(getGoal(child.id)).resolves.toBeNull();
    await expect(listGoalTasks(parent.id)).resolves.toEqual([]);
  });

  test('deleteGoal avoids loops when goals form cycles (covers seen-guard branch)', async () => {
    const parent = await createGoal({ projectId: 23, prompt: 'Cyclic parent' });
    const child = await createGoal({ projectId: 23, prompt: 'Cyclic child', parentGoalId: parent.id });

    // Create a cycle: parent -> child -> parent.
    await runRaw('UPDATE agent_goals SET parent_goal_id = ? WHERE id = ?', [child.id, parent.id]);

    const result = await deleteGoal(parent.id, { includeChildren: true });

    expect(result.deleted).toBe(true);
    expect(result.deletedGoalIds).toEqual(expect.arrayContaining([parent.id, child.id]));
    expect(new Set(result.deletedGoalIds).size).toBe(result.deletedGoalIds.length);

    await expect(getGoal(parent.id)).resolves.toBeNull();
    await expect(getGoal(child.id)).resolves.toBeNull();
  });

  test('deleteGoal can skip child deletion when includeChildren=false', async () => {
    const parent = await createGoal({ projectId: 24, prompt: 'Parent keep children' });
    const child = await createGoal({ projectId: 24, prompt: 'Child kept', parentGoalId: parent.id });

    await createGoalTask(parent.id, { type: 'analysis', title: 'Parent task' });
    await createGoalTask(child.id, { type: 'analysis', title: 'Child task' });

    const result = await deleteGoal(parent.id, { includeChildren: false });
    expect(result.deleted).toBe(true);
    expect(result.deletedGoalIds).toEqual([parent.id]);

    await expect(getGoal(parent.id)).resolves.toBeNull();
    await expect(getGoal(child.id)).resolves.toMatchObject({ id: child.id, parentGoalId: parent.id });
    await expect(listGoalTasks(child.id)).resolves.toHaveLength(1);
  });

  test('deleteGoal returns deleted:false when the goal does not exist', async () => {
    const result = await deleteGoal(999999, { includeChildren: true });
    expect(result).toEqual({ deleted: false, deletedGoalIds: [] });
  });

  test('listChildGoalIds returns empty when goalIds is missing/invalid', async () => {
    await expect(goalStoreTesting.listChildGoalIds()).resolves.toEqual([]);
    await expect(goalStoreTesting.listChildGoalIds([])).resolves.toEqual([]);
    await expect(goalStoreTesting.listChildGoalIds(null)).resolves.toEqual([]);
    await expect(goalStoreTesting.listChildGoalIds('nope')).resolves.toEqual([]);
  });
});
