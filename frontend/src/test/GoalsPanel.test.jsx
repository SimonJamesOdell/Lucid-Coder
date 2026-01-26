import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import GoalsPanel, { compareGoalsForDisplay } from '../components/GoalsPanel.jsx';
import { useAppState } from '../context/AppStateContext.jsx';
import * as goalsApi from '../utils/goalsApi.js';

vi.mock('../context/AppStateContext.jsx', () => ({
  useAppState: vi.fn()
}));

vi.mock('../utils/goalsApi.js');

const project = { id: 1, name: 'Demo Project' };

describe('GoalsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows empty state when no project selected', () => {
    useAppState.mockReturnValue({ currentProject: null, jobState: null });

    const { container } = render(<GoalsPanel mode="tab" />);

    expect(screen.getByTestId('goals-tab')).toBeInTheDocument();
    expect(screen.getByTestId('goals-modal-empty')).toHaveTextContent('Select a project');
  });

  it('ignores goals-updated events when no project is selected', () => {
    useAppState.mockReturnValue({ currentProject: null, jobState: null });

    const { container } = render(<GoalsPanel mode="tab" />);

    window.dispatchEvent(new CustomEvent('lucidcoder:goals-updated', { detail: { projectId: 1 } }));

    expect(goalsApi.fetchGoals).not.toHaveBeenCalled();
  });

  it('always loads goals including completed/archived', async () => {
    useAppState.mockReturnValue({ currentProject: project, jobState: null });
    goalsApi.fetchGoals.mockResolvedValue([]);

    const { container } = render(<GoalsPanel mode="tab" />);

    await waitFor(() => {
      expect(goalsApi.fetchGoals).toHaveBeenCalledWith(1, { includeArchived: true });
    });
  });

  it('shows empty copy for current and past when there are no goals', async () => {
    useAppState.mockReturnValue({ currentProject: project, jobState: null });
    // Exercise the non-array fallback path in loadGoals.
    goalsApi.fetchGoals.mockResolvedValueOnce(null);

    const user = userEvent.setup();
    render(<GoalsPanel mode="tab" />);

    expect(await screen.findByTestId('goals-tab-filter-current')).toBeInTheDocument();
    expect(await screen.findByTestId('goals-tab-empty')).toHaveTextContent('No current goals yet.');

    await user.click(screen.getByTestId('goals-tab-filter-past'));
    expect(await screen.findByTestId('goals-tab-empty')).toHaveTextContent('No past goals yet.');

    await user.click(screen.getByTestId('goals-tab-filter-current'));
    expect(await screen.findByTestId('goals-tab-empty')).toHaveTextContent('No current goals yet.');
  });

  it('renders Unknown status without an extra phase class when status is missing', async () => {
    useAppState.mockReturnValue({ currentProject: project, jobState: null });
    goalsApi.fetchGoals.mockResolvedValue([
      { id: 50, prompt: 'Mystery goal', parentGoalId: null }
    ]);

    render(<GoalsPanel mode="tab" />);

    await screen.findByTestId('goals-modal-goal-50');
    const status = screen.getByLabelText('Status: Unknown');
    expect(status.className).toBe('goals-modal-goal-status');
  });

  it('shows an error when goals fail to load', async () => {
    useAppState.mockReturnValue({ currentProject: project, jobState: null });
    goalsApi.fetchGoals.mockRejectedValueOnce(new Error('network down'));

    render(<GoalsPanel mode="tab" />);

    expect(await screen.findByTestId('goals-tab-filter-current')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load goals');
  });

  it('shows current/past tabs and filters completed goal groups', async () => {
    useAppState.mockReturnValue({ currentProject: project, jobState: null });
    goalsApi.fetchGoals.mockResolvedValue([
      { id: 1, prompt: 'Current goal', status: 'planning', parentGoalId: null },
      { id: 2, prompt: 'Past goal', status: 'ready', parentGoalId: null }
    ]);

    const user = userEvent.setup();
    render(<GoalsPanel mode="tab" />);

    expect(await screen.findByTestId('goals-tab-filter-current')).toBeInTheDocument();
    expect(screen.getByText('Current goal')).toBeInTheDocument();
    expect(screen.queryByText('Past goal')).toBeNull();

    await user.click(screen.getByTestId('goals-tab-filter-past'));
    await waitFor(() => {
      expect(screen.getByText('Past goal')).toBeInTheDocument();
    });
    expect(screen.queryByText('Current goal')).toBeNull();
  });

  it('treats merged lifecycle goals as past even when status is not ready', async () => {
    useAppState.mockReturnValue({ currentProject: project, jobState: null });
    goalsApi.fetchGoals.mockResolvedValue([
      { id: 10, prompt: 'Still working', status: 'planning', parentGoalId: null },
      { id: 11, prompt: 'Merged lifecycle', status: 'planning', lifecycleState: 'merged', parentGoalId: null }
    ]);

    const user = userEvent.setup();
    render(<GoalsPanel mode="tab" />);

    expect(await screen.findByTestId('goals-tab-filter-current')).toBeInTheDocument();
    expect(screen.getByText('Still working')).toBeInTheDocument();
    expect(screen.queryByText('Merged lifecycle')).toBeNull();

    await user.click(screen.getByTestId('goals-tab-filter-past'));
    await waitFor(() => {
      expect(screen.getByText('Merged lifecycle')).toBeInTheDocument();
    });
    expect(screen.queryByText('Still working')).toBeNull();
  });

  it('past goal groups are collapsed by default and can be expanded/collapsed', async () => {
    useAppState.mockReturnValue({ currentProject: project, jobState: null });
    goalsApi.fetchGoals.mockResolvedValue([
      { id: 30, prompt: 'Past parent', status: 'ready', parentGoalId: null },
      { id: 31, prompt: 'Past child', status: 'ready', parentGoalId: 30 }
    ]);

    const user = userEvent.setup();
    render(<GoalsPanel mode="tab" />);

    await user.click(await screen.findByTestId('goals-tab-filter-past'));

    expect(screen.getByText('Past parent')).toBeInTheDocument();
    expect(screen.queryByText('Past child')).toBeNull();

    await user.click(await screen.findByTestId('goals-past-toggle-30'));
    expect(await screen.findByText('Past child')).toBeInTheDocument();

    await user.click(await screen.findByTestId('goals-past-toggle-30'));
    await waitFor(() => {
      expect(screen.queryByText('Past child')).toBeNull();
    });
  });

  it('ignores past toggle requests for invalid goal ids', async () => {
    useAppState.mockReturnValue({ currentProject: project, jobState: null });
    goalsApi.fetchGoals.mockResolvedValue([
      { id: 40, prompt: 'Past root', status: 'ready', parentGoalId: null },
      { id: 41, prompt: 'Past nested', status: 'ready', parentGoalId: 40 }
    ]);

    const user = userEvent.setup();
    render(<GoalsPanel mode="tab" />);
    await user.click(await screen.findByTestId('goals-tab-filter-past'));

    expect(screen.queryByText('Past nested')).toBeNull();

    const toggleFn = GoalsPanel.__testHooks?.latestTogglePastGoalExpanded;
    expect(typeof toggleFn).toBe('function');

    toggleFn('not-a-number');
    await Promise.resolve();
    expect(screen.queryByText('Past nested')).toBeNull();
  });

  it('modal mode does not render tab filters (covers tab-mode guards)', async () => {
    useAppState.mockReturnValue({ currentProject: project, jobState: null });
    goalsApi.fetchGoals.mockResolvedValue([]);

    const user = userEvent.setup();
    render(<GoalsPanel mode="modal" isOpen onRequestClose={vi.fn()} />);

    await waitFor(() => {
      expect(goalsApi.fetchGoals).toHaveBeenCalledWith(project.id, { includeArchived: true });
    });

    await user.click(screen.getByTestId('goals-modal-refresh'));
    await waitFor(() => {
      expect(goalsApi.fetchGoals).toHaveBeenCalledTimes(2);
    });

    expect(screen.getByTestId('goals-modal')).toBeInTheDocument();
    expect(screen.queryByTestId('goals-tab-filter-current')).toBeNull();
    expect(screen.queryByTestId('goals-tab-filter-past')).toBeNull();
    expect(screen.getByText('Goals', { exact: true })).toBeInTheDocument();
  });

  it('refreshes goals when the automation flow signals goals were updated', async () => {
    useAppState.mockReturnValue({ currentProject: project, jobState: null });

    goalsApi.fetchGoals
      .mockResolvedValueOnce([
        { id: 101, prompt: 'Last step', status: 'verifying', parentGoalId: 100 },
        { id: 100, prompt: 'Parent', status: 'planning', parentGoalId: null }
      ])
      .mockResolvedValueOnce([
        { id: 101, prompt: 'Last step', status: 'ready', parentGoalId: 100 },
        { id: 100, prompt: 'Parent', status: 'planning', parentGoalId: null }
      ]);

    const { container } = render(<GoalsPanel mode="tab" />);

    // Initial render shows the verifying badge.
    const childButton = await screen.findByTestId('goals-modal-goal-101');
    expect(within(childButton).getByText('Verifying')).toBeInTheDocument();

    window.dispatchEvent(new CustomEvent('lucidcoder:goals-updated', { detail: { projectId: 1 } }));

    // The goal group transitions to "past" once completed.
    const user = userEvent.setup();
    await user.click(screen.getByTestId('goals-tab-filter-past'));

    await user.click(await screen.findByTestId('goals-past-toggle-100'));

    await waitFor(() => {
      expect(within(screen.getByTestId('goals-modal-goal-101')).getByText('Completed')).toBeInTheDocument();
    });
  });

  it('ignores goals-updated events for other projects and removes the listener on unmount', async () => {
    useAppState.mockReturnValue({ currentProject: project, jobState: null });
    goalsApi.fetchGoals.mockResolvedValue([]);

    const { unmount } = render(<GoalsPanel mode="tab" />);

    await waitFor(() => {
      expect(goalsApi.fetchGoals).toHaveBeenCalledWith(1, { includeArchived: true });
    });

    const callCountAfterInitialLoad = goalsApi.fetchGoals.mock.calls.length;

    // Wrong project id should be ignored.
    window.dispatchEvent(new CustomEvent('lucidcoder:goals-updated', { detail: { projectId: 999 } }));

    await Promise.resolve();
    expect(goalsApi.fetchGoals.mock.calls.length).toBe(callCountAfterInitialLoad);

    // Listener is removed on unmount.
    unmount();
    window.dispatchEvent(new CustomEvent('lucidcoder:goals-updated', { detail: { projectId: 1 } }));
    await Promise.resolve();

    expect(goalsApi.fetchGoals.mock.calls.length).toBe(callCountAfterInitialLoad);
  });

  it('bails out of goals-updated subscription when window event APIs are missing', async () => {
    useAppState.mockReturnValue({ currentProject: project, jobState: null });
    goalsApi.fetchGoals.mockResolvedValue([]);

    const originalAdd = window.addEventListener;
    const originalRemove = window.removeEventListener;

    // Force the effect to hit its guard path.
    // eslint-disable-next-line no-param-reassign
    window.addEventListener = undefined;
    // eslint-disable-next-line no-param-reassign
    window.removeEventListener = undefined;

    render(<GoalsPanel mode="tab" />);

    await waitFor(() => {
      expect(goalsApi.fetchGoals).toHaveBeenCalledWith(1, { includeArchived: true });
    });

    const callsAfterInitial = goalsApi.fetchGoals.mock.calls.length;
    window.dispatchEvent(new CustomEvent('lucidcoder:goals-updated', { detail: { projectId: 1 } }));
    await Promise.resolve();

    expect(goalsApi.fetchGoals.mock.calls.length).toBe(callsAfterInitial);

    // Restore window APIs for subsequent tests.
    // eslint-disable-next-line no-param-reassign
    window.addEventListener = originalAdd;
    // eslint-disable-next-line no-param-reassign
    window.removeEventListener = originalRemove;
  });

  it('normalizes done/completed to ready and shows progress when parent has no children', async () => {
    useAppState.mockReturnValue({ currentProject: project, jobState: null });
    goalsApi.fetchGoals.mockResolvedValue([
      { id: 10, prompt: 'Ship it', status: 'done', parentGoalId: null }
    ]);

    const user = userEvent.setup();
    render(<GoalsPanel mode="tab" />);

    await user.click(await screen.findByTestId('goals-tab-filter-past'));

    await waitFor(() => {
      expect(screen.getByText('Ship it')).toBeInTheDocument();
    });

    // done -> ready, also triggers parent-only progress 1/1
    const goalButton = screen.getByTestId('goals-modal-goal-10');
    expect(within(goalButton).getByText('Completed')).toBeInTheDocument();
    expect(within(goalButton).getByText('1/1')).toBeInTheDocument();
    expect(within(goalButton).getByText('Ship it')).toBeInTheDocument();
  });

  it("shows 'Failed' label for failed goals", async () => {
    useAppState.mockReturnValue({ currentProject: project, jobState: null });
    goalsApi.fetchGoals.mockResolvedValue([
      { id: 11, prompt: 'Investigate bug', status: 'failed', parentGoalId: null }
    ]);

    const user = userEvent.setup();
    render(<GoalsPanel mode="tab" />);

    await user.click(await screen.findByTestId('goals-tab-filter-past'));

    await waitFor(() => {
      expect(screen.getByText('Investigate bug')).toBeInTheDocument();
    });

    const goalButton = screen.getByTestId('goals-modal-goal-11');
    expect(within(goalButton).getByText('Failed')).toBeInTheDocument();
  });

  it('computes progress ratio for parent goals with children', () => {
    const { computeGoalProgress } = GoalsPanel.__testHooks;
    const goal = {
      status: 'planning',
      children: [
        { status: 'ready', children: [] },
        { status: 'planning', children: [] }
      ]
    };

    const result = computeGoalProgress(goal);

    expect(result).toMatchObject({ done: 1, total: 2 });
    expect(result.ratio).toBe(0.5);
  });

  it('treats non-array children as empty when rendering', async () => {
    useAppState.mockReturnValue({ currentProject: project, jobState: null });
    const goalsPayload = [{ id: 41, prompt: 'Parent goal', status: 'planning', parentGoalId: null }];
    goalsApi.fetchGoals.mockResolvedValue(goalsPayload);

    const originalIsArray = Array.isArray;
    const isArraySpy = vi.spyOn(Array, 'isArray').mockImplementation((value) => {
      if (originalIsArray(value) && value.length === 0) {
        return false;
      }
      return originalIsArray(value);
    });

    const { container } = render(<GoalsPanel mode="tab" />);

    await waitFor(() => {
      expect(screen.getByText('Parent goal')).toBeInTheDocument();
    });

    expect(container.querySelector('.goals-modal-children')).toBeNull();

    isArraySpy.mockRestore();
  });

  it('does not mark goals done when there is no progress and status is not ready', async () => {
    useAppState.mockReturnValue({ currentProject: project, jobState: null });
    goalsApi.fetchGoals.mockResolvedValue([
      { id: 15, prompt: 'Still planning', status: 'planning', parentGoalId: null }
    ]);

    render(<GoalsPanel mode="tab" />);

    await waitFor(() => {
      expect(screen.getByText('Still planning')).toBeInTheDocument();
    });

    const goalButton = screen.getByTestId('goals-modal-goal-15');
    expect(goalButton.className).not.toMatch(/done/);
    expect(within(goalButton).queryByText('0/0')).not.toBeInTheDocument();
    expect(goalButton.querySelector('.goals-modal-progressbar')).toBeNull();
  });

  it('clears all root goals when confirmed', async () => {
    useAppState.mockReturnValue({ currentProject: project, jobState: null });
    goalsApi.fetchGoals
      .mockResolvedValueOnce([
        { id: 10, prompt: 'Parent goal', status: 'planning', parentGoalId: null },
        { id: 11, prompt: 'Child goal', status: 'planning', parentGoalId: 10 },
        { id: 12, prompt: 'Orphan goal', status: 'planning', parentGoalId: null }
      ])
      .mockResolvedValueOnce([]);
    goalsApi.deleteGoal.mockResolvedValue({ success: true, deletedGoalIds: [10, 11, 12] });
    const user = userEvent.setup();
    render(<GoalsPanel mode="tab" />);

    await user.click(await screen.findByTestId('goals-clear-goals'));
    await user.click(await screen.findByTestId('modal-confirm'));

    await waitFor(() => {
      expect(goalsApi.deleteGoal).toHaveBeenCalledWith(10);
      expect(goalsApi.deleteGoal).toHaveBeenCalledWith(12);
    });

    await waitFor(() => {
      expect(goalsApi.fetchGoals).toHaveBeenCalledTimes(2);
    });

  });

  it('renders child goals in creation order (oldest first)', async () => {
    useAppState.mockReturnValue({ currentProject: project, jobState: null });
    goalsApi.fetchGoals.mockResolvedValue([
      { id: 10, prompt: 'Parent goal', status: 'planning', parentGoalId: null, createdAt: '2026-01-01T00:00:00.000Z' },
      // Returned in reverse order (newest first)
      { id: 13, prompt: 'Third', status: 'planning', parentGoalId: 10, createdAt: '2026-01-01T00:00:03.000Z' },
      { id: 12, prompt: 'Second', status: 'planning', parentGoalId: 10, createdAt: '2026-01-01T00:00:02.000Z' },
      { id: 11, prompt: 'First', status: 'planning', parentGoalId: 10, createdAt: '2026-01-01T00:00:01.000Z' }
    ]);

    render(<GoalsPanel mode="tab" />);

    await waitFor(() => {
      expect(screen.getByText('Parent goal')).toBeInTheDocument();
    });

    const parentButton = screen.getByTestId('goals-modal-goal-10');
    const group = parentButton.closest('.goals-modal-goal-group');
    expect(group).toBeTruthy();

    const titles = Array.from(group.querySelectorAll('.goals-modal-children .goals-modal-goal-title'))
      .map((node) => node.textContent);

    expect(titles).toEqual(['First', 'Second', 'Third']);
  });

  it('skips goals that are missing ids when building the tree', async () => {
    useAppState.mockReturnValue({ currentProject: project, jobState: null });
    goalsApi.fetchGoals.mockResolvedValue([
      { prompt: 'Missing id', status: 'planning', parentGoalId: null },
      { id: 21, prompt: 'Valid goal', status: 'planning', parentGoalId: null }
    ]);

    render(<GoalsPanel mode="tab" />);

    await waitFor(() => {
      expect(screen.getByText('Valid goal')).toBeInTheDocument();
    });

    expect(screen.queryByText('Missing id')).not.toBeInTheDocument();
  });

  it('renders nested child goals with child styling', async () => {
    useAppState.mockReturnValue({ currentProject: project, jobState: null });
    goalsApi.fetchGoals.mockResolvedValue([
      { id: 30, prompt: 'Root', status: 'planning', parentGoalId: null },
      { id: 31, prompt: 'Child', status: 'ready', parentGoalId: 30 },
      { id: 32, prompt: 'Grandchild', status: 'ready', parentGoalId: 31 }
    ]);

    const user = userEvent.setup();
    render(<GoalsPanel mode="tab" />);

    await user.click(await screen.findByTestId('goals-tab-filter-past'));

    await user.click(await screen.findByTestId('goals-past-toggle-30'));

    await waitFor(() => {
      expect(screen.getByText('Root')).toBeInTheDocument();
    });

    const childButton = screen.getByTestId('goals-modal-goal-31');
    const grandchildButton = screen.getByTestId('goals-modal-goal-32');

    expect(childButton.className).toMatch(/child/);
    expect(grandchildButton.className).toMatch(/child/);
  });

  it('sorts child goals with createdAt ahead of those without', async () => {
    useAppState.mockReturnValue({ currentProject: project, jobState: null });
    goalsApi.fetchGoals.mockResolvedValue([
      { id: 10, prompt: 'Parent goal', status: 'planning', parentGoalId: null, createdAt: '2026-01-01T00:00:00.000Z' },
      // One child missing createdAt should be sorted after children with valid createdAt.
      { id: 11, prompt: 'No timestamp', status: 'planning', parentGoalId: 10 },
      { id: 12, prompt: 'Has timestamp', status: 'planning', parentGoalId: 10, createdAt: '2026-01-01T00:00:01.000Z' }
    ]);

    render(<GoalsPanel mode="tab" />);

    await waitFor(() => {
      expect(screen.getByText('Parent goal')).toBeInTheDocument();
    });

    const parentButton = screen.getByTestId('goals-modal-goal-10');
    const group = parentButton.closest('.goals-modal-goal-group');
    expect(group).toBeTruthy();

    const titles = Array.from(group.querySelectorAll('.goals-modal-children .goals-modal-goal-title'))
      .map((node) => node.textContent);

    expect(titles).toEqual(['Has timestamp', 'No timestamp']);
  });

  it('compareGoalsForDisplay orders timestamped goals before untimestamped goals', () => {
    expect(compareGoalsForDisplay(
      { id: 1, createdAt: '2026-01-01T00:00:01.000Z' },
      { id: 2 }
    )).toBeLessThan(0);

    expect(compareGoalsForDisplay(
      { id: 1 },
      { id: 2, createdAt: '2026-01-01T00:00:01.000Z' }
    )).toBeGreaterThan(0);

    expect(compareGoalsForDisplay(
      { id: 1 },
      { id: 2 }
    )).toBeLessThan(0);

    expect(compareGoalsForDisplay(
      {},
      { id: 1 }
    )).toBeLessThan(0);

    expect(compareGoalsForDisplay(
      { id: 1 },
      {}
    )).toBeGreaterThan(0);
  });

  it('does not clear goals when confirmation is declined', async () => {
    useAppState.mockReturnValue({ currentProject: project, jobState: null });
    goalsApi.fetchGoals.mockResolvedValue([
      { id: 40, prompt: 'Delete me', status: 'planning', parentGoalId: null }
    ]);

    const user = userEvent.setup();
    render(<GoalsPanel mode="tab" />);

    await user.click(await screen.findByTestId('goals-clear-goals'));
    await user.click(await screen.findByTestId('modal-cancel'));

    expect(goalsApi.deleteGoal).not.toHaveBeenCalled();
  });

  it('shows an error when clear goals fails', async () => {
    useAppState.mockReturnValue({ currentProject: project, jobState: null });
    goalsApi.fetchGoals.mockResolvedValue([
      { id: 42, prompt: 'Cannot remove', status: 'planning', parentGoalId: null }
    ]);
    goalsApi.deleteGoal.mockRejectedValue(new Error('nope'));

    const user = userEvent.setup();
    render(<GoalsPanel mode="tab" />);

    await user.click(await screen.findByTestId('goals-clear-goals'));
    await user.click(await screen.findByTestId('modal-confirm'));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Failed to clear goals');
    });
  });

  it('polls for goals while a job is active and ignores silent failures', async () => {
    useAppState.mockReturnValue({
      currentProject: project,
      jobState: {
        jobsByProject: {
          '1': {
            jobs: [null, { id: 'job-final', status: 'succeeded' }, { id: 'job-1', status: 'running' }]
          }
        }
      }
    });

    let intervalCallback = null;
    const setIntervalSpy = vi
      .spyOn(window, 'setInterval')
      .mockImplementation((callback, ms) => {
        // Only capture the GoalsPanel polling interval (1000ms).
        if (ms === 1000) {
          intervalCallback = callback;
          return 123;
        }
        return 999;
      });
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval').mockImplementation(() => {});

    const goal = { id: 60, prompt: 'Stays put', status: 'planning', parentGoalId: null };
    let callCount = 0;
    goalsApi.fetchGoals.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 3) {
        throw new Error('silent failure');
      }
      return [goal];
    });

    const { unmount } = render(<GoalsPanel mode="tab" />);

    expect(await screen.findByText('Stays put')).toBeInTheDocument();

    await waitFor(() => {
      expect(goalsApi.fetchGoals).toHaveBeenCalledWith(1, { includeArchived: true });
    });

    expect(intervalCallback).toBeTypeOf('function');
    // Trigger the scheduled tick: this should be a silent refresh.
    intervalCallback();
    await Promise.resolve();

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Stays put')).toBeInTheDocument();

    // After unmount, wait for cleanup so the cancelled guard is active.
    unmount();
    await waitFor(() => {
      expect(clearIntervalSpy).toHaveBeenCalledWith(123);
    });

    const callCountAfterUnmount = callCount;
    intervalCallback();
    await Promise.resolve();
    expect(callCount).toBe(callCountAfterUnmount);

    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  it('disables Refresh while loading goals', async () => {
    useAppState.mockReturnValue({ currentProject: project, jobState: null });

    // Keep the initial goals request pending so isLoading stays true.
    goalsApi.fetchGoals.mockImplementation(() => new Promise(() => {}));

    render(<GoalsPanel mode="modal" isOpen={true} onRequestClose={vi.fn()} />);

    const refresh = screen.getByTestId('goals-modal-refresh');
    await waitFor(() => {
      expect(refresh).toBeDisabled();
    });
  });

  it('does not start polling when all jobs are in a final state', async () => {
    useAppState.mockReturnValue({
      currentProject: project,
      jobState: {
        jobsByProject: {
          '1': {
            jobs: [{ id: 'job-final', status: 'succeeded' }]
          }
        }
      }
    });
    goalsApi.fetchGoals.mockResolvedValue([]);

    const setIntervalSpy = vi.spyOn(window, 'setInterval');

    render(<GoalsPanel mode="tab" />);
    await waitFor(() => {
      expect(goalsApi.fetchGoals).toHaveBeenCalled();
    });

    const goalsPanelPollingCalls = setIntervalSpy.mock.calls.filter((call) => call?.[1] === 1000);
    expect(goalsPanelPollingCalls).toHaveLength(0);
    setIntervalSpy.mockRestore();
  });

  it('stops polling after the active job completes (cancelled tick no-ops)', async () => {
    const runningState = {
      currentProject: project,
      jobState: {
        jobsByProject: {
          '1': {
            jobs: [{ id: 'job-1', status: 'running' }]
          }
        }
      }
    };

    const finalState = {
      currentProject: project,
      jobState: {
        jobsByProject: {
          '1': {
            jobs: [{ id: 'job-1', status: 'succeeded' }]
          }
        }
      }
    };

    let appState = runningState;
    useAppState.mockImplementation(() => appState);

    let intervalCallback = null;
    const setIntervalSpy = vi
      .spyOn(window, 'setInterval')
      .mockImplementation((callback) => {
        intervalCallback = callback;
        return 456;
      });
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval').mockImplementation(() => {});

    goalsApi.fetchGoals.mockResolvedValue([]);

    const { rerender } = render(<GoalsPanel mode="tab" />);

    await waitFor(() => {
      expect(setIntervalSpy).toHaveBeenCalled();
    });
    expect(intervalCallback).toBeTypeOf('function');

    intervalCallback();
    await Promise.resolve();
    const callCountBefore = goalsApi.fetchGoals.mock.calls.length;

    // Trigger effect cleanup by making the active job disappear.
    appState = finalState;
    rerender(<GoalsPanel mode="tab" />);

    await waitFor(() => {
      expect(clearIntervalSpy).toHaveBeenCalledWith(456);
    });

    // When the active job finishes, GoalsPanel performs a final refresh so the
    // last phase transition (e.g. verifying -> ready) is visible.
    await waitFor(() => {
      expect(goalsApi.fetchGoals.mock.calls.length).toBe(callCountBefore + 1);
    });

    intervalCallback();
    await Promise.resolve();

    expect(goalsApi.fetchGoals.mock.calls.length).toBe(callCountBefore + 1);

    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  it('modal close button calls onRequestClose', async () => {
    useAppState.mockReturnValue({ currentProject: project, jobState: null });
    goalsApi.fetchGoals.mockResolvedValue([]);

    const onRequestClose = vi.fn();
    const user = userEvent.setup();

    render(<GoalsPanel mode="modal" isOpen={true} onRequestClose={onRequestClose} />);

    await user.click(await screen.findByTestId('goals-modal-close'));
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  it('modal defaults isOpen=true when omitted', async () => {
    useAppState.mockReturnValue({ currentProject: project, jobState: null });
    goalsApi.fetchGoals.mockResolvedValue([]);

    render(<GoalsPanel mode="modal" onRequestClose={vi.fn()} />);
    expect(await screen.findByTestId('goals-modal')).toBeInTheDocument();
  });

  it('opens the clear goals confirmation dialog', async () => {
    useAppState.mockReturnValue({ currentProject: project, jobState: null });

    goalsApi.fetchGoals
      .mockResolvedValueOnce([{ id: 77, prompt: 'SSR remove', status: 'planning', parentGoalId: null }])
      .mockResolvedValueOnce([]);
    goalsApi.deleteGoal.mockResolvedValue();

    const user = userEvent.setup();
    render(<GoalsPanel mode="tab" />);

    await user.click(await screen.findByTestId('goals-clear-goals'));

    expect(await screen.findByTestId('modal-content')).toBeInTheDocument();
  });

  it('modal: locks body scroll, closes on Escape/backdrop, and unlocks on close', async () => {
    useAppState.mockReturnValue({ currentProject: project, jobState: null });
    goalsApi.fetchGoals.mockResolvedValue([]);

    const onRequestClose = vi.fn();

    const { rerender } = render(
      <GoalsPanel mode="modal" isOpen={true} onRequestClose={onRequestClose} />
    );

    expect(screen.getByTestId('goals-modal')).toBeInTheDocument();
    await waitFor(() => {
      expect(document.body.style.overflow).toBe('hidden');
    });

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onRequestClose).toHaveBeenCalledTimes(1);

    const backdrop = screen.getByTestId('goals-modal');
    const panel = screen.getByText('Goals & Progress').closest('.goals-modal-panel');
    expect(panel).toBeTruthy();

    // Clicking inside the panel should not close.
    panel.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(onRequestClose).toHaveBeenCalledTimes(1);

    // Clicking the backdrop itself closes.
    fireEvent.click(backdrop);
    expect(onRequestClose).toHaveBeenCalledTimes(2);

    rerender(<GoalsPanel mode="modal" isOpen={false} onRequestClose={onRequestClose} />);

    expect(screen.queryByTestId('goals-modal')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(document.body.style.overflow).toBe('unset');
    });
  });
});

describe('GoalsPanel helper hooks', () => {
  const hooks = GoalsPanel.__testHooks;

  it('getGoalTitle falls back to prompt and default label', () => {
    expect(hooks.getGoalTitle(null)).toBe('Goal');
    expect(hooks.getGoalTitle({ title: '  Feature Name  ' })).toBe('Feature Name');
    expect(hooks.getGoalTitle({ title: '  ', prompt: ' Ship feature ' })).toBe('Ship feature');
    expect(hooks.getGoalTitle({ title: '  ', prompt: '   ' })).toBe('Goal');
    expect(hooks.getGoalTitle({ title: '', prompt: null })).toBe('Goal');
  });

  it('normalizePhase preserves known workflow stages', () => {
    expect(hooks.normalizePhase(' implementing ')).toBe('implementing');
    expect(hooks.normalizePhase('Verifying')).toBe('verifying');
  });

  it('normalizePhase and formatPhaseLabel handle known aliases', () => {
    expect(hooks.normalizePhase(' DONE ')).toBe('ready');
    expect(hooks.normalizePhase('Completed')).toBe('ready');
    expect(hooks.normalizePhase('done')).toBe('ready');
    expect(hooks.normalizePhase('custom-phase')).toBe('custom-phase');
    expect(hooks.normalizePhase('')).toBe('');
    expect(hooks.formatPhaseLabel('ready')).toBe('Completed');
    expect(hooks.formatPhaseLabel('failed')).toBe('Failed');
    expect(hooks.formatPhaseLabel('planning')).toBe('Planning');
  });

  it('computeGoalProgress reports parent-only completion and child ratios', () => {
    const parent = { id: 1, status: 'done', children: [] };
    expect(hooks.computeGoalProgress(parent)).toEqual({ done: 1, total: 1, ratio: 1 });

    const withChildren = hooks.computeGoalProgress({
      id: 4,
      status: 'implementing',
      children: [
        { id: 2, status: 'ready', children: [] },
        { id: 3, status: 'failed', children: null }
      ]
    });
    expect(withChildren.done).toBe(1);
    expect(withChildren.total).toBe(2);
    expect(withChildren.ratio).toBe(0.5);
  });

  it('computeGoalProgress ignores non-array children and reports zero progress', () => {
    const result = hooks.computeGoalProgress({ id: 9, status: 'planning', children: 'nope' });
    expect(result).toEqual({ done: 0, total: 0, ratio: 0 });
  });

  it('splitGoalTreeForTabs skips null roots', () => {
    const result = hooks.splitGoalTreeForTabs([null, { id: 1, status: 'ready' }]);
    expect(result.current).toEqual([]);
    expect(result.past).toHaveLength(1);
    expect(result.past[0].id).toBe(1);
  });
});
