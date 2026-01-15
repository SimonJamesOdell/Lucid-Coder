import express from 'express';
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

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const { projectId, prompt } = req.body || {};
    const result = await createGoalFromPrompt({ projectId, prompt });
    res.status(201).json(result);
  } catch (error) {
    if (/projectId is required|prompt is required/i.test(error.message)) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error('Error creating goal:', error);
    res.status(500).json({ error: 'Failed to create goal' });
  }
});

router.get('/', async (req, res) => {
  try {
    const projectId = Number(req.query.projectId);
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }
    const includeArchived = String(req.query.includeArchived || '').trim() === '1';
    const goals = await listGoalsForProject(projectId, { includeArchived });
    res.json({ goals });
  } catch (error) {
    console.error('Error listing goals:', error);
    res.status(500).json({ error: 'Failed to list goals' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'id is required' });
    }
    const result = await getGoalWithTasks(id);
    if (!result) {
      return res.status(404).json({ error: 'Goal not found' });
    }
    res.json(result);
  } catch (error) {
    console.error('Error fetching goal:', error);
    res.status(500).json({ error: 'Failed to fetch goal' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'id is required' });
    }

    const result = await deleteGoalById(id, { includeChildren: true });
    if (!result?.deleted) {
      return res.status(404).json({ error: 'Goal not found' });
    }

    return res.json({
      success: true,
      deletedGoalIds: result.deletedGoalIds || [id]
    });
  } catch (error) {
    console.error('Error deleting goal:', error);
    return res.status(500).json({ error: 'Failed to delete goal' });
  }
});

router.post('/:id/phase', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { phase, metadata } = req.body || {};

    if (!id) {
      return res.status(400).json({ error: 'id is required' });
    }
    if (!phase) {
      return res.status(400).json({ error: 'phase is required' });
    }

    const updated = await advanceGoalPhase(id, phase, metadata);
    if (!updated) {
      return res.status(404).json({ error: 'Goal not found' });
    }
    res.json(updated);
  } catch (error) {
    if (/Unknown phase/i.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    if (/Goal not found/i.test(error.message)) {
      return res.status(404).json({ error: 'Goal not found' });
    }
    if (/Invalid phase transition/i.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Error advancing goal phase:', error);
    res.status(500).json({ error: 'Failed to advance goal phase' });
  }
});

router.post('/:id/state', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { state, metadata } = req.body || {};

    if (!id) {
      return res.status(400).json({ error: 'id is required' });
    }
    if (!state) {
      return res.status(400).json({ error: 'state is required' });
    }

    const updated = await advanceGoalState(id, state, metadata);
    if (!updated) {
      return res.status(404).json({ error: 'Goal not found' });
    }
    res.json(updated);
  } catch (error) {
    if (/Unknown state/i.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    if (/Goal not found/i.test(error.message)) {
      return res.status(404).json({ error: 'Goal not found' });
    }
    if (/Invalid goal transition/i.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Error advancing goal state:', error);
    res.status(500).json({ error: 'Failed to advance goal state' });
  }
});

router.post('/:id/tests', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { status, summary, logs } = req.body || {};

    if (!id) {
      return res.status(400).json({ error: 'id is required' });
    }
    if (!status) {
      return res.status(400).json({ error: 'status is required' });
    }

    const task = await recordTestRunForGoal(id, { status, summary, logs });
    res.json(task);
  } catch (error) {
    if (/Goal not found/i.test(error.message)) {
      return res.status(404).json({ error: 'Goal not found' });
    }
    if (/status is required/i.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Error recording test run:', error);
    res.status(500).json({ error: 'Failed to record test run' });
  }
});

router.post('/:id/run-tests', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { cwd, command, args, env } = req.body || {};

    if (!id) {
      return res.status(400).json({ error: 'id is required' });
    }

    if (!cwd || !command) {
      return res.status(400).json({ error: 'cwd and command are required' });
    }

    const task = await runTestsForGoal(id, { cwd, command, args, env });
    res.json(task);
  } catch (error) {
    if (/Goal not found/i.test(error.message)) {
      return res.status(404).json({ error: 'Goal not found' });
    }
    console.error('Error running tests for goal:', error);
    res.status(500).json({ error: 'Failed to run tests for goal' });
  }
});

router.post('/plan', async (req, res) => {
  try {
    const { projectId, prompt, childPrompts } = req.body || {};

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }
    if (!prompt) {
      return res.status(400).json({ error: 'prompt is required' });
    }

    const result = await createMetaGoalWithChildren({ projectId, prompt, childPrompts });
    res.status(201).json(result);
  } catch (error) {
    if (/childPrompts must be an array/i.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    if (/Parent goal not found|Child goal must use same projectId as parent/i.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    if (/projectId is required|prompt is required/i.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Error planning meta-goal with children:', error);
    res.status(500).json({ error: 'Failed to plan meta-goal with children' });
  }
});

router.post('/plan-from-prompt', async (req, res) => {
  const { projectId, prompt } = req.body || {};
  try {

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }
    if (!prompt) {
      return res.status(400).json({ error: 'prompt is required' });
    }

    const result = await planGoalFromPrompt({ projectId, prompt });
    res.status(201).json(result);
  } catch (error) {
    if (/projectId is required|prompt is required/i.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    if (isLlmPlanningError(error)) {
      try {
        const fallbackResult = await planGoalFromPromptFallback({ projectId, prompt });
        return res.status(201).json(fallbackResult);
      } catch (fallbackError) {
        console.error('Fallback planning also failed:', fallbackError?.message || fallbackError);
        return res.status(502).json({ error: error.message });
      }
    }
    console.error('Error planning meta-goal from prompt via LLM:', error);
    res.status(500).json({ error: 'Failed to plan meta-goal from prompt' });
  }
});

export default router;
