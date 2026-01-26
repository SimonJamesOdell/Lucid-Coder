import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../services/runStore.js', () => ({
  appendRunEvent: vi.fn(),
  createRun: vi.fn(),
  updateRun: vi.fn()
}));

import { createAutopilotSession, __testing as autopilotTesting } from '../services/autopilotSessions.js';
import * as runStore from '../services/runStore.js';

describe('autopilotSessions coverage (createRun missing id)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    autopilotTesting.reset();

    runStore.createRun.mockResolvedValue(null);
    runStore.appendRunEvent.mockResolvedValue({ id: 1 });
    runStore.updateRun.mockResolvedValue({ id: 1 });
  });

  afterEach(() => {
    autopilotTesting.reset();
  });

  it('skips run backfill when createRun returns null (covers runRecord?.id false branch)', async () => {
    const session = await createAutopilotSession({
      projectId: 1,
      prompt: 'Do the thing',
      deps: {
        generateId: () => 'session-missing-run',
        autopilot: async () => ({ ok: true })
      }
    });

    expect(runStore.createRun).toHaveBeenCalled();
    expect(session.runId).toBe(null);
    expect(runStore.appendRunEvent).not.toHaveBeenCalled();

    await autopilotTesting.waitForSessionInternal('session-missing-run', 2000);
  });

  it('swallows appendRunEvent failures once runId exists (covers appendSessionEvent best-effort catch)', async () => {
    runStore.createRun.mockResolvedValueOnce({ id: 'run-1' });

    // First appendRunEvent is used for backfilling the initial session:created event.
    // Subsequent events emitted during worker execution should be best-effort and
    // must not crash if persistence fails.
    runStore.appendRunEvent
      .mockResolvedValueOnce({ id: 1 })
      .mockRejectedValue(new Error('append failed'));

    const session = await createAutopilotSession({
      projectId: 1,
      prompt: 'Do the thing',
      deps: {
        generateId: () => 'session-append-reject',
        autopilot: async () => ({ ok: true })
      }
    });

    expect(session.runId).toBe('run-1');

    await autopilotTesting.waitForSessionInternal('session-append-reject', 2000);

    const internal = autopilotTesting.getSessionInternal('session-append-reject');
    expect(internal.status).toBe('completed');
    expect(runStore.appendRunEvent).toHaveBeenCalled();
  });
});
