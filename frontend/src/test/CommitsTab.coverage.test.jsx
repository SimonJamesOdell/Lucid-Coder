import React from 'react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, screen, act } from '@testing-library/react';
import axios from 'axios';

let latestComposerOnAutofill = null;

let requestEditorFocusValue = vi.fn();
let workingBranchesValue = {};
let workspaceChangesValue = {};
let syncBranchOverviewValue = vi.fn();
let isLLMConfiguredValue = false;

const project = { id: 'project-coverage', name: 'Coverage Project' };

vi.mock('../context/AppStateContext', () => ({
  useAppState: () => ({
    requestEditorFocus: requestEditorFocusValue,
    workingBranches: workingBranchesValue,
    workspaceChanges: workspaceChangesValue,
    syncBranchOverview: syncBranchOverviewValue,
    isLLMConfigured: isLLMConfiguredValue
  })
}));

vi.mock('../components/branch-tab/CommitComposer', () => ({
  __esModule: true,
  default: (props) => {
    latestComposerOnAutofill = props.onAutofill;
    return (
      <div data-testid="mock-commit-composer">
        <div data-testid="branch-commit-hint">{props.commitHint || ''}</div>
        {props.commitMessageError ? (
          <div data-testid="branch-commit-error">{props.commitMessageError}</div>
        ) : null}
        {props.onAutofill ? (
          <button
            type="button"
            data-testid="branch-commit-autofill"
            onClick={props.onAutofill}
            disabled={
              !props.hasSelectedFiles ||
              !props.canAutofill ||
              props.isGenerating ||
              props.isCommitting
            }
          >
            Autofill with AI
          </button>
        ) : null}
      </div>
    );
  }
}));

const mockedCommitComposer = {
  commitMessageRequest: null,
  commitMessageError: null,
  isLLMConfigured: false,
  getCommitMessageForBranch: vi.fn(() => ''),
  getCommitSubjectForBranch: vi.fn(() => 'Coverage subject'),
  getCommitBodyForBranch: vi.fn(() => ''),
  handleCommitMessageChange: vi.fn(),
  handleCommitMessageAutofill: vi.fn(),
  clearCommitMessageForBranch: vi.fn()
};

vi.mock('../components/branch-tab/useCommitComposer', () => ({
  useCommitComposer: () => mockedCommitComposer
}));

const renderCommitsTab = async (props = {}) => {
  const CommitsTab = (await import('../components/CommitsTab')).default;
  return render(<CommitsTab project={project} {...props} />);
};

beforeEach(() => {
  vi.clearAllMocks();
  axios.get.mockReset();
  axios.post.mockReset();
  requestEditorFocusValue = vi.fn();
  workingBranchesValue = {};
  workspaceChangesValue = {};
  syncBranchOverviewValue = vi.fn();
  isLLMConfiguredValue = false;

  mockedCommitComposer.commitMessageRequest = null;
  mockedCommitComposer.commitMessageError = null;
  mockedCommitComposer.isLLMConfigured = false;

  mockedCommitComposer.getCommitMessageForBranch.mockImplementation(() => '');
  mockedCommitComposer.getCommitSubjectForBranch.mockImplementation(() => 'Coverage subject');
  mockedCommitComposer.getCommitBodyForBranch.mockImplementation(() => '');
});

describe('CommitsTab coverage branches', () => {
  test('commit handler assigns head sha after refresh (covers headSha line)', async () => {
    const testApiRef = { current: null };

    // Ensure commit is allowed.
    workingBranchesValue = {
      [project.id]: {
        name: 'feature/coverage',
        status: 'ready-for-merge',
        lastTestStatus: 'passed',
        testsRequired: false,
        stagedFiles: [{ path: 'src/a.js' }]
      }
    };

    const headCommit = {
      sha: 'abc1234',
      shortSha: 'abc1234',
      message: 'Head commit',
      author: { name: 'Alice' },
      authoredAt: '2024-01-01T00:00:00.000Z'
    };

    let commitsFetchCount = 0;
    axios.get.mockImplementation(async (url) => {
      if (url === `/api/projects/${project.id}/commits`) {
        commitsFetchCount += 1;
        return {
          data: {
            success: true,
            commits: commitsFetchCount === 1 ? [] : [headCommit]
          }
        };
      }

      if (url === `/api/projects/${project.id}/commits/${headCommit.sha}`) {
        return {
          data: {
            success: true,
            commit: {
              ...headCommit,
              files: []
            }
          }
        };
      }

      return { data: { success: true } };
    });

    axios.post.mockResolvedValueOnce({
      data: {
        success: true,
        overview: { branches: [], current: 'feature/coverage', workingBranches: [] }
      }
    });

    await renderCommitsTab({ testApiRef });

    await waitFor(() => {
      expect(testApiRef.current).toEqual(
        expect.objectContaining({
          handleCommitStagedChanges: expect.any(Function)
        })
      );
    });

    await act(async () => {
      await testApiRef.current.handleCommitStagedChanges();
    });

    await waitFor(() => {
      expect(axios.post).toHaveBeenCalled();
      const commitsCalls = axios.get.mock.calls.filter(([url]) => url === `/api/projects/${project.id}/commits`);
      expect(commitsCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  test('commit handler tolerates refresh failure (covers headSha null branch)', async () => {
    const testApiRef = { current: null };

    workingBranchesValue = {
      [project.id]: {
        name: 'feature/coverage',
        status: 'ready-for-merge',
        lastTestStatus: 'passed',
        testsRequired: false,
        stagedFiles: [{ path: 'src/a.js' }]
      }
    };

    let commitsFetchCount = 0;
    axios.get.mockImplementation(async (url) => {
      if (url === `/api/projects/${project.id}/commits`) {
        commitsFetchCount += 1;

        // Initial load succeeds; post-commit refresh fails so fetchCommits() returns null.
        if (commitsFetchCount === 1) {
          return { data: { success: true, commits: [] } };
        }

        return { data: { success: false, error: 'Backend unavailable' } };
      }

      return { data: { success: true } };
    });

    axios.post.mockResolvedValueOnce({
      data: {
        success: true,
        overview: { branches: [], current: 'feature/coverage', workingBranches: [] }
      }
    });

    await renderCommitsTab({ testApiRef });

    await waitFor(() => {
      expect(testApiRef.current).toEqual(
        expect.objectContaining({
          handleCommitStagedChanges: expect.any(Function)
        })
      );
    });

    await act(async () => {
      await testApiRef.current.handleCommitStagedChanges();
    });

    await waitFor(() => {
      expect(axios.post).toHaveBeenCalled();
      const commitsCalls = axios.get.mock.calls.filter(([url]) => url === `/api/projects/${project.id}/commits`);
      expect(commitsCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  test('shows the empty commits state when the backend returns no commits', async () => {
    axios.get.mockResolvedValueOnce({ data: { success: true, commits: [] } });

    workingBranchesValue = {
      [project.id]: { name: 'feature/coverage', stagedFiles: [] }
    };

    await renderCommitsTab();

    expect(await screen.findByTestId('commits-empty')).toBeInTheDocument();
  });

  test('dedupes commits by sha but keeps commits without a sha', async () => {
    axios.get
      .mockResolvedValueOnce({
        data: {
          success: true,
          commits: [
            {
              sha: 'abc1234',
              shortSha: 'abc1234',
              message: 'First',
              author: { name: 'Alice' },
              authoredAt: '2024-01-01T00:00:00.000Z'
            },
            {
              sha: 'abc1234',
              shortSha: 'abcdup',
              message: 'Duplicate',
              author: { name: 'Bob' },
              authoredAt: '2024-01-02T00:00:00.000Z'
            },
            {
              sha: null,
              shortSha: 'none',
              message: 'No sha commit',
              author: { name: 'Charlie' },
              authoredAt: '2024-01-03T00:00:00.000Z'
            }
          ]
        }
      })
      .mockResolvedValueOnce({
        data: {
          success: true,
          commit: {
            sha: 'abc1234',
            shortSha: 'abc1234',
            message: 'First',
            files: []
          }
        }
      });

    workingBranchesValue = {
      [project.id]: { name: 'feature/coverage', stagedFiles: [] }
    };

    await renderCommitsTab();

    expect(await screen.findByTestId('commit-abc1234')).toBeInTheDocument();
    expect(screen.queryByTestId('commit-abcdup')).toBeNull();
    expect(screen.getByTestId('commit-none')).toBeInTheDocument();
  });

  test('CSS-only detection returns early when there are no staged files', async () => {
    axios.get.mockResolvedValueOnce({ data: { success: true, commits: [] } });

    workingBranchesValue = {
      [project.id]: { name: 'feature/coverage', stagedFiles: [] }
    };

    await renderCommitsTab();

    await waitFor(() => {
      expect(axios.get).toHaveBeenCalled();
    });
  });

  test('pending commit selection is cleared when branch becomes not ready to commit', async () => {
    const commitsResponse = {
      data: {
        success: true,
        commits: [
          {
            sha: 'aaaaaaaa',
            shortSha: 'aaaaaaa',
            message: 'Existing commit',
            author: { name: 'Alice' },
            authoredAt: '2024-01-01T00:00:00.000Z'
          }
        ]
      }
    };

    axios.get.mockResolvedValueOnce(commitsResponse);

    workingBranchesValue = {
      [project.id]: {
        name: 'feature/coverage',
        stagedFiles: [{ path: 'src/a.js' }],
        lastTestStatus: 'passed',
        status: 'ready-for-merge'
      }
    };

    const view = await renderCommitsTab();

    const pending = await screen.findByTestId('commit-pending');
    expect(pending.className).toMatch(/selected/);

    // Flip the branch state so it's no longer ready-to-commit.
    workingBranchesValue = {
      [project.id]: {
        name: 'feature/coverage',
        stagedFiles: [],
        lastTestStatus: 'passed',
        status: 'ready-for-merge'
      }
    };

    const CommitsTab = (await import('../components/CommitsTab')).default;

    // Depending on module caching, rerendering with a dynamically imported component
    // can sometimes trigger a remount and a second fetch.
    axios.get.mockResolvedValueOnce(commitsResponse);
    view.rerender(<CommitsTab project={project} />);

    await waitFor(() => {
      expect(screen.queryByTestId('commit-pending')).toBeNull();
    });

    const commitItem = await screen.findByTestId('commit-aaaaaaa');
    expect(commitItem.className).toMatch(/selected/);
  });

  test('manual autofill bails out when activeBranchName is empty even if LLM is configured', async () => {
    axios.get.mockResolvedValueOnce({ data: { success: true, commits: [] } });

    isLLMConfiguredValue = true;
    mockedCommitComposer.isLLMConfigured = true;
    mockedCommitComposer.commitMessageRequest = null;

    workingBranchesValue = {
      [project.id]: { name: null }
    };
    workspaceChangesValue = {
      [project.id]: { stagedFiles: [{ path: 'src/styles.css' }] }
    };

    await renderCommitsTab();

    expect(typeof latestComposerOnAutofill).toBe('function');
    latestComposerOnAutofill();
    expect(mockedCommitComposer.handleCommitMessageAutofill).not.toHaveBeenCalled();
  });

  test('manual autofill bails out when there are no staged files even if LLM is configured', async () => {
    axios.get.mockResolvedValueOnce({ data: { success: true, commits: [] } });

    isLLMConfiguredValue = true;
    mockedCommitComposer.isLLMConfigured = true;
    mockedCommitComposer.commitMessageRequest = null;

    workingBranchesValue = {
      [project.id]: { name: 'feature/coverage', stagedFiles: [] }
    };

    await renderCommitsTab();

    expect(typeof latestComposerOnAutofill).toBe('function');
    latestComposerOnAutofill();
    expect(mockedCommitComposer.handleCommitMessageAutofill).not.toHaveBeenCalled();
  });

  test('treats staged files with blank paths as not CSS-only', async () => {
    axios.get.mockResolvedValueOnce({ data: { success: true, commits: [] } });

    workingBranchesValue = {
      [project.id]: { name: 'feature/coverage' }
    };
    workspaceChangesValue = {
      [project.id]: { stagedFiles: [{ path: '' }] }
    };

    await renderCommitsTab();

    await waitFor(() => {
      expect(axios.get).toHaveBeenCalled();
    });
  });

  test('treats staged files with non-string paths as not CSS-only', async () => {
    axios.get.mockResolvedValueOnce({ data: { success: true, commits: [] } });

    workingBranchesValue = {
      [project.id]: { name: 'feature/coverage' }
    };
    workspaceChangesValue = {
      [project.id]: { stagedFiles: [{ path: null }] }
    };

    await renderCommitsTab();

    await waitFor(() => {
      expect(axios.get).toHaveBeenCalled();
    });
  });

  test('clears pending selection to empty string when branch becomes not-ready and there are no commits', async () => {
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: [] } })
      .mockResolvedValueOnce({ data: { success: true, commits: [] } });

    workingBranchesValue = {
      [project.id]: { name: 'feature/coverage', stagedFiles: [{ path: 'src/styles.css' }] }
    };

    const view = await renderCommitsTab();
    expect(await screen.findByTestId('commit-pending-header')).toBeInTheDocument();

    workingBranchesValue = {
      [project.id]: { name: 'feature/coverage', stagedFiles: [] }
    };

    const CommitsTab = (await import('../components/CommitsTab')).default;
    view.rerender(<CommitsTab project={project} />);

    await waitFor(() => {
      expect(screen.queryByTestId('commit-pending-header')).toBeNull();
    });

    expect(screen.getByTestId('commit-no-selection')).toBeInTheDocument();
  });

  test('selectedCommit memo falls back to null when sha is not in commits', async () => {
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: [] } })
      // Selecting an arbitrary SHA triggers the detail-loader effect.
      .mockResolvedValueOnce({ data: { success: true } });

    const apiRef = { current: null };
    await renderCommitsTab({ testApiRef: apiRef });

    await waitFor(() => {
      expect(apiRef.current?.handleSelectCommit).toBeTypeOf('function');
    });

    await waitFor(() => {
      expect(screen.queryByTestId('commits-loading')).toBeNull();
    });

    await act(async () => {
      apiRef.current.handleSelectCommit('does-not-exist');
    });

    await waitFor(() => {
      expect(axios.get).toHaveBeenCalledWith(
        `/api/projects/${project.id}/commits/${encodeURIComponent('does-not-exist')}`
      );
    });

    expect(screen.getByTestId('commit-no-selection')).toBeInTheDocument();
  });

  test('commit list falls back when message/author are missing', async () => {
    axios.get
      .mockResolvedValueOnce({
        data: {
          success: true,
          commits: [
            {
              sha: 'bbbbbbbb',
              shortSha: 'bbbbbbb',
              message: '',
              author: null,
              authoredAt: ''
            }
          ]
        }
      })
      // The first commit is auto-selected, triggering a detail-loader call.
      .mockResolvedValueOnce({ data: { success: true } });

    await renderCommitsTab();

    await waitFor(() => {
      expect(axios.get).toHaveBeenCalled();
    });

    expect(screen.getByText('No message')).toBeInTheDocument();
    expect(screen.getAllByText('Unknown author').length).toBeGreaterThan(0);
  });

  test('pending commit header pluralizes staged files and tolerates non-string draft values', async () => {
    axios.get.mockResolvedValueOnce({ data: { success: true, commits: [] } });

    mockedCommitComposer.getCommitSubjectForBranch.mockImplementation(() => null);
    mockedCommitComposer.getCommitBodyForBranch.mockImplementation(() => undefined);

    workingBranchesValue = {
      [project.id]: {
        name: 'feature/coverage',
        stagedFiles: [{ path: 'src/a.js' }, { path: 'src/b.js' }],
        lastTestStatus: 'passed',
        status: 'ready-for-merge'
      }
    };

    await renderCommitsTab();

    const header = await screen.findByTestId('commit-pending-header');
    expect(header).toHaveTextContent('2 staged files');
  });

  test('autofill request waits until an active branch name is available', async () => {
    axios.get.mockResolvedValueOnce({ data: { success: true, commits: [] } });

    isLLMConfiguredValue = true;
    mockedCommitComposer.isLLMConfigured = true;
    mockedCommitComposer.commitMessageRequest = null;
    mockedCommitComposer.getCommitSubjectForBranch.mockImplementation(() => '');
    mockedCommitComposer.getCommitBodyForBranch.mockImplementation(() => '');

    // No working branch loaded yet.
    workingBranchesValue = {
      [project.id]: null
    };
    workspaceChangesValue = {
      [project.id]: { stagedFiles: [{ path: 'src/styles.css' }] }
    };

    const onConsumeAutofillRequest = vi.fn();
    await renderCommitsTab({ autofillRequestId: 77, onConsumeAutofillRequest });

    await waitFor(() => {
      expect(axios.get).toHaveBeenCalled();
    });

    expect(mockedCommitComposer.handleCommitMessageAutofill).not.toHaveBeenCalled();
    expect(onConsumeAutofillRequest).not.toHaveBeenCalled();
  });

  test('does not auto-autofill when LLM prerequisites are missing even with a request id', async () => {
    axios.get.mockResolvedValueOnce({ data: { success: true, commits: [] } });

    mockedCommitComposer.isLLMConfigured = false;
    mockedCommitComposer.commitMessageRequest = null;
    mockedCommitComposer.getCommitSubjectForBranch.mockImplementation(() => '');
    mockedCommitComposer.getCommitBodyForBranch.mockImplementation(() => '');

    workingBranchesValue = {
      [project.id]: { name: 'feature/coverage' }
    };
    workspaceChangesValue = {
      [project.id]: { stagedFiles: [{ path: 'src/styles.css' }] }
    };

    const onConsumeAutofillRequest = vi.fn();
    await renderCommitsTab({ autofillRequestId: 123, onConsumeAutofillRequest });

    await waitFor(() => {
      expect(axios.get).toHaveBeenCalled();
    });

    expect(mockedCommitComposer.handleCommitMessageAutofill).not.toHaveBeenCalled();
    expect(onConsumeAutofillRequest).toHaveBeenCalledWith(123);
  });

  test('manual autofill bails out when LLM prerequisites are missing', async () => {
    axios.get.mockResolvedValueOnce({ data: { success: true, commits: [] } });

    mockedCommitComposer.isLLMConfigured = false;
    mockedCommitComposer.commitMessageRequest = null;
    mockedCommitComposer.getCommitSubjectForBranch.mockImplementation(() => '');
    mockedCommitComposer.getCommitBodyForBranch.mockImplementation(() => '');

    workingBranchesValue = {
      [project.id]: { name: 'feature/coverage' }
    };
    workspaceChangesValue = {
      [project.id]: { stagedFiles: [{ path: 'src/styles.css' }] }
    };

    await renderCommitsTab();

    expect(typeof latestComposerOnAutofill).toBe('function');
    latestComposerOnAutofill();
    expect(mockedCommitComposer.handleCommitMessageAutofill).not.toHaveBeenCalled();
  });

  test('manual autofill bails out while a commit message is generating', async () => {
    axios.get.mockResolvedValueOnce({ data: { success: true, commits: [] } });

    isLLMConfiguredValue = true;
    mockedCommitComposer.isLLMConfigured = true;
    mockedCommitComposer.commitMessageRequest = 'feature/coverage';
    mockedCommitComposer.getCommitSubjectForBranch.mockImplementation(() => '');
    mockedCommitComposer.getCommitBodyForBranch.mockImplementation(() => '');

    workingBranchesValue = {
      [project.id]: { name: 'feature/coverage' }
    };
    workspaceChangesValue = {
      [project.id]: { stagedFiles: [{ path: 'src/styles.css' }] }
    };

    await renderCommitsTab();

    expect(typeof latestComposerOnAutofill).toBe('function');
    latestComposerOnAutofill();
    expect(mockedCommitComposer.handleCommitMessageAutofill).not.toHaveBeenCalled();
  });

  test('manual autofill bails out while commit is in flight', async () => {
    axios.get.mockResolvedValueOnce({ data: { success: true, commits: [] } });

    isLLMConfiguredValue = true;
    mockedCommitComposer.isLLMConfigured = true;
    mockedCommitComposer.commitMessageRequest = null;
    mockedCommitComposer.getCommitSubjectForBranch.mockImplementation(() => 'feat: something');
    mockedCommitComposer.getCommitBodyForBranch.mockImplementation(() => '');

    workingBranchesValue = {
      [project.id]: {
        name: 'feature/coverage',
        stagedFiles: [{ path: 'src/styles.css' }],
        lastTestStatus: 'passed',
        status: 'ready-for-merge'
      }
    };

    const apiRef = { current: null };
    await renderCommitsTab({ testApiRef: apiRef });

    await waitFor(() => {
      expect(typeof apiRef.current.handleCommitStagedChanges).toBe('function');
      expect(typeof apiRef.current.handleManualAutofill).toBe('function');
    });

    // Fire a commit request and keep it pending so commitInFlight remains true.
    axios.post.mockImplementationOnce(() => new Promise(() => {}));
    act(() => {
      apiRef.current.handleCommitStagedChanges();
    });

    // Let React flush the commitInFlight state update.
    await act(async () => {
      await Promise.resolve();
    });

    apiRef.current.handleManualAutofill();
    expect(mockedCommitComposer.handleCommitMessageAutofill).not.toHaveBeenCalled();
  });

  test('merge handler returns early when branch is not merge-ready', async () => {
    axios.get.mockResolvedValueOnce({ data: { success: true, commits: [] } });

    workingBranchesValue = {
      [project.id]: {
        name: 'feature/not-ready',
        stagedFiles: [],
        status: 'active',
        lastTestStatus: 'failed',
        testsRequired: true
      }
    };

    const apiRef = { current: null };
    await renderCommitsTab({ testApiRef: apiRef });

    await waitFor(() => {
      expect(typeof apiRef.current.handleMergeBranch).toBe('function');
    });

    await act(async () => {
      await apiRef.current.handleMergeBranch();
    });

    expect(axios.post).not.toHaveBeenCalled();
  });

  test('auto-autofill tolerates non-string draft values', async () => {
    axios.get.mockResolvedValueOnce({ data: { success: true, commits: [] } });

    isLLMConfiguredValue = true;
    mockedCommitComposer.isLLMConfigured = true;
    mockedCommitComposer.commitMessageRequest = null;
    mockedCommitComposer.getCommitSubjectForBranch.mockImplementation(() => null);
    mockedCommitComposer.getCommitBodyForBranch.mockImplementation(() => undefined);

    workingBranchesValue = {
      [project.id]: { name: 'feature/coverage' }
    };
    workspaceChangesValue = {
      [project.id]: { stagedFiles: [{ path: 'src/styles.css' }] }
    };

    const onConsumeAutofillRequest = vi.fn();
    await renderCommitsTab({ autofillRequestId: 1, onConsumeAutofillRequest });

    await waitFor(() => {
      expect(mockedCommitComposer.handleCommitMessageAutofill).toHaveBeenCalledWith('feature/coverage', [
        { path: 'src/styles.css' }
      ]);
    });

    expect(onConsumeAutofillRequest).toHaveBeenCalledWith(1);
  });

  test('does not auto-autofill while commit message is generating', async () => {
    axios.get.mockResolvedValueOnce({ data: { success: true, commits: [] } });

    isLLMConfiguredValue = true;
    mockedCommitComposer.isLLMConfigured = true;
    mockedCommitComposer.commitMessageRequest = 'feature/coverage';
    mockedCommitComposer.getCommitSubjectForBranch.mockImplementation(() => '');
    mockedCommitComposer.getCommitBodyForBranch.mockImplementation(() => '');

    workingBranchesValue = {
      [project.id]: { name: 'feature/coverage' }
    };
    workspaceChangesValue = {
      [project.id]: { stagedFiles: [{ path: 'src/styles.css' }] }
    };

    const onConsumeAutofillRequest = vi.fn();
    await renderCommitsTab({ autofillRequestId: 1, onConsumeAutofillRequest });

    await waitFor(() => {
      expect(axios.get).toHaveBeenCalled();
    });

    expect(mockedCommitComposer.handleCommitMessageAutofill).not.toHaveBeenCalled();
    expect(onConsumeAutofillRequest).toHaveBeenCalledWith(1);
  });

  test('auto-autofill only runs once per request and waits for manual click thereafter', async () => {
    axios.get.mockResolvedValueOnce({ data: { success: true, commits: [] } });

    isLLMConfiguredValue = true;
    mockedCommitComposer.isLLMConfigured = true;
    mockedCommitComposer.commitMessageRequest = null;
    mockedCommitComposer.getCommitSubjectForBranch.mockImplementation(() => '');
    mockedCommitComposer.getCommitBodyForBranch.mockImplementation(() => '');

    workingBranchesValue = {
      [project.id]: { name: 'feature/coverage' }
    };
    workspaceChangesValue = {
      [project.id]: { stagedFiles: [{ path: 'src/styles.css' }] }
    };

    const onConsumeAutofillRequest = vi.fn();
    const view = await renderCommitsTab({ autofillRequestId: 7, onConsumeAutofillRequest });

    await waitFor(() => {
      expect(mockedCommitComposer.handleCommitMessageAutofill).toHaveBeenCalledTimes(1);
    });

    // Simulate a re-render with the same request id (e.g., user cleared the input).
    // Change a dependency so the effect runs again and hits the consumed-request guard.
    workspaceChangesValue = {
      [project.id]: { stagedFiles: [{ path: 'src/styles.css' }] }
    };

    const CommitsTab = (await import('../components/CommitsTab')).default;
    view.rerender(
      <CommitsTab project={project} autofillRequestId={7} onConsumeAutofillRequest={onConsumeAutofillRequest} />
    );

    expect(mockedCommitComposer.handleCommitMessageAutofill).toHaveBeenCalledTimes(1);
    expect(onConsumeAutofillRequest).toHaveBeenCalledWith(7);

    // Manual button triggers autofill again.
    screen.getByTestId('branch-commit-autofill').click();
    expect(mockedCommitComposer.handleCommitMessageAutofill).toHaveBeenCalledTimes(2);
    expect(mockedCommitComposer.handleCommitMessageAutofill).toHaveBeenLastCalledWith('feature/coverage', [
      { path: 'src/styles.css' }
    ]);
  });

  test('uses workspaceChanges staged files when active branch omits stagedFiles', async () => {
    mockedCommitComposer.getCommitSubjectForBranch.mockImplementation(() => '');
    axios.get.mockResolvedValueOnce({ data: { success: true, commits: [] } });

    workingBranchesValue = {
      [project.id]: { name: 'feature/coverage' }
    };
    workspaceChangesValue = {
      [project.id]: { stagedFiles: [{ path: 'src/styles.css' }] }
    };

    await renderCommitsTab();

    await waitFor(() => {
      expect(screen.getByTestId('branch-commit-hint')).toHaveTextContent(
        'Add a short subject line to enable the commit.'
      );
    });
  });

  test('prefers working-branch staged files over workspaceChanges when both are present', async () => {
    mockedCommitComposer.getCommitSubjectForBranch.mockImplementation(() => '');
    axios.get.mockResolvedValueOnce({ data: { success: true, commits: [] } });

    workingBranchesValue = {
      [project.id]: {
        name: 'feature/coverage',
        stagedFiles: [{ path: 'src/a.css' }, { path: 'src/b.css' }]
      }
    };
    workspaceChangesValue = {
      [project.id]: { stagedFiles: [{ path: 'src/styles.css' }] }
    };

    await renderCommitsTab();

    expect(await screen.findByTestId('commit-pending-header')).toHaveTextContent('2 staged files');
  });

  test('CSS-only detection treats non-css staged files as not css-only', async () => {
    axios.get.mockResolvedValueOnce({ data: { success: true, commits: [] } });

    workingBranchesValue = {
      [project.id]: { name: 'feature/coverage', stagedFiles: [{ path: 'src/app.js' }] }
    };

    await renderCommitsTab();

    // Non-CSS staged changes should not qualify as ready-to-commit.
    expect(screen.queryByTestId('commit-pending')).toBeNull();
  });

  test('does not clear selection when branch is not ready and selection is not pending', async () => {
    axios.get
      .mockResolvedValueOnce({
        data: {
          success: true,
          commits: [
            {
              sha: 'aaaaaaaaaaaaaaaa',
              shortSha: 'aaaaaaa',
              message: 'First commit',
              author: { name: 'Author' },
              authoredAt: '2024-01-01T00:00:00Z'
            }
          ]
        }
      })
      // The component automatically loads details for the selected commit.
      // If we don't mock this call, it sets an error state and hides the list.
      .mockResolvedValueOnce({
        data: {
          success: true,
          commit: { files: [] }
        }
      });

    // Not ready-to-commit: main branch.
    workingBranchesValue = {
      [project.id]: { name: 'main', stagedFiles: [] }
    };

    await renderCommitsTab();

    expect(await screen.findByTestId('commit-aaaaaaa')).toBeInTheDocument();
    expect(screen.queryByTestId('commit-pending')).toBeNull();
  });

  test('selects the pending commit automatically when branch becomes ready to commit', async () => {
    axios.get.mockResolvedValueOnce({ data: { success: true, commits: [] } });

    workingBranchesValue = {
      [project.id]: { name: 'feature/coverage', stagedFiles: [] }
    };

    const view = await renderCommitsTab();

    expect(screen.queryByTestId('commit-pending-header')).toBeNull();

    // Make the branch ready-to-commit without a user click.
    workingBranchesValue = {
      [project.id]: { name: 'feature/coverage', stagedFiles: [{ path: 'src/styles.css' }] }
    };

    const CommitsTab = (await import('../components/CommitsTab')).default;
    view.rerender(<CommitsTab project={project} />);

    expect(await screen.findByTestId('commit-pending-header')).toBeInTheDocument();
  });

  test('merge success syncs overview and sets status message', async () => {
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: [] } })
      .mockResolvedValueOnce({ data: { success: true, commits: [] } });

    axios.post.mockResolvedValueOnce({
      data: {
        success: true,
        overview: { status: 'ready-for-merge' }
      }
    });

    workingBranchesValue = {
      [project.id]: {
        name: 'feature/coverage',
        status: 'ready-for-merge',
        stagedFiles: [],
        testsRequired: false
      }
    };

    const testApiRef = { current: null };
    await renderCommitsTab({ testApiRef });

    await waitFor(() => {
      expect(testApiRef.current?.handleMergeBranch).toBeTypeOf('function');
    });

    await act(async () => {
      await testApiRef.current.handleMergeBranch();
    });

    expect(syncBranchOverviewValue).toHaveBeenCalledWith(project.id, { status: 'ready-for-merge' });
    expect(await screen.findByText('Merged branch into main')).toBeInTheDocument();
  });

  test('merge ignores overview when syncBranchOverview is not a function', async () => {
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: [] } })
      .mockResolvedValueOnce({ data: { success: true, commits: [] } });

    axios.post.mockResolvedValueOnce({
      data: {
        success: true,
        overview: { status: 'ready-for-merge' }
      }
    });

    syncBranchOverviewValue = null;

    workingBranchesValue = {
      [project.id]: {
        name: 'feature/coverage',
        status: 'ready-for-merge',
        stagedFiles: [],
        testsRequired: false
      }
    };

    const testApiRef = { current: null };
    await renderCommitsTab({ testApiRef });

    await waitFor(() => {
      expect(testApiRef.current?.handleMergeBranch).toBeTypeOf('function');
    });

    await act(async () => {
      await testApiRef.current.handleMergeBranch();
    });

    expect(await screen.findByText('Merged branch into main')).toBeInTheDocument();
  });

  test('merge failure uses server-provided error copy', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    axios.get.mockResolvedValueOnce({ data: { success: true, commits: [] } });

    axios.post.mockRejectedValueOnce({
      response: {
        data: {
          error: 'Cannot merge right now'
        }
      }
    });

    workingBranchesValue = {
      [project.id]: {
        name: 'feature/coverage',
        status: 'ready-for-merge',
        stagedFiles: [],
        testsRequired: false
      }
    };

    const testApiRef = { current: null };
    await renderCommitsTab({ testApiRef });

    await waitFor(() => {
      expect(testApiRef.current?.handleMergeBranch).toBeTypeOf('function');
    });

    await act(async () => {
      await testApiRef.current.handleMergeBranch();
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot merge right now');

    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  test('merge failure falls back to default error copy when backend omits error', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    axios.get.mockResolvedValueOnce({ data: { success: true, commits: [] } });

    axios.post.mockRejectedValueOnce(new Error('Merge failed'));

    workingBranchesValue = {
      [project.id]: {
        name: 'feature/coverage',
        status: 'ready-for-merge',
        stagedFiles: [],
        testsRequired: false
      }
    };

    const testApiRef = { current: null };
    await renderCommitsTab({ testApiRef });

    await waitFor(() => {
      expect(testApiRef.current?.handleMergeBranch).toBeTypeOf('function');
    });

    await act(async () => {
      await testApiRef.current.handleMergeBranch();
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to merge branch');

    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  test('omits commit payload when draft message is empty and uses fallback commit error copy', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: [] } })
      .mockResolvedValueOnce({ data: { success: true, commits: [] } });

    workingBranchesValue = {
      [project.id]: { name: 'feature/coverage' }
    };
    workspaceChangesValue = {
      [project.id]: { stagedFiles: [{ path: 'src/styles.css' }] }
    };

    const testApiRef = { current: null };

    const error = new Error('Commit failed');
    axios.post.mockRejectedValueOnce(error);

    await renderCommitsTab({ testApiRef });

    await waitFor(() => {
      expect(testApiRef.current?.handleCommitStagedChanges).toBeTypeOf('function');
    });

    await act(async () => {
      await testApiRef.current.handleCommitStagedChanges();
    });

    expect(axios.post).toHaveBeenCalledWith(
      `/api/projects/${project.id}/branches/${encodeURIComponent('feature/coverage')}/commit`,
      undefined
    );

    expect(await screen.findByTestId('branch-commit-error')).toHaveTextContent(
      'Failed to commit staged changes'
    );

    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  test('commit success syncs overview when backend returns one', async () => {
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: [] } })
      .mockResolvedValueOnce({
        data: {
          success: true,
          commits: [
            {
              sha: 'abc1234',
              shortSha: 'abc1234',
              message: 'feat: commit',
              author: { name: 'Alice' },
              authoredAt: '2024-01-01T00:00:00.000Z'
            }
          ]
        }
      })
      .mockResolvedValueOnce({
        data: {
          success: true,
          commit: {
            sha: 'abc1234',
            shortSha: 'abc1234',
            message: 'feat: commit',
            files: []
          }
        }
      });

    axios.post.mockResolvedValueOnce({
      data: {
        success: true,
        overview: { status: 'ready-for-merge' }
      }
    });

    mockedCommitComposer.getCommitMessageForBranch.mockImplementation(() => '  feat: commit  ');

    workingBranchesValue = {
      [project.id]: {
        name: 'feature/coverage',
        stagedFiles: [{ path: 'src/styles.css' }],
        lastTestStatus: 'passed',
        status: 'ready-for-merge'
      }
    };
    workspaceChangesValue = {
      [project.id]: { stagedFiles: [{ path: 'src/styles.css' }] }
    };

    const testApiRef = { current: null };
    await renderCommitsTab({ testApiRef });

    await waitFor(() => {
      expect(testApiRef.current?.handleCommitStagedChanges).toBeTypeOf('function');
    });

    await act(async () => {
      await testApiRef.current.handleCommitStagedChanges();
    });

    expect(syncBranchOverviewValue).toHaveBeenCalledWith(project.id, { status: 'ready-for-merge' });
    expect(mockedCommitComposer.clearCommitMessageForBranch).toHaveBeenCalledWith('feature/coverage');
  });
});
