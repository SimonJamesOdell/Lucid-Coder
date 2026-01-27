import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import * as branchTabUtils from '../components/branch-tab/utils';
import CommitsTab from '../components/CommitsTab';

const mockRequestEditorFocus = vi.fn();
let requestEditorFocusValue = mockRequestEditorFocus;
let workingBranchesValue = {};
let workspaceChangesValue = {};
let syncBranchOverviewValue = vi.fn();
let isLLMConfiguredValue = false;

vi.mock('../context/AppStateContext', () => ({
  useAppState: () => ({
    requestEditorFocus: requestEditorFocusValue,
    workingBranches: workingBranchesValue,
    workspaceChanges: workspaceChangesValue,
    syncBranchOverview: syncBranchOverviewValue,
    isLLMConfigured: isLLMConfiguredValue
  })
}));

const mockProject = { id: 'project-55', name: 'History Project' };

const baseCommits = [
  {
    sha: 'def987654321',
    shortSha: 'def9876',
    message: 'Add feature',
    author: { name: 'Demo Dev' },
    authoredAt: '2025-01-06T09:00:00Z',
    canRevert: true
  },
  {
    sha: 'abc123456789',
    shortSha: 'abc1234',
    message: 'Initial commit',
    author: { name: 'Demo Dev' },
    authoredAt: '2025-01-05T10:00:00Z',
    canRevert: false
  }
];

const buildCommitDetail = (commit) => ({
  sha: commit.sha,
  shortSha: commit.shortSha,
  message: commit.message,
  body: `${commit.message} body`,
  author: commit.author,
  authoredAt: commit.authoredAt,
  canRevert: commit.canRevert !== false,
  files: [
    { path: 'src/App.jsx', status: 'M' },
    { path: 'README.md', status: 'A' }
  ]
});

const renderCommitsTab = async (overrides = {}, options = {}) => {
  const props = { project: mockProject, ...overrides };
  if (options.testApiRef) {
    props.testApiRef = options.testApiRef;
  }
  if (options.testInitialState) {
    props.testInitialState = options.testInitialState;
  }
  const result = render(<CommitsTab {...props} />);
  if (props.project?.id && !options.skipFetchWait) {
    await waitFor(() =>
      expect(axios.get).toHaveBeenCalledWith(`/api/projects/${props.project.id}/commits`)
    );
  }
  return result;
};

beforeEach(() => {
  vi.clearAllMocks();
  axios.get.mockReset();
  axios.post.mockReset();
  mockRequestEditorFocus.mockReset();
  requestEditorFocusValue = mockRequestEditorFocus;
  workingBranchesValue = {};
  workspaceChangesValue = {};
  syncBranchOverviewValue = vi.fn();
  isLLMConfiguredValue = false;
});

describe('CommitsTab', () => {
  test('syncs branch overview when commits API includes overview', async () => {
    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature-autosave',
        lastTestStatus: 'passed',
        stagedFiles: [{ path: 'src/App.jsx', source: 'editor', timestamp: '2025-01-01T10:00:00.000Z' }]
      }
    };

    const overview = {
      current: 'feature-autosave',
      branches: [],
      workingBranches: [
        {
          name: 'feature-autosave',
          status: 'needs-fix',
          lastTestStatus: 'failed',
          testsRequired: true,
          stagedFiles: [{ path: 'src/App.js', source: 'editor', timestamp: '2025-01-01T10:00:00.000Z' }]
        }
      ],
      latestTestRun: null
    };

    axios.get.mockResolvedValueOnce({ data: { success: true, commits: [], overview } });

    await renderCommitsTab();

    expect(syncBranchOverviewValue).toHaveBeenCalledWith(mockProject.id, overview);
  });

  test('de-dupes commits by sha (avoids duplicate initial commit entries)', async () => {
    const duplicate = { ...baseCommits[1] };

    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature-demo',
        lastTestStatus: 'passed',
        status: 'ready-for-merge',
        stagedFiles: []
      }
    };

    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: [duplicate, duplicate], overview: null } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(duplicate) } });

    await renderCommitsTab();

    await waitFor(() => {
      expect(screen.getAllByTestId(`commit-${duplicate.shortSha}`)).toHaveLength(1);
    });
  });

  test('hides commit composer on main branch (initial commit state)', async () => {
    workingBranchesValue = {
      [mockProject.id]: { name: 'main', lastTestStatus: 'passed', stagedFiles: [] }
    };

    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    await renderCommitsTab();

    expect(screen.queryByTestId('branch-commit-submit')).not.toBeInTheDocument();
    expect(screen.queryByTestId('branch-commit-subject')).not.toBeInTheDocument();
  });

  test('hides commit composer when tests have not passed and staged changes are not CSS-only', async () => {
    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature-login',
        lastTestStatus: 'failed',
        stagedFiles: [{ path: 'src/App.jsx', source: 'editor', timestamp: '2025-01-01T10:00:00.000Z' }]
      }
    };

    axios.get.mockResolvedValueOnce({ data: { success: true, commits: [] } });

    await renderCommitsTab();

    expect(screen.queryByTestId('branch-commit-submit')).not.toBeInTheDocument();
    expect(screen.queryByTestId('branch-commit-subject')).not.toBeInTheDocument();
  });

  test('renders commit list and shows first commit details', async () => {
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    await renderCommitsTab();

    expect(await screen.findByTestId('commit-def9876')).toHaveClass('selected');
    await waitFor(() => {
      expect(screen.getByTestId('commit-files-list')).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 3, name: 'Add feature' })).toBeInTheDocument();
    });
  });

  test('promotes a ready-to-commit branch as a pending item and selects it by default', async () => {
    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature/y',
        status: 'ready-for-merge',
        lastTestStatus: 'passed',
        stagedFiles: [{ path: 'src/App.jsx', source: 'editor', timestamp: '2025-01-01T10:00:00.000Z' }]
      }
    };

    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    await renderCommitsTab();

    const pendingItem = await screen.findByTestId('commit-pending');
    expect(pendingItem).toHaveClass('selected');
    expect(screen.getByTestId('commit-pending-header')).toBeInTheDocument();
    expect(screen.getByTestId('commit-pending-branch')).toHaveTextContent('feature/y');
    expect(screen.getByTestId('branch-commit-subject')).toBeInTheDocument();
  });

  test('pending commit UI pluralizes staged files when more than one file is staged', async () => {
    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature/css-plural',
        status: 'needs-fix',
        lastTestStatus: 'failed',
        stagedFiles: [{ path: 'src/styles/a.css' }, { path: 'src/styles/b.css' }]
      }
    };

    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    await renderCommitsTab();

    expect(await screen.findByTestId('commit-pending')).toHaveTextContent('2 staged files');
    expect(await screen.findByTestId('commit-pending-header')).toHaveTextContent('2 staged files');
  });

  test('clicking the pending commit item keeps it selected', async () => {
    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature/y',
        status: 'ready-for-merge',
        lastTestStatus: 'passed',
        stagedFiles: [{ path: 'src/App.jsx', source: 'editor', timestamp: '2025-01-01T10:00:00.000Z' }]
      }
    };

    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    const user = userEvent.setup();
    await renderCommitsTab();

    const pendingItem = await screen.findByTestId('commit-pending');
    await user.click(pendingItem);

    expect(pendingItem).toHaveClass('selected');
    expect(screen.getByTestId('commit-pending-header')).toBeInTheDocument();
  });

  test('hides the commit composer when a real commit is selected', async () => {
    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature/y',
        status: 'ready-for-merge',
        lastTestStatus: 'passed',
        stagedFiles: [{ path: 'src/App.jsx', source: 'editor', timestamp: '2025-01-01T10:00:00.000Z' }]
      }
    };

    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[1]) } });

    const user = userEvent.setup();
    await renderCommitsTab();

    await user.click(screen.getByTestId('commit-abc1234'));

    await waitFor(() => {
      expect(screen.queryByTestId('commit-pending-header')).not.toBeInTheDocument();
      expect(screen.queryByTestId('branch-commit-subject')).not.toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 3, name: 'Initial commit' })).toBeInTheDocument();
    });
  });

  test('removes pending commit UI once staged changes are cleared', async () => {
    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature/y',
        status: 'ready-for-merge',
        lastTestStatus: 'passed',
        stagedFiles: [{ path: 'src/App.jsx', source: 'editor', timestamp: '2025-01-01T10:00:00.000Z' }]
      }
    };

    axios.get.mockImplementation((url) => {
      if (url === `/api/projects/${mockProject.id}/commits`) {
        return Promise.resolve({ data: { success: true, commits: baseCommits } });
      }

      if (url.startsWith(`/api/projects/${mockProject.id}/commits/`)) {
        return Promise.resolve({
          data: { success: true, commit: buildCommitDetail(baseCommits[0]) }
        });
      }

      return Promise.resolve({ data: { success: true } });
    });

    const { rerender } = await renderCommitsTab();

    expect(await screen.findByTestId('commit-pending')).toBeInTheDocument();
    expect(screen.getByTestId('branch-commit-subject')).toBeInTheDocument();

    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature/y',
        lastTestStatus: 'passed',
        stagedFiles: []
      }
    };

    rerender(<CommitsTab project={mockProject} />);

    await waitFor(() => {
      expect(screen.queryByTestId('commit-pending')).not.toBeInTheDocument();
      expect(screen.queryByTestId('branch-commit-subject')).not.toBeInTheDocument();
    });
  });

  test('selecting another commit loads its details once', async () => {
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[1]) } });

    const user = userEvent.setup();
    await renderCommitsTab();

    await user.click(screen.getByTestId('commit-abc1234'));

    await waitFor(() => {
      expect(axios.get).toHaveBeenCalledWith(
        `/api/projects/${mockProject.id}/commits/${encodeURIComponent(baseCommits[1].sha)}`
      );
      expect(screen.getByRole('heading', { level: 3, name: 'Initial commit' })).toBeInTheDocument();
    });
  });

  test('reverting a commit posts to the revert endpoint and refreshes list', async () => {
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[1]) } });

    axios.post.mockResolvedValue({
      data: {
        success: true,
        commits: baseCommits.slice(1)
      }
    });

    const user = userEvent.setup();
    await renderCommitsTab();

    const revertButton = await screen.findByTestId('commit-revert');
    await user.click(revertButton);

    await waitFor(() => {
      expect(screen.getByTestId('modal-content')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('modal-confirm'));

    await waitFor(() => {
      expect(axios.post).toHaveBeenCalledWith(
        `/api/projects/${mockProject.id}/commits/${baseCommits[0].sha}/revert`
      );
      expect(screen.getByText('Reverted def9876')).toBeInTheDocument();
    });
  });

  test('selecting two commits and squashing posts to the squash endpoint', async () => {
    const squashedCommit = {
      ...baseCommits[0],
      sha: 'new123456789',
      shortSha: 'new1234',
      message: 'Initial commit',
      canRevert: false
    };

    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(squashedCommit) } });

    axios.post.mockResolvedValue({
      data: {
        success: true,
        squashed: {
          olderSha: baseCommits[1].sha,
          newerSha: baseCommits[0].sha,
          newSha: 'new123456789'
        },
        commits: [
          { ...baseCommits[0], sha: 'new123456789', shortSha: 'new1234', message: 'Initial commit' }
        ]
      }
    });

    const user = userEvent.setup();
    await renderCommitsTab();

    await user.click(screen.getByTestId('commit-squash-select-def9876'));
    await user.click(screen.getByTestId('commit-squash-select-abc1234'));

    expect(await screen.findByTestId('commit-squash-action')).toBeInTheDocument();
    await user.click(screen.getByTestId('commit-squash-action'));

    await waitFor(() => {
      expect(screen.getByTestId('modal-content')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('modal-confirm'));

    await waitFor(() => {
      expect(axios.post).toHaveBeenCalledWith(
        `/api/projects/${mockProject.id}/commits/squash`,
        { olderSha: baseCommits[1].sha, newerSha: baseCommits[0].sha }
      );
      expect(screen.getByText('Squashed commits')).toBeInTheDocument();
    });
  });

  test('squash selection rejects a third commit', async () => {
    const extraCommit = {
      sha: 'zzz111222333',
      shortSha: 'zzz1112',
      message: 'Third commit',
      author: { name: 'Demo Dev' },
      authoredAt: '2025-01-07T10:00:00Z',
      canRevert: true
    };
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: [baseCommits[0], extraCommit, baseCommits[1]] } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    const user = userEvent.setup();
    await renderCommitsTab();

    await user.click(screen.getByTestId('commit-squash-select-def9876'));
    await user.click(screen.getByTestId('commit-squash-select-zzz1112'));
    await user.click(screen.getByTestId('commit-squash-select-abc1234'));

    expect(await screen.findByTestId('commit-squash-error')).toHaveTextContent('Select at most two commits');
    expect(screen.getByTestId('commit-squash-select-abc1234')).not.toBeChecked();
  });

  test('shows empty state when no commits exist', async () => {
    axios.get.mockResolvedValueOnce({ data: { success: true, commits: [] } });

    await renderCommitsTab();

    expect(screen.getByTestId('commits-empty')).toHaveTextContent('No commits found');
    expect(screen.getByTestId('commit-no-selection')).toBeInTheDocument();
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('treats missing commits array as empty list', async () => {
    axios.get.mockResolvedValueOnce({ data: { success: true } });

    await renderCommitsTab();

    expect(screen.getByTestId('commits-empty')).toHaveTextContent('No commits found');
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('displays error message when commit fetch fails', async () => {
    const error = new Error('Fetch failed');
    error.response = { data: { error: 'Backend offline' } };
    axios.get.mockRejectedValueOnce(error);

    await renderCommitsTab();

    await waitFor(() => {
      expect(screen.getByText('Backend offline')).toBeInTheDocument();
    });
  });

  test('falls back to default error when commit fetch throws without response', async () => {
    axios.get.mockRejectedValueOnce(new Error('Total failure'));

    await renderCommitsTab();

    await waitFor(() => {
      expect(screen.getByText('Failed to load commits')).toBeInTheDocument();
    });
  });

  test('shows placeholder when commit details are missing', async () => {
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: false } });

    await renderCommitsTab();

    await waitFor(() => {
      expect(screen.getByTestId('commit-details-missing')).toBeInTheDocument();
    });
  });

  test('does not refetch details for the same commit twice', async () => {
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    const user = userEvent.setup();
    await renderCommitsTab();

    await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(2));

    await user.click(screen.getByTestId('commit-def9876'));

    await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(2));
  });

  test('skips revert flow when user cancels confirmation', async () => {
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    const user = userEvent.setup();
    await renderCommitsTab();

    const revertButton = await screen.findByTestId('commit-revert');
    await user.click(revertButton);

    await waitFor(() => {
      expect(screen.getByTestId('modal-content')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('modal-cancel'));

    expect(axios.post).not.toHaveBeenCalled();
  });

  test('disables file open when editor focus is unavailable', async () => {
    requestEditorFocusValue = null;
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    await renderCommitsTab();

    const fileButton = await screen.findByTestId('commit-file-open-0');
    expect(fileButton).toBeDisabled();
    expect(mockRequestEditorFocus).not.toHaveBeenCalled();
  });

  test('shows fallback when commit has no file metadata', async () => {
    const detailWithoutFiles = { ...buildCommitDetail(baseCommits[0]), files: [] };
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: detailWithoutFiles } });

    await renderCommitsTab();

    await waitFor(() => {
      expect(screen.getByTestId('commit-no-files')).toBeInTheDocument();
    });
  });

  test('renders fallback labels when commit metadata is missing', async () => {
    const metadataSparseCommit = {
      ...baseCommits[0],
      sha: 'missingmeta',
      shortSha: 'missing',
      message: '',
      author: null
    };
    const metadataSparseDetail = {
      ...buildCommitDetail(metadataSparseCommit),
      message: '',
      body: '',
      author: null,
      files: [{ path: 'src/solo.js' }]
    };
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: [metadataSparseCommit] } })
      .mockResolvedValueOnce({ data: { success: true, commit: metadataSparseDetail } });

    await renderCommitsTab();

    expect(screen.getByText('No message')).toBeInTheDocument();
    const unknownAuthorEntries = screen.getAllByText('Unknown author');
    expect(unknownAuthorEntries.length).toBeGreaterThanOrEqual(2);

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 3, name: 'No message provided' })
      ).toBeInTheDocument();
    });

    expect(
      await screen.findByRole('heading', { level: 4, name: '1 file' })
    ).toBeInTheDocument();
    const fileStatus = (await screen.findByTestId('commit-file-open-0'))
      .querySelector('.commit-file-status');
    expect(fileStatus).not.toBeNull();
    expect(fileStatus).toHaveTextContent('M');
    expect(fileStatus).toHaveClass('status-m');
  });

  test('handles revert errors by surfacing messages', async () => {
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    const error = new Error('Revert failed');
    error.response = { data: { error: 'Unable to revert' } };
    axios.post.mockRejectedValueOnce(error);

    const user = userEvent.setup();
    await renderCommitsTab();

    const revertButton = await screen.findByTestId('commit-revert');
    await user.click(revertButton);

    await waitFor(() => {
      expect(screen.getByTestId('modal-content')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('modal-confirm'));

    await waitFor(() => {
      expect(screen.getByText('Unable to revert')).toBeInTheDocument();
    });
  });

  test('does not fetch commits when no project is provided', async () => {
    const registerCommitsActions = vi.fn();
    await renderCommitsTab({ project: null, registerCommitsActions }, { skipFetchWait: true });

    expect(axios.get).not.toHaveBeenCalled();
    expect(screen.getByTestId('commits-empty')).toBeInTheDocument();
    expect(registerCommitsActions).toHaveBeenCalledWith(expect.objectContaining({
      isDisabled: true,
      refreshCommits: expect.any(Function)
    }));
  });

  test('treats projects without an id as not selected', async () => {
    const registerCommitsActions = vi.fn();
    await renderCommitsTab({ project: { name: 'Untitled project' }, registerCommitsActions }, { skipFetchWait: true });

    expect(axios.get).not.toHaveBeenCalled();
    expect(screen.getByTestId('commits-empty')).toBeInTheDocument();
    expect(registerCommitsActions).toHaveBeenCalledWith(expect.objectContaining({
      isDisabled: true,
      refreshCommits: expect.any(Function)
    }));
  });

  test('surfaces API error copy when commits response is not successful', async () => {
    axios.get.mockResolvedValueOnce({ data: { success: false, error: 'No history' } });

    await renderCommitsTab({}, { skipFetchWait: true });

    await waitFor(() => {
      expect(screen.getByText('No history')).toBeInTheDocument();
    });
  });

  test('hides revert button for non-revertable commits', async () => {
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[1]) } });

    const user = userEvent.setup();
    await renderCommitsTab();

    expect(await screen.findByTestId('commit-revert')).toBeInTheDocument();

    await user.click(screen.getByTestId('commit-abc1234'));

    await waitFor(() => {
      expect(axios.get).toHaveBeenCalledWith(
        `/api/projects/${mockProject.id}/commits/${encodeURIComponent(baseCommits[1].sha)}`
      );
    });

    expect(screen.queryByTestId('commit-revert')).not.toBeInTheDocument();
  });

  test('clicking a file entry requests editor focus', async () => {
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    const user = userEvent.setup();
    await renderCommitsTab();

    const fileButton = await screen.findByTestId('commit-file-open-0');
    await user.click(fileButton);

    expect(mockRequestEditorFocus).toHaveBeenCalledWith(
      mockProject.id,
      'src/App.jsx',
      expect.objectContaining({ source: 'commits', commitSha: baseCommits[0].sha })
    );
  });

  test('shows "Unknown time" for missing or invalid timestamps', async () => {
    const timestampCommits = [
      { ...baseCommits[0], authoredAt: null },
      { ...baseCommits[1], authoredAt: 'not-a-date', canRevert: false }
    ];
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: timestampCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(timestampCommits[0]) } });

    await renderCommitsTab();

    await waitFor(() => {
      const unknownEntries = screen.getAllByText('Unknown time');
      expect(unknownEntries.length).toBeGreaterThanOrEqual(2);
    });
  });

  test('keeps selected commit when refreshed with an unchanged entry', async () => {
    const registerCommitsActions = vi.fn();
    let refreshCommits;
    registerCommitsActions.mockImplementation((actions) => {
      refreshCommits = actions?.refreshCommits;
      return undefined;
    });

    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[1]) } })
      .mockResolvedValueOnce({ data: { success: true, commits: [...baseCommits].reverse() } });

    const user = userEvent.setup();
    await renderCommitsTab({ registerCommitsActions });

    await user.click(screen.getByTestId('commit-abc1234'));
    await waitFor(() => expect(screen.getByTestId('commit-abc1234')).toHaveClass('selected'));

    expect(typeof refreshCommits).toBe('function');
    await act(async () => {
      await refreshCommits();
    });
    await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(4));
    expect(screen.getByTestId('commit-abc1234')).toHaveClass('selected');
  });

  test('displays API error when commits response is unsuccessful', async () => {
    axios.get.mockResolvedValueOnce({ data: { success: false, error: 'No sync available' } });

    await renderCommitsTab();

    await waitFor(() => {
      expect(screen.getByText('No sync available')).toBeInTheDocument();
    });
  });

  test('falls back to default error when commits response lacks message', async () => {
    axios.get.mockResolvedValueOnce({ data: { success: false } });

    await renderCommitsTab();

    await waitFor(() => {
      expect(screen.getByText('Failed to load commits')).toBeInTheDocument();
    });
  });

  test('handleSelectCommit ignores falsy SHAs via test API', async () => {
    const testApiRef = { current: null };
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[1]) } });

    const user = userEvent.setup();
    await renderCommitsTab({}, { testApiRef });
    await waitFor(() => expect(testApiRef.current?.handleSelectCommit).toBeTypeOf('function'));

    await user.click(screen.getByTestId('commit-abc1234'));
    await waitFor(() => expect(screen.getByTestId('commit-abc1234')).toHaveClass('selected'));

    await act(async () => {
      testApiRef.current.handleSelectCommit('');
    });

    expect(screen.getByTestId('commit-abc1234')).toHaveClass('selected');
  });

  test('loadCommitDetails skips network work when details already exist', async () => {
    const testApiRef = { current: null };
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    await renderCommitsTab({}, { testApiRef });
    await waitFor(() => expect(testApiRef.current?.loadCommitDetails).toBeTypeOf('function'));
    await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(2));
    await screen.findByTestId('commit-files-list');

    await act(async () => {
      await testApiRef.current.loadCommitDetails(baseCommits[0].sha);
    });

    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  test('loadCommitDetails surfaces fallback error when request fails via test API', async () => {
    const testApiRef = { current: null };
    const detailError = new Error('Manual failure');
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } })
      .mockRejectedValueOnce(detailError);

    await renderCommitsTab({}, { testApiRef });
    await waitFor(() => expect(testApiRef.current?.loadCommitDetails).toBeTypeOf('function'));
    await act(async () => {
      await testApiRef.current.loadCommitDetails('missing-sha');
    });

    await waitFor(() => {
      expect(screen.getByText('Failed to load commit details')).toBeInTheDocument();
    });
  });

  test('loadCommitDetails clears loading indicator once fetch resolves for newly selected commit', async () => {
    const detailResolution = {};
    const pendingDetail = new Promise((resolve) => {
      detailResolution.resolve = resolve;
    });

    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } })
      .mockImplementationOnce(() => pendingDetail);

    const user = userEvent.setup();
    await renderCommitsTab();

    await waitFor(() => expect(screen.getByTestId('commit-files-list')).toBeInTheDocument());

    await user.click(screen.getByTestId('commit-abc1234'));

    await waitFor(() => {
      expect(screen.getByTestId('commit-details-loading')).toBeInTheDocument();
    });

    detailResolution.resolve({
      data: { success: true, commit: buildCommitDetail(baseCommits[1]) }
    });

    await waitFor(() => {
      expect(screen.queryByTestId('commit-details-loading')).not.toBeInTheDocument();
    });
  });

  test('loadCommitDetails keeps latest loading state when earlier request resolves second', async () => {
    const extraCommit = {
      sha: 'xyz999988877',
      shortSha: 'xyz9999',
      message: 'Docs update',
      author: { name: 'Demo Dev' },
      authoredAt: '2025-01-07T12:00:00Z',
      canRevert: true
    };
    const commitsResponse = [...baseCommits, extraCommit];
    const createDeferred = () => {
      let resolve;
      const promise = new Promise((res) => {
        resolve = res;
      });
      return { promise, resolve };
    };
    const firstDetail = createDeferred();
    const secondDetail = createDeferred();

    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: commitsResponse } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(commitsResponse[0]) } })
      .mockImplementationOnce(() => firstDetail.promise)
      .mockImplementationOnce(() => secondDetail.promise)
      .mockImplementationOnce(() => secondDetail.promise);

    const user = userEvent.setup();
    await renderCommitsTab();

    await waitFor(() => expect(screen.getByTestId('commit-files-list')).toBeInTheDocument());

    await user.click(screen.getByTestId('commit-abc1234'));
    await waitFor(() => expect(screen.getByTestId('commit-details-loading')).toBeInTheDocument());

    await user.click(screen.getByTestId('commit-xyz9999'));
    await waitFor(() => expect(screen.getByTestId('commit-details-loading')).toBeInTheDocument());

    firstDetail.resolve({ data: { success: true, commit: buildCommitDetail(commitsResponse[1]) } });

    await waitFor(() => {
      expect(screen.getByTestId('commit-details-loading')).toBeInTheDocument();
    });

    secondDetail.resolve({ data: { success: true, commit: buildCommitDetail(extraCommit) } });

    await waitFor(() => {
      expect(screen.queryByTestId('commit-details-loading')).not.toBeInTheDocument();
    });
  });

  test('surfaces errors when commit detail fetch fails', async () => {
    const detailError = new Error('detail exploded');
    detailError.response = { data: { error: 'No details' } };
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockRejectedValueOnce(detailError);

    await renderCommitsTab();

    await waitFor(() => {
      expect(screen.getByText('No details')).toBeInTheDocument();
    });
  });

  test('prevents duplicate revert requests when one is pending', async () => {
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    let resolveRevert;
    const revertPromise = new Promise((resolve) => {
      resolveRevert = resolve;
    });
    axios.post.mockReturnValueOnce(revertPromise);

    const user = userEvent.setup();
    await renderCommitsTab();

    const revertButton = await screen.findByTestId('commit-revert');
    await user.click(revertButton);

    await waitFor(() => {
      expect(screen.getByTestId('modal-content')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('modal-confirm'));

    await waitFor(() => {
      expect(screen.getByTestId('modal-confirm')).toBeDisabled();
    });

    expect(axios.post).toHaveBeenCalledTimes(1);

    resolveRevert({ data: { success: true, commits: baseCommits } });
    await waitFor(() => expect(screen.getByText('Reverted def9876')).toBeInTheDocument());
  });

  test('handleRevertCommit exits immediately when revertingSha already matches', async () => {
    const testApiRef = { current: null };
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    await renderCommitsTab({}, { testApiRef, testInitialState: { revertingSha: baseCommits[0].sha } });
    await waitFor(() => expect(testApiRef.current?.handleRevertCommit).toBeTypeOf('function'));

    await act(async () => {
      await testApiRef.current.handleRevertCommit(baseCommits[0].sha);
    });

    expect(axios.post).not.toHaveBeenCalled();
  });

  test('does not attempt revert when commit cannot be reverted', async () => {
    const testApiRef = { current: null };
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    await renderCommitsTab({}, { testApiRef });
    await waitFor(() => expect(testApiRef.current?.handleRevertCommit).toBeTypeOf('function'));
    await waitFor(() => expect(screen.getByTestId('commit-abc1234')).toBeInTheDocument());

    await act(async () => {
      await testApiRef.current.handleRevertCommit(baseCommits[1].sha);
    });

    expect(axios.post).not.toHaveBeenCalled();
  });

  test('shows server error when revert endpoint indicates failure', async () => {
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });
    axios.post.mockResolvedValueOnce({ data: { success: false, error: 'No revert' } });

    const user = userEvent.setup();
    await renderCommitsTab();

    const revertButton = await screen.findByTestId('commit-revert');
    await user.click(revertButton);

    await waitFor(() => {
      expect(screen.getByTestId('modal-content')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('modal-confirm'));

    await waitFor(() => {
      expect(screen.getByText('No revert')).toBeInTheDocument();
    });
  });

  test('handleRevertCommit test API applies commits when response omits replacements', async () => {
    const testApiRef = { current: null };
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });
    axios.post.mockResolvedValueOnce({ data: { success: true } });

    await renderCommitsTab({}, { testApiRef });
    await waitFor(() => expect(testApiRef.current?.handleRevertCommit).toBeTypeOf('function'));

    await act(async () => {
      await testApiRef.current.handleRevertCommit(baseCommits[0].sha);
    });

    await waitFor(() => {
      expect(screen.getByText('Reverted def9876')).toBeInTheDocument();
    });
  });

  test('handleRevertCommit test API surfaces fallback error text for API response', async () => {
    const testApiRef = { current: null };
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });
    axios.post.mockResolvedValueOnce({ data: { success: false } });

    await renderCommitsTab({}, { testApiRef });
    await waitFor(() => expect(testApiRef.current?.handleRevertCommit).toBeTypeOf('function'));

    await act(async () => {
      await testApiRef.current.handleRevertCommit(baseCommits[0].sha);
    });

    await waitFor(() => {
      expect(screen.getByText('Failed to revert commit')).toBeInTheDocument();
    });
  });

  test('handleRevertCommit test API surfaces fallback error text for network failure', async () => {
    const testApiRef = { current: null };
    const revertError = new Error('Network exploded');
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });
    axios.post.mockRejectedValueOnce(revertError);

    await renderCommitsTab({}, { testApiRef });
    await waitFor(() => expect(testApiRef.current?.handleRevertCommit).toBeTypeOf('function'));

    await act(async () => {
      await testApiRef.current.handleRevertCommit(baseCommits[0].sha);
    });

    await waitFor(() => {
      expect(screen.getByText('Failed to revert commit')).toBeInTheDocument();
    });
  });

  test('handleOpenFileFromCommit ignores empty file paths via test API', async () => {
    const testApiRef = { current: null };
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    await renderCommitsTab({}, { testApiRef });
    await waitFor(() => expect(testApiRef.current?.handleOpenFileFromCommit).toBeTypeOf('function'));

    await act(async () => {
      testApiRef.current.handleOpenFileFromCommit('');
    });

    expect(mockRequestEditorFocus).not.toHaveBeenCalled();
  });

  test('shows loading indicator while commit details are pending', async () => {
    let resolveDetails;
    const pendingDetails = new Promise((resolve) => {
      resolveDetails = resolve;
    });

    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockReturnValueOnce(pendingDetails);

    await renderCommitsTab();

    await waitFor(() => {
      expect(screen.getByTestId('commit-details-loading')).toBeInTheDocument();
    });

    resolveDetails({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    await waitFor(() => {
      expect(screen.queryByTestId('commit-details-loading')).toBeNull();
    });
  });

  test('handleCommitStagedChanges guard returns when project id is missing', async () => {
    const testApiRef = { current: null };
    await renderCommitsTab({ project: { name: 'No id project' } }, { testApiRef, skipFetchWait: true });
    await waitFor(() => expect(testApiRef.current?.handleCommitStagedChanges).toBeTypeOf('function'));

    await act(async () => {
      await testApiRef.current.handleCommitStagedChanges();
    });

    expect(axios.post).not.toHaveBeenCalled();
  });

  test('handleCommitStagedChanges guard returns when active branch name is missing', async () => {
    const testApiRef = { current: null };

    workingBranchesValue = {
      [mockProject.id]: null
    };

    axios.get.mockResolvedValueOnce({ data: { success: true, commits: [] } });

    await renderCommitsTab({}, { testApiRef });
    await waitFor(() => expect(testApiRef.current?.handleCommitStagedChanges).toBeTypeOf('function'));

    await act(async () => {
      await testApiRef.current.handleCommitStagedChanges();
    });

    expect(axios.post).not.toHaveBeenCalled();
  });

  test('handleCommitStagedChanges guard returns when commit is not allowed', async () => {
    const testApiRef = { current: null };

    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature-login',
        stagedFiles: [{ path: 'src/App.jsx', source: 'editor', timestamp: '2025-01-01T10:00:00.000Z' }]
      }
    };

    axios.get.mockResolvedValueOnce({ data: { success: true, commits: [] } });

    await renderCommitsTab({}, { testApiRef });
    await waitFor(() => expect(testApiRef.current?.handleCommitStagedChanges).toBeTypeOf('function'));

    await act(async () => {
      await testApiRef.current.handleCommitStagedChanges();
    });

    expect(axios.post).not.toHaveBeenCalled();
  });

  test('hides commit composer when there are no staged files', async () => {
    workingBranchesValue = {
      [mockProject.id]: { name: 'feature-login', lastTestStatus: 'passed', stagedFiles: [] }
    };

    axios.get.mockResolvedValueOnce({ data: { success: true, commits: [] } });

    await renderCommitsTab();

    expect(screen.queryByTestId('branch-commit-submit')).not.toBeInTheDocument();
    expect(screen.queryByTestId('branch-commit-hint')).not.toBeInTheDocument();
    expect(await screen.findByTestId('commit-no-selection')).toBeInTheDocument();
  });

  test('commit composer posts to commit endpoint and refreshes', async () => {
    const newCommit = {
      sha: 'fed111122223333',
      shortSha: 'fed1111',
      message: 'feat: tidy login flows',
      author: { name: 'Demo Dev' },
      authoredAt: '2025-01-07T10:00:00Z',
      canRevert: true
    };

    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature-login',
        status: 'ready-for-merge',
        lastTestStatus: 'passed',
        stagedFiles: [{ path: 'src/App.jsx', source: 'editor', timestamp: '2025-01-01T10:00:00.000Z' }]
      }
    };

    syncBranchOverviewValue = vi.fn(() => {
      workingBranchesValue = {
        [mockProject.id]: {
          name: 'feature-login',
          status: 'ready-for-merge',
          lastTestStatus: 'passed',
          stagedFiles: []
        }
      };
    });

    let commitsFetchCount = 0;
    axios.get.mockImplementation((url) => {
      if (url === `/api/projects/${mockProject.id}/commits`) {
        commitsFetchCount += 1;
        return Promise.resolve({
          data: {
            success: true,
            commits: commitsFetchCount === 1 ? baseCommits : [newCommit, ...baseCommits]
          }
        });
      }

      if (url.startsWith(`/api/projects/${mockProject.id}/commits/`)) {
        const sha = decodeURIComponent(url.split('/').pop() || '');
        const commit = sha === newCommit.sha ? newCommit : baseCommits[0];
        return Promise.resolve({ data: { success: true, commit: buildCommitDetail(commit) } });
      }

      return Promise.resolve({ data: { success: true } });
    });

    axios.post.mockResolvedValueOnce({
      data: {
        success: true,
        overview: { branches: [], current: 'feature-login', workingBranches: [] }
      }
    });

    const user = userEvent.setup();
    await renderCommitsTab();

    const commitButton = await screen.findByTestId('branch-commit-submit');
    expect(commitButton).toBeDisabled();

    await user.type(screen.getByTestId('branch-commit-subject'), 'feat: tidy login flows');
    await user.type(screen.getByTestId('branch-commit-input'), 'Explain why this change matters.');
    expect(commitButton).toBeEnabled();

    await user.click(commitButton);

    await waitFor(() => {
      expect(axios.post).toHaveBeenCalledWith(
        `/api/projects/${mockProject.id}/branches/feature-login/commit`,
        { message: 'feat: tidy login flows\n\nExplain why this change matters.' }
      );
      expect(syncBranchOverviewValue).toHaveBeenCalled();
      expect(screen.getByText('Committed staged changes')).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByTestId('commit-fed1111')).toHaveClass('selected');
    });

    expect(screen.queryByTestId('branch-commit-subject')).not.toBeInTheDocument();
  });

  test('does not show merge/test gate banners when simply viewing history with merge blocked', async () => {
    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature-login',
        status: 'needs-fix',
        lastTestStatus: null,
        testsRequired: true,
        stagedFiles: []
      }
    };

    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    await renderCommitsTab();

    expect(screen.queryByTestId('commit-gate-status')).not.toBeInTheDocument();
    expect(screen.queryByTestId('commit-merge-blocked')).not.toBeInTheDocument();
  });

  test('commit composer surfaces inline error when commit request fails', async () => {
    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature-login',
        status: 'ready-for-merge',
        lastTestStatus: 'passed',
        stagedFiles: [{ path: 'src/App.jsx', source: 'editor', timestamp: '2025-01-01T10:00:00.000Z' }]
      }
    };

    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: [] } })
      .mockResolvedValueOnce({ data: { success: true, commits: [] } });

    const error = new Error('Commit failed');
    error.response = { data: { error: 'Unable to commit' } };
    axios.post.mockRejectedValueOnce(error);

    const user = userEvent.setup();
    await renderCommitsTab();

    await user.type(screen.getByTestId('branch-commit-subject'), 'fix: handle edge case');
    await user.click(screen.getByTestId('branch-commit-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('branch-commit-error')).toHaveTextContent('Unable to commit');
    });
  });

  test('commit composer falls back to default error when commit request fails without response', async () => {
    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature-login',
        status: 'ready-for-merge',
        lastTestStatus: 'passed',
        stagedFiles: [{ path: 'src/App.jsx', source: 'editor', timestamp: '2025-01-01T10:00:00.000Z' }]
      }
    };

    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: [] } })
      .mockResolvedValueOnce({ data: { success: true, commits: [] } });

    axios.post.mockRejectedValueOnce(new Error('Commit exploded'));

    const user = userEvent.setup();
    await renderCommitsTab();

    await user.type(screen.getByTestId('branch-commit-subject'), 'fix: handle network edge case');
    await user.click(screen.getByTestId('branch-commit-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('branch-commit-error')).toHaveTextContent('Failed to commit staged changes');
    });
  });

  test('commit composer auto-generates a message when LLM is configured and draft is empty', async () => {
    isLLMConfiguredValue = true;
    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature-login',
        status: 'ready-for-merge',
        lastTestStatus: 'passed',
        stagedFiles: [{ path: 'src/App.jsx', status: 'M' }]
      }
    };

    let resolveContext;
    const pendingContext = new Promise((resolve) => {
      resolveContext = resolve;
    });

    axios.get.mockImplementation((url) => {
      if (url === `/api/projects/${mockProject.id}/commits`) {
        return Promise.resolve({ data: { success: true, commits: [] } });
      }
      if (url === `/api/projects/${mockProject.id}/branches/feature-login/commit-context`) {
        return pendingContext;
      }
      return Promise.resolve({ data: { success: true } });
    });

    axios.post.mockImplementation((url) => {
      if (url === '/api/llm/generate') {
        return Promise.resolve({
          data: {
            response: {
              choices: [
                {
                  message: {
                    content: 'feat: generate commit message'
                  }
                }
              ]
            }
          }
        });
      }
      return Promise.resolve({ data: { success: true } });
    });

    await renderCommitsTab({
      autofillRequestId: 1,
      onConsumeAutofillRequest: vi.fn()
    });

    await waitFor(() => {
      expect(axios.get).toHaveBeenCalledWith(
        `/api/projects/${mockProject.id}/branches/feature-login/commit-context`
      );
    });

    resolveContext({
      data: {
        success: true,
        context: {
          branch: 'feature-login',
          totalFiles: 1,
          files: [],
          summaryText: '1. src/App.jsx',
          aggregateDiff: '',
          truncated: false,
          isGitAvailable: true
        }
      }
    });

    await waitFor(() => {
      expect(screen.getByTestId('branch-commit-subject')).toHaveValue('feat: generate commit message');
    });
  });

  test('handleManualAutofill exits immediately when LLM is not configured via test API', async () => {
    isLLMConfiguredValue = false;
    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature-login',
        status: 'ready-for-merge',
        lastTestStatus: 'passed',
        stagedFiles: [{ path: 'src/App.jsx', status: 'M' }]
      }
    };

    axios.get.mockResolvedValueOnce({ data: { success: true, commits: [] } });

    const testApiRef = { current: null };
    await renderCommitsTab({}, { testApiRef });

    const initialHandler = testApiRef.current.handleManualAutofill;

    await act(async () => {
      await initialHandler();
    });

    expect(axios.post).not.toHaveBeenCalled();
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(axios.get).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/commits`);
  });

  test('handleManualAutofill avoids duplicate requests when generation is in progress via test API', async () => {
    isLLMConfiguredValue = true;
    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature-login',
        status: 'ready-for-merge',
        lastTestStatus: 'passed',
        stagedFiles: [{ path: 'src/App.jsx', status: 'M' }]
      }
    };

    let resolveContext;
    const pendingContext = new Promise((resolve) => {
      resolveContext = resolve;
    });

    axios.get.mockImplementation((url) => {
      if (url === `/api/projects/${mockProject.id}/commits`) {
        return Promise.resolve({ data: { success: true, commits: [] } });
      }
      if (url === `/api/projects/${mockProject.id}/branches/feature-login/commit-context`) {
        return pendingContext;
      }
      return Promise.resolve({ data: { success: true } });
    });

    axios.post.mockImplementation((url) => {
      if (url === '/api/llm/generate') {
        return Promise.resolve({
          data: {
            response: {
              choices: [
                {
                  message: {
                    content: 'feat: generate commit message'
                  }
                }
              ]
            }
          }
        });
      }
      return Promise.resolve({ data: { success: true } });
    });

    const testApiRef = { current: null };
    await renderCommitsTab({}, { testApiRef });

    const initialHandler = testApiRef.current.handleManualAutofill;

    await act(async () => {
      await initialHandler();
    });

    await waitFor(() => {
      expect(axios.get).toHaveBeenCalledWith(
        `/api/projects/${mockProject.id}/branches/feature-login/commit-context`
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('branch-commit-autofill')).toHaveTextContent('Autofilling…');
    });

    await waitFor(() => {
      expect(testApiRef.current.handleManualAutofill).not.toBe(initialHandler);
    });

    await act(async () => {
      await testApiRef.current.handleManualAutofill();
    });

    expect(
      axios.get.mock.calls.filter(
        ([url]) => url === `/api/projects/${mockProject.id}/branches/feature-login/commit-context`
      )
    ).toHaveLength(1);

    resolveContext({
      data: {
        success: true,
        context: {
          branch: 'feature-login',
          totalFiles: 1,
          files: [],
          summaryText: '1. src/App.jsx',
          aggregateDiff: '',
          truncated: false,
          isGitAvailable: true
        }
      }
    });

    await waitFor(() => {
      expect(screen.getByTestId('branch-commit-subject')).toHaveValue('feat: generate commit message');
    });
  });

  test('shows merge CTA when branch is ready-for-merge and merges into main', async () => {
    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature-login',
        status: 'ready-for-merge',
        lastTestStatus: 'passed',
        stagedFiles: []
      }
    };

    axios.get.mockImplementation((url) => {
      if (url === `/api/projects/${mockProject.id}/commits`) {
        return Promise.resolve({ data: { success: true, commits: baseCommits } });
      }
      if (url.startsWith(`/api/projects/${mockProject.id}/commits/`)) {
        return Promise.resolve({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });
      }
      return Promise.resolve({ data: { success: true } });
    });

    axios.post.mockResolvedValueOnce({
      data: {
        success: true,
        overview: { branches: [], current: 'feature-login', workingBranches: [] }
      }
    });

    const user = userEvent.setup();
    await renderCommitsTab();

    const mergeButton = await screen.findByTestId('commit-merge');
    expect(mergeButton).toBeEnabled();

    await user.click(mergeButton);

    await waitFor(() => {
      expect(axios.post).toHaveBeenCalledWith(
        `/api/projects/${mockProject.id}/branches/feature-login/merge`
      );
      expect(syncBranchOverviewValue).toHaveBeenCalled();
      expect(screen.getByText('Merged branch into main')).toBeInTheDocument();
    });
  });

  test('handleMergeBranch exits immediately when prerequisites are missing via test API', async () => {
    const testApiRef = { current: null };
    await renderCommitsTab({ project: null }, { testApiRef, skipFetchWait: true });

    await act(async () => {
      await testApiRef.current.handleMergeBranch();
    });

    expect(axios.post).not.toHaveBeenCalled();
  });

  test('shows merge CTA for CSS-only branches when tests are optional', async () => {
    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature-login',
        status: 'ready-for-merge',
        lastTestStatus: null,
        testsRequired: false,
        stagedFiles: []
      }
    };

    axios.get.mockImplementation((url) => {
      if (url === `/api/projects/${mockProject.id}/commits`) {
        return Promise.resolve({ data: { success: true, commits: baseCommits } });
      }
      if (url.startsWith(`/api/projects/${mockProject.id}/commits/`)) {
        return Promise.resolve({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });
      }
      return Promise.resolve({ data: { success: true } });
    });

    axios.post.mockResolvedValueOnce({
      data: {
        success: true,
        overview: { branches: [], current: 'feature-login', workingBranches: [] }
      }
    });

    const user = userEvent.setup();
    await renderCommitsTab();

    expect(await screen.findByText('CSS-only (tests optional)')).toBeInTheDocument();

    const mergeButton = await screen.findByTestId('commit-merge');
    expect(mergeButton).toBeEnabled();

    await user.click(mergeButton);

    await waitFor(() => {
      expect(axios.post).toHaveBeenCalledWith(
        `/api/projects/${mockProject.id}/branches/feature-login/merge`
      );
    });
  });

  test('shows merge errors in the details panel when merge fails', async () => {
    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature-login',
        status: 'ready-for-merge',
        lastTestStatus: 'passed',
        stagedFiles: []
      }
    };

    axios.get.mockImplementation((url) => {
      if (url === `/api/projects/${mockProject.id}/commits`) {
        return Promise.resolve({ data: { success: true, commits: baseCommits } });
      }
      if (url.startsWith(`/api/projects/${mockProject.id}/commits/`)) {
        return Promise.resolve({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });
      }
      return Promise.resolve({ data: { success: true } });
    });

    const mergeError = new Error('Merge failed');
    mergeError.response = { data: { error: 'Cannot merge right now' } };
    axios.post.mockRejectedValueOnce(mergeError);

    const user = userEvent.setup();
    await renderCommitsTab();

    await user.click(await screen.findByTestId('commit-merge'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot merge right now');
  });

  test('falls back to default error when merge request fails without response', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature-login',
        status: 'ready-for-merge',
        lastTestStatus: 'passed',
        stagedFiles: []
      }
    };

    axios.get.mockImplementation((url) => {
      if (url === `/api/projects/${mockProject.id}/commits`) {
        return Promise.resolve({ data: { success: true, commits: baseCommits } });
      }
      if (url.startsWith(`/api/projects/${mockProject.id}/commits/`)) {
        return Promise.resolve({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });
      }
      return Promise.resolve({ data: { success: true } });
    });

    axios.post.mockRejectedValueOnce(new Error('Merge exploded'));

    const user = userEvent.setup();
    await renderCommitsTab();

    await user.click(await screen.findByTestId('commit-merge'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to merge branch');
    consoleError.mockRestore();
  });

  test('hides merge-blocked banner when commit composer is shown (staged changes present)', async () => {
    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature-login',
        status: 'ready-for-merge',
        lastTestStatus: 'passed',
        stagedFiles: [{ path: 'src/login.tsx', source: 'editor', timestamp: '2025-01-01T10:00:00.000Z' }]
      }
    };

    axios.get.mockImplementation((url) => {
      if (url === `/api/projects/${mockProject.id}/commits`) {
        return Promise.resolve({ data: { success: true, commits: baseCommits } });
      }
      if (url.startsWith(`/api/projects/${mockProject.id}/commits/`)) {
        return Promise.resolve({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });
      }
      return Promise.resolve({ data: { success: true } });
    });

    await renderCommitsTab();

    expect(await screen.findByTestId('branch-commit-subject')).toBeInTheDocument();
    expect(screen.queryByTestId('commit-merge-blocked')).not.toBeInTheDocument();
  });

  test('surfaces tests, coverage, and merge gate status', async () => {
    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature-login',
        status: 'active',
        lastTestStatus: null,
        testsRequired: false,
        mergeBlockedReason: null,
        lastTestSummary: {
          coverage: {
            totals: {
              lines: { pct: 95 }
            },
            thresholds: {
              lines: 90
            }
          }
        },
        stagedFiles: [{ path: 'src/App.jsx', source: 'editor', timestamp: '2025-01-01T12:00:00.000Z' }]
      }
    };

    axios.get.mockImplementation((url) => {
      if (url === `/api/projects/${mockProject.id}/commits`) {
        return Promise.resolve({ data: { success: true, commits: baseCommits } });
      }
      if (url.startsWith(`/api/projects/${mockProject.id}/commits/`)) {
        return Promise.resolve({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });
      }
      return Promise.resolve({ data: { success: true } });
    });

    await renderCommitsTab();

    expect(await screen.findByTestId('commit-gate-status')).toBeInTheDocument();
    expect(screen.getByTestId('commit-gate-tests')).toHaveTextContent('Tests: Optional');
    expect(screen.getByTestId('commit-gate-coverage')).toHaveTextContent('Coverage: 95% / 90%');
    expect(screen.getByTestId('commit-gate-merge')).toHaveTextContent('Merge: Blocked (Commit staged changes before merging)');
  });

  test('gate status coverage label shows Unknown when pct is missing', async () => {
    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature-login',
        status: 'active',
        lastTestStatus: null,
        testsRequired: false,
        mergeBlockedReason: null,
        lastTestSummary: {
          coverage: {
            totals: {
              lines: {}
            },
            thresholds: {
              lines: 90
            }
          }
        },
        stagedFiles: [{ path: 'src/App.jsx', source: 'editor', timestamp: '2025-01-01T12:00:00.000Z' }]
      }
    };

    axios.get.mockImplementation((url) => {
      if (url === `/api/projects/${mockProject.id}/commits`) {
        return Promise.resolve({ data: { success: true, commits: baseCommits } });
      }
      if (url.startsWith(`/api/projects/${mockProject.id}/commits/`)) {
        return Promise.resolve({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });
      }
      return Promise.resolve({ data: { success: true } });
    });

    await renderCommitsTab();

    expect(await screen.findByTestId('commit-gate-coverage')).toHaveTextContent('Coverage: Unknown / 90%');
  });

  test('gate status coverage label shows Unknown when required threshold is missing', async () => {
    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature-login',
        status: 'active',
        lastTestStatus: null,
        testsRequired: false,
        mergeBlockedReason: null,
        lastTestSummary: {
          coverage: {
            totals: {
              lines: { pct: 95 }
            },
            thresholds: {
              lines: undefined
            }
          }
        },
        stagedFiles: [{ path: 'src/App.jsx', source: 'editor', timestamp: '2025-01-01T12:00:00.000Z' }]
      }
    };

    axios.get.mockImplementation((url) => {
      if (url === `/api/projects/${mockProject.id}/commits`) {
        return Promise.resolve({ data: { success: true, commits: baseCommits } });
      }
      if (url.startsWith(`/api/projects/${mockProject.id}/commits/`)) {
        return Promise.resolve({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });
      }
      return Promise.resolve({ data: { success: true } });
    });

    await renderCommitsTab();

    expect(await screen.findByTestId('commit-gate-coverage')).toHaveTextContent('Coverage: 95% / Unknown');
  });

  test('gate status coverage label shows Unknown when summary is missing but tests are required', async () => {
    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature-missing-summary',
        status: 'ready-for-merge',
        lastTestStatus: 'passed',
        testsRequired: true,
        mergeBlockedReason: null,
        stagedFiles: [{ path: 'src/App.jsx', source: 'editor', timestamp: '2025-01-01T12:00:00.000Z' }]
      }
    };

    axios.get.mockImplementation((url) => {
      if (url === `/api/projects/${mockProject.id}/commits`) {
        return Promise.resolve({ data: { success: true, commits: baseCommits } });
      }
      if (url.startsWith(`/api/projects/${mockProject.id}/commits/`)) {
        return Promise.resolve({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });
      }
      return Promise.resolve({ data: { success: true } });
    });

    await renderCommitsTab();

    // When a branch is ready-to-commit, CommitsTab selects the pending commit by default.
    // Select a real commit to exit the composer state so gate banners can render.
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('commit-abc1234'));

    expect(await screen.findByTestId('commit-gate-coverage')).toHaveTextContent('Coverage: Unknown');
  });

  test('gate status shows Coverage optional when tests are optional and no summary is available', async () => {
    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature-login',
        status: 'active',
        lastTestStatus: null,
        testsRequired: false,
        mergeBlockedReason: null,
        stagedFiles: [{ path: 'src/App.jsx', source: 'editor', timestamp: '2025-01-01T12:00:00.000Z' }]
      }
    };

    axios.get.mockImplementation((url) => {
      if (url === `/api/projects/${mockProject.id}/commits`) {
        return Promise.resolve({ data: { success: true, commits: baseCommits } });
      }
      if (url.startsWith(`/api/projects/${mockProject.id}/commits/`)) {
        return Promise.resolve({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });
      }
      return Promise.resolve({ data: { success: true } });
    });

    await renderCommitsTab();

    expect(await screen.findByTestId('commit-gate-coverage')).toHaveTextContent('Coverage: Optional');
  });

  test('shows testing CTA when the last run failed', async () => {
    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature-tests-failed',
        status: 'needs-fix',
        lastTestStatus: 'failed',
        testsRequired: true,
        stagedFiles: [{ path: 'src/App.jsx', source: 'editor', timestamp: '2025-01-01T12:00:00.000Z' }]
      }
    };

    axios.get.mockImplementation((url) => {
      if (url === `/api/projects/${mockProject.id}/commits`) {
        return Promise.resolve({ data: { success: true, commits: baseCommits } });
      }
      if (url.startsWith(`/api/projects/${mockProject.id}/commits/`)) {
        return Promise.resolve({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });
      }
      return Promise.resolve({ data: { success: true } });
    });

    await renderCommitsTab();

    expect(await screen.findByTestId('commit-tests-required')).toBeInTheDocument();
    expect(screen.queryByTestId('commit-gate-status')).toBeNull();
  });

  test('shows a single testing CTA when no test results are available', async () => {
    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature-tests-pending',
        status: 'needs-fix',
        lastTestStatus: null,
        testsRequired: true,
        stagedFiles: [{ path: 'src/App.jsx', source: 'editor', timestamp: '2025-01-01T12:00:00.000Z' }]
      }
    };

    axios.get.mockImplementation((url) => {
      if (url === `/api/projects/${mockProject.id}/commits`) {
        return Promise.resolve({ data: { success: true, commits: baseCommits } });
      }
      if (url.startsWith(`/api/projects/${mockProject.id}/commits/`)) {
        return Promise.resolve({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });
      }
      return Promise.resolve({ data: { success: true } });
    });

    const onRequestTestsTab = vi.fn();
    const user = userEvent.setup();
    await renderCommitsTab({ onRequestTestsTab });

    expect(await screen.findByTestId('commit-tests-required')).toBeInTheDocument();
    expect(screen.queryByTestId('commit-gate-status')).toBeNull();
    expect(screen.queryByTestId('commit-merge-blocked')).toBeNull();

    await user.click(screen.getByTestId('commit-start-tests'));
    expect(onRequestTestsTab).toHaveBeenCalledWith({
      autoRun: true,
      source: 'automation',
      returnToCommits: true
    });
  });

  test('testing CTA no-ops when no handler is provided', async () => {
    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature-tests-pending',
        status: 'needs-fix',
        lastTestStatus: null,
        testsRequired: true,
        stagedFiles: [{ path: 'src/App.jsx', source: 'editor', timestamp: '2025-01-01T12:00:00.000Z' }]
      }
    };

    axios.get.mockImplementation((url) => {
      if (url === `/api/projects/${mockProject.id}/commits`) {
        return Promise.resolve({ data: { success: true, commits: baseCommits } });
      }
      if (url.startsWith(`/api/projects/${mockProject.id}/commits/`)) {
        return Promise.resolve({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });
      }
      return Promise.resolve({ data: { success: true } });
    });

    const user = userEvent.setup();
    await renderCommitsTab();

    const startButton = await screen.findByTestId('commit-start-tests');
    expect(startButton).toBeEnabled();
    await user.click(startButton);
  });

  test('gate status shows Tests optional when requirements are disabled without CSS-only changes', async () => {
    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature-optional-tests',
        status: 'ready-for-merge',
        lastTestStatus: null,
        testsRequired: false,
        mergeBlockedReason: null,
        stagedFiles: [{ path: 'src/components/App.jsx', source: 'editor', timestamp: '2025-01-01T12:00:00.000Z' }]
      }
    };

    axios.get.mockImplementation((url) => {
      if (url === `/api/projects/${mockProject.id}/commits`) {
        return Promise.resolve({ data: { success: true, commits: baseCommits } });
      }
      if (url.startsWith(`/api/projects/${mockProject.id}/commits/`)) {
        return Promise.resolve({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });
      }
      return Promise.resolve({ data: { success: true } });
    });

    await renderCommitsTab();

    expect(await screen.findByTestId('commit-gate-tests')).toHaveTextContent('Tests: Optional');
  });

  test('hides gate status + merge blocker banners when commit composer is shown for CSS-only staged changes', async () => {
    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature-css-only',
        status: 'needs-fix',
        lastTestStatus: null,
        testsRequired: true,
        stagedFiles: [{ path: 'src/styles/global.css', source: 'editor', timestamp: '2025-01-01T12:00:00.000Z' }]
      }
    };

    axios.get.mockImplementation((url) => {
      if (url === `/api/projects/${mockProject.id}/commits`) {
        return Promise.resolve({ data: { success: true, commits: baseCommits } });
      }
      if (url.startsWith(`/api/projects/${mockProject.id}/commits/`)) {
        return Promise.resolve({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });
      }
      return Promise.resolve({ data: { success: true } });
    });

    await renderCommitsTab();

    // Commit composer should be visible in the pending state.
    expect(await screen.findByTestId('branch-commit-subject')).toBeInTheDocument();

    // Gate banners are redundant once the commit UI is visible.
    expect(screen.queryByTestId('commit-gate-tests')).not.toBeInTheDocument();
    expect(screen.queryByTestId('commit-gate-coverage')).not.toBeInTheDocument();
    expect(screen.queryByTestId('commit-gate-merge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('commit-merge-blocked')).not.toBeInTheDocument();
  });

  test('merge gate falls back to generic blocked copy when blocker text is unavailable', async () => {
    const describeSpy = vi.spyOn(branchTabUtils, 'describeMergeBlocker').mockReturnValue(null);

    try {
      workingBranchesValue = {
        [mockProject.id]: {
          name: 'feature-missing-blocker',
          status: 'ready-for-merge',
          lastTestStatus: 'passed',
          testsRequired: true,
          mergeBlockedReason: null,
          stagedFiles: [{ path: 'src/App.jsx', source: 'editor', timestamp: '2025-01-01T12:00:00.000Z' }]
        }
      };

      axios.get.mockImplementation((url) => {
        if (url === `/api/projects/${mockProject.id}/commits`) {
          return Promise.resolve({ data: { success: true, commits: baseCommits } });
        }
        if (url.startsWith(`/api/projects/${mockProject.id}/commits/`)) {
          return Promise.resolve({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });
        }
        return Promise.resolve({ data: { success: true } });
      });

      await renderCommitsTab();

      const user = userEvent.setup();
      await user.click(await screen.findByTestId('commit-abc1234'));

      expect(await screen.findByTestId('commit-gate-merge')).toHaveTextContent('Merge: Blocked');
      expect(screen.queryByTestId('commit-merge-blocked')).not.toBeInTheDocument();
    } finally {
      describeSpy.mockRestore();
    }
  });

  test('requestSquashSelectedCommits exits when project id is missing via test API', async () => {
    const testApiRef = { current: null };
    await renderCommitsTab({ project: { name: 'No project id' } }, { testApiRef, skipFetchWait: true });
    await waitFor(() => expect(testApiRef.current?.requestSquashSelectedCommits).toBeTypeOf('function'));

    await act(async () => {
      testApiRef.current.requestSquashSelectedCommits();
    });

    expect(axios.post).not.toHaveBeenCalled();
    expect(screen.queryByTestId('modal-content')).not.toBeInTheDocument();
    expect(screen.queryByTestId('commit-squash-error')).not.toBeInTheDocument();
  });

  test('requestSquashSelectedCommits shows error when fewer than two commits are selected via test API', async () => {
    const testApiRef = { current: null };
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    await renderCommitsTab({}, { testApiRef });
    await waitFor(() => expect(testApiRef.current?.requestSquashSelectedCommits).toBeTypeOf('function'));

    await act(async () => {
      testApiRef.current.toggleSquashSelection(baseCommits[0].sha);
    });

    await act(async () => {
      testApiRef.current.requestSquashSelectedCommits();
    });

    expect(await screen.findByTestId('commit-squash-error')).toHaveTextContent('Select exactly two commits');
    expect(screen.queryByTestId('modal-content')).not.toBeInTheDocument();
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('toggleSquashSelection ignores invalid shas via test API', async () => {
    const testApiRef = { current: null };
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    await renderCommitsTab({}, { testApiRef });
    await waitFor(() => expect(testApiRef.current?.toggleSquashSelection).toBeTypeOf('function'));

    await act(async () => {
      testApiRef.current.toggleSquashSelection(null);
      testApiRef.current.toggleSquashSelection('   ');
    });

    expect(screen.queryByTestId('commit-squash-bar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('commit-squash-error')).not.toBeInTheDocument();
  });

  test('toggleSquashSelection de-selects commits when toggled twice via test API', async () => {
    const testApiRef = { current: null };
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    await renderCommitsTab({}, { testApiRef });
    await waitFor(() => expect(testApiRef.current?.toggleSquashSelection).toBeTypeOf('function'));

    await act(async () => {
      testApiRef.current.toggleSquashSelection(baseCommits[0].sha);
    });

    expect(await screen.findByTestId('commit-squash-bar')).toBeInTheDocument();

    await act(async () => {
      testApiRef.current.toggleSquashSelection(baseCommits[0].sha);
    });

    expect(screen.queryByTestId('commit-squash-bar')).not.toBeInTheDocument();
  });

  test('keeps commits with missing shas when deduping', async () => {
    const commitsWithMissingSha = [
      ...baseCommits,
      {
        sha: '',
        shortSha: 'nosha',
        message: 'Mystery commit',
        author: { name: 'Demo Dev' },
        authoredAt: '2025-01-07T10:00:00Z',
        canRevert: false
      }
    ];

    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: commitsWithMissingSha } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    await renderCommitsTab();

    expect(await screen.findByTestId('commit-nosha')).toBeInTheDocument();
  });

  test('consumes autofill request id when callback is provided', async () => {
    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature-autofill',
        lastTestStatus: 'passed',
        stagedFiles: []
      }
    };

    const onConsumeAutofillRequest = vi.fn();
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    await renderCommitsTab({
      autofillRequestId: 'autofill-req-1',
      onConsumeAutofillRequest
    });

    await waitFor(() => expect(onConsumeAutofillRequest).toHaveBeenCalledWith('autofill-req-1'));
    expect(onConsumeAutofillRequest).toHaveBeenCalledTimes(1);
  });

  test('autofill request exits when active branch name is missing', async () => {
    const onConsumeAutofillRequest = vi.fn();
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    await renderCommitsTab({
      autofillRequestId: 'autofill-req-2',
      onConsumeAutofillRequest
    });

    await act(async () => {});
    expect(onConsumeAutofillRequest).not.toHaveBeenCalled();
  });

  test('handleSquashSelectedCommits surfaces server error when response is unsuccessful via test API', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const testApiRef = { current: null };
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    axios.post.mockResolvedValueOnce({
      data: {
        success: false,
        error: 'Cannot squash right now'
      }
    });

    await renderCommitsTab({}, { testApiRef });
    await waitFor(() => expect(testApiRef.current?.handleSquashSelectedCommits).toBeTypeOf('function'));

    await act(async () => {
      await testApiRef.current.handleSquashSelectedCommits({
        olderSha: baseCommits[1].sha,
        newerSha: baseCommits[0].sha
      });
    });

    expect(axios.post).toHaveBeenCalledWith(
      `/api/projects/${mockProject.id}/commits/squash`,
      { olderSha: baseCommits[1].sha, newerSha: baseCommits[0].sha }
    );
    expect(await screen.findByTestId('commit-squash-error')).toHaveTextContent('Cannot squash right now');
    consoleError.mockRestore();
  });

  test('handleSquashSelectedCommits falls back to default error when response lacks message via test API', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const testApiRef = { current: null };
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    axios.post.mockResolvedValueOnce({
      data: {
        success: false
      }
    });

    await renderCommitsTab({}, { testApiRef });
    await waitFor(() => expect(testApiRef.current?.handleSquashSelectedCommits).toBeTypeOf('function'));

    await act(async () => {
      await testApiRef.current.handleSquashSelectedCommits({
        olderSha: baseCommits[1].sha,
        newerSha: baseCommits[0].sha
      });
    });

    expect(await screen.findByTestId('commit-squash-error')).toHaveTextContent('Failed to squash commits');
    consoleError.mockRestore();
  });

  test('handleSquashSelectedCommits surfaces fallback error text for API response failures via test API', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const testApiRef = { current: null };
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    const err = new Error('Squash failed');
    err.response = { data: { error: 'Squash request failed' } };
    axios.post.mockRejectedValueOnce(err);

    await renderCommitsTab({}, { testApiRef });
    await waitFor(() => expect(testApiRef.current?.handleSquashSelectedCommits).toBeTypeOf('function'));

    await act(async () => {
      await testApiRef.current.handleSquashSelectedCommits({
        olderSha: baseCommits[1].sha,
        newerSha: baseCommits[0].sha
      });
    });

    expect(await screen.findByTestId('commit-squash-error')).toHaveTextContent('Squash request failed');
    consoleError.mockRestore();
  });

  test('handleSquashSelectedCommits falls back to default error text for network failures via test API', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const testApiRef = { current: null };
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    axios.post.mockRejectedValueOnce(new Error('Network down'));

    await renderCommitsTab({}, { testApiRef });
    await waitFor(() => expect(testApiRef.current?.handleSquashSelectedCommits).toBeTypeOf('function'));

    await act(async () => {
      await testApiRef.current.handleSquashSelectedCommits({
        olderSha: baseCommits[1].sha,
        newerSha: baseCommits[0].sha
      });
    });

    expect(await screen.findByTestId('commit-squash-error')).toHaveTextContent('Failed to squash commits');
    consoleError.mockRestore();
  });

  test('handleSquashSelectedCommits exits when project id is missing via test API', async () => {
    const testApiRef = { current: null };
    await renderCommitsTab({ project: { name: 'No project id' } }, { testApiRef, skipFetchWait: true });
    await waitFor(() => expect(testApiRef.current?.handleSquashSelectedCommits).toBeTypeOf('function'));

    await act(async () => {
      await testApiRef.current.handleSquashSelectedCommits({ olderSha: 'older', newerSha: 'newer' });
    });

    expect(axios.post).not.toHaveBeenCalled();
    expect(screen.queryByTestId('commit-squash-error')).not.toBeInTheDocument();
  });

  test('handleSquashSelectedCommits shows error when pair cannot be resolved via test API', async () => {
    const testApiRef = { current: null };
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    await renderCommitsTab({}, { testApiRef });
    await waitFor(() => expect(testApiRef.current?.handleSquashSelectedCommits).toBeTypeOf('function'));

    await act(async () => {
      await testApiRef.current.clearSquashSelection();
    });

    await act(async () => {
      await testApiRef.current.handleSquashSelectedCommits();
    });

    expect(await screen.findByTestId('commit-squash-error')).toHaveTextContent('Select exactly two commits to squash');
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('requestSquashSelectedCommits shows error when selection shas are missing from commits via test API', async () => {
    const testApiRef = { current: null };
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    await renderCommitsTab({}, { testApiRef });
    await waitFor(() => expect(testApiRef.current?.requestSquashSelectedCommits).toBeTypeOf('function'));

    await act(async () => {
      testApiRef.current.clearSquashSelection();
      testApiRef.current.toggleSquashSelection('missing-sha-1');
      testApiRef.current.toggleSquashSelection('missing-sha-2');
    });

    await act(async () => {
      testApiRef.current.requestSquashSelectedCommits();
    });

    expect(await screen.findByTestId('commit-squash-error')).toHaveTextContent('Select exactly two commits');
    expect(screen.queryByTestId('modal-content')).not.toBeInTheDocument();
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('keeps commits with non-string shas when deduping via test API', async () => {
    const testApiRef = { current: null };
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    await renderCommitsTab({}, { testApiRef });
    await waitFor(() => expect(testApiRef.current?.applyCommits).toBeTypeOf('function'));

    const weirdCommit = {
      ...baseCommits[0],
      sha: null,
      shortSha: 'weirdsha',
      message: 'Weird SHA commit'
    };

    await act(async () => {
      testApiRef.current.applyCommits([weirdCommit, ...baseCommits]);
    });

    expect(await screen.findByText('Weird SHA commit')).toBeInTheDocument();
  });

  test('uses workspace staged files when branch context stagedFiles is missing', async () => {
    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature-css',
        status: 'needs-fix',
        lastTestStatus: 'failed',
        stagedFiles: null
      }
    };
    workspaceChangesValue = {
      [mockProject.id]: {
        stagedFiles: [{ path: 'src/styles.css' }]
      }
    };

    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    await renderCommitsTab();

    expect(await screen.findByTestId('commit-pending')).toBeInTheDocument();
    expect(screen.getByTestId('commit-pending')).toHaveTextContent('1 staged file');
    expect(screen.getByTestId('commit-pending')).toHaveTextContent('CSS-only (tests optional)');
    expect(await screen.findByTestId('commit-pending-header')).toHaveTextContent('CSS-only (skip tests allowed)');
  });

  test('falls back to empty staged files when workspace stagedFiles is not an array', async () => {
    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature-no-staged',
        status: 'needs-fix',
        lastTestStatus: 'failed',
        stagedFiles: null
      }
    };
    workspaceChangesValue = {
      [mockProject.id]: {
        stagedFiles: 'not-an-array'
      }
    };

    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    await renderCommitsTab();

    expect(screen.queryByTestId('commit-pending')).not.toBeInTheDocument();
  });

  test('treats non-string file paths as not CSS-only', async () => {
    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature-weird-path',
        status: 'ready-for-merge',
        lastTestStatus: 'passed',
        stagedFiles: [{ path: 123 }]
      }
    };

    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    await renderCommitsTab();

    expect(await screen.findByTestId('commit-pending')).toHaveTextContent('Tests passed');
  });

  test('requestSquashSelectedCommits resolves newer/older even when selection order is reversed', async () => {
    const testApiRef = { current: null };
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    await renderCommitsTab({}, { testApiRef });
    await waitFor(() => expect(testApiRef.current?.requestSquashSelectedCommits).toBeTypeOf('function'));
    await screen.findByTestId('commit-def9876');

    await act(async () => {
      testApiRef.current.clearSquashSelection();
      testApiRef.current.toggleSquashSelection(baseCommits[1].sha);
      testApiRef.current.toggleSquashSelection(baseCommits[0].sha);
    });

    await waitFor(() => {
      expect(screen.getByTestId('commit-squash-bar')).toHaveTextContent('2 selected');
    });

    await act(async () => {
      testApiRef.current.requestSquashSelectedCommits();
    });

    expect(await screen.findByTestId('modal-content')).toBeInTheDocument();
    expect(screen.getByTestId('modal-content')).toHaveTextContent('Newer: def9876');
    expect(screen.getByTestId('modal-content')).toHaveTextContent('Older: abc1234');
  });

  test('requestSquashSelectedCommits falls back to sha slices when shortSha is blank', async () => {
    const testApiRef = { current: null };
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    await renderCommitsTab({}, { testApiRef });
    await waitFor(() => expect(testApiRef.current?.applyCommits).toBeTypeOf('function'));
    await screen.findByTestId('commit-def9876');

    const commitsWithBlankShortSha = baseCommits.map((commit) => ({
      ...commit,
      shortSha: ''
    }));

    await act(async () => {
      testApiRef.current.applyCommits(commitsWithBlankShortSha);
    });

    await act(async () => {
      testApiRef.current.clearSquashSelection();
      testApiRef.current.toggleSquashSelection(baseCommits[0].sha);
      testApiRef.current.toggleSquashSelection(baseCommits[1].sha);
    });

    await waitFor(() => {
      expect(screen.getByTestId('commit-squash-bar')).toHaveTextContent('2 selected');
    });

    await act(async () => {
      testApiRef.current.requestSquashSelectedCommits();
    });

    expect(await screen.findByTestId('modal-content')).toBeInTheDocument();
    expect(screen.getByTestId('modal-content')).toHaveTextContent('Newer: def9876');
    expect(screen.getByTestId('modal-content')).toHaveTextContent('Older: abc1234');
  });

  test('openConfirmModal falls back to empty title/message and drops non-function onConfirm', async () => {
    const testApiRef = { current: null };
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    await renderCommitsTab({}, { testApiRef });
    await waitFor(() => expect(testApiRef.current?.openConfirmModal).toBeTypeOf('function'));

    await act(async () => {
      testApiRef.current.openConfirmModal({ title: '', message: '', onConfirm: 'nope' });
    });

    expect(await screen.findByTestId('modal-content')).toBeInTheDocument();
    expect(screen.queryByTestId('modal-confirm')).not.toBeInTheDocument();
    expect(screen.getByTestId('modal-cancel')).toBeInTheDocument();
  });

  test('handleSquashSelectedCommits uses existing commits when response omits commits array', async () => {
    const testApiRef = { current: null };
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });
    axios.post.mockResolvedValueOnce({ data: { success: true, squashed: { newSha: '' } } });

    await renderCommitsTab({}, { testApiRef });
    await waitFor(() => expect(testApiRef.current?.handleSquashSelectedCommits).toBeTypeOf('function'));

    await act(async () => {
      await testApiRef.current.handleSquashSelectedCommits({
        olderSha: baseCommits[1].sha,
        newerSha: baseCommits[0].sha
      });
    });

    expect(await screen.findByTestId('commit-def9876')).toBeInTheDocument();
    expect(screen.getByTestId('commit-abc1234')).toBeInTheDocument();
  });

  test('clears selection when pending commit disappears and no commits exist', async () => {
    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature-css',
        status: 'needs-fix',
        lastTestStatus: 'failed',
        stagedFiles: [{ path: 'src/styles.css' }]
      }
    };

    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: [] } });

    const result = await renderCommitsTab({}, { skipFetchWait: true });
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/commits`));

    expect(await screen.findByTestId('commit-pending')).toBeInTheDocument();

    workingBranchesValue = {
      [mockProject.id]: {
        name: 'feature-css',
        status: 'needs-fix',
        lastTestStatus: 'failed',
        stagedFiles: []
      }
    };

    await act(async () => {
      result.rerender(<CommitsTab project={mockProject} />);
    });

    expect(screen.queryByTestId('commit-pending')).not.toBeInTheDocument();
    expect(await screen.findByTestId('commit-no-selection')).toHaveTextContent('Select a commit to view details.');
  });

  test('shows the no-selection empty state when selected sha is not in the commits list', async () => {
    const testApiRef = { current: null };
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } })
      .mockResolvedValueOnce({ data: { success: false } });

    await renderCommitsTab({}, { testApiRef });
    await waitFor(() => expect(testApiRef.current?.handleSelectCommit).toBeTypeOf('function'));
    await screen.findByTestId('commit-def9876');

    await act(async () => {
      testApiRef.current.handleSelectCommit('not-a-real-sha');
    });

    expect(await screen.findByTestId('commit-no-selection')).toHaveTextContent('Select a commit to view details.');
  });

  test('openConfirmModal uses default confirm/cancel labels when not provided via test API', async () => {
    const testApiRef = { current: null };
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    await renderCommitsTab({}, { testApiRef });
    await waitFor(() => expect(testApiRef.current?.openConfirmModal).toBeTypeOf('function'));

    const onConfirm = vi.fn();

    await act(async () => {
      testApiRef.current.openConfirmModal({ title: 'Confirm?', message: 'Demo message', onConfirm });
    });

    expect(await screen.findByTestId('modal-content')).toBeInTheDocument();
    expect(screen.getByTestId('modal-confirm')).toHaveTextContent('Confirm');
    expect(screen.getByTestId('modal-cancel')).toHaveTextContent('Cancel');

    await act(async () => {
      testApiRef.current.closeConfirmModal();
    });

    expect(screen.queryByTestId('modal-content')).not.toBeInTheDocument();
  });

  test('requestRevertCommit exits when project id is missing via test API', async () => {
    const testApiRef = { current: null };
    await renderCommitsTab({ project: { name: 'No project id' } }, { testApiRef, skipFetchWait: true });
    await waitFor(() => expect(testApiRef.current?.requestRevertCommit).toBeTypeOf('function'));

    await act(async () => {
      testApiRef.current.requestRevertCommit('some-sha');
    });

    expect(axios.post).not.toHaveBeenCalled();
    expect(screen.queryByTestId('modal-content')).not.toBeInTheDocument();
  });

  test('requestRevertCommit does not open modal when commit cannot be reverted via test API', async () => {
    const testApiRef = { current: null };
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail(baseCommits[0]) } });

    await renderCommitsTab({}, { testApiRef });
    await waitFor(() => expect(testApiRef.current?.requestRevertCommit).toBeTypeOf('function'));

    await act(async () => {
      testApiRef.current.requestRevertCommit(baseCommits[1].sha);
    });

    expect(axios.post).not.toHaveBeenCalled();
    expect(screen.queryByTestId('modal-content')).not.toBeInTheDocument();
  });
});
