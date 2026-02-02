import React, { useEffect, useMemo, useState } from 'react';
import './ProcessesTab.css';

export const normalizeStatus = (status) => (status ? status : 'idle');

export const formatTimestamp = (value) => {
  if (!value) {
    return 'Just now';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Recently';
  }
  return date.toLocaleTimeString();
};

export const resolvePortValue = (ports, key) => {
  if (!ports) {
    return null;
  }
  return ports.active?.[key] ?? ports.stored?.[key] ?? ports.preferred?.[key] ?? null;
};

export const deriveDisplayStatus = (process) => {
  const rawStatus = normalizeStatus(process?.status);
  if (rawStatus === 'starting') {
    const hasActivity = Boolean(
      process?.port ||
      process?.lastHeartbeat ||
      (Array.isArray(process?.logs) && process.logs.length > 0)
    );
    if (hasActivity) {
      return 'running';
    }
  }
  return rawStatus;
};

export const ProcessColumn = ({
  label,
  processKey,
  process,
  ports,
  onRefresh,
  onRestart,
  onStop,
  isRefreshing,
  isRestarting,
  isStopping
}) => {
  const status = deriveDisplayStatus(process);
  const statusClass = status.replace(/\s+/g, '-');
  const columnKey = processKey || label.toLowerCase();
  const portLabel = resolvePortValue(ports, columnKey);
  const logs = Array.isArray(process?.logs) ? process.logs : [];
  const restartIdle = status === 'idle';
  const restartLabel = restartIdle ? 'Start project' : 'Restart project';
  const restartingLabel = restartIdle ? 'Starting…' : 'Restarting…';
  const stopDisabled = isStopping || status === 'idle' || !onStop;

  return (
    <div className="process-column" data-testid={`process-column-${columnKey}`}>
      <div className="process-card">
        <div className="process-card-header">
          <h4>{label}</h4>
          <span className={`process-status-badge status-${statusClass}`}>{status}</span>
        </div>
        <dl className="process-meta">
          <div>
            <dt>PID</dt>
            <dd>{process?.pid ?? '—'}</dd>
          </div>
          <div>
            <dt>Port</dt>
            <dd>{portLabel ?? '—'}</dd>
          </div>
          <div>
            <dt>Last heartbeat</dt>
            <dd>{process?.lastHeartbeat ? formatTimestamp(process.lastHeartbeat) : 'Not available'}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd className="process-meta-status">{status}</dd>
          </div>
        </dl>
        <div className="process-controls">
          <button
            type="button"
            className="process-control-btn"
            onClick={onRefresh}
            disabled={isRefreshing}
            data-testid={`process-refresh-${columnKey}`}
          >
            {isRefreshing ? 'Checking…' : 'Refresh status'}
          </button>
          <button
            type="button"
            className={`process-control-btn ${restartIdle ? 'positive' : 'destructive'}`}
            onClick={onRestart}
            disabled={isRestarting}
            data-testid={`process-restart-${columnKey}`}
          >
            {isRestarting ? restartingLabel : restartLabel}
          </button>
          <button
            type="button"
            className="process-control-btn destructive"
            onClick={onStop}
            disabled={stopDisabled}
            data-testid={`process-stop-${columnKey}`}
          >
            {isStopping ? 'Stopping…' : 'Stop project'}
          </button>
        </div>
      </div>

      <div className="process-logs" data-testid={`process-logs-${label.toLowerCase()}`}>
        <div className="process-logs-header">Console output</div>
        {logs.length > 0 ? (
          <div className="process-log-list">
            {logs.map((log, index) => (
              <div key={`${label}-log-${index}`} className={`log-entry log-${log.stream || 'stdout'}`}>
                <span className="log-timestamp">{formatTimestamp(log.timestamp)}</span>
                <pre className="log-message">{log.message}</pre>
              </div>
            ))}
          </div>
        ) : (
          <div className="log-empty">No output captured yet.</div>
        )}
      </div>
    </div>
  );
};

export const computeProcessSnapshot = (projectId, processInfo) => {
  if (!projectId || !processInfo || processInfo.projectId !== projectId) {
    return {
      processes: { frontend: null, backend: null },
      ports: null
    };
  }
  return {
    processes: {
      frontend: processInfo.processes?.frontend || null,
      backend: processInfo.processes?.backend || null
    },
    ports: processInfo.ports || null
  };
};

const ProcessesTab = ({
  project,
  processInfo,
  onRefreshStatus,
  onRestartProject,
  onStopProject,
  onCreateBackend
}) => {
  const [refreshingState, setRefreshingState] = useState({ frontend: false, backend: false });
  const [restartingState, setRestartingState] = useState({ frontend: false, backend: false });
  const [stoppingState, setStoppingState] = useState({ frontend: false, backend: false });
  const [creatingBackend, setCreatingBackend] = useState(false);
  const [createBackendError, setCreateBackendError] = useState('');

  useEffect(() => {
    setRefreshingState({ frontend: false, backend: false });
    setRestartingState({ frontend: false, backend: false });
    setStoppingState({ frontend: false, backend: false });
  }, [project?.id]);

  const snapshot = useMemo(
    () => computeProcessSnapshot(project?.id, processInfo),
    [project?.id, processInfo]
  );
  const processes = snapshot.processes;
  const ports = snapshot.ports;
  const hasBackend = processInfo?.capabilities?.backend?.exists ?? true;

  const stopEnabled = Boolean(project?.id && onStopProject);

  const handleRefresh = async (target) => {
    if (!project?.id || !onRefreshStatus || refreshingState[target]) {
      return;
    }
    setRefreshingState((prev) => ({ ...prev, [target]: true }));
    try {
      await onRefreshStatus(project.id);
    } finally {
      setRefreshingState((prev) => ({ ...prev, [target]: false }));
    }
  };

  const handleRestart = async (target) => {
    if (!project?.id || !onRestartProject || restartingState[target]) {
      return;
    }
    setRestartingState((prev) => ({ ...prev, [target]: true }));
    try {
      await onRestartProject(project.id, target);
    } finally {
      setRestartingState((prev) => ({ ...prev, [target]: false }));
    }
  };

  const handleStop = async (target) => {
    setStoppingState((prev) => ({ ...prev, [target]: true }));
    try {
      await onStopProject(project.id, target);
    } finally {
      setStoppingState((prev) => ({ ...prev, [target]: false }));
    }
  };

  const handleCreateBackend = async () => {
    if (!project?.id || !onCreateBackend || creatingBackend) {
      return;
    }
    setCreatingBackend(true);
    setCreateBackendError('');
    try {
      await onCreateBackend(project.id);
    } catch (error) {
      setCreateBackendError(error?.message || 'Failed to create backend');
    } finally {
      setCreatingBackend(false);
    }
  };

  if (!project) {
    return (
      <div className="processes-tab empty" data-testid="processes-tab-empty">
        Select a project to view process details.
      </div>
    );
  }

  return (
    <div className="processes-tab" data-testid="processes-tab">
      <div className="processes-grid">
        <ProcessColumn
          label="Frontend"
          processKey="frontend"
          process={processes.frontend}
          ports={ports}
          onRefresh={() => handleRefresh('frontend')}
          onRestart={() => handleRestart('frontend')}
          onStop={stopEnabled ? () => handleStop('frontend') : null}
          isRefreshing={refreshingState.frontend}
          isRestarting={restartingState.frontend}
          isStopping={stoppingState.frontend}
        />
        {hasBackend ? (
          <ProcessColumn
            label="Backend"
            processKey="backend"
            process={processes.backend}
            ports={ports}
            onRefresh={() => handleRefresh('backend')}
            onRestart={() => handleRestart('backend')}
            onStop={stopEnabled ? () => handleStop('backend') : null}
            isRefreshing={refreshingState.backend}
            isRestarting={restartingState.backend}
            isStopping={stoppingState.backend}
          />
        ) : (
          <div className="process-column" data-testid="process-column-backend">
            <div className="process-card process-empty">
              <div className="process-card-header">
                <h4>Backend</h4>
              </div>
              <p className="process-empty-text">This project doesn’t have a backend yet.</p>
              {createBackendError && (
                <p className="process-empty-error">{createBackendError}</p>
              )}
              <div className="process-controls">
                <button
                  type="button"
                  className="process-control-btn"
                  onClick={handleCreateBackend}
                  disabled={creatingBackend || !onCreateBackend}
                  data-testid="process-create-backend"
                >
                  {creatingBackend ? 'Creating backend…' : 'Create backend'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ProcessesTab;
