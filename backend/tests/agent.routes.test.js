import { beforeEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../services/agentRequestHandler.js', () => ({
  handleAgentRequest: vi.fn()
}));

vi.mock('../services/agentOrchestrator.js', () => ({
  planGoalFromPrompt: vi.fn(),
  createChildGoal: vi.fn()
}));

vi.mock('../services/branchWorkflow.js', () => ({
  runTestsForBranch: vi.fn()
}));

vi.mock('../services/agentUiState.js', () => ({
  acknowledgeUiCommands: vi.fn(),
  enqueueUiCommand: vi.fn(),
  getUiSnapshot: vi.fn(),
  listUiCommands: vi.fn(),
  upsertUiSnapshot: vi.fn()
}));

vi.mock('../services/autopilotSessions.js', () => ({
  AutopilotSessionErrorCodes: { NOT_FOUND: 'NOT_FOUND' },
  cancelAutopilotSession: vi.fn(),
  createAutopilotSession: vi.fn(),
  enqueueAutopilotSessionMessage: vi.fn(),
  getAutopilotSession: vi.fn(),
  resumeAutopilotSessions: vi.fn()
}));

import agentRoutes from '../routes/agent.js';
import { handleAgentRequest } from '../services/agentRequestHandler.js';
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

describe('Agent routes', () => {
  let app;

  const createApp = (withJson = true) => {
    const instance = express();
    if (withJson) {
      instance.use(express.json());
    }
    instance.use('/api/agent', agentRoutes);
    return instance;
  };

  const findRouteHandler = (path, method) => {
    const layer = agentRoutes.stack.find((entry) => entry.route?.path === path && entry.route?.methods?.[method]);
    if (!layer) {
      throw new Error(`Route handler not found for ${method.toUpperCase()} ${path}`);
    }
    return layer.route.stack[0].handle;
  };

  const invokeRoute = async (path, method, reqOverrides = {}) => {
    const handler = findRouteHandler(path, method);
    const status = vi.fn().mockReturnThis();
    const json = vi.fn().mockReturnThis();
    const res = { status, json };
    const req = {
      body: undefined,
      params: {},
      query: undefined,
      ...reqOverrides
    };

    await handler(req, res);
    return { status, json };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp(true);
  });

  describe('POST /api/agent/request', () => {
    test('rejects when body is missing (req.body fallback)', async () => {
      const response = await request(createApp(false))
        .post('/api/agent/request');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'projectId is required' });
    });

    test('rejects missing projectId', async () => {
      const response = await request(app)
        .post('/api/agent/request')
        .send({ prompt: 'Do something' });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'projectId is required' });
    });

    test('rejects missing prompt', async () => {
      const response = await request(app)
        .post('/api/agent/request')
        .send({ projectId: 123 });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'prompt is required' });
    });

    test('returns agent handler result on success', async () => {
      handleAgentRequest.mockResolvedValue({ success: true, kind: 'feature' });

      const response = await request(app)
        .post('/api/agent/request')
        .send({ projectId: 123, prompt: 'Do something' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true, kind: 'feature' });
      expect(handleAgentRequest).toHaveBeenCalledWith({ projectId: 123, prompt: 'Do something' });
    });

    test('returns 500 with error.message details on failure', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      handleAgentRequest.mockRejectedValue(new Error('boom'));

      const response = await request(app)
        .post('/api/agent/request')
        .send({ projectId: 123, prompt: 'Do something' });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Agent request failed',
        details: 'boom'
      });

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    test("returns 500 with 'Unknown error' details when thrown value has no message", async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      handleAgentRequest.mockRejectedValue({});

      const response = await request(app)
        .post('/api/agent/request')
        .send({ projectId: 123, prompt: 'Do something' });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Agent request failed',
        details: 'Unknown error'
      });

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('POST /api/agent/ui/snapshot', () => {
    test('rejects when body is missing (req.body fallback)', async () => {
      const response = await request(createApp(false))
        .post('/api/agent/ui/snapshot');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'projectId and sessionId are required' });
    });

    test('rejects missing projectId/sessionId', async () => {
      const response = await request(app)
        .post('/api/agent/ui/snapshot')
        .send({ projectId: 1 });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'projectId and sessionId are required' });
    });

    test('upserts snapshot and returns success', async () => {
      const response = await request(app)
        .post('/api/agent/ui/snapshot')
        .send({ projectId: 1, sessionId: 's1', tab: 'goals', count: 2 });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
      expect(upsertUiSnapshot).toHaveBeenCalledWith(1, 's1', { tab: 'goals', count: 2 });
    });

    test('returns 500 when snapshot upsert throws', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      upsertUiSnapshot.mockImplementation(() => {
        throw new Error('nope');
      });

      const response = await request(app)
        .post('/api/agent/ui/snapshot')
        .send({ projectId: 1, sessionId: 's1', tab: 'goals' });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to update UI snapshot' });

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('GET /api/agent/ui/snapshot', () => {
    test('rejects missing projectId/sessionId', async () => {
      const response = await request(app)
        .get('/api/agent/ui/snapshot')
        .query({ projectId: 1 });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'projectId and sessionId are required' });
    });

    test('returns stored snapshot', async () => {
      getUiSnapshot.mockReturnValue({ tab: 'files' });

      const response = await request(app)
        .get('/api/agent/ui/snapshot')
        .query({ projectId: 1, sessionId: 's1' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ tab: 'files' });
    });

    test('returns empty object when no snapshot exists', async () => {
      getUiSnapshot.mockReturnValue(undefined);

      const response = await request(app)
        .get('/api/agent/ui/snapshot')
        .query({ projectId: 1, sessionId: 's1' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({});
    });

    test('returns 500 when snapshot retrieval throws', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      getUiSnapshot.mockImplementation(() => {
        throw new Error('nope');
      });

      const response = await request(app)
        .get('/api/agent/ui/snapshot')
        .query({ projectId: 1, sessionId: 's1' });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to get UI snapshot' });

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('POST /api/agent/ui/commands', () => {
    test('rejects when body is missing (req.body fallback)', async () => {
      const response = await request(createApp(false))
        .post('/api/agent/ui/commands');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'projectId, sessionId, and command are required' });
    });

    test('rejects missing required fields', async () => {
      const response = await request(app)
        .post('/api/agent/ui/commands')
        .send({ projectId: 1, sessionId: 's1' });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'projectId, sessionId, and command are required' });
    });

    test('enqueues a command and returns success', async () => {
      const response = await request(app)
        .post('/api/agent/ui/commands')
        .send({ projectId: 1, sessionId: 's1', command: { type: 'toast', text: 'hi' } });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
      expect(enqueueUiCommand).toHaveBeenCalledWith(1, 's1', { type: 'toast', text: 'hi' });
    });

    test('returns 500 when enqueue throws', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      enqueueUiCommand.mockImplementation(() => {
        throw new Error('nope');
      });

      const response = await request(app)
        .post('/api/agent/ui/commands')
        .send({ projectId: 1, sessionId: 's1', command: { type: 'toast' } });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to enqueue UI command' });

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('GET /api/agent/ui/commands', () => {
    test('rejects missing projectId/sessionId', async () => {
      const response = await request(app)
        .get('/api/agent/ui/commands')
        .query({ projectId: 1 });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'projectId and sessionId are required' });
    });

    test('returns command list', async () => {
      listUiCommands.mockReturnValue([{ id: 'c1' }]);

      const response = await request(app)
        .get('/api/agent/ui/commands')
        .query({ projectId: 1, sessionId: 's1' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ commands: [{ id: 'c1' }] });
    });

    test('returns 500 when list throws', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      listUiCommands.mockImplementation(() => {
        throw new Error('nope');
      });

      const response = await request(app)
        .get('/api/agent/ui/commands')
        .query({ projectId: 1, sessionId: 's1' });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to list UI commands' });

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('POST /api/agent/ui/commands/ack', () => {
    test('rejects when body is missing (req.body fallback)', async () => {
      const response = await request(createApp(false))
        .post('/api/agent/ui/commands/ack');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'projectId, sessionId, and commandIds array are required' });
    });

    test('rejects missing commandIds array', async () => {
      const response = await request(app)
        .post('/api/agent/ui/commands/ack')
        .send({ projectId: 1, sessionId: 's1', commandIds: 'nope' });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'projectId, sessionId, and commandIds array are required' });
    });

    test('acknowledges command ids and returns success', async () => {
      const response = await request(app)
        .post('/api/agent/ui/commands/ack')
        .send({ projectId: 1, sessionId: 's1', commandIds: ['c1', 'c2'] });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true });
      expect(acknowledgeUiCommands).toHaveBeenCalledWith(1, 's1', ['c1', 'c2']);
    });

    test('returns 500 when ack throws', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      acknowledgeUiCommands.mockImplementation(() => {
        throw new Error('nope');
      });

      const response = await request(app)
        .post('/api/agent/ui/commands/ack')
        .send({ projectId: 1, sessionId: 's1', commandIds: ['c1'] });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to acknowledge UI commands' });

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('Autopilot route validation', () => {
    test('POST /api/agent/autopilot rejects missing projectId', async () => {
      const response = await request(app)
        .post('/api/agent/autopilot')
        .send({ prompt: 'Need a plan' });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'projectId is required' });
    });

    test('POST /api/agent/autopilot rejects missing prompt', async () => {
      const response = await request(app)
        .post('/api/agent/autopilot')
        .send({ projectId: 'proj-1' });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'prompt is required' });
    });

    test('GET /api/agent/autopilot/sessions/:sessionId rejects missing projectId', async () => {
      const response = await request(app)
        .get('/api/agent/autopilot/sessions/session-1');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'projectId is required' });
    });

    test('POST /api/agent/autopilot/sessions/:sessionId/messages rejects missing projectId', async () => {
      const response = await request(app)
        .post('/api/agent/autopilot/sessions/session-1/messages')
        .send({ message: 'hi' });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'projectId is required' });
    });

    test('POST /api/agent/autopilot/sessions/:sessionId/messages rejects missing message', async () => {
      const response = await request(app)
        .post('/api/agent/autopilot/sessions/session-1/messages')
        .send({ projectId: 'proj-1' });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'message is required' });
    });

    test('POST /api/agent/autopilot/sessions/:sessionId/cancel rejects missing projectId', async () => {
      const response = await request(app)
        .post('/api/agent/autopilot/sessions/session-1/cancel')
        .send({ reason: 'user' });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'projectId is required' });
    });

    test('POST /api/agent/autopilot/resume rejects missing projectId', async () => {
      const response = await request(app)
        .post('/api/agent/autopilot/resume')
        .send({ uiSessionId: 'ui-1' });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'projectId is required' });
    });

    test('POST /api/agent/autopilot/resume rejects missing uiSessionId', async () => {
      const response = await request(app)
        .post('/api/agent/autopilot/resume')
        .send({ projectId: 'proj-1' });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'uiSessionId is required' });
    });
  });

  describe('Autopilot route fallbacks with undefined body/query', () => {
    test('POST /api/agent/autopilot handles undefined body by treating it as empty object', async () => {
      const { status, json } = await invokeRoute('/autopilot', 'post');

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'projectId is required' });
    });

    test('GET /api/agent/autopilot/sessions/:sessionId handles undefined query by treating it as empty object', async () => {
      const { status, json } = await invokeRoute('/autopilot/sessions/:sessionId', 'get', {
        params: { sessionId: 'undefined-query' }
      });

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'projectId is required' });
    });

    test('POST /api/agent/autopilot/sessions/:sessionId/messages handles undefined body', async () => {
      const { status, json } = await invokeRoute('/autopilot/sessions/:sessionId/messages', 'post', {
        params: { sessionId: 'missing-body' }
      });

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'projectId is required' });
    });

    test('POST /api/agent/autopilot/sessions/:sessionId/cancel handles undefined body', async () => {
      const { status, json } = await invokeRoute('/autopilot/sessions/:sessionId/cancel', 'post', {
        params: { sessionId: 'missing-body' }
      });

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'projectId is required' });
    });

    test('POST /api/agent/autopilot/resume handles undefined body', async () => {
      const { status, json } = await invokeRoute('/autopilot/resume', 'post');

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'projectId is required' });
    });
  });

  describe('Autopilot routes success cases', () => {
    test('POST /api/agent/autopilot starts a session', async () => {
      const session = { id: 'session-123', projectId: 'proj-1' };
      createAutopilotSession.mockResolvedValue(session);

      const response = await request(app)
        .post('/api/agent/autopilot')
        .send({ projectId: 'proj-1', prompt: 'Ship it', options: { depth: 2 }, uiSessionId: 'ui-1' });

      expect(response.status).toBe(202);
      expect(response.body).toEqual({ success: true, session });
      expect(createAutopilotSession).toHaveBeenCalledWith({
        projectId: 'proj-1',
        prompt: 'Ship it',
        options: { depth: 2 },
        uiSessionId: 'ui-1'
      });
    });

    test('GET /api/agent/autopilot/sessions/:sessionId returns session when project matches', async () => {
      const session = { id: 'session-1', projectId: 'proj-1', state: 'running' };
      getAutopilotSession.mockReturnValue(session);

      const response = await request(app)
        .get('/api/agent/autopilot/sessions/session-1')
        .query({ projectId: 'proj-1' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true, session });
    });

    test('GET /api/agent/autopilot/sessions/:sessionId returns 404 when project mismatches', async () => {
      const session = { id: 'session-1', projectId: 'proj-2' };
      getAutopilotSession.mockReturnValue(session);

      const response = await request(app)
        .get('/api/agent/autopilot/sessions/session-1')
        .query({ projectId: 'proj-1' });

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Autopilot session not found' });
    });

    test('POST /api/agent/autopilot/sessions/:sessionId/messages enqueues message', async () => {
      const session = { id: 'session-99', latestMessage: 'Hello' };
      enqueueAutopilotSessionMessage.mockReturnValue(session);

      const response = await request(app)
        .post('/api/agent/autopilot/sessions/session-99/messages')
        .send({ projectId: 'proj-9', message: 'Hi', kind: 'user', metadata: { foo: 'bar' } });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true, session });
      expect(enqueueAutopilotSessionMessage).toHaveBeenCalledWith({
        sessionId: 'session-99',
        projectId: 'proj-9',
        message: 'Hi',
        kind: 'user',
        metadata: { foo: 'bar' }
      });
    });

    test('POST /api/agent/autopilot/sessions/:sessionId/messages returns 404 when session is missing', async () => {
      const notFoundError = new Error('missing');
      notFoundError.code = AutopilotSessionErrorCodes.NOT_FOUND;
      enqueueAutopilotSessionMessage.mockImplementation(() => {
        throw notFoundError;
      });

      const response = await request(app)
        .post('/api/agent/autopilot/sessions/session-404/messages')
        .send({ projectId: 'proj-9', message: 'Hi again' });

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Autopilot session not found' });
    });

    test('POST /api/agent/autopilot/sessions/:sessionId/cancel returns session metadata', async () => {
      const session = { id: 'session-4', status: 'cancelling' };
      cancelAutopilotSession.mockReturnValue(session);

      const response = await request(app)
        .post('/api/agent/autopilot/sessions/session-4/cancel')
        .send({ projectId: 'proj-4', reason: 'user-request' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true, session });
      expect(cancelAutopilotSession).toHaveBeenCalledWith({
        sessionId: 'session-4',
        projectId: 'proj-4',
        reason: 'user-request'
      });
    });

    test('POST /api/agent/autopilot/sessions/:sessionId/cancel returns 404 for missing session', async () => {
      const notFoundError = new Error('missing');
      notFoundError.code = AutopilotSessionErrorCodes.NOT_FOUND;
      cancelAutopilotSession.mockImplementation(() => {
        throw notFoundError;
      });

      const response = await request(app)
        .post('/api/agent/autopilot/sessions/session-404/cancel')
        .send({ projectId: 'proj-4' });

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Autopilot session not found' });
    });

    test('POST /api/agent/autopilot/resume resumes sessions', async () => {
      const resumeResult = { success: true, resumedSessionIds: ['session-1'] };
      resumeAutopilotSessions.mockReturnValue(resumeResult);

      const response = await request(app)
        .post('/api/agent/autopilot/resume')
        .send({ projectId: 'proj-1', uiSessionId: 'ui-1', limit: 3 });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(resumeResult);
      expect(resumeAutopilotSessions).toHaveBeenCalledWith({
        projectId: 'proj-1',
        uiSessionId: 'ui-1',
        limit: 3
      });
    });
  });

  describe('Autopilot routes error handling', () => {
    test('POST /api/agent/autopilot surfaces server errors', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      createAutopilotSession.mockRejectedValue(new Error('planner offline'));

      const response = await request(app)
        .post('/api/agent/autopilot')
        .send({ projectId: 'proj-1', prompt: 'Ship it' });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Failed to start autopilot session',
        details: 'planner offline'
      });

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    test('POST /api/agent/autopilot falls back to Unknown error when thrown value lacks message', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      createAutopilotSession.mockRejectedValue({});

      const response = await request(app)
        .post('/api/agent/autopilot')
        .send({ projectId: 'proj-1', prompt: 'Ship it' });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Failed to start autopilot session',
        details: 'Unknown error'
      });

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    test('GET /api/agent/autopilot/sessions/:sessionId returns 500 when retrieval fails', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      getAutopilotSession.mockImplementation(() => {
        throw new Error('db exploded');
      });

      const response = await request(app)
        .get('/api/agent/autopilot/sessions/session-1')
        .query({ projectId: 'proj-1' });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Failed to fetch autopilot session',
        details: 'db exploded'
      });

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    test('GET /api/agent/autopilot/sessions/:sessionId falls back to Unknown error when retrieval throws without message', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      getAutopilotSession.mockImplementation(() => {
        const err = {};
        throw err;
      });

      const response = await request(app)
        .get('/api/agent/autopilot/sessions/session-1')
        .query({ projectId: 'proj-1' });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Failed to fetch autopilot session',
        details: 'Unknown error'
      });

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    test('POST /api/agent/autopilot/sessions/:sessionId/messages returns 500 when enqueue fails', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      enqueueAutopilotSessionMessage.mockImplementation(() => {
        throw new Error('queue down');
      });

      const response = await request(app)
        .post('/api/agent/autopilot/sessions/session-1/messages')
        .send({ projectId: 'proj-1', message: 'Hello world' });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Failed to enqueue autopilot message',
        details: 'queue down'
      });

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    test('POST /api/agent/autopilot/sessions/:sessionId/messages falls back to Unknown error when enqueue throws without message', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      enqueueAutopilotSessionMessage.mockImplementation(() => {
        throw {};
      });

      const response = await request(app)
        .post('/api/agent/autopilot/sessions/session-1/messages')
        .send({ projectId: 'proj-1', message: 'Hello world' });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Failed to enqueue autopilot message',
        details: 'Unknown error'
      });

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    test('POST /api/agent/autopilot/sessions/:sessionId/cancel returns 500 when cancel fails', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      cancelAutopilotSession.mockImplementation(() => {
        throw new Error('cancellation blocked');
      });

      const response = await request(app)
        .post('/api/agent/autopilot/sessions/session-1/cancel')
        .send({ projectId: 'proj-1', reason: 'user-request' });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Failed to cancel autopilot session',
        details: 'cancellation blocked'
      });

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    test('POST /api/agent/autopilot/sessions/:sessionId/cancel falls back to Unknown error when cancel throws without message', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      cancelAutopilotSession.mockImplementation(() => {
        throw {};
      });

      const response = await request(app)
        .post('/api/agent/autopilot/sessions/session-1/cancel')
        .send({ projectId: 'proj-1', reason: 'user-request' });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Failed to cancel autopilot session',
        details: 'Unknown error'
      });

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    test('POST /api/agent/autopilot/resume returns 500 when resume fails', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      resumeAutopilotSessions.mockImplementation(() => {
        throw new Error('resume boom');
      });

      const response = await request(app)
        .post('/api/agent/autopilot/resume')
        .send({ projectId: 'proj-1', uiSessionId: 'ui-1' });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Failed to resume autopilot sessions',
        details: 'resume boom'
      });

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    test('POST /api/agent/autopilot/resume falls back to Unknown error when resume throws without message', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      resumeAutopilotSessions.mockImplementation(() => {
        throw {};
      });

      const response = await request(app)
        .post('/api/agent/autopilot/resume')
        .send({ projectId: 'proj-1', uiSessionId: 'ui-1' });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Failed to resume autopilot sessions',
        details: 'Unknown error'
      });

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });
});
