import React from 'react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import axios from 'axios';

let workingBranchesValue = {};
let workspaceChangesValue = {};
let syncBranchOverviewValue = vi.fn();

const project = { id: 'project-status-message', name: 'Status Message Project' };

vi.mock('../context/AppStateContext', () => ({
  useAppState: () => ({
    requestEditorFocus: vi.fn(),
    workingBranches: workingBranchesValue,
    workspaceChanges: workspaceChangesValue,
    syncBranchOverview: syncBranchOverviewValue,
    isLLMConfigured: false
  })
}));

vi.mock('../components/branch-tab/useCommitComposer', () => ({
  useCommitComposer: () => ({
    commitMessageRequest: null,
    commitMessageError: null,
    isLLMConfigured: false,
    getCommitMessageForBranch: vi.fn(() => ''),
    getCommitSubjectForBranch: vi.fn(() => 'Timer subject'),
    getCommitBodyForBranch: vi.fn(() => ''),
    handleCommitMessageChange: vi.fn(),
    handleCommitMessageAutofill: vi.fn(),
    clearCommitMessageForBranch: vi.fn()
  })
}));

vi.mock('../components/commitsTab/CommitDetailsPanel', () => ({
  __esModule: true,
  default: (props) => (
    <div data-testid="mock-commit-details">
      <div data-testid="status-message">{props.statusMessage || ''}</div>
      <button
        type="button"
        data-testid="trigger-commit"
        onClick={async () => {
          await props.onCommit?.();
        }}
      >
        Commit
      </button>
    </div>
  )
}));

beforeEach(() => {
  vi.clearAllMocks();
  axios.get.mockReset();
  axios.post.mockReset();

  workingBranchesValue = {};
  workspaceChangesValue = {};
  syncBranchOverviewValue = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CommitsTab status message timer coverage', () => {
  test('clears the status message after the timeout fires', async () => {
    vi.useFakeTimers();

    axios.get
      .mockResolvedValueOnce({ data: { success: true, commits: [] } })
      .mockResolvedValueOnce({ data: { success: true, commits: [] } });

    axios.post.mockResolvedValueOnce({ data: { success: true } });

    workingBranchesValue = {
      [project.id]: { name: 'feature/timer', stagedFiles: [{ path: 'src/a.js' }] }
    };

    const CommitsTab = (await import('../components/CommitsTab')).default;

    render(<CommitsTab project={project} />);

    // Let the initial fetchCommits effect settle (it flips `loading` on/off).
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('trigger-commit'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('status-message').textContent).toBe('Committed staged changes');

    act(() => {
      vi.advanceTimersByTime(2500);
    });

    expect(screen.getByTestId('status-message').textContent).toBe('');
  });
});
