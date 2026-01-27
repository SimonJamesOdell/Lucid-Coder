import React from 'react';
import StagedFilesCard from './StagedFilesCard';
import CommittedFilesCard from './CommittedFilesCard';

const BranchDetails = ({
  warningMessage,
  canCheckout,
  onCheckout,
  checkoutTestId,
  checkoutLabel,
  canDelete,
  onDeleteBranch,
  deleteLabel,
  isDeleting,
  isStoppingProject,
  selectedFiles,
  hasSelectedFiles,
  onClearAll,
  onOpenFile,
  onClearFile,
  isCurrentBranch,
  showWorkingPanels = true,
  onBeginTesting,
  canBeginTesting,
  isBeginningTesting,
  onSkipTesting,
  canSkipTesting,
  showCssOnlySkipHint,
  readyForMerge,
  onMerge,
  canMerge,
  isMerging,
  committedFiles,
  isLoadingCommittedFiles,
  committedFilesBranchName
}) => (
  <section className="branch-details-panel" data-testid="branch-details-panel">
    {warningMessage && (
      <div className="branch-warning" data-testid="branch-warning">
        {warningMessage}
      </div>
    )}

    {canCheckout && (
      <div className="branch-actions-row">
        <button
          type="button"
          className="branch-action secondary"
          onClick={onCheckout}
          disabled={isStoppingProject}
          data-testid={checkoutTestId}
        >
          {checkoutLabel}
        </button>
      </div>
    )}

    {showWorkingPanels ? (
      <>
        <StagedFilesCard
          selectedFiles={selectedFiles}
          hasSelectedFiles={hasSelectedFiles}
          onOpenFile={onOpenFile}
          onClearFile={onClearFile}
          onClearAll={onClearAll}
          canDelete={canDelete}
          onDeleteBranch={onDeleteBranch}
          deleteLabel={deleteLabel}
          isDeleting={isDeleting}
          isStoppingProject={isStoppingProject}
          isCurrentBranch={isCurrentBranch}
        />

        {readyForMerge && !hasSelectedFiles && (
          <CommittedFilesCard
            files={committedFiles}
            onOpenFile={onOpenFile}
            isLoading={isLoadingCommittedFiles}
            branchName={committedFilesBranchName}
            primaryActionLabel={
              Array.isArray(committedFiles) && committedFiles.length > 0
                ? (isMerging ? 'Merging…' : 'Merge Now')
                : null
            }
            primaryActionTestId="branch-merge"
            onPrimaryAction={onMerge}
            isPrimaryActionDisabled={Boolean(!canMerge || isMerging || isStoppingProject)}
          />
        )}

        {readyForMerge ? (
          (Array.isArray(committedFiles) && committedFiles.length > 0 && !hasSelectedFiles)
            ? null
            : (
              <div className="branch-commit-card" data-testid="branch-merge-card">
                <div className="panel-header">
                  <div>
                    <p className="panel-eyebrow">Merge</p>
                    <h4>Branch Status : Ready to merge</h4>
                  </div>
                  <div className="branch-actions-row">
                    <button
                      type="button"
                      className="branch-action success large"
                      onClick={onMerge}
                      disabled={!onMerge || !canMerge || isMerging || isStoppingProject}
                      data-testid="branch-merge"
                    >
                      {isMerging ? 'Merging…' : 'Merge into main'}
                    </button>
                  </div>
                </div>
              </div>
            )
        ) : (
          <div className="branch-commit-card" data-testid="branch-begin-testing-card">
            <div className="panel-header">
              <div>
                <p className="panel-eyebrow">Testing</p>
                <h4>Branch Status : Untested</h4>
                {showCssOnlySkipHint && (
                  <p className="panel-count" data-testid="branch-css-only-skip-hint">
                    (Branch is CSS only skip test available)
                  </p>
                )}
              </div>
              <div className="branch-actions-row">
                <button
                  type="button"
                  className="branch-action success large"
                  onClick={onBeginTesting}
                  disabled={!onBeginTesting || !canBeginTesting || isBeginningTesting}
                  data-testid="branch-begin-testing"
                >
                  {isBeginningTesting ? 'Running tests…' : 'Begin testing'}
                </button>
                {canSkipTesting && (
                  <button
                    type="button"
                    className="branch-action secondary large"
                    onClick={onSkipTesting}
                    disabled={!onSkipTesting || isBeginningTesting}
                    data-testid="branch-skip-testing"
                  >
                    Skip testing
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </>
    ) : (
      <div className="branch-files-card" data-testid="branch-main-info">
        <div className="panel-header">
          <div>
            <p className="panel-eyebrow">Main branch</p>
            <h4>Work happens on feature branches</h4>
          </div>
        </div>
        <div className="branch-no-files" data-testid="branch-main-message">
          Create or select a working branch to stage changes and run tests.
        </div>
      </div>
    )}
  </section>
);

export default BranchDetails;
