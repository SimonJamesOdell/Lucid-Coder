import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import GoalsModal from '../components/GoalsModal.jsx';
import { useAppState } from '../context/AppStateContext';
import { deleteGoal, fetchGoalWithTasks, fetchGoals } from '../utils/goalsApi';

vi.mock('../context/AppStateContext', () => ({
  useAppState: vi.fn(),
}));

vi.mock('../utils/goalsApi', () => ({
  fetchGoals: vi.fn(),
  fetchGoalWithTasks: vi.fn(),
  deleteGoal: vi.fn(),
}));

describe('GoalsModal', () => {
  beforeEach(() => {
  planMetaGoal: vi.fn(),
    vi.clearAllMocks();
    document.body.style.overflow = 'unset';

    useAppState.mockReturnValue({
      currentProject: { id: 123, name: 'Demo Project' },
    });

    fetchGoals.mockResolvedValue([]);
    fetchGoalWithTasks.mockResolvedValue({ id: 1, tasks: [] });
    deleteGoal.mockResolvedValue({ success: true, deletedGoalIds: [1] });
  });

  it('renders nothing when closed', () => {
    const onClose = vi.fn();
    const { container } = render(<GoalsModal isOpen={false} onClose={onClose} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows empty state when no project is selected', async () => {
    useAppState.mockReturnValue({ currentProject: null });

    render(<GoalsModal isOpen={true} onClose={vi.fn()} />);

    expect(screen.getByTestId('goals-modal')).toBeInTheDocument();
    expect(screen.getByTestId('goals-modal-empty')).toHaveTextContent('Select a project');

    // Should not attempt to load goals without a project id.
    await waitFor(() => {
      expect(fetchGoals).not.toHaveBeenCalled();
    });
  });

  it('locks body scroll while open and unlocks on close', () => {
    const onClose = vi.fn();

    const { rerender, unmount } = render(<GoalsModal isOpen={true} onClose={onClose} />);
    expect(document.body.style.overflow).toBe('hidden');

    rerender(<GoalsModal isOpen={false} onClose={onClose} />);
    // When closed, component returns null, but effect cleanup should run.
    expect(document.body.style.overflow).toBe('unset');

    // Also safe to unmount.
    unmount();
    expect(document.body.style.overflow).toBe('unset');
  });

  it('closes on Escape and on backdrop click', async () => {
    const onClose = vi.fn();

    render(<GoalsModal isOpen={true} onClose={onClose} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    const modal = screen.getByTestId('goals-modal');
    fireEvent.click(modal);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('does not close when clicking inside the modal panel', () => {
    const onClose = vi.fn();
    render(<GoalsModal isOpen={true} onClose={onClose} />);

    fireEvent.click(screen.getByText('Goals & Progress'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows a remove-goal action for the selected goal', async () => {
    fetchGoals.mockResolvedValueOnce([{ id: 1, prompt: 'Goal', status: 'planning', parentGoalId: null }]);

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<GoalsModal isOpen={true} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByTestId('goals-modal-goal-1'));
    fireEvent.click(screen.getByTestId('goals-modal-remove-goal'));

    await waitFor(() => {
      expect(deleteGoal).toHaveBeenCalledWith(1);
    });

    confirmSpy.mockRestore();
  });

  it('shows loading while goals load and ignores non-array responses', async () => {
    let resolveGoals;
    const pendingGoals = new Promise((resolve) => {
      resolveGoals = resolve;
    });
    fetchGoals.mockReturnValueOnce(pendingGoals);

    render(<GoalsModal isOpen={true} onClose={vi.fn()} />);

    expect(await screen.findByText('Loading…')).toBeInTheDocument();

    resolveGoals({ not: 'an array' });

    await waitFor(() => {
      expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    });

    // Should render an empty list rather than throwing.
    expect(screen.getByTestId('goals-modal-goal-list')).toBeInTheDocument();
  });

  it('loads goals, shows progress, loads goal details, and renders tasks', async () => {
    fetchGoals.mockResolvedValue([
      { id: 1, prompt: 'Parent goal', status: 'verifying', parentGoalId: null },
      { id: 2, prompt: 'Child completed', status: 'completed', parentGoalId: 1 },
      { id: 3, prompt: 'Child ready', status: '  READY ', parentGoalId: 1 },
      { id: 8, prompt: 'Child missing status', status: null, parentGoalId: 1 },
      // Covers computeGoalProgress(total===0) where parent is ready.
      { id: 4, prompt: 'Solo done goal', status: 'ready', parentGoalId: null },
      // Covers computeGoalProgress(total===0) where parent is not done.
      { id: 7, prompt: 'Solo not done goal', status: 'planning', parentGoalId: null },
      // Covers normalizePhase(!text) + unknown fallback.
      { id: 5, prompt: 'Missing status goal', status: null, parentGoalId: null },
      // Covers normalizePhase fallback return (non-standard status).
      { id: 6, prompt: 'Custom status goal', status: 'blocked', parentGoalId: null },
    ]);

    fetchGoalWithTasks.mockResolvedValue({
      id: 1,
      tasks: [
        { id: 9, title: 'Do thing', type: 'analysis', status: 'done' },
        { id: 10, title: '', type: 'testing', status: null },
      ],
    });

    render(<GoalsModal isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(fetchGoals).toHaveBeenCalledWith(123, { includeArchived: true });
    });

    const list = screen.getByTestId('goals-modal-goal-list');
    expect(within(list).getByText('Parent goal')).toBeInTheDocument();

    // Shows normalized status and progress summary 1/1.
    expect(within(list).getByText('Verifying')).toBeInTheDocument();
    // Two done children out of three (one child has unknown status).
    expect(within(list).getByText('2/3')).toBeInTheDocument();

    // Child statuses are normalized (completed/READY -> ready).
    expect(within(list).getAllByText('Completed').length).toBeGreaterThan(0);

    // Child missing status uses unknown fallback.
    expect(within(screen.getByTestId('goals-modal-goal-8')).getByText('Unknown')).toBeInTheDocument();

    // total===0 branch where parent is ready => shows 1/1.
    expect(within(list).getByText('Solo done goal')).toBeInTheDocument();
    expect(within(list).getAllByText('1/1').length).toBeGreaterThan(0);

    // total===0 branch where parent is not done => no progress counter.
    expect(within(list).getByText('Solo not done goal')).toBeInTheDocument();

    // Empty status => unknown fallback.
    expect(within(list).getByText('Missing status goal')).toBeInTheDocument();
    expect(within(screen.getByTestId('goals-modal-goal-5')).getByText('Unknown')).toBeInTheDocument();

    // Non-standard status uses fallback return.
    expect(within(list).getByText('Custom status goal')).toBeInTheDocument();
    expect(within(list).getByText('Blocked')).toBeInTheDocument();

    // Select parent goal -> loads details.
    fireEvent.click(screen.getByTestId('goals-modal-goal-1'));

    await waitFor(() => {
      expect(fetchGoalWithTasks).toHaveBeenCalledWith(1);
    });

    const tasks = await screen.findByTestId('goals-modal-task-list');
    const taskScope = within(tasks);
    expect(taskScope.getByText('Do thing')).toBeInTheDocument();
    expect(taskScope.getByText('analysis')).toBeInTheDocument();
    expect(taskScope.getByText('done')).toBeInTheDocument();

    // Task fallbacks: title -> type and status -> pending.
    expect(taskScope.getAllByText('testing').length).toBeGreaterThan(0);
    expect(taskScope.getByText('pending')).toBeInTheDocument();

    // Selecting a child goal applies the selected class on child buttons.
    fireEvent.click(screen.getByTestId('goals-modal-goal-2'));
    expect(screen.getByTestId('goals-modal-goal-2').className).toMatch(/selected/);
  });

  it('shows the no-tasks message when selected goal has no recorded tasks', async () => {
    fetchGoals.mockResolvedValueOnce([{ id: 1, prompt: 'Goal', status: 'planning', parentGoalId: null }]);
    fetchGoalWithTasks.mockResolvedValueOnce({ id: 1, tasks: [] });

    render(<GoalsModal isOpen={true} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByTestId('goals-modal-goal-1'));
    expect(await screen.findByText('No tasks recorded for this goal yet.')).toBeInTheDocument();
  });

  it('ignores detail results that arrive after the modal closes (cancellation)', async () => {
    fetchGoals.mockResolvedValueOnce([{ id: 1, prompt: 'Goal', status: 'planning', parentGoalId: null }]);

    let resolveDetails;
    const pendingDetails = new Promise((resolve) => {
      resolveDetails = resolve;
    });
    fetchGoalWithTasks.mockReturnValueOnce(pendingDetails);

    const { rerender } = render(<GoalsModal isOpen={true} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('goals-modal-goal-1'));

    // Close before the promise resolves so the effect cleanup sets `canceled`.
    rerender(<GoalsModal isOpen={false} onClose={vi.fn()} />);

    resolveDetails({ id: 1, tasks: [{ id: 't1', title: 'Late task', type: 'analysis', status: 'done' }] });
    await Promise.resolve();
  });

  it('ignores detail errors that arrive after the modal closes (cancellation)', async () => {
    fetchGoals.mockResolvedValueOnce([{ id: 1, prompt: 'Goal', status: 'planning', parentGoalId: null }]);

    let rejectDetails;
    const pendingDetails = new Promise((_, reject) => {
      rejectDetails = reject;
    });
    fetchGoalWithTasks.mockReturnValueOnce(pendingDetails);

    const { rerender } = render(<GoalsModal isOpen={true} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('goals-modal-goal-1'));

    rerender(<GoalsModal isOpen={false} onClose={vi.fn()} />);

    rejectDetails(new Error('late failure'));
    await Promise.resolve();
  });

  it('is safe when onClose is omitted', async () => {
    useAppState.mockReturnValue({ currentProject: { id: 123, name: '' } });
    render(<GoalsModal isOpen={true} />);

    // Project name falls back when missing/falsy.
    expect(screen.getByText('Project')).toBeInTheDocument();

    // These should not throw even without an onClose handler.
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('goals-modal'));
    fireEvent.click(screen.getByTestId('goals-modal-close'));
  });

  it('uses fallback detail copy when selected goal disappears after refresh', async () => {
    fetchGoals
      .mockResolvedValueOnce([{ id: 1, prompt: 'Temp goal', status: 'planning', parentGoalId: null }])
      .mockResolvedValueOnce([]);

    render(<GoalsModal isOpen={true} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByTestId('goals-modal-goal-1'));

    // Refresh swaps out the goal list, leaving the selection pointing at a missing id.
    fireEvent.click(screen.getByTestId('goals-modal-refresh'));
    await waitFor(() => expect(fetchGoals).toHaveBeenCalledTimes(2));

    // Detail view should fall back safely when the selected goal no longer exists.
    expect(screen.getByText('Goal')).toBeInTheDocument();
    expect(screen.getByText(/Status: unknown/i)).toBeInTheDocument();
  });

  it('shows error states when goal loading fails and when detail loading fails', async () => {
    fetchGoals.mockRejectedValueOnce(new Error('boom'));

    render(<GoalsModal isOpen={true} onClose={vi.fn()} />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Failed to load goals');

    // Refresh retries
    fetchGoals.mockResolvedValueOnce([{ id: 1, prompt: 'Goal', status: 'planning', parentGoalId: null }]);
    fireEvent.click(screen.getByTestId('goals-modal-refresh'));

    await waitFor(() => {
      expect(fetchGoals).toHaveBeenCalledTimes(2);
    });

    // Detail load error
    fetchGoalWithTasks.mockRejectedValueOnce(new Error('nope'));
    fireEvent.click(await screen.findByTestId('goals-modal-goal-1'));

    const detailAlert = await screen.findByRole('alert');
    expect(detailAlert).toHaveTextContent('Failed to load goal details');

    expect(screen.getByTestId('goals-modal-detail')).toBeInTheDocument();
  });
});
