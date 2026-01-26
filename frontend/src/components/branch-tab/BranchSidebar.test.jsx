import React from 'react';
import { describe, test, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BranchSidebar from './BranchSidebar';

const renderSidebar = (props = {}) => {
  const defaultProps = {
    branchSummaries: [],
    branchListMode: 'open',
    onChangeBranchListMode: vi.fn(),
    openBranchCount: 0,
    pastBranchCount: 0,
    sortedBranches: [],
    workingBranchMap: new Map(),
    selectedBranchName: null,
    onSelectBranch: vi.fn()
  };
  return render(<BranchSidebar {...defaultProps} {...props} />);
};

describe('BranchSidebar', () => {
  test('shows header and empty state when no branches exist', () => {
    renderSidebar();

    expect(screen.getByText('Branches')).toBeInTheDocument();
    expect(screen.getByText('0 total')).toBeInTheDocument();
    expect(screen.getByTestId('branch-filter-bar')).toBeInTheDocument();
    expect(screen.getByTestId('branch-filter-open')).toBeInTheDocument();
    expect(screen.getByTestId('branch-filter-past')).toBeInTheDocument();
    expect(screen.getByTestId('branch-empty')).toHaveTextContent('No branches yet');
  });

  test('clicking Open filter calls onChangeBranchListMode', async () => {
    const onChangeBranchListMode = vi.fn();
    const user = userEvent.setup();

    renderSidebar({ branchListMode: 'past', onChangeBranchListMode });

    await user.click(screen.getByTestId('branch-filter-open'));
    expect(onChangeBranchListMode).toHaveBeenCalledWith('open');
  });

  test('clicking Past filter calls onChangeBranchListMode', async () => {
    const onChangeBranchListMode = vi.fn();
    const user = userEvent.setup();

    renderSidebar({ branchListMode: 'open', onChangeBranchListMode });

    await user.click(screen.getByTestId('branch-filter-past'));
    expect(onChangeBranchListMode).toHaveBeenCalledWith('past');
  });

  test('clicking filters is safe when handler missing', async () => {
    const user = userEvent.setup();

    renderSidebar({ onChangeBranchListMode: undefined });

    await user.click(screen.getByTestId('branch-filter-open'));
    await user.click(screen.getByTestId('branch-filter-past'));
  });

  test('defaults Open/Past branch counts to 0 when missing', () => {
    renderSidebar({ openBranchCount: undefined, pastBranchCount: undefined });

    expect(screen.getByLabelText('Open branches count')).toHaveTextContent('0');
    expect(screen.getByLabelText('Past branches count')).toHaveTextContent('0');
  });

  test('shows past empty state when no past branches exist', () => {
    renderSidebar({ branchListMode: 'past' });

    expect(screen.getByTestId('branch-empty')).toHaveTextContent('No past branches yet');
  });

  test('renders branch rows, chips, and trigger selection', async () => {
    const branches = [
      { name: 'feature/login', stagedFileCount: 1, status: 'active', isCurrent: true },
      { name: 'release/v1', stagedFileCount: 2, status: 'merged', isCurrent: false }
    ];
    const branchSummaries = branches.map((branch) => ({ name: branch.name }));
    const workingBranchMap = new Map([
      [branches[0].name, { lastTestStatus: 'failed', stagedFiles: [] }]
    ]);
    const onSelectBranch = vi.fn();
    const user = userEvent.setup();

    renderSidebar({
      branchSummaries,
      branchListMode: 'open',
      openBranchCount: 1,
      pastBranchCount: 1,
      sortedBranches: branches,
      workingBranchMap,
      selectedBranchName: branches[0].name,
      onSelectBranch
    });

    const firstRow = screen.getByTestId('branch-list-item-feature-login');
    const secondRow = screen.getByTestId('branch-list-item-release-v1');

    expect(firstRow).toHaveClass('selected');
    expect(screen.getByText('Current')).toBeInTheDocument();
    expect(within(secondRow).getAllByText('Merged')).toHaveLength(2);
    expect(screen.getByText('Needs Fix')).toBeInTheDocument();
    expect(screen.getByText('1 staged file')).toBeInTheDocument();
    expect(screen.getByText('2 staged files')).toBeInTheDocument();

    await user.click(secondRow);
    expect(onSelectBranch).toHaveBeenCalledWith('release/v1');
  });

  test('prefers working branch stagedFiles length over stagedFileCount when available', () => {
    const branches = [
      { name: 'feature/autosave-123', stagedFileCount: 0, status: 'active', isCurrent: true }
    ];
    const branchSummaries = branches.map((branch) => ({ name: branch.name }));
    const workingBranchMap = new Map([
      [branches[0].name, { lastTestStatus: null, stagedFiles: [{ path: 'src/App.jsx' }] }]
    ]);

    renderSidebar({
      branchSummaries,
      branchListMode: 'open',
      openBranchCount: 1,
      pastBranchCount: 0,
      sortedBranches: branches,
      workingBranchMap,
      selectedBranchName: branches[0].name
    });

    expect(screen.getByText('1 staged file')).toBeInTheDocument();
  });

  test('defaults staged file count to 0 when missing', () => {
    const branches = [{ name: 'feature/missing-count', status: 'active', isCurrent: true }];
    const branchSummaries = branches.map((branch) => ({ name: branch.name }));

    renderSidebar({
      branchSummaries,
      branchListMode: 'open',
      openBranchCount: 1,
      pastBranchCount: 0,
      sortedBranches: branches,
      selectedBranchName: branches[0].name
    });

    expect(screen.getByText('0 staged files')).toBeInTheDocument();
  });

  test('hides staged file counter for main branch', () => {
    const branches = [
      { name: 'main', stagedFileCount: 0, status: 'protected', isCurrent: true },
      { name: 'feature/login', stagedFileCount: 2, status: 'active', isCurrent: false }
    ];
    const branchSummaries = branches.map((branch) => ({ name: branch.name }));

    renderSidebar({
      branchSummaries,
      branchListMode: 'open',
      openBranchCount: 2,
      pastBranchCount: 0,
      sortedBranches: branches,
      selectedBranchName: 'main'
    });

    expect(within(screen.getByTestId('branch-list-item-main')).queryByText(/staged file/i)).toBeNull();
    expect(screen.getByText('2 staged files')).toBeInTheDocument();
  });
});
