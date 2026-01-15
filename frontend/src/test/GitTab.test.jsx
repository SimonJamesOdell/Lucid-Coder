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
    getEffectiveGitSettings: vi.fn().mockReturnValue({
      workflow: 'cloud',
      provider: 'github',
      remoteUrl: 'https://github.com/lucid/repo.git',
      defaultBranch: 'main',
      autoPush: true,
      useCommitTemplate: false,
      commitTemplate: ''
    }),
    getProjectGitSettingsSnapshot: vi.fn().mockReturnValue({
      inheritsFromGlobal: false,
      effectiveSettings: {
        workflow: 'cloud',
        provider: 'github',
        remoteUrl: 'https://github.com/lucid/repo.git',
        defaultBranch: 'main',
        autoPush: true,
        useCommitTemplate: false,
        commitTemplate: ''
      },
      projectSettings: {
        workflow: 'cloud',
        provider: 'github',
        remoteUrl: 'https://github.com/lucid/repo.git',
        defaultBranch: 'main',
        autoPush: true,
        useCommitTemplate: false,
        commitTemplate: ''
      },
      globalSettings: {
        workflow: 'local',
        provider: 'github',
        remoteUrl: '',
        defaultBranch: 'main',
        autoPush: false,
        useCommitTemplate: false,
        commitTemplate: ''
      }
    }),
    updateProjectGitSettings: vi.fn().mockResolvedValue({}),
    clearProjectGitSettings: vi.fn().mockResolvedValue({}),
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
    const clearProjectGitSettings = vi.fn().mockResolvedValue({});
    useAppState.mockReturnValue(buildContext({ clearProjectGitSettings }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('git-reset-overrides'));
    expect(clearProjectGitSettings).toHaveBeenCalledWith('proj-1');
  });

  test('shows error when resetting overrides fails', async () => {
    const clearProjectGitSettings = vi.fn().mockRejectedValue(new Error('Reset failed'));
    useAppState.mockReturnValue(buildContext({ clearProjectGitSettings }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('git-reset-overrides'));

    expect(clearProjectGitSettings).toHaveBeenCalledWith('proj-1');
    expect(await screen.findByRole('alert')).toHaveTextContent('Reset failed');
  });

  test('reset override errors fall back to default copy when message missing', async () => {
    const clearProjectGitSettings = vi.fn().mockRejectedValue({});
    useAppState.mockReturnValue(buildContext({ clearProjectGitSettings }));

    const user = userEvent.setup();
    render(<GitTab />);

    await user.click(screen.getByTestId('git-reset-overrides'));

    expect(clearProjectGitSettings).toHaveBeenCalledWith('proj-1');
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to reset project git settings');
  });

  test('shows inheritance indicator when using global settings', () => {
    const getProjectGitSettingsSnapshot = vi.fn().mockReturnValue({
      inheritsFromGlobal: true,
      effectiveSettings: {
        workflow: 'local',
        provider: 'github',
        remoteUrl: '',
        defaultBranch: 'main',
        autoPush: false,
        useCommitTemplate: false,
        commitTemplate: ''
      },
      projectSettings: null,
      globalSettings: {
        workflow: 'local',
        provider: 'github',
        remoteUrl: '',
        defaultBranch: 'main',
        autoPush: false,
        useCommitTemplate: false,
        commitTemplate: ''
      }
    });
    useAppState.mockReturnValue(buildContext({ getProjectGitSettingsSnapshot }));

    render(<GitTab />);

    expect(screen.getByTestId('git-inheritance-indicator')).toHaveTextContent('Using global defaults');
    expect(screen.queryByTestId('git-reset-overrides')).not.toBeInTheDocument();
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

    expect(screen.getByText('Local workspace')).toBeInTheDocument();
    expect(screen.getByText('Not connected')).toBeInTheDocument();
    expect(screen.getByText('Work stays on your machine until you hook up a remote host.')).toBeInTheDocument();
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

    const providerLabel = screen.getByText(
      (content, element) => content === 'Provider' && element?.classList?.contains('label')
    );
    expect(providerLabel.nextElementSibling).toHaveTextContent('GitLab');
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

    expect(screen.getByText('Add a remote URL to complete the connection for this project.')).toBeInTheDocument();
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

    const statusLabel = screen.getByText(
      (content, element) => content === 'Default branch' && element?.classList?.contains('label')
    );
    expect(statusLabel.nextElementSibling).toHaveTextContent('main');
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

    await user.type(screen.getByTestId('project-token'), 'ghp_missing');
    await user.click(screen.getByTestId('git-show-remote-creator'));
    await user.click(screen.getByTestId('git-create-remote-button'));

    await waitFor(() => {
      expect(createProjectRemoteRepository).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByTestId('project-workflow-cloud')).toBeChecked();
    expect(screen.getByTestId('project-remote-url')).toHaveValue('');
    expect(screen.getByText('Repository created and linked.')).toBeInTheDocument();
  });

  test('requires a token before creating a remote repository', async () => {
    const createProjectRemoteRepository = vi.fn();
    useAppState.mockReturnValue(buildContext({ createProjectRemoteRepository }));

    const user = userEvent.setup();
    render(<GitTab />);

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

    await user.selectOptions(screen.getByTestId('project-provider-select'), 'gitlab');
    await user.type(screen.getByTestId('project-token'), 'glpat_token');
    await user.click(screen.getByTestId('git-show-remote-creator'));

    expect(screen.getByText(/GitLab APIs securely/)).toBeInTheDocument();
  });

});
