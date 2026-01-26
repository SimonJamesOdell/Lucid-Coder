import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import './RunsTab.css';

const safeString = (value) => (typeof value === 'string' ? value : '');

const formatIso = (value) => {
  const iso = safeString(value).trim();
  if (!iso) return '';
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString();
  } catch {
    return iso;
  }
};

const formatDuration = (startedAt, finishedAt) => {
  const startIso = safeString(startedAt).trim();
  const endIso = safeString(finishedAt).trim();
  if (!startIso || !endIso) return '';
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '';
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${minutes}m ${rem}s`;
};

const statusClass = (status) => {
  const normalized = safeString(status).toLowerCase();
  if (normalized === 'completed') return 'is-completed';
  if (normalized === 'failed') return 'is-failed';
  if (normalized === 'cancelled') return 'is-cancelled';
  if (normalized === 'running') return 'is-running';
  return 'is-pending';
};

const RunsTab = ({ project }) => {
  const projectId = project?.id ?? null;
  const [runs, setRuns] = useState([]);
  const [selectedRunId, setSelectedRunId] = useState(null);
  const selectedRunIdRef = useRef(null);
  const [selectedRun, setSelectedRun] = useState(null);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState(null);

  const hasProject = Boolean(projectId);

  useEffect(() => {
    selectedRunIdRef.current = selectedRunId;
  }, [selectedRunId]);

  const loadRuns = useCallback(async () => {
    if (!projectId) {
      setRuns([]);
      setSelectedRunId(null);
      setSelectedRun(null);
      setEvents([]);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await axios.get(`/api/projects/${projectId}/runs`);
      const list = Array.isArray(response?.data?.runs)
        ? response.data.runs
        : Array.isArray(response?.data)
          ? response.data
          : [];

      setRuns(list);

      const currentSelected = selectedRunIdRef.current;
      if (currentSelected && !list.some((run) => run?.id === currentSelected)) {
        setSelectedRunId(null);
        setSelectedRun(null);
        setEvents([]);
      }
    } catch (err) {
      setError(err?.message || 'Failed to load runs');
      setRuns([]);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const loadRunDetails = useCallback(async (runId) => {
    /* c8 ignore next 5 */
    if (!projectId || !runId) {
      setSelectedRun(null);
      setEvents([]);
      return;
    }

    setDetailLoading(true);
    setError(null);

    try {
      const response = await axios.get(`/api/projects/${projectId}/runs/${runId}`, {
        params: { includeEvents: 1 }
      });
      const run = response?.data?.run || response?.data || null;
      const runEvents = Array.isArray(response?.data?.events)
        ? response.data.events
        : Array.isArray(run?.events)
          ? run.events
          : [];

      setSelectedRun(run);
      setEvents(runEvents);
    } catch (err) {
      setSelectedRun(null);
      setEvents([]);
      setError(err?.message || 'Failed to load run');
    } finally {
      setDetailLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    if (!selectedRunId) {
      setSelectedRun(null);
      setEvents([]);
      return;
    }

    void loadRunDetails(selectedRunId);
  }, [selectedRunId, loadRunDetails]);

  const sortedRuns = useMemo(() => {
    /* c8 ignore next */
    if (!Array.isArray(runs)) return [];
    return [...runs].sort((a, b) => Number(b?.id ?? 0) - Number(a?.id ?? 0));
  }, [runs]);

  return (
    <div className="runs-tab" data-testid="runs-tab-panel">
      <div className="runs-header">
        <div>
          <h2>Runs</h2>
          <p className="runs-subtitle">Persisted execution history for this project.</p>
        </div>
        <div className="runs-header-actions">
          <button
            type="button"
            className="secondary"
            onClick={() => void loadRuns()}
            disabled={!hasProject || loading}
            data-testid="runs-refresh"
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {!hasProject ? (
        <div className="runs-empty" data-testid="runs-empty">
          Select a project to view runs.
        </div>
      ) : (
        <div className="runs-layout">
          <aside className="runs-list" aria-label="Runs list">
            {error && (
              <div className="runs-error" role="alert" data-testid="runs-error">
                {error}
              </div>
            )}

            {sortedRuns.length === 0 && !loading ? (
              <div className="runs-none" data-testid="runs-none">
                No runs yet.
              </div>
            ) : (
              <ul className="runs-items" data-testid="runs-list">
                {sortedRuns.map((run) => {
                  const runId = run?.id ?? null;
                  const active = runId && runId === selectedRunId;
                  const label = safeString(run?.statusMessage) || safeString(run?.kind) || `Run ${runId}`;
                  return (
                    <li key={runId ?? label}>
                      <button
                        type="button"
                        className={`run-item${active ? ' is-active' : ''}`}
                        onClick={() => setSelectedRunId(runId)}
                        data-testid={runId ? `run-row-${runId}` : undefined}
                      >
                        <div className="run-item-top">
                          <span className={`run-status ${statusClass(run?.status)}`}>{safeString(run?.status) || 'pending'}</span>
                          <span className="run-kind">{safeString(run?.kind) || 'run'}</span>
                        </div>
                        <div className="run-label">{label}</div>
                        <div className="run-meta">
                          <span>{formatIso(run?.startedAt || run?.createdAt)}</span>
                          <span>{formatDuration(run?.startedAt, run?.finishedAt)}</span>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </aside>

          <section className="runs-detail" aria-label="Run details">
            {!selectedRunId ? (
              <div className="runs-detail-empty" data-testid="runs-detail-empty">
                Select a run to see details.
              </div>
            ) : detailLoading ? (
              <div className="runs-detail-loading" data-testid="runs-detail-loading">
                Loading…
              </div>
            ) : !selectedRun ? (
              <div className="runs-detail-missing" data-testid="runs-detail-missing">
                Run not found.
              </div>
            ) : (
              <>
                <div className="runs-detail-header">
                  <h3 data-testid="runs-detail-title">
                    {safeString(selectedRun.statusMessage) || `Run ${selectedRun.id}`}
                  </h3>
                  <div className="runs-detail-badges">
                    <span className={`run-status ${statusClass(selectedRun.status)}`}>{safeString(selectedRun.status) || 'pending'}</span>
                    <span className="run-kind">{safeString(selectedRun.kind) || 'run'}</span>
                  </div>
                </div>

                <div className="runs-detail-grid">
                  <div><span className="runs-detail-key">Started</span><span>{formatIso(selectedRun.startedAt || selectedRun.createdAt) || '—'}</span></div>
                  <div><span className="runs-detail-key">Finished</span><span>{formatIso(selectedRun.finishedAt) || '—'}</span></div>
                  <div><span className="runs-detail-key">Duration</span><span>{formatDuration(selectedRun.startedAt, selectedRun.finishedAt) || '—'}</span></div>
                  <div><span className="runs-detail-key">Session</span><span>{safeString(selectedRun.sessionId) || '—'}</span></div>
                </div>

                {safeString(selectedRun.error) ? (
                  <div className="runs-detail-error" role="alert" data-testid="runs-detail-error">
                    {selectedRun.error}
                  </div>
                ) : null}

                <div className="runs-events">
                  <h4>Timeline</h4>
                  {events.length === 0 ? (
                    <div className="runs-events-empty" data-testid="runs-events-empty">
                      No events.
                    </div>
                  ) : (
                    <ul className="runs-events-list" data-testid="runs-events-list">
                      {events.map((evt) => (
                        <li key={evt?.id || `${evt?.timestamp}-${evt?.type}-${evt?.message}`}
                          className="runs-event"
                        >
                          <div className="runs-event-top">
                            <span className="runs-event-time">{formatIso(evt?.timestamp)}</span>
                            <span className="runs-event-type">{safeString(evt?.type) || 'event'}</span>
                          </div>
                          {safeString(evt?.message) ? (
                            <pre className="runs-event-message">{evt.message}</pre>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
};

export default RunsTab;
