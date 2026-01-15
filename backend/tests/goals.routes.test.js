import { beforeEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../services/agentOrchestrator.js', () => ({
  createGoalFromPrompt: vi.fn(),
  getGoalWithTasks: vi.fn(),
  listGoalsForProject: vi.fn(),
  deleteGoalById: vi.fn(),
  advanceGoalPhase: vi.fn(),
  advanceGoalState: vi.fn(),
  recordTestRunForGoal: vi.fn(),
  runTestsForGoal: vi.fn(),
  createMetaGoalWithChildren: vi.fn(),
  planGoalFromPrompt: vi.fn()
}));
vi.mock('../services/planningFallback.js', () => ({
  isLlmPlanningError: vi.fn(() => false),
  planGoalFromPromptFallback: vi.fn()
}));

import goalsRoutes from '../routes/goals.js';
import {
  createGoalFromPrompt,
  getGoalWithTasks,
  listGoalsForProject,
  deleteGoalById,
  advanceGoalPhase,
  advanceGoalState,
  recordTestRunForGoal,
  runTestsForGoal,
  createMetaGoalWithChildren,
  planGoalFromPrompt
} from '../services/agentOrchestrator.js';
import { isLlmPlanningError, planGoalFromPromptFallback } from '../services/planningFallback.js';

describe('Goals routes', () => {
  const createApp = (withJson = true) => {
    const app = express();
    if (withJson) app.use(express.json());
    app.use('/api/goals', goalsRoutes);
    return app;
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/goals', () => {
    test('creates goal', async () => {
      createGoalFromPrompt.mockResolvedValue({ id: 1 });

      const res = await request(createApp())
        .post('/api/goals')
        .send({ projectId: 123, prompt: 'Do it' });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ id: 1 });
      expect(createGoalFromPrompt).toHaveBeenCalledWith({ projectId: 123, prompt: 'Do it' });
    });

    test('maps validation errors to 400', async () => {
      createGoalFromPrompt.mockRejectedValue(new Error('projectId is required'));

      const res = await request(createApp())
        .post('/api/goals')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'projectId is required' });
    });

    test('returns 500 on unexpected error', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      createGoalFromPrompt.mockRejectedValue(new Error('boom'));

      const res = await request(createApp())
        .post('/api/goals')
        .send({ projectId: 1, prompt: 'x' });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to create goal' });

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    test('handles missing body (req.body fallback)', async () => {
      createGoalFromPrompt.mockRejectedValue(new Error('projectId is required'));

      const res = await request(createApp(false)).post('/api/goals');

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/projectId is required/i);
    });
  });

  describe('GET /api/goals', () => {
    test('requires projectId', async () => {
      const res = await request(createApp())
        .get('/api/goals');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'projectId is required' });
    });

    test('lists goals with includeArchived=1', async () => {
      listGoalsForProject.mockResolvedValue([{ id: 1 }]);

      const res = await request(createApp())
        .get('/api/goals')
        .query({ projectId: 123, includeArchived: '1' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ goals: [{ id: 1 }] });
      expect(listGoalsForProject).toHaveBeenCalledWith(123, { includeArchived: true });
    });

    test('lists goals with includeArchived default false', async () => {
      listGoalsForProject.mockResolvedValue([]);

      const res = await request(createApp())
        .get('/api/goals')
        .query({ projectId: 123 });

      expect(res.status).toBe(200);
      expect(listGoalsForProject).toHaveBeenCalledWith(123, { includeArchived: false });
    });

    test('returns 500 on list failure', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      listGoalsForProject.mockRejectedValue(new Error('boom'));

      const res = await request(createApp())
        .get('/api/goals')
        .query({ projectId: 123 });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to list goals' });

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('GET /api/goals/:id', () => {
    test('requires id', async () => {
      const res = await request(createApp())
        .get('/api/goals/0');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'id is required' });
    });

    test('returns 404 when missing', async () => {
      getGoalWithTasks.mockResolvedValue(null);

      const res = await request(createApp())
        .get('/api/goals/1');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Goal not found' });
    });

    test('returns goal with tasks', async () => {
      getGoalWithTasks.mockResolvedValue({ id: 1, tasks: [] });

      const res = await request(createApp())
        .get('/api/goals/1');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: 1, tasks: [] });
    });

    test('returns 500 on fetch error', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      getGoalWithTasks.mockRejectedValue(new Error('boom'));

      const res = await request(createApp())
        .get('/api/goals/1');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to fetch goal' });

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('DELETE /api/goals/:id', () => {
    test('requires id', async () => {
      const res = await request(createApp())
        .delete('/api/goals/0');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'id is required' });
    });

    test('returns 404 when goal not found', async () => {
      deleteGoalById.mockResolvedValue({ deleted: false });

      const res = await request(createApp())
        .delete('/api/goals/1');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Goal not found' });
    });

    test('deletes goal and returns deletedGoalIds', async () => {
      deleteGoalById.mockResolvedValue({ deleted: true, deletedGoalIds: [1, 2] });

      const res = await request(createApp())
        .delete('/api/goals/1');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, deletedGoalIds: [1, 2] });
      expect(deleteGoalById).toHaveBeenCalledWith(1, { includeChildren: true });
    });

    test('defaults deletedGoalIds to [id]', async () => {
      deleteGoalById.mockResolvedValue({ deleted: true });

      const res = await request(createApp())
        .delete('/api/goals/7');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, deletedGoalIds: [7] });
    });

    test('returns 500 on delete failure', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      deleteGoalById.mockRejectedValue(new Error('boom'));

      const res = await request(createApp())
        .delete('/api/goals/1');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to delete goal' });

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('POST /api/goals/:id/phase', () => {
    test('requires id', async () => {
      const res = await request(createApp())
        .post('/api/goals/0/phase')
        .send({ phase: 'testing' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'id is required' });
    });

    test('requires phase', async () => {
      const res = await request(createApp())
        .post('/api/goals/1/phase')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'phase is required' });
    });

    test('returns 404 when advance returns null', async () => {
      advanceGoalPhase.mockResolvedValue(null);

      const res = await request(createApp())
        .post('/api/goals/1/phase')
        .send({ phase: 'testing', metadata: { a: 1 } });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Goal not found' });
    });

    test('advances phase and returns updated goal', async () => {
      advanceGoalPhase.mockResolvedValue({ id: 1, phase: 'testing' });

      const res = await request(createApp())
        .post('/api/goals/1/phase')
        .send({ phase: 'testing', metadata: { a: 1 } });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: 1, phase: 'testing' });
      expect(advanceGoalPhase).toHaveBeenCalledWith(1, 'testing', { a: 1 });
    });

    test('maps Unknown phase to 400', async () => {
      advanceGoalPhase.mockRejectedValue(new Error('Unknown phase: nope'));

      const res = await request(createApp())
        .post('/api/goals/1/phase')
        .send({ phase: 'nope' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Unknown phase/i);
    });

    test('maps Goal not found error to 404', async () => {
      advanceGoalPhase.mockRejectedValue(new Error('Goal not found'));

      const res = await request(createApp())
        .post('/api/goals/1/phase')
        .send({ phase: 'testing' });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Goal not found' });
    });

    test('maps Invalid phase transition to 400', async () => {
      advanceGoalPhase.mockRejectedValue(new Error('Invalid phase transition'));

      const res = await request(createApp())
        .post('/api/goals/1/phase')
        .send({ phase: 'testing' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid phase transition/i);
    });

    test('returns 500 on unexpected error', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      advanceGoalPhase.mockRejectedValue(new Error('boom'));

      const res = await request(createApp())
        .post('/api/goals/1/phase')
        .send({ phase: 'testing' });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to advance goal phase' });
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    test('handles missing body (req.body fallback)', async () => {
      const res = await request(createApp(false))
        .post('/api/goals/1/phase');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'phase is required' });
    });
  });

  describe('POST /api/goals/:id/state', () => {
    test('requires id', async () => {
      const res = await request(createApp())
        .post('/api/goals/0/state')
        .send({ state: 'ready' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'id is required' });
    });

    test('requires state', async () => {
      const res = await request(createApp())
        .post('/api/goals/1/state')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'state is required' });
    });

    test('returns 404 when advance returns null', async () => {
      advanceGoalState.mockResolvedValue(null);

      const res = await request(createApp())
        .post('/api/goals/1/state')
        .send({ state: 'ready', metadata: { a: 1 } });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Goal not found' });
    });

    test('advances state and returns updated goal', async () => {
      advanceGoalState.mockResolvedValue({ id: 1, state: 'ready' });

      const res = await request(createApp())
        .post('/api/goals/1/state')
        .send({ state: 'ready', metadata: { a: 1 } });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: 1, state: 'ready' });
      expect(advanceGoalState).toHaveBeenCalledWith(1, 'ready', { a: 1 });
    });

    test('maps Unknown state to 400', async () => {
      advanceGoalState.mockRejectedValue(new Error('Unknown state: nope'));

      const res = await request(createApp())
        .post('/api/goals/1/state')
        .send({ state: 'nope' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Unknown state/i);
    });

    test('maps Goal not found error to 404', async () => {
      advanceGoalState.mockRejectedValue(new Error('Goal not found'));

      const res = await request(createApp())
        .post('/api/goals/1/state')
        .send({ state: 'ready' });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Goal not found' });
    });

    test('maps Invalid goal transition to 400', async () => {
      advanceGoalState.mockRejectedValue(new Error('Invalid goal transition'));

      const res = await request(createApp())
        .post('/api/goals/1/state')
        .send({ state: 'ready' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid goal transition/i);
    });

    test('returns 500 on unexpected error', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      advanceGoalState.mockRejectedValue(new Error('boom'));

      const res = await request(createApp())
        .post('/api/goals/1/state')
        .send({ state: 'ready' });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to advance goal state' });
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    test('handles missing body (req.body fallback)', async () => {
      const res = await request(createApp(false))
        .post('/api/goals/1/state');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'state is required' });
    });
  });

  describe('POST /api/goals/:id/tests', () => {
    test('requires id', async () => {
      const res = await request(createApp())
        .post('/api/goals/0/tests')
        .send({ status: 'passed' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'id is required' });
    });

    test('requires status', async () => {
      const res = await request(createApp())
        .post('/api/goals/1/tests')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'status is required' });
    });

    test('records test run and returns task', async () => {
      recordTestRunForGoal.mockResolvedValue({ id: 10, kind: 'test' });

      const res = await request(createApp())
        .post('/api/goals/1/tests')
        .send({ status: 'passed', summary: { total: 1 }, logs: 'ok' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: 10, kind: 'test' });
      expect(recordTestRunForGoal).toHaveBeenCalledWith(1, { status: 'passed', summary: { total: 1 }, logs: 'ok' });
    });

    test('maps Goal not found to 404', async () => {
      recordTestRunForGoal.mockRejectedValue(new Error('Goal not found'));

      const res = await request(createApp())
        .post('/api/goals/1/tests')
        .send({ status: 'passed' });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Goal not found' });
    });

    test('maps status required error to 400', async () => {
      recordTestRunForGoal.mockRejectedValue(new Error('status is required'));

      const res = await request(createApp())
        .post('/api/goals/1/tests')
        .send({ status: 'passed' });

      // Route maps message containing "status is required" to 400
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/status is required/i);
    });

    test('returns 500 on unexpected error', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      recordTestRunForGoal.mockRejectedValue(new Error('boom'));

      const res = await request(createApp())
        .post('/api/goals/1/tests')
        .send({ status: 'passed' });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to record test run' });
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    test('handles missing body (req.body fallback)', async () => {
      const res = await request(createApp(false))
        .post('/api/goals/1/tests');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'status is required' });
    });
  });

  describe('POST /api/goals/:id/run-tests', () => {
    test('requires id', async () => {
      const res = await request(createApp())
        .post('/api/goals/0/run-tests')
        .send({ cwd: '/tmp', command: 'npm' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'id is required' });
    });

    test('requires cwd and command', async () => {
      const res = await request(createApp())
        .post('/api/goals/1/run-tests')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'cwd and command are required' });
    });

    test('runs tests for goal', async () => {
      runTestsForGoal.mockResolvedValue({ id: 1, kind: 'task' });

      const res = await request(createApp())
        .post('/api/goals/1/run-tests')
        .send({ cwd: '/tmp', command: 'npm', args: ['test'], env: { A: '1' } });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: 1, kind: 'task' });
      expect(runTestsForGoal).toHaveBeenCalledWith(1, { cwd: '/tmp', command: 'npm', args: ['test'], env: { A: '1' } });
    });

    test('maps Goal not found to 404', async () => {
      runTestsForGoal.mockRejectedValue(new Error('Goal not found'));

      const res = await request(createApp())
        .post('/api/goals/1/run-tests')
        .send({ cwd: '/tmp', command: 'npm' });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Goal not found' });
    });

    test('returns 500 on unexpected error', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      runTestsForGoal.mockRejectedValue(new Error('boom'));

      const res = await request(createApp())
        .post('/api/goals/1/run-tests')
        .send({ cwd: '/tmp', command: 'npm' });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to run tests for goal' });
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    test('handles missing body (req.body fallback)', async () => {
      const res = await request(createApp(false))
        .post('/api/goals/1/run-tests');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'cwd and command are required' });
    });
  });

  describe('POST /api/goals/plan', () => {
    test('requires projectId', async () => {
      const res = await request(createApp())
        .post('/api/goals/plan')
        .send({ prompt: 'x' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'projectId is required' });
    });

    test('requires prompt', async () => {
      const res = await request(createApp())
        .post('/api/goals/plan')
        .send({ projectId: 1 });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'prompt is required' });
    });

    test('plans meta goal with children', async () => {
      createMetaGoalWithChildren.mockResolvedValue({ id: 1, children: [] });

      const res = await request(createApp())
        .post('/api/goals/plan')
        .send({ projectId: 1, prompt: 'x', childPrompts: ['a'] });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ id: 1, children: [] });
      expect(createMetaGoalWithChildren).toHaveBeenCalledWith({ projectId: 1, prompt: 'x', childPrompts: ['a'] });
    });

    test('maps childPrompts array validation to 400', async () => {
      createMetaGoalWithChildren.mockRejectedValue(new Error('childPrompts must be an array'));

      const res = await request(createApp())
        .post('/api/goals/plan')
        .send({ projectId: 1, prompt: 'x', childPrompts: 'nope' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/childPrompts must be an array/i);
    });

    test('maps parent/child constraint errors to 400', async () => {
      createMetaGoalWithChildren.mockRejectedValue(new Error('Parent goal not found'));

      const res = await request(createApp())
        .post('/api/goals/plan')
        .send({ projectId: 1, prompt: 'x', childPrompts: [] });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Parent goal not found/i);
    });

    test('maps required field errors to 400', async () => {
      createMetaGoalWithChildren.mockRejectedValue(new Error('prompt is required'));

      const res = await request(createApp())
        .post('/api/goals/plan')
        .send({ projectId: 1, prompt: 'x', childPrompts: [] });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/prompt is required/i);
    });

    test('returns 500 on unexpected error', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      createMetaGoalWithChildren.mockRejectedValue(new Error('boom'));

      const res = await request(createApp())
        .post('/api/goals/plan')
        .send({ projectId: 1, prompt: 'x', childPrompts: [] });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to plan meta-goal with children' });
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    test('handles missing body (req.body fallback)', async () => {
      const res = await request(createApp(false))
        .post('/api/goals/plan');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'projectId is required' });
    });
  });

  describe('POST /api/goals/plan-from-prompt', () => {
    test('requires projectId', async () => {
      const res = await request(createApp())
        .post('/api/goals/plan-from-prompt')
        .send({ prompt: 'x' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'projectId is required' });
    });

    test('requires prompt', async () => {
      const res = await request(createApp())
        .post('/api/goals/plan-from-prompt')
        .send({ projectId: 1 });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'prompt is required' });
    });

    test('plans meta goal from prompt', async () => {
      planGoalFromPrompt.mockResolvedValue({ id: 1 });

      const res = await request(createApp())
        .post('/api/goals/plan-from-prompt')
        .send({ projectId: 1, prompt: 'x' });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ id: 1 });
      expect(planGoalFromPrompt).toHaveBeenCalledWith({ projectId: 1, prompt: 'x' });
    });

    test('maps required field errors to 400', async () => {
      planGoalFromPrompt.mockRejectedValue(new Error('projectId is required'));

      const res = await request(createApp())
        .post('/api/goals/plan-from-prompt')
        .send({ projectId: 1, prompt: 'x' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/projectId is required/i);
    });

    test('falls back to simplified planning when the LLM planner fails', async () => {
      planGoalFromPrompt.mockRejectedValue(new Error('LLM planning response malformed'));
      isLlmPlanningError.mockReturnValue(true);
      planGoalFromPromptFallback.mockResolvedValue({ fallback: true });

      const res = await request(createApp())
        .post('/api/goals/plan-from-prompt')
        .send({ projectId: 1, prompt: 'x' });

      expect(planGoalFromPromptFallback).toHaveBeenCalledWith({ projectId: 1, prompt: 'x' });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ fallback: true });
    });

    test('returns 502 when both the LLM planner and fallback planner fail', async () => {
      planGoalFromPrompt.mockRejectedValue(new Error('LLM planning response malformed'));
      isLlmPlanningError.mockReturnValue(true);
      planGoalFromPromptFallback.mockRejectedValue(new Error('fallback boom'));
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await request(createApp())
        .post('/api/goals/plan-from-prompt')
        .send({ projectId: 1, prompt: 'x' });

      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/LLM planning response/i);
      expect(consoleSpy).toHaveBeenCalledWith('Fallback planning also failed:', 'fallback boom');
      consoleSpy.mockRestore();
    });

    test('logs fallback objects without message when both planners fail', async () => {
      planGoalFromPrompt.mockRejectedValue(new Error('LLM planning response malformed'));
      isLlmPlanningError.mockReturnValue(true);
      planGoalFromPromptFallback.mockRejectedValue(null);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await request(createApp())
        .post('/api/goals/plan-from-prompt')
        .send({ projectId: 1, prompt: 'x' });

      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/LLM planning response/i);
      expect(consoleSpy).toHaveBeenCalledWith('Fallback planning also failed:', null);
      consoleSpy.mockRestore();
    });

    test('returns 500 on unexpected error', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      planGoalFromPrompt.mockRejectedValue(new Error('boom'));
      isLlmPlanningError.mockReturnValue(false);

      const res = await request(createApp())
        .post('/api/goals/plan-from-prompt')
        .send({ projectId: 1, prompt: 'x' });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to plan meta-goal from prompt' });
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    test('handles missing body (req.body fallback)', async () => {
      const res = await request(createApp(false))
        .post('/api/goals/plan-from-prompt');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'projectId is required' });
    });
  });
});
