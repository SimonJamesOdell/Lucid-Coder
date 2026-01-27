import React from 'react';
import { describe, test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CommittedFilesCard from '../components/branch-tab/CommittedFilesCard';

describe('CommittedFilesCard', () => {
  test('renders loading state and branch name', () => {
    render(
      <CommittedFilesCard
        files={['src/App.jsx']}
        onOpenFile={vi.fn()}
        isLoading={true}
        branchName="feature/loading"
        primaryActionLabel={null}
        primaryActionTestId="primary"
        onPrimaryAction={null}
        isPrimaryActionDisabled={false}
      />
    );

    expect(screen.getByTestId('branch-committed-files-card')).toBeInTheDocument();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.getByTestId('branch-committed-files-loading')).toBeInTheDocument();
    expect(screen.getByTestId('branch-committed-files-branch')).toHaveTextContent('feature/loading');
  });

  test('renders file list, safe test ids, and calls onOpenFile', async () => {
    const onOpenFile = vi.fn();
    const user = userEvent.setup();

    render(
      <CommittedFilesCard
        files={['src/App.jsx', 'README.md']}
        onOpenFile={onOpenFile}
        isLoading={false}
        branchName={null}
        primaryActionLabel="Merge Now"
        primaryActionTestId="merge-action"
        onPrimaryAction={() => {}}
        isPrimaryActionDisabled={false}
      />
    );

    expect(screen.getByTestId('branch-committed-file-list')).toBeInTheDocument();
    expect(screen.getByText('2 files')).toBeInTheDocument();

    await user.click(screen.getByTestId('branch-committed-file-src-app-jsx'));
    expect(onOpenFile).toHaveBeenCalledWith('src/App.jsx');

    expect(screen.getByTestId('merge-action')).toBeEnabled();
  });

  test('renders empty state when no files are present', () => {
    render(
      <CommittedFilesCard
        files={null}
        onOpenFile={null}
        isLoading={false}
        branchName={null}
        primaryActionLabel={null}
        primaryActionTestId="primary"
        onPrimaryAction={null}
        isPrimaryActionDisabled={false}
      />
    );

    expect(screen.getByTestId('branch-committed-no-files')).toBeInTheDocument();
    expect(screen.getByText('No committed changes')).toBeInTheDocument();
  });
});
