import React from 'react';
import { describe, test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import CommitDetailsPanel from '../components/commitsTab/CommitDetailsPanel';

describe('CommitDetailsPanel', () => {
  test('does not show merge blocked banner when gateStatus.merge already includes the message', () => {
    render(
      <CommitDetailsPanel
        projectId="proj-1"
        statusMessage={null}
        gateStatus={{ tests: 'passed', coverage: 'passed', merge: 'Merge blocked: coverage' }}
        mergeActionError={null}
        mergeBlockedBannerMessage="coverage"
        branchReadyToMerge={false}
        shouldShowCommitComposer={false}
        activeBranchName="feature/x"
        stagedFiles={[]}
        isCssOnlyStaged={false}
        mergeIsCssOnly={false}
        handleMergeBranch={() => {}}
        mergeInFlight={false}
        commitInFlight={false}
        shouldShowTestingCta={false}
        testsStatus={null}
        onStartTesting={null}
        hideCommitDetails={false}
        hasStagedFiles={true}
        commitSubject=""
        commitBody=""
        onSubjectChange={() => {}}
        onBodyChange={() => {}}
        onCommit={() => {}}
        onAutofill={() => {}}
        canAutofill={false}
        canCommit={false}
        commitHint={null}
        isGeneratingCommit={false}
        commitMessageError={null}
        selectedCommit={null}
        isDetailLoading={false}
        selectedDetails={null}
        canRevertSelectedCommit={false}
        revertingSha={null}
        requestRevertCommit={() => {}}
        handleOpenFileFromCommit={() => {}}
        canOpenFiles={false}
        branchReadyToCommit={false}
      />
    );

    expect(screen.getByTestId('commit-details-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('commit-merge-blocked')).toBeNull();
  });

  test('shows merge blocked banner when gate status does not already include message', () => {
    render(
      <CommitDetailsPanel
        projectId="proj-1"
        statusMessage={null}
        gateStatus={{ tests: 'passed', coverage: 'passed', merge: 'blocked by tests' }}
        mergeActionError={null}
        mergeBlockedBannerMessage="coverage"
        branchReadyToMerge={false}
        shouldShowCommitComposer={false}
        activeBranchName="feature/x"
        stagedFiles={[]}
        isCssOnlyStaged={false}
        mergeIsCssOnly={false}
        handleMergeBranch={() => {}}
        mergeInFlight={false}
        commitInFlight={false}
        shouldShowTestingCta={false}
        testsStatus={null}
        onStartTesting={null}
        hideCommitDetails={false}
        hasStagedFiles={true}
        commitSubject=""
        commitBody=""
        onSubjectChange={() => {}}
        onBodyChange={() => {}}
        onCommit={() => {}}
        onAutofill={() => {}}
        canAutofill={false}
        canCommit={false}
        commitHint={null}
        isGeneratingCommit={false}
        commitMessageError={null}
        selectedCommit={null}
        isDetailLoading={false}
        selectedDetails={null}
        canRevertSelectedCommit={false}
        revertingSha={null}
        requestRevertCommit={() => {}}
        handleOpenFileFromCommit={() => {}}
        canOpenFiles={false}
        branchReadyToCommit={false}
      />
    );

    expect(screen.getByTestId('commit-merge-blocked')).toHaveTextContent('Merge blocked: coverage');
  });

  test('shows pending testing copy when testsStatus is pending', () => {
    render(
      <CommitDetailsPanel
        projectId="proj-1"
        statusMessage={null}
        gateStatus={null}
        mergeActionError={null}
        mergeBlockedBannerMessage={null}
        branchReadyToMerge={false}
        shouldShowCommitComposer={false}
        activeBranchName="feature/x"
        stagedFiles={[]}
        isCssOnlyStaged={false}
        mergeIsCssOnly={false}
        handleMergeBranch={() => {}}
        mergeInFlight={false}
        commitInFlight={false}
        shouldShowTestingCta={true}
        testsStatus="pending"
        onStartTesting={() => {}}
        hideCommitDetails={false}
        hasStagedFiles={false}
        commitSubject=""
        commitBody=""
        onSubjectChange={() => {}}
        onBodyChange={() => {}}
        onCommit={() => {}}
        onAutofill={() => {}}
        canAutofill={false}
        canCommit={false}
        commitHint={null}
        isGeneratingCommit={false}
        commitMessageError={null}
        selectedCommit={null}
        isDetailLoading={false}
        selectedDetails={null}
        canRevertSelectedCommit={false}
        revertingSha={null}
        requestRevertCommit={() => {}}
        handleOpenFileFromCommit={() => {}}
        canOpenFiles={false}
        branchReadyToCommit={false}
      />
    );

    expect(screen.getByTestId('commit-tests-required')).toHaveTextContent(
      'Automated testing is currently running. Please wait…'
    );
  });
});
