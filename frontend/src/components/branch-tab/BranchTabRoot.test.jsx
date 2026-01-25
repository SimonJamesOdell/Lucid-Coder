import React from 'react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const syncBranchOverviewSpy = vi.fn();

vi.mock('../../context/AppStateContext', () => ({
  __esModule: true,
  useAppState: () => ({
    syncBranchOverview: syncBranchOverviewSpy
  })
}));

vi.mock('./useBranchTabState', () => ({
  __esModule: true,
  default: vi.fn()
}));

vi.mock('./useToolbarActions', () => ({
  __esModule: true,
  default: vi.fn()
}));

const branchDetailsSpy = vi.fn();
vi.mock('./BranchDetails', () => ({
  __esModule: true,
  default: (props) => {
    branchDetailsSpy(props);
    return (
      <div data-testid="branch-details" data-warning={props.warningMessage || ''}>
        <button
          type="button"
          data-testid="mock-delete-branch"
          onClick={() => props.onDeleteBranch?.()}
        >
          Delete
        </button>
        BranchDetails
      </div>
    );
  }
}));

vi.mock('./BranchSidebar', () => ({
  __esModule: true,
  default: (props) => (
    <div data-testid="branch-sidebar" data-selected={props.selectedBranchName}>
      BranchSidebar
    </div>
  )
}));

vi.mock('./NewBranchModal', () => ({
  __esModule: true,
  default: (props) => {
    return (
      <div
        data-testid="new-branch-modal"
        data-open={props.isOpen ? 'true' : 'false'}
        data-error={props.errorMessage || ''}
      >
        <button type="button" data-testid="modal-close" onClick={() => props.onClose?.()}>
          Close
        </button>
        <button
          type="button"
          data-testid="modal-submit"
          onClick={() => props.onSubmit?.({ name: 'branch-name' })}
        >
          Submit
        </button>
      </div>
    );
  }
}));

import BranchTabRoot from './BranchTabRoot';
import useBranchTabState from './useBranchTabState';
import useToolbarActions from './useToolbarActions';

const buildBranchState = (overrides = {}) => ({
  loading: false,
  error: null,
  showShutdownBanner: false,
  shutdownError: null,
  isStoppingProject: false,
  branchSummaries: [{ name: 'feature/login' }],
  sortedBranches: [
    { name: 'feature/login', stagedFileCount: 0, status: 'active', isCurrent: false }
  ],
  selectedBranchName: 'feature/login',
  setSelectedBranch: vi.fn(),
  selectedSummary: { name: 'feature/login', status: 'active', isCurrent: false },
  selectedWorkingBranch: {
    name: 'feature/login',
    status: 'ready-for-merge',
    lastTestStatus: 'passed',
    mergeBlockedReason: 'Fix tests',
    stagedFiles: []
  },
  workingBranchMap: new Map(),
  selectedFiles: [],
  hasSelectedFiles: false,
  mergeWarning: null,
  branchTestValidity: {},
  testInFlight: null,
  mergeInFlight: null,
  testMergeInFlight: null,
  skipMergeInFlight: null,
  deleteInFlight: null,
  handleRunTests: vi.fn(),
  handleMergeBranch: vi.fn(),
  handleTestAndMerge: vi.fn(),
  handleDeleteBranch: vi.fn(),
  handleCheckoutBranch: vi.fn(),
  handleClearStaged: vi.fn(),
  handleClearFile: vi.fn(),
  handleOpenFile: vi.fn(),
  handleCreateBranch: vi.fn().mockResolvedValue({}),
  selectedBranchRef: { current: null },
  createBranchInFlight: false,
  ...overrides
});

let latestToolbarState;

describe('BranchTabRoot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncBranchOverviewSpy.mockReset();
    latestToolbarState = undefined;
    useBranchTabState.mockReturnValue(buildBranchState());
    useToolbarActions.mockImplementation((state) => {
      latestToolbarState = state;
    });
  });

  const renderComponent = (props = {}) => (
    render(<BranchTabRoot project={{ id: 'p1', name: 'Demo Project' }} {...props} />)
  );

  test('passes merge readiness info into toolbar actions', () => {
    renderComponent();
    expect(latestToolbarState.readyForMerge).toBe(true);
    expect(latestToolbarState.selectedStagedCount).toBe(0);
    expect(latestToolbarState.canBeginMerge).toBe(true);
  });

  test('delete branch handler swallows failures from delete callback', async () => {
    const handleDeleteBranch = vi.fn().mockRejectedValue(new Error('nope'));
    useBranchTabState.mockReturnValue(buildBranchState({ handleDeleteBranch }));

    const user = userEvent.setup();
    renderComponent();

    await act(async () => {
      await user.click(screen.getByTestId('mock-delete-branch'));
      await Promise.resolve();
    });

    expect(handleDeleteBranch).toHaveBeenCalledWith('feature/login');
  });

  test('delete branch handler no-ops while project is stopping', async () => {
    const handleDeleteBranch = vi.fn();
    useBranchTabState.mockReturnValue(buildBranchState({
      isStoppingProject: true,
      handleDeleteBranch
    }));

    const user = userEvent.setup();
    renderComponent();

    await act(async () => {
      await user.click(screen.getByTestId('mock-delete-branch'));
      await Promise.resolve();
    });

    expect(handleDeleteBranch).not.toHaveBeenCalled();
  });

  test('prefers invalidation warning over merge blocker text', () => {
    useBranchTabState.mockReturnValue(buildBranchState({
      branchTestValidity: { 'feature/login': { invalidated: true } },
      selectedFiles: [{ path: 'README.md', timestamp: 'now' }],
      hasSelectedFiles: true,
      selectedWorkingBranch: {
        name: 'feature/login',
        status: 'active',
        lastTestStatus: 'failed',
        mergeBlockedReason: 'Should not show',
        stagedFiles: []
      }
    }));

    renderComponent();
    const lastCall = branchDetailsSpy.mock.calls.at(-1)[0];
    expect(lastCall.warningMessage).toContain('Changes were made');
  });

  test('falls back to merge blocked reason when tests fail', () => {
    useBranchTabState.mockReturnValue(buildBranchState({
      branchTestValidity: {},
      selectedWorkingBranch: {
        name: 'feature/login',
        status: 'active',
        lastTestStatus: 'failed',
        mergeBlockedReason: 'Resolve failing tests before merging',
        stagedFiles: []
      }
    }));

    renderComponent();
    const lastCall = branchDetailsSpy.mock.calls.at(-1)[0];
    expect(lastCall.warningMessage).toBe('Resolve failing tests before merging');
  });

  test('suppresses invalidation warning when no staged files remain', () => {
    useBranchTabState.mockReturnValue(buildBranchState({
      branchTestValidity: { 'feature/login': { invalidated: true } },
      selectedFiles: [],
      hasSelectedFiles: false,
      selectedWorkingBranch: {
        name: 'feature/login',
        status: 'active',
        lastTestStatus: 'passed',
        stagedFiles: []
      }
    }));

    renderComponent();
    const lastCall = branchDetailsSpy.mock.calls.at(-1)[0];
    expect(lastCall.warningMessage).toBeNull();
  });

  test('wires BranchDetails callbacks to branch handlers', async () => {
    const handleCheckoutBranch = vi.fn();
    const handleClearStaged = vi.fn();
    const handleClearFile = vi.fn();
    const handleOpenFile = vi.fn();
    const overview = { branches: [], current: 'main', workingBranches: [] };
    const handleRunTests = vi.fn().mockResolvedValue({ overview });

    const onRequestCommitsTab = vi.fn();

    useBranchTabState.mockReturnValue(buildBranchState({
      selectedFiles: [{ path: 'README.md' }],
      hasSelectedFiles: true,
      handleCheckoutBranch,
      handleClearStaged,
      handleClearFile,
      handleOpenFile,
      handleRunTests,
      selectedWorkingBranch: {
        name: 'feature/login',
        status: 'active',
        lastTestStatus: null,
        mergeBlockedReason: 'Fix tests',
        stagedFiles: []
      }
    }));

    renderComponent({ onRequestCommitsTab });

    const detailsProps = branchDetailsSpy.mock.calls.at(-1)[0];

    await act(async () => {
      detailsProps.onCheckout();
      detailsProps.onClearAll();
      detailsProps.onClearFile('README.md');
      detailsProps.onOpenFile('README.md');
      detailsProps.onBeginTesting();
    });

    expect(handleCheckoutBranch).toHaveBeenCalledWith('feature/login');
    expect(handleClearStaged).toHaveBeenCalledWith('feature/login');
    expect(handleClearFile).toHaveBeenCalledWith('README.md', 'feature/login');
    expect(handleRunTests).toHaveBeenCalledWith('feature/login', { navigateToCommitsOnPass: false });

    await waitFor(() => {
      expect(syncBranchOverviewSpy).toHaveBeenCalledWith('p1', overview);
    });
  });

  test('wires skip testing callback when staged files are CSS only', async () => {
    const onRequestCommitsTab = vi.fn();

    useBranchTabState.mockReturnValue(buildBranchState({
      selectedFiles: [{ path: 'src/App.css' }],
      hasSelectedFiles: true,
      skipMergeInFlight: null,
      selectedWorkingBranch: {
        name: 'feature/login',
        status: 'active',
        lastTestStatus: null,
        mergeBlockedReason: 'Fix tests',
        stagedFiles: []
      }
    }));

    renderComponent({ onRequestCommitsTab });
    const detailsProps = branchDetailsSpy.mock.calls.at(-1)[0];

    expect(detailsProps.canSkipTesting).toBe(true);
    expect(typeof detailsProps.onSkipTesting).toBe('function');

    await act(async () => {
      detailsProps.onSkipTesting();
    });

    expect(onRequestCommitsTab).toHaveBeenCalled();
  });

  test('skip testing stays disabled when staged selection is empty', () => {
    useBranchTabState.mockReturnValue(buildBranchState({
      hasSelectedFiles: true,
      selectedFiles: []
    }));

    renderComponent({ onRequestCommitsTab: vi.fn() });
    const detailsProps = branchDetailsSpy.mock.calls.at(-1)[0];

    expect(detailsProps.showCssOnlySkipHint).toBe(false);
    expect(detailsProps.canSkipTesting).toBe(false);
    expect(detailsProps.onSkipTesting).toBeNull();
  });

  test('skip testing stays disabled when selected files payload is not an array', () => {
    useBranchTabState.mockReturnValue(buildBranchState({
      hasSelectedFiles: true,
      selectedFiles: null
    }));

    renderComponent({ onRequestCommitsTab: vi.fn() });
    const detailsProps = branchDetailsSpy.mock.calls.at(-1)[0];

    expect(detailsProps.showCssOnlySkipHint).toBe(false);
    expect(detailsProps.canSkipTesting).toBe(false);
    expect(detailsProps.onSkipTesting).toBeNull();
  });

  test('skip testing stays disabled when staged files have no string path', () => {
    useBranchTabState.mockReturnValue(buildBranchState({
      hasSelectedFiles: true,
      selectedFiles: [{ path: null }]
    }));

    renderComponent({ onRequestCommitsTab: vi.fn() });
    const detailsProps = branchDetailsSpy.mock.calls.at(-1)[0];

    expect(detailsProps.showCssOnlySkipHint).toBe(false);
    expect(detailsProps.canSkipTesting).toBe(false);
    expect(detailsProps.onSkipTesting).toBeNull();
  });

  test('opens and completes create branch flow via toolbar action', async () => {
    const user = userEvent.setup();
    const handleCreateBranch = vi.fn().mockResolvedValue({ id: 'new' });
    useBranchTabState.mockReturnValue(buildBranchState({ handleCreateBranch }));

    renderComponent();
    await act(async () => latestToolbarState.handleCreateBranch());

    const modal = screen.getByTestId('new-branch-modal');
    expect(modal).toHaveAttribute('data-open', 'true');

    await user.click(screen.getByTestId('modal-submit'));
    await waitFor(() => {
      expect(handleCreateBranch).toHaveBeenCalledWith({ name: 'branch-name' });
      expect(screen.getByTestId('new-branch-modal')).toHaveAttribute('data-open', 'false');
    });
  });

  test('does not open create branch modal when project is stopping', async () => {
    useBranchTabState.mockReturnValue(buildBranchState({ isStoppingProject: true }));
    renderComponent();

    await act(async () => latestToolbarState.handleCreateBranch());
    expect(screen.getByTestId('new-branch-modal')).toHaveAttribute('data-open', 'false');
  });

  test('handle dismiss respects createBranchInFlight guard', async () => {
    useBranchTabState.mockReturnValue(buildBranchState({ createBranchInFlight: true }));
    const user = userEvent.setup();
    renderComponent();

    await act(async () => latestToolbarState.handleCreateBranch());
    expect(screen.getByTestId('new-branch-modal')).toHaveAttribute('data-open', 'true');

    await user.click(screen.getByTestId('modal-close'));
    expect(screen.getByTestId('new-branch-modal')).toHaveAttribute('data-open', 'true');
  });

  test('handle dismiss closes modal when submission is idle', async () => {
    const user = userEvent.setup();
    renderComponent();

    await act(async () => latestToolbarState.handleCreateBranch());
    expect(screen.getByTestId('new-branch-modal')).toHaveAttribute('data-open', 'true');

    await user.click(screen.getByTestId('modal-close'));
    await waitFor(() => {
      expect(screen.getByTestId('new-branch-modal')).toHaveAttribute('data-open', 'false');
    });
  });

  test('surfacing API errors from create branch flow', async () => {
    const user = userEvent.setup();
    const handleCreateBranch = vi.fn().mockRejectedValue({
      response: { data: { error: 'limit reached' } }
    });
    useBranchTabState.mockReturnValue(buildBranchState({ handleCreateBranch }));

    renderComponent();
    await act(async () => latestToolbarState.handleCreateBranch());

    await user.click(screen.getByTestId('modal-submit'));
    await waitFor(() => {
      expect(handleCreateBranch).toHaveBeenCalled();
      expect(screen.getByTestId('new-branch-modal')).toHaveAttribute('data-error', 'limit reached');
      expect(screen.getByTestId('new-branch-modal')).toHaveAttribute('data-open', 'true');
    });
  });

  test('ignores create confirmations when handler becomes unavailable', async () => {
    const user = userEvent.setup();
    const handleCreateBranch = vi.fn().mockResolvedValue({});
    useBranchTabState.mockReturnValue(buildBranchState({ handleCreateBranch }));

    const view = renderComponent();
    await act(async () => latestToolbarState.handleCreateBranch());
    expect(screen.getByTestId('new-branch-modal')).toHaveAttribute('data-open', 'true');

    useBranchTabState.mockReturnValue(buildBranchState({ handleCreateBranch: null }));
    view.rerender(<BranchTabRoot project={{ id: 'p1', name: 'Demo Project' }} />);

    await user.click(screen.getByTestId('modal-submit'));
    expect(handleCreateBranch).not.toHaveBeenCalledWith({ name: 'branch-name' });
    expect(screen.getByTestId('new-branch-modal')).toHaveAttribute('data-open', 'true');
    expect(screen.getByTestId('new-branch-modal')).toHaveAttribute('data-error', '');
  });

  test('renders both loading and error messages when provided', () => {
    useBranchTabState.mockReturnValue(buildBranchState({ loading: true, error: 'Failed to load' }));
    renderComponent();
    expect(screen.getByText('Loading branches...')).toBeInTheDocument();
    expect(screen.getByText('Failed to load')).toBeInTheDocument();
  });

  test('renders shutdown banner variations', () => {
    useBranchTabState.mockReturnValue(buildBranchState({
      showShutdownBanner: true,
      isStoppingProject: true,
      shutdownError: null
    }));
    const view = renderComponent();
    expect(screen.getByText('Stopping Demo Project processes…')).toBeInTheDocument();

    useBranchTabState.mockReturnValue(buildBranchState({
      showShutdownBanner: true,
      isStoppingProject: false,
      shutdownError: 'boom'
    }));
    view.rerender(<BranchTabRoot project={{ id: 'p1', name: 'Demo Project' }} />);
    const banner = screen.getByTestId('branch-shutdown-banner');
    expect(banner).toHaveClass('is-error');
    expect(banner).toHaveTextContent('Stop failed: boom');
  });

});
