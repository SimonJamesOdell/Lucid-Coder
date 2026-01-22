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

const buildGoalTree = (goals = []) => {
  const map = new Map();
  goals.forEach((goal) => {
    if (!goal?.id) return;
    map.set(goal.id, { ...goal, children: [] });
  });

  map.forEach((node) => {
    if (node.parentGoalId && map.has(node.parentGoalId)) {
      map.get(node.parentGoalId).children.push(node);
    }
  });

  const roots = Array.from(map.values()).filter(
    (node) => !node.parentGoalId || !map.has(node.parentGoalId)
  );

  const sortTree = (nodes) => {
    nodes.sort((a, b) => Number(a.id) - Number(b.id));
    nodes.forEach((node) => {
      if (Array.isArray(node.children) && node.children.length > 0) {
        sortTree(node.children);
      }
    });
  };

  sortTree(roots);
  return roots;
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

  const goalTree = buildGoalTree(goals);

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
        {goalTree.map((goal) => {
          const renderNode = (node, depth = 0) => (
            <React.Fragment key={node.id}>
              <li data-testid={depth === 0 ? 'agent-goal-parent' : 'agent-goal-child'}>
                <span>{getGoalTitle(node)}</span>
                <span> — {formatPhaseLabel(node.status)}</span>
              </li>
              {Array.isArray(node.children)
                ? node.children.map((child) => renderNode(child, depth + 1))
                : null}
            </React.Fragment>
          );

          return renderNode(goal, 0);
        })}
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
