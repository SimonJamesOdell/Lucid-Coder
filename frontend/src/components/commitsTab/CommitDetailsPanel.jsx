import React from 'react';
import CommitComposer from '../branch-tab/CommitComposer';
import { formatGateValue, formatTimestamp } from './formatters';

const CommitDetailsPanel = ({
  projectId,
  statusMessage,
  gateStatus,
  mergeActionError,
  mergeBlockedBannerMessage,
  branchReadyToMerge,
  shouldShowCommitComposer,
  activeBranchName,
  stagedFiles,
  isCssOnlyStaged,
  mergeIsCssOnly,
  handleMergeBranch,
  mergeInFlight,
  commitInFlight,
  shouldShowTestingCta,
  testsStatus,
  onStartTesting,
  hideCommitDetails,
  hasStagedFiles,
  commitSubject,
  commitBody,
  onSubjectChange,
  onBodyChange,
  onCommit,
  onClearChanges,
  onAutofill,
  canAutofill,
  canCommit,
  commitHint,
  isGeneratingCommit,
  isClearingChanges,
  commitMessageError,
  selectedCommit,
  isDetailLoading,
  selectedDetails,
  canRevertSelectedCommit,
  revertingSha,
  requestRevertCommit,
  handleOpenFileFromCommit,
  canOpenFiles,
  branchReadyToCommit
}) => {
  const shouldShowBranchGate = Boolean(
    hasStagedFiles ||
    shouldShowCommitComposer ||
    branchReadyToMerge ||
    shouldShowTestingCta ||
    mergeInFlight ||
    commitInFlight
  );

  const shouldShowMergeBlockedBanner = Boolean(
    !mergeActionError
    && shouldShowBranchGate
    && mergeBlockedBannerMessage
    && (!gateStatus?.merge || !String(gateStatus.merge).includes(mergeBlockedBannerMessage))
  );

  return (
    <section className="commits-details-panel" data-testid="commit-details-panel">
    {statusMessage && (
      <div className="commits-status-message" role="status">
        {statusMessage}
      </div>
    )}

    {shouldShowTestingCta && (
      <div className="commits-status-message with-action" role="status" data-testid="commit-tests-required">
        <div>
          {testsStatus === 'pending'
            ? 'Automated testing is currently running. Please wait…'
            : 'This branch needs a successful, recorded test run before it can be merged. Start testing to continue.'}
        </div>
        <button
          type="button"
          className="commits-action"
          onClick={onStartTesting}
          disabled={!onStartTesting || testsStatus === 'pending'}
          data-testid="commit-start-tests"
        >
          Start testing
        </button>
      </div>
    )}

    {shouldShowBranchGate && gateStatus && (
      <div className="commits-status-message" role="status" data-testid="commit-gate-status">
        <span data-testid="commit-gate-tests">Tests: {formatGateValue(gateStatus.tests)}</span>
        <span aria-hidden="true"> • </span>
        <span data-testid="commit-gate-coverage">Coverage: {formatGateValue(gateStatus.coverage)}</span>
        <span aria-hidden="true"> • </span>
        <span data-testid="commit-gate-merge">Merge: {formatGateValue(gateStatus.merge)}</span>
      </div>
    )}

    {mergeActionError && (
      <div className="error" role="alert">
        {mergeActionError}
      </div>
    )}

    {shouldShowMergeBlockedBanner && (
      <div className="commits-status-message" role="status" data-testid="commit-merge-blocked">
        Merge blocked: {mergeBlockedBannerMessage}
      </div>
    )}

    {branchReadyToMerge && !shouldShowCommitComposer && (
      <div className="commit-pending-header" data-testid="commit-merge-header">
        <div>
          <p className="panel-eyebrow">Ready to merge</p>
          <h3 data-testid="commit-merge-branch">{activeBranchName}</h3>
          <div className="commit-detail-meta">
            <span>No staged changes</span>
            <span>•</span>
            <span>{mergeIsCssOnly ? 'CSS-only (tests optional)' : 'Tests passed'}</span>
          </div>
        </div>
        <button
          type="button"
          className="commits-action success"
          onClick={handleMergeBranch}
          disabled={mergeInFlight || commitInFlight}
          data-testid="commit-merge"
        >
          {mergeInFlight ? 'Merging…' : 'Merge into main'}
        </button>
      </div>
    )}

    {shouldShowCommitComposer && (
      <div className="commit-pending-header" data-testid="commit-pending-header">
        <div>
          <p className="panel-eyebrow">Ready to commit</p>
          <h3 data-testid="commit-pending-branch">{activeBranchName}</h3>
          <div className="commit-detail-meta">
            <span>{stagedFiles.length} staged file{stagedFiles.length === 1 ? '' : 's'}</span>
            <span>•</span>
            <span>{isCssOnlyStaged ? 'CSS-only (skip tests allowed)' : 'Tests passed'}</span>
          </div>
        </div>
      </div>
    )}

    {shouldShowCommitComposer && (
      <CommitComposer
        hasSelectedFiles={hasStagedFiles}
        commitSubject={commitSubject}
        commitBody={commitBody}
        onSubjectChange={onSubjectChange}
        onBodyChange={onBodyChange}
        onCommit={onCommit}
        onClearChanges={onClearChanges}
        onAutofill={onAutofill}
        canAutofill={canAutofill}
        canCommit={canCommit}
        isCommitting={commitInFlight}
        isClearing={isClearingChanges}
        commitHint={commitHint}
        isGenerating={isGeneratingCommit}
        commitMessageError={commitMessageError}
      />
    )}

    {selectedCommit ? (
      <>
        <div className="commit-detail-header">
          <div>
            <p className="panel-eyebrow">Selected commit</p>
            <h3>{selectedCommit.message || 'No message provided'}</h3>
            <div className="commit-detail-meta">
              <span>{selectedCommit.shortSha}</span>
              <span>•</span>
              <span>{selectedCommit.author?.name || 'Unknown author'}</span>
              <span>•</span>
              <span>{formatTimestamp(selectedCommit.authoredAt)}</span>
            </div>
          </div>
          {canRevertSelectedCommit && (
            <button
              type="button"
              className="commits-action destructive"
              onClick={() => requestRevertCommit(selectedCommit.sha)}
              disabled={!projectId || revertingSha === selectedCommit.sha}
              data-testid="commit-revert"
            >
              {revertingSha === selectedCommit.sha ? 'Reverting…' : 'Revert commit'}
            </button>
          )}
        </div>

        {isDetailLoading && (
          <div className="loading" data-testid="commit-details-loading">Loading commit details…</div>
        )}

        {!isDetailLoading && selectedDetails && !hideCommitDetails && (
          <>
            <div className="commit-detail-body">
              <p>{selectedDetails.body || 'No extended description for this commit.'}</p>
            </div>
            <div className="commit-files-card">
              <div className="panel-header">
                <div>
                  <p className="panel-eyebrow">Changed files</p>
                  <h4>
                    {selectedDetails.files?.length
                      ? `${selectedDetails.files.length} file${selectedDetails.files.length === 1 ? '' : 's'}`
                      : 'No file metadata available'}
                  </h4>
                </div>
              </div>
              {selectedDetails.files?.length ? (
                <ul className="commit-files-list" data-testid="commit-files-list">
                  {selectedDetails.files.map((file, index) => (
                    <li key={`${selectedDetails.sha}-${file.path}`}>
                      <button
                        type="button"
                        className="commit-file-entry"
                        onClick={() => handleOpenFileFromCommit(file.path)}
                        disabled={!canOpenFiles}
                        data-testid={`commit-file-open-${index}`}
                        title={canOpenFiles ? `Open ${file.path}` : undefined}
                      >
                        <span className={`commit-file-status status-${file.status?.toLowerCase() || 'm'}`}>
                          {file.status || 'M'}
                        </span>
                        <span className="commit-file-path">{file.path}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="commits-empty" data-testid="commit-no-files">
                  File-level details unavailable for this commit.
                </div>
              )}
            </div>
          </>
        )}

        {!isDetailLoading && !selectedDetails && !hideCommitDetails && (
          <div className="commits-empty" data-testid="commit-details-missing">
            Commit metadata is unavailable for this selection.
          </div>
        )}
      </>
    ) : (
      <div className="commits-empty" data-testid="commit-no-selection">
        {branchReadyToCommit
          ? 'Select the pending commit to author a message, or select a commit to view details.'
          : 'Select a commit to view details.'}
      </div>
    )}
    </section>
  );
};

export default CommitDetailsPanel;
