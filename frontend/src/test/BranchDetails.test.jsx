import React from 'react';
import { describe, test, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import BranchDetails from '../components/branch-tab/BranchDetails';

describe('BranchDetails', () => {
  test('renders committed files panel with Merge Now primary action when readyForMerge and committedFiles exist', () => {
    render(
      <BranchDetails
        warningMessage={null}
        canCheckout={false}
        onCheckout={null}
        checkoutTestId="branch-checkout"
        checkoutLabel="Switch"
        canDelete={false}
        onDeleteBranch={null}
        deleteLabel="Delete"
        isDeleting={false}
        isStoppingProject={false}
        selectedFiles={[]}
        hasSelectedFiles={false}
        onClearAll={null}
        onOpenFile={null}
        onClearFile={null}
        isCurrentBranch={false}
        showWorkingPanels={true}
        onBeginTesting={null}
        canBeginTesting={false}
        isBeginningTesting={false}
        onSkipTesting={null}
        canSkipTesting={false}
        showCssOnlySkipHint={false}
        readyForMerge={true}
        onMerge={() => {}}
        canMerge={true}
        isMerging={false}
        committedFiles={['src/App.jsx']}
        isLoadingCommittedFiles={false}
        committedFilesBranchName="feature/test"
      />
    );

    expect(screen.getByTestId('branch-committed-files-card')).toBeInTheDocument();
    expect(screen.getByTestId('branch-merge')).toHaveTextContent('Merge Now');
    expect(screen.queryByTestId('branch-merge-card')).toBeNull();
  });

  test('falls back to merge card when readyForMerge but no committedFiles are present', () => {
    render(
      <BranchDetails
        warningMessage={null}
        canCheckout={false}
        onCheckout={null}
        checkoutTestId="branch-checkout"
        checkoutLabel="Switch"
        canDelete={false}
        onDeleteBranch={null}
        deleteLabel="Delete"
        isDeleting={false}
        isStoppingProject={false}
        selectedFiles={[]}
        hasSelectedFiles={false}
        onClearAll={null}
        onOpenFile={null}
        onClearFile={null}
        isCurrentBranch={false}
        showWorkingPanels={true}
        onBeginTesting={null}
        canBeginTesting={false}
        isBeginningTesting={false}
        onSkipTesting={null}
        canSkipTesting={false}
        showCssOnlySkipHint={false}
        readyForMerge={true}
        onMerge={() => {}}
        canMerge={true}
        isMerging={false}
        committedFiles={[]}
        isLoadingCommittedFiles={false}
        committedFilesBranchName="feature/empty"
      />
    );

    expect(screen.getByTestId('branch-merge-card')).toBeInTheDocument();
    expect(screen.getByTestId('branch-merge')).toHaveTextContent('Merge into main');

    // BranchDetails always renders the committed-files card when readyForMerge && !hasSelectedFiles;
    // the primary action is omitted when there are no committed files.
    const committedCard = screen.getByTestId('branch-committed-files-card');
    expect(within(committedCard).queryByTestId('branch-merge')).toBeNull();
  });

  test('shows Merging… label in committed files primary action when merge is in flight', () => {
    render(
      <BranchDetails
        warningMessage={null}
        canCheckout={false}
        onCheckout={null}
        checkoutTestId="branch-checkout"
        checkoutLabel="Switch"
        canDelete={false}
        onDeleteBranch={null}
        deleteLabel="Delete"
        isDeleting={false}
        isStoppingProject={false}
        selectedFiles={[]}
        hasSelectedFiles={false}
        onClearAll={null}
        onOpenFile={null}
        onClearFile={null}
        isCurrentBranch={false}
        showWorkingPanels={true}
        onBeginTesting={null}
        canBeginTesting={false}
        isBeginningTesting={false}
        onSkipTesting={null}
        canSkipTesting={false}
        showCssOnlySkipHint={false}
        readyForMerge={true}
        onMerge={() => {}}
        canMerge={true}
        isMerging={true}
        committedFiles={['src/App.jsx']}
        isLoadingCommittedFiles={false}
        committedFilesBranchName="feature/merging"
      />
    );

    expect(screen.getByTestId('branch-committed-files-card')).toBeInTheDocument();
    expect(screen.getByTestId('branch-merge')).toHaveTextContent('Merging…');
    expect(screen.queryByTestId('branch-merge-card')).toBeNull();
  });

  test('shows Merging… label in merge card when merge is in flight', () => {
    render(
      <BranchDetails
        warningMessage={null}
        canCheckout={false}
        onCheckout={null}
        checkoutTestId="branch-checkout"
        checkoutLabel="Switch"
        canDelete={false}
        onDeleteBranch={null}
        deleteLabel="Delete"
        isDeleting={false}
        isStoppingProject={false}
        selectedFiles={[{ path: 'src/App.jsx' }]}
        hasSelectedFiles={true}
        onClearAll={null}
        onOpenFile={null}
        onClearFile={null}
        isCurrentBranch={false}
        showWorkingPanels={true}
        onBeginTesting={null}
        canBeginTesting={false}
        isBeginningTesting={false}
        onSkipTesting={null}
        canSkipTesting={false}
        showCssOnlySkipHint={false}
        readyForMerge={true}
        onMerge={() => {}}
        canMerge={true}
        isMerging={true}
        committedFiles={['src/App.jsx']}
        isLoadingCommittedFiles={false}
        committedFilesBranchName="feature/merging"
      />
    );

    expect(screen.getByTestId('branch-merge-card')).toBeInTheDocument();
    expect(screen.getByTestId('branch-merge')).toHaveTextContent('Merging…');
  });
});
