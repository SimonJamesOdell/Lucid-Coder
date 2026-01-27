import React from 'react';
import { formatTimestamp } from './formatters';

const CommitListPanel = ({
  projectId,
  commits,
  branchReadyToCommit,
  activeBranchName,
  isPendingSelected,
  stagedFiles,
  isCssOnlyStaged,
  squashSelection,
  squashInFlight,
  squashError,
  selectedCommitSha,
  onSelectPending,
  onSelectCommit,
  onToggleSquashSelection,
  onRequestSquash,
  onClearSquash
}) => (
  <aside className="commits-list-panel">
    {Boolean(squashSelection.length) && (
      <div className="commits-status-message" role="status" data-testid="commit-squash-bar">
        <span>{squashSelection.length} selected</span>
        <span aria-hidden="true"> • </span>
        <button
          type="button"
          className="commits-action"
          onClick={onRequestSquash}
          disabled={!projectId || squashSelection.length !== 2 || squashInFlight}
          data-testid="commit-squash-action"
        >
          {squashInFlight ? 'Squashing…' : 'Squash selected'}
        </button>
        <button
          type="button"
          className="commits-action ghost"
          onClick={onClearSquash}
          disabled={squashInFlight}
          data-testid="commit-squash-clear"
        >
          Clear
        </button>
      </div>
    )}

    {squashError && (
      <div className="error" role="alert" data-testid="commit-squash-error">
        {squashError}
      </div>
    )}
    <div className="commits-list" data-testid="commits-list">
      {branchReadyToCommit && (
        <button
          key={`pending:${activeBranchName}`}
          type="button"
          className={`commits-list-item pending${isPendingSelected ? ' selected' : ''}`}
          onClick={onSelectPending}
          data-testid="commit-pending"
        >
          <div className="commit-list-primary">
            <div className="commit-message" title={`Pending commit for ${activeBranchName}`}>Pending commit</div>
            <span className="commit-sha">{activeBranchName}</span>
          </div>
          <div className="commit-list-meta">
            <span>{stagedFiles.length} staged file{stagedFiles.length === 1 ? '' : 's'}</span>
            <span>•</span>
            <span>{isCssOnlyStaged ? 'CSS-only (tests optional)' : 'Tests passed'}</span>
          </div>
        </button>
      )}
      {commits.map((commit) => (
        <button
          key={commit.sha}
          type="button"
          className={`commits-list-item${commit.sha === selectedCommitSha ? ' selected' : ''}`}
          onClick={() => onSelectCommit(commit.sha)}
          data-testid={`commit-${commit.shortSha}`}
        >
          <div className="commit-list-primary">
            <input
              type="checkbox"
              checked={squashSelection.includes(commit.sha)}
              onChange={() => onToggleSquashSelection(commit.sha)}
              onClick={(event) => event.stopPropagation()}
              aria-label={`Select ${commit.shortSha} for squash`}
              data-testid={`commit-squash-select-${commit.shortSha}`}
            />
            <div className="commit-message" title={commit.message}>{commit.message || 'No message'}</div>
            <span className="commit-sha">{commit.shortSha}</span>
          </div>
          <div className="commit-list-meta">
            <span>{commit.author?.name || 'Unknown author'}</span>
            <span>•</span>
            <span>{formatTimestamp(commit.authoredAt)}</span>
          </div>
        </button>
      ))}
      {!commits.length && (
        <div className="commits-empty" data-testid="commits-empty">
          No commits found in this project yet.
        </div>
      )}
    </div>
  </aside>
);

export default CommitListPanel;
