import React from 'react';
import {
  formatDurationSeconds,
  renderLogLines,
  statusLabel,
  isJobActive
} from './helpers.jsx';

const TestSuiteCard = ({ config, job, project, onRun, onCancel }) => {
  const active = isJobActive(job);
  const durationLabel = formatDurationSeconds(job);

  return (
    <div className="test-card" data-testid={`test-card-${config.type}`}>
      <div className="test-card-header">
        <div>
          <h4>{config.label}</h4>
          <p>{config.description}</p>
        </div>
        <span className={`job-status ${job?.status || 'idle'}`} data-testid={`job-status-${config.type}`}>
          {statusLabel(job?.status)}
        </span>
      </div>

      <div className="test-card-body">
        {job ? (
          <>
            <div className="job-meta">
              <code data-testid={`job-command-${config.type}`}>
                {job.command} {job.args?.join(' ') || ''}
              </code>
              <span className="job-cwd">{job.cwd}</span>
              {durationLabel && (
                <span className="job-duration">{durationLabel}</span>
              )}
            </div>
            <div className="job-logs" data-testid={`job-logs-${config.type}`}>
              {renderLogLines(job)}
            </div>
          </>
        ) : (
          <div className="test-empty-inline">
            <p>No runs yet. Kick off the first {config.label.toLowerCase()}.</p>
          </div>
        )}
      </div>

      <div className="test-card-actions">
        <button
          type="button"
          onClick={() => onRun(config.type)}
          disabled={!project || active}
          data-testid={`run-${config.type}`}
        >
          {active ? 'Running…' : `Run ${config.label}`}
        </button>
        {active && (
          <button
            type="button"
            className="secondary"
            onClick={() => onCancel(job)}
            data-testid={`cancel-${config.type}`}
          >
            Cancel Run
          </button>
        )}
      </div>
    </div>
  );
};

export default TestSuiteCard;
