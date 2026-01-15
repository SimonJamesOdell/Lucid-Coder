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

import agentRoutes from '../routes/agent.js';
import { handleAgentRequest } from '../services/agentRequestHandler.js';
import {
  acknowledgeUiCommands,
  enqueueUiCommand,
  getUiSnapshot,
  listUiCommands,
  upsertUiSnapshot
} from '../services/agentUiState.js';

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
});
