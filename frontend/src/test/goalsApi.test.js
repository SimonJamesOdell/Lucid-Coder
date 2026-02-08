import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import {
  fetchGoals,
  fetchGoalWithTasks,
  createGoal,
  deleteGoal,
  advanceGoalPhase,
  recordGoalTestRun,
  runGoalTests,
  createMetaGoalWithChildren,
  planMetaGoal,
  agentRequest,
  agentAutopilot,
  agentAutopilotStatus,
  agentAutopilotMessage,
  agentAutopilotCancel,
  agentAutopilotResume,
  agentRequestStream,
  agentCleanupStream
} from '../utils/goalsApi.js';

describe('goalsApi', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('fetchGoals calls /api/goals with projectId and returns goals array', async () => {
    axios.get.mockResolvedValue({ data: { goals: [{ id: 1 }, { id: 2 }] } });

    const goals = await fetchGoals(123);

    expect(axios.get).toHaveBeenCalledWith('/api/goals', { params: { projectId: 123 } });
    expect(goals).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('fetchGoals can include archived goals when requested', async () => {
    axios.get.mockResolvedValue({ data: { goals: [] } });

    await fetchGoals(123, { includeArchived: true });

    expect(axios.get).toHaveBeenCalledWith('/api/goals', { params: { projectId: 123, includeArchived: 1 } });
  });

  it('fetchGoalWithTasks fetches a goal by id', async () => {
    await expect(fetchGoalWithTasks()).rejects.toThrow('goalId is required');

    axios.get.mockResolvedValueOnce({
      data: { id: 5, tasks: [{ id: 9 }] },
    });

    const goal = await fetchGoalWithTasks(5);
    expect(goal).toEqual({ id: 5, tasks: [{ id: 9 }] });
    expect(axios.get).toHaveBeenCalledWith('/api/goals/5');
  });

  it('createGoal posts prompt and projectId and returns goal payload', async () => {
    const backendResponse = {
      goal: { id: 5, projectId: 7, prompt: 'Build a todo system' },
      tasks: [{ id: 1, type: 'analysis' }]
    };
    axios.post.mockResolvedValue({ data: backendResponse });

    const result = await createGoal(7, 'Build a todo system');

    expect(axios.post).toHaveBeenCalledWith('/api/goals', {
      projectId: 7,
      prompt: 'Build a todo system'
    });
    expect(result).toBe(backendResponse);
  });

  it('deleteGoal deletes a goal by id and returns payload', async () => {
    await expect(deleteGoal()).rejects.toThrow('goalId is required');

    const backendResponse = { ok: true, deletedGoalId: 9 };
    axios.delete.mockResolvedValueOnce({ data: backendResponse });

    const result = await deleteGoal(9);

    expect(axios.delete).toHaveBeenCalledWith('/api/goals/9');
    expect(result).toBe(backendResponse);
  });

  it('advanceGoalPhase posts target phase and metadata and returns updated goal', async () => {
    const updatedGoal = { id: 9, status: 'testing' };
    axios.post.mockResolvedValue({ data: updatedGoal });

    const result = await advanceGoalPhase(9, 'testing', { note: 'Wrote failing tests' });

    expect(axios.post).toHaveBeenCalledWith('/api/goals/9/phase', {
      phase: 'testing',
      metadata: { note: 'Wrote failing tests' }
    });
    expect(result).toBe(updatedGoal);
  });

  it('recordGoalTestRun posts to tests endpoint and returns task', async () => {
    const task = { id: 3, type: 'test-run', status: 'failed' };
    axios.post.mockResolvedValue({ data: task });

    const payload = { status: 'failed', summary: 'Tests failed', logs: ['1 failing'] };
    const result = await recordGoalTestRun(11, payload);

    expect(axios.post).toHaveBeenCalledWith('/api/goals/11/tests', payload);
    expect(result).toBe(task);
  });

  it('runGoalTests posts to run-tests endpoint and returns task', async () => {
    const task = { id: 4, type: 'test-run', status: 'passed' };
    axios.post.mockResolvedValue({ data: task });

    const payload = { cwd: '/repo', command: 'npm', args: ['test'] };
    const result = await runGoalTests(12, payload);

    expect(axios.post).toHaveBeenCalledWith('/api/goals/12/run-tests', payload);
    expect(result).toBe(task);
  });

  it('planMetaGoal posts to /api/goals/plan-from-prompt and returns parent and children', async () => {
    const backendResponse = {
      parent: { id: 1, projectId: 42, prompt: 'Build analytics dashboard' },
      children: [
        { id: 2, projectId: 42, parentGoalId: 1, prompt: 'Set up database schema' },
        { id: 3, projectId: 42, parentGoalId: 1, prompt: 'Create API endpoints' }
      ]
    };
    axios.post.mockResolvedValue({ data: backendResponse });

    const payload = {
      projectId: 42,
      prompt: 'Build analytics dashboard'
    };

    const result = await planMetaGoal(payload);

    expect(axios.post).toHaveBeenCalledWith('/api/goals/plan-from-prompt', payload);
    expect(result).toBe(backendResponse);
  });

  it('createMetaGoalWithChildren posts to /api/goals/plan and returns parent + children', async () => {
    const backendResponse = {
      parent: { id: 1, projectId: 42, prompt: 'Fix failing tests' },
      children: [{ id: 2, projectId: 42, parentGoalId: 1, prompt: 'Fix failing frontend tests' }]
    };
    axios.post.mockResolvedValue({ data: backendResponse });

    const payload = {
      projectId: 42,
      prompt: 'Fix failing tests',
      childPrompts: ['Fix failing frontend tests']
    };

    const result = await createMetaGoalWithChildren(payload);

    expect(axios.post).toHaveBeenCalledWith('/api/goals/plan', payload);
    expect(result).toBe(backendResponse);
  });

  it('createMetaGoalWithChildren validates required inputs', async () => {
    await expect(createMetaGoalWithChildren({ prompt: 'Fix tests', childPrompts: [] }))
      .rejects.toThrow('projectId is required');
    await expect(createMetaGoalWithChildren({ projectId: 1, childPrompts: [] }))
      .rejects.toThrow('prompt is required');
    await expect(createMetaGoalWithChildren({ projectId: 1, prompt: 'Fix tests', childPrompts: 'nope' }))
      .rejects.toThrow('childPrompts must be an array');
  });

  it('agentRequest posts to /api/agent/request and returns decision payload', async () => {
    const backendResponse = {
      kind: 'feature',
      parent: { id: 10, projectId: 99, prompt: 'Build ecommerce site' },
      children: []
    };
    axios.post.mockResolvedValue({ data: backendResponse });

    const payload = {
      projectId: 99,
      prompt: 'Build an ecommerce site.'
    };

    const result = await agentRequest(payload);

    expect(axios.post).toHaveBeenCalledWith('/api/agent/request', payload);
    expect(result).toBe(backendResponse);
  });

  it('agentAutopilot requires projectId + prompt and posts to /api/agent/autopilot', async () => {
    await expect(agentAutopilot({ projectId: 'proj-1' })).rejects.toThrow('prompt is required');
    await expect(agentAutopilot({ prompt: 'Assist' })).rejects.toThrow('projectId is required');

    const mockedResponse = { data: { ok: true } };
    axios.post.mockResolvedValueOnce(mockedResponse);
    const result = await agentAutopilot({ projectId: 'proj-1', prompt: 'Assist', options: { coverageThresholds: { lines: 100 } } });

    expect(axios.post).toHaveBeenCalledWith('/api/agent/autopilot', {
      projectId: 'proj-1',
      prompt: 'Assist',
      options: { coverageThresholds: { lines: 100 } }
    });
    expect(result).toEqual({ ok: true });
  });

  it('agentAutopilot defaults options to {} when omitted', async () => {
    axios.post.mockResolvedValueOnce({ data: { ok: true } });

    const result = await agentAutopilot({ projectId: 'proj-1', prompt: 'Assist' });

    expect(axios.post).toHaveBeenCalledWith('/api/agent/autopilot', {
      projectId: 'proj-1',
      prompt: 'Assist',
      options: {}
    });
    expect(result).toEqual({ ok: true });
  });

  it('agentAutopilot includes uiSessionId when available and trims it', async () => {
    axios.post.mockResolvedValueOnce({ data: { ok: true } });

    const key = 'lucidcoder.uiSessionId';
    const originalValue = window.sessionStorage.getItem(key);
    window.sessionStorage.setItem(key, '  ui-session-123  ');

    try {
      const result = await agentAutopilot({ projectId: 'proj-1', prompt: 'Assist' });

      expect(axios.post).toHaveBeenCalledWith('/api/agent/autopilot', {
        projectId: 'proj-1',
        prompt: 'Assist',
        options: {},
        uiSessionId: 'ui-session-123'
      });
      expect(result).toEqual({ ok: true });
    } finally {
      if (originalValue === null) {
        window.sessionStorage.removeItem(key);
      } else {
        window.sessionStorage.setItem(key, originalValue);
      }
    }
  });

  it('agentRequestStream emits chunk/done/error events and parses event names', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'event: chunk\n',
      'data: {"text":"Hello"}\n\n',
      'event: done\n',
      'data: {"result":{"kind":"question"}}\n\n',
      'event: error\n',
      'data: {}\n\n'
    ];

    const stream = new ReadableStream({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
        controller.close();
      }
    });

    fetch.mockResolvedValue({ ok: true, status: 200, body: stream });

    const receivedChunks = [];
    const completed = [];
    const errors = [];

    await agentRequestStream({
      projectId: 'proj-1',
      prompt: 'Hello',
      onChunk: (text) => receivedChunks.push(text),
      onComplete: (result) => completed.push(result),
      onError: (message) => errors.push(message)
    });

    expect(receivedChunks).toEqual(['Hello']);
    expect(completed).toEqual([{ kind: 'question' }]);
    expect(errors).toEqual(['Agent request failed']);
  });

  it('agentCleanupStream throws when the response is not ok or has no body', async () => {
    fetch.mockResolvedValueOnce({ ok: false, status: 500, body: null });
    await expect(agentCleanupStream({ projectId: 'p1' })).rejects.toThrow('Cleanup stream failed (500)');

    fetch.mockResolvedValueOnce({ ok: true, status: 200, body: null });
    await expect(agentCleanupStream({ projectId: 'p1' })).rejects.toThrow('Cleanup stream failed (200)');
  });

  it('agentCleanupStream emits onEvent/onDone/onError and falls back to text payload for non-JSON data', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      // No data → ignored.
      'event: status\n\n',
      // Non-JSON data → { text: data } payload.
      'event: status\n',
      'data: hello\n\n',
      // JSON data
      'event: message\n',
      'data: {"ok":true}\n\n',
      'event: done\n',
      'data: {"result":{"status":"complete"}}\n\n',
      'event: error\n',
      'data: {}\n\n'
    ];

    const stream = new ReadableStream({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
        controller.close();
      }
    });

    fetch.mockResolvedValueOnce({ ok: true, status: 200, body: stream });

    const events = [];
    const done = [];
    const errors = [];

    await agentCleanupStream({
      projectId: 'proj-1',
      onEvent: (name, payload) => events.push({ name, payload }),
      onDone: (result) => done.push(result),
      onError: (message) => errors.push(message)
    });

    expect(events).toEqual(
      expect.arrayContaining([
        { name: 'status', payload: { text: 'hello' } },
        { name: 'message', payload: { ok: true } }
      ])
    );
    expect(done).toEqual([{ status: 'complete' }]);
    expect(errors).toEqual(['Cleanup failed']);
  });

  it('agentCleanupStream handles empty event names and buffered delimiter parsing', async () => {
    const encoder = new TextEncoder();
    const payload =
      'event:\n' +
      'data: null\n\n' +
      'event: done\n' +
      'data: {"result":{"ok":true}}\n\n';

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(payload));
        controller.close();
      }
    });

    const originalDecoder = global.TextDecoder;
    class BufferedDecoder {
      constructor() {
        this.chunks = [];
      }
      decode(value, options) {
        if (value) {
          this.chunks.push(Buffer.from(value).toString('utf-8'));
        }
        if (options?.stream) {
          return '';
        }
        return this.chunks.join('');
      }
    }
    global.TextDecoder = BufferedDecoder;

    fetch.mockResolvedValueOnce({ ok: true, status: 200, body: stream });

    const events = [];
    const done = [];

    await agentCleanupStream({
      projectId: 'proj-1',
      onEvent: (name, data) => events.push({ name, data }),
      onDone: (result) => done.push(result)
    });

    expect(events).toEqual([{ name: 'message', data: {} }]);
    expect(done).toEqual([{ ok: true }]);

    global.TextDecoder = originalDecoder;
  });

  it('agentRequestStream parses a trailing event block without a delimiter', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'event: done\n',
      'data: {"result":{"kind":"question","answer":"ok"}}'
    ];

    const stream = new ReadableStream({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
        controller.close();
      }
    });

    fetch.mockResolvedValue({ ok: true, status: 200, body: stream });

    const completed = [];

    await agentRequestStream({
      projectId: 'proj-1',
      prompt: 'Hello',
      onComplete: (result) => completed.push(result)
    });

    expect(completed).toEqual([{ kind: 'question', answer: 'ok' }]);
  });

  it('agentRequestStream parses multiple events from the trailing buffer', async () => {
    const encoder = new TextEncoder();
    const payload =
      'event: chunk\n' +
      'data: {"text":"Hello"}\n\n' +
      'event: done\n' +
      'data: {"result":{"kind":"question","answer":"ok"}}\n\n';

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(payload));
        controller.close();
      }
    });

    fetch.mockResolvedValue({ ok: true, status: 200, body: stream });

    const receivedChunks = [];
    const completed = [];

    const originalDecoder = globalThis.TextDecoder;
    class BufferedDecoder {
      constructor() {
        this.buffer = '';
      }

      decode(value, options = {}) {
        if (value) {
          this.buffer += originalDecoder.prototype.decode.call(new originalDecoder(), value, options);
        }
        if (options?.stream) {
          return '';
        }
        const output = this.buffer;
        this.buffer = '';
        return output;
      }
    }

    globalThis.TextDecoder = BufferedDecoder;

    try {
      await agentRequestStream({
        projectId: 'proj-1',
        prompt: 'Hello',
        onChunk: (text) => receivedChunks.push(text),
        onComplete: (result) => completed.push(result)
      });
    } finally {
      globalThis.TextDecoder = originalDecoder;
    }

    expect(receivedChunks).toEqual(['Hello']);
    expect(completed).toEqual([{ kind: 'question', answer: 'ok' }]);
  });

  it('agentAutopilot omits uiSessionId when stored value is only whitespace', async () => {
    axios.post.mockResolvedValueOnce({ data: { ok: true } });

    const key = 'lucidcoder.uiSessionId';
    const originalValue = window.sessionStorage.getItem(key);
    window.sessionStorage.setItem(key, '   ');

    try {
      const result = await agentAutopilot({ projectId: 'proj-1', prompt: 'Assist' });

      expect(axios.post).toHaveBeenCalledWith('/api/agent/autopilot', {
        projectId: 'proj-1',
        prompt: 'Assist',
        options: {}
      });
      expect(result).toEqual({ ok: true });
    } finally {
      if (originalValue === null) {
        window.sessionStorage.removeItem(key);
      } else {
        window.sessionStorage.setItem(key, originalValue);
      }
    }
  });

  it('agentAutopilot omits uiSessionId when window is unavailable', async () => {
    axios.post.mockResolvedValueOnce({ data: { ok: true } });

    const originalWindow = globalThis.window;
    try {
      globalThis.window = undefined;
      const result = await agentAutopilot({ projectId: 'proj-1', prompt: 'Assist' });

      expect(axios.post).toHaveBeenCalledWith('/api/agent/autopilot', {
        projectId: 'proj-1',
        prompt: 'Assist',
        options: {}
      });
      expect(result).toEqual({ ok: true });
    } finally {
      globalThis.window = originalWindow;
    }
  });

  it('agentAutopilot omits uiSessionId when sessionStorage access throws', async () => {
    axios.post.mockResolvedValueOnce({ data: { ok: true } });

    const getItemSpy = vi.spyOn(window.sessionStorage, 'getItem');
    getItemSpy.mockImplementation(() => {
      throw new Error('storage failed');
    });

    try {
      const result = await agentAutopilot({ projectId: 'proj-1', prompt: 'Assist' });

      expect(axios.post).toHaveBeenCalledWith('/api/agent/autopilot', {
        projectId: 'proj-1',
        prompt: 'Assist',
        options: {}
      });
      expect(result).toEqual({ ok: true });
    } finally {
      getItemSpy.mockRestore();
    }
  });

  it('agentAutopilotStatus requires projectId + sessionId and calls status endpoint', async () => {
    await expect(agentAutopilotStatus({ projectId: 1 })).rejects.toThrow('sessionId is required');
    await expect(agentAutopilotStatus({ sessionId: 's1' })).rejects.toThrow('projectId is required');

    axios.get.mockResolvedValueOnce({ data: { status: 'running' } });
    const result = await agentAutopilotStatus({ projectId: 1, sessionId: 's1' });

    expect(axios.get).toHaveBeenCalledWith('/api/agent/autopilot/sessions/s1', { params: { projectId: 1 } });
    expect(result).toEqual({ status: 'running' });
  });

  it('agentAutopilotMessage requires fields and posts to messages endpoint', async () => {
    await expect(agentAutopilotMessage({ projectId: 1, sessionId: 's1' })).rejects.toThrow('message is required');
    await expect(agentAutopilotMessage({ projectId: 1, message: 'hi' })).rejects.toThrow('sessionId is required');
    await expect(agentAutopilotMessage({ sessionId: 's1', message: 'hi' })).rejects.toThrow('projectId is required');

    axios.post.mockResolvedValueOnce({ data: { queued: true, messageId: 1 } });
    const result = await agentAutopilotMessage({ projectId: 1, sessionId: 's1', message: 'Update goal' });

    expect(axios.post).toHaveBeenCalledWith('/api/agent/autopilot/sessions/s1/messages', {
      projectId: 1,
      message: 'Update goal'
    });
    expect(result).toEqual({ queued: true, messageId: 1 });

    axios.post.mockResolvedValueOnce({ data: { queued: true } });
    await agentAutopilotMessage({
      projectId: 1,
      sessionId: 's2',
      message: 'Pause please',
      kind: 'pause',
      metadata: { reason: 'tests failing' }
    });

    expect(axios.post).toHaveBeenLastCalledWith('/api/agent/autopilot/sessions/s2/messages', {
      projectId: 1,
      message: 'Pause please',
      kind: 'pause',
      metadata: { reason: 'tests failing' }
    });
  });

  it('agentAutopilotMessage ignores metadata that is not an object', async () => {
    axios.post.mockResolvedValueOnce({ data: { accepted: true } });

    const payload = { projectId: 2, sessionId: 'meta', message: 'hello', metadata: 'nope' };
    const data = await agentAutopilotMessage(payload);

    expect(axios.post).toHaveBeenCalledWith('/api/agent/autopilot/sessions/meta/messages', {
      projectId: 2,
      message: 'hello'
    });
    expect(data).toEqual({ accepted: true });
  });

  it('agentAutopilotCancel requires fields and posts to cancel endpoint', async () => {
    await expect(agentAutopilotCancel({ projectId: 1 })).rejects.toThrow('sessionId is required');
    await expect(agentAutopilotCancel({ sessionId: 's1' })).rejects.toThrow('projectId is required');

    axios.post.mockResolvedValueOnce({ data: { cancelled: true } });
    const result = await agentAutopilotCancel({ projectId: 1, sessionId: 's1', reason: 'user' });

    expect(axios.post).toHaveBeenCalledWith('/api/agent/autopilot/sessions/s1/cancel', {
      projectId: 1,
      reason: 'user'
    });
    expect(result).toEqual({ cancelled: true });
  });

  it('agentAutopilotCancel omits reason when not provided', async () => {
    axios.post.mockResolvedValueOnce({ data: { cancelled: true } });

    await agentAutopilotCancel({ projectId: 3, sessionId: 's4' });

    expect(axios.post).toHaveBeenCalledWith('/api/agent/autopilot/sessions/s4/cancel', {
      projectId: 3
    });
  });

  it('agentAutopilotResume requires parameters and posts to resume endpoint', async () => {
    await expect(agentAutopilotResume({ uiSessionId: 'ui-1' })).rejects.toThrow('projectId is required');
    await expect(agentAutopilotResume({ projectId: 1 })).rejects.toThrow('uiSessionId is required');

    axios.post.mockResolvedValueOnce({ data: { success: true, resumed: [] } });
    const payload = await agentAutopilotResume({ projectId: 1, uiSessionId: 'ui-1', limit: 2 });

    expect(axios.post).toHaveBeenCalledWith('/api/agent/autopilot/resume', {
      projectId: 1,
      uiSessionId: 'ui-1',
      limit: 2
    });
    expect(payload).toEqual({ success: true, resumed: [] });
  });

  it('agentAutopilotResume falls back to default limit when value is invalid', async () => {
    axios.post.mockResolvedValueOnce({ data: { success: true } });

    await agentAutopilotResume({ projectId: 5, uiSessionId: 'ui-5', limit: 'invalid' });

    expect(axios.post).toHaveBeenCalledWith('/api/agent/autopilot/resume', {
      projectId: 5,
      uiSessionId: 'ui-5',
      limit: 5
    });
  });
});
