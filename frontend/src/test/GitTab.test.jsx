import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import GitTab, { slugifyRepoName } from '../components/GitTab';
import { useAppState } from '../context/AppStateContext';

vi.mock('../context/AppStateContext', () => ({
  useAppState: vi.fn()
}));

describe('GitTab', () => {
  const buildContext = (overrides = {}) => ({
    currentProject: { id: 'proj-1', name: 'Demo Project', path: '/tmp/demo' },
    gitSettings: { workflow: 'cloud', provider: 'github', tokenPresent: true },
    gitConnectionStatus: { provider: 'github', account: { login: 'octo' }, message: 'Connected', testedAt: '2026-01-01T00:00:00.000Z' },
    projectGitStatus: {},
    getEffectiveGitSettings: vi.fn().mockReturnValue({
      workflow: 'cloud',
      provider: 'github',
      remoteUrl: 'https://github.com/lucid/repo.git',
      defaultBranch: 'main'
    }),
    fetchProjectGitStatus: vi.fn().mockResolvedValue({
      branch: 'main',
      ahead: 0,
      behind: 0,
      hasRemote: true
    }),
    fetchProjectGitRemote: vi.fn().mockResolvedValue({
      branch: 'main',
      ahead: 0,
      behind: 0,
      hasRemote: true
    }),
    pullProjectGitRemote: vi.fn().mockResolvedValue({
      status: { branch: 'main', ahead: 0, behind: 0, hasRemote: true },
      strategy: 'noop'
    }),
    stashProjectGitChanges: vi.fn().mockResolvedValue({
      stashed: true,
      label: 'lucidcoder-auto/main',
      status: { branch: 'main', ahead: 0, behind: 0, hasRemote: true, dirty: false }
    }),
    discardProjectGitChanges: vi.fn().mockResolvedValue({
      discarded: true,
      status: { branch: 'main', ahead: 0, behind: 0, hasRemote: true, dirty: false }
    }),
    fetchProjectBranchesOverview: vi.fn().mockResolvedValue({
      branches: [{ name: 'main' }],
      current: 'main'
    }),
    checkoutProjectBranch: vi.fn().mockResolvedValue({ success: true }),
    getProjectGitSettingsSnapshot: vi.fn().mockReturnValue({
      inheritsFromGlobal: false,
      effectiveSettings: {
        workflow: 'cloud',
        provider: 'github',
        remoteUrl: 'https://github.com/lucid/repo.git',
        defaultBranch: 'main'
      },
      projectSettings: {
        workflow: 'cloud',
        provider: 'github',
        remoteUrl: 'https://github.com/lucid/repo.git',
        defaultBranch: 'main'
      },
      globalSettings: {
        workflow: 'local',
        provider: 'github',
        remoteUrl: '',
        defaultBranch: 'main'
      }
    }),
    updateProjectGitSettings: vi.fn().mockResolvedValue({}),
    createProjectRemoteRepository: vi.fn().mockResolvedValue({}),
    ...overrides
  });

  beforeEach(() => {
    vi.clearAllMocks();
    useAppState.mockReturnValue(buildContext());
  });

  test('shows empty state when no project is selected', () => {
    useAppState.mockReturnValue(buildContext({ currentProject: null }));

    render(<GitTab />);

    expect(screen.getByText(/Select a project/i)).toBeInTheDocument();
  });

  test('shows ahead and behind counts when remote status is available', () => {
    useAppState.mockReturnValue(buildContext({
      projectGitStatus: {
        'proj-1': {
          hasRemote: true,
          branch: 'main',
          ahead: 2,
          behind: 1
        }
      }
    }));

    render(<GitTab />);

    const aheadLabel = screen.getByText('Ahead');
    const behindLabel = screen.getByText('Behind');

    expect(aheadLabel.parentElement?.querySelector('strong')).toHaveTextContent('2');
    expect(behindLabel.parentElement?.querySelector('strong')).toHaveTextContent('1');
  });

  test('defaults ahead and behind counts to zero when missing', () => {
    useAppState.mockReturnValue(buildContext({
      projectGitStatus: {
        'proj-1': {
          hasRemote: true,
          branch: 'main'
        }
      }
    }));

    render(<GitTab />);

    const aheadLabel = screen.getByText('Ahead');
    const behindLabel = screen.getByText('Behind');

    expect(aheadLabel.parentElement?.querySelector('strong')).toHaveTextContent('0');
    expect(behindLabel.parentElement?.querySelector('strong')).toHaveTextContent('0');
  });

  test('falls back to default repo name when project title cannot be slugified', async () => {
    const user = userEvent.setup();
    useAppState.mockReturnValue(
      buildContext({ currentProject: { id: 'proj-1', name: '!!!', path: '/tmp/demo' } })
    );

    render(<GitTab />);

    await user.click(screen.getByTestId('git-show-remote-creator'));
    expect(screen.getByTestId('git-remote-create-name')).toHaveValue('lucidcoder-project');
  });

  test('prefills remote creator with fallback when project name is empty', async () => {
    const user = userEvent.setup();
    useAppState.mockReturnValue(
      buildContext({ currentProject: { id: 'proj-1', name: '', path: '/tmp/demo' } })
    );

    render(<GitTab />);

    await user.click(screen.getByTestId('git-show-remote-creator'));
    expect(screen.getByTestId('git-remote-create-name')).toHaveValue('lucidcoder-project');
  });

  test('slugifyRepoName normalizes mixed characters', () => {
    expect(slugifyRepoName('New Repo!?')).toBe('new-repo');
    expect(slugifyRepoName('')).toBe('lucidcoder-project');
  });

  test('slugifyRepoName trims leading and trailing dashes', () => {
    expect(slugifyRepoName('--My Repo--')).toBe('my-repo');
  });

  test('allows editing remote preferences and saving overrides', async () => {
    const updateProjectGitSettings = vi.fn().mockResolvedValue({
      workflow: 'cloud',
      provider: 'github',
      remoteUrl: 'https://github.com/lucid/override.git',
      defaultBranch: 'main'
    });
    useAppState.mockReturnValue(buildContext({ updateProjectGitSettings }));

    const user = userEvent.setup();
    render(<GitTab />);

    const remoteInput = screen.getByTestId('project-remote-url');
    await user.clear(remoteInput);
    await user.type(remoteInput, 'https://github.com/lucid/override.git');

    const saveButton = screen.getByTestId('git-save-preferences');
    expect(saveButton).toBeEnabled();

    const form = screen.getByTestId('git-settings-form');
    fireEvent.submit(form);

    await waitFor(() => {
      expect(updateProjectGitSettings).toHaveBeenCalledWith(
        'proj-1',
        expect.objectContaining({ remoteUrl: 'https://github.com/lucid/override.git' })
      );
    });
  });

  test('saves default branch as main when input is cleared', async () => {
    const updateProjectGitSettings = vi.fn().mockResolvedValue({
      workflow: 'cloud',
      provider: 'github',
      remoteUrl: 'https://github.com/lucid/sanitized.git',
      defaultBranch: ''
    });
    useAppState.mockReturnValue(buildContext({ updateProjectGitSettings }));

    const user = userEvent.setup();
    render(<GitTab />);

    const branchInput = screen.getByTestId('project-default-branch');
    await user.clear(branchInput);
    const remoteInput = screen.getByTestId('project-remote-url');
    await user.clear(remoteInput);
    await user.type(remoteInput, 'https://github.com/lucid/sanitized.git');

    await user.click(screen.getByTestId('git-save-preferences'));

    await waitFor(() => {
      expect(updateProjectGitSettings).toHaveBeenCalledWith(
        'proj-1',
        expect.objectContaining({ defaultBranch: 'main' })
      );
    });
  });

  test('does nothing when save is pressed without changes', async () => {
    const user = userEvent.setup();
    const updateProjectGitSettings = vi.fn();
    useAppState.mockReturnValue(buildContext({ updateProjectGitSettings }));

    render(<GitTab />);

    const saveButton = screen.getByTestId('git-save-preferences');
    expect(saveButton).toBeDisabled();

    const form = screen.getByTestId('git-settings-form');
    await user.click(saveButton);
    fireEvent.submit(form);

    expect(updateProjectGitSettings).not.toHaveBeenCalled();
  });

  test('reset button clears project overrides', async () => {
    useAppState.mockReturnValue(buildContext());
    render(<GitTab />);
    expect(screen.queryByTestId('git-reset-overrides')).toBeNull();
  });

  test('shows error when resetting overrides fails', async () => {
    useAppState.mockReturnValue(buildContext());
    render(<GitTab />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('reset override errors fall back to default copy when message missing', async () => {
    useAppState.mockReturnValue(buildContext());
    render(<GitTab />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('shows inheritance indicator when using global settings', () => {
    const getProjectGitSettingsSnapshot = vi.fn().mockReturnValue({
      inheritsFromGlobal: true,
      effectiveSettings: {
        workflow: 'local',
        provider: 'github',
        remoteUrl: '',
        defaultBranch: 'main'
      },
      projectSettings: null,
      globalSettings: {
        workflow: 'local',
        provider: 'github',
        remoteUrl: '',
        defaultBranch: 'main'
      }
    });
    useAppState.mockReturnValue(buildContext({ getProjectGitSettingsSnapshot }));

    render(<GitTab />);
  });

  test('renders local-only connection status messaging', () => {
    const getEffectiveGitSettings = vi.fn().mockReturnValue({
      workflow: 'local',
      provider: 'github',
      remoteUrl: '',
      defaultBranch: 'main'
    });
    const getProjectGitSettingsSnapshot = vi.fn().mockReturnValue({
      inheritsFromGlobal: true,
      effectiveSettings: { workflow: 'local' },
      projectSettings: null,
      globalSettings: { workflow: 'local' }
    });

    useAppState.mockReturnValue(buildContext({ getEffectiveGitSettings, getProjectGitSettingsSnapshot }));

    render(<GitTab />);

    expect(screen.queryByTestId('git-repo-pane')).toBeNull();
  });

  test('connection status reflects GitLab provider for cloud workflow', () => {
    const getEffectiveGitSettings = vi.fn().mockReturnValue({
      workflow: 'cloud',
      provider: 'gitlab',
      remoteUrl: 'https://gitlab.com/lucid/repo.git',
      defaultBranch: 'main'
    });

    useAppState.mockReturnValue(buildContext({ getEffectiveGitSettings }));

    render(<GitTab />);
    expect(screen.getAllByText('GitLab').length).toBeGreaterThan(0);
  });

  test('prompts for remote url when cloud workflow lacks a remote', () => {
    const getEffectiveGitSettings = vi.fn().mockReturnValue({
      workflow: 'cloud',
      provider: 'github',
      remoteUrl: '',
      defaultBranch: 'main'
    });
    const getProjectGitSettingsSnapshot = vi.fn().mockReturnValue({
      inheritsFromGlobal: false,
      effectiveSettings: { workflow: 'cloud', remoteUrl: '' },
      projectSettings: { workflow: 'cloud', remoteUrl: '' },
      globalSettings: { workflow: 'local' }
    });

    useAppState.mockReturnValue(buildContext({ getEffectiveGitSettings, getProjectGitSettingsSnapshot }));

    render(<GitTab />);

    expect(screen.getByTestId('project-remote-url')).toBeInTheDocument();
  });

  test('shows default branch fallback copy when status data omits value', () => {
    const getEffectiveGitSettings = vi.fn().mockReturnValue({
      workflow: 'cloud',
      provider: 'github',
      remoteUrl: 'https://github.com/lucid/orig.git',
      defaultBranch: ''
    });
    const getProjectGitSettingsSnapshot = vi.fn().mockReturnValue({
      inheritsFromGlobal: false,
      effectiveSettings: { workflow: 'cloud', remoteUrl: 'https://github.com/lucid/orig.git', defaultBranch: '' },
      projectSettings: { workflow: 'cloud' },
      globalSettings: { workflow: 'local' }
    });

    useAppState.mockReturnValue(
      buildContext({ getEffectiveGitSettings, getProjectGitSettingsSnapshot })
    );

    render(<GitTab />);

    expect(screen.getByTestId('git-repo-pane')).toBeInTheDocument();
  });

  test('shows global connection banner only when global mode selected', async () => {
    useAppState.mockReturnValue(buildContext({
      gitConnectionStatus: { provider: '', account: null, message: '', testedAt: '' },
      gitSettings: { workflow: 'cloud', provider: 'github', tokenPresent: false },
      getEffectiveGitSettings: vi.fn().mockReturnValue({
        workflow: 'cloud',
        provider: 'gitlab',
        remoteUrl: 'https://gitlab.com/demo/repo.git',
        defaultBranch: 'main'
      })
    }));

    const user = userEvent.setup();
    render(<GitTab />);

    expect(screen.queryByTestId('git-global-connection-alert')).toBeNull();

    await user.click(screen.getByTestId('project-connection-global'));
    expect(screen.getByTestId('git-global-connection-alert')).toBeInTheDocument();
  });

  test('open global settings button dispatches event', async () => {
    useAppState.mockReturnValue(buildContext({
      gitConnectionStatus: { provider: '', account: null, message: '', testedAt: '' },
      gitSettings: { workflow: 'cloud', provider: 'github', tokenPresent: false },
      getEffectiveGitSettings: vi.fn().mockReturnValue({
        workflow: 'cloud',
        provider: 'github',
        remoteUrl: 'https://github.com/lucid/repo.git',
        defaultBranch: 'main'
      })
    }));

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('project-connection-global'));
    await user.click(screen.getByTestId('git-open-global-settings'));

    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'lucidcoder:open-git-settings' }));
    dispatchSpy.mockRestore();
  });

  test('shows repository pane when project uses remote provider', () => {
    render(<GitTab />);
    expect(screen.getByTestId('git-repo-pane')).toBeInTheDocument();
  });

  test('fetch remote shows success message', async () => {
    const fetchProjectGitRemote = vi.fn().mockResolvedValue({
      branch: 'main',
      ahead: 0,
      behind: 0,
      hasRemote: true
    });
    useAppState.mockReturnValue(buildContext({ fetchProjectGitRemote }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('git-fetch-remote'));

    expect(await screen.findByText('Fetched latest from remote.')).toBeInTheDocument();
  });

  test('fetch remote falls back to default error copy', async () => {
    const fetchProjectGitRemote = vi.fn().mockRejectedValue({});
    useAppState.mockReturnValue(buildContext({ fetchProjectGitRemote }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('git-fetch-remote'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to fetch remote.');
  });

  test('surfaces git status errors with fallback copy', async () => {
    const fetchProjectGitStatus = vi.fn().mockRejectedValue({});
    useAppState.mockReturnValue(buildContext({ fetchProjectGitStatus }));

    render(<GitTab />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load git status.');
  });

  test('uses current git status fallback when branch overview omits current', async () => {
    const fetchProjectBranchesOverview = vi.fn().mockResolvedValue({
      branches: [{ name: 'main' }, { name: 'develop' }],
      current: ''
    });
    useAppState.mockReturnValue(buildContext({
      fetchProjectBranchesOverview,
      projectGitStatus: {
        'proj-1': { currentBranch: 'develop', hasRemote: true, branch: 'main', ahead: 0, behind: 0 }
      }
    }));

    render(<GitTab />);

    await waitFor(() => {
      expect(screen.getByTestId('git-checkout-branch-select')).toHaveValue('develop');
    });
  });

  test('defaults selected branch to first option when overview has no current', async () => {
    const fetchProjectBranchesOverview = vi.fn().mockResolvedValue({
      branches: [{ name: 'main' }, { name: 'develop' }]
    });
    useAppState.mockReturnValue(buildContext({
      fetchProjectBranchesOverview,
      projectGitStatus: {
        'proj-1': { hasRemote: true, branch: 'main', ahead: 0, behind: 0 }
      }
    }));

    render(<GitTab />);

    await waitFor(() => {
      expect(screen.getByTestId('git-checkout-branch-select')).toHaveValue('main');
    });
  });

  test('updates selected branch when the checkout select changes', async () => {
    const fetchProjectBranchesOverview = vi.fn().mockResolvedValue({
      branches: [{ name: 'main' }, { name: 'develop' }],
      current: 'main'
    });
    useAppState.mockReturnValue(buildContext({
      fetchProjectBranchesOverview,
      projectGitStatus: {
        'proj-1': { hasRemote: true, branch: 'main', ahead: 0, behind: 0 }
      }
    }));

    render(<GitTab />);

    const select = await screen.findByTestId('git-checkout-branch-select');
    await waitFor(() => {
      expect(select).toHaveValue('main');
    });

    fireEvent.change(select, { target: { value: 'develop' } });
    expect(select).toHaveValue('develop');
  });

  test('shows empty branch list when overview omits branches', async () => {
    const fetchProjectBranchesOverview = vi.fn().mockResolvedValue({
      branches: null,
      current: ''
    });
    useAppState.mockReturnValue(buildContext({ fetchProjectBranchesOverview }));

    render(<GitTab />);

    await waitFor(() => {
      expect(screen.getByTestId('git-checkout-branch-select')).toHaveDisplayValue('No branches');
    });
    expect(screen.getByTestId('git-checkout-branch')).toBeDisabled();
  });

  test('surfaces branch overview errors with fallback copy', async () => {
    const fetchProjectBranchesOverview = vi.fn().mockRejectedValue({});
    useAppState.mockReturnValue(buildContext({ fetchProjectBranchesOverview }));

    render(<GitTab />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load branches.');
  });

  test('switching to local connection hides remote panes', async () => {
    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('project-connection-local'));

    expect(screen.queryByTestId('git-repo-pane')).toBeNull();
  });

  test('global connection defaults provider when git settings are missing', async () => {
    const updateProjectGitSettings = vi.fn().mockResolvedValue({});
    useAppState.mockReturnValue(buildContext({
      gitSettings: { workflow: 'cloud', provider: '', tokenPresent: true },
      updateProjectGitSettings
    }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('project-connection-global'));
    const remoteInput = screen.getByTestId('project-remote-url');
    await user.clear(remoteInput);
    await user.type(remoteInput, 'https://github.com/lucid/default.git');
    await user.click(screen.getByTestId('git-save-preferences'));

    await waitFor(() => {
      expect(updateProjectGitSettings).toHaveBeenCalledWith(
        'proj-1',
        expect.objectContaining({ provider: 'github' })
      );
    });
  });

  test('switching to global connection applies default provider', async () => {
    useAppState.mockReturnValue(buildContext({
      gitSettings: { workflow: 'cloud', provider: '', tokenPresent: true }
    }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('project-connection-local'));
    await user.click(screen.getByTestId('project-connection-global'));

    expect(screen.getByTestId('project-provider-select')).toHaveValue('github');
  });

  test('fetch and pull handlers guard when project id is missing', async () => {
    const fetchProjectGitRemote = vi.fn();
    const pullProjectGitRemote = vi.fn();
    useAppState.mockReturnValue(buildContext({
      currentProject: { name: 'No Id Project' },
      fetchProjectGitRemote,
      pullProjectGitRemote
    }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('git-fetch-remote'));
    await user.click(screen.getByTestId('git-pull-remote'));

    expect(fetchProjectGitRemote).not.toHaveBeenCalled();
    expect(pullProjectGitRemote).not.toHaveBeenCalled();
  });

  test('pull remote reports noop strategy', async () => {
    const pullProjectGitRemote = vi.fn().mockResolvedValue({
      status: { branch: 'main', ahead: 0, behind: 0, hasRemote: true },
      strategy: 'noop'
    });
    useAppState.mockReturnValue(buildContext({ pullProjectGitRemote }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('git-pull-remote'));

    expect(await screen.findByText('Already up to date.')).toBeInTheDocument();
  });

  test('pull remote reports rebase strategy', async () => {
    const pullProjectGitRemote = vi.fn().mockResolvedValue({
      status: { branch: 'main', ahead: 0, behind: 0, hasRemote: true },
      strategy: 'rebase'
    });
    useAppState.mockReturnValue(buildContext({ pullProjectGitRemote }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('git-pull-remote'));

    expect(await screen.findByText('Pulled with rebase.')).toBeInTheDocument();
  });

  test('pull remote reports default strategy message', async () => {
    const pullProjectGitRemote = vi.fn().mockResolvedValue({
      status: { branch: 'main', ahead: 0, behind: 0, hasRemote: true },
      strategy: 'merge'
    });
    useAppState.mockReturnValue(buildContext({ pullProjectGitRemote }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('git-pull-remote'));

    expect(await screen.findByText('Pull complete.')).toBeInTheDocument();
  });

  test('pull remote reports stash restore success', async () => {
    const pullProjectGitRemote = vi.fn().mockResolvedValue({
      status: { branch: 'main', ahead: 0, behind: 0, hasRemote: true },
      strategy: 'ff-only',
      stash: { created: true, restored: true }
    });
    useAppState.mockReturnValue(buildContext({ pullProjectGitRemote }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('git-pull-remote'));

    expect(await screen.findByText('Pulled with fast-forward. Stashed changes restored.')).toBeInTheDocument();
  });

  test('pull remote reports stash restore failure with error message', async () => {
    const pullProjectGitRemote = vi.fn().mockResolvedValue({
      status: { branch: 'main', ahead: 0, behind: 0, hasRemote: true },
      strategy: 'ff-only',
      stash: { created: true, error: 'stash restore failed' }
    });
    useAppState.mockReturnValue(buildContext({ pullProjectGitRemote }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('git-pull-remote'));

    expect(await screen.findByRole('alert')).toHaveTextContent('stash restore failed');
  });

  test('pull remote reports stash restore failure when no error is provided', async () => {
    const pullProjectGitRemote = vi.fn().mockResolvedValue({
      status: { branch: 'main', ahead: 0, behind: 0, hasRemote: true },
      strategy: 'ff-only',
      stash: { created: true }
    });
    useAppState.mockReturnValue(buildContext({ pullProjectGitRemote }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('git-pull-remote'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Pulled, but stashed changes were not restored');
  });

  test('pull remote falls back to default error message', async () => {
    const pullProjectGitRemote = vi.fn().mockRejectedValue({});
    useAppState.mockReturnValue(buildContext({ pullProjectGitRemote }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('git-pull-remote'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to pull remote.');
  });

  test('shows dirty working tree status and resolve actions', () => {
    useAppState.mockReturnValue(buildContext({
      projectGitStatus: {
        'proj-1': {
          hasRemote: true,
          branch: 'main',
          currentBranch: 'main',
          ahead: 0,
          behind: 1,
          dirty: true
        }
      }
    }));

    render(<GitTab />);

    expect(screen.getByText('Dirty')).toBeInTheDocument();
    expect(screen.getByTestId('git-stash-changes')).toBeInTheDocument();
    expect(screen.getByTestId('git-discard-changes')).toBeInTheDocument();
    expect(screen.getByTestId('git-stash-pull')).toBeInTheDocument();
    expect(screen.getByTestId('git-discard-pull')).toBeInTheDocument();
  });

  test('stash changes reports success when stashed', async () => {
    const stashProjectGitChanges = vi.fn().mockResolvedValue({ stashed: true });
    useAppState.mockReturnValue(buildContext({
      stashProjectGitChanges,
      projectGitStatus: {
        'proj-1': {
          hasRemote: true,
          branch: 'main',
          currentBranch: 'main',
          ahead: 0,
          behind: 1,
          dirty: true
        }
      }
    }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('git-stash-changes'));

    expect(await screen.findByText('Changes stashed.')).toBeInTheDocument();
  });

  test('stash changes does nothing when project id is missing', async () => {
    const stashProjectGitChanges = vi.fn();
    useAppState.mockReturnValue(buildContext({
      currentProject: { id: '', name: 'No Id', path: '/tmp/demo' },
      stashProjectGitChanges,
      projectGitStatus: {
        '': {
          hasRemote: true,
          branch: 'main',
          currentBranch: 'main',
          ahead: 0,
          behind: 1,
          dirty: true
        }
      }
    }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('git-stash-changes'));

    expect(stashProjectGitChanges).not.toHaveBeenCalled();
  });

  test('stash changes reports clean working tree when nothing stashed', async () => {
    const stashProjectGitChanges = vi.fn().mockResolvedValue({ stashed: false });
    useAppState.mockReturnValue(buildContext({
      stashProjectGitChanges,
      projectGitStatus: {
        'proj-1': {
          hasRemote: true,
          branch: 'main',
          currentBranch: 'main',
          ahead: 0,
          behind: 1,
          dirty: true
        }
      }
    }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('git-stash-changes'));

    expect(await screen.findByText('Working tree already clean.')).toBeInTheDocument();
  });

  test('stash changes reports error when stash fails', async () => {
    const stashProjectGitChanges = vi.fn().mockRejectedValue(new Error('stash failed'));
    useAppState.mockReturnValue(buildContext({
      stashProjectGitChanges,
      projectGitStatus: {
        'proj-1': {
          hasRemote: true,
          branch: 'main',
          currentBranch: 'main',
          ahead: 0,
          behind: 1,
          dirty: true
        }
      }
    }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('git-stash-changes'));

    expect(await screen.findByRole('alert')).toHaveTextContent('stash failed');
  });

  test('stash changes falls back to default error message', async () => {
    const stashProjectGitChanges = vi.fn().mockRejectedValue({});
    useAppState.mockReturnValue(buildContext({
      stashProjectGitChanges,
      projectGitStatus: {
        'proj-1': {
          hasRemote: true,
          branch: 'main',
          currentBranch: 'main',
          ahead: 0,
          behind: 1,
          dirty: true
        }
      }
    }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('git-stash-changes'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to stash changes.');
  });

  test('stash changes falls back when error message is empty', async () => {
    const stashProjectGitChanges = vi.fn().mockRejectedValue({ message: '' });
    useAppState.mockReturnValue(buildContext({
      stashProjectGitChanges,
      projectGitStatus: {
        'proj-1': {
          hasRemote: true,
          branch: 'main',
          currentBranch: 'main',
          ahead: 0,
          behind: 1,
          dirty: true
        }
      }
    }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('git-stash-changes'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to stash changes.');
  });

  test('discard changes does nothing when confirmation is declined', async () => {
    const discardProjectGitChanges = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    useAppState.mockReturnValue(buildContext({
      discardProjectGitChanges,
      projectGitStatus: {
        'proj-1': {
          hasRemote: true,
          branch: 'main',
          currentBranch: 'main',
          ahead: 0,
          behind: 1,
          dirty: true
        }
      }
    }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('git-discard-changes'));

    expect(discardProjectGitChanges).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  test('discard changes reports clean working tree when nothing discarded', async () => {
    const discardProjectGitChanges = vi.fn().mockResolvedValue({ discarded: false });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    useAppState.mockReturnValue(buildContext({
      discardProjectGitChanges,
      projectGitStatus: {
        'proj-1': {
          hasRemote: true,
          branch: 'main',
          currentBranch: 'main',
          ahead: 0,
          behind: 1,
          dirty: true
        }
      }
    }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('git-discard-changes'));

    expect(await screen.findByText('Working tree already clean.')).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  test('discard changes does nothing when project id is missing', async () => {
    const discardProjectGitChanges = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm');
    useAppState.mockReturnValue(buildContext({
      currentProject: { id: '', name: 'No Id', path: '/tmp/demo' },
      discardProjectGitChanges,
      projectGitStatus: {
        '': {
          hasRemote: true,
          branch: 'main',
          currentBranch: 'main',
          ahead: 0,
          behind: 1,
          dirty: true
        }
      }
    }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('git-discard-changes'));

    expect(discardProjectGitChanges).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  test('discard changes falls back to default error message', async () => {
    const discardProjectGitChanges = vi.fn().mockRejectedValue({});
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    useAppState.mockReturnValue(buildContext({
      discardProjectGitChanges,
      projectGitStatus: {
        'proj-1': {
          hasRemote: true,
          branch: 'main',
          currentBranch: 'main',
          ahead: 0,
          behind: 1,
          dirty: true
        }
      }
    }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('git-discard-changes'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to discard changes.');
    confirmSpy.mockRestore();
  });

  test('discard changes reports success when discarded', async () => {
    const discardProjectGitChanges = vi.fn().mockResolvedValue({ discarded: true });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    useAppState.mockReturnValue(buildContext({
      discardProjectGitChanges,
      projectGitStatus: {
        'proj-1': {
          hasRemote: true,
          branch: 'main',
          currentBranch: 'main',
          ahead: 0,
          behind: 1,
          dirty: true
        }
      }
    }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('git-discard-changes'));

    expect(await screen.findByText('Local changes discarded.')).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  test('stash and pull sends stash mode', async () => {
    const pullProjectGitRemote = vi.fn().mockResolvedValue({
      status: { branch: 'main', ahead: 0, behind: 0, hasRemote: true },
      strategy: 'ff-only'
    });
    useAppState.mockReturnValue(buildContext({
      pullProjectGitRemote,
      projectGitStatus: {
        'proj-1': {
          hasRemote: true,
          branch: 'main',
          currentBranch: 'main',
          ahead: 0,
          behind: 1,
          dirty: true
        }
      }
    }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('git-stash-pull'));

    expect(pullProjectGitRemote).toHaveBeenCalledWith('proj-1', { mode: 'stash' });
  });

  test('discard and pull confirms before sending discard mode', async () => {
    const pullProjectGitRemote = vi.fn().mockResolvedValue({
      status: { branch: 'main', ahead: 0, behind: 0, hasRemote: true },
      strategy: 'ff-only'
    });
    useAppState.mockReturnValue(buildContext({
      pullProjectGitRemote,
      projectGitStatus: {
        'proj-1': {
          hasRemote: true,
          branch: 'main',
          currentBranch: 'main',
          ahead: 0,
          behind: 1,
          dirty: true
        }
      }
    }));

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('git-discard-pull'));

    expect(pullProjectGitRemote).toHaveBeenCalledWith('proj-1', { mode: 'discard', confirm: true });
    confirmSpy.mockRestore();
  });

  test('branch mismatch guidance and pull warning are shown', async () => {
    const pullProjectGitRemote = vi.fn();
    useAppState.mockReturnValue(buildContext({
      pullProjectGitRemote,
      projectGitStatus: {
        'proj-1': {
          hasRemote: true,
          branch: 'main',
          currentBranch: 'feature/login',
          ahead: 0,
          behind: 0
        }
      }
    }));

    const user = userEvent.setup();
    render(<GitTab />);

    expect(screen.getByText(/You are on feature\/login/)).toBeInTheDocument();

    await user.click(screen.getByTestId('git-pull-remote'));

    expect(await screen.findByText(/Pull updates this branch/)).toBeInTheDocument();
    expect(pullProjectGitRemote).not.toHaveBeenCalled();
  });

  test('guidance copy explains diverged branches', () => {
    useAppState.mockReturnValue(buildContext({
      projectGitStatus: {
        'proj-1': {
          hasRemote: true,
          branch: 'main',
          currentBranch: 'main',
          ahead: 2,
          behind: 1
        }
      }
    }));

    render(<GitTab />);

    expect(screen.getByText(/Local and remote changed in different ways/)).toBeInTheDocument();
  });

  test('guidance copy explains when remote is ahead', () => {
    useAppState.mockReturnValue(buildContext({
      projectGitStatus: {
        'proj-1': {
          hasRemote: true,
          branch: 'main',
          currentBranch: 'main',
          ahead: 0,
          behind: 2
        }
      }
    }));

    render(<GitTab />);

    expect(screen.getByText(/The remote has 2 new commits/)).toBeInTheDocument();
  });

  test('guidance copy uses singular commit when remote is ahead by one', () => {
    useAppState.mockReturnValue(buildContext({
      projectGitStatus: {
        'proj-1': {
          hasRemote: true,
          branch: 'main',
          currentBranch: 'main',
          ahead: 0,
          behind: 1
        }
      }
    }));

    render(<GitTab />);

    expect(screen.getByText(
      'The remote has 1 new commit. Pull to update your workspace with those changes.'
    )).toBeInTheDocument();
  });

  test('guidance copy explains when local is ahead', () => {
    useAppState.mockReturnValue(buildContext({
      projectGitStatus: {
        'proj-1': {
          hasRemote: true,
          branch: 'main',
          currentBranch: 'main',
          ahead: 3,
          behind: 0
        }
      }
    }));

    render(<GitTab />);

    expect(screen.getByText(/Your local changes are ahead by 3 commits/)).toBeInTheDocument();
  });

  test('guidance copy uses singular commit when local is ahead by one', () => {
    useAppState.mockReturnValue(buildContext({
      projectGitStatus: {
        'proj-1': {
          hasRemote: true,
          branch: 'main',
          currentBranch: 'main',
          ahead: 1,
          behind: 0
        }
      }
    }));

    render(<GitTab />);

    expect(screen.getByText(
      'Your local changes are ahead by 1 commit. You need to decide when to push them to share with the remote.'
    )).toBeInTheDocument();
  });

  test('discard and pull cancels when confirmation is declined', async () => {
    const pullProjectGitRemote = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    useAppState.mockReturnValue(buildContext({
      pullProjectGitRemote,
      projectGitStatus: {
        'proj-1': {
          hasRemote: true,
          branch: 'main',
          currentBranch: 'main',
          ahead: 0,
          behind: 1,
          dirty: true
        }
      }
    }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('git-discard-pull'));

    expect(pullProjectGitRemote).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  test('open remote trims .git suffix', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    useAppState.mockReturnValue(buildContext({
      getEffectiveGitSettings: vi.fn().mockReturnValue({
        workflow: 'cloud',
        provider: 'github',
        remoteUrl: 'https://github.com/lucid/repo.git',
        defaultBranch: 'main'
      })
    }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('git-open-remote'));

    expect(openSpy).toHaveBeenCalledWith(
      'https://github.com/lucid/repo',
      '_blank',
      'noopener,noreferrer'
    );

    openSpy.mockRestore();
  });

  test('copy remote uses clipboard when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true
    });

    useAppState.mockReturnValue(buildContext({
      getEffectiveGitSettings: vi.fn().mockReturnValue({
        workflow: 'cloud',
        provider: 'github',
        remoteUrl: 'https://github.com/lucid/repo.git',
        defaultBranch: 'main'
      })
    }));

    render(<GitTab />);

    await waitFor(() => {
      expect(screen.getByText('https://github.com/lucid/repo.git')).toBeInTheDocument();
    });

    const copyButton = screen.getByTestId('git-copy-remote');
    expect(copyButton).toBeEnabled();
    fireEvent.click(copyButton);

    expect(writeText).toHaveBeenCalledWith('https://github.com/lucid/repo.git');
    expect(await screen.findByText('Remote URL copied.')).toBeInTheDocument();
  });

  test('copy remote reports error when clipboard write fails', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('clipboard failed'));
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText },
      configurable: true
    });

    useAppState.mockReturnValue(buildContext({
      getEffectiveGitSettings: vi.fn().mockReturnValue({
        workflow: 'cloud',
        provider: 'github',
        remoteUrl: 'https://github.com/lucid/repo.git',
        defaultBranch: 'main'
      })
    }));

    render(<GitTab />);

    await waitFor(() => {
      expect(screen.getByText('https://github.com/lucid/repo.git')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('git-copy-remote'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to copy remote URL.');
  });

  test('copy remote uses execCommand fallback when clipboard is unavailable', async () => {
    document.execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(window.navigator, 'clipboard', { value: undefined, configurable: true });

    useAppState.mockReturnValue(buildContext({
      getEffectiveGitSettings: vi.fn().mockReturnValue({
        workflow: 'cloud',
        provider: 'github',
        remoteUrl: 'https://github.com/lucid/repo.git',
        defaultBranch: 'main'
      })
    }));

    render(<GitTab />);

    await waitFor(() => {
      expect(screen.getByText('https://github.com/lucid/repo.git')).toBeInTheDocument();
    });

    const copyButton = screen.getByTestId('git-copy-remote');
    expect(copyButton).toBeEnabled();
    fireEvent.click(copyButton);

    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(await screen.findByText('Remote URL copied.')).toBeInTheDocument();
  });

  test('updates default branch and reports success', async () => {
    const updateProjectGitSettings = vi.fn().mockResolvedValue({ defaultBranch: 'release' });
    useAppState.mockReturnValue(buildContext({ updateProjectGitSettings }));

    const user = userEvent.setup();
    render(<GitTab />);

    const branchInput = screen.getByTestId('project-default-branch');
    await user.clear(branchInput);
    await user.type(branchInput, 'release');
    await user.click(screen.getByTestId('git-update-default-branch'));

    await waitFor(() => {
      expect(updateProjectGitSettings).toHaveBeenCalledWith('proj-1', {
        workflow: 'cloud',
        provider: 'github',
        remoteUrl: 'https://github.com/lucid/repo.git',
        defaultBranch: 'release'
      });
    });
    expect(await screen.findByText('Default branch set to release.')).toBeInTheDocument();
  });

  test('update default branch falls back to input when response omits branch', async () => {
    const updateProjectGitSettings = vi.fn().mockResolvedValue({});
    useAppState.mockReturnValue(buildContext({ updateProjectGitSettings }));

    const user = userEvent.setup();
    render(<GitTab />);

    const branchInput = screen.getByTestId('project-default-branch');
    await user.clear(branchInput);
    await user.type(branchInput, 'release');
    await user.click(screen.getByTestId('git-update-default-branch'));

    await waitFor(() => {
      expect(updateProjectGitSettings).toHaveBeenCalledWith('proj-1', {
        workflow: 'cloud',
        provider: 'github',
        remoteUrl: 'https://github.com/lucid/repo.git',
        defaultBranch: 'release'
      });
    });
    expect(await screen.findByText('Default branch set to release.')).toBeInTheDocument();
  });

  test('update default branch reports fallback error', async () => {
    const updateProjectGitSettings = vi.fn().mockRejectedValue({});
    useAppState.mockReturnValue(buildContext({ updateProjectGitSettings }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('git-update-default-branch'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to update default branch.');
  });

  test('update default branch uses global provider when connection mode is global', async () => {
    const updateProjectGitSettings = vi.fn().mockResolvedValue({ defaultBranch: 'release' });
    useAppState.mockReturnValue(buildContext({
      updateProjectGitSettings,
      gitSettings: { workflow: 'cloud', provider: '', tokenPresent: true }
    }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('project-connection-global'));

    const branchInput = screen.getByTestId('project-default-branch');
    await user.clear(branchInput);
    await user.type(branchInput, 'release');
    await user.click(screen.getByTestId('git-update-default-branch'));

    await waitFor(() => {
      expect(updateProjectGitSettings).toHaveBeenCalledWith('proj-1', {
        workflow: 'cloud',
        provider: 'github',
        remoteUrl: 'https://github.com/lucid/repo.git',
        defaultBranch: 'release'
      });
    });
  });

  test('update default branch uses custom provider when connection mode is custom', async () => {
    const updateProjectGitSettings = vi.fn().mockResolvedValue({ defaultBranch: 'release' });
    useAppState.mockReturnValue(buildContext({
      updateProjectGitSettings,
      gitSettings: { workflow: 'cloud', provider: 'github', tokenPresent: true },
      getEffectiveGitSettings: vi.fn().mockReturnValue({
        workflow: 'cloud',
        provider: 'gitlab',
        remoteUrl: 'https://gitlab.com/acme/repo.git',
        defaultBranch: 'main'
      }),
      getProjectGitSettingsSnapshot: vi.fn().mockReturnValue({
        inheritsFromGlobal: false,
        effectiveSettings: {
          workflow: 'cloud',
          provider: 'gitlab',
          remoteUrl: 'https://gitlab.com/acme/repo.git',
          defaultBranch: 'main'
        },
        projectSettings: {
          workflow: 'cloud',
          provider: 'gitlab',
          remoteUrl: 'https://gitlab.com/acme/repo.git',
          defaultBranch: 'main'
        },
        globalSettings: {
          workflow: 'local',
          provider: 'github',
          remoteUrl: '',
          defaultBranch: 'main'
        }
      })
    }));

    const user = userEvent.setup();
    render(<GitTab />);

    const branchInput = screen.getByTestId('project-default-branch');
    await user.clear(branchInput);
    await user.type(branchInput, 'release');
    await user.click(screen.getByTestId('git-update-default-branch'));

    await waitFor(() => {
      expect(updateProjectGitSettings).toHaveBeenCalledWith('proj-1', {
        workflow: 'cloud',
        provider: 'gitlab',
        remoteUrl: 'https://gitlab.com/acme/repo.git',
        defaultBranch: 'release'
      });
    });
  });

  test('renders with missing project git status map', () => {
    useAppState.mockReturnValue(buildContext({ projectGitStatus: undefined }));

    render(<GitTab />);

    expect(screen.getByTestId('git-repo-pane')).toBeInTheDocument();
  });

  test('blocks repo creation when global token is missing', async () => {
    useAppState.mockReturnValue(buildContext({
      gitSettings: { workflow: 'cloud', provider: 'github', tokenPresent: false },
      gitConnectionStatus: { provider: '', account: null, message: '', testedAt: '' }
    }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('git-show-remote-creator'));
    await user.click(screen.getByTestId('git-create-remote-button'));

    expect(await screen.findByTestId('git-global-connection-alert')).toBeInTheDocument();
  });

  test('shows remote creator error when global connection is not configured', async () => {
    useAppState.mockReturnValue(buildContext({
      gitSettings: { workflow: 'cloud', provider: 'github', tokenPresent: false },
      gitConnectionStatus: { provider: '', account: null, message: '', testedAt: '' }
    }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('project-connection-global'));
    await user.click(screen.getByTestId('git-show-remote-creator'));
    await user.click(screen.getByTestId('git-create-remote-button'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Global connection is not configured');
  });

  test('blocks repo creation when global connection is missing', async () => {
    useAppState.mockReturnValue(buildContext({
      gitSettings: { workflow: 'cloud', provider: 'github', tokenPresent: false },
      gitConnectionStatus: { provider: '', account: null, message: '', testedAt: '' }
    }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('project-connection-global'));
    await user.click(screen.getByTestId('git-show-remote-creator'));
    await user.click(screen.getByTestId('git-create-remote-button'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Global connection is not configured');
  });

  test('checkout branch reports success and refreshes status', async () => {
    const checkoutProjectBranch = vi.fn().mockResolvedValue({ success: true });
    const fetchProjectGitStatus = vi.fn().mockResolvedValue({});
    const fetchProjectBranchesOverview = vi.fn().mockResolvedValue({
      branches: [{ name: 'main' }],
      current: 'main'
    });
    useAppState.mockReturnValue(buildContext({
      checkoutProjectBranch,
      fetchProjectGitStatus,
      fetchProjectBranchesOverview
    }));

    const user = userEvent.setup();
    render(<GitTab />);

    await waitFor(() => {
      expect(screen.getByTestId('git-checkout-branch-select')).toHaveValue('main');
    });
    await user.click(screen.getByTestId('git-checkout-branch'));

    expect(await screen.findByText('Checked out main.')).toBeInTheDocument();
    expect(fetchProjectGitStatus).toHaveBeenCalledWith('proj-1');
  });

  test('checkout branch falls back to default error message', async () => {
    const checkoutProjectBranch = vi.fn().mockRejectedValue({});
    const fetchProjectBranchesOverview = vi.fn().mockResolvedValue({
      branches: [{ name: 'main' }],
      current: 'main'
    });
    useAppState.mockReturnValue(buildContext({
      checkoutProjectBranch,
      fetchProjectBranchesOverview
    }));

    const user = userEvent.setup();
    render(<GitTab />);

    await waitFor(() => {
      expect(screen.getByTestId('git-checkout-branch-select')).toHaveValue('main');
    });
    await user.click(screen.getByTestId('git-checkout-branch'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to checkout branch.');
  });

  test('shows initialization error when initial push fails', async () => {
    const createProjectRemoteRepository = vi.fn().mockResolvedValue({
      success: true,
      repository: { remoteUrl: 'https://github.com/lucid/new.git' },
      projectSettings: {
        workflow: 'cloud',
        provider: 'github',
        remoteUrl: 'https://github.com/lucid/new.git',
        defaultBranch: 'main'
      },
      initialization: { success: false, error: 'Push failed' }
    });

    useAppState.mockReturnValue(buildContext({ createProjectRemoteRepository }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('project-connection-custom'));
    await user.type(screen.getByTestId('project-token'), 'ghp_newtoken');
    await user.click(screen.getByTestId('git-show-remote-creator'));
    await user.click(screen.getByTestId('git-create-remote-button'));

    expect(await screen.findByRole('alert')).toHaveTextContent('initial push failed');
  });

  test('shows fallback success copy when no commits are pushed', async () => {
    const createProjectRemoteRepository = vi.fn().mockResolvedValue({
      success: true,
      repository: { remoteUrl: 'https://github.com/lucid/new.git' },
      projectSettings: {
        workflow: 'cloud',
        provider: 'github',
        remoteUrl: 'https://github.com/lucid/new.git',
        defaultBranch: 'main'
      },
      initialization: { success: true, pushed: false }
    });

    useAppState.mockReturnValue(buildContext({ createProjectRemoteRepository }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('project-connection-custom'));
    await user.type(screen.getByTestId('project-token'), 'ghp_newtoken');
    await user.click(screen.getByTestId('git-show-remote-creator'));
    await user.click(screen.getByTestId('git-create-remote-button'));

    expect(await screen.findByText(/No commits were pushed yet/i)).toBeInTheDocument();
  });

  test('uses initialization message when provided for no-commit push', async () => {
    const createProjectRemoteRepository = vi.fn().mockResolvedValue({
      success: true,
      repository: { remoteUrl: 'https://github.com/lucid/new.git' },
      projectSettings: {
        workflow: 'cloud',
        provider: 'github',
        remoteUrl: 'https://github.com/lucid/new.git',
        defaultBranch: 'main'
      },
      initialization: { success: true, pushed: false, message: 'Push commits when ready.' }
    });

    useAppState.mockReturnValue(buildContext({ createProjectRemoteRepository }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('project-connection-custom'));
    await user.type(screen.getByTestId('project-token'), 'ghp_newtoken');
    await user.click(screen.getByTestId('git-show-remote-creator'));
    await user.click(screen.getByTestId('git-create-remote-button'));

    expect(await screen.findByText('Repository created. Push commits when ready.')).toBeInTheDocument();
  });

  test('renders repo status details when status is available', () => {
    useAppState.mockReturnValue(buildContext({
      projectGitStatus: {
        'proj-1': {
          hasRemote: true,
          branch: 'main',
          ahead: 2,
          behind: 1
        }
      }
    }));

    render(<GitTab />);

    expect(screen.getByText('Ahead')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('Behind')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  test('shows error banner when pull fails', async () => {
    const pullProjectGitRemote = vi.fn().mockRejectedValue(new Error('Blocked'));
    useAppState.mockReturnValue(buildContext({ pullProjectGitRemote }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('git-pull-remote'));

    expect(await screen.findByText('Blocked')).toBeInTheDocument();
  });

  test('shows success banner when pull completes', async () => {
    const pullProjectGitRemote = vi.fn().mockResolvedValue({
      status: { branch: 'main', ahead: 0, behind: 0, hasRemote: true },
      strategy: 'ff-only'
    });
    useAppState.mockReturnValue(buildContext({ pullProjectGitRemote }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('git-pull-remote'));

    expect(await screen.findByText(/fast-forward/i)).toBeInTheDocument();
  });

  test('remote creation helper triggers backend call', async () => {
    const createProjectRemoteRepository = vi.fn().mockResolvedValue({
      success: true,
      repository: { remoteUrl: 'https://github.com/lucid/new.git' },
      projectSettings: {
        workflow: 'cloud',
        provider: 'github',
        remoteUrl: 'https://github.com/lucid/new.git',
        defaultBranch: 'main'
      }
    });
    useAppState.mockReturnValue(buildContext({ createProjectRemoteRepository }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('project-connection-custom'));
    await user.type(screen.getByTestId('project-token'), 'ghp_newtoken');
    await user.click(screen.getByTestId('git-show-remote-creator'));
    const repoNameInput = screen.getByTestId('git-remote-create-name');
    await user.clear(repoNameInput);
    await user.type(repoNameInput, 'lucid-new');
    await user.click(screen.getByTestId('git-create-remote-button'));

    expect(createProjectRemoteRepository).toHaveBeenCalledWith(
      'proj-1',
      expect.objectContaining({
        name: 'lucid-new',
        token: 'ghp_newtoken'
      })
    );

    await waitFor(() => {
      expect(screen.getByTestId('project-remote-url')).toHaveValue('https://github.com/lucid/new.git');
    });
    expect(screen.getByText('Repository created and linked.')).toBeInTheDocument();
  });

  test('remote creation falls back to main branch when field is blank', async () => {
    const createProjectRemoteRepository = vi.fn().mockResolvedValue({ success: true });
    useAppState.mockReturnValue(buildContext({ createProjectRemoteRepository }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('project-connection-custom'));
    await user.clear(screen.getByTestId('project-default-branch'));
    await user.type(screen.getByTestId('project-token'), 'ghp_branchless');
    await user.click(screen.getByTestId('git-show-remote-creator'));
    await user.click(screen.getByTestId('git-create-remote-button'));

    await waitFor(() => {
      expect(createProjectRemoteRepository).toHaveBeenCalledWith(
        'proj-1',
        expect.objectContaining({ defaultBranch: 'main' })
      );
    });
  });

  test('uses repository URL when backend omits updated settings', async () => {
    const createProjectRemoteRepository = vi.fn().mockResolvedValue({
      success: true,
      repository: { remoteUrl: 'https://gitlab.com/demo/solo.git' }
    });
    useAppState.mockReturnValue(buildContext({ createProjectRemoteRepository }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('project-connection-custom'));
    await user.type(screen.getByTestId('project-token'), 'ghp_repoonly');
    await user.click(screen.getByTestId('git-show-remote-creator'));
    await user.click(screen.getByTestId('git-create-remote-button'));

    await waitFor(() => {
      expect(screen.getByTestId('project-remote-url')).toHaveValue('https://gitlab.com/demo/solo.git');
    });
  });

  test('still switches workflow to cloud when backend omits remote details', async () => {
    const createProjectRemoteRepository = vi.fn().mockResolvedValue({ success: true });
    useAppState.mockReturnValue(buildContext({ createProjectRemoteRepository }));

    const user = userEvent.setup();
    render(<GitTab />);

    const remoteInput = screen.getByTestId('project-remote-url');
    await user.clear(remoteInput);
    expect(remoteInput).toHaveValue('');

    await user.click(screen.getByTestId('git-show-remote-creator'));
    await user.click(screen.getByTestId('git-create-remote-button'));

    await waitFor(() => {
      expect(createProjectRemoteRepository).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByTestId('project-connection-global')).toBeChecked();
    expect(screen.getByTestId('project-remote-url')).toHaveValue('');
    expect(screen.getByText('Repository created and linked.')).toBeInTheDocument();
  });

  test('requires a token before creating a remote repository', async () => {
    const createProjectRemoteRepository = vi.fn();
    useAppState.mockReturnValue(buildContext({ createProjectRemoteRepository }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('project-connection-custom'));
    await user.click(screen.getByTestId('git-show-remote-creator'));
    await user.click(screen.getByTestId('git-create-remote-button'));

    expect(createProjectRemoteRepository).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a personal access token');
  });

  test('surfaces errors when remote creation fails', async () => {
    const createProjectRemoteRepository = vi.fn().mockRejectedValue(new Error('Git host unreachable'));
    useAppState.mockReturnValue(buildContext({ createProjectRemoteRepository }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('project-connection-custom'));
    await user.type(screen.getByTestId('project-token'), 'ghp_error');
    await user.click(screen.getByTestId('git-show-remote-creator'));
    await user.click(screen.getByTestId('git-create-remote-button'));

    expect(createProjectRemoteRepository).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('alert')).toHaveTextContent('Git host unreachable');
  });

  test('remote creation error falls back to default copy when message missing', async () => {
    const createProjectRemoteRepository = vi.fn().mockRejectedValue({});
    useAppState.mockReturnValue(buildContext({ createProjectRemoteRepository }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('project-connection-custom'));
    await user.type(screen.getByTestId('project-token'), 'ghp_errorless');
    await user.click(screen.getByTestId('git-show-remote-creator'));
    await user.click(screen.getByTestId('git-create-remote-button'));

    expect(createProjectRemoteRepository).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to create remote repository.');
  });

  test('displays inline error when saving settings fails', async () => {
    const updateProjectGitSettings = vi.fn().mockRejectedValue(new Error('Unable to update settings'));
    useAppState.mockReturnValue(buildContext({ updateProjectGitSettings }));

    const user = userEvent.setup();
    render(<GitTab />);

    const remoteInput = screen.getByTestId('project-remote-url');
    await user.clear(remoteInput);
    await user.type(remoteInput, 'https://github.com/lucid/error.git');
    await user.click(screen.getByTestId('project-connection-custom'));
    await user.type(screen.getByTestId('project-token'), 'ghp_savetoken');

    await user.click(screen.getByTestId('git-save-preferences'));

    await waitFor(() => {
      expect(updateProjectGitSettings).toHaveBeenCalledWith(
        'proj-1',
        expect.objectContaining({
          remoteUrl: 'https://github.com/lucid/error.git',
          token: 'ghp_savetoken'
        })
      );
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to update settings');
  });

  test('save error falls back to default message when backend omits reason', async () => {
    const updateProjectGitSettings = vi.fn().mockRejectedValue({});
    useAppState.mockReturnValue(buildContext({ updateProjectGitSettings }));

    const user = userEvent.setup();
    render(<GitTab />);

    const remoteInput = screen.getByTestId('project-remote-url');
    await user.clear(remoteInput);
    await user.type(remoteInput, 'https://github.com/lucid/failure.git');
    await user.click(screen.getByTestId('git-save-preferences'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to save project git settings');
  });

  test('remote helper describes GitLab API usage when provider changes', async () => {
    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('project-connection-custom'));
    await user.selectOptions(screen.getByTestId('project-provider-select'), 'gitlab');
    await user.type(screen.getByTestId('project-token'), 'glpat_token');
    await user.click(screen.getByTestId('git-show-remote-creator'));

    expect(screen.getByText(/GitLab APIs securely/)).toBeInTheDocument();
  });

});
