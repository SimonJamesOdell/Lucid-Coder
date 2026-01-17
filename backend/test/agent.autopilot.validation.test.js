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

const createApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/agent', agentRoutes);
  return app;
};

describe('Agent autopilot validation (unit suite)', () => {
  let app;

  beforeEach(() => {
    app = createApp();
  });

  test('POST /api/agent/autopilot requires projectId', async () => {
    const response = await request(app)
      .post('/api/agent/autopilot')
      .send({ prompt: 'Plan work' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'projectId is required' });
  });

  test('POST /api/agent/autopilot requires prompt text', async () => {
    const response = await request(app)
      .post('/api/agent/autopilot')
      .send({ projectId: 'proj-1' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'prompt is required' });
  });

  test('GET /api/agent/autopilot/sessions/:sessionId requires projectId query', async () => {
    const response = await request(app)
      .get('/api/agent/autopilot/sessions/session-1');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'projectId is required' });
  });

  test('POST /api/agent/autopilot/sessions/:sessionId/messages requires projectId', async () => {
    const response = await request(app)
      .post('/api/agent/autopilot/sessions/session-1/messages')
      .send({ message: 'Hello' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'projectId is required' });
  });

  test('POST /api/agent/autopilot/sessions/:sessionId/messages requires message text', async () => {
    const response = await request(app)
      .post('/api/agent/autopilot/sessions/session-1/messages')
      .send({ projectId: 'proj-1' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'message is required' });
  });

  test('POST /api/agent/autopilot/sessions/:sessionId/cancel requires projectId', async () => {
    const response = await request(app)
      .post('/api/agent/autopilot/sessions/session-1/cancel')
      .send({ reason: 'user' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'projectId is required' });
  });

  test('POST /api/agent/autopilot/resume requires projectId', async () => {
    const response = await request(app)
      .post('/api/agent/autopilot/resume')
      .send({ uiSessionId: 'ui-1' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'projectId is required' });
  });

  test('POST /api/agent/autopilot/resume requires uiSessionId', async () => {
    const response = await request(app)
      .post('/api/agent/autopilot/resume')
      .send({ projectId: 'proj-1' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'uiSessionId is required' });
  });
});
