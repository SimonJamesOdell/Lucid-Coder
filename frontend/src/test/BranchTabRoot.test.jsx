import React from 'react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, act, screen, waitFor } from '@testing-library/react';
import BranchTabRoot from '../components/branch-tab/BranchTabRoot';
import axios from 'axios';

const mockUseBranchTabState = vi.fn();
const mockUseCommitComposer = vi.fn();
const mockUseToolbarActions = vi.fn();
const mockDeriveDisplayStatus = vi.fn(() => 'active');
const mockCanBranchMerge = vi.fn(() => true);

const branchSidebarMock = vi.fn();
const branchDetailsMock = vi.fn();
const newBranchModalMock = vi.fn();
const syncBranchOverviewSpy = vi.fn();

vi.mock('../context/AppStateContext', () => ({
  useAppState: () => ({
    syncBranchOverview: syncBranchOverviewSpy
  })
}));

vi.mock('../components/branch-tab/useBranchTabState', () => ({
  __esModule: true,
  default: (...args) => mockUseBranchTabState(...args)
}));

vi.mock('../components/branch-tab/useCommitComposer', () => ({
  useCommitComposer: (...args) => mockUseCommitComposer(...args)
}));

vi.mock('../components/branch-tab/useToolbarActions', () => ({
  __esModule: true,
  default: (...args) => mockUseToolbarActions(...args)
}));

vi.mock('../components/branch-tab/utils', () => ({
  canBranchMerge: (...args) => mockCanBranchMerge(...args),
  deriveDisplayStatus: (...args) => mockDeriveDisplayStatus(...args)
}));

vi.mock('../components/branch-tab/BranchSidebar', () => ({
  __esModule: true,
  default: (props) => {
    branchSidebarMock(props);
    return <div data-testid="mock-branch-sidebar" />;
  }
}));

vi.mock('../components/branch-tab/BranchDetails', () => ({
  __esModule: true,
  default: (props) => {
    branchDetailsMock(props);
    return <div data-testid="mock-branch-details" />;
  }
}));

vi.mock('../components/branch-tab/NewBranchModal', () => ({
  __esModule: true,
  default: (props) => {
    newBranchModalMock(props);
    return <div data-testid="mock-branch-modal" />;
  }
}));

const buildCommitComposer = (overrides = {}) => ({
  commitMessageRequest: null,
  commitMessageError: null,
  isLLMConfigured: false,
  getCommitMessageForBranch: vi.fn(() => ({ subject: '', body: '' })),
  getCommitSubjectForBranch: vi.fn(() => ''),
  getCommitBodyForBranch: vi.fn(() => ''),
  handleCommitMessageChange: vi.fn(),
  handleCommitMessageAutofill: vi.fn(),
  clearCommitMessageForBranch: vi.fn(),
  ...overrides
});

const buildBranchState = (overrides = {}) => ({
  loading: false,
  error: null,
  showShutdownBanner: false,
  shutdownError: null,
  isStoppingProject: false,
  branchSummaries: [],
  sortedBranches: [],
  selectedBranchName: 'feature-login',
  setSelectedBranch: vi.fn(),
  selectedSummary: { name: 'feature-login', isCurrent: false },
  selectedWorkingBranch: { name: 'feature-login', stagedFiles: [] },
  workingBranchMap: {},
  selectedFiles: [{ path: 'README.md' }],
  hasSelectedFiles: true,
  mergeWarning: null,
  branchTestValidity: {},
  testInFlight: null,
  mergeInFlight: null,
  testMergeInFlight: null,
  skipMergeInFlight: null,
  deleteInFlight: null,
  commitInFlight: null,
  handleRunTests: vi.fn(),
  handleMergeBranch: vi.fn(),
  handleTestAndMerge: vi.fn(),
  handleDeleteBranch: vi.fn(),
  handleCheckoutBranch: vi.fn(),
  handleClearStaged: vi.fn(),
  handleClearFile: vi.fn(),
  handleOpenFile: vi.fn(),
  handleCommitBranch: vi.fn(),
  handleCreateBranch: vi.fn(),
  selectedBranchRef: { current: null },
  createBranchInFlight: false,
  createBranchError: null,
  branchSummariesLoaded: true,
  ...overrides
});

const setupMocks = ({ branchOverrides = {}, composerOverrides = {} } = {}) => {
  mockUseBranchTabState.mockReturnValue(buildBranchState(branchOverrides));
  mockUseCommitComposer.mockReturnValue(buildCommitComposer(composerOverrides));
};

beforeEach(() => {
  vi.clearAllMocks();
  mockDeriveDisplayStatus.mockReturnValue('active');
  mockCanBranchMerge.mockReturnValue(true);
  axios.get.mockResolvedValue({ data: { files: [] } });
  setupMocks();
});

describe('BranchTabRoot targeted behavior', () => {
  test('runs committed files effect on mount', async () => {
    axios.get.mockResolvedValueOnce({ data: { files: [] } });

    setupMocks({
      branchOverrides: {
        selectedBranchName: 'feature/effect-mount',
        selectedSummary: { name: 'feature/effect-mount', isCurrent: false, stagedFileCount: 1 },
        selectedWorkingBranch: { name: 'feature/effect-mount', stagedFiles: [] },
        selectedFiles: [],
        hasSelectedFiles: false
      }
    });

    render(<BranchTabRoot project={{ id: 'proj-1', name: 'Demo' }} />);

    await waitFor(() => {
      expect(axios.get).toHaveBeenCalled();
    });
  });

  test('committed files effect falls back when selectedBranchName is falsy', async () => {
    setupMocks({
      branchOverrides: {
        selectedBranchName: '',
        selectedSummary: null,
        selectedWorkingBranch: null,
        selectedFiles: [],
        hasSelectedFiles: false
      }
    });

    render(<BranchTabRoot project={{ id: 'proj-1', name: 'Demo' }} />);

    await waitFor(() => {
      const detailsProps = branchDetailsMock.mock.calls.at(-1)[0];
      expect(detailsProps.committedFiles).toEqual([]);
      expect(detailsProps.committedFilesBranchName).toBe('');
    });

    expect(axios.get).not.toHaveBeenCalled();
  });

  test('begin testing does not sync overview when project id is missing', async () => {
    const overview = { branches: [{ name: 'main' }], current: 'main' };
    const handleRunTests = vi.fn().mockResolvedValue({ overview });

    setupMocks({
      branchOverrides: {
        selectedBranchName: 'feature-login',
        selectedSummary: { name: 'feature-login', isCurrent: false },
        selectedWorkingBranch: { name: 'feature-login', stagedFiles: [{ path: 'README.md' }] },
        selectedFiles: [{ path: 'README.md' }],
        hasSelectedFiles: true,
        handleRunTests
      }
    });

    render(<BranchTabRoot project={null} />);

    const detailsProps = branchDetailsMock.mock.calls.at(-1)[0];
    expect(typeof detailsProps.onBeginTesting).toBe('function');

    await act(async () => {
      detailsProps.onBeginTesting();
    });

    await waitFor(() => {
      expect(handleRunTests).toHaveBeenCalledWith('feature-login', { navigateToCommitsOnPass: false });
    });

    expect(syncBranchOverviewSpy).not.toHaveBeenCalled();
  });

  test('begin testing syncs branch overview when provided', async () => {
    const handleRunTests = vi.fn().mockResolvedValue({ overview: { branches: [{ name: 'main' }], current: 'main' } });

    setupMocks({
      branchOverrides: {
        selectedBranchName: 'feature-login',
        selectedSummary: { name: 'feature-login', isCurrent: false },
        selectedWorkingBranch: { name: 'feature-login', stagedFiles: [{ path: 'README.md' }] },
        selectedFiles: [{ path: 'README.md' }],
        hasSelectedFiles: true,
        handleRunTests
      }
    });

    render(<BranchTabRoot project={{ id: 'proj-1', name: 'Demo' }} />);

    const detailsProps = branchDetailsMock.mock.calls.at(-1)[0];
    expect(typeof detailsProps.onBeginTesting).toBe('function');

    await act(async () => {
      detailsProps.onBeginTesting();
    });

    await waitFor(() => {
      expect(handleRunTests).toHaveBeenCalledWith('feature-login', { navigateToCommitsOnPass: false });
      expect(syncBranchOverviewSpy).toHaveBeenCalledWith('proj-1', { branches: [{ name: 'main' }], current: 'main' });
    });
  });

  test('handleConfirmCreateBranch surfaces backend errors', async () => {
    const creationError = new Error('boom');
    creationError.response = { data: { error: 'Cannot create branch' } };
    setupMocks({
      branchOverrides: {
        handleCreateBranch: vi.fn().mockRejectedValue(creationError)
      }
    });

    render(<BranchTabRoot project={{ id: 'proj-1' }} />);

    const initialModalProps = newBranchModalMock.mock.calls.at(-1)[0];
    await act(async () => {
      await initialModalProps.onSubmit({ name: 'feature-ai' });
    });

    const latestModalProps = newBranchModalMock.mock.calls.at(-1)[0];
    expect(latestModalProps.errorMessage).toBe('Cannot create branch');
  });

  test('handleConfirmCreateBranch falls back to default error copy', async () => {
    setupMocks({
      branchOverrides: {
        handleCreateBranch: vi.fn().mockRejectedValue({})
      }
    });

    render(<BranchTabRoot project={{ id: 'proj-1' }} />);

    const modalProps = newBranchModalMock.mock.calls.at(-1)[0];
    await act(async () => {
      await modalProps.onSubmit({ name: 'feature-ai' });
    });

    const latestModalProps = newBranchModalMock.mock.calls.at(-1)[0];
    expect(latestModalProps.errorMessage).toBe('Failed to create branch');
  });

  test('clears committed files when prerequisites are not met', async () => {
    setupMocks({
      branchOverrides: {
        selectedBranchName: 'main',
        selectedSummary: { name: 'main', isCurrent: true },
        selectedWorkingBranch: null,
        selectedFiles: [],
        hasSelectedFiles: false
      }
    });

    render(<BranchTabRoot project={{ id: 'proj-1', name: 'Demo' }} />);

    await waitFor(() => {
      const detailsProps = branchDetailsMock.mock.calls.at(-1)[0];
      expect(detailsProps.committedFiles).toEqual([]);
      expect(detailsProps.isLoadingCommittedFiles).toBe(false);
      expect(detailsProps.committedFilesBranchName).toBe('');
    });
  });

  test('fetches committed files once and serves subsequent visits from cache', async () => {
    axios.get.mockResolvedValueOnce({ data: { files: ['src/A.jsx', 'src/B.jsx'] } });

    setupMocks({
      branchOverrides: {
        selectedBranchName: 'feature/cache-me',
        selectedSummary: { name: 'feature/cache-me', isCurrent: false, stagedFileCount: 1 },
        selectedWorkingBranch: { name: 'feature/cache-me', stagedFiles: [] },
        selectedFiles: [],
        hasSelectedFiles: false
      }
    });

    const view = render(<BranchTabRoot project={{ id: 'proj-1', name: 'Demo' }} />);

    await waitFor(() => {
      const detailsProps = branchDetailsMock.mock.calls.at(-1)[0];
      expect(detailsProps.committedFiles).toEqual(['src/A.jsx', 'src/B.jsx']);
      expect(detailsProps.isLoadingCommittedFiles).toBe(false);
      expect(detailsProps.committedFilesBranchName).toBe('feature/cache-me');
    });

    // Move away to another branch, then back to ensure the cache hit path runs.
    setupMocks({
      branchOverrides: {
        selectedBranchName: 'feature/other',
        selectedSummary: { name: 'feature/other', isCurrent: false, stagedFileCount: 1 },
        selectedWorkingBranch: { name: 'feature/other', stagedFiles: [] },
        // Avoid triggering a separate committed-files fetch for the intermediate branch.
        selectedFiles: [{ path: 'README.md' }],
        hasSelectedFiles: true
      }
    });

    view.rerender(<BranchTabRoot project={{ id: 'proj-1', name: 'Demo' }} />);

    setupMocks({
      branchOverrides: {
        selectedBranchName: 'feature/cache-me',
        selectedSummary: { name: 'feature/cache-me', isCurrent: false, stagedFileCount: 1 },
        selectedWorkingBranch: { name: 'feature/cache-me', stagedFiles: [] },
        selectedFiles: [],
        hasSelectedFiles: false
      }
    });

    view.rerender(<BranchTabRoot project={{ id: 'proj-1', name: 'Demo' }} />);

    await waitFor(() => {
      const detailsProps = branchDetailsMock.mock.calls.at(-1)[0];
      expect(detailsProps.committedFiles).toEqual(['src/A.jsx', 'src/B.jsx']);
      expect(detailsProps.committedFilesBranchName).toBe('feature/cache-me');
    });

    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('handles committed files fetch errors by caching and surfacing empty files', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => null);
    axios.get.mockRejectedValueOnce(new Error('boom'));

    setupMocks({
      branchOverrides: {
        selectedBranchName: 'feature/fail-fetch',
        selectedSummary: { name: 'feature/fail-fetch', isCurrent: false, stagedFileCount: 1 },
        selectedWorkingBranch: { name: 'feature/fail-fetch', stagedFiles: [] },
        selectedFiles: [],
        hasSelectedFiles: false
      }
    });

    render(<BranchTabRoot project={{ id: 'proj-1', name: 'Demo' }} />);

    await waitFor(() => {
      const detailsProps = branchDetailsMock.mock.calls.at(-1)[0];
      expect(detailsProps.committedFiles).toEqual([]);
      expect(detailsProps.isLoadingCommittedFiles).toBe(false);
      expect(detailsProps.committedFilesBranchName).toBe('feature/fail-fetch');
    });

    warnSpy.mockRestore();
  });

  test('ignores committed files fetch resolution after unmount (covers cancelled guards)', async () => {
    const deferred = {};
    deferred.promise = new Promise((resolve, reject) => {
      deferred.resolve = resolve;
      deferred.reject = reject;
    });

    axios.get.mockReturnValueOnce(deferred.promise);

    setupMocks({
      branchOverrides: {
        selectedBranchName: 'feature/cancelled',
        selectedSummary: { name: 'feature/cancelled', isCurrent: false, stagedFileCount: 1 },
        selectedWorkingBranch: { name: 'feature/cancelled', stagedFiles: [] },
        selectedFiles: [],
        hasSelectedFiles: false
      }
    });

    const view = render(<BranchTabRoot project={{ id: 'proj-1', name: 'Demo' }} />);
    view.unmount();

    await act(async () => {
      deferred.resolve({ data: { files: ['src/ignored.jsx'] } });
      await Promise.resolve();
    });
  });

  test('does not warn when committed files fetch rejects after unmount (covers cancelled catch guard)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => null);
    const deferred = {};
    deferred.promise = new Promise((resolve, reject) => {
      deferred.resolve = resolve;
      deferred.reject = reject;
    });

    axios.get.mockReturnValueOnce(deferred.promise);

    setupMocks({
      branchOverrides: {
        selectedBranchName: 'feature/cancelled-reject',
        selectedSummary: { name: 'feature/cancelled-reject', isCurrent: false, stagedFileCount: 1 },
        selectedWorkingBranch: { name: 'feature/cancelled-reject', stagedFiles: [] },
        selectedFiles: [],
        hasSelectedFiles: false
      }
    });

    const view = render(<BranchTabRoot project={{ id: 'proj-1', name: 'Demo' }} />);
    view.unmount();

    await act(async () => {
      deferred.reject(new Error('nope'));
      await Promise.resolve();
    });

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('wraps onMerge callback and swallows merge errors', async () => {
    const handleMergeBranch = vi.fn().mockRejectedValue(new Error('merge failed'));

    setupMocks({
      branchOverrides: {
        selectedBranchName: 'feature/merge-wrap',
        selectedSummary: { name: 'feature/merge-wrap', isCurrent: false, stagedFileCount: 1 },
        selectedWorkingBranch: { name: 'feature/merge-wrap', stagedFiles: [] },
        selectedFiles: [],
        hasSelectedFiles: false,
        handleMergeBranch
      }
    });

    render(<BranchTabRoot project={{ id: 'proj-1', name: 'Demo' }} />);
    const detailsProps = branchDetailsMock.mock.calls.at(-1)[0];

    expect(typeof detailsProps.onMerge).toBe('function');

    await act(async () => {
      detailsProps.onMerge();
      await Promise.resolve();
    });

    expect(handleMergeBranch).toHaveBeenCalledWith('feature/merge-wrap');
  });

  test('renders revert checkout controls when selected branch is merged', () => {
    mockDeriveDisplayStatus.mockReturnValue('merged');
    setupMocks();

    render(<BranchTabRoot project={{ id: 'proj-1', name: 'Demo' }} />);

    const detailsProps = branchDetailsMock.mock.calls.at(-1)[0];
    expect(detailsProps.checkoutTestId).toBe('branch-revert');
    expect(detailsProps.checkoutLabel).toBe('Revert to this branch');
  });

  test('shows stopping banner copy when processes are shutting down', () => {
    setupMocks({
      branchOverrides: {
        showShutdownBanner: true,
        isStoppingProject: true,
        shutdownError: null
      }
    });

    render(<BranchTabRoot project={{ name: 'Demo Project' }} />);

    expect(screen.getByTestId('branch-shutdown-banner')).toHaveTextContent(
      'Stopping Demo Project processes…'
    );
  });

  test('shutdown banner falls back to generic project label when name is missing', () => {
    setupMocks({
      branchOverrides: {
        showShutdownBanner: true,
        isStoppingProject: true,
        shutdownError: null
      }
    });

    render(<BranchTabRoot project={null} />);

    expect(screen.getByTestId('branch-shutdown-banner')).toHaveTextContent(
      'Stopping project processes…'
    );
  });

  test('shows failure banner copy when shutdown reports an error', () => {
    setupMocks({
      branchOverrides: {
        showShutdownBanner: true,
        isStoppingProject: false,
        shutdownError: 'network timeout'
      }
    });

    render(<BranchTabRoot project={{ name: 'Demo Project' }} />);

    expect(screen.getByTestId('branch-shutdown-banner')).toHaveTextContent(
      'Stop failed: network timeout'
    );
  });
});
