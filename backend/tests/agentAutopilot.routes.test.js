import { beforeEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../services/autopilotSessions.js', () => ({
  AutopilotSessionErrorCodes: { NOT_FOUND: 'AUTOPILOT_SESSION_NOT_FOUND' },
  cancelAutopilotSession: vi.fn(),
  createAutopilotSession: vi.fn(),
  enqueueAutopilotSessionMessage: vi.fn(),
  getAutopilotSession: vi.fn(),
  resumeAutopilotSessions: vi.fn()
}));

import agentRoutes from '../routes/agent.js';
import {
  AutopilotSessionErrorCodes,
  cancelAutopilotSession,
  createAutopilotSession,
  enqueueAutopilotSessionMessage,
  getAutopilotSession,
  resumeAutopilotSessions
} from '../services/autopilotSessions.js';

describe('Agent autopilot routes', () => {
  let app;

  const createApp = () => {
    const instance = express();
    instance.use(express.json());
    instance.use('/api/agent', agentRoutes);
    return instance;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  describe('POST /api/agent/autopilot', () => {
    test('rejects missing projectId or prompt', async () => {
      let response = await request(app)
        .post('/api/agent/autopilot')
        .send({ prompt: 'Do work' });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'projectId is required' });

      response = await request(app)
        .post('/api/agent/autopilot')
        .send({ projectId: 1 });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'prompt is required' });
    });

    test('returns 202 with session summary on success', async () => {
      createAutopilotSession.mockResolvedValue({ id: 'session-123' });

      const response = await request(app)
        .post('/api/agent/autopilot')
        .send({ projectId: 1, prompt: 'Automate me', options: { coverageThresholds: { lines: 80 } }, uiSessionId: 'ui-1' });

      expect(response.status).toBe(202);
      expect(response.body).toEqual({ success: true, session: { id: 'session-123' } });
      expect(createAutopilotSession).toHaveBeenCalledWith({
        projectId: 1,
        prompt: 'Automate me',
        options: { coverageThresholds: { lines: 80 } },
        uiSessionId: 'ui-1'
      });
    });

    test('returns 500 when service throws', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      createAutopilotSession.mockRejectedValue(new Error('boom'));

      const response = await request(app)
        .post('/api/agent/autopilot')
        .send({ projectId: 1, prompt: 'Automate me' });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Failed to start autopilot session');
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('GET /api/agent/autopilot/sessions/:sessionId', () => {
    test('requires projectId query param', async () => {
      const response = await request(app)
        .get('/api/agent/autopilot/sessions/abc');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'projectId is required' });
    });

    test('returns 404 when session missing', async () => {
      getAutopilotSession.mockReturnValue(null);

      const response = await request(app)
        .get('/api/agent/autopilot/sessions/abc')
        .query({ projectId: 1 });

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Autopilot session not found' });
    });

    test('returns session summary when found', async () => {
      getAutopilotSession.mockReturnValue({ id: 'abc', projectId: 1, status: 'running' });

      const response = await request(app)
        .get('/api/agent/autopilot/sessions/abc')
        .query({ projectId: 1 });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true, session: { id: 'abc', projectId: 1, status: 'running' } });
    });
  });

  describe('POST /api/agent/autopilot/sessions/:sessionId/messages', () => {
    test('validates request body', async () => {
      let response = await request(app)
        .post('/api/agent/autopilot/sessions/abc/messages')
        .send({ message: 'Hi' });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'projectId is required' });

      response = await request(app)
        .post('/api/agent/autopilot/sessions/abc/messages')
        .send({ projectId: 1 });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'message is required' });
    });

    test('returns 404 when service raises NOT_FOUND', async () => {
      enqueueAutopilotSessionMessage.mockImplementation(() => {
        const error = new Error('missing');
        error.code = AutopilotSessionErrorCodes.NOT_FOUND;
        throw error;
      });

      const response = await request(app)
        .post('/api/agent/autopilot/sessions/abc/messages')
        .send({ projectId: 1, message: 'Hello' });

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Autopilot session not found' });
    });

    test('returns updated session on success', async () => {
      enqueueAutopilotSessionMessage.mockReturnValue({ id: 'abc', events: [] });

      const response = await request(app)
        .post('/api/agent/autopilot/sessions/abc/messages')
        .send({ projectId: 1, message: 'Hello', kind: 'goal-update' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true, session: { id: 'abc', events: [] } });
      expect(enqueueAutopilotSessionMessage).toHaveBeenCalledWith({
        sessionId: 'abc',
        projectId: 1,
        message: 'Hello',
        kind: 'goal-update',
        metadata: undefined
      });
    });
  });

  describe('POST /api/agent/autopilot/sessions/:sessionId/cancel', () => {
    test('requires projectId', async () => {
      const response = await request(app)
        .post('/api/agent/autopilot/sessions/abc/cancel')
        .send({});
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'projectId is required' });
    });

    test('returns 404 when session missing', async () => {
      cancelAutopilotSession.mockImplementation(() => {
        const error = new Error('missing');
        error.code = AutopilotSessionErrorCodes.NOT_FOUND;
        throw error;
      });

      const response = await request(app)
        .post('/api/agent/autopilot/sessions/abc/cancel')
        .send({ projectId: 1 });

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Autopilot session not found' });
    });

    test('returns session summary when cancel acknowledged', async () => {
      cancelAutopilotSession.mockReturnValue({ id: 'abc', status: 'running' });

      const response = await request(app)
        .post('/api/agent/autopilot/sessions/abc/cancel')
        .send({ projectId: 1, reason: 'user request' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true, session: { id: 'abc', status: 'running' } });
      expect(cancelAutopilotSession).toHaveBeenCalledWith({ sessionId: 'abc', projectId: 1, reason: 'user request' });
    });
  });

  describe('POST /api/agent/autopilot/resume', () => {
    test('validates required fields', async () => {
      let response = await request(app)
        .post('/api/agent/autopilot/resume')
        .send({ uiSessionId: 'ui-1' });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'projectId is required' });

      response = await request(app)
        .post('/api/agent/autopilot/resume')
        .send({ projectId: 1 });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'uiSessionId is required' });
    });

    test('returns resume payload on success', async () => {
      resumeAutopilotSessions.mockReturnValue({ success: true, resumed: [] });

      const response = await request(app)
        .post('/api/agent/autopilot/resume')
        .send({ projectId: 1, uiSessionId: 'ui-1', limit: 3 });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true, resumed: [] });
      expect(resumeAutopilotSessions).toHaveBeenCalledWith({ projectId: 1, uiSessionId: 'ui-1', limit: 3 });
    });
  });
});
