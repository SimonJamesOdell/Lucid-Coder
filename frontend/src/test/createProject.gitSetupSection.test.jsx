import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import GitSetupSection from '../components/create-project/GitSetupSection';

function buildProps(overrides = {}) {
  return {
    projectSource: 'git',
    createLoading: false,
    localPath: '',
    setLocalPath: vi.fn(),
    createError: '',
    setCreateError: vi.fn(),
    handleFolderSelect: vi.fn(),
    localImportMode: 'copy',
    setLocalImportMode: vi.fn(),
    gitConnectionMode: 'custom',
    setGitConnectionMode: vi.fn(),
    gitConnectionRemoteUrl: '',
    setGitConnectionRemoteUrl: vi.fn(),
    gitRemoteUrl: 'https://example.com/org/repo.git',
    setGitRemoteUrl: vi.fn(),
    cloneCreateRemote: false,
    setCloneCreateRemote: vi.fn(),
    gitWorkflowMode: '',
    setGitWorkflowMode: vi.fn(),
    setGitCloudMode: vi.fn(),
    gitProvider: 'github',
    setGitProvider: vi.fn(),
    gitToken: '',
    setGitToken: vi.fn(),
    gitCloudMode: '',
    gitRepoName: '',
    setGitRepoName: vi.fn(),
    newProjectName: 'demo-app',
    gitRepoOwner: '',
    setGitRepoOwner: vi.fn(),
    gitRepoVisibility: 'private',
    setGitRepoVisibility: vi.fn(),
    shouldShowGitSummary: false,
    gitSummaryItems: [],
    ...overrides
  };
}

describe('create-project GitSetupSection', () => {
  test('renders clone flow controls for git source', () => {
    render(<GitSetupSection {...buildProps()} />);

    expect(screen.getByLabelText('Repository URL *')).toBeInTheDocument();
    expect(screen.getByLabelText('Git Workflow *')).toBeInTheDocument();
    expect(screen.getByText('Create a new repo after cloning (create fork)')).toBeInTheDocument();
  });

  test('shows new-project workflow and git summary for cloud create', () => {
    render(
      <GitSetupSection
        {...buildProps({
          projectSource: 'new',
          gitWorkflowMode: 'custom',
          gitCloudMode: 'create',
          shouldShowGitSummary: true,
          gitSummaryItems: [{ label: 'Provider', value: 'github' }]
        })}
      />
    );

    expect(screen.getByText('Derived from repo')).toBeInTheDocument();
    expect(screen.getByLabelText('Personal Access Token *')).toBeInTheDocument();
    expect(screen.getByLabelText('Repository Name')).toBeInTheDocument();
  });

  test('local import mode calls handlers', async () => {
    const user = userEvent.setup();
    const props = buildProps({ projectSource: 'local', localImportMode: 'copy', gitConnectionMode: 'local' });

    render(<GitSetupSection {...props} />);

    await user.click(screen.getByRole('button', { name: 'Browse' }));
    await user.click(screen.getByText('Link to existing folder'));

    expect(props.handleFolderSelect).toHaveBeenCalled();
    expect(props.setLocalImportMode).toHaveBeenCalledWith('link');
  });
});
