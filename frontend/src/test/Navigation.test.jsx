import { describe, test, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Navigation from '../components/Navigation';
import { useAppState } from '../context/AppStateContext';
import { VERSION } from '../../../shared/version.mjs';

vi.mock('../context/AppStateContext', () => ({
  useAppState: vi.fn()
}));

const defaultGitSettings = {
  workflow: 'local',
  provider: 'github',
  remoteUrl: '',
  username: '',
  token: '',
  defaultBranch: 'main'
};

const baseState = () => ({
  isLLMConfigured: true,
  currentProject: null,
  projects: [],
  canUseProjects: true,
  canUseTools: true,
  canUseSettings: true,
  theme: 'dark',
  configureLLM: vi.fn(),
  selectProject: vi.fn(),
  closeProject: vi.fn(),
  createProject: vi.fn().mockResolvedValue({ id: 'proj-1', name: 'Created Project' }),
  importProject: vi.fn(),
  showCreateProject: vi.fn(),
  showImportProject: vi.fn(),
  toggleTheme: vi.fn(),
  setPreviewPanelTab: vi.fn(),
  gitSettings: defaultGitSettings,
  gitConnectionStatus: { provider: '', account: null, message: '', testedAt: '' },
  projectGitSettings: {},
  updateGitSettings: vi.fn(),
  testGitConnection: vi.fn(),
  updateProjectGitSettings: vi.fn(),
  getEffectiveGitSettings: vi.fn().mockReturnValue(defaultGitSettings),
  portSettings: {
    frontendPortBase: 6100,
    backendPortBase: 6500
  },
  updatePortSettings: vi.fn().mockResolvedValue(undefined),
  testingSettings: {
    coverageTarget: 100
  },
  updateTestingSettings: vi.fn().mockResolvedValue(undefined),
  projectShutdownState: {
    isStopping: false,
    projectId: null,
    projectName: '',
    startedAt: null,
    error: null
  }
});

const renderNavigation = (overrides = {}) => {
  const state = { ...baseState(), ...overrides };
  useAppState.mockReturnValue(state);
  const user = userEvent.setup();
  render(<Navigation />);
  return { state, user };
};

beforeEach(() => {
  vi.clearAllMocks();
  useAppState.mockReset();
});

describe('Navigation Component', () => {
  test('renders navigation title', () => {
    renderNavigation();

    expect(screen.getByText('Lucid Coder')).toBeInTheDocument();
  });

  test('renders version badge when provided', () => {
    useAppState.mockReturnValue(baseState());
    render(<Navigation versionLabel={VERSION} />);

    expect(screen.getByTestId('nav-version')).toHaveTextContent(`v${VERSION}`);
  });

  test('shows disabled dropdowns when LLM not configured', () => {
    renderNavigation({
      isLLMConfigured: false,
      canUseProjects: false,
      canUseSettings: false,
      canUseTools: false
    });

    expect(screen.getByRole('button', { name: /Projects/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Settings/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Tools/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /LLM Usage/ })).toBeDisabled();
  });

  test('LLM usage nav button opens the LLM usage preview tab', async () => {
    const setPreviewPanelTab = vi.fn();
    const { user, state } = renderNavigation({
      canUseTools: true,
      currentProject: { id: 'p-1', name: 'Alpha Project' },
      setPreviewPanelTab
    });

    await user.click(screen.getByTestId('nav-llm-usage'));

    expect(state.setPreviewPanelTab).toHaveBeenCalledWith(
      'llm-usage',
      expect.objectContaining({ source: 'user' })
    );
  });

  test('shows theme toggle button', () => {
    renderNavigation();

    expect(screen.getByTitle('Switch to light mode')).toBeInTheDocument();
  });

  test('displays current project name', () => {
    renderNavigation({ currentProject: { id: 'p-1', name: 'Alpha Project' } });

    expect(screen.getByText('Alpha Project')).toBeInTheDocument();
  });

  test('shows "No Project Selected" when no project is active', () => {
    renderNavigation();

    expect(screen.getByText('No Project Selected')).toBeInTheDocument();
  });

  test('theme toggle works correctly', async () => {
    const { state, user } = renderNavigation();

    await user.click(screen.getByTitle('Switch to light mode'));

    expect(state.toggleTheme).toHaveBeenCalledTimes(1);
  });

  test('projects dropdown shows correct content when enabled', async () => {
    const projects = [
      { id: 'p-1', name: 'Project Alpha' },
      { id: 'p-2', name: 'Project Beta' }
    ];
    const { user } = renderNavigation({ projects });

    await user.click(screen.getByRole('button', { name: /Projects/ }));

    expect(screen.getByText(/Select Project/i)).toBeInTheDocument();
    expect(screen.getByText('Project Alpha')).toBeInTheDocument();
    expect(screen.getByText('Project Beta')).toBeInTheDocument();
    expect(screen.getByText('Add project')).toBeInTheDocument();
  });

  test('settings dropdown shows correct content when enabled', async () => {
    const { user } = renderNavigation();

    await user.click(screen.getByRole('button', { name: /Settings/ }));

    expect(screen.getByText('Configure LLM')).toBeInTheDocument();
    expect(screen.getByText('Configure Git')).toBeInTheDocument();
    expect(screen.getByText('Ports')).toBeInTheDocument();
    expect(screen.getByText('Configure Testing')).toBeInTheDocument();
  });

  test('configure LLM option opens configuration modal', async () => {
    const { user } = renderNavigation();

    await user.click(screen.getByRole('button', { name: /Settings/ }));
    await user.click(screen.getByText('Configure LLM'));

    const modal = await screen.findByTestId('llm-config-modal');
    expect(modal).toBeInTheDocument();
    expect(screen.getByText('Configure LLM')).toBeInTheDocument();
  });

  test('LLM configuration modal can be dismissed', async () => {
    const { user } = renderNavigation();

    await user.click(screen.getByRole('button', { name: /Settings/ }));
    await user.click(screen.getByText('Configure LLM'));

    const modal = await screen.findByTestId('llm-config-modal');
    expect(modal).toBeInTheDocument();

    await user.click(screen.getByTestId('llm-config-close'));

    await waitFor(() => {
      expect(screen.queryByTestId('llm-config-modal')).not.toBeInTheDocument();
    });
  });

  test('git settings modal lets users update workflow preferences', async () => {
    const { user, state } = renderNavigation();
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    await user.click(screen.getByRole('button', { name: /Settings/ }));
    await user.click(screen.getByText('Configure Git'));

    const modal = await screen.findByTestId('git-settings-modal');
    expect(modal).toBeInTheDocument();

    await user.click(screen.getByTestId('git-workflow-cloud'));
    await user.selectOptions(screen.getByTestId('git-provider-select'), 'gitlab');
    const branchInput = screen.getByTestId('git-default-branch');
    await user.clear(branchInput);
    await user.type(branchInput, 'develop');

    await user.click(screen.getByTestId('git-save-button'));

    expect(state.updateGitSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'cloud',
        provider: 'gitlab',
        defaultBranch: 'develop'
      })
    );

    alertSpy.mockRestore();
  });

  test('git settings modal registers connection status after test', async () => {
    const testGitConnection = vi.fn().mockResolvedValue({
      account: { login: 'octo' },
      message: 'Connected to GitHub'
    });
    const registerGitConnectionStatus = vi.fn();
    const { user } = renderNavigation({ testGitConnection, registerGitConnectionStatus });

    await user.click(screen.getByRole('button', { name: /Settings/ }));
    await user.click(screen.getByText('Configure Git'));

    await user.click(screen.getByTestId('git-workflow-cloud'));
    await user.click(screen.getByTestId('git-test-connection'));

    await waitFor(() => {
      expect(testGitConnection).toHaveBeenCalledWith(expect.objectContaining({ provider: 'github', token: '' }));
    });
    expect(registerGitConnectionStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'github',
        message: 'Connected to GitHub',
        testedAt: expect.any(String)
      })
    );
  });

  test('git settings event opens the modal', async () => {
    renderNavigation();

    window.dispatchEvent(new CustomEvent('lucidcoder:open-git-settings'));

    expect(await screen.findByTestId('git-settings-modal')).toBeInTheDocument();
  });

  test('git settings modal uses default alert message when error has no message', async () => {
    const updateGitSettings = vi.fn().mockRejectedValue({});
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { user } = renderNavigation({ updateGitSettings });

    await user.click(screen.getByRole('button', { name: /Settings/ }));
    await user.click(screen.getByText('Configure Git'));

    await user.click(screen.getByTestId('git-save-button'));

    await waitFor(() => {
      expect(alertSpy).toHaveBeenCalledWith('Failed to update git settings. Please try again.');
    });

    consoleError.mockRestore();
    alertSpy.mockRestore();
  });

  test('git connection status uses provider fallback when response omits details', async () => {
    const testGitConnection = vi.fn().mockResolvedValue({});
    const registerGitConnectionStatus = vi.fn();
    const { user } = renderNavigation({ testGitConnection, registerGitConnectionStatus });

    await user.click(screen.getByRole('button', { name: /Settings/ }));
    await user.click(screen.getByText('Configure Git'));

    await user.click(screen.getByTestId('git-workflow-cloud'));
    await user.selectOptions(screen.getByTestId('git-provider-select'), 'gitlab');
    await user.click(screen.getByTestId('git-test-connection'));

    await waitFor(() => {
      expect(registerGitConnectionStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'gitlab',
          account: null,
          message: 'Connected'
        })
      );
    });
  });


  test('git settings modal surfaces save errors to the user', async () => {
    const updateGitSettings = vi.fn().mockRejectedValue(new Error('Network down'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const { user } = renderNavigation({ updateGitSettings });

    await user.click(screen.getByRole('button', { name: /Settings/ }));
    await user.click(screen.getByText('Configure Git'));

    const saveButton = await screen.findByTestId('git-save-button');
    await user.click(saveButton);

    await waitFor(() => expect(updateGitSettings).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith('Network down')
    );
    expect(consoleError).toHaveBeenCalledWith('Failed to update git settings', expect.any(Error));

    consoleError.mockRestore();
    alertSpy.mockRestore();
  });

  test('port settings modal opens from settings menu', async () => {
    const { user } = renderNavigation();

    await user.click(screen.getByRole('button', { name: /Settings/ }));
    await user.click(screen.getByText('Ports'));

    const modal = await screen.findByTestId('port-settings-modal');
    expect(modal).toBeInTheDocument();
    expect(screen.getByDisplayValue('6100')).toBeInTheDocument();
    expect(screen.getByDisplayValue('6500')).toBeInTheDocument();
  });

  test('port settings modal saves updates via context action', async () => {
    const updatePortSettings = vi.fn().mockResolvedValue(undefined);
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const { user, state } = renderNavigation({ updatePortSettings });

    await user.click(screen.getByRole('button', { name: /Settings/ }));
    await user.click(screen.getByText('Ports'));

    const frontendInput = await screen.findByTestId('port-frontend-input');
    const backendInput = await screen.findByTestId('port-backend-input');

    await user.clear(frontendInput);
    await user.type(frontendInput, '5200');
    await user.clear(backendInput);
    await user.type(backendInput, '5400');

    await user.click(screen.getByTestId('port-settings-save'));

    expect(state.updatePortSettings).toHaveBeenCalledWith({
      frontendPortBase: 5200,
      backendPortBase: 5400
    });

    alertSpy.mockRestore();
  });

  test('port settings modal can be dismissed with the close button', async () => {
    const { user } = renderNavigation();

    await user.click(screen.getByRole('button', { name: /Settings/ }));
    await user.click(screen.getByText('Ports'));

    await screen.findByTestId('port-settings-modal');
    await user.click(screen.getByTestId('port-settings-close'));

    await waitFor(() => {
      expect(screen.queryByTestId('port-settings-modal')).not.toBeInTheDocument();
    });
  });

  test('port settings modal surfaces save errors to the user', async () => {
    const updatePortSettings = vi.fn().mockRejectedValue(new Error('Ports locked'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const { user } = renderNavigation({ updatePortSettings });

    await user.click(screen.getByRole('button', { name: /Settings/ }));
    await user.click(screen.getByText('Ports'));

    const saveButton = await screen.findByTestId('port-settings-save');
    await user.click(saveButton);

    await waitFor(() => expect(updatePortSettings).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Ports locked'));
    expect(consoleError).toHaveBeenCalledWith('Failed to update port settings', expect.any(Error));

    consoleError.mockRestore();
    alertSpy.mockRestore();
  });

  test('port settings modal shows default error message when error has no detail', async () => {
    const updatePortSettings = vi.fn().mockRejectedValue({});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const { user } = renderNavigation({ updatePortSettings });

    await user.click(screen.getByRole('button', { name: /Settings/ }));
    await user.click(screen.getByText('Ports'));

    const saveButton = await screen.findByTestId('port-settings-save');
    await user.click(saveButton);

    await waitFor(() => expect(updatePortSettings).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith('Failed to update port settings. Please try again.')
    );
    expect(consoleError).toHaveBeenCalledWith('Failed to update port settings', expect.any(Object));

    consoleError.mockRestore();
    alertSpy.mockRestore();
  });

  test('testing settings modal opens from settings menu', async () => {
    const { user } = renderNavigation();

    await user.click(screen.getByRole('button', { name: /Settings/ }));
    await user.click(screen.getByText('Configure Testing'));

    const modal = await screen.findByTestId('testing-settings-modal');
    expect(modal).toBeInTheDocument();
    expect(screen.getByTestId('testing-coverage-value')).toHaveTextContent('100%');
  });

  test('testing settings modal saves updates via context action', async () => {
    const updateTestingSettings = vi.fn().mockResolvedValue(undefined);
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const { user, state } = renderNavigation({ updateTestingSettings });

    await user.click(screen.getByRole('button', { name: /Settings/ }));
    await user.click(screen.getByText('Configure Testing'));

    const slider = await screen.findByTestId('testing-coverage-slider');
    fireEvent.change(slider, { target: { value: '70' } });
    await user.click(screen.getByTestId('testing-settings-save'));

    expect(state.updateTestingSettings).toHaveBeenCalledWith({ coverageTarget: 70 });

    alertSpy.mockRestore();
  });

  test('testing settings modal surfaces save errors to the user', async () => {
    const updateTestingSettings = vi.fn().mockRejectedValue(new Error('Testing settings locked'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const { user } = renderNavigation({ updateTestingSettings });

    await user.click(screen.getByRole('button', { name: /Settings/ }));
    await user.click(screen.getByText('Configure Testing'));

    const saveButton = await screen.findByTestId('testing-settings-save');
    await user.click(saveButton);

    await waitFor(() => expect(updateTestingSettings).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Testing settings locked'));
    expect(consoleError).toHaveBeenCalledWith('Failed to update testing settings', expect.any(Error));

    consoleError.mockRestore();
    alertSpy.mockRestore();
  });

  test('testing settings modal shows default error message when error has no detail', async () => {
    const updateTestingSettings = vi.fn().mockRejectedValue({});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const { user } = renderNavigation({ updateTestingSettings });

    await user.click(screen.getByRole('button', { name: /Settings/ }));
    await user.click(screen.getByText('Configure Testing'));

    const saveButton = await screen.findByTestId('testing-settings-save');
    await user.click(saveButton);

    await waitFor(() => expect(updateTestingSettings).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith('Failed to update testing settings. Please try again.')
    );
    expect(consoleError).toHaveBeenCalledWith('Failed to update testing settings', expect.any(Object));

    consoleError.mockRestore();
    alertSpy.mockRestore();
  });

  test('testing settings modal can be closed with the header button', async () => {
    const { user } = renderNavigation();

    await user.click(screen.getByRole('button', { name: /Settings/ }));
    await user.click(screen.getByText('Configure Testing'));

    await screen.findByTestId('testing-settings-modal');
    await user.click(screen.getByTestId('testing-settings-close'));

    await waitFor(() => {
      expect(screen.queryByTestId('testing-settings-modal')).not.toBeInTheDocument();
    });
  });

  test('tools dropdown shows correct content when enabled', async () => {
    const { user } = renderNavigation();

    await user.click(screen.getByRole('button', { name: /Tools/ }));

    expect(screen.getByText('Clean Up')).toBeInTheDocument();
    expect(screen.getByText('Refactor')).toBeInTheDocument();
    expect(screen.getByText('Add Tests')).toBeInTheDocument();
    expect(screen.getByText('Audit Security')).toBeInTheDocument();
  });

  test('tool actions open and close their modals', async () => {
    const { user } = renderNavigation();

    await user.click(screen.getByRole('button', { name: /Tools/ }));
    await user.click(screen.getByText('Clean Up'));

    expect(await screen.findByTestId('tool-cleanup-modal')).toBeInTheDocument();
    await user.click(screen.getByTestId('tool-cleanup-close'));
    await waitFor(() => {
      expect(screen.queryByTestId('tool-cleanup-modal')).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Tools/ }));
    await user.click(screen.getByText('Refactor'));

    expect(await screen.findByTestId('tool-refactor-modal')).toBeInTheDocument();
    await user.click(screen.getByTestId('tool-refactor-close'));
    await waitFor(() => {
      expect(screen.queryByTestId('tool-refactor-modal')).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Tools/ }));
    await user.click(screen.getByText('Add Tests'));

    expect(await screen.findByTestId('tool-add-tests-modal')).toBeInTheDocument();
    await user.click(screen.getByTestId('tool-add-tests-close'));
    await waitFor(() => {
      expect(screen.queryByTestId('tool-add-tests-modal')).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Tools/ }));
    await user.click(screen.getByText('Audit Security'));

    expect(await screen.findByTestId('tool-audit-security-modal')).toBeInTheDocument();
    await user.click(screen.getByTestId('tool-audit-security-close'));
    await waitFor(() => {
      expect(screen.queryByTestId('tool-audit-security-modal')).not.toBeInTheDocument();
    });
  });

  test('opens Clean Up modal when lucidcoder:open-cleanup-tool fires', async () => {
    renderNavigation();

    expect(screen.queryByTestId('tool-cleanup-modal')).not.toBeInTheDocument();

    window.dispatchEvent(new CustomEvent('lucidcoder:open-cleanup-tool'));

    await waitFor(() => {
      expect(screen.getByTestId('tool-cleanup-modal')).toBeInTheDocument();
    });
  });

  test('create project triggers the create project view', async () => {
    const showCreateProject = vi.fn();
    const closeProject = vi.fn();
    const { user } = renderNavigation({ showCreateProject, closeProject });

    await user.click(screen.getByRole('button', { name: /Projects/ }));
    await user.click(screen.getByText('Add project'));

    expect(closeProject).not.toHaveBeenCalled();
    expect(showCreateProject).toHaveBeenCalledTimes(1);
  });

  test('create project closes the active project before showing the view', async () => {
    const closeProject = vi.fn().mockResolvedValue(undefined);
    const showCreateProject = vi.fn();
    const { user } = renderNavigation({
      currentProject: { id: 'p-1', name: 'Alpha Project' },
      closeProject,
      showCreateProject
    });

    await user.click(screen.getByRole('button', { name: /Projects/ }));
    await user.click(screen.getByText('Add project'));

    await waitFor(() => expect(showCreateProject).toHaveBeenCalled());
    expect(closeProject).toHaveBeenCalledTimes(1);
    expect(closeProject.mock.invocationCallOrder[0]).toBeLessThan(showCreateProject.mock.invocationCallOrder[0]);
  });

  test('add project triggers the create project view', async () => {
    const { user, state } = renderNavigation();

    await user.click(screen.getByRole('button', { name: /Projects/ }));
    await user.click(screen.getByText('Add project'));

    expect(state.showCreateProject).toHaveBeenCalled();
  });

  test('shows close project button when project is selected', () => {
    renderNavigation({ currentProject: { id: 'p-5', name: 'Active Project' } });

    expect(screen.getByLabelText('Close project')).toBeInTheDocument();
  });

  test('does not show close project button when no project is selected', () => {
    renderNavigation();

    expect(screen.queryByLabelText('Close project')).not.toBeInTheDocument();
  });

  test('close project button is positioned correctly next to project name', () => {
    renderNavigation({ currentProject: { id: 'p-9', name: 'Project Nebula' } });

    const title = screen.getByText('Project Nebula');
    const closeButton = screen.getByLabelText('Close project');

    expect(closeButton.parentElement).toBe(title.parentElement);
  });

  test('close project button calls closeProject handler', async () => {
    const closeProject = vi.fn();
    const { user, state } = renderNavigation({ currentProject: { id: 'p-3', name: 'Live Project' }, closeProject });

    await user.click(screen.getByLabelText('Close project'));

    expect(closeProject).toHaveBeenCalledTimes(1);
    expect(state.closeProject).toBe(closeProject);
  });

  test('close project button disables and shows progress indicator while stopping', () => {
    renderNavigation({
      currentProject: { id: 'p-77', name: 'Stopping Project' },
      projectShutdownState: {
        isStopping: true,
        projectId: 'p-77',
        projectName: 'Stopping Project',
        startedAt: '2024-01-01T00:00:00.000Z',
        error: null
      }
    });

    const button = screen.getByTestId('close-project-button');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('shutdown-status')).toHaveTextContent('Stopping Stopping Project');
  });
  
  test('git settings modal can be closed with the header button', async () => {
    const { user } = renderNavigation();

    await user.click(screen.getByRole('button', { name: /Settings/ }));
    await user.click(screen.getByText('Configure Git'));

    await screen.findByTestId('git-settings-modal');
    await user.click(screen.getByTestId('git-close-button'));

    await waitFor(() => {
      expect(screen.queryByTestId('git-settings-modal')).not.toBeInTheDocument();
    });
  });

  test('displays shutdown error message when stop fails', () => {
    renderNavigation({
      currentProject: null,
      projectShutdownState: {
        isStopping: false,
        projectId: 'p-errors',
        projectName: 'Errored Project',
        startedAt: null,
        error: 'API timeout'
      }
    });

    const status = screen.getByTestId('shutdown-status');
    expect(status).toHaveTextContent('Stop failed: API timeout');
  });

  test('handles missing project shutdown state gracefully', () => {
    renderNavigation({ projectShutdownState: null });

    expect(screen.queryByTestId('shutdown-status')).not.toBeInTheDocument();
  });

  test('shutdown status falls back to generic project name when missing', () => {
    renderNavigation({
      currentProject: null,
      projectShutdownState: {
        isStopping: true,
        projectId: null,
        projectName: '',
        startedAt: null,
        error: null
      }
    });

    const status = screen.getByTestId('shutdown-status');
    expect(status).toHaveTextContent('Stopping project');
  });

  test('project selection handles start API errors gracefully', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const selectProject = vi.fn(async () => {
      console.warn('Backend server not available - project selected but processes not started. Please ensure the backend server is running.');
    });
    const projects = [{ id: 'p-1', name: 'Orion Project' }];
    const { user } = renderNavigation({ projects, selectProject });

    await user.click(screen.getByRole('button', { name: /Projects/ }));
    await user.click(screen.getByText('Orion Project'));

    await waitFor(() => expect(selectProject).toHaveBeenCalledWith(projects[0]));
    expect(consoleWarn).toHaveBeenCalled();

    consoleWarn.mockRestore();
  });
});