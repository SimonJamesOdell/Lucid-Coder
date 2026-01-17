import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../services/agentAutopilot.js', () => {
  const autopilotFeatureRequest = vi.fn(async () => ({ branchName: 'autopilot-default' }));
  return { autopilotFeatureRequest };
});

import {
  cancelAutopilotSession,
  createAutopilotSession,
  enqueueAutopilotSessionMessage,
  getAutopilotSession,
  resumeAutopilotSessions,
  __testing
} from '../services/autopilotSessions.js';
import { autopilotFeatureRequest } from '../services/agentAutopilot.js';

const wait = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

describe('autopilotSessions service', () => {
  beforeEach(() => {
    __testing.reset();
    autopilotFeatureRequest.mockReset();
    autopilotFeatureRequest.mockResolvedValue({ branchName: 'autopilot-default' });
  });

  test('createAutopilotSession enforces projectId and prompt', async () => {
    await expect(createAutopilotSession({ prompt: 'do things' })).rejects.toThrow('projectId is required');
    await expect(createAutopilotSession({ projectId: 1 })).rejects.toThrow('prompt is required');
  });

  test('createAutopilotSession normalizes ids, options, and uiSessionId', async () => {
    const circular = {};
    circular.self = circular;

    const session = await createAutopilotSession({
      projectId: 101,
      prompt: 'Normalize inputs',
      options: circular,
      uiSessionId: '   ',
      deps: {
        generateId: () => 0,
        now: () => '2024-02-02T00:00:00.000Z',
        autopilot: vi.fn(async () => undefined)
      }
    });

    expect(session.id).not.toBe('0');
    const internal = __testing.getSessionInternal(session.id);
    expect(internal.options).toEqual({});
    expect(internal.uiSessionId).toBeNull();
    await __testing.waitForSessionInternal(session.id);
    const stored = getAutopilotSession(session.id);
    expect(stored.result).toBeNull();
  });

  test('createAutopilotSession falls back when generator and clock are invalid', async () => {
    const session = await createAutopilotSession({
      projectId: 103,
      prompt: 'Fallback helpers',
      uiSessionId: 123,
      options: 5,
      deps: {
        generateId: 'not-fn',
        now: () => 123,
        autopilot: vi.fn(async () => ({ ok: true }))
      }
    });

    expect(session.id).toBeTruthy();
    const internal = __testing.getSessionInternal(session.id);
    expect(internal.uiSessionId).toBeNull();
    expect(internal.options).toEqual({});
  });

  test('createAutopilotSession starts worker and stores result', async () => {
    const autopilot = vi.fn(async ({ deps }) => {
      deps.reportStatus('working');
      deps.appendEvent({ type: 'custom', message: 'hello' });
      deps.appendEvent({ type: 'log' });
      deps.appendEvent();
      const circular = {};
      circular.self = circular;
      deps.appendEvent({ type: 5, message: 123, payload: true, meta: { ok: true } });
      deps.appendEvent({ type: 'note', message: 'circular', payload: circular });
      deps.ui.navigateTab(123);
      deps.ui.navigateTab(null);
      deps.ui.navigateTab('files');
      deps.shouldPause();
      return { branchName: 'feat/autopilot' };
    });

    const session = await createAutopilotSession({
      projectId: 42,
      prompt: 'Ship feature',
      deps: {
        autopilot,
        generateId: () => 'session-1',
        now: () => new Date('2024-01-01T00:00:00.000Z')
      }
    });

    expect(session.status).toBe('pending');

    await __testing.waitForSessionInternal('session-1');

    const stored = getAutopilotSession('session-1');
    expect(stored.status).toBe('completed');
    expect(stored.result).toEqual({ branchName: 'feat/autopilot' });
    expect(autopilot).toHaveBeenCalledTimes(1);
    expect(stored.events.some((event) => event.type === 'custom')).toBe(true);
    const fallbackEvent = stored.events.find((event) => event.message === '123');
    expect(fallbackEvent.type).toBe('log');
    expect(fallbackEvent.payload).toBe(true);
    const circularEvent = stored.events.find((event) => event.message === 'circular');
    expect(circularEvent.payload).toBeNull();
    const uiEvent = stored.events.find((event) => event.type === 'ui:navigate');
    expect(uiEvent.payload.tab).toBe('123');
    const navigateEvent = stored.events.find((event) => event.message === 'navigate');
    expect(navigateEvent.payload.tab).toBeNull();
  });

  test('createAutopilotSession trims event backlog and reports status changes once', async () => {
    const autopilot = vi.fn(async ({ deps }) => {
      deps.reportStatus(123);
      deps.reportStatus('');
      deps.reportStatus('Working');
      deps.reportStatus('Working');
      for (let i = 0; i < 505; i += 1) {
        deps.appendEvent({ type: 'log', message: `event-${i}` });
      }
      return { ok: true };
    });

    const session = await createAutopilotSession({
      projectId: 102,
      prompt: 'Trim events',
      deps: { autopilot, generateId: () => 'session-trim' }
    });

    await __testing.waitForSessionInternal(session.id);
    const stored = getAutopilotSession(session.id);
    expect(stored.eventsTrimmed).toBeGreaterThan(0);
    expect(stored.events.length).toBeLessThanOrEqual(500);
    const internal = __testing.getSessionInternal(session.id);
    expect(internal.statusMessage).toBe('Completed successfully');
  });

  test('createAutopilotSession uses default autopilot when deps do not provide one', async () => {
    autopilotFeatureRequest.mockResolvedValueOnce({ branchName: 'from-default' });

    const session = await createAutopilotSession({
      projectId: 88,
      prompt: 'Use default autopilot',
      deps: { generateId: () => 'session-default', now: () => new Date('2024-03-01T00:00:00.000Z') }
    });

    expect(session.status).toBe('pending');

    await __testing.waitForSessionInternal('session-default');
    const stored = getAutopilotSession('session-default');
    expect(stored.status).toBe('completed');
    expect(stored.result).toEqual({ branchName: 'from-default' });
    expect(autopilotFeatureRequest).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 88, prompt: 'Use default autopilot' })
    );
  });

  test('getAutopilotSession returns null for missing session ids', () => {
    const session = getAutopilotSession();
    expect(session).toBeNull();
  });

  test('enqueueAutopilotSessionMessage feeds consumeUserUpdates', async () => {
    const updates = [];
    const autopilot = vi.fn(async ({ deps }) => {
      await wait(20);
      updates.push(...deps.consumeUserUpdates());
      updates.push(...deps.consumeUserUpdates());
      return { done: true };
    });

    const session = await createAutopilotSession({
      projectId: 7,
      prompt: 'Iterate quickly',
      deps: { autopilot, generateId: () => 'session-updates' }
    });

    await wait(5);
    enqueueAutopilotSessionMessage({
      sessionId: session.id,
      projectId: 7,
      message: 'Refine acceptance criteria'
    });

    await __testing.waitForSessionInternal(session.id);

    expect(updates).toContain('Refine acceptance criteria');
    expect(updates.filter((update) => update === 'Refine acceptance criteria')).toHaveLength(1);
  });

  test('enqueueAutopilotSessionMessage stores metadata payload', async () => {
    const autopilot = vi.fn(async ({ deps }) => {
      await wait(5);
      deps.consumeUserUpdates();
      return { ok: true };
    });

    const session = await createAutopilotSession({
      projectId: 11,
      prompt: 'Metadata',
      deps: { autopilot, generateId: () => 'session-metadata' }
    });

    const circular = {};
    circular.self = circular;

    enqueueAutopilotSessionMessage({
      sessionId: session.id,
      projectId: 11,
      message: 'Add metadata',
      kind: 'goal-update',
      metadata: circular
    });

    const internal = __testing.getSessionInternal(session.id);
    expect(internal.control.pendingUpdates[0].metadata).toBeNull();
    await __testing.waitForSessionInternal(session.id);
  });

  test('enqueueAutopilotSessionMessage requires projectId', () => {
    expect(() => enqueueAutopilotSessionMessage({ sessionId: 'missing', message: 'Hi' })).toThrow(
      'projectId is required'
    );
  });

  test('enqueueAutopilotSessionMessage requires non-empty message', async () => {
    const session = await createAutopilotSession({
      projectId: 10,
      prompt: 'Validate messages',
      deps: { autopilot: vi.fn(async () => ({ ok: true })), generateId: () => 'session-messages' }
    });

    expect(() => enqueueAutopilotSessionMessage({ sessionId: session.id, projectId: 10, message: '   ' })).toThrow(
      'message is required'
    );
  });

  test('enqueueAutopilotSessionMessage enforces project ownership', async () => {
    const session = await createAutopilotSession({
      projectId: 'owner-1',
      prompt: 'Ownership',
      deps: { autopilot: vi.fn(async () => ({ ok: true })), generateId: () => 'session-owner' }
    });

    expect(() =>
      enqueueAutopilotSessionMessage({ sessionId: session.id, projectId: 'owner-2', message: 'Hello' })
    ).toThrow(/Autopilot session not found/);
  });

  test('enqueueAutopilotSessionMessage toggles pause, resume, and cancel flags', async () => {
    const blocker = vi.fn(async ({ deps }) => {
      while (!deps.shouldCancel()) {
        await wait();
      }
      throw Object.assign(new Error('cancelled'), { code: 'AUTOPILOT_CANCELLED' });
    });

    const session = await createAutopilotSession({
      projectId: 12,
      prompt: 'Toggle flags',
      deps: { autopilot: blocker, generateId: () => 'session-flags' }
    });

    const internal = __testing.getSessionInternal(session.id);

    enqueueAutopilotSessionMessage({ sessionId: session.id, projectId: 12, message: 'Pause please', kind: 'pause' });
    expect(internal.control.pauseRequested).toBe(true);

    enqueueAutopilotSessionMessage({ sessionId: session.id, projectId: 12, message: 'Resume now', kind: 'resume' });
    expect(internal.control.pauseRequested).toBe(false);

    enqueueAutopilotSessionMessage({ sessionId: session.id, projectId: 12, message: 'Cancel', kind: 'cancel' });
    expect(internal.control.cancelRequested).toBe(true);

    cancelAutopilotSession({ sessionId: session.id, projectId: 12 });
    await __testing.waitForSessionInternal(session.id);
  });

  test('autopilot cancellation uses default message when missing', async () => {
    const autopilot = vi.fn(async () => {
      throw { code: 'AUTOPILOT_CANCELLED' };
    });
    
    const session = await createAutopilotSession({
      projectId: 16,
      prompt: 'Cancel default message',
      deps: { autopilot, generateId: () => 'session-cancel-default' }
    });
    
    await __testing.waitForSessionInternal(session.id);
    const stored = getAutopilotSession(session.id);
    expect(stored.status).toBe('cancelled');
    const cancelEvent = stored.events.find((event) => event.type === 'session:cancelled');
    expect(cancelEvent.message).toBe('Autopilot cancelled');
  });

  test('startAutopilotWorker logs and marks session failed when worker crashes before starting', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const sessionPromise = createAutopilotSession({
      projectId: 66,
      prompt: 'Crash worker',
      deps: {
        generateId: () => 'session-crash',
        autopilot: vi.fn(async () => ({ ok: true }))
      }
    });

    const internal = __testing.getSessionInternal('session-crash');
    const originalPush = internal.events.push.bind(internal.events);
    internal.events.push = (...args) => {
      internal.events.push = originalPush;
      throw new Error('event queue broken');
    };

    await sessionPromise;
    await __testing.waitForSessionInternal('session-crash');
    const stored = getAutopilotSession('session-crash');
    expect(stored.status).toBe('failed');
    expect(stored.error).toBe('event queue broken');
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  test('startAutopilotWorker uses default crash message when error has no message', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const sessionPromise = createAutopilotSession({
      projectId: 67,
      prompt: 'Crash worker no message',
      deps: {
        generateId: () => 'session-crash-default',
        autopilot: vi.fn(async () => ({ ok: true }))
      }
    });

    const internal = __testing.getSessionInternal('session-crash-default');
    const originalPush = internal.events.push.bind(internal.events);
    internal.events.push = (...args) => {
      internal.events.push = originalPush;
      throw {};
    };

    await sessionPromise;
    await __testing.waitForSessionInternal('session-crash-default');
    const stored = getAutopilotSession('session-crash-default');
    expect(stored.status).toBe('failed');
    expect(stored.error).toBe('Autopilot worker crashed');
    consoleSpy.mockRestore();
  });
  test('resumeAutopilotSessions defaults limit when invalid', async () => {
    const releases = [];
    const autopilot = vi.fn(async () => {
      await new Promise((resolve) => {
        releases.push(resolve);
      });
      return { ok: true };
    });
    const sessionsToResume = [];
    for (let i = 0; i < 6; i += 1) {
      const session = await createAutopilotSession({
        projectId: 'proj-limit',
        prompt: `Session ${i}`,
        uiSessionId: 'ui-limit',
        deps: { autopilot, generateId: () => `session-limit-${i}` }
      });
      sessionsToResume.push(session);
    }

    while (releases.length < 6) {
      await wait(5);
    }

    const result = resumeAutopilotSessions({ projectId: 'proj-limit', uiSessionId: 'ui-limit', limit: 0 });
    expect(result.resumed).toHaveLength(5);

    releases.forEach((release) => release());
    await Promise.all(sessionsToResume.map((session) => __testing.waitForSessionInternal(session.id)));
  });
  test('waitForSessionInternal returns when no worker promise exists', async () => {
    const autopilot = vi.fn(async () => ({ ok: true }));
    const session = await createAutopilotSession({
      projectId: 502,
      prompt: 'No worker promise',
      deps: { autopilot, generateId: () => 'session-no-worker' }
    });

    await __testing.waitForSessionInternal(session.id);
    const internal = __testing.getSessionInternal(session.id);
    internal.status = 'completed';
    internal.control.workerPromise = null;

    const result = await __testing.waitForSessionInternal(session.id, 20);
    expect(result).toBeTruthy();
  });
  test('startAutopilotWorker returns null when running without a promise', async () => {
    const session = await createAutopilotSession({
      projectId: 602,
      prompt: 'Running no promise',
      deps: { autopilot: vi.fn(async () => ({ ok: true })), generateId: () => 'session-running-null' }
    });

    const internal = __testing.getSessionInternal(session.id);
    internal.control.running = true;
    internal.control.workerPromise = null;

    const result = __testing.startAutopilotWorker(internal);
    expect(result).toBeNull();
  });

  test('cancelAutopilotSession marks session as cancelled', async () => {
    let shouldStop = false;
    const autopilot = vi.fn(async ({ deps }) => {
      while (!shouldStop) {
        await wait(5);
        if (deps.shouldCancel()) {
          shouldStop = true;
          const error = new Error('cancelled');
          error.code = 'AUTOPILOT_CANCELLED';
          throw error;
        }
      }
    });

    const session = await createAutopilotSession({
      projectId: 9,
      prompt: 'Long running work',
      deps: { autopilot, generateId: () => 'session-cancel' }
    });

    await wait(10);
    const summary = cancelAutopilotSession({ sessionId: session.id, projectId: 9, reason: 'user request' });
    expect(summary.status).toBe('running');

    await __testing.waitForSessionInternal(session.id);
    const stored = getAutopilotSession(session.id);
    expect(stored.status).toBe('cancelled');
  });

  test('autopilot failure marks session cancelled when cancel requested', async () => {
    const autopilot = vi.fn(async () => {
      throw new Error('boom');
    });

    const session = await createAutopilotSession({
      projectId: 13,
      prompt: 'Cancel override',
      deps: { autopilot, generateId: () => 'session-cancelled' }
    });

    cancelAutopilotSession({ sessionId: session.id, projectId: 13 });
    await __testing.waitForSessionInternal(session.id);
    const stored = getAutopilotSession(session.id);
    expect(stored.status).toBe('cancelled');
  });

  test('autopilot failure uses default error message when missing', async () => {
    const autopilot = vi.fn(async () => {
      throw {};
    });

    const session = await createAutopilotSession({
      projectId: 14,
      prompt: 'Missing error message',
      deps: { autopilot, generateId: () => 'session-error-message' }
    });

    await __testing.waitForSessionInternal(session.id);
    const stored = getAutopilotSession(session.id);
    expect(stored.status).toBe('failed');
    expect(stored.error).toBe('Autopilot run failed');
  });

  test('cancelAutopilotSession requires projectId', () => {
    expect(() => cancelAutopilotSession({ sessionId: 'any' })).toThrow('projectId is required');
  });

  test('cancelAutopilotSession returns existing summary when session already terminal', async () => {
    const autopilot = vi.fn(async () => ({ done: true }));
    const session = await createAutopilotSession({
      projectId: 15,
      prompt: 'Already done',
      deps: { autopilot, generateId: () => 'session-terminal' }
    });

    await __testing.waitForSessionInternal(session.id);
    const summary = cancelAutopilotSession({ sessionId: session.id, projectId: 15 });
    expect(summary.status).toBe('completed');
    const stored = getAutopilotSession(session.id);
    expect(stored.status).toBe('completed');
  });

  test('enqueueAutopilotSessionMessage throws NOT_FOUND for unknown session', () => {
    expect(() => enqueueAutopilotSessionMessage({ sessionId: 'missing', projectId: 1, message: 'Hi' })).toThrowError(
      /Autopilot session not found/
    );
  });

  test('resumeAutopilotSessions returns active sessions for matching uiSessionId', async () => {
    let release;
    const autopilot = vi.fn(async () => {
      await new Promise((resolve) => {
        release = resolve;
      });
      return { ok: true };
    });

    const session = await createAutopilotSession({
      projectId: 'proj-1',
      prompt: 'Keep running',
      uiSessionId: 'ui-123',
      deps: { autopilot, generateId: () => 'session-resume' }
    });

    // Wait until the worker registers its async body so release is defined.
    while (typeof release !== 'function') {
      await wait(5);
    }

    const result = resumeAutopilotSessions({ projectId: 'proj-1', uiSessionId: 'ui-123', limit: 2 });
    expect(result.success).toBe(true);
    expect(result.resumed).toHaveLength(1);
    expect(result.resumed[0].id).toBe(session.id);

    release();
    await __testing.waitForSessionInternal(session.id);
  });

  test('waitForSessionInternal returns null when the session no longer exists', async () => {
    const result = await __testing.waitForSessionInternal('missing-session', 20);
    expect(result).toBeNull();
  });

  test('waitForSessionInternal ignores worker promise failures', async () => {
    const autopilot = vi.fn(async () => ({ ok: true }));
    const session = await createAutopilotSession({
      projectId: 501,
      prompt: 'Ignore worker errors',
      deps: { autopilot, generateId: () => 'session-worker-fail' }
    });

    await __testing.waitForSessionInternal(session.id);
    const internal = __testing.getSessionInternal(session.id);
    internal.status = 'completed';
    internal.control.workerPromise = Promise.reject(new Error('worker failed'));

    const result = await __testing.waitForSessionInternal(session.id, 20);
    expect(result).toBeTruthy();
  });

  test('waitForSessionInternal times out when the session never reaches a terminal status', async () => {
    let stopped = false;
    const autopilot = vi.fn(async ({ deps }) => {
      while (!deps.shouldCancel()) {
        await wait(25);
      }
      stopped = true;
      return { cancelled: true };
    });

    const session = await createAutopilotSession({
      projectId: 500,
      prompt: 'Never finish',
      deps: { autopilot, generateId: () => 'session-timeout' }
    });

    await expect(__testing.waitForSessionInternal(session.id, 30)).rejects.toThrow(
      'Timed out waiting for autopilot session to finish'
    );

    cancelAutopilotSession({ sessionId: session.id, projectId: 500 });
    await __testing.waitForSessionInternal(session.id);
    expect(stopped).toBe(true);
  });

  test('resumeAutopilotSessions requires projectId and uiSessionId', () => {
    expect(() => resumeAutopilotSessions({ uiSessionId: 'ui' })).toThrow('projectId is required');
    expect(() => resumeAutopilotSessions({ projectId: 'proj' })).toThrow('uiSessionId is required');
  });

  test('resumeAutopilotSessions filters by project/ui and restarts paused sessions', async () => {
    // Project mismatch
    await createAutopilotSession({
      projectId: 'proj-other',
      prompt: 'Different project',
      uiSessionId: 'ui-1',
      deps: { autopilot: vi.fn(async () => ({ ok: true })), generateId: () => 'session-other' }
    });

    // UI mismatch
    await createAutopilotSession({
      projectId: 'proj-1',
      prompt: 'Different ui',
      uiSessionId: 'ui-2',
      deps: { autopilot: vi.fn(async () => ({ ok: true })), generateId: () => 'session-ui-mismatch' }
    });

    // Completed session (not active)
    const completed = await createAutopilotSession({
      projectId: 'proj-1',
      prompt: 'Completed',
      uiSessionId: 'ui-1',
      deps: { autopilot: vi.fn(async () => ({ done: true })), generateId: () => 'session-completed' }
    });
    await __testing.waitForSessionInternal(completed.id);

    // Paused session needing restart
    const restart = await createAutopilotSession({
      projectId: 'proj-1',
      prompt: 'Restart me',
      uiSessionId: 'ui-1',
      deps: { autopilot: vi.fn(async () => ({ first: true })), generateId: () => 'session-restart' }
    });
    await __testing.waitForSessionInternal(restart.id);
    const internal = __testing.getSessionInternal(restart.id);
    const restartedAutopilot = vi.fn(async () => ({ rerun: true }));
    internal.status = 'paused';
    internal.control.running = false;
    internal.control.workerPromise = null;
    internal.control.autopilot = restartedAutopilot;

    const result = resumeAutopilotSessions({ projectId: 'proj-1', uiSessionId: 'ui-1', limit: 5 });
    expect(result.resumed).toHaveLength(1);
    expect(result.resumed[0].id).toBe(restart.id);

    await __testing.waitForSessionInternal(restart.id);
    expect(restartedAutopilot).toHaveBeenCalled();
  });

  test('startAutopilotWorker returns existing promise when running', async () => {
    const session = await createAutopilotSession({
      projectId: 601,
      prompt: 'Already running',
      deps: { autopilot: vi.fn(async () => ({ ok: true })), generateId: () => 'session-running' }
    });

    const internal = __testing.getSessionInternal(session.id);
    const existing = Promise.resolve('existing');
    internal.control.running = true;
    internal.control.workerPromise = existing;

    const result = __testing.startAutopilotWorker(internal);
    expect(result).toBe(existing);
  });
});
