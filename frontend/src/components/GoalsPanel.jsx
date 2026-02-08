import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAppState } from '../context/AppStateContext';
import {
  deleteGoal,
  fetchGoals
} from '../utils/goalsApi';
import Modal from './Modal';
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

const normalizeLifecycleState = (value) => String(value || '').trim().toLowerCase();

const isPastGoalGroup = (goal) => {
  const lifecycle = normalizeLifecycleState(goal?.lifecycleState);
  if (lifecycle === 'ready-to-merge' || lifecycle === 'merged' || lifecycle === 'cancelled') {
    return true;
  }

  const progress = computeGoalProgress(goal);
  const hasProgress = progress.total > 0;
  const groupDone = hasProgress ? progress.done === progress.total : isGoalDone(goal);
  if (groupDone) {
    return true;
  }

  const phase = normalizePhase(goal?.status);
  return phase === 'failed' || phase === 'ready';
};

const splitGoalTreeForTabs = (roots = []) => {
  const rootGoals = Array.isArray(roots) ? roots : [];
  const current = [];
  const past = [];

  for (const root of rootGoals) {
    if (!root) continue;
    if (isPastGoalGroup(root)) {
      past.push(root);
    } else {
      current.push(root);
    }
  }

  return { current, past };
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
  onRequestClose
}) => {
  const isModal = mode === 'modal';
  const isVisible = isModal ? Boolean(isOpen) : true;

  const isTabMode = !isModal;

  const { currentProject, jobState } = useAppState();
  const [goals, setGoals] = useState([]);
  const [activeList, setActiveList] = useState('current');
  const [expandedPastGoalIds, setExpandedPastGoalIds] = useState(() => new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [isClearing, setIsClearing] = useState(false);
  const [isClearDialogOpen, setIsClearDialogOpen] = useState(false);
  const [selectedGoalId, setSelectedGoalId] = useState(null);

  const fullGoalTree = useMemo(() => buildGoalTree(goals), [goals]);
  const goalTabs = useMemo(() => splitGoalTreeForTabs(fullGoalTree), [fullGoalTree]);
  const displayGoalTree = useMemo(() => {
    if (!isTabMode) {
      return fullGoalTree;
    }

    return activeList === 'past' ? goalTabs.past : goalTabs.current;
  }, [activeList, fullGoalTree, goalTabs.current, goalTabs.past, isTabMode]);

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

  useEffect(() => {
    if (!isTabMode) {
      return;
    }
    setActiveList('current');
    setExpandedPastGoalIds(new Set());
    setSelectedGoalId(null);
  }, [isTabMode, projectId]);

  useEffect(() => {
    if (!isVisible) {
      return;
    }
    setSelectedGoalId(null);
  }, [isVisible, projectId]);

  useEffect(() => {
    if (!isTabMode) {
      return;
    }
    if (activeList !== 'past') {
      return;
    }

    // Past lists are collapsed by default each time you switch into them.
    setExpandedPastGoalIds(new Set());
  }, [activeList, isTabMode]);

  const togglePastGoalExpanded = (goalId) => {
    const numericId = Number(goalId);
    if (!numericId) {
      return;
    }

    setExpandedPastGoalIds((prev) => {
      const next = new Set(prev);
      if (next.has(numericId)) {
        next.delete(numericId);
      } else {
        next.add(numericId);
      }
      return next;
    });
  };

  if (GoalsPanel.__testHooks) {
    GoalsPanel.__testHooks.latestTogglePastGoalExpanded = togglePastGoalExpanded;
  }

  const findGoalById = (nodes, targetId) => {
    const queue = Array.isArray(nodes) ? nodes : [];
    for (const node of queue) {
      if (!node) continue;
      if (Number(node.id) === Number(targetId)) return node;
      const children = Array.isArray(node.children) ? node.children : [];
      const match = findGoalById(children, targetId);
      if (match) return match;
    }
    return null;
  };

  if (GoalsPanel.__testHooks) {
    GoalsPanel.__testHooks.latestFindGoalById = findGoalById;
  }

  const selectedGoal = useMemo(() => {
    if (!selectedGoalId) return null;
    return findGoalById(fullGoalTree, selectedGoalId);
  }, [fullGoalTree, selectedGoalId]);

  useEffect(() => {
    if (selectedGoalId && !selectedGoal) {
      setSelectedGoalId(null);
    }
  }, [selectedGoal, selectedGoalId]);

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

    setIsClearing(false);
    setIsClearDialogOpen(false);
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

  const handleClearGoals = async () => {
    /* c8 ignore start */
    if (!projectId) {
      return;
    }
    /* c8 ignore stop */

    const rootIds = fullGoalTree.map((goal) => goal?.id).filter(Boolean);
    /* c8 ignore start */
    if (rootIds.length === 0) {
      return;
    }
    /* c8 ignore stop */

    setIsClearing(true);
    setError(null);
    try {
      for (const id of rootIds) {
        // Delete top-level goals; the backend deletes children as well.
        await deleteGoal(id);
      }
      await loadGoals(projectId);
      setIsClearDialogOpen(false);
    } catch {
      setError('Failed to clear goals');
    } finally {
      setIsClearing(false);
    }
  };

  const panel = (
    <div className={`goals-modal-panel${isModal ? '' : ' goals-tab-panel'}`} data-testid={isModal ? undefined : 'goals-tab'}>
      {isModal && (
        <div className="goals-modal-header">
          <div>
            <p className="goals-modal-eyebrow">{projectName}</p>
            <h2 id="goals-modal-title">Goals &amp; Progress</h2>
          </div>
          <div className="goals-modal-header-actions">
            <button
              type="button"
              className="goals-modal-button ghost"
              onClick={() => loadGoals(currentProject?.id)}
              disabled={!currentProject?.id || isLoading}
              data-testid="goals-modal-refresh"
            >
              Refresh
            </button>
            <button
              type="button"
              className="goals-modal-close"
              onClick={() => onRequestClose?.()}
              aria-label="Close goals modal"
              data-testid="goals-modal-close"
            >
              &times;
            </button>
          </div>
        </div>
      )}

      <div className="goals-modal-body">
        {!currentProject?.id ? (
          <div className="goals-modal-empty" data-testid="goals-modal-empty">
            Select a project to inspect goals.
          </div>
        ) : (
          <>
            <div className="goals-modal-sidebar">
              {isTabMode ? (
                <>
                  <div className="goals-tab-header">
                    <div className="goals-tab-filterbar" role="tablist" aria-label="Goals list">
                      <button
                        type="button"
                        className={`goals-tab-filter${activeList === 'current' ? ' is-active' : ''}`}
                        onClick={() => setActiveList('current')}
                        role="tab"
                        aria-selected={activeList === 'current'}
                        data-testid="goals-tab-filter-current"
                      >
                        Current
                        <span className="goals-tab-filter-count">{goalTabs.current.length}</span>
                      </button>
                      <button
                        type="button"
                        className={`goals-tab-filter${activeList === 'past' ? ' is-active' : ''}`}
                        onClick={() => setActiveList('past')}
                        role="tab"
                        aria-selected={activeList === 'past'}
                        data-testid="goals-tab-filter-past"
                      >
                        Past
                        <span className="goals-tab-filter-count">{goalTabs.past.length}</span>
                      </button>
                    </div>
                    <div className="goals-tab-actions">
                      <button
                        type="button"
                        className="git-settings-button primary"
                        onClick={() => setIsClearDialogOpen(true)}
                        disabled={!projectId || isClearing || goals.length === 0}
                        data-testid="goals-clear-goals"
                      >
                        {isClearing ? 'Clearing…' : 'Clear goals'}
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="goals-modal-section-title">Goals</div>
              )}
              {isLoading && <div className="goals-modal-muted">Loading…</div>}
              {error && (
                <div className="goals-modal-error" role="alert">
                  {error}
                </div>
              )}

              <div className="goals-modal-goal-list" data-testid="goals-modal-goal-list">
                {displayGoalTree.length === 0 && !isLoading && !error && (
                  <div className="goals-modal-muted" data-testid="goals-tab-empty">
                    {activeList === 'past' ? 'No past goals yet.' : 'No current goals yet.'}
                  </div>
                )}
                {displayGoalTree.map((goal) => {
                  const renderGoalNode = (node, depth = 0) => {
                    const children = Array.isArray(node.children) ? node.children : [];
                    const progress = computeGoalProgress(node);
                    const groupDone = progress.total > 0 ? progress.done === progress.total : isGoalDone(node);
                    const goalPhase = normalizePhase(node.status);
                    const isChild = depth > 0;
                    const isPastRoot = isTabMode && activeList === 'past' && depth === 0;
                    const rootId = Number(node.id);
                    const isExpanded = isPastRoot && expandedPastGoalIds.has(rootId);
                    const canToggle = isPastRoot && rootId && children.length > 0;

                    return (
                      <div key={node.id} className="goals-modal-goal-group">
                        <div
                          className={`goals-modal-goal${isChild ? ' child' : ''}${groupDone ? ' done' : ''}${selectedGoalId === Number(node.id) ? ' is-selected' : ''}`}
                          data-testid={`goals-modal-goal-${node.id}`}
                          role="button"
                          tabIndex={0}
                          onClick={() => setSelectedGoalId(Number(node.id))}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              setSelectedGoalId(Number(node.id));
                            }
                          }}
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
                            {canToggle && (
                              <button
                                type="button"
                                className="goals-past-toggle"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  togglePastGoalExpanded(rootId);
                                }}
                                aria-expanded={isExpanded}
                                data-testid={`goals-past-toggle-${rootId}`}
                              >
                                {isExpanded ? 'Collapse' : 'Expand'}
                              </button>
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
                        </div>

                        {children.length > 0 && (!isPastRoot || isExpanded) && (
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
              {isTabMode ? (
                <>
                  <div className="goals-modal-section-title">Inspector</div>
                  {selectedGoal ? (
                    <pre className="goals-inspector-json" data-testid="goals-inspector-json">
                      {JSON.stringify(selectedGoal, null, 2)}
                    </pre>
                  ) : (
                    <div className="goals-modal-muted" data-testid="goals-inspector-empty">
                      Select a goal to inspect.
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="goals-modal-section-title">Actions</div>
                  <div className="goals-modal-muted">Remove all goals for this project.</div>
                  <div className="goals-modal-detail-actions">
                    <button
                      type="button"
                      className="git-settings-button primary"
                      onClick={() => setIsClearDialogOpen(true)}
                      disabled={!projectId || isClearing || goals.length === 0}
                      data-testid="goals-clear-goals"
                    >
                      {isClearing ? 'Clearing…' : 'Clear goals'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>
      {isClearDialogOpen && (
        <Modal
          isOpen={isClearDialogOpen}
          onClose={() => setIsClearDialogOpen(false)}
          onConfirm={handleClearGoals}
          title="Clear all goals?"
          message="This will permanently remove all goals and child goals for this project."
          confirmText="Clear goals"
          cancelText="Cancel"
          type="danger"
          isProcessing={isClearing}
          confirmLoadingText="Clearing…"
        />
      )}
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
  isPastGoalGroup,
  splitGoalTreeForTabs,
  computeGoalProgress,
  formatPhaseLabel
});
