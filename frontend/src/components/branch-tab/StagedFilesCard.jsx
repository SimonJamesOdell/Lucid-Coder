import React from 'react';
import { safeTestId } from './utils';

const formatStagedMeta = (change) => (change.source === 'ai' ? 'AI Assistant' : 'Editor Save');

const formatTimestamp = (value) => {
  if (!value) {
    return 'Just now';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Recently';
  }
  return date.toLocaleTimeString();
};

const StagedFilesCard = ({
  selectedFiles,
  hasSelectedFiles,
  onOpenFile,
  onClearFile,
  onClearAll,
  isStoppingProject,
  isCurrentBranch
}) => (
  <div className="branch-files-card">
    <div className="panel-header">
      <div>
        <p className="panel-eyebrow">Staged files</p>
        <h4>
          {hasSelectedFiles
            ? `${selectedFiles.length} file${selectedFiles.length === 1 ? '' : 's'}`
            : (isCurrentBranch ? 'No staged changes' : 'No files staged')}
        </h4>
      </div>
      {hasSelectedFiles && (
        <button
          type="button"
          className="branch-action ghost"
          onClick={onClearAll}
          disabled={isStoppingProject}
          data-testid="clear-staged-inline"
        >
          Clear all
        </button>
      )}
    </div>

    {hasSelectedFiles ? (
      <ul className="branch-file-list" data-testid="branch-file-list">
        {selectedFiles.map((file) => (
          <li key={`${file.path}-${file.timestamp}`} className="branch-file-entry">
            <button
              type="button"
              className="branch-file-button has-overlay"
              onClick={() => onOpenFile(file.path)}
              data-testid={`branch-file-${safeTestId(file.path)}`}
            >
              <div className="branch-file-name">{file.path}</div>
              <div className="branch-file-meta">
                <span>{formatStagedMeta(file)}</span>
                <span>•</span>
                <span>{formatTimestamp(file.timestamp)}</span>
              </div>
            </button>
            <button
              type="button"
              className="branch-file-clear overlay"
              onClick={() => onClearFile(file.path)}
              disabled={isStoppingProject}
              data-testid={`branch-file-clear-${safeTestId(file.path)}`}
              aria-label={`Clear ${file.path}`}
            >
              Clear
            </button>
          </li>
        ))}
      </ul>
    ) : (
      <div className="branch-no-files" data-testid="branch-no-files">
        {isCurrentBranch
          ? 'Save a file or ask the assistant to edit code to stage it here.'
          : 'No staged files on this branch yet.'}
      </div>
    )}
  </div>
);

export default StagedFilesCard;
