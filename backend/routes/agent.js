import express from 'express';
import { handleAgentRequest } from '../services/agentRequestHandler.js';
import { planGoalFromPrompt, createChildGoal } from '../services/agentOrchestrator.js';
import { runTestsForBranch } from '../services/branchWorkflow.js';
import {
  acknowledgeUiCommands,
  enqueueUiCommand,
  getUiSnapshot,
  listUiCommands,
  upsertUiSnapshot
} from '../services/agentUiState.js';

const router = express.Router();

router.post('/request', async (req, res) => {
  try {
    const { projectId, prompt } = req.body || {};

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }
    if (!prompt) {
      return res.status(400).json({ error: 'prompt is required' });
    }

    const result = await handleAgentRequest({ projectId, prompt });
    res.status(200).json(result);
  } catch (error) {
    console.error('[Agent] Request failed:', error.message || error);
    res.status(500).json({ 
      error: 'Agent request failed', 
      details: error.message || 'Unknown error' 
    });
  }
});

router.post('/ui/snapshot', (req, res) => {
  try {
    const { projectId, sessionId, ...snapshot } = req.body || {};
    if (!projectId || !sessionId) {
      return res.status(400).json({ error: 'projectId and sessionId are required' });
    }
    upsertUiSnapshot(projectId, sessionId, snapshot);
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('[Agent UI] Snapshot update failed:', error);
    res.status(500).json({ error: 'Failed to update UI snapshot' });
  }
});

router.get('/ui/snapshot', (req, res) => {
  try {
    const { projectId, sessionId } = req.query;
    if (!projectId || !sessionId) {
      return res.status(400).json({ error: 'projectId and sessionId are required' });
    }
    const snapshot = getUiSnapshot(projectId, sessionId);
    res.status(200).json(snapshot || {});
  } catch (error) {
    console.error('[Agent UI] Snapshot retrieval failed:', error);
    res.status(500).json({ error: 'Failed to get UI snapshot' });
  }
});

router.post('/ui/commands', (req, res) => {
  try {
    const { projectId, sessionId, command } = req.body || {};
    if (!projectId || !sessionId || !command) {
      return res.status(400).json({ error: 'projectId, sessionId, and command are required' });
    }
    enqueueUiCommand(projectId, sessionId, command);
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('[Agent UI] Command enqueue failed:', error);
    res.status(500).json({ error: 'Failed to enqueue UI command' });
  }
});

router.get('/ui/commands', (req, res) => {
  try {
    const { projectId, sessionId } = req.query;
    if (!projectId || !sessionId) {
      return res.status(400).json({ error: 'projectId and sessionId are required' });
    }
    const commands = listUiCommands(projectId, sessionId);
    res.status(200).json({ commands });
  } catch (error) {
    console.error('[Agent UI] Command list failed:', error);
    res.status(500).json({ error: 'Failed to list UI commands' });
  }
});

router.post('/ui/commands/ack', (req, res) => {
  try {
    const { projectId, sessionId, commandIds } = req.body || {};
    if (!projectId || !sessionId || !Array.isArray(commandIds)) {
      return res.status(400).json({ error: 'projectId, sessionId, and commandIds array are required' });
    }
    acknowledgeUiCommands(projectId, sessionId, commandIds);
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('[Agent UI] Command acknowledgment failed:', error);
    res.status(500).json({ error: 'Failed to acknowledge UI commands' });
  }
});

export default router;
