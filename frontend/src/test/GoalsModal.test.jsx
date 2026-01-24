import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import GoalsModal from '../components/GoalsModal.jsx';
import { useAppState } from '../context/AppStateContext';
import { deleteGoal, fetchGoals } from '../utils/goalsApi';

vi.mock('../context/AppStateContext', () => ({
  useAppState: vi.fn(),
}));

vi.mock('../utils/goalsApi', () => ({
  fetchGoals: vi.fn(),
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
    return waitFor(() => {
      expect(document.body.style.overflow).toBe('hidden');
    }).then(async () => {
      rerender(<GoalsModal isOpen={false} onClose={onClose} />);
      // When closed, component returns null, but effect cleanup should run.
      await waitFor(() => {
        expect(document.body.style.overflow).toBe('unset');
      });

      // Also safe to unmount.
      unmount();
      expect(document.body.style.overflow).toBe('unset');
    });
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

  it('clears goals when confirmed', async () => {
    fetchGoals
      .mockResolvedValueOnce([
        { id: 1, prompt: 'Goal', status: 'planning', parentGoalId: null },
        { id: 2, prompt: 'Child', status: 'planning', parentGoalId: 1 }
      ])
      .mockResolvedValueOnce([]);

    render(<GoalsModal isOpen={true} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByTestId('goals-clear-goals'));
    fireEvent.click(await screen.findByTestId('modal-confirm'));

    await waitFor(() => {
      expect(deleteGoal).toHaveBeenCalledWith(1);
    });
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

  it('loads goals and shows progress', async () => {
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

  it('shows error states when goal loading fails', async () => {
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

    expect(screen.getByTestId('goals-modal-detail')).toBeInTheDocument();
  });
});
