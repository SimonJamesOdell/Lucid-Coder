import React from 'react';
import { safeTestId } from './utils';

const CommittedFilesCard = ({
  files,
  onOpenFile,
  isLoading = false,
  branchName,
  primaryActionLabel,
  primaryActionTestId,
  onPrimaryAction,
  isPrimaryActionDisabled = false
}) => {
  const normalizedFiles = Array.isArray(files) ? files.filter(Boolean) : [];
  const hasFiles = normalizedFiles.length > 0;

  return (
    <div className="branch-files-card" data-testid="branch-committed-files-card">
      <div className="panel-header">
        <div>
          <p className="panel-eyebrow">Committed files</p>
          <h4>
            {isLoading
              ? 'Loading…'
              : (hasFiles
                ? `${normalizedFiles.length} file${normalizedFiles.length === 1 ? '' : 's'}`
                : 'No committed changes')}
          </h4>
          {branchName && (
            <p className="panel-count" data-testid="branch-committed-files-branch">
              {branchName}
            </p>
          )}
        </div>

        {primaryActionLabel && (
          <div className="branch-actions-row">
            <button
              type="button"
              className="branch-action success"
              onClick={onPrimaryAction}
              disabled={!onPrimaryAction || isPrimaryActionDisabled}
              data-testid={primaryActionTestId}
            >
              {primaryActionLabel}
            </button>
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="branch-no-files" data-testid="branch-committed-files-loading">
          Fetching committed changes…
        </div>
      ) : (
        hasFiles ? (
          <ul className="branch-file-list" data-testid="branch-committed-file-list">
            {normalizedFiles.map((filePath) => (
              <li key={filePath} className="branch-file-entry">
                <button
                  type="button"
                  className="branch-file-button"
                  onClick={() => onOpenFile?.(filePath)}
                  data-testid={`branch-committed-file-${safeTestId(filePath)}`}
                >
                  <div className="branch-file-name">{filePath}</div>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="branch-no-files" data-testid="branch-committed-no-files">
            No committed file changes detected for this branch.
          </div>
        )
      )}
    </div>
  );
};

export default CommittedFilesCard;
