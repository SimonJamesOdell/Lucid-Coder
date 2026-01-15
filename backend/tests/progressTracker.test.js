import { describe, test, expect, beforeEach, vi } from 'vitest';
import {
  initProgress,
  updateProgress,
  completeProgress,
  failProgress,
  buildProgressPayload,
  getProgressSnapshot,
  attachProgressStream,
  resetProgressStore,
  __testing
} from '../services/progressTracker.js';

const createMockResponse = () => {
  const handlers = new Map();
  let throwOnWrite = false;
  const response = {
    write: vi.fn(() => {
      if (throwOnWrite) {
        throw new Error('write failed');
      }
    }),
    end: vi.fn(),
    on: vi.fn((event, handler) => {
      handlers.set(event, handler);
    }),
    trigger: (event) => {
      const handler = handlers.get(event);
      if (handler) {
        handler();
      }
    }
  };
  response.status = vi.fn(() => response);
  response.enableThrowOnWrite = () => {
    throwOnWrite = true;
  };
  return response;
};

describe('progressTracker service', () => {
  beforeEach(() => {
    resetProgressStore();
  });

  test('initializes and updates progress snapshots', () => {
    initProgress('tracker-1', { statusMessage: 'Queued' });
    let snapshot = getProgressSnapshot('tracker-1');
    expect(snapshot).toBeDefined();
    expect(snapshot.statusMessage).toBe('Queued');

    updateProgress('tracker-1', {
      completion: 25,
      statusMessage: 'Directories created'
    });

    snapshot = getProgressSnapshot('tracker-1');
    expect(snapshot.completion).toBe(25);
    expect(snapshot.statusMessage).toBe('Directories created');
  });

  test('marks tracker as failed when requested', () => {
    initProgress('tracker-2');
    failProgress('tracker-2', 'Backend offline');
    const snapshot = getProgressSnapshot('tracker-2');
    expect(snapshot.status).toBe('failed');
    expect(snapshot.error).toBe('Backend offline');
  });

  test('streams updates to attached clients', () => {
    initProgress('tracker-3');
    const res = createMockResponse();
    attachProgressStream('tracker-3', res);

    expect(res.write).toHaveBeenCalled();

    updateProgress('tracker-3', { statusMessage: 'Streaming update', completion: 50 });
    expect(res.write).toHaveBeenCalledWith(expect.stringContaining('Streaming update'));

    res.trigger('close');
    expect(res.end).not.toHaveBeenCalled();
  });

  test('completeProgress marks 100% and schedules cleanup', () => {
    initProgress('tracker-4', { status: 'in-progress' });
    const snapshot = completeProgress('tracker-4', 'All done');

    expect(snapshot.status).toBe('completed');
    expect(snapshot.completion).toBe(100);
    expect(snapshot.statusMessage).toBe('All done');
  });

  test('buildProgressPayload derives completion from steps', () => {
    const payload = buildProgressPayload(3, 'processing', 'in-progress');
    expect(Array.isArray(payload.steps)).toBe(true);
    expect(payload.steps.length).toBeGreaterThan(0);
    expect(payload.statusMessage).toBe('processing');
    expect(payload.status).toBe('in-progress');
    expect(payload.completion).toBeGreaterThan(0);
  });

  test('returns null when tracker key is missing', () => {
    expect(initProgress()).toBeNull();
    expect(updateProgress()).toBeNull();
  });

  test('broadcast update no-ops when entry does not exist', () => {
    expect(() => __testing.broadcastUpdate('missing-tracker')).not.toThrow();
  });

  test('scheduleCleanup no-ops for unknown trackers', () => {
    expect(() => __testing.scheduleCleanup('ghost-cleanup')).not.toThrow();
    expect(getProgressSnapshot('ghost-cleanup')).toBeNull();
  });

  test('does not schedule cleanup while progress is in-progress', () => {
    initProgress('tracker-active', { status: 'in-progress' });
    const res = createMockResponse();
    attachProgressStream('tracker-active', res);

    res.trigger('close');

    expect(getProgressSnapshot('tracker-active')).not.toBeNull();
  });

  test('attachProgressStream responds with 400 when key is missing', () => {
    const res = createMockResponse();
    attachProgressStream(undefined, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.end).toHaveBeenCalled();
  });

  test('removes clients that throw during broadcasts', () => {
    initProgress('tracker-throw');
    const res = createMockResponse();
    attachProgressStream('tracker-throw', res);
    res.enableThrowOnWrite();

    expect(() => updateProgress('tracker-throw', { statusMessage: 'boom' })).not.toThrow();
    expect(res.end).toHaveBeenCalled();
  });

  test('completeProgress and failProgress create trackers when missing', () => {
    const completed = completeProgress('ghost-complete');
    expect(completed.status).toBe('completed');
    expect(completed.completion).toBe(100);

    const failed = failProgress('ghost-fail');
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('Project creation failed');
  });

  test('cleans up clients after retention period', () => {
    vi.useFakeTimers();
    const res = createMockResponse();
    initProgress('tracker-clean');
    attachProgressStream('tracker-clean', res);

    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    try {
      completeProgress('tracker-clean', 'done');
      failProgress('tracker-clean', 'retry later');

      expect(clearTimeoutSpy).toHaveBeenCalled();

      vi.runOnlyPendingTimers();

      expect(res.end).toHaveBeenCalled();
      expect(getProgressSnapshot('tracker-clean')).toBeNull();
    } finally {
      clearTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  test('resetProgressStore forces all clients to close', () => {
    initProgress('tracker-reset');
    const res = createMockResponse();
    attachProgressStream('tracker-reset', res);

    resetProgressStore();

    expect(res.end).toHaveBeenCalled();
    expect(getProgressSnapshot('tracker-reset')).toBeNull();
  });
});
