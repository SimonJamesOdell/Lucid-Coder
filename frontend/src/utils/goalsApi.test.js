import { describe, test, expect, beforeEach, vi } from 'vitest';
import axios from 'axios';
import {
  fetchGoals,
  createGoal,
  createMetaGoalWithChildren,
  advanceGoalPhase,
  recordGoalTestRun,
  runGoalTests,
  planMetaGoal,
  agentRequest
} from './goalsApi';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn()
  }
}));

const mockedAxios = axios;

describe('goalsApi helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('fetchGoals requires projectId and returns goal list', async () => {
    await expect(fetchGoals()).rejects.toThrow('projectId is required');

    mockedAxios.get.mockResolvedValue({ data: { goals: [{ id: 'g1' }] } });
    const result = await fetchGoals('proj-1');
    expect(result).toEqual([{ id: 'g1' }]);
    expect(mockedAxios.get).toHaveBeenCalledWith('/api/goals', { params: { projectId: 'proj-1' } });

    mockedAxios.get.mockResolvedValue({ data: {} });
    const fallback = await fetchGoals('proj-2');
    expect(fallback).toEqual([]);
  });

  test('createGoal validates prompt and returns payload', async () => {
    await expect(createGoal('proj-1')).rejects.toThrow('prompt is required');
    await expect(createGoal()).rejects.toThrow('projectId is required');

    mockedAxios.post.mockResolvedValue({ data: { id: 'goal-123' } });
    const result = await createGoal('proj-1', 'Ship onboarding');
    expect(mockedAxios.post).toHaveBeenCalledWith('/api/goals', { projectId: 'proj-1', prompt: 'Ship onboarding' });
    expect(result).toEqual({ id: 'goal-123' });
  });

  test('createMetaGoalWithChildren posts parent + child prompts', async () => {
    await expect(createMetaGoalWithChildren({ projectId: 'proj-1' })).rejects.toThrow('prompt is required');
    await expect(createMetaGoalWithChildren({ prompt: 'Fix failing tests', childPrompts: [] })).rejects.toThrow('projectId is required');
    await expect(createMetaGoalWithChildren({ projectId: 'proj-1', prompt: 'Fix failing tests' })).rejects.toThrow('childPrompts must be an array');

    mockedAxios.post.mockResolvedValue({ data: { parent: { id: 1 }, children: [{ id: 2 }] } });
    const payload = { projectId: 'proj-1', prompt: 'Fix failing tests', childPrompts: ['Fix failing frontend tests'] };
    const result = await createMetaGoalWithChildren(payload);
    expect(mockedAxios.post).toHaveBeenCalledWith('/api/goals/plan', payload);
    expect(result).toEqual({ parent: { id: 1 }, children: [{ id: 2 }] });
  });

  test('advanceGoalPhase enforces goalId and phase', async () => {
    await expect(advanceGoalPhase()).rejects.toThrow('goalId is required');
    await expect(advanceGoalPhase('goal-1')).rejects.toThrow('phase is required');

    mockedAxios.post.mockResolvedValue({ data: { success: true } });
    await advanceGoalPhase('goal-1', 'review', { reviewer: 'qa' });
    expect(mockedAxios.post).toHaveBeenCalledWith('/api/goals/goal-1/phase', { phase: 'review', metadata: { reviewer: 'qa' } });
  });

  test('recordGoalTestRun posts payload with default object', async () => {
    await expect(recordGoalTestRun()).rejects.toThrow('goalId is required');
    mockedAxios.post.mockResolvedValue({ data: { success: true } });
    await recordGoalTestRun('goal-2');
    expect(mockedAxios.post).toHaveBeenCalledWith('/api/goals/goal-2/tests', {});

    await recordGoalTestRun('goal-2', { passed: true });
    expect(mockedAxios.post).toHaveBeenCalledWith('/api/goals/goal-2/tests', { passed: true });
  });

  test('runGoalTests mirrors record behaviour and enforces goalId', async () => {
    await expect(runGoalTests()).rejects.toThrow('goalId is required');

    mockedAxios.post.mockResolvedValue({ data: { queued: true } });
    await runGoalTests('goal-3');
    expect(mockedAxios.post).toHaveBeenCalledWith('/api/goals/goal-3/run-tests', {});

    await runGoalTests('goal-3', { suite: 'smoke' });
    expect(mockedAxios.post).toHaveBeenCalledWith('/api/goals/goal-3/run-tests', { suite: 'smoke' });
  });

  test('planMetaGoal and agentRequest require projectId + prompt', async () => {
    await expect(planMetaGoal({ projectId: 'proj-1' })).rejects.toThrow('prompt is required');
    await expect(planMetaGoal({ prompt: 'Explore' })).rejects.toThrow('projectId is required');
    mockedAxios.post.mockResolvedValue({ data: { planned: true } });
    await planMetaGoal({ projectId: 'proj-1', prompt: 'Explore' });
    expect(mockedAxios.post).toHaveBeenCalledWith('/api/goals/plan-from-prompt', { projectId: 'proj-1', prompt: 'Explore' });

    await expect(agentRequest({ projectId: 'proj-1' })).rejects.toThrow('prompt is required');
    await expect(agentRequest({ prompt: 'Assist' })).rejects.toThrow('projectId is required');
    mockedAxios.post.mockResolvedValue({ data: { ok: true } });
    await agentRequest({ projectId: 'proj-1', prompt: 'Assist' });
    expect(mockedAxios.post).toHaveBeenCalledWith('/api/agent/request', { projectId: 'proj-1', prompt: 'Assist' });
  });
});
