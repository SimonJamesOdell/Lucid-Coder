import { afterEach, describe, expect, test, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const loadStreamRouter = async () => {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'development');

  vi.doMock('../services/agentRequestHandler.js', () => ({
    handleAgentRequest: vi.fn()
  }));
  vi.doMock('../services/agentOrchestrator.js', () => ({
    planGoalFromPrompt: vi.fn(),
    createChildGoal: vi.fn()
  }));
  vi.doMock('../services/branchWorkflow.js', () => ({
    runTestsForBranch: vi.fn()
  }));
  vi.doMock('../services/agentUiState.js', () => ({
    acknowledgeUiCommands: vi.fn(),
    enqueueUiCommand: vi.fn(),
    getUiSnapshot: vi.fn(),
    listUiCommands: vi.fn(),
    upsertUiSnapshot: vi.fn()
  }));
  vi.doMock('../services/autopilotSessions.js', () => ({
    AutopilotSessionErrorCodes: { NOT_FOUND: 'NOT_FOUND' },
    cancelAutopilotSession: vi.fn(),
    createAutopilotSession: vi.fn(),
    enqueueAutopilotSessionMessage: vi.fn(),
    getAutopilotSession: vi.fn(),
    resumeAutopilotSessions: vi.fn()
  }));

  const { default: agentRoutes } = await import('../routes/agent.js');
  const { handleAgentRequest } = await import('../services/agentRequestHandler.js');

  return { agentRoutes, handleAgentRequest };
};

describe('Agent stream coverage (dev mode)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('streams with delay and flushHeaders', async () => {
    const { agentRoutes, handleAgentRequest } = await loadStreamRouter();
    const app = express();
    app.use(express.json());
    app.use('/api/agent', agentRoutes);

    handleAgentRequest.mockResolvedValue({
      kind: 'question',
      answer: 'This answer is long enough to trigger delay between chunk events.'
    });

    const response = await request(app)
      .post('/api/agent/request/stream')
      .send({ projectId: 123, prompt: 'Do something' });

    expect(response.status).toBe(200);
    expect(response.text).toContain('event: chunk');
    expect(response.text).toContain('event: done');
  });
});