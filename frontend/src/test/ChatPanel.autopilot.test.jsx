import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChatPanel from '../components/ChatPanel';
import { useAppState } from '../context/AppStateContext';
import * as goalsApi from '../utils/goalsApi';
import { processGoals } from '../services/goalAutomationService';
import { shouldSkipAutomationTests } from '../components/chatPanelCssOnly';
import * as React from 'react';

vi.mock('../context/AppStateContext');
vi.mock('../utils/goalsApi');
vi.mock('../services/goalAutomationService', () => ({
  handlePlanOnlyFeature: vi.fn(),
  handleRegularFeature: vi.fn(),
  processGoals: vi.fn().mockResolvedValue({ success: true })
}));
vi.mock('../components/chatPanelCssOnly', () => ({
  shouldSkipAutomationTests: vi.fn()
}));
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    on: vi.fn((event, handler) => {
      // Simulate immediate connection
      if (event === 'connect') {
        setTimeout(() => handler(), 0);
      }
    }),
    off: vi.fn(),
    emit: vi.fn((event, data, callback) => {
      if (event === 'autopilot:join' && callback) {
        // Simulate successful join with initial state
        callback({
          ok: true,
          status: { statusMessage: 'Autopilot running', status: 'running' },
          events: [
            { id: 1, message: 'Starting autopilot', type: 'step:start', payload: { prompt: 'Initial task' } }
          ]
        });
      }
    }),
    disconnect: vi.fn()
  }))
}));
vi.mock('../components/AutopilotTimeline.jsx', () => ({
  default: ({ events }) => {
    const safeEvents = Array.isArray(events) ? events.filter((evt) => evt && typeof evt === 'object') : [];
    return (
      <div data-testid="autopilot-timeline">
        {safeEvents.map((evt, idx) => (
          <div key={evt.id || idx} data-testid={`timeline-event-${evt.id || idx}`}>{evt.message || ''}</div>
        ))}
      </div>
    );
  }
}));

const getAutopilotHandlers = () => ChatPanel.__testHooks?.handlers || {};
const getStorageHelpers = () => ChatPanel.__testHooks?.storage || {};
const getLatestInstance = () => ChatPanel.__testHooks?.getLatestInstance?.() || null;
const ensureActiveAutopilotSession = async (overrides = {}) => {
  const latest = getLatestInstance();
  expect(latest?.setAutopilotSession).toBeInstanceOf(Function);
  await act(async () => {
    latest.setAutopilotSession?.({ id: 'session-test', status: 'running', ...overrides });
  });
  return latest;
};
const createDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const buildBaseAppState = (overrides = {}) => ({
  currentProject: { id: 123 },
  jobState: { jobsByProject: {} },
  setPreviewPanelTab: vi.fn(),
  stageAiChange: vi.fn(),
  startAutomationJob: vi.fn(),
  markTestRunIntent: vi.fn(),
  requestEditorFocus: vi.fn(),
  syncBranchOverview: vi.fn(),
  workingBranches: {},
  ...overrides
});

const renderWithAppState = (overrides = {}) => {
  useAppState.mockReturnValue(buildBaseAppState(overrides));
  return render(<ChatPanel width={320} side="left" />);
};

const startAutopilotSession = async (overrides = {}) => {
  const utils = renderWithAppState(overrides);
  const input = screen.getByTestId('chat-input');
  await userEvent.type(input, 'Trigger autopilot session');
  const { startAutopilot } = getAutopilotHandlers();
  await act(async () => {
    await startAutopilot?.();
  });
  await waitFor(() => {
    expect(goalsApi.agentAutopilot).toHaveBeenCalled();
  });
  return utils;
};

describe('ChatPanel - Autopilot Features', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shouldSkipAutomationTests.mockReturnValue(false);
    processGoals.mockResolvedValue({ success: true });
    if (typeof window !== 'undefined' && window.sessionStorage?.clear) {
      window.sessionStorage.clear();
    }
    goalsApi.fetchGoals.mockResolvedValue([]);
    goalsApi.agentRequest.mockResolvedValue({ kind: 'question', answer: 'Test', steps: [] });
    goalsApi.agentAutopilot.mockResolvedValue({ session: { id: 'session-1', status: 'pending', events: [] } });
    goalsApi.agentAutopilotStatus.mockResolvedValue({ session: { id: 'session-1', status: 'running', events: [] } });
    goalsApi.agentAutopilotMessage.mockResolvedValue({ session: { id: 'session-1', status: 'running', events: [] } });
    goalsApi.agentAutopilotCancel.mockResolvedValue({ session: { id: 'session-1', status: 'cancelled', events: [] } });
    goalsApi.agentAutopilotResume.mockResolvedValue({ success: true, resumed: [] });
    goalsApi.readUiSessionId = vi.fn().mockReturnValue('ui-session');
    goalsApi.createGoal = vi.fn().mockResolvedValue({ goal: { id: 'goal-1' } });
    goalsApi.createMetaGoalWithChildren = vi.fn().mockResolvedValue({
      parent: { id: 'meta-parent' },
      children: [{ id: 'child-1' }]
    });
  });

  describe('Autopilot Timeline Inspector', () => {
    it('renders inspector when autopilot events exist', async () => {
      goalsApi.agentAutopilotResume.mockResolvedValue({
        success: true,
        resumed: [
          {
            id: 'session-inspector',
            status: 'running',
            statusMessage: 'Working on it',
            events: [
              { id: 1, type: 'plan', message: 'Plan', payload: { steps: ['Do work'] } },
              { id: 2, type: 'step:start', message: 'Do work', payload: { prompt: 'Do work' } }
            ]
          }
        ]
      });

      useAppState.mockReturnValue({
        currentProject: { id: 123 },
        jobState: { jobsByProject: {} },
        setPreviewPanelTab: vi.fn(),
        stageAiChange: vi.fn(),
        startAutomationJob: vi.fn(),
        markTestRunIntent: vi.fn(),
        requestEditorFocus: vi.fn(),
        syncBranchOverview: vi.fn(),
        workingBranches: {}
      });

      render(<ChatPanel width={320} side="left" />);

      await waitFor(() => {
        expect(screen.getByTestId('chat-inspector')).toBeInTheDocument();
        expect(screen.getByTestId('autopilot-timeline')).toBeInTheDocument();
      });
    });

    it('advances planned steps when prior steps complete', async () => {
      goalsApi.agentAutopilotResume.mockResolvedValueOnce({
        success: true,
        resumed: [
          {
            id: 'session-plan-advance',
            status: 'running',
            statusMessage: 'Continuing plan',
            events: [
              { id: 'plan', type: 'plan', payload: { steps: ['First', 'Second', 'Third'] } },
              { id: 'step-1', type: 'step:start', payload: { prompt: 'First' } },
              { id: 'step-1-done', type: 'step:done', payload: { prompt: 'First' } },
              { id: 'step-2', type: 'step:start', payload: { prompt: 'Second' } }
            ]
          }
        ]
      });
      goalsApi.agentAutopilotStatus.mockResolvedValue({
        session: {
          id: 'session-plan-advance',
          status: 'running',
          statusMessage: 'Continuing plan',
          events: [
            { id: 'plan', type: 'plan', payload: { steps: ['First', 'Second', 'Third'] } },
            { id: 'step-1', type: 'step:start', payload: { prompt: 'First' } },
            { id: 'step-1-done', type: 'step:done', payload: { prompt: 'First' } },
            { id: 'step-2', type: 'step:start', payload: { prompt: 'Second' } }
          ]
        }
      });

      renderWithAppState();

      const inspector = await screen.findByTestId('chat-inspector');
      expect(within(inspector).getByText('Current step: Second')).toBeInTheDocument();
      expect(within(inspector).getByText('Next step: Third')).toBeInTheDocument();
    });

    it('ignores non-object events when building the step snapshot', async () => {
      const noisyEvents = [
        null,
        'mis-shaped',
        { id: 'plan', type: 'plan', payload: { steps: ['Solo Task'] } },
        { id: 'step-1', type: 'step:start', payload: { prompt: 'Solo Task' } }
      ];
      goalsApi.agentAutopilotResume.mockResolvedValueOnce({
        success: true,
        resumed: [
          {
            id: 'session-invalid-events',
            status: 'running',
            statusMessage: 'Processing',
            events: noisyEvents
          }
        ]
      });
      goalsApi.agentAutopilotStatus.mockResolvedValueOnce({
        session: {
          id: 'session-invalid-events',
          status: 'running',
          statusMessage: 'Processing',
          events: noisyEvents
        }
      });

      renderWithAppState();

      const inspector = await screen.findByTestId('chat-inspector');
      expect(within(inspector).getByText('Current step: Solo Task')).toBeInTheDocument();
      expect(within(inspector).queryByText('Next step:')).not.toBeInTheDocument();
    });

    it('falls back to status text when no status message is available', async () => {
      goalsApi.agentAutopilotResume.mockResolvedValueOnce({
        success: true,
        resumed: [
          {
            id: 'session-status-only',
            status: 'running',
            statusMessage: '',
            events: []
          }
        ]
      });
      goalsApi.agentAutopilotStatus.mockResolvedValue({
        session: {
          id: 'session-status-only',
          status: 'running',
          statusMessage: '',
          events: []
        }
      });

      renderWithAppState();

      expect(await screen.findByText('Autopilot · running')).toBeInTheDocument();
    });
    it('falls back to pending status and guards against invalid event arrays', async () => {
      renderWithAppState();

      const latest = getLatestInstance();
      expect(latest?.setAutopilotSession).toBeInstanceOf(Function);
      expect(latest?.setAutopilotEvents).toBeInstanceOf(Function);

      await act(async () => {
        latest.setAutopilotSession?.({ id: 'custom-session', status: '', statusMessage: '' });
      });
      await act(async () => {
        latest.setAutopilotEvents?.('mis-shaped');
      });

      const inspector = await screen.findByTestId('chat-inspector');
      expect(within(inspector).getByText('Autopilot · pending')).toBeInTheDocument();
      expect(within(inspector).queryByText(/Current step:/)).toBeNull();
      expect(within(inspector).queryByText(/Next step:/)).toBeNull();
    });

    it('skips invalid plan and prompt payloads when building the snapshot', async () => {
      const noisyEvents = [
        { id: 'plan-invalid', type: 'plan', payload: { steps: 'not-an-array' } },
        { id: 'plan-valid', type: 'plan', payload: { steps: ['  Keep going  ', 42, '', 'Next Step'] } },
        { id: 'start-invalid', type: 'step:start', payload: { prompt: 123 } },
        { id: 'start-valid', type: 'step:start', payload: { prompt: 'Keep going ' } },
        { id: 'done-invalid', type: 'step:done', payload: { prompt: {} } },
        { id: 'done-valid', type: 'step:done', payload: { prompt: 'Keep going ' } }
      ];
      goalsApi.agentAutopilotResume.mockResolvedValueOnce({
        success: true,
        resumed: [
          {
            id: 'session-trim',
            status: '',
            statusMessage: '',
            events: noisyEvents
          }
        ]
      });
      goalsApi.agentAutopilotStatus.mockResolvedValueOnce({
        session: {
          id: 'session-trim',
          status: '',
          statusMessage: '',
          events: noisyEvents
        }
      });

      renderWithAppState();

      const inspector = await screen.findByTestId('chat-inspector');
      expect(within(inspector).queryByText(/Current step:/)).toBeNull();
      expect(within(inspector).getByText('Next step: Next Step')).toBeInTheDocument();
      expect(within(inspector).getByText('Autopilot · pending')).toBeInTheDocument();
    });
  });

  describe('Autopilot hydration and resume', () => {
    it('refreshes stored sessions before attempting resume', async () => {
      const projectId = 777;
      const storedSession = { sessionId: 'stored-session', projectId };
      window.sessionStorage.setItem('lucidcoder.autopilotSession', JSON.stringify(storedSession));

      renderWithAppState({ currentProject: { id: projectId } });

      await waitFor(() => {
        expect(goalsApi.agentAutopilotStatus).toHaveBeenCalledWith({ projectId, sessionId: 'stored-session' });
      });
      expect(goalsApi.agentAutopilotResume).not.toHaveBeenCalled();
    });

    it('skips resume when a prior attempt already ran', async () => {
      goalsApi.readUiSessionId.mockReturnValue('ui-repeat');

      renderWithAppState();

      await waitFor(() => {
        expect(goalsApi.agentAutopilotResume).toHaveBeenCalledTimes(1);
      });

      goalsApi.agentAutopilotResume.mockClear();
      const hydrateAgain = ChatPanel.__testHooks?.hydrateAutopilot;
      expect(typeof hydrateAgain).toBe('function');

      await act(async () => {
        await hydrateAgain?.();
      });

      expect(goalsApi.agentAutopilotResume).not.toHaveBeenCalled();
    });

    it('ignores resume results after the component unmounts', async () => {
      goalsApi.readUiSessionId.mockReturnValue('ui-cancelled');
      let resolveResume;
      goalsApi.agentAutopilotResume.mockReturnValue(
        new Promise((resolve) => {
          resolveResume = resolve;
        })
      );

      const { unmount } = renderWithAppState();
      unmount();

      await act(async () => {
        resolveResume?.({ resumed: [{ id: 'session-cancelled', status: 'running', events: [] }] });
        await Promise.resolve();
      });

      expect(goalsApi.agentAutopilotStatus).not.toHaveBeenCalled();
    });

    it('logs failures when autopilot resume throws', async () => {
      goalsApi.readUiSessionId.mockReturnValue('ui-error');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      goalsApi.agentAutopilotResume.mockRejectedValueOnce(new Error('resume failed'));

      renderWithAppState();

      await waitFor(() => {
        expect(goalsApi.agentAutopilotResume).toHaveBeenCalled();
      });
      expect(warnSpy).toHaveBeenCalledWith('Failed to resume autopilot session', expect.any(Error));
      warnSpy.mockRestore();
    });
  });

  describe('Autopilot storage helpers', () => {
    const STORAGE_KEY = 'lucidcoder.autopilotSession';

    beforeEach(() => {
      window.sessionStorage.clear();
    });

    it('persists active sessions and clears terminal ones', async () => {
      renderWithAppState({ currentProject: { id: 246 } });
      const storage = getStorageHelpers();

      await act(async () => {
        await storage.applyAutopilotSummary?.({ id: 'session-storage', status: 'running', events: [] });
      });

      expect(window.sessionStorage.getItem(STORAGE_KEY)).toContain('session-storage');

      await act(async () => {
        await storage.applyAutopilotSummary?.({ id: 'session-storage', status: 'completed', events: [] });
      });

      expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();

      await act(async () => {
        await storage.applyAutopilotSummary?.(null);
      });
    });

    it('honors project scoping when loading stored sessions', () => {
      renderWithAppState({ currentProject: { id: 555 } });
      const storage = getStorageHelpers();

      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ sessionId: 'foreign', projectId: 999 }));
      expect(storage.loadStoredAutopilotSession?.()).toBeNull();

      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ sessionId: 'local', projectId: 555 }));
      expect(storage.loadStoredAutopilotSession?.()).toEqual({ sessionId: 'local', projectId: 555 });
    });

    it('ignores persisting sessions when status is inactive', () => {
      renderWithAppState({ currentProject: { id: 777 } });
      const storage = getStorageHelpers();

      storage.persistAutopilotSession?.({ id: 'should-not-save', status: 'failed' });
      expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('skips persisting when session metadata is incomplete', () => {
      renderWithAppState({ currentProject: { id: 888 } });
      const storage = getStorageHelpers();

      storage.persistAutopilotSession?.({ status: 'running' });
      expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('swallows storage errors when persisting sessions', () => {
      renderWithAppState({ currentProject: { id: 999 } });
      const storage = getStorageHelpers();

      const setSpy = vi.spyOn(window.sessionStorage, 'setItem').mockImplementation(() => {
        throw new Error('storage failure');
      });

      expect(() => {
        storage.persistAutopilotSession?.({ id: 'session-error', status: 'running' });
      }).not.toThrow();

      setSpy.mockRestore();
    });

    it('returns null when no project context is available for stored sessions', () => {
      renderWithAppState({ currentProject: null });
      const storage = getStorageHelpers();

      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ sessionId: 'orphaned', projectId: 4321 }));
      expect(storage.loadStoredAutopilotSession?.()).toBeNull();
    });

    it('returns null when stored payload lacks session id or cannot be parsed', () => {
      renderWithAppState({ currentProject: { id: 333 } });
      const storage = getStorageHelpers();

      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ projectId: 333 }));
      expect(storage.loadStoredAutopilotSession?.()).toBeNull();

      window.sessionStorage.setItem(STORAGE_KEY, '{not-json');
      expect(storage.loadStoredAutopilotSession?.()).toBeNull();
    });

    it('skips clearing storage when window is unavailable', () => {
      renderWithAppState();
      const storage = getStorageHelpers();
      const removeSpy = vi.spyOn(window.sessionStorage, 'removeItem');
      const originalWindow = window;

      try {
        global.window = undefined;
        storage.clearStoredAutopilotSession?.();
      } finally {
        global.window = originalWindow;
        removeSpy.mockRestore();
      }

      expect(removeSpy).not.toHaveBeenCalled();
    });

    it('swallows errors when clearing stored sessions fails', () => {
      renderWithAppState();
      const storage = getStorageHelpers();
      const removeSpy = vi.spyOn(window.sessionStorage, 'removeItem').mockImplementation(() => {
        throw new Error('remove failed');
      });

      expect(() => storage.clearStoredAutopilotSession?.()).not.toThrow();

      removeSpy.mockRestore();
    });

    it('normalizes fallback fields when applying autopilot summary data', async () => {
      renderWithAppState({ currentProject: { id: 321 } });
      const storage = getStorageHelpers();
      let normalized;

      await act(async () => {
        normalized = storage.applyAutopilotSummary?.({ sessionId: 4321, status: '', events: null }, { persist: false });
      });

      expect(normalized).toMatchObject({ id: '4321', status: 'pending', events: [] });

      const inspector = await screen.findByTestId('chat-inspector');
      expect(within(inspector).getByText('Session ID: 4321')).toBeInTheDocument();
      expect(within(inspector).getByText('Autopilot · pending')).toBeInTheDocument();
      await act(async () => {
        normalized = storage.applyAutopilotSummary?.({ statusMessage: '', status: '', events: [] }, { persist: false });
      });

      expect(normalized).toMatchObject({ id: '', status: 'pending' });
      expect(within(inspector).getByText(/^Session ID:\s*$/)).toBeInTheDocument();
    });
  });

  describe('Autopilot refresh helpers', () => {
    it('skips refresh attempts when identifiers are missing', async () => {
      renderWithAppState({ currentProject: null });
      const latest = getLatestInstance();

      expect(latest?.refreshAutopilotStatus).toBeInstanceOf(Function);
      const result = await latest.refreshAutopilotStatus?.('session-missing');
      expect(result).toBeNull();
      expect(goalsApi.agentAutopilotStatus).not.toHaveBeenCalled();
    });

    it('reschedules polling when sessions remain active', async () => {
      vi.useFakeTimers();
      const timeoutSpy = vi.spyOn(global, 'setTimeout');
      let unmount;
      try {
        ({ unmount } = renderWithAppState());
        goalsApi.agentAutopilotStatus.mockReset();
        goalsApi.agentAutopilotStatus
          .mockResolvedValueOnce({ session: { id: 'loop', status: 'running', events: [] } })
          .mockResolvedValueOnce({ session: { id: 'loop', status: 'completed', events: [] } });

        const latest = getLatestInstance();
        expect(latest?.refreshAutopilotStatus).toBeInstanceOf(Function);

        await act(async () => {
          await latest.refreshAutopilotStatus?.('loop');
        });

        expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2000);

        await act(async () => {
          vi.runOnlyPendingTimers();
        });
        await Promise.resolve();

        expect(goalsApi.agentAutopilotStatus).toHaveBeenCalledTimes(2);
      } finally {
        unmount?.();
        timeoutSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it('retries and logs when refresh calls fail', async () => {
      vi.useFakeTimers();
      const timeoutSpy = vi.spyOn(global, 'setTimeout');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      let unmount;
      try {
        ({ unmount } = renderWithAppState());
        goalsApi.agentAutopilotStatus.mockReset();
        goalsApi.agentAutopilotStatus
          .mockRejectedValueOnce(new Error('network issue'))
          .mockResolvedValueOnce({ session: { id: 'loop', status: 'completed', events: [] } });

        const latest = getLatestInstance();

        const result = await latest.refreshAutopilotStatus?.('loop');
        expect(result).toBeNull();
        expect(warnSpy).toHaveBeenCalledWith('Failed to refresh autopilot session', expect.any(Error));
        expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 4000);

        await act(async () => {
          vi.runOnlyPendingTimers();
        });
        await Promise.resolve();

        expect(goalsApi.agentAutopilotStatus).toHaveBeenCalledTimes(2);
      } finally {
        unmount?.();
        timeoutSpy.mockRestore();
        warnSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it('honors the immediate refresh delay for bare session payloads', async () => {
      vi.useFakeTimers();
      const timeoutSpy = vi.spyOn(global, 'setTimeout');
      let unmount;
      try {
        ({ unmount } = renderWithAppState());
        goalsApi.agentAutopilotStatus.mockReset();
        goalsApi.agentAutopilotStatus.mockResolvedValueOnce({ id: 'loop', status: 'running', events: [] });

        const latest = getLatestInstance();

        await act(async () => {
          await latest.refreshAutopilotStatus?.('loop', { immediate: true });
        });

        expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1000);

        await act(async () => {
          vi.runOnlyPendingTimers();
        });
        await Promise.resolve();
      } finally {
        unmount?.();
        timeoutSpy.mockRestore();
        vi.useRealTimers();
      }
    });
  });

  describe('Job Logs Display', () => {
    it('renders job logs section structure when jobs exist', () => {
      useAppState.mockReturnValue({
        currentProject: { id: 123 },
        jobState: {
          jobsByProject: {
            '123': {
              jobs: [
                {
                  type: 'test-run',
                  displayName: 'Unit Tests',
                  status: 'running',
                  logs: [
                    { stream: 'stdout', message: 'Running test suite...' },
                    { stream: 'stdout', message: 'Tests passed: 5/5' },
                    { stream: 'stderr', message: 'Warning: deprecated API' }
                  ]
                },
                {
                  type: 'test-run',
                  displayName: 'Integration Tests',
                  status: 'completed',
                  logs: [
                    { stream: 'stdout', message: 'Integration tests complete' }
                  ]
                }
              ]
            }
          }
        },
        setPreviewPanelTab: vi.fn()
      });

      render(<ChatPanel width={320} side="left" />);

      // Job logs only visible when autopilot is actually running
      // This verifies the component handles the jobState prop correctly
      expect(screen.getByTestId('chat-panel')).toBeInTheDocument();
      expect(screen.queryByTestId('chat-job-logs')).not.toBeInTheDocument();
      expect(screen.queryByTestId('chat-job-logs')).not.toBeInTheDocument();
    });

    it('handles empty job logs', () => {
      useAppState.mockReturnValue({
        currentProject: { id: 123 },
        jobState: {
          jobsByProject: {
            '123': {
              jobs: []
            }
          }
        },
        setPreviewPanelTab: vi.fn()
      });

      render(<ChatPanel width={320} side="left" />);
      expect(screen.getByTestId('chat-panel')).toBeInTheDocument();
      expect(screen.queryByTestId('chat-job-logs')).not.toBeInTheDocument();
    });

    it('handles undefined jobsByProject', () => {
      useAppState.mockReturnValue({
        currentProject: { id: 123 },
        jobState: {},
        setPreviewPanelTab: vi.fn()
      });

      render(<ChatPanel width={320} side="left" />);
      expect(screen.getByTestId('chat-panel')).toBeInTheDocument();
      expect(screen.queryByTestId('chat-job-logs')).not.toBeInTheDocument();
    });

    it('filters to only test-run job types', () => {
      useAppState.mockReturnValue({
        currentProject: { id: 123 },
        jobState: {
          jobsByProject: {
            '123': {
              jobs: [
                { type: 'test-run', displayName: 'Tests', status: 'running', logs: [] },
                { type: 'build', displayName: 'Build', status: 'completed', logs: [] },
                { type: 'lint', displayName: 'Lint', status: 'completed', logs: [] }
              ]
            }
          }
        },
        setPreviewPanelTab: vi.fn()
      });

      render(<ChatPanel width={320} side="left" />);
      // Component should render without errors with mixed job types
      expect(screen.getByTestId('chat-panel')).toBeInTheDocument();
    });

    it('handles jobs with very long log arrays', () => {
      const manyLogs = Array.from({ length: 150 }, (_, i) => ({
        stream: 'stdout',
        message: `Log line ${i + 1}`
      }));

      useAppState.mockReturnValue({
        currentProject: { id: 123 },
        jobState: {
          jobsByProject: {
            '123': {
              jobs: [
                {
                  type: 'test-run',
                  displayName: 'Long Test',
                  status: 'running',
                  logs: manyLogs
                }
              ]
            }
          }
        },
        setPreviewPanelTab: vi.fn()
      });

      render(<ChatPanel width={320} side="left" />);
      expect(screen.getByTestId('chat-panel')).toBeInTheDocument();
      expect(screen.queryByTestId('chat-job-logs')).not.toBeInTheDocument();
    });

    it('shows inspector step details and job logs when autopilot resumes with test runs', async () => {
      goalsApi.agentAutopilotResume.mockResolvedValueOnce({
        success: true,
        resumed: [
          {
            id: 'session-jobs',
            status: 'running',
            statusMessage: 'Executing plan',
            events: [
              { id: 'plan-1', type: 'plan', payload: { steps: ['Wire up API', 'Write tests'] } },
              { id: 'step-1', type: 'step:start', payload: { prompt: 'Wire up API' } }
            ]
          }
        ]
      });
      goalsApi.agentAutopilotStatus.mockResolvedValue({
        session: {
          id: 'session-jobs',
          status: 'running',
          statusMessage: 'Executing plan',
          events: [
            { id: 'plan-1', type: 'plan', payload: { steps: ['Wire up API', 'Write tests'] } },
            { id: 'step-1', type: 'step:start', payload: { prompt: 'Wire up API' } }
          ]
        }
      });

      useAppState.mockReturnValue({
        currentProject: { id: 123 },
        jobState: {
          jobsByProject: {
            '123': {
              jobs: [
                null,
                { type: 'build', displayName: 'Build', status: 'done', logs: [] },
                {
                  type: 'test-run',
                  displayName: 'Frontend Tests',
                  status: 'running',
                  logs: [
                    { stream: 'stdout', message: 'Suite start' },
                    { stream: 'stderr', message: 'Warning found' }
                  ]
                }
              ]
            }
          }
        },
        setPreviewPanelTab: vi.fn(),
        stageAiChange: vi.fn(),
        startAutomationJob: vi.fn(),
        markTestRunIntent: vi.fn(),
        requestEditorFocus: vi.fn(),
        syncBranchOverview: vi.fn(),
        workingBranches: {}
      });

      render(<ChatPanel width={320} side="left" />);

      const inspector = await screen.findByTestId('chat-inspector');
      expect(within(inspector).getByText('Current step: Wire up API')).toBeInTheDocument();
      expect(within(inspector).getByText('Next step: Write tests')).toBeInTheDocument();

      const jobLogs = await screen.findByTestId('chat-job-logs');
      expect(within(jobLogs).getByText('Frontend Tests • running')).toBeInTheDocument();
      expect(within(jobLogs).getByText('Suite start')).toBeInTheDocument();
      expect(within(jobLogs).getByText('Warning found')).toBeInTheDocument();
    });

    it('falls back to default job headers when metadata is missing', async () => {
      goalsApi.agentAutopilotResume.mockResolvedValueOnce({
        success: true,
        resumed: [
          {
            id: 'session-default',
            status: 'running',
            statusMessage: '',
            events: []
          }
        ]
      });
      goalsApi.agentAutopilotStatus.mockResolvedValue({
        session: { id: 'session-default', status: 'running', statusMessage: '', events: [] }
      });

      useAppState.mockReturnValue({
        currentProject: { id: 456 },
        jobState: {
          jobsByProject: {
            '456': {
              jobs: [
                {
                  type: 'test-run',
                  displayName: '',
                  status: '',
                  logs: [{}, { message: undefined, stream: undefined }]
                }
              ]
            }
          }
        },
        setPreviewPanelTab: vi.fn()
      });

      render(<ChatPanel width={320} side="left" />);
      const jobLogs = await screen.findByTestId('chat-job-logs');
      expect(within(jobLogs).getByText('Test Run • pending')).toBeInTheDocument();
    });
  });

  describe('Autopilot Control Buttons', () => {
    it('does not render a Start Autopilot button, but can still launch autopilot', async () => {
      useAppState.mockReturnValue({
        currentProject: { id: 555 },
        jobState: { jobsByProject: {} },
        setPreviewPanelTab: vi.fn(),
        stageAiChange: vi.fn(),
        startAutomationJob: vi.fn(),
        markTestRunIntent: vi.fn(),
        requestEditorFocus: vi.fn(),
        syncBranchOverview: vi.fn(),
        workingBranches: {}
      });
      goalsApi.agentAutopilot.mockResolvedValueOnce({
        session: { id: 'session-start', status: 'running', statusMessage: 'Running', events: [] }
      });
      goalsApi.agentAutopilotStatus.mockResolvedValue({
        session: { id: 'session-start', status: 'running', events: [] }
      });

      render(<ChatPanel width={320} side="left" />);

      expect(screen.queryByTestId('autopilot-control-start')).toBeNull();

      const input = screen.getByTestId('chat-input');
      await userEvent.type(input, 'Implement autopilot');

      const { startAutopilot } = getAutopilotHandlers();
      await act(async () => {
        await startAutopilot?.();
      });

      await waitFor(() => {
        expect(goalsApi.agentAutopilot).toHaveBeenCalledWith({ projectId: 555, prompt: 'Implement autopilot' });
      });
    });

    it('renders stop/pause/resume buttons when autopilot is running', async () => {
      useAppState.mockReturnValue({
        currentProject: { id: 777 },
        jobState: { jobsByProject: {} },
        setPreviewPanelTab: vi.fn(),
        stageAiChange: vi.fn(),
        startAutomationJob: vi.fn(),
        markTestRunIntent: vi.fn(),
        requestEditorFocus: vi.fn(),
        syncBranchOverview: vi.fn(),
        workingBranches: {}
      });

      goalsApi.agentAutopilot.mockResolvedValueOnce({
        session: { id: 'session-control', status: 'running', statusMessage: 'Running', events: [] }
      });
      goalsApi.agentAutopilotStatus
        .mockResolvedValueOnce({
          session: { id: 'session-control', status: 'running', statusMessage: 'Running', events: [] }
        })
        .mockResolvedValueOnce({
          session: { id: 'session-control', status: 'paused', statusMessage: 'Paused', events: [] }
        })
        .mockResolvedValue({
          session: { id: 'session-control', status: 'running', statusMessage: 'Running', events: [] }
        });
      goalsApi.agentAutopilotMessage
        .mockResolvedValueOnce({ session: { id: 'session-control', status: 'paused', events: [] } })
        .mockResolvedValueOnce({ session: { id: 'session-control', status: 'running', events: [] } });

      render(<ChatPanel width={320} side="left" />);

      const input = screen.getByTestId('chat-input');
      await userEvent.type(input, 'Ship it');
      const { startAutopilot } = getAutopilotHandlers();
      await act(async () => {
        await startAutopilot?.();
      });

      await waitFor(() => {
        expect(screen.getByTestId('autopilot-control-stop')).toBeInTheDocument();
        expect(screen.getByTestId('autopilot-control-pause')).toBeInTheDocument();
      });

      const pauseButton = screen.getByTestId('autopilot-control-pause');
      await userEvent.click(pauseButton);

      await waitFor(() => {
        expect(screen.getByTestId('autopilot-control-resume')).toBeInTheDocument();
      });

      await userEvent.click(screen.getByTestId('autopilot-control-resume'));

      expect(goalsApi.agentAutopilotMessage).toHaveBeenCalledTimes(2);

      const changeButton = screen.getByTestId('autopilot-control-change-direction');
      await userEvent.click(changeButton);
      expect(screen.getByTestId('chat-input').value).toBe('Please change direction by ');

      const undoButton = screen.getByTestId('autopilot-control-undo-last-change');
      await userEvent.click(undoButton);
      expect(screen.getByTestId('chat-input').value)
        .toBe('Undo the last change and explain what will be rolled back.');

      const cancelRefresh = createDeferred();
      goalsApi.agentAutopilotStatus.mockImplementationOnce(() => cancelRefresh.promise);

      await userEvent.click(screen.getByTestId('autopilot-control-stop'));

      const statusNote = await screen.findByTestId('autopilot-status-note');
      expect(statusNote).toHaveTextContent('Autopilot cancellation requested.');
      cancelRefresh.resolve({ session: { id: 'session-control', status: 'cancelled', events: [] } });
    });

    it('routes slash commands and free-form prompts while autopilot is running', async () => {
      useAppState.mockReturnValue({
        currentProject: { id: 888 },
        jobState: { jobsByProject: {} },
        setPreviewPanelTab: vi.fn(),
        stageAiChange: vi.fn(),
        startAutomationJob: vi.fn(),
        markTestRunIntent: vi.fn(),
        requestEditorFocus: vi.fn(),
        syncBranchOverview: vi.fn(),
        workingBranches: {}
      });

      goalsApi.agentAutopilot.mockResolvedValueOnce({
        session: { id: 'session-commands', status: 'running', statusMessage: 'Running', events: [] }
      });
      goalsApi.agentAutopilotStatus.mockResolvedValue({
        session: { id: 'session-commands', status: 'running', statusMessage: 'Running', events: [] }
      });

      render(<ChatPanel width={320} side="left" />);

      const input = screen.getByTestId('chat-input');
      await userEvent.type(input, 'Automate release notes');
      const { startAutopilot } = getAutopilotHandlers();
      await act(async () => {
        await startAutopilot?.();
      });

      await waitFor(() => {
        expect(screen.getByTestId('autopilot-control-stop')).toBeInTheDocument();
      });

      await userEvent.clear(input);
      await userEvent.type(input, 'Keep pushing forward');
      await userEvent.click(screen.getByTestId('chat-send-button'));

      await waitFor(() => {
        expect(goalsApi.agentAutopilotMessage).toHaveBeenCalledWith({
          projectId: 888,
          sessionId: 'session-commands',
          message: 'Keep pushing forward'
        });
      });

      await userEvent.clear(input);
      await userEvent.type(input, '/stop');
      await userEvent.click(screen.getByTestId('chat-send-button'));

      await waitFor(() => {
        expect(goalsApi.agentAutopilotCancel).toHaveBeenCalledWith({
          projectId: 888,
          sessionId: 'session-commands',
          reason: 'User requested stop'
        });
      });
    });
  });

  describe('Autopilot messaging and controls', () => {
    it('reports when autopilot guidance is sent without an active session', async () => {
      renderWithAppState();

      const { autopilotMessage } = getAutopilotHandlers();
      await act(async () => {
        const result = await autopilotMessage?.('Please keep going');
        expect(result).toBeNull();
      });

      expect(goalsApi.agentAutopilotMessage).not.toHaveBeenCalled();
      const statusNote = await screen.findByTestId('autopilot-status-note');
      expect(statusNote).toHaveTextContent('Autopilot is not running.');
    });

    it('ignores whitespace-only guidance when autopilot is running', async () => {
      await startAutopilotSession({ currentProject: { id: 910 } });
      goalsApi.agentAutopilotMessage.mockClear();

      const { autopilotMessage } = getAutopilotHandlers();
      await act(async () => {
        const result = await autopilotMessage?.('   ');
        expect(result).toBeNull();
      });

      expect(goalsApi.agentAutopilotMessage).not.toHaveBeenCalled();
    });

    it('surfaces API failures when sending autopilot guidance', async () => {
      await startAutopilotSession({ currentProject: { id: 920 } });
      goalsApi.agentAutopilotMessage.mockRejectedValueOnce(new Error('send-fail'));

      const { autopilotMessage } = getAutopilotHandlers();
      await act(async () => {
        await autopilotMessage?.('Please update the plan');
      });

      const statusNote = await screen.findByTestId('autopilot-status-note');
      expect(statusNote).toHaveTextContent('Failed to send guidance to autopilot.');
    });

    it('handles guidance failures when a session is injected manually', async () => {
      renderWithAppState({ currentProject: { id: 935 } });
      await ensureActiveAutopilotSession({ id: 'session-injected' });
      goalsApi.agentAutopilotMessage.mockRejectedValueOnce(new Error('manual-fail'));

      const { autopilotMessage } = getAutopilotHandlers();
      await act(async () => {
        await autopilotMessage?.('Provide a status update');
      });

      const statusNote = await screen.findByTestId('autopilot-status-note');
      expect(statusNote).toHaveTextContent('Failed to send guidance to autopilot.');
    });

    it('sets guidance success note after sending autopilot message', async () => {
      await startAutopilotSession({ currentProject: { id: 925 } });
      goalsApi.agentAutopilotMessage.mockResolvedValueOnce({ id: 'session-1', status: 'running', events: [] });
      const guidanceRefresh = createDeferred();
      goalsApi.agentAutopilotStatus.mockImplementationOnce(() => guidanceRefresh.promise);
      const { autopilotMessage } = getAutopilotHandlers();

      await act(async () => {
        const result = await autopilotMessage?.('Focus on CSS coverage');
        expect(result).toBeTruthy();
      });

      const statusNote = await screen.findByTestId('autopilot-status-note');
      expect(statusNote).toHaveTextContent('Guidance sent to autopilot.');
      guidanceRefresh.resolve({ session: { id: 'session-1', status: 'running', events: [] } });
    });

    it('reports when autopilot controls are used without a session', async () => {
      renderWithAppState();

      const { autopilotControl } = getAutopilotHandlers();
      await act(async () => {
        await autopilotControl?.('pause');
      });

      const statusNote = await screen.findByTestId('autopilot-status-note');
      expect(statusNote).toHaveTextContent('Autopilot is not running.');
    });

    it('surfaces failures when autopilot control requests fail', async () => {
      await startAutopilotSession({ currentProject: { id: 930 } });
      goalsApi.agentAutopilotCancel.mockRejectedValueOnce(new Error('cancel-fail'));

      const { autopilotControl } = getAutopilotHandlers();
      await act(async () => {
        await autopilotControl?.('cancel');
      });

      const statusNote = await screen.findByTestId('autopilot-status-note');
      expect(statusNote).toHaveTextContent('Failed to cancel autopilot.');
    });

    it('handles cancel failures after manually injecting a session', async () => {
      renderWithAppState({ currentProject: { id: 937 } });
      await ensureActiveAutopilotSession({ id: 'session-control' });
      goalsApi.agentAutopilotCancel.mockRejectedValueOnce(new Error('manual-cancel'));

      const { autopilotControl } = getAutopilotHandlers();
      await act(async () => {
        await autopilotControl?.('cancel');
      });

      const statusNote = await screen.findByTestId('autopilot-status-note');
      expect(statusNote).toHaveTextContent('Failed to cancel autopilot.');
    });

    it('reports pause/resume transitions with status notes', async () => {
      await startAutopilotSession({ currentProject: { id: 932 } });
      goalsApi.agentAutopilotMessage
        .mockResolvedValueOnce({ id: 'session-1', status: 'paused', events: [] })
        .mockResolvedValueOnce({ session: { id: 'session-1', status: 'running', events: [] } });

      const { autopilotControl } = getAutopilotHandlers();
      const pauseRefresh = createDeferred();
      goalsApi.agentAutopilotStatus.mockImplementationOnce(() => pauseRefresh.promise);
      await act(async () => {
        await autopilotControl?.('pause');
      });
      let statusNote = await screen.findByTestId('autopilot-status-note');
      expect(statusNote).toHaveTextContent('Autopilot pause requested.');
      pauseRefresh.resolve({ session: { id: 'session-1', status: 'paused', events: [] } });

      const resumeRefresh = createDeferred();
      goalsApi.agentAutopilotStatus.mockImplementationOnce(() => resumeRefresh.promise);
      await act(async () => {
        await autopilotControl?.('resume');
      });
      statusNote = await screen.findByTestId('autopilot-status-note');
      expect(statusNote).toHaveTextContent('Autopilot resume requested.');
      resumeRefresh.resolve({ session: { id: 'session-1', status: 'running', events: [] } });
    });

    it('ignores non-string guidance payloads even when autopilot is running', async () => {
      await startAutopilotSession({ currentProject: { id: 926 } });
      goalsApi.agentAutopilotMessage.mockClear();

      const { autopilotMessage } = getAutopilotHandlers();
      await act(async () => {
        const result = await autopilotMessage?.(42);
        expect(result).toBeNull();
      });

      expect(goalsApi.agentAutopilotMessage).not.toHaveBeenCalled();
    });

    it('does not refresh autopilot status when guidance responses omit an id', async () => {
      await startAutopilotSession({ currentProject: { id: 946 } });
      goalsApi.agentAutopilotMessage.mockResolvedValueOnce({ status: 'running', events: [] });
      goalsApi.agentAutopilotStatus.mockClear();

      const { autopilotMessage } = getAutopilotHandlers();
      await act(async () => {
        await autopilotMessage?.('Continue exploring');
      });

      expect(goalsApi.agentAutopilotStatus).not.toHaveBeenCalled();
      const statusNote = await screen.findByTestId('autopilot-status-note');
      expect(statusNote).toHaveTextContent('Guidance sent to autopilot.');
    });

    it('rejects unsupported autopilot control actions', async () => {
      await startAutopilotSession({ currentProject: { id: 950 } });
      goalsApi.agentAutopilotCancel.mockClear();
      goalsApi.agentAutopilotMessage.mockClear();

      const { autopilotControl } = getAutopilotHandlers();
      await act(async () => {
        await autopilotControl?.('rewind');
      });

      expect(goalsApi.agentAutopilotCancel).not.toHaveBeenCalled();
      expect(goalsApi.agentAutopilotMessage).not.toHaveBeenCalled();
      const statusNote = await screen.findByTestId('autopilot-status-note');
      expect(statusNote).toHaveTextContent('Unsupported autopilot control.');
    });

    it('treats non-string autopilot control payloads as unsupported commands', async () => {
      await startAutopilotSession({ currentProject: { id: 952 } });
      goalsApi.agentAutopilotCancel.mockClear();
      goalsApi.agentAutopilotMessage.mockClear();

      const { autopilotControl } = getAutopilotHandlers();
      await act(async () => {
        await autopilotControl?.(42);
      });

      expect(goalsApi.agentAutopilotCancel).not.toHaveBeenCalled();
      expect(goalsApi.agentAutopilotMessage).not.toHaveBeenCalled();
      const statusNote = await screen.findByTestId('autopilot-status-note');
      expect(statusNote).toHaveTextContent('Unsupported autopilot control.');
    });

    it('refreshes autopilot status when guidance responses include a session id', async () => {
      await startAutopilotSession({ currentProject: { id: 948 } });
      goalsApi.agentAutopilotMessage.mockResolvedValueOnce({ session: { id: 'session-2', status: 'running', events: [] } });
      goalsApi.agentAutopilotStatus.mockClear();

      const { autopilotMessage } = getAutopilotHandlers();
      await act(async () => {
        await autopilotMessage?.('Advance to next step');
      });

      await waitFor(() => {
        expect(goalsApi.agentAutopilotStatus).toHaveBeenCalledWith({ projectId: 948, sessionId: 'session-2' });
      });
    });

    it('applies control responses when the session wrapper is missing', async () => {
      await startAutopilotSession({ currentProject: { id: 934 } });
      goalsApi.agentAutopilotMessage.mockResolvedValueOnce({ id: 'session-1', status: 'paused', events: [] });

      const { autopilotControl } = getAutopilotHandlers();
      const pauseRefresh = createDeferred();
      goalsApi.agentAutopilotStatus.mockImplementationOnce(() => pauseRefresh.promise);
      await act(async () => {
        await autopilotControl?.('pause');
      });

      expect(goalsApi.agentAutopilotMessage).toHaveBeenCalledWith({
        projectId: 934,
        sessionId: 'session-1',
        message: 'pause',
        kind: 'pause'
      });

      const inspector = await screen.findByTestId('chat-inspector');
      expect(within(inspector).getByText('Autopilot · paused')).toBeInTheDocument();
      pauseRefresh.resolve({ session: { id: 'session-1', status: 'paused', events: [] } });
    });

    it('disables autopilot controls while guidance is being sent', async () => {
      await startAutopilotSession({ currentProject: { id: 938 } });

      const stopButton = await screen.findByTestId('autopilot-control-stop');
      const input = screen.getByTestId('chat-input');
      await userEvent.clear(input);
      await userEvent.type(input, 'Stay on target');

      let resolveMessage;
      goalsApi.agentAutopilotMessage.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveMessage = resolve;
        })
      );

      await userEvent.click(screen.getByTestId('chat-send-button'));
      await waitFor(() => {
        expect(stopButton).toBeDisabled();
      });

      await act(async () => {
        resolveMessage?.({ session: { id: 'session-1', status: 'running', events: [] } });
      });

      await waitFor(() => {
        expect(stopButton).not.toBeDisabled();
      });
    });

    it('applies cancel responses when the session wrapper is missing', async () => {
      await startAutopilotSession({ currentProject: { id: 942 } });
      goalsApi.agentAutopilotCancel.mockResolvedValueOnce({ id: 'session-1', status: 'cancelled', statusMessage: 'Done', events: [] });

      const cancelRefresh = createDeferred();
      goalsApi.agentAutopilotStatus.mockImplementationOnce(() => cancelRefresh.promise);

      const { autopilotControl } = getAutopilotHandlers();
      await act(async () => {
        await autopilotControl?.('cancel');
      });

      const inspector = await screen.findByTestId('chat-inspector');
      expect(within(inspector).getByText('Autopilot · Done')).toBeInTheDocument();
      const statusNote = await screen.findByTestId('autopilot-status-note');
      expect(statusNote).toHaveTextContent('Autopilot cancellation requested.');
      cancelRefresh.resolve({ session: { id: 'session-1', status: 'cancelled', statusMessage: 'Done', events: [] } });
    });
  });

  describe('Chat command helpers', () => {
    it('reports when stop command is used without an active session', async () => {
      renderWithAppState();
      const { submitPrompt } = getAutopilotHandlers();

      await act(async () => {
        await submitPrompt?.('/stop');
      });

      expect(await screen.findByText('Nothing is currently running.')).toBeInTheDocument();
    });
  });

  describe('Submit prompt guards', () => {
    it('ignores non-string prompt payloads', async () => {
      renderWithAppState();
      const { submitPrompt } = getAutopilotHandlers();

      await act(async () => {
        await submitPrompt?.(null);
      });

      expect(goalsApi.agentRequest).not.toHaveBeenCalled();
    });
  });

  describe('Test hook helpers', () => {
    it('clears the latest instance reference', () => {
      ChatPanel.__testHooks.latestInstance = { test: true };
      ChatPanel.__testHooks.clearLatestInstance?.();
      expect(ChatPanel.__testHooks.getLatestInstance?.()).toBeNull();
    });
  });

  describe('Autopilot Start Safeguards', () => {
    const buildAutopilotAppState = (overrides = {}) => ({
      currentProject: { id: 901 },
      jobState: { jobsByProject: {} },
      setPreviewPanelTab: vi.fn(),
      stageAiChange: vi.fn(),
      startAutomationJob: vi.fn(),
      markTestRunIntent: vi.fn(),
      requestEditorFocus: vi.fn(),
      syncBranchOverview: vi.fn(),
      workingBranches: {},
      ...overrides
    });

    it('prevents starting autopilot without describing the feature', async () => {
      useAppState.mockReturnValue(buildAutopilotAppState());

      render(<ChatPanel width={320} side="left" />);

      const { startAutopilot } = getAutopilotHandlers();
      expect(typeof startAutopilot).toBe('function');

      await act(async () => {
        await startAutopilot();
      });

      const error = await screen.findByTestId('chat-error');
      expect(error).toHaveTextContent('Describe the feature you want before starting autopilot.');
      expect(goalsApi.agentAutopilot).not.toHaveBeenCalled();
    });

    it('prevents starting autopilot when no project is selected', async () => {
      useAppState.mockReturnValue(buildAutopilotAppState({ currentProject: null }));

      render(<ChatPanel width={320} side="left" />);

      const input = screen.getByTestId('chat-input');
      await userEvent.type(input, 'Need autopilot support');

      const { startAutopilot } = getAutopilotHandlers();
      expect(typeof startAutopilot).toBe('function');

      await act(async () => {
        await startAutopilot();
      });

      const error = await screen.findByTestId('chat-error');
      expect(error).toHaveTextContent('Select a project before starting autopilot.');
      expect(goalsApi.agentAutopilot).not.toHaveBeenCalled();
    });

    it('surfaces backend errors when autopilot session id is missing', async () => {
      useAppState.mockReturnValue(buildAutopilotAppState());
      goalsApi.agentAutopilot.mockResolvedValueOnce({ session: { status: 'running', events: [] } });

      render(<ChatPanel width={320} side="left" />);

      const input = screen.getByTestId('chat-input');
      await userEvent.type(input, 'Start autopilot please');

      const { startAutopilot } = getAutopilotHandlers();
      await act(async () => {
        await startAutopilot?.();
      });

      await waitFor(() => {
        expect(screen.getByText('Autopilot session did not return an id.')).toBeInTheDocument();
      });
    });

    it('shows a fallback error message when autopilot start fails', async () => {
      useAppState.mockReturnValue(buildAutopilotAppState());
      goalsApi.agentAutopilot.mockRejectedValueOnce(new Error(''));

      render(<ChatPanel width={320} side="left" />);

      const input = screen.getByTestId('chat-input');
      await userEvent.type(input, 'Start autopilot please');

      const { startAutopilot } = getAutopilotHandlers();
      await act(async () => {
        await startAutopilot?.();
      });

      await waitFor(() => {
        expect(screen.getByText('Failed to start autopilot.')).toBeInTheDocument();
      });
    });

    it('handles start responses that omit the session wrapper', async () => {
      useAppState.mockReturnValue(buildAutopilotAppState());
      goalsApi.agentAutopilot.mockResolvedValueOnce({ id: 'session-direct', status: 'running', events: [] });
      goalsApi.agentAutopilotStatus.mockResolvedValueOnce({
        session: { id: 'session-direct', status: 'running', events: [] }
      });

      render(<ChatPanel width={320} side="left" />);

      const input = screen.getByTestId('chat-input');
      await userEvent.type(input, 'Direct session response');

      const { startAutopilot } = getAutopilotHandlers();
      await act(async () => {
        await startAutopilot?.();
      });

      await waitFor(() => {
        expect(goalsApi.agentAutopilotStatus).toHaveBeenCalledWith({ projectId: 901, sessionId: 'session-direct' });
      });
    });
  });

  describe('Automated test-fix goals', () => {
    it('skips automated test runs when CSS-only changes are detected', async () => {
      shouldSkipAutomationTests.mockReturnValue(true);
      const setPreviewPanelTab = vi.fn();
      const startAutomationJob = vi.fn();

      renderWithAppState({ currentProject: { id: 444 }, setPreviewPanelTab, startAutomationJob });

      const { runAutomatedTestFixGoal } = getAutopilotHandlers();
      await act(async () => {
        await runAutomatedTestFixGoal?.({ prompt: 'Fix tests', childPrompts: [] }, { origin: 'automation' });
      });

      expect(setPreviewPanelTab).toHaveBeenCalledWith('commits', { source: 'automation' });
      expect(startAutomationJob).not.toHaveBeenCalled();
      expect(
        await screen.findByText(
          'CSS-only update detected. Skipping automated test run and moving to commit stage.'
        )
      ).toBeInTheDocument();
    });

    it('uses the user source when CSS-only updates skip automation manually', async () => {
      shouldSkipAutomationTests.mockReturnValue(true);
      const setPreviewPanelTab = vi.fn();
      const startAutomationJob = vi.fn();

      renderWithAppState({ currentProject: { id: 445 }, setPreviewPanelTab, startAutomationJob });

      const { runAutomatedTestFixGoal } = getAutopilotHandlers();
      await act(async () => {
        await runAutomatedTestFixGoal?.({ prompt: 'Fix tests', childPrompts: [] }, { origin: 'user' });
      });

      expect(setPreviewPanelTab).toHaveBeenCalledWith('commits', { source: 'user' });
      expect(startAutomationJob).not.toHaveBeenCalled();
    });
  });

  describe('Change Direction and Undo Prompts', () => {
    it('handleChangeDirectionPrompt would set input value if autopilot was running', () => {
      // These functions check for autopilot state before executing
      // Since we can't set internal state, we verify the component renders correctly
      useAppState.mockReturnValue({
        currentProject: { id: 123 },
        jobState: { jobsByProject: {} },
        setPreviewPanelTab: vi.fn()
      });

      render(<ChatPanel width={320} side="left" />);

      const input = screen.getByTestId('chat-input');
      expect(input).toBeInTheDocument();
      expect(input.value).toBe('');
    });

    it('handleUndoLastChangePrompt would set input value if autopilot was running', () => {
      useAppState.mockReturnValue({
        currentProject: { id: 123 },
        jobState: { jobsByProject: {} },
        setPreviewPanelTab: vi.fn()
      });

      render(<ChatPanel width={320} side="left" />);

      const input = screen.getByTestId('chat-input');
      expect(input).toBeInTheDocument();
      // Input should be empty since autopilot isn't running
      expect(input.value).toBe('');
    });

    it('shows status note when change direction is requested without an active session', async () => {
      useAppState.mockReturnValue({
        currentProject: { id: 321 },
        jobState: { jobsByProject: {} },
        setPreviewPanelTab: vi.fn()
      });

      render(<ChatPanel width={320} side="left" />);

      const { changeDirectionPrompt } = getAutopilotHandlers();
      expect(typeof changeDirectionPrompt).toBe('function');

      act(() => {
        changeDirectionPrompt();
      });

      const statusNote = await screen.findByTestId('autopilot-status-note');
      expect(statusNote).toHaveTextContent('Autopilot must be running before changing direction.');
    });

    it('shows status note when undo last change is requested without an active session', async () => {
      useAppState.mockReturnValue({
        currentProject: { id: 654 },
        jobState: { jobsByProject: {} },
        setPreviewPanelTab: vi.fn()
      });

      render(<ChatPanel width={320} side="left" />);

      const { undoLastChangePrompt } = getAutopilotHandlers();
      expect(typeof undoLastChangePrompt).toBe('function');

      act(() => {
        undoLastChangePrompt();
      });

      const statusNote = await screen.findByTestId('autopilot-status-note');
      expect(statusNote).toHaveTextContent('Autopilot must be running before undoing a change.');
    });

    it('prefills the change direction prompt when autopilot is running', async () => {
      await startAutopilotSession();
      const { changeDirectionPrompt } = getAutopilotHandlers();

      act(() => {
        changeDirectionPrompt();
      });

      await waitFor(() => {
        expect(screen.getByTestId('chat-input').value).toBe('Please change direction by ');
      });
    });

    it('prefills the undo last change prompt when autopilot is running', async () => {
      await startAutopilotSession();
      const { undoLastChangePrompt } = getAutopilotHandlers();

      act(() => {
        undoLastChangePrompt();
      });

      await waitFor(() => {
        expect(screen.getByTestId('chat-input').value)
          .toBe('Undo the last change and explain what will be rolled back.');
      });
    });

    it('preserves existing input when change direction is requested with content present', async () => {
      await startAutopilotSession();
      const { changeDirectionPrompt } = getAutopilotHandlers();

      const input = screen.getByTestId('chat-input');
      await userEvent.type(input, 'Already drafting');

      act(() => {
        changeDirectionPrompt();
      });

      await waitFor(() => {
        expect(screen.getByTestId('chat-input').value).toBe('Already drafting');
      });
    });
  });

  describe('Autopilot Job Log Limits', () => {
    const buildAutopilotAppState = (jobStateOverrides) => ({
      currentProject: { id: 123 },
      jobState: jobStateOverrides,
      setPreviewPanelTab: vi.fn(),
      stageAiChange: vi.fn(),
      startAutomationJob: vi.fn(),
      markTestRunIntent: vi.fn(),
      requestEditorFocus: vi.fn(),
      syncBranchOverview: vi.fn(),
      workingBranches: {}
    });

    const mockAutopilotResume = () => {
      goalsApi.agentAutopilotResume.mockResolvedValueOnce({
        success: true,
        resumed: [
          {
            id: 'session-log-limits',
            status: 'running',
            statusMessage: 'Active',
            events: []
          }
        ]
      });
      goalsApi.agentAutopilotStatus.mockResolvedValue({
        session: { id: 'session-log-limits', status: 'running', events: [] }
      });
    };

    it('skips jobs whose sliced logs produce no entries', async () => {
      const weirdLogs = [
        { stream: 'stdout', message: 'Alpha' },
        { stream: 'stdout', message: 'Beta' }
      ];
      weirdLogs.slice = () => [];

      mockAutopilotResume();

      useAppState.mockReturnValue(buildAutopilotAppState({
        jobsByProject: {
          '123': {
            jobs: [
              {
                type: 'test-run',
                displayName: 'Weird Job',
                status: 'running',
                logs: weirdLogs
              },
              {
                type: 'test-run',
                displayName: 'Normal Job',
                status: 'running',
                logs: [{ stream: 'stdout', message: 'Visible log' }]
              }
            ]
          }
        }
      }));

      render(<ChatPanel width={320} side="left" />);

      const jobLogs = await screen.findByTestId('chat-job-logs');
      expect(within(jobLogs).getByText('Normal Job • running')).toBeInTheDocument();
      expect(within(jobLogs).queryByText('Weird Job • running')).not.toBeInTheDocument();
    });

    it('respects the total job log line limit', async () => {
      const buildJob = (index) => ({
        type: 'test-run',
        displayName: `Heavy Job ${index + 1}`,
        status: 'running',
        logs: Array.from({ length: 80 }, (_, entryIdx) => ({
          stream: 'stdout',
          message: `Heavy Job ${index + 1} Log ${entryIdx + 1}`
        }))
      });

      mockAutopilotResume();

      useAppState.mockReturnValue(buildAutopilotAppState({
        jobsByProject: {
          '123': {
            jobs: Array.from({ length: 4 }, (_, idx) => buildJob(idx))
          }
        }
      }));

      render(<ChatPanel width={320} side="left" />);

      const jobLogs = await screen.findByTestId('chat-job-logs');
      expect(within(jobLogs).getByText('Heavy Job 4 • running')).toBeInTheDocument();
      expect(within(jobLogs).getByText('Heavy Job 4 Log 40')).toBeInTheDocument();
      expect(within(jobLogs).queryByText('Heavy Job 4 Log 41')).not.toBeInTheDocument();
    });
  });

  describe('Component Resilience', () => {
    it('handles null project gracefully', () => {
      useAppState.mockReturnValue({
        currentProject: null,
        jobState: { jobsByProject: {} },
        setPreviewPanelTab: vi.fn()
      });

      render(<ChatPanel width={320} side="left" />);
      expect(screen.getByTestId('chat-panel')).toBeInTheDocument();
    });

    it('handles missing jobState gracefully', () => {
      useAppState.mockReturnValue({
        currentProject: { id: 123 },
        jobState: null,
        setPreviewPanelTab: vi.fn()
      });

      render(<ChatPanel width={320} side="left" />);
      expect(screen.getByTestId('chat-panel')).toBeInTheDocument();
    });

    it('handles malformed job data gracefully', () => {
      useAppState.mockReturnValue({
        currentProject: { id: 123 },
        jobState: {
          jobsByProject: {
            '123': {
              jobs: [
                null,
                undefined,
                {},
                { type: 'test-run' }, // Missing other fields
                { type: 'test-run', logs: 'not-an-array' }
              ]
            }
          }
        },
        setPreviewPanelTab: vi.fn()
      });

      render(<ChatPanel width={320} side="left" />);
      expect(screen.getByTestId('chat-panel')).toBeInTheDocument();
    });
  });
});
