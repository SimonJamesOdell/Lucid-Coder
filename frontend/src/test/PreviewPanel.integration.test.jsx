import React from 'react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import PreviewPanel from '../components/PreviewPanel';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn()
  }
}));

let appStateGetter = () => {
  throw new Error('useAppState mock not configured');
};

vi.mock('../context/AppStateContext', () => ({
  useAppState: () => appStateGetter()
}));

vi.mock('../components/PreviewTab', () => ({
  __esModule: true,
  default: React.forwardRef(() => <div data-testid="mock-preview-tab" />)
}));

vi.mock('../components/GoalsTab', () => ({
  __esModule: true,
  default: () => <div data-testid="mock-goals-tab" />
}));

vi.mock('../components/FilesTab', () => ({
  __esModule: true,
  default: () => <div data-testid="mock-files-tab" />
}));

vi.mock('../components/TestTab', () => ({
  __esModule: true,
  default: () => <div data-testid="mock-test-tab" />
}));

vi.mock('../components/BranchTab', () => ({
  __esModule: true,
  default: () => <div data-testid="mock-branch-tab" />
}));

vi.mock('../components/GitTab', () => ({
  __esModule: true,
  default: () => <div data-testid="mock-git-tab" />
}));

vi.mock('../components/ProcessesTab', () => ({
  __esModule: true,
  default: () => <div data-testid="mock-processes-tab" />
}));

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

const buildCommitDetail = () => ({
  sha: 'def987654321',
  shortSha: 'def9876',
  message: 'Add feature',
  authoredAt: '2025-01-06T09:00:00Z',
  author: { name: 'Demo Dev' },
  canRevert: true,
  files: [
    { path: 'src/App.jsx', status: 'M' },
    { path: 'README.md', status: 'A' }
  ]
});

describe('PreviewPanel commit-to-files integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appStateGetter = () => {
      throw new Error('useAppState mock not configured');
    };
  });

  const setupAppState = () => {
    const requestEditorFocusMock = vi.fn();
    let appState = {
      currentProject: { id: 77, name: 'Integration Project' },
      hasBranchNotification: false,
      requestEditorFocus: (...args) => {
        requestEditorFocusMock(...args);
      },
      projectProcesses: null,
      refreshProcessStatus: vi.fn(),
      restartProject: vi.fn(),
      editorFocusRequest: null
    };

    const updateState = (patch) => {
      appState = { ...appState, ...patch };
    };

    const requestEditorFocus = (projectId, filePath, options) => {
      requestEditorFocusMock(projectId, filePath, options);
      updateState({
        editorFocusRequest: {
          projectId,
          filePath,
          source: options?.source || 'unknown'
        }
      });
    };

    appState.requestEditorFocus = requestEditorFocus;
    appStateGetter = () => appState;

    return {
      requestEditorFocusMock,
      updateState
    };
  };

  test('clicking a commit file switches PreviewPanel to the Files tab', async () => {
    const { requestEditorFocusMock, updateState } = setupAppState();
    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: baseCommits } })
      .mockResolvedValueOnce({ data: { success: true, commit: buildCommitDetail() } });

    const user = userEvent.setup();
    const view = render(<PreviewPanel />);

    await user.click(screen.getByTestId('commits-tab'));

    const commitButton = await screen.findByTestId('commit-def9876');
    await user.click(commitButton);

    const fileButton = await screen.findByTestId('commit-file-open-0');
    await user.click(fileButton);

    await waitFor(() => {
      expect(requestEditorFocusMock).toHaveBeenCalledWith(
        77,
        'src/App.jsx',
        expect.objectContaining({ source: 'commits' })
      );
    });

    updateState({
      editorFocusRequest: {
        projectId: 77,
        filePath: 'src/App.jsx',
        source: 'commits'
      }
    });

    view.rerender(<PreviewPanel />);

    await waitFor(() => {
      expect(screen.getByTestId('mock-files-tab')).toBeInTheDocument();
    });
  });
});
