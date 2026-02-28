import React from 'react';
import Modal from '../Modal';

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

  const missingEntries = Array.isArray(gitIgnoreSuggestion?.entries)
    ? gitIgnoreSuggestion.entries.filter((entry) => typeof entry === 'string' && entry.trim())
    : [];
  const trackedInstallFiles = Array.isArray(gitIgnoreSuggestion?.trackedFiles)
    ? gitIgnoreSuggestion.trackedFiles.filter((entry) => typeof entry === 'string' && entry.trim())
    : [];

  const issueSummaryParts = [];
  if (missingEntries.length > 0) {
    issueSummaryParts.push(`missing .gitignore entries: ${missingEntries.join(', ')}`);
  }
  if (trackedInstallFiles.length > 0) {
    issueSummaryParts.push(`tracked install files: ${trackedInstallFiles.join(', ')}`);
  }
  const issueSummaryText = issueSummaryParts.length > 0
    ? issueSummaryParts.join('; ')
    : 'setup detected .gitignore issues for this repository.';

  const hasMissingEntries = missingEntries.length > 0;
  const hasTrackedInstallFiles = trackedInstallFiles.length > 0;

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
      <Modal
        isOpen={Boolean(gitIgnoreSuggestion) && gitIgnoreStatus.state !== 'working'}
        onClose={gitIgnoreStatus.state === 'done' ? onContinueAfterGitIgnore : onSkipGitIgnore}
        onConfirm={gitIgnoreStatus.state === 'done' ? onContinueAfterGitIgnore : onApplyGitIgnore}
        contentClassName="modal-wide"
        title="Fix .gitignore issues"
        message={(
          <div className="gitignore-suggestion">
            <h5>Setup check failed: this repository has .gitignore issues that can break Lucid Coder setup.</h5>
            <p>
              Detected issue: {issueSummaryText}
            </p>
            {hasTrackedInstallFiles && (
              <p>
                Why this is a problem: dependency installs modify these tracked files, which can leave your working tree dirty and make
                Lucid Coder detect unrelated file changes.
              </p>
            )}
            {hasMissingEntries && (
              <p>
                Why this is a problem: generated dependency/build artifacts can be committed by mistake and interfere with automation.
              </p>
            )}
            <p>
              What auto-fix will change: {hasMissingEntries
                ? `append ${missingEntries.length} missing entr${missingEntries.length === 1 ? 'y' : 'ies'} to .gitignore${hasTrackedInstallFiles ? ' and commit .gitignore.' : '.'}`
                : 'no new .gitignore entries will be added.'}
              {hasTrackedInstallFiles
                ? ' Already tracked files (for example package-lock.json) are not untracked automatically.'
                : ''}
            </p>
            <p>
              If you want to continue, we can fix this automatically.
            </p>
            {gitIgnoreSuggestion?.entries?.length > 0 && (
              <p>
                Missing .gitignore entries:
              </p>
            )}
            <ul>
              {(gitIgnoreSuggestion?.entries || []).map((entry) => (
                <li key={entry}><code>{entry}</code></li>
              ))}
            </ul>
            {gitIgnoreSuggestion?.trackedFiles?.length > 0 && (
              <p className="gitignore-warning">
                Note: installs will update tracked files ({gitIgnoreSuggestion.trackedFiles.join(', ')}),
                so the working tree may still show changes.
              </p>
            )}
            {gitIgnoreSuggestion?.samplePaths?.length > 0 && (
              <p className="gitignore-sample">
                Detected: {gitIgnoreSuggestion.samplePaths.join(', ')}
              </p>
            )}
            {gitIgnoreStatus.state === 'error' && (
              <div className="gitignore-error">{gitIgnoreStatus.error}</div>
            )}
          </div>
        )}
        confirmText={gitIgnoreStatus.state === 'done' ? 'Continue to project' : 'Fix Issue'}
        cancelText={gitIgnoreStatus.state === 'done' ? 'Close' : 'Cancel Installation'}
        type="warning"
        dismissOnBackdrop={false}
        dismissOnEscape={false}
      />
    </div>
  );
};

export default CreateProjectProgressPanel;
