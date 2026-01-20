import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAppState } from '../context/AppStateContext';
import {
  deleteGoal,
  fetchGoalWithTasks,
  fetchGoals
} from '../utils/goalsApi';
import './GoalsModal.css';

const PHASE_ORDER = ['planning', 'testing', 'implementing', 'verifying', 'ready', 'failed'];

const normalizePhase = (value) => {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (PHASE_ORDER.includes(text)) return text;
  if (text === 'done' || text === 'completed') return 'ready';
  return text;
};

const isGoalDone = (goal) => {
  const phase = normalizePhase(goal?.status);
  return phase === 'ready';
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

const formatPhaseLabel = (phase) => {
  const normalized = normalizePhase(phase);
  if (!normalized) return 'Unknown';
  if (normalized === 'ready') return 'Completed';
  if (normalized === 'failed') return 'Failed';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
};

const computeLeafProgress = (goal) => {
  const children = Array.isArray(goal?.children) ? goal.children : [];
  if (children.length === 0) {
    return { done: isGoalDone(goal) ? 1 : 0, total: 1 };
  }

  return children.reduce(
    (acc, child) => {
      const next = computeLeafProgress(child);
      return { done: acc.done + next.done, total: acc.total + next.total };
    },
    { done: 0, total: 0 }
  );
};

const computeGoalProgress = (goal) => {
  const children = Array.isArray(goal?.children) ? goal.children : [];
  if (children.length === 0) {
    if (isGoalDone(goal)) {
      return { done: 1, total: 1, ratio: 1 };
    }
    return { done: 0, total: 0, ratio: 0 };
  }

  const leafProgress = computeLeafProgress(goal);
  const ratio = leafProgress.done / leafProgress.total;
  return { ...leafProgress, ratio };
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
    const sorted = nodes.slice().sort(compareGoalsForDisplay);
    sorted.forEach((node) => {
      if (Array.isArray(node.children) && node.children.length > 0) {
        node.children = node.children.slice().sort(compareGoalsForDisplay);
        sortTree(node.children);
      }
    });
    return sorted;
  };

  return sortTree(roots);
};

export const compareGoalsForDisplay = (a, b) => {
  const aTime = a?.createdAt ? new Date(a.createdAt).getTime() : NaN;
  const bTime = b?.createdAt ? new Date(b.createdAt).getTime() : NaN;

  const aHasTime = Number.isFinite(aTime);
  const bHasTime = Number.isFinite(bTime);

  if (aHasTime && bHasTime && aTime !== bTime) {
    return aTime - bTime;
  }
  if (aHasTime && !bHasTime) {
    return -1;
  }
  if (!aHasTime && bHasTime) {
    return 1;
  }

  return Number(a?.id || 0) - Number(b?.id || 0);
};

const GoalsPanel = ({
  mode = 'tab',
  isOpen = true,
  onRequestClose,
  automationPaused = false,
  onResumeAutomation
}) => {
  const isModal = mode === 'modal';
  const isVisible = isModal ? Boolean(isOpen) : true;

  const { currentProject, jobState } = useAppState();
  const [goals, setGoals] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedGoalId, setSelectedGoalId] = useState(null);
  const [selectedDetails, setSelectedDetails] = useState(null);
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const goalTree = useMemo(() => buildGoalTree(goals), [goals]);

  const loadGoals = async (projectId, { silent = false } = {}) => {
    if (!projectId) {
      setGoals([]);
      return;
    }

    if (!silent) {
      setIsLoading(true);
      setError(null);
    }

    try {
      const data = await fetchGoals(projectId, { includeArchived: true });
      setGoals(Array.isArray(data) ? data : []);
    } catch {
      if (!silent) {
        setError('Failed to load goals');
        setGoals([]);
      }
    } finally {
      if (!silent) {
        setIsLoading(false);
      }
    }
  };

  const projectId = currentProject?.id;

  const activeJob = useMemo(() => {
    if (!projectId) {
      return null;
    }

    const bucket = jobState?.jobsByProject?.[String(projectId)];
    const jobs = Array.isArray(bucket?.jobs) ? bucket.jobs : [];
    if (jobs.length === 0) {
      return null;
    }

    const finalStates = new Set(['succeeded', 'failed', 'cancelled']);
    return jobs.find((job) => job && !finalStates.has(String(job.status))) || null;
  }, [jobState?.jobsByProject, projectId]);

  const previousActiveJobIdRef = useRef(null);

  useEffect(() => {
    if (!isVisible || !projectId) {
      previousActiveJobIdRef.current = null;
      return;
    }

    const previousId = previousActiveJobIdRef.current;
    const currentId = activeJob?.id || null;
    previousActiveJobIdRef.current = currentId;

    // When a job finishes, the polling effect below is torn down. Trigger one
    // last silent refresh so the final phase transition (e.g. verifying -> ready)
    // is visible without requiring a tab switch.
    if (previousId && !currentId) {
      loadGoals(projectId, { silent: true });
    }
  }, [activeJob?.id, isVisible, projectId]);

  useEffect(() => {
    if (!isModal || !isVisible) {
      return undefined;
    }

    if (typeof document !== 'undefined') {
      document.body.style.overflow = 'hidden';
    }

    return () => {
      if (typeof document !== 'undefined') {
        document.body.style.overflow = 'unset';
      }
    };
  }, [isModal, isVisible]);

  useEffect(() => {
    if (!isModal || !isVisible) {
      return undefined;
    }

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        onRequestClose?.();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isModal, isVisible, onRequestClose]);

  useEffect(() => {
    if (!isVisible) {
      return;
    }

    setSelectedGoalId(null);
    setSelectedDetails(null);
    setIsDeleting(false);
    loadGoals(projectId);
  }, [isVisible, projectId]);

  useEffect(() => {
    if (!isVisible) {
      return;
    }
    if (!projectId) {
      return;
    }
    if (!activeJob) {
      return;
    }

    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      loadGoals(projectId, { silent: true });
    };

    // Refresh quickly so newly-created goals show up without requiring a tab switch.
    tick();
    const intervalId = window.setInterval(tick, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activeJob?.id, isVisible, projectId]);

  useEffect(() => {
    if (!isVisible) {
      return;
    }

    if (!selectedGoalId) {
      setSelectedDetails(null);
      return;
    }

    let canceled = false;
    setIsLoadingDetails(true);
    setError(null);

    fetchGoalWithTasks(selectedGoalId)
      .then((data) => {
        if (canceled) return;
        setSelectedDetails(data);
      })
      .catch(() => {
        if (canceled) return;
        setError('Failed to load goal details');
        setSelectedDetails(null);
      })
      .finally(() => {
        if (canceled) return;
        setIsLoadingDetails(false);
      });

    return () => {
      canceled = true;
    };
  }, [isVisible, selectedGoalId]);

  useEffect(() => {
    if (!isVisible) {
      return undefined;
    }

    if (
      typeof window === 'undefined' ||
      typeof window.addEventListener !== 'function' ||
      typeof window.removeEventListener !== 'function'
    ) {
      return undefined;
    }

    const handleGoalsUpdated = (event) => {
      if (!projectId) {
        return;
      }

      const updatedProjectId = event?.detail?.projectId;
      if (updatedProjectId != null && String(updatedProjectId) !== String(projectId)) {
        return;
      }

      loadGoals(projectId, { silent: true });
    };

    window.addEventListener('lucidcoder:goals-updated', handleGoalsUpdated);
    return () => {
      window.removeEventListener('lucidcoder:goals-updated', handleGoalsUpdated);
    };
  }, [isVisible, projectId]);

  if (isModal && !isVisible) {
    return null;
  }

  const handleBackdropClick = (event) => {
    if (event.target === event.currentTarget) {
      onRequestClose?.();
    }
  };

  const projectName = currentProject?.name || 'Project';

  const selectedGoal =
    selectedGoalId && Array.isArray(goals)
      ? goals.find((goal) => goal.id === selectedGoalId) || null
      : null;

  const handleRemoveSelectedGoal = async () => {
    const confirmFn = globalThis?.window?.confirm;
    const confirmed = typeof confirmFn === 'function'
      ? confirmFn('Remove this goal? This will also remove any child goals.')
      : true;

    if (!confirmed) {
      return;
    }

    setIsDeleting(true);
    setError(null);
    try {
      await deleteGoal(selectedGoalId);
      setSelectedGoalId(null);
      setSelectedDetails(null);
      await loadGoals(projectId);
    } catch {
      setError('Failed to remove goal');
    } finally {
      setIsDeleting(false);
    }
  };

  const panel = (
    <div className={`goals-modal-panel${isModal ? '' : ' goals-tab-panel'}`} data-testid={isModal ? undefined : 'goals-tab'}>
      <div className="goals-modal-header">
        <div>
          <p className="goals-modal-eyebrow">{projectName}</p>
          <h2 id="goals-modal-title">Goals &amp; Progress</h2>
        </div>
        <div className="goals-modal-header-actions">
          {automationPaused && (
            <button
              type="button"
              className="goals-modal-button"
              onClick={() => onResumeAutomation?.()}
              data-testid="goals-tab-resume-automation"
            >
              Resume automation
            </button>
          )}
          <button
            type="button"
            className="goals-modal-button ghost"
            onClick={() => loadGoals(currentProject?.id)}
            disabled={!currentProject?.id || isLoading}
            data-testid="goals-modal-refresh"
          >
            Refresh
          </button>
          {isModal && (
            <button
              type="button"
              className="goals-modal-close"
              onClick={() => onRequestClose?.()}
              aria-label="Close goals modal"
              data-testid="goals-modal-close"
            >
              &times;
            </button>
          )}
        </div>
      </div>

      <div className="goals-modal-body">
        {!currentProject?.id ? (
          <div className="goals-modal-empty" data-testid="goals-modal-empty">
            Select a project to inspect goals.
          </div>
        ) : (
          <>
            <div className="goals-modal-sidebar">
              <div className="goals-modal-section-title">Goals</div>
              {isLoading && <div className="goals-modal-muted">Loading…</div>}
              {error && (
                <div className="goals-modal-error" role="alert">
                  {error}
                </div>
              )}

              <div className="goals-modal-goal-list" data-testid="goals-modal-goal-list">
                {goalTree.map((goal) => {
                  const renderGoalNode = (node, depth = 0) => {
                    const children = Array.isArray(node.children) ? node.children : [];
                    const progress = computeGoalProgress(node);
                    const groupDone = progress.total > 0 ? progress.done === progress.total : isGoalDone(node);
                    const isSelected = node.id === selectedGoalId;
                    const goalPhase = normalizePhase(node.status) || '';
                    const isChild = depth > 0;

                    return (
                      <div key={node.id} className="goals-modal-goal-group">
                        <button
                          type="button"
                          className={`goals-modal-goal${isChild ? ' child' : ''}${isSelected ? ' selected' : ''}${groupDone ? ' done' : ''}`}
                          onClick={() => setSelectedGoalId(node.id)}
                          data-testid={`goals-modal-goal-${node.id}`}
                        >
                          <div className="goals-modal-goal-title">{getGoalTitle(node)}</div>
                          <div className="goals-modal-goal-meta">
                            <span
                              className={`goals-modal-goal-status${goalPhase ? ` ${goalPhase}` : ''}`}
                              aria-label={`Status: ${formatPhaseLabel(goalPhase)}`}
                            >
                              {formatPhaseLabel(goalPhase)}
                            </span>
                            {progress.total > 0 && (
                              <span className="goals-modal-goal-progress">
                                {progress.done}/{progress.total}
                              </span>
                            )}
                          </div>
                          {progress.total > 0 && (
                            <div className="goals-modal-progressbar" aria-hidden="true">
                              <div
                                className="goals-modal-progressbar-fill"
                                style={{ width: `${Math.round(progress.ratio * 100)}%` }}
                              />
                            </div>
                          )}
                        </button>

                        {children.length > 0 && (
                          <div className="goals-modal-children">
                            {children.map((child) => renderGoalNode(child, depth + 1))}
                          </div>
                        )}
                      </div>
                    );
                  };

                  return renderGoalNode(goal, 0);
                })}
              </div>
            </div>

            <div className="goals-modal-detail" data-testid="goals-modal-detail">
              <div className="goals-modal-section-title">Details</div>
              {!selectedGoalId ? (
                <div className="goals-modal-muted">Select a goal to view tasks and progress.</div>
              ) : (
                <>
                  <div className="goals-modal-detail-header">
                    <div className="goals-modal-detail-title">{getGoalTitle(selectedGoal)}</div>
                    <div className="goals-modal-detail-status">
                      Status: {formatPhaseLabel(normalizePhase(selectedGoal?.status) || '')}
                    </div>
                  </div>

                  <div className="goals-modal-detail-actions">
                    <button
                      type="button"
                      className="goals-modal-button ghost"
                      onClick={handleRemoveSelectedGoal}
                      disabled={!projectId || !selectedGoalId || isDeleting}
                      data-testid="goals-modal-remove-goal"
                    >
                      {isDeleting ? 'Removing…' : 'Remove goal'}
                    </button>
                  </div>

                  {isLoadingDetails && <div className="goals-modal-muted">Loading details…</div>}

                  {selectedDetails?.tasks?.length ? (
                    <ul className="goals-modal-task-list" data-testid="goals-modal-task-list">
                      {selectedDetails.tasks.map((task) => (
                        <li key={task.id} className="goals-modal-task">
                          <div className="goals-modal-task-title">{task.title || task.type}</div>
                          <div className="goals-modal-task-meta">
                            <span>{task.type}</span>
                            <span>—</span>
                            <span>{task.status || 'pending'}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="goals-modal-muted">No tasks recorded for this goal yet.</div>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );

  if (isModal) {
    return (
      <div
        className="goals-modal-backdrop"
        onClick={handleBackdropClick}
        role="dialog"
        aria-modal="true"
        aria-labelledby="goals-modal-title"
        data-testid="goals-modal"
      >
        {panel}
      </div>
    );
  }

  return <div className="goals-tab-root">{panel}</div>;
};

export default GoalsPanel;

GoalsPanel.__testHooks = GoalsPanel.__testHooks || {};
Object.assign(GoalsPanel.__testHooks, {
  normalizePhase,
  getGoalTitle,
  computeGoalProgress,
  formatPhaseLabel
});
