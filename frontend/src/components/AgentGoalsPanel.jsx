import React, { useEffect, useState } from 'react';
import { useAppState } from '../context/AppStateContext';
import { fetchGoals, runGoalTests } from '../utils/goalsApi';

const normalizePhase = (value) => {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (text === 'done' || text === 'completed') return 'ready';
  return text;
};

const formatPhaseLabel = (value) => {
  const phase = normalizePhase(value);
  if (!phase) return 'Unknown';
  if (phase === 'ready') return 'Completed';
  if (phase === 'failed') return 'Failed';
  return phase.charAt(0).toUpperCase() + phase.slice(1);
};

const getGoalTitle = (goal) => {
  if (!goal) {
    return 'Goal';
  }
  const title = typeof goal.title === 'string' ? goal.title.trim() : '';
  if (title) {
    return title;
  }
  const prompt = typeof goal.prompt === 'string' ? goal.prompt.trim() : '';
  return prompt || 'Goal';
};

const AgentGoalsPanel = ({ onGoalsLoaded }) => {
  const { currentProject } = useAppState();
  const [goals, setGoals] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [isRunningTests, setIsRunningTests] = useState(false);

  const loadGoals = async (projectId) => {
    if (!projectId) {
      setGoals([]);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const data = await fetchGoals(projectId, { includeArchived: true });
      setGoals(data);
      if (onGoalsLoaded) {
        onGoalsLoaded(data.length);
      }
    } catch (err) {
      setError('Failed to load goals');
      if (onGoalsLoaded) {
        onGoalsLoaded(0);
      }
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadGoals(currentProject?.id);
  }, [currentProject?.id]);

  const handleRunTests = async () => {
    if (!currentProject?.id || goals.length === 0) return;
    setIsRunningTests(true);
    setError(null);
    try {
      const firstGoal = goals[0];
      await runGoalTests(firstGoal.id, {
        cwd: '.',
        command: 'npm',
        args: ['test']
      });
      await loadGoals(currentProject.id);
    } catch (err) {
      setError('Failed to run tests');
    } finally {
      setIsRunningTests(false);
    }
  };

  if (!currentProject?.id) {
    return (
      <div data-testid="agent-goals-panel">
        <p>Select a project to manage agent goals.</p>
      </div>
    );
  }

  const parents = goals.filter((g) => !g.parentGoalId);
  const childrenByParent = goals.reduce((map, goal) => {
    if (goal.parentGoalId) {
      if (!map[goal.parentGoalId]) {
        map[goal.parentGoalId] = [];
      }
      map[goal.parentGoalId].push(goal);
    }
    return map;
  }, {});

  return (
    <div data-testid="agent-goals-panel">
      <h3>Agent Goals</h3>
      {goals.length > 0 && (
        <button
          type="button"
          data-testid="run-goal-tests-button"
          onClick={handleRunTests}
          disabled={isRunningTests}
        >
          {isRunningTests ? 'Running tests…' : 'Run tests for first goal'}
        </button>
      )}
      {isLoading && <p>Loading...</p>}
      {error && <p role="alert">{error}</p>}
      <ul data-testid="agent-goal-list">
        {parents.map((goal) => (
          <React.Fragment key={goal.id}>
            <li data-testid="agent-goal-parent">
              <span>{getGoalTitle(goal)}</span>
              <span> — {formatPhaseLabel(goal.status)}</span>
            </li>
            {(childrenByParent[goal.id] || []).map((child) => (
              <li
                key={child.id}
                data-testid="agent-goal-child"
                className="agent-goal-child"
              >
                <span>{getGoalTitle(child)}</span>
                <span> — {formatPhaseLabel(child.status)}</span>
              </li>
            ))}
          </React.Fragment>
        ))}
      </ul>
    </div>
  );
};

export default AgentGoalsPanel;

AgentGoalsPanel.__testHooks = AgentGoalsPanel.__testHooks || {};
Object.assign(AgentGoalsPanel.__testHooks, {
  getGoalTitle,
  normalizePhase,
  formatPhaseLabel
});
