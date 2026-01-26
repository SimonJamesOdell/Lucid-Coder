import React, { useMemo, useCallback, useState } from 'react';
import useBranchTabState from './useBranchTabState';
import useToolbarActions from './useToolbarActions';
import BranchSidebar from './BranchSidebar';
import BranchDetails from './BranchDetails';
import { canBranchMerge, deriveDisplayStatus } from './utils';
import NewBranchModal from './NewBranchModal';
import { useAppState } from '../../context/AppStateContext';

const BranchTabRoot = ({ project, onRequestFileOpen, onRequestTestsTab, onRequestCommitsTab, registerBranchActions }) => {
  const { syncBranchOverview } = useAppState();

  const branchState = useBranchTabState({
    project,
    onRequestTestsTab,
    onRequestCommitsTab,
    onRequestFileOpen,
    getCommitMessageForBranch: null,
    clearCommitMessageForBranch: null
  });

  const {
    loading,
    error,
    showShutdownBanner,
    shutdownError,
    isStoppingProject,
    branchListMode,
    setBranchListMode,
    openBranchCount,
    pastBranchCount,
    branchSummaries,
    sortedBranches,
    selectedBranchName,
    setSelectedBranch,
    selectedSummary,
    selectedWorkingBranch,
    workingBranchMap,
    selectedFiles,
    hasSelectedFiles,
    mergeWarning,
    branchTestValidity,
    testInFlight,
    mergeInFlight,
    testMergeInFlight,
    skipMergeInFlight,
    deleteInFlight,
    handleRunTests,
    handleMergeBranch,
    handleTestAndMerge,
    handleDeleteBranch,
    handleCheckoutBranch,
    handleClearStaged,
    handleClearFile,
    handleOpenFile,
    handleCreateBranch,
    selectedBranchRef,
    createBranchInFlight
  } = branchState;

  const [isCreateModalOpen, setCreateModalOpen] = useState(false);
  const [createModalError, setCreateModalError] = useState(null);

  const handleRequestCreateBranch = useCallback(() => {
    if (!handleCreateBranch || isStoppingProject) {
      return;
    }
    setCreateModalError(null);
    setCreateModalOpen(true);
  }, [handleCreateBranch, isStoppingProject]);

  const handleDismissCreateModal = useCallback(() => {
    if (createBranchInFlight) {
      return;
    }
    setCreateModalOpen(false);
    setCreateModalError(null);
  }, [createBranchInFlight]);

  const handleConfirmCreateBranch = useCallback(async (payload) => {
    if (!handleCreateBranch) {
      return;
    }
    try {
      setCreateModalError(null);
      await handleCreateBranch(payload);
      setCreateModalOpen(false);
    } catch (error) {
      const message = error?.response?.data?.error || error?.message || 'Failed to create branch';
      setCreateModalError(message);
    }
  }, [handleCreateBranch]);

  const isCurrentBranch = Boolean(selectedSummary?.isCurrent);
  const isMainSelected = selectedBranchName === 'main';
  const hasSelectedWorkingBranch = Boolean(selectedWorkingBranch);
  const normalizedSelectedFiles = Array.isArray(selectedFiles) ? selectedFiles : [];
  const selectedStagedCount = normalizedSelectedFiles.length;
  const summaryStagedCount = Number(selectedSummary?.stagedFileCount || 0);
  const hasStagedChanges = selectedStagedCount > 0 || summaryStagedCount > 0;
  const canBeginMerge = hasSelectedWorkingBranch;
  const canCheckout = Boolean(selectedSummary && !isCurrentBranch);
  const canDelete = Boolean(selectedSummary && selectedSummary.name !== 'main');
  const isDeletingBranch = deleteInFlight === selectedBranchName;
  const deleteLabel = isDeletingBranch ? 'Deleting…' : 'Delete branch';
  const handleRequestDeleteBranch = useCallback(() => {
    if (!canDelete || !selectedBranchName || !handleDeleteBranch || isStoppingProject) {
      return;
    }
    void Promise.resolve(handleDeleteBranch(selectedBranchName)).catch(() => null);
  }, [canDelete, selectedBranchName, handleDeleteBranch, isStoppingProject]);
  const selectedStatus = deriveDisplayStatus(selectedSummary, selectedWorkingBranch);
  const isMergedBranch = selectedStatus === 'merged';
  const lastTestStatus = selectedWorkingBranch?.lastTestStatus || null;
  const testsFailed = lastTestStatus === 'failed';
  const testsInvalidated = Boolean(branchTestValidity[selectedBranchName]?.invalidated);
  const mergeCandidateBranch = selectedWorkingBranch
    ? { ...selectedWorkingBranch, stagedFiles: normalizedSelectedFiles }
    : null;
  const readyForMerge = canBranchMerge(mergeCandidateBranch) && !testsInvalidated;
  const invalidationWarning = (testsInvalidated && hasStagedChanges)
    ? 'Changes were made after the last passing tests. Run tests again before merging.'
    : null;
  const warningMessage = mergeWarning
    || invalidationWarning
    || (testsFailed ? selectedWorkingBranch?.mergeBlockedReason : null);
  const isBeginningTesting = testInFlight === selectedBranchName;
  const canBeginTesting = hasSelectedWorkingBranch
    && hasStagedChanges
    && !isStoppingProject
    && !isBeginningTesting;

  const syncOverviewIfAvailable = useCallback((overview) => {
    if (!overview || !project?.id) {
      return;
    }

    if (typeof syncBranchOverview === 'function') {
      syncBranchOverview(project.id, overview);
    }
  }, [project?.id, syncBranchOverview]);

  const isCssOnlyStaged = useMemo(() => {
    if (!hasSelectedFiles || !Array.isArray(selectedFiles) || selectedFiles.length === 0) {
      return false;
    }

    return selectedFiles.every((file) => {
      const filePath = typeof file?.path === 'string' ? file.path.trim().toLowerCase() : '';
      return Boolean(filePath) && filePath.endsWith('.css');
    });
  }, [hasSelectedFiles, selectedFiles]);

  const isSkippingTestsAndMerging = skipMergeInFlight === selectedBranchName;
  const canSkipTesting = Boolean(
    hasSelectedWorkingBranch
    && canBeginTesting
    && isCssOnlyStaged
    && !isSkippingTestsAndMerging
  );

  const toolbarState = {
    registerBranchActions,
    selectedBranchName,
    hasSelectedWorkingBranch,
    selectedStagedCount,
    canBeginMerge,
    readyForMerge,
    isStoppingProject,
    testInFlight,
    testMergeInFlight,
    mergeInFlight,
    handleRunTests,
    handleTestAndMerge,
    handleMergeBranch,
    handleCreateBranch: handleRequestCreateBranch,
    createBranchInFlight
  };

  useToolbarActions(toolbarState);

  const layout = useMemo(() => (
    <div className="branch-layout">
      <BranchSidebar
        branchSummaries={branchSummaries}
        branchListMode={branchListMode}
        onChangeBranchListMode={setBranchListMode}
        openBranchCount={openBranchCount}
        pastBranchCount={pastBranchCount}
        sortedBranches={sortedBranches}
        workingBranchMap={workingBranchMap}
        selectedBranchName={selectedBranchName}
        onSelectBranch={setSelectedBranch}
      />
      <BranchDetails
        warningMessage={warningMessage}
        canCheckout={canCheckout}
        onCheckout={() => handleCheckoutBranch(selectedBranchName)}
        checkoutTestId={isMergedBranch ? 'branch-revert' : 'branch-checkout'}
        checkoutLabel={isMergedBranch ? 'Revert to this branch' : 'Switch to this branch'}
        canDelete={canDelete}
        onDeleteBranch={canDelete ? handleRequestDeleteBranch : null}
        deleteLabel={deleteLabel}
        isDeleting={isDeletingBranch}
        isStoppingProject={isStoppingProject}
        selectedFiles={selectedFiles}
        hasSelectedFiles={hasSelectedFiles}
        onClearAll={() => handleClearStaged(selectedBranchName)}
        onOpenFile={handleOpenFile}
        onClearFile={(filePath) => handleClearFile(filePath, selectedBranchName)}
        isCurrentBranch={isCurrentBranch}
        showWorkingPanels={!isMainSelected}
        onBeginTesting={canBeginTesting
          ? () => {
            void Promise.resolve(handleRunTests(selectedBranchName, { navigateToCommitsOnPass: false }))
              .then((result) => syncOverviewIfAvailable(result?.overview))
              .catch(() => null);
          }
          : null}
        canBeginTesting={canBeginTesting}
        isBeginningTesting={isBeginningTesting}
        onSkipTesting={canSkipTesting ? () => onRequestCommitsTab?.() : null}
        canSkipTesting={canSkipTesting}
        showCssOnlySkipHint={isCssOnlyStaged}
      />
    </div>
  ), [
    branchSummaries,
    branchListMode,
    setBranchListMode,
    openBranchCount,
    pastBranchCount,
    sortedBranches,
    workingBranchMap,
    selectedBranchName,
    setSelectedBranch,
    warningMessage,
    canCheckout,
    handleCheckoutBranch,
    isMergedBranch,
    isStoppingProject,
    selectedFiles,
    hasSelectedFiles,
    handleClearStaged,
    handleOpenFile,
    handleClearFile,
    canBeginTesting,
    isBeginningTesting,
    handleRunTests,
    isCssOnlyStaged,
    isMainSelected,
    isCurrentBranch,
    onRequestCommitsTab
  ]);

  return (
    <div className="branch-tab" data-testid="branch-tab">
      {showShutdownBanner && (
        <div className="branch-header">
          <div
            className={`branch-shutdown-banner${shutdownError ? ' is-error' : ''}`}
            data-testid="branch-shutdown-banner"
            role="status"
            aria-live="polite"
          >
            <span className="branch-shutdown-dot" aria-hidden="true" />
            <span>
              {isStoppingProject
                ? `Stopping ${project?.name || 'project'} processes…`
                : `Stop failed: ${shutdownError}`}
            </span>
          </div>
        </div>
      )}

      {loading && <div className="loading">Loading branches...</div>}
      {error && <div className="error">{error}</div>}

      {!loading && !error && layout}

      <NewBranchModal
        isOpen={isCreateModalOpen}
        isSubmitting={createBranchInFlight}
        errorMessage={createModalError}
        onClose={handleDismissCreateModal}
        onSubmit={handleConfirmCreateBranch}
      />
    </div>
  );
};

export default BranchTabRoot;
