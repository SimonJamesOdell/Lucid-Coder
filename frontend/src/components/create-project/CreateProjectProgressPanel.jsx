import React from 'react';

const CreateProjectProgressPanel = ({
  progress,
  processes,
  gitIgnoreSuggestion,
  gitIgnoreStatus,
  onApplyGitIgnore,
  onSkipGitIgnore,
  onContinueAfterGitIgnore
}) => {
  if (!progress) {
    return null;
  }

  return (
    <div className="progress-container">
      <h4>Creating your project...</h4>
      <div className="progress-bar" role="progressbar" aria-valuenow={progress.completion} aria-valuemin="0" aria-valuemax="100">
        <div
          className="progress-fill"
          style={{ width: `${progress.completion}%` }}
        ></div>
      </div>
      {progress.statusMessage && (
        <p className="progress-status">{progress.statusMessage}</p>
      )}
      {progress.status === 'failed' && progress.error && (
        <div className="progress-error">{progress.error}</div>
      )}
      <div className="progress-steps">
        {progress.steps.map((step, index) => (
          <div key={index} className={`progress-step ${step.completed ? 'completed' : ''}`}>
            <span className="step-icon">
              {step.completed ? '✓' : '●'}
            </span>
            <span className="step-name">{step.name}</span>
          </div>
        ))}
      </div>
      {processes && progress.completion === 100 && (
        <div className="success-info">
          <p>✅ Project created successfully!</p>
          <p>Frontend running on: <a href={`http://localhost:${processes.frontend.port}`} target="_blank" rel="noopener noreferrer">http://localhost:{processes.frontend.port}</a></p>
          <p>Backend running on: <a href={`http://localhost:${processes.backend.port}`} target="_blank" rel="noopener noreferrer">http://localhost:{processes.backend.port}</a></p>
        </div>
      )}
      {gitIgnoreSuggestion && gitIgnoreStatus.state !== 'working' && (
        <div className="gitignore-suggestion">
          <h5>This repo is missing information in it's .gitignore file which will result in issues when used with Lucid Coder.</h5>
          <p>
            If you want to continue, we can fix this issue automatically.
          </p>
          {gitIgnoreSuggestion.entries.length > 0 && (
            <p>
              Suggested entries:
            </p>
          )}
          <ul>
            {gitIgnoreSuggestion.entries.map((entry) => (
              <li key={entry}><code>{entry}</code></li>
            ))}
          </ul>
          {gitIgnoreSuggestion.trackedFiles?.length > 0 && (
            <p className="gitignore-warning">
              Note: installs will update tracked files ({gitIgnoreSuggestion.trackedFiles.join(', ')}),
              so the working tree may still show changes.
            </p>
          )}
          {gitIgnoreSuggestion.samplePaths?.length > 0 && (
            <p className="gitignore-sample">
              Detected: {gitIgnoreSuggestion.samplePaths.join(', ')}
            </p>
          )}
          {gitIgnoreStatus.state === 'error' && (
            <div className="gitignore-error">{gitIgnoreStatus.error}</div>
          )}
          <div className="gitignore-actions">
            {gitIgnoreStatus.state !== 'done' ? (
              <>
                <button
                  type="button"
                  className="git-settings-button primary"
                  onClick={onApplyGitIgnore}
                  disabled={gitIgnoreStatus.state === 'working'}
                >
                  Fix Issue
                </button>
                <button
                  type="button"
                  className="git-settings-button secondary"
                  onClick={onSkipGitIgnore}
                  disabled={gitIgnoreStatus.state === 'working'}
                >
                  Cancel Installation
                </button>
              </>
            ) : (
              <button
                type="button"
                className="git-settings-button primary"
                onClick={onContinueAfterGitIgnore}
              >
                Continue to project
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default CreateProjectProgressPanel;
