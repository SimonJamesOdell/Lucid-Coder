import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AgentGoalsPanel from '../components/AgentGoalsPanel.jsx';
import { useAppState } from '../context/AppStateContext.jsx';
import * as goalsApi from '../utils/goalsApi.js';

vi.mock('../context/AppStateContext.jsx', () => ({
  useAppState: vi.fn()
}));

vi.mock('../utils/goalsApi.js');

describe('AgentGoalsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prompts to select a project when none is active', () => {
    useAppState.mockReturnValue({ currentProject: null });

    render(<AgentGoalsPanel />);

    expect(screen.getByTestId('agent-goals-panel')).toBeInTheDocument();
    expect(screen.getByText(/Select a project to manage agent goals/i)).toBeInTheDocument();
  });

  it('loads and displays goals for the current project', async () => {
    useAppState.mockReturnValue({ currentProject: { id: 1, name: 'Demo' } });
    goalsApi.fetchGoals.mockResolvedValue([
      { id: 1, prompt: 'First goal', status: 'planning' },
      { id: 2, prompt: 'Second goal', status: 'testing' }
    ]);

    const onGoalsLoaded = vi.fn();
    render(<AgentGoalsPanel onGoalsLoaded={onGoalsLoaded} />);

    expect(goalsApi.fetchGoals).toHaveBeenCalledWith(1, { includeArchived: true });

    await waitFor(() => {
      expect(screen.getByText('First goal')).toBeInTheDocument();
      expect(screen.getByText('Second goal')).toBeInTheDocument();
      expect(onGoalsLoaded).toHaveBeenCalledWith(2);
    });
  });

  it('formats status labels for done/completed/failed/unknown', async () => {
    useAppState.mockReturnValue({ currentProject: { id: 101, name: 'Demo' } });
    goalsApi.fetchGoals.mockResolvedValue([
      { id: 1, prompt: 'Done goal', status: 'done' },
      { id: 2, prompt: 'Completed goal', status: 'completed' },
      { id: 3, prompt: 'Failed goal', status: 'failed' },
      { id: 4, prompt: 'Whitespace status goal', status: '   ' },
      { id: 5, prompt: 'Null status goal', status: null }
    ]);

    render(<AgentGoalsPanel />);

    await waitFor(() => {
      expect(screen.getByText(/Done goal/i)).toBeInTheDocument();
    });

    const items = screen.getAllByTestId('agent-goal-parent');
    const text = items.map((item) => item.textContent);

    expect(text).toEqual(expect.arrayContaining([
      expect.stringContaining('Done goal — Completed'),
      expect.stringContaining('Completed goal — Completed'),
      expect.stringContaining('Failed goal — Failed'),
      expect.stringContaining('Whitespace status goal — Unknown'),
      expect.stringContaining('Null status goal — Unknown')
    ]));
  });

  it('shows an error message when loading goals fails', async () => {
    useAppState.mockReturnValue({ currentProject: { id: 3, name: 'Demo' } });
    goalsApi.fetchGoals.mockRejectedValue(new Error('boom'));

    render(<AgentGoalsPanel />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Failed to load goals/i);
    });
  });

  it('calls onGoalsLoaded with zero when loading fails', async () => {
    useAppState.mockReturnValue({ currentProject: { id: 4, name: 'Demo' } });
    goalsApi.fetchGoals.mockRejectedValue(new Error('network'));
    const onGoalsLoaded = vi.fn();

    render(<AgentGoalsPanel onGoalsLoaded={onGoalsLoaded} />);

    await waitFor(() => {
      expect(onGoalsLoaded).toHaveBeenCalledWith(0);
    });
  });

  it('runs tests for the first goal and reloads goals', async () => {
    useAppState.mockReturnValue({ currentProject: { id: 5, name: 'Demo' } });
    goalsApi.fetchGoals.mockResolvedValueOnce([
      { id: 10, prompt: 'Goal with tests', status: 'testing' }
    ]);
    goalsApi.runGoalTests.mockResolvedValue({
      id: 99,
      type: 'test-run',
      status: 'failed'
    });

    const user = userEvent.setup();

    render(<AgentGoalsPanel />);

    // wait for initial load
    await waitFor(() => {
      expect(screen.getByText('Goal with tests')).toBeInTheDocument();
    });

    const runButton = screen.getByTestId('run-goal-tests-button');
    await user.click(runButton);

    await waitFor(() => {
      expect(goalsApi.runGoalTests).toHaveBeenCalledWith(10, {
        cwd: '.',
        command: 'npm',
        args: ['test']
      });
    });
  });

  it('surfaces an error when running goal tests fails', async () => {
    useAppState.mockReturnValue({ currentProject: { id: 6, name: 'Demo' } });
    goalsApi.fetchGoals.mockResolvedValue([
      { id: 11, prompt: 'Unstable goal', status: 'testing' }
    ]);
    goalsApi.runGoalTests.mockRejectedValue(new Error('boom'));

    const user = userEvent.setup();
    render(<AgentGoalsPanel />);

    await waitFor(() => {
      expect(screen.getByText('Unstable goal')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('run-goal-tests-button'));

    await waitFor(() => {
      expect(goalsApi.runGoalTests).toHaveBeenCalledWith(11, {
        cwd: '.',
        command: 'npm',
        args: ['test']
      });
      expect(screen.getByRole('alert')).toHaveTextContent(/Failed to run tests/i);
    });
  });

  it('groups child goals under their parent', async () => {
    useAppState.mockReturnValue({ currentProject: { id: 9, name: 'Demo' } });
    goalsApi.fetchGoals.mockResolvedValue([
      { id: 1, prompt: 'Parent goal', status: 'planning', parentGoalId: null },
      { id: 2, prompt: 'Child A', status: 'planning', parentGoalId: 1 },
      { id: 3, prompt: 'Child B', status: 'testing', parentGoalId: 1 }
    ]);

    render(<AgentGoalsPanel />);

    await waitFor(() => {
      const parents = screen.getAllByTestId('agent-goal-parent');
      const children = screen.getAllByTestId('agent-goal-child');

      expect(parents).toHaveLength(1);
      expect(children).toHaveLength(2);
      expect(parents[0]).toHaveTextContent('Parent goal');
      expect(children[0]).toHaveTextContent('Child A');
      expect(children[1]).toHaveTextContent('Child B');
    });
  });

  it('skips goals without ids when building the tree', async () => {
    useAppState.mockReturnValue({ currentProject: { id: 11, name: 'Demo' } });
    goalsApi.fetchGoals.mockResolvedValue([
      { prompt: 'Missing id goal', status: 'planning', parentGoalId: null },
      { id: 5, prompt: 'Valid goal', status: 'planning', parentGoalId: null }
    ]);

    render(<AgentGoalsPanel />);

    await waitFor(() => {
      expect(screen.getByText('Valid goal')).toBeInTheDocument();
    });

    expect(screen.queryByText('Missing id goal')).not.toBeInTheDocument();
  });

  it('renders an empty list when every goal is missing an id', async () => {
    useAppState.mockReturnValue({ currentProject: { id: 13, name: 'Demo' } });
    goalsApi.fetchGoals.mockResolvedValue([
      { prompt: 'Missing id goal', status: 'planning', parentGoalId: null }
    ]);

    render(<AgentGoalsPanel />);

    await waitFor(() => {
      expect(screen.getByTestId('agent-goal-list')).toBeInTheDocument();
    });

    expect(screen.queryByTestId('agent-goal-parent')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-goal-child')).not.toBeInTheDocument();
  });

  it('skips child rendering when children is not an array', async () => {
    useAppState.mockReturnValue({ currentProject: { id: 10, name: 'Demo' } });
    goalsApi.fetchGoals.mockResolvedValue([
      { id: 1, prompt: 'Parent goal', status: 'planning', parentGoalId: null },
      { id: 2, prompt: 'Child goal', status: 'planning', parentGoalId: 1 }
    ]);

    const isArraySpy = vi.spyOn(Array, 'isArray').mockImplementation(() => false);

    render(<AgentGoalsPanel />);

    await waitFor(() => {
      expect(screen.getByText('Parent goal')).toBeInTheDocument();
    });

    expect(screen.queryByTestId('agent-goal-child')).not.toBeInTheDocument();

    isArraySpy.mockRestore();
  });

  it('does not attempt to run tests when goals array becomes empty before clicking', async () => {
    useAppState.mockReturnValue({ currentProject: { id: 12, name: 'Demo' } });
    const goalsPayload = [{ id: 31, prompt: 'Transient goal', status: 'planning' }];
    goalsApi.fetchGoals.mockResolvedValue(goalsPayload);

    render(<AgentGoalsPanel />);

    await waitFor(() => {
      expect(screen.getByText('Transient goal')).toBeInTheDocument();
    });

    goalsPayload.length = 0;

    const runButton = screen.getByTestId('run-goal-tests-button');
    fireEvent.click(runButton);

    expect(goalsApi.runGoalTests).not.toHaveBeenCalled();
  });

  describe('__testHooks.getGoalTitle', () => {
    it('returns the default label when the goal object is missing', () => {
      const { getGoalTitle } = AgentGoalsPanel.__testHooks;

      expect(getGoalTitle(null)).toBe('Goal');
      expect(getGoalTitle(undefined)).toBe('Goal');
    });

    it('prefers trimmed title text when available', () => {
      const { getGoalTitle } = AgentGoalsPanel.__testHooks;
      const goal = {
        title: '   Ship MVP   ',
        prompt: 'ignore the prompt'
      };

      expect(getGoalTitle(goal)).toBe('Ship MVP');
    });

    it('falls back to a trimmed prompt when no title exists', () => {
      const { getGoalTitle } = AgentGoalsPanel.__testHooks;
      const goal = {
        title: '   ',
        prompt: '   add telemetry   '
      };

      expect(getGoalTitle(goal)).toBe('add telemetry');
    });

    it('returns the default label when both title and prompt are empty', () => {
      const { getGoalTitle } = AgentGoalsPanel.__testHooks;
      const goal = {
        title: '   ',
        prompt: '\n\t'
      };

      expect(getGoalTitle(goal)).toBe('Goal');
    });

    it('ignores non-string prompt values when falling back', () => {
      const { getGoalTitle } = AgentGoalsPanel.__testHooks;
      const goal = {
        title: '   ',
        prompt: { text: 'invalid' }
      };

      expect(getGoalTitle(goal)).toBe('Goal');
    });
  });
});
