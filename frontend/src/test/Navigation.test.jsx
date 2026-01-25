import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
  defaultBranch: 'main',
  autoPush: false,
  useCommitTemplate: false,
  commitTemplate: ''
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
  toggleTheme: vi.fn(),
  setPreviewPanelTab: vi.fn(),
  gitSettings: defaultGitSettings,
  projectGitSettings: {},
  updateGitSettings: vi.fn(),
  updateProjectGitSettings: vi.fn(),
  getEffectiveGitSettings: vi.fn().mockReturnValue(defaultGitSettings),
  portSettings: {
    frontendPortBase: 6100,
    backendPortBase: 6500
  },
  updatePortSettings: vi.fn().mockResolvedValue(undefined),
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
    expect(screen.getByText('Create new project')).toBeInTheDocument();
    expect(screen.getByText('Import project')).toBeInTheDocument();
  });

  test('settings dropdown shows correct content when enabled', async () => {
    const { user } = renderNavigation();

    await user.click(screen.getByRole('button', { name: /Settings/ }));

    expect(screen.getByText('Configure LLM')).toBeInTheDocument();
    expect(screen.getByText('Configure Git')).toBeInTheDocument();
    expect(screen.getByText('Ports')).toBeInTheDocument();
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
    await user.type(screen.getByTestId('git-remote-url'), 'https://gitlab.com/demo/repo.git');
    await user.type(screen.getByTestId('git-username'), 'octocat');
    const branchInput = screen.getByTestId('git-default-branch');
    await user.clear(branchInput);
    await user.type(branchInput, 'develop');
    await user.click(screen.getByTestId('git-auto-push'));

    await user.click(screen.getByTestId('git-save-button'));

    expect(state.updateGitSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'cloud',
        provider: 'gitlab',
        remoteUrl: 'https://gitlab.com/demo/repo.git',
        username: 'octocat',
        defaultBranch: 'develop',
        autoPush: true
      })
    );

    alertSpy.mockRestore();
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
      expect(alertSpy).toHaveBeenCalledWith('Failed to update git settings. Please try again.')
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

  test('tools dropdown shows correct content when enabled', async () => {
    const { user } = renderNavigation();

    await user.click(screen.getByRole('button', { name: /Tools/ }));

    expect(screen.getByText('Clean Up')).toBeInTheDocument();
    expect(screen.getByText('Refactor')).toBeInTheDocument();
    expect(screen.getByText('Add Tests')).toBeInTheDocument();
    expect(screen.getByText('Audit Security')).toBeInTheDocument();
  });

  test('tool actions show placeholder alerts when triggered', async () => {
    const { user } = renderNavigation();
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    await user.click(screen.getByRole('button', { name: /Tools/ }));
    await user.click(screen.getByText('Clean Up'));

    await user.click(screen.getByRole('button', { name: /Tools/ }));
    await user.click(screen.getByText('Refactor'));

    await user.click(screen.getByRole('button', { name: /Tools/ }));
    await user.click(screen.getByText('Add Tests'));

    await user.click(screen.getByRole('button', { name: /Tools/ }));
    await user.click(screen.getByText('Audit Security'));

    expect(alertSpy).toHaveBeenCalledTimes(4);
    expect(alertSpy).toHaveBeenNthCalledWith(1, 'Clean Up tool would execute here');
    expect(alertSpy).toHaveBeenNthCalledWith(2, 'Refactor tool would execute here');
    expect(alertSpy).toHaveBeenNthCalledWith(3, 'Add Tests tool would execute here');
    expect(alertSpy).toHaveBeenNthCalledWith(4, 'Audit Security tool would execute here');

    alertSpy.mockRestore();
  });

  test('create project functionality works', async () => {
    const createProject = vi.fn().mockResolvedValue({ id: 'new', name: 'New Project' });
    const { user, state } = renderNavigation({ createProject });
    const promptSpy = vi
      .spyOn(window, 'prompt')
      .mockImplementationOnce(() => '  New Project  ')
      .mockImplementationOnce(() => '  New description  ');
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    await user.click(screen.getByRole('button', { name: /Projects/ }));
    await user.click(screen.getByText('Create new project'));

    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith({ name: 'New Project', description: 'New description' })
    );
    expect(alertSpy).toHaveBeenCalledWith('Project created successfully!');

    promptSpy.mockRestore();
    alertSpy.mockRestore();
    expect(state.createProject).toBe(createProject);
  });

  test('create project falls back to empty description when prompt cancelled', async () => {
    const createProject = vi
      .fn()
      .mockResolvedValue({ id: 'no-desc', name: 'Project Without Description' });
    const { user } = renderNavigation({ createProject });
    const promptSpy = vi
      .spyOn(window, 'prompt')
      .mockImplementationOnce(() => 'Project Without Description')
      .mockImplementationOnce(() => null);
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    await user.click(screen.getByRole('button', { name: /Projects/ }));
    await user.click(screen.getByText('Create new project'));

    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith({
        name: 'Project Without Description',
        description: ''
      })
    );
    expect(alertSpy).toHaveBeenCalledWith('Project created successfully!');

    promptSpy.mockRestore();
    alertSpy.mockRestore();
  });

  test('handles project creation cancellation', async () => {
    const { user, state } = renderNavigation();
    const promptSpy = vi.spyOn(window, 'prompt').mockImplementation(() => '');
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    await user.click(screen.getByRole('button', { name: /Projects/ }));
    await user.click(screen.getByText('Create new project'));

    expect(promptSpy).toHaveBeenCalledTimes(1);
    expect(state.createProject).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();

    promptSpy.mockRestore();
    alertSpy.mockRestore();
  });
  
  test('surfaces project creation errors to the user', async () => {
    const createProject = vi.fn().mockRejectedValue(new Error('Backend offline'));
    const { user, state } = renderNavigation({ createProject });
    const promptSpy = vi
      .spyOn(window, 'prompt')
      .mockImplementationOnce(() => '  Broken Project  ')
      .mockImplementationOnce(() => '  desc  ');
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    await user.click(screen.getByRole('button', { name: /Projects/ }));
    await user.click(screen.getByText('Create new project'));

    await waitFor(() => expect(createProject).toHaveBeenCalledWith({ name: 'Broken Project', description: 'desc' }));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Failed to create project: Backend offline'));

    expect(state.createProject).toBe(createProject);

    promptSpy.mockRestore();
    alertSpy.mockRestore();
  });

  test('import project reads selected JSON file and dispatches action', async () => {
    const { user, state } = renderNavigation();
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const realCreateElement = document.createElement.bind(document);
    const fakeInput = { type: '', accept: '', onchange: null, click: vi.fn() };
    const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tagName, options) => {
      if (tagName === 'input') {
        return fakeInput;
      }
      return realCreateElement(tagName, options);
    });
    const originalFileReader = window.FileReader;
    class MockFileReader {
      readAsText() {
        this.onload?.({ target: { result: JSON.stringify({ id: 'imported', name: 'Imported Project' }) } });
      }
    }
    window.FileReader = MockFileReader;
    fakeInput.click.mockImplementation(() => {
      fakeInput.onchange?.({ target: { files: [{ name: 'project.json' }] } });
    });

    await user.click(screen.getByRole('button', { name: /Projects/ }));
    await user.click(screen.getByText('Import project'));

    expect(fakeInput.click).toHaveBeenCalled();
    expect(state.importProject).toHaveBeenCalledWith({ id: 'imported', name: 'Imported Project' });
    expect(alertSpy).toHaveBeenCalledWith('Project imported successfully!');

    createElementSpy.mockRestore();
    window.FileReader = originalFileReader;
    alertSpy.mockRestore();
  });

  test('import project shows error when JSON parsing fails', async () => {
    const { user, state } = renderNavigation();
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const realCreateElement = document.createElement.bind(document);
    const fakeInput = { type: '', accept: '', onchange: null, click: vi.fn() };
    const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tagName, options) => {
      if (tagName === 'input') {
        return fakeInput;
      }
      return realCreateElement(tagName, options);
    });
    const originalFileReader = window.FileReader;
    class MockFileReader {
      readAsText() {
        this.onload?.({ target: { result: 'not-json' } });
      }
    }
    window.FileReader = MockFileReader;
    fakeInput.click.mockImplementation(() => {
      fakeInput.onchange?.({ target: { files: [{ name: 'broken.json' }] } });
    });

    await user.click(screen.getByRole('button', { name: /Projects/ }));
    await user.click(screen.getByText('Import project'));

    expect(fakeInput.click).toHaveBeenCalled();
    expect(state.importProject).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith('Error importing project: Invalid JSON file');

    createElementSpy.mockRestore();
    window.FileReader = originalFileReader;
    alertSpy.mockRestore();
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