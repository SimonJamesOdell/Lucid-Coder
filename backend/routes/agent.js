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
import {
  AutopilotSessionErrorCodes,
  cancelAutopilotSession,
  createAutopilotSession,
  enqueueAutopilotSessionMessage,
  getAutopilotSession,
  resumeAutopilotSessions
} from '../services/autopilotSessions.js';
import { runForegroundCleanup } from '../services/foregroundCleanupRunner.js';

const router = express.Router();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const STREAM_CHUNK_SIZE = 24;
const STREAM_DELAY_MS = process.env.NODE_ENV === 'test' ? 0 : 15;

const writeSseEvent = (res, event, payload) => {
  if (!res || res.writableEnded || res.destroyed) {
    return false;
  }

  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch {
    return false;
  }
};

router.post('/cleanup/stream', async (req, res) => {
  const cancelled = { value: false };

  try {
    const {
      projectId,
      prompt,
      includeFrontend = true,
      includeBackend = true,
      pruneRedundantTests = true,
      options
    } = req.body || {};

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }
    if (!res || res.writableEnded || res.destroyed) {
      return res.end();
    }

    try {
      res.write('retry: 1000\n\n');
    } catch {
      return res.end();
    }

    // Important: `req` can emit `close` as soon as the request body is fully read.
    // For SSE, we want cancellation when the client disconnects from the response.
    res.on('close', () => {
      cancelled.value = true;
    });
    req.on('aborted', () => {
      cancelled.value = true;
    });

    const result = await runForegroundCleanup({
      projectId,
      prompt: typeof prompt === 'string' ? prompt : '',
      includeFrontend: Boolean(includeFrontend),
      includeBackend: Boolean(includeBackend),
      pruneRedundantTests: pruneRedundantTests !== false,
      options,
      shouldCancel: () => cancelled.value,
      onEvent: ({ event, data }) => {
        writeSseEvent(res, event || 'message', data || {});
      }
    });

    writeSseEvent(res, 'done', { result });
    res.end();
  } catch (error) {
    if (error?.code === 'CLEANUP_CANCELLED' || cancelled.value) {
      writeSseEvent(res, 'done', { result: { cancelled: true } });
      return res.end();
    }

    writeSseEvent(res, 'error', { message: error?.message || 'Cleanup failed' });
    return res.end();
  }
});

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

router.post('/request/stream', async (req, res) => {
  try {
    const { projectId, prompt } = req.body || {};

    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }
    if (!prompt) {
      return res.status(400).json({ error: 'prompt is required' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }
    res.write('retry: 1000\n\n');

    const result = await handleAgentRequest({ projectId, prompt });

    if (result?.kind === 'question' && typeof result.answer === 'string' && result.answer.length > 0) {
      for (let index = 0; index < result.answer.length; index += STREAM_CHUNK_SIZE) {
        const chunk = result.answer.slice(index, index + STREAM_CHUNK_SIZE);
        writeSseEvent(res, 'chunk', { text: chunk });
        if (STREAM_DELAY_MS) {
          await sleep(STREAM_DELAY_MS);
        }
      }
    }

    writeSseEvent(res, 'done', { result });
    res.end();
  } catch (error) {
    writeSseEvent(res, 'error', { message: error?.message || 'Agent request failed' });
    res.end();
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

router.post('/autopilot', async (req, res) => {
  try {
    const { projectId, prompt, options, uiSessionId } = req.body || {};
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }
    if (!prompt) {
      return res.status(400).json({ error: 'prompt is required' });
    }
    const session = await createAutopilotSession({ projectId, prompt, options, uiSessionId });
    res.status(202).json({ success: true, session });
  } catch (error) {
    console.error('[Agent Autopilot] Start failed:', error);
    res.status(500).json({
      error: 'Failed to start autopilot session',
      details: error?.message || 'Unknown error'
    });
  }
});

router.get('/autopilot/sessions/:sessionId', (req, res) => {
  try {
    const { projectId } = req.query || {};
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    const session = getAutopilotSession(req.params.sessionId);
    if (!session || String(session.projectId) !== String(projectId)) {
      return res.status(404).json({ error: 'Autopilot session not found' });
    }

    res.status(200).json({ success: true, session });
  } catch (error) {
    console.error('[Agent Autopilot] Status failed:', error);
    res.status(500).json({
      error: 'Failed to fetch autopilot session',
      details: error?.message || 'Unknown error'
    });
  }
});

router.post('/autopilot/sessions/:sessionId/messages', (req, res) => {
  try {
    const { projectId, message, kind, metadata } = req.body || {};
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }
    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    const session = enqueueAutopilotSessionMessage({
      sessionId: req.params.sessionId,
      projectId,
      message,
      kind,
      metadata
    });
    res.status(200).json({ success: true, session });
  } catch (error) {
    if (error?.code === AutopilotSessionErrorCodes.NOT_FOUND) {
      return res.status(404).json({ error: 'Autopilot session not found' });
    }
    console.error('[Agent Autopilot] Message failed:', error);
    res.status(500).json({
      error: 'Failed to enqueue autopilot message',
      details: error?.message || 'Unknown error'
    });
  }
});

router.post('/autopilot/sessions/:sessionId/cancel', (req, res) => {
  try {
    const { projectId, reason } = req.body || {};
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    const session = cancelAutopilotSession({
      sessionId: req.params.sessionId,
      projectId,
      reason
    });
    res.status(200).json({ success: true, session });
  } catch (error) {
    if (error?.code === AutopilotSessionErrorCodes.NOT_FOUND) {
      return res.status(404).json({ error: 'Autopilot session not found' });
    }
    console.error('[Agent Autopilot] Cancel failed:', error);
    res.status(500).json({
      error: 'Failed to cancel autopilot session',
      details: error?.message || 'Unknown error'
    });
  }
});

router.post('/autopilot/resume', (req, res) => {
  try {
    const { projectId, uiSessionId, limit } = req.body || {};
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }
    if (!uiSessionId) {
      return res.status(400).json({ error: 'uiSessionId is required' });
    }

    const result = resumeAutopilotSessions({ projectId, uiSessionId, limit });
    res.status(200).json(result);
  } catch (error) {
    console.error('[Agent Autopilot] Resume failed:', error);
    res.status(500).json({
      error: 'Failed to resume autopilot sessions',
      details: error?.message || 'Unknown error'
    });
  }
});

export default router;
