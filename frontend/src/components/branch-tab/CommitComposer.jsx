import React from 'react';

const CommitComposer = ({
  hasSelectedFiles,
  commitSubject,
  commitBody,
  onSubjectChange,
  onBodyChange,
  onCommit,
  onAutofill,
  onClearChanges,
  canAutofill,
  canCommit,
  isCommitting,
  isClearing,
  commitHint,
  isGenerating,
  commitMessageError
}) => (
  <div className="branch-commit-card">
    <div className="panel-header">
      <div>
        <p className="panel-eyebrow">Commit message</p>
        <h4>{hasSelectedFiles ? 'Describe the staged changes' : 'Add staged files to enable commits'}</h4>
      </div>
    </div>
    <input
      type="text"
      className="branch-commit-subject"
      value={commitSubject}
      onChange={(event) => onSubjectChange(event.target.value)}
      placeholder="Short summary (≤72 chars)"
      disabled={!hasSelectedFiles || isGenerating || isCommitting || isClearing}
      maxLength={160}
      data-testid="branch-commit-subject"
    />
    <textarea
      className="branch-commit-textarea"
      value={commitBody}
      onChange={(event) => onBodyChange(event.target.value)}
      placeholder="Add more context about what changed and why"
      rows={5}
      disabled={!hasSelectedFiles || isGenerating || isCommitting || isClearing}
      data-testid="branch-commit-input"
    />
    {commitMessageError && (
      <div className="branch-inline-error" role="alert" data-testid="branch-commit-error">
        {commitMessageError}
      </div>
    )}
    {(commitHint && !canCommit) && (
      <p className="branch-commit-hint" data-testid="branch-commit-hint">{commitHint}</p>
    )}
    <div className="branch-actions-row">
      {onAutofill && (
        <button
          type="button"
          className="branch-action secondary"
          onClick={onAutofill}
          disabled={!canAutofill || !hasSelectedFiles || isGenerating || isCommitting || isClearing}
          data-testid="branch-commit-autofill"
        >
          {isGenerating ? 'Autofilling…' : 'Autofill with AI'}
        </button>
      )}
      {onClearChanges && (
        <button
          type="button"
          className="branch-action destructive branch-action-clear-changes"
          onClick={onClearChanges}
          disabled={!hasSelectedFiles || isGenerating || isCommitting || isClearing}
          data-testid="branch-commit-clear"
        >
          <span className="branch-action-icon" aria-hidden="true">🗑️</span>
          {isClearing ? 'Clearing…' : 'Clear changes'}
        </button>
      )}
      <button
        type="button"
        className="branch-action primary"
        onClick={onCommit}
        disabled={!canCommit || isCommitting || isClearing}
        data-testid="branch-commit-submit"
      >
        {isCommitting ? 'Committing…' : 'Commit staged changes'}
      </button>
    </div>
  </div>
);

export default CommitComposer;
