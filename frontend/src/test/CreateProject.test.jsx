import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import CreateProject, { BACKEND_UNAVAILABLE_MESSAGE } from '../components/CreateProject';

const mockCreateProject = vi.fn();
const mockImportProject = vi.fn();
const mockSelectProject = vi.fn();
const mockShowMain = vi.fn();
const mockFetchProjects = vi.fn();
const mockCreateProjectRemoteRepository = vi.fn();
const mockUpdateProjectGitSettings = vi.fn();

const defaultGitSettings = {
  provider: 'github',
  username: 'global-user',
  defaultBranch: 'main',
  tokenPresent: true
};

let mockGitSettings = { ...defaultGitSettings };

const socketInstances = [];
const defaultSocketConfig = {
  connectError: true,
  joinResponse: { error: 'connect failed' },
  deferConnect: false,
  throwOnCreate: false,
  throwOnOff: false,
  throwOnDisconnect: false
};
let socketConfig = { ...defaultSocketConfig };

class FakeSocket {
  constructor() {
    this.connected = false;
    this.disconnected = false;
    this.listeners = new Map();
    this.emitted = [];

    this.offCalls = [];

    if (!socketConfig.deferConnect) {
      Promise.resolve().then(() => {
        if (this.disconnected) {
          return;
        }
        if (socketConfig.connectError) {
          this.trigger('connect_error', new Error('connect failed'));
          return;
        }
        this.connected = true;
        this.trigger('connect');
      });
    }
  }

  on(event, handler) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(handler);
  }

  off(event, handler) {
    this.offCalls.push({ event, handler });
    if (socketConfig.throwOnOff) {
      throw new Error('off failed');
    }
    if (!this.listeners.has(event)) {
      return;
    }
    if (typeof handler === 'function') {
      this.listeners.get(event).delete(handler);
      if (this.listeners.get(event).size === 0) {
        this.listeners.delete(event);
      }
      return;
    }
    this.listeners.delete(event);
  }

  emit(event, payload, ack) {
    this.emitted.push({ event, payload });
    if (event === 'progress:join' && typeof ack === 'function') {
      ack(socketConfig.joinResponse);
    }
  }

  trigger(event, payload) {
    const handlers = this.listeners.get(event);
    if (handlers) {
      handlers.forEach((handler) => handler(payload));
    }
  }

  disconnect() {
    if (socketConfig.throwOnDisconnect) {
      throw new Error('disconnect failed');
    }
    this.disconnected = true;
    this.connected = false;
  }
}

class MockEventSource {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.onmessage = null;
    this.onerror = null;
    this.closed = false;
    this.listeners = new Map();
    MockEventSource.instances.push(this);
  }

  addEventListener(eventName, handler) {
    if (!this.listeners.has(eventName)) {
      this.listeners.set(eventName, new Set());
    }
    this.listeners.get(eventName).add(handler);
  }

  emitProgress(payload) {
    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(payload) });
    }
    const handlers = this.listeners.get('progress');
    if (handlers) {
      handlers.forEach((handler) => handler({ data: JSON.stringify(payload) }));
    }
  }

  emitError(event = {}) {
    if (this.onerror) {
      this.onerror(event);
    }
  }

  emitRaw(data) {
    if (this.onmessage) {
      this.onmessage({ data });
    }
    const handlers = this.listeners.get('progress');
    if (handlers) {
      handlers.forEach((handler) => handler({ data }));
    }
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }
}

vi.mock('../context/AppStateContext', () => ({
  useAppState: () => ({
    createProject: mockCreateProject,
    importProject: mockImportProject,
    selectProject: mockSelectProject,
    showMain: mockShowMain,
    fetchProjects: mockFetchProjects,
    gitSettings: mockGitSettings,
    createProjectRemoteRepository: mockCreateProjectRemoteRepository,
    updateProjectGitSettings: mockUpdateProjectGitSettings
  })
}));

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => {
    if (socketConfig.throwOnCreate) {
      throw new Error('socket create failed');
    }
    const socket = new FakeSocket();
    socketInstances.push(socket);
    return socket;
  })
}));

const mockAxios = axios;
const originalEventSource = typeof window !== 'undefined' ? window.EventSource : undefined;

const renderComponent = () => {
  return {
    user: userEvent.setup()
  };
};

const waitForCreateProjectHooks = async () => {
  await waitFor(() => {
    expect(typeof CreateProject.__testHooks?.runPostCloneSetup).toBe('function');
  });
  return CreateProject.__testHooks;
};

const sourceLabelMap = {
  new: 'Create a new project',
  local: 'Import a local folder',
  git: 'Clone from Git'
};

const ensureSourceStep = async (user) => {
  if (screen.queryByText('Project Source')) {
    return;
  }

  for (let i = 0; i < 3; i += 1) {
    const backButton = screen.queryByRole('button', { name: /back/i });
    if (!backButton) {
      break;
    }
    await user.click(backButton);
    if (screen.queryByText('Project Source')) {
      return;
    }
  }
};

const ensureDetailsStep = async (user) => {
  if (screen.queryByLabelText('Project Name *')) {
    return;
  }

  await ensureGitStep(user, { source: 'new' });
  const workflowSelect = screen.queryByLabelText('Git Workflow *');
  if (workflowSelect && !workflowSelect.value) {
    await user.selectOptions(workflowSelect, 'local');
  }

  await user.click(getNextButton());

  await screen.findByLabelText('Project Name *');
};

const ensureGitStep = async (user, { source = 'new' } = {}) => {
  if (screen.queryByLabelText('Git Workflow *') || screen.queryByLabelText('Project Folder Path *')) {
    return;
  }

  const backButton = screen.queryByRole('button', { name: /back/i });
  if (backButton) {
    await user.click(backButton);
    if (screen.queryByLabelText('Git Workflow *') || screen.queryByLabelText('Project Folder Path *')) {
      return;
    }
  }

  await ensureSourceStep(user);
  const sourceLabel = sourceLabelMap[source] || sourceLabelMap.new;
  await user.click(screen.getByText(sourceLabel));
  await user.click(getNextButton());

  if (source === 'local') {
    await screen.findByLabelText('Project Folder Path *');
  } else {
    await screen.findByLabelText('Git Workflow *');
  }
};

const getNextButton = () => screen.getByRole('button', { name: /^next$/i });

const getCreateProjectButton = () => screen.getByRole('button', {
  name: /create project|import project|next/i
});

const goToCompatibilityStep = async (user, pathValue) => {
  await ensureGitStep(user, { source: 'local' });
  await user.type(screen.getByLabelText('Project Folder Path *'), pathValue);
  await user.click(getNextButton());
  await screen.findByLabelText('Project Name *');
  await user.type(screen.getByLabelText('Project Name *'), 'Local Import');
  await user.click(screen.getByRole('button', { name: /create project/i }));
};

const submitForm = async (user) => {
  await ensureDetailsStep(user);
  await user.click(getCreateProjectButton());
};

const fillProjectName = async (user, name = 'My Project') => {
  await ensureDetailsStep(user);
  const input = screen.getByLabelText('Project Name *');
  await user.clear(input);
  await user.type(input, name);
};

const fillDescription = async (user, description = 'Description') => {
  await ensureDetailsStep(user);
  const input = screen.getByLabelText('Description');
  await user.clear(input);
  await user.type(input, description);
};

const goToGitStep = async (user, projectName = '') => {
  await ensureGitStep(user);
  const workflowSelect = screen.queryByLabelText('Git Workflow *');
  if (workflowSelect && !workflowSelect.value) {
    await user.selectOptions(workflowSelect, 'local');
  }

  await user.click(getNextButton());
  await screen.findByLabelText('Project Name *');

  if (projectName) {
    const input = screen.getByLabelText('Project Name *');
    await user.clear(input);
    await user.type(input, projectName);
  }

  await user.click(screen.getByRole('button', { name: /back/i }));
  await screen.findByLabelText('Git Workflow *');
};

const goToGitStepWithFireEvent = () => {
  fireEvent.click(screen.getByText(sourceLabelMap.new));
  fireEvent.click(getNextButton());
};

const goToDetailsStepWithFireEvent = () => {
  goToGitStepWithFireEvent();
  fireEvent.change(screen.getByLabelText('Git Workflow *'), { target: { value: 'local' } });
  fireEvent.click(getNextButton());
};

const createSuccessResponse = (overrides = {}) => {
  const project = overrides.project || { id: 'proj-1', name: 'My Project' };
  const data = {
    success: true,
    project,
    message: 'Project created successfully',
    ...overrides
  };

  return { data };
};

beforeEach(() => {
  vi.clearAllMocks();
  MockEventSource.instances.length = 0;
  socketInstances.length = 0;
  socketConfig = { ...defaultSocketConfig };
  mockGitSettings = { ...defaultGitSettings };
  if (typeof window !== 'undefined') {
    window.EventSource = MockEventSource;
  }
});

afterEach(() => {
  if (typeof window !== 'undefined') {
    window.EventSource = originalEventSource;
  }
});

describe('Validation', () => {

    test('clones an existing repo when using global workflow', async () => {
      const { user } = renderComponent();
      mockImportProject.mockResolvedValue({
        project: { id: 'proj-cloud-global', name: 'My Project' },
        jobs: []
      });

      render(<CreateProject />);
      await ensureGitStep(user, { source: 'git' });
      await user.type(screen.getByLabelText('Repository URL *'), 'https://github.com/octocat/my-project.git');
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'global');

      await user.click(getNextButton());
      await user.click(getCreateProjectButton());

      await waitFor(() => {
        expect(mockImportProject).toHaveBeenCalledWith(expect.objectContaining({
          importMethod: 'git',
          gitUrl: 'https://github.com/octocat/my-project.git',
          gitConnectionMode: 'global'
        }));
      });
    });

    test('surfaces clone import errors', async () => {
      const { user } = renderComponent();
      mockImportProject.mockRejectedValue(new Error('clone failed'));

      render(<CreateProject />);
      await ensureGitStep(user, { source: 'git' });
      await user.type(screen.getByLabelText('Repository URL *'), 'https://github.com/octocat/my-project.git');
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'global');

      await user.click(getNextButton());
      await user.click(getCreateProjectButton());

      expect(await screen.findByText('clone failed')).toBeInTheDocument();
    });

    test('shows error when git repository url is missing', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await ensureGitStep(user, { source: 'git' });
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'global');

      await user.click(getNextButton());

      expect(screen.getByText(/git repository url is required/i)).toBeInTheDocument();
      expect(mockImportProject).not.toHaveBeenCalled();
    });

    test('shows error when custom cloud workflow omits PAT', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await ensureGitStep(user);
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'custom');
      await screen.findByLabelText('Repository Name');

      await user.click(getNextButton());

      expect(screen.getByText(/personal access token is required/i)).toBeInTheDocument();
      expect(mockAxios.post).not.toHaveBeenCalled();
    });

    test('clears git setup validation errors as the user selects options and types', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await ensureGitStep(user);
      await user.click(getCreateProjectButton());
      expect(screen.getByText(/git workflow selection is required/i)).toBeInTheDocument();

      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'custom');
      expect(screen.queryByText(/git workflow selection is required/i)).not.toBeInTheDocument();

      await user.click(getCreateProjectButton());
      expect(screen.getByText(/personal access token is required/i)).toBeInTheDocument();

      await user.type(screen.getByLabelText('Personal Access Token *'), 'glpat-test');
      await waitFor(() => {
        expect(screen.queryByText(/personal access token is required/i)).not.toBeInTheDocument();
      });
    });

    test('clears custom workflow errors and covers repo create metadata edits', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await ensureGitStep(user);
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'custom');

      await user.click(getCreateProjectButton());
      expect(screen.getByText(/personal access token is required/i)).toBeInTheDocument();

      await user.selectOptions(screen.getByLabelText('Git Provider *'), 'gitlab');
      await waitFor(() => {
        expect(screen.queryByText(/personal access token is required/i)).not.toBeInTheDocument();
      });

      await user.click(getCreateProjectButton());
      expect(screen.getByText(/personal access token is required/i)).toBeInTheDocument();

      await user.type(screen.getByLabelText('Personal Access Token *'), 'glpat-test');
      await waitFor(() => {
        expect(screen.queryByText(/personal access token is required/i)).not.toBeInTheDocument();
      });

      await user.type(screen.getByLabelText('Repository Name'), 'RepoName');
      await user.type(screen.getByLabelText('Owner / Org'), 'octocat');
      await user.selectOptions(screen.getByLabelText('Visibility'), 'public');
      expect(screen.getByLabelText('Owner / Org')).toHaveValue('octocat');
      expect(screen.getByLabelText('Visibility')).toHaveValue('public');
    });

    test('clears repository URL errors when local import cloud URL changes', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await ensureGitStep(user, { source: 'local' });

      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'global');
      await screen.findByLabelText('Repository URL *');
      await user.type(screen.getByLabelText('Project Folder Path *'), 'C:/projects/local-app');
      await user.click(getNextButton());
      expect(screen.getByText(/repository url is required/i)).toBeInTheDocument();

      await user.type(screen.getByLabelText('Repository URL *'), 'https://example.com/org/repo.git');
      await waitFor(() => {
        expect(screen.queryByText(/repository url is required/i)).not.toBeInTheDocument();
      });
    });

    test('blocks linked imports outside the managed folder before advancing', async () => {
      const { user } = renderComponent();
      mockAxios.post.mockRejectedValueOnce({
        response: {
          data: {
            error: 'Linked projects must be inside the managed projects folder. Use copy instead.'
          }
        }
      });

      render(<CreateProject />);
      await ensureGitStep(user, { source: 'local' });
      await user.type(screen.getByLabelText('Project Folder Path *'), 'C:/tmp/outside-managed-root');
      await user.click(screen.getByText('Link to existing folder'));

      await user.click(getNextButton());

      expect(screen.getByText(/linked projects must be inside the managed projects folder/i)).toBeInTheDocument();
      expect(screen.queryByLabelText('Project Name *')).not.toBeInTheDocument();
    });

    test('shows error when project name is empty', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await submitForm(user);

      expect(screen.getByText('Project name is required')).toBeInTheDocument();
      expect(mockAxios.post).not.toHaveBeenCalled();
    });

    test('clears required-name error when project name changes', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await ensureDetailsStep(user);
      await user.click(getCreateProjectButton());

      expect(screen.getByText('Project name is required')).toBeInTheDocument();

      await user.type(screen.getByLabelText('Project Name *'), 'My Project');
      await waitFor(() => {
        expect(screen.queryByText('Project name is required')).not.toBeInTheDocument();
      });
    });

    test('shows required-name error when name becomes empty before git step submit', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await ensureDetailsStep(user);

      const form = screen.getByRole('form');
      const projectNameInput = screen.getByLabelText('Project Name *');

      await act(async () => {
        fireEvent.change(projectNameInput, { target: { value: 'Temp' } });
        fireEvent.change(projectNameInput, { target: { value: '' } });
        fireEvent.submit(form);
      });

      expect(await screen.findByText('Project name is required')).toBeInTheDocument();
      expect(mockAxios.post).not.toHaveBeenCalled();
    });

    test('shows error when project name is only whitespace', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await fillProjectName(user, '   ');
      await submitForm(user);

      expect(screen.getByText('Project name is required')).toBeInTheDocument();
      expect(mockAxios.post).not.toHaveBeenCalled();
    });

    test('submit button is enabled to allow validation', async () => {
      const { user } = renderComponent();
      render(<CreateProject />);

      await ensureDetailsStep(user);

      expect(getCreateProjectButton()).not.toBeDisabled();
    });

    test('submit button is enabled when name is provided', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await fillProjectName(user);

      expect(getCreateProjectButton()).not.toBeDisabled();
    });
  });

  describe('Form Interactions', () => {
    test('updates project name field', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await fillProjectName(user, 'New Project');

      expect(screen.getByLabelText('Project Name *')).toHaveValue('New Project');
    });

    test('updates description field', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await fillDescription(user, 'New description');

      expect(screen.getByLabelText('Description')).toHaveValue('New description');
    });

    test('shows repository name placeholder based on project name', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);

      await goToGitStep(user, 'My Project');

      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'global');

      const repoNameInput = screen.getByLabelText('Repository Name');
      expect(repoNameInput).toHaveAttribute('placeholder', 'Default: My Project');
    });

    test('falls back to the generic repository name placeholder when project name is blank during git step', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);

      await ensureGitStep(user);
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'global');

      const repoNameInput = screen.getByLabelText('Repository Name');
      expect(repoNameInput).toHaveAttribute('placeholder', 'Repository name');
    });

    test('shows repo fields when creating a new remote after cloning', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);

      await ensureGitStep(user, { source: 'git' });
      await user.type(screen.getByLabelText('Repository URL *'), 'https://github.com/octocat/my-project.git');
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'global');
      await user.click(screen.getByText('Create a new repo after cloning'));

      expect(await screen.findByLabelText('Repository Name')).toBeInTheDocument();
    });

    test('deriveRepoName handles non-string values', async () => {
      render(<CreateProject />);

      const hooks = await waitForCreateProjectHooks();

      expect(hooks.deriveRepoName(null)).toBe('');
    });

    test('updates frontend language selection and resets framework', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await ensureDetailsStep(user);
      const frontendFramework = screen.getByLabelText('Frontend Framework *');
      await user.selectOptions(frontendFramework, 'angular');
      expect(frontendFramework).toHaveValue('angular');

      const frontendLanguage = screen.getByLabelText('Frontend Language *');
      await user.selectOptions(frontendLanguage, 'typescript');

      expect(frontendLanguage).toHaveValue('typescript');
      expect(frontendFramework).toHaveValue('react');
    });

    test('updates frontend framework selection', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await ensureDetailsStep(user);
      const frontendFramework = screen.getByLabelText('Frontend Framework *');
      await user.selectOptions(frontendFramework, 'vue');

      expect(frontendFramework).toHaveValue('vue');
    });

    test('shows correct frontend frameworks for selected language', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await ensureDetailsStep(user);
      const frontendLanguage = screen.getByLabelText('Frontend Language *');
      await user.selectOptions(frontendLanguage, 'typescript');

      const frameworkSelect = screen.getByLabelText('Frontend Framework *');
      const options = within(frameworkSelect).getAllByRole('option');
      const optionValues = options.map((option) => option.value);

      expect(optionValues).toEqual(['react', 'vue', 'angular', 'svelte', 'nextjs', 'nuxtjs', 'vanilla']);
    });
  });

  describe('Git Setup UI', () => {
    test('allows switching project source back to new', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);

      await ensureSourceStep(user);
      await user.click(screen.getByText('Import a local folder'));
      await user.click(screen.getByText('Create a new project'));
      await user.click(getNextButton());

      expect(await screen.findByLabelText('Git Workflow *')).toBeInTheDocument();
    });

    test('renders git workflow options for local imports', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);

      await ensureGitStep(user, { source: 'local' });

      const workflowSelect = screen.getByLabelText('Git Workflow *');
      const optionLabels = within(workflowSelect)
        .getAllByRole('option')
        .map((option) => option.textContent);

      expect(optionLabels).toContain('Cloud (use global git settings)');
      expect(optionLabels).toContain('Cloud (custom connection)');
    });

    test('renders git workflow options for git imports', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);

      await ensureGitStep(user, { source: 'git' });

      const workflowSelect = screen.getByLabelText('Git Workflow *');
      const optionLabels = within(workflowSelect)
        .getAllByRole('option')
        .map((option) => option.textContent);

      expect(optionLabels).toContain('Cloud (use global git settings)');
      expect(optionLabels).toContain('Cloud (custom connection)');
    });

    test('renders git workflow options for new projects', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);

      await ensureGitStep(user, { source: 'new' });

      const workflowSelect = screen.getByLabelText('Git Workflow *');
      const optionLabels = within(workflowSelect)
        .getAllByRole('option')
        .map((option) => option.textContent);

      expect(optionLabels).toContain('Cloud (use global git settings)');
      expect(optionLabels).toContain('Cloud (custom connection)');
    });

    test('renders workflow option values for local imports', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);

      await ensureGitStep(user, { source: 'local' });
      const localValues = within(screen.getByLabelText('Git Workflow *'))
        .getAllByRole('option')
        .map((option) => option.value);

      expect(localValues).toContain('local');
      expect(localValues).toContain('global');
      expect(localValues).toContain('custom');
    });

    test('renders workflow option values for git imports', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);

      await ensureGitStep(user, { source: 'git' });
      const gitValues = within(screen.getByLabelText('Git Workflow *'))
        .getAllByRole('option')
        .map((option) => option.value);

      expect(gitValues).toContain('local');
      expect(gitValues).toContain('global');
      expect(gitValues).toContain('custom');
    });

    test('shows custom cloud inputs for local imports', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);

      await ensureGitStep(user, { source: 'local' });
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'custom');

      expect(await screen.findByLabelText('Git Provider *')).toBeInTheDocument();
      expect(screen.getByLabelText('Personal Access Token *')).toBeInTheDocument();
    });

    test('shows custom cloud inputs for git imports', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);

      await ensureGitStep(user, { source: 'git' });
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'custom');

      expect(await screen.findByLabelText('Git Provider *')).toBeInTheDocument();
      expect(screen.getByLabelText('Personal Access Token *')).toBeInTheDocument();
    });

    test('shows custom cloud inputs for new projects', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);

      await ensureGitStep(user, { source: 'new' });
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'custom');

      expect(await screen.findByLabelText('Git Provider *')).toBeInTheDocument();
      expect(screen.getByLabelText('Personal Access Token *')).toBeInTheDocument();
    });

    test('clears local git workflow error when selecting a connection mode', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);

      await ensureGitStep(user, { source: 'local' });
      await user.click(getNextButton());

      expect(screen.getByText('Project path is required')).toBeInTheDocument();

      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'global');

      await waitFor(() => {
        expect(screen.queryByText('Project path is required')).not.toBeInTheDocument();
      });
    });

    test('clears local path error when typing a folder path', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);

      await ensureGitStep(user, { source: 'local' });
      await user.click(getNextButton());

      expect(screen.getByText('Project path is required')).toBeInTheDocument();

      await user.type(screen.getByLabelText('Project Folder Path *'), 'C:/projects/local-app');

      await waitFor(() => {
        expect(screen.queryByText('Project path is required')).not.toBeInTheDocument();
      });
    });

    test('clears git clone URL error when typing the repository URL', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);

      await ensureGitStep(user, { source: 'git' });
      await user.click(getNextButton());

      expect(screen.getByText('Git repository URL is required')).toBeInTheDocument();

      await user.type(screen.getByLabelText('Repository URL *'), 'https://github.com/org/repo.git');

      await waitFor(() => {
        expect(screen.queryByText('Git repository URL is required')).not.toBeInTheDocument();
      });
    });

    test('clears git workflow error when selecting a connection mode for git imports', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);

      await ensureGitStep(user, { source: 'git' });
      await user.click(getNextButton());

      expect(screen.getByText('Git repository URL is required')).toBeInTheDocument();

      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'custom');

      await waitFor(() => {
        expect(screen.queryByText('Git repository URL is required')).not.toBeInTheDocument();
      });
    });

    test('clears connect URL error when editing the repository URL', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);

      await ensureGitStep(user, { source: 'new' });
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'custom');

      const hooks = await waitForCreateProjectHooks();
      act(() => {
        hooks.setGitCloudMode('connect');
      });

      await user.click(getNextButton());

      expect(screen.getByText('Personal access token is required for a custom cloud connection')).toBeInTheDocument();

      await user.type(screen.getByLabelText('Repository URL *'), 'https://github.com/org/repo.git');

      await waitFor(() => {
        expect(screen.queryByText('Personal access token is required for a custom cloud connection')).not.toBeInTheDocument();
      });
    });

    test('clears repo owner error when editing owner/org field', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);

      await ensureGitStep(user, { source: 'new' });
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'custom');
      await user.click(getNextButton());

      expect(screen.getByText('Personal access token is required for a custom cloud connection')).toBeInTheDocument();

      await user.type(screen.getByLabelText('Owner / Org'), 'octocat');

      await waitFor(() => {
        expect(screen.queryByText('Personal access token is required for a custom cloud connection')).not.toBeInTheDocument();
      });
    });

    test('shows cloud connection URL field for local imports', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);

      await ensureGitStep(user, { source: 'local' });
      await user.type(screen.getByLabelText('Project Folder Path *'), 'C:/projects/local-app');
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'global');
      await user.click(getNextButton());

      expect(screen.getByText('Repository URL is required for cloud workflows')).toBeInTheDocument();

      await user.type(screen.getByLabelText('Repository URL *'), 'https://github.com/org/repo.git');

      await waitFor(() => {
        expect(screen.queryByText('Repository URL is required for cloud workflows')).not.toBeInTheDocument();
      });
    });

    test('clears repo metadata error when editing clone fields', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);

      await ensureGitStep(user, { source: 'git' });
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'global');
      await user.click(screen.getByText('Create a new repo after cloning'));
      await user.click(getNextButton());

      expect(screen.getByText('Git repository URL is required')).toBeInTheDocument();

      await user.type(screen.getByLabelText('Repository Name'), 'repo-name');
      await user.type(screen.getByLabelText('Owner / Org'), 'octocat');
      await user.selectOptions(screen.getByLabelText('Visibility'), 'public');

      await waitFor(() => {
        expect(screen.queryByText('Git repository URL is required')).not.toBeInTheDocument();
      });
    });

    test('shows connect summary card when git cloud mode is connect', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);

      await ensureGitStep(user, { source: 'new' });
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'global');

      const hooks = await waitForCreateProjectHooks();
      act(() => {
        hooks.setGitCloudMode('connect');
      });

      const urlInput = await screen.findByLabelText('Repository URL *');
      await user.type(urlInput, 'https://github.com/octocat/sample-repo.git');

      expect(await screen.findByText('Derived from repo')).toBeInTheDocument();
      expect(screen.getByText('Repo name')).toBeInTheDocument();
      expect(screen.getByText('Remote')).toBeInTheDocument();
      expect(screen.getByText('Provider')).toBeInTheDocument();
      expect(screen.getByText('sample-repo')).toBeInTheDocument();
      expect(screen.getByText('https://github.com/octocat/sample-repo.git')).toBeInTheDocument();
      expect(screen.getByText('github')).toBeInTheDocument();
    });

    test('shows connect summary card with custom provider', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);

      await ensureGitStep(user, { source: 'new' });
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'custom');
      await user.selectOptions(screen.getByLabelText('Git Provider *'), 'gitlab');
      await user.type(screen.getByLabelText('Personal Access Token *'), 'glpat-test');

      const hooks = await waitForCreateProjectHooks();
      act(() => {
        hooks.setGitCloudMode('connect');
      });

      const urlInput = await screen.findByLabelText('Repository URL *');
      await user.type(urlInput, 'https://gitlab.com/octocat/sample-repo.git');

      expect(await screen.findByText('Derived from repo')).toBeInTheDocument();
      expect(screen.getByText('gitlab')).toBeInTheDocument();
    });

    test('falls back to github provider in connect summary when settings are blank', async () => {
      mockGitSettings = {
        ...defaultGitSettings,
        provider: ''
      };

      const { user } = renderComponent();

      render(<CreateProject />);

      await ensureGitStep(user, { source: 'new' });
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'global');

      const hooks = await waitForCreateProjectHooks();
      act(() => {
        hooks.setGitCloudMode('connect');
      });

      const urlInput = await screen.findByLabelText('Repository URL *');
      await user.type(urlInput, 'https://github.com/octocat/sample-repo.git');

      expect(await screen.findByText('Derived from repo')).toBeInTheDocument();
      expect(screen.getByText('github')).toBeInTheDocument();
    });

    test('shows visibility options for new project repo creation', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);

      await ensureGitStep(user, { source: 'new' });
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'global');

      const visibilitySelect = await screen.findByLabelText('Visibility');
      const visibilityValues = within(visibilitySelect)
        .getAllByRole('option')
        .map((option) => option.value);

      expect(visibilityValues).toContain('private');
      expect(visibilityValues).toContain('public');
      expect(visibilitySelect).toHaveValue('private');
    });
  });

  describe('Project Creation', () => {
    test('creates project with valid data and makes correct API calls', async () => {
      const { user } = renderComponent();
      mockAxios.post.mockResolvedValue(createSuccessResponse());
      mockUpdateProjectGitSettings.mockResolvedValue({});
      mockCreateProjectRemoteRepository.mockResolvedValue({});

      render(<CreateProject />);
      await fillProjectName(user, 'My Project');
      await fillDescription(user, 'Description');
      await user.selectOptions(screen.getByLabelText('Frontend Language *'), 'typescript');
      await user.selectOptions(screen.getByLabelText('Frontend Framework *'), 'vue');
      await user.selectOptions(screen.getByLabelText('Backend Language *'), 'python');
      await user.selectOptions(screen.getByLabelText('Backend Framework *'), 'fastapi');

      await submitForm(user);

      await waitFor(() => {
        expect(mockAxios.post).toHaveBeenCalledWith('/api/projects', expect.objectContaining({
          name: 'My Project',
          description: 'Description',
          frontend: { language: 'typescript', framework: 'vue' },
          backend: { language: 'python', framework: 'fastapi' },
          progressKey: expect.any(String)
        }));
      });

      await waitFor(() => {
        expect(mockSelectProject).toHaveBeenCalledWith(expect.objectContaining({ name: 'My Project' }));
        expect(mockFetchProjects).toHaveBeenCalled();
      });
    });

    test('connects existing repo when using global cloud workflow', async () => {
      const { user } = renderComponent();
      mockAxios.post.mockResolvedValue(createSuccessResponse({ project: { id: 'proj-cloud-global', name: 'My Project' } }));
      mockCreateProjectRemoteRepository.mockResolvedValueOnce({ success: true });

      render(<CreateProject />);
      await ensureGitStep(user);
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'global');
      await screen.findByLabelText('Repository Name');
      await user.click(getNextButton());
      await user.type(screen.getByLabelText('Project Name *'), 'My Project');
      await user.click(getCreateProjectButton());

      await waitFor(() => {
        expect(mockCreateProjectRemoteRepository).toHaveBeenCalledWith(
          'proj-cloud-global',
          expect.objectContaining({
            provider: 'github',
            name: 'My Project'
          })
        );
      });
    });

    test('prompts to apply gitignore fixes after cloning a repo', async () => {
      const { user } = renderComponent();

      mockAxios.post
        .mockResolvedValueOnce({
          data: {
            ...createSuccessResponse({ project: { id: 'proj-gitignore', name: 'My Project' } }).data,
            setupRequired: true,
            gitIgnoreSuggestion: {
              needed: true,
              entries: ['node_modules/'],
              samplePaths: ['node_modules/'],
              trackedFiles: ['package-lock.json']
            }
          }
        })
        .mockResolvedValueOnce({ data: { success: true, applied: true, committed: true, entries: ['node_modules/'] } })
        .mockResolvedValueOnce({ data: { success: true, processes: { frontend: { port: 3000 }, backend: { port: 4000 } } } });

      render(<CreateProject />);
      await ensureGitStep(user);
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'global');
      await screen.findByLabelText('Repository Name');
      await user.click(getNextButton());
      await user.type(screen.getByLabelText('Project Name *'), 'My Project');
      await user.click(getCreateProjectButton());

      expect(await screen.findByText(/missing information in it's \.gitignore/i)).toBeInTheDocument();
      expect(screen.getByText('node_modules/')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /fix issue/i }));

      await waitFor(() => {
        expect(mockAxios.post).toHaveBeenCalledWith(
          '/api/projects/proj-gitignore/git/ignore-fix',
          expect.objectContaining({
            entries: ['node_modules/'],
            commit: true
          })
        );
      });

      await waitFor(() => {
        expect(mockAxios.post).toHaveBeenCalledWith('/api/projects/proj-gitignore/setup');
      });

      await waitFor(() => {
        expect(mockShowMain).toHaveBeenCalled();
      }, { timeout: 3000 });
    });

    test('prompts gitignore fixes even when sample paths are missing', async () => {
      const { user } = renderComponent();

      mockAxios.post.mockResolvedValueOnce({
        data: {
          ...createSuccessResponse({ project: { id: 'proj-gitignore-nosample', name: 'My Project' } }).data,
          setupRequired: true,
          gitIgnoreSuggestion: {
            needed: true,
            entries: ['node_modules/']
          }
        }
      });

      render(<CreateProject />);
      await ensureGitStep(user);
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'global');
      await screen.findByLabelText('Repository Name');
      await user.click(getNextButton());
      await user.type(screen.getByLabelText('Project Name *'), 'My Project');
      await user.click(getCreateProjectButton());

      expect(await screen.findByText(/missing information in it's \.gitignore/i)).toBeInTheDocument();
      expect(screen.queryByText(/detected:/i)).not.toBeInTheDocument();
    });

    test('shows an error when gitignore update fails', async () => {
      const { user } = renderComponent();

      mockAxios.post
        .mockResolvedValueOnce({
          data: {
            ...createSuccessResponse({ project: { id: 'proj-gitignore-fail', name: 'My Project' } }).data,
            setupRequired: true,
            gitIgnoreSuggestion: {
              needed: true,
              entries: ['node_modules/'],
              samplePaths: ['node_modules/']
            }
          }
        })
        .mockResolvedValueOnce({ data: { success: false, error: 'gitignore update failed' } });

      render(<CreateProject />);
      await ensureGitStep(user);
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'global');
      await screen.findByLabelText('Repository Name');
      await user.click(getNextButton());
      await user.type(screen.getByLabelText('Project Name *'), 'My Project');
      await user.click(getCreateProjectButton());

      expect(await screen.findByText(/missing information in it's \.gitignore/i)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /fix issue/i }));

      expect(await screen.findByText(/gitignore update failed/i)).toBeInTheDocument();
    });

    test('shows an error when setup fails after skipping gitignore update', async () => {
      const { user } = renderComponent();

      mockAxios.post
        .mockResolvedValueOnce({
          data: {
            ...createSuccessResponse({ project: { id: 'proj-gitignore-skip', name: 'My Project' } }).data,
            setupRequired: true,
            gitIgnoreSuggestion: {
              needed: true,
              entries: ['node_modules/'],
              trackedFiles: ['package-lock.json'],
              samplePaths: ['node_modules/']
            }
          }
        })
        .mockResolvedValueOnce({ data: { success: false, error: 'setup failed' } });

      render(<CreateProject />);
      await ensureGitStep(user);
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'global');
      await screen.findByLabelText('Repository Name');
      await user.click(getNextButton());
      await user.type(screen.getByLabelText('Project Name *'), 'My Project');
      await user.click(getCreateProjectButton());

      expect(await screen.findByText(/tracked files.*package-lock\.json/i)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /cancel installation/i }));

      expect(await screen.findByText(/setup failed/i)).toBeInTheDocument();
    });

    test('exposes gitignore test hooks and rejects missing setup ids', async () => {
      render(<CreateProject />);

      const hooks = await waitForCreateProjectHooks();

      await expect(hooks.runPostCloneSetup()).rejects.toThrow(/missing project id/i);
    });

    test('gitignore handlers return early without suggestions', async () => {
      render(<CreateProject />);

      const hooks = await waitForCreateProjectHooks();

      await act(async () => {
        await hooks.handleApplyGitIgnore();
        await hooks.handleSkipGitIgnore();
      });

      expect(mockAxios.post).not.toHaveBeenCalled();
    });

    test('runPostCloneSetup surfaces setup failures', async () => {
      render(<CreateProject />);

      mockAxios.post.mockResolvedValueOnce({ data: { success: false, error: 'setup failed' } });

      const hooks = await waitForCreateProjectHooks();

      act(() => {
        hooks.setProgress({
          steps: [{ name: 'Step 1', completed: false }],
          completion: 0,
          status: 'pending',
          statusMessage: 'Waiting...'
        });
      });

      await expect(hooks.runPostCloneSetup('proj-setup-fail')).rejects.toThrow(/setup failed/i);
    });

    test('runPostCloneSetup uses default error when response omits details', async () => {
      render(<CreateProject />);

      mockAxios.post.mockResolvedValueOnce({ data: { success: false } });

      const hooks = await waitForCreateProjectHooks();

      act(() => {
        hooks.setProgress({
          steps: [{ name: 'Step 1', completed: false }],
          completion: 0,
          status: 'pending',
          statusMessage: 'Waiting...'
        });
      });

      await expect(hooks.runPostCloneSetup('proj-setup-default')).rejects.toThrow(/failed to complete project setup/i);
    });

    test('runPostCloneSetup falls back to default steps when progress is missing', async () => {
      render(<CreateProject />);

      mockAxios.post.mockResolvedValueOnce({ data: { success: true, message: 'Setup done' } });

      const hooks = await waitForCreateProjectHooks();

      act(() => {
        hooks.setProgress(null);
      });

      await act(async () => {
        await hooks.runPostCloneSetup('proj-setup-fallback');
      });

      expect(mockAxios.post).toHaveBeenCalledWith('/api/projects/proj-setup-fallback/setup');
    });

    test('handleApplyGitIgnore shows error when update fails', async () => {
      render(<CreateProject />);

      mockAxios.post.mockResolvedValueOnce({ data: { success: false, error: 'gitignore update failed' } });

      const hooks = await waitForCreateProjectHooks();

      act(() => {
        hooks.setProgress({
          steps: [{ name: 'Step 1', completed: false }],
          completion: 0,
          status: 'pending',
          statusMessage: 'Waiting...'
        });
        hooks.setGitIgnoreSuggestion({
          projectId: 'proj-gitignore-fail',
          entries: ['node_modules/'],
          detected: [],
          samplePaths: [],
          trackedFiles: []
        });
      });

      expect(await screen.findByText(/missing information in it's \.gitignore/i)).toBeInTheDocument();

      await act(async () => {
        await hooks.handleApplyGitIgnore();
      });

      expect(await screen.findByText(/gitignore update failed/i)).toBeInTheDocument();
    });

    test('handleApplyGitIgnore uses default error when response omits error', async () => {
      render(<CreateProject />);

      mockAxios.post.mockResolvedValueOnce({ data: { success: false } });

      const hooks = await waitForCreateProjectHooks();

      act(() => {
        hooks.setProgress({
          steps: [{ name: 'Step 1', completed: false }],
          completion: 0,
          status: 'pending',
          statusMessage: 'Waiting...'
        });
        hooks.setGitIgnoreSuggestion({
          projectId: 'proj-gitignore-default',
          entries: ['node_modules/'],
          detected: [],
          samplePaths: [],
          trackedFiles: []
        });
      });

      expect(await screen.findByText(/missing information in it's \.gitignore/i)).toBeInTheDocument();

      await act(async () => {
        await hooks.handleApplyGitIgnore();
      });

      expect(await screen.findByText(/failed to update \.gitignore/i)).toBeInTheDocument();
    });

    test('handleApplyGitIgnore surfaces response errors on request failure', async () => {
      render(<CreateProject />);

      mockAxios.post.mockRejectedValueOnce({ response: { data: { error: 'apply failed' } } });

      const hooks = await waitForCreateProjectHooks();

      act(() => {
        hooks.setProgress({
          steps: [{ name: 'Step 1', completed: false }],
          completion: 0,
          status: 'pending',
          statusMessage: 'Waiting...'
        });
        hooks.setGitIgnoreSuggestion({
          projectId: 'proj-gitignore-reject',
          entries: ['node_modules/'],
          detected: [],
          samplePaths: [],
          trackedFiles: []
        });
      });

      expect(await screen.findByText(/missing information in it's \.gitignore/i)).toBeInTheDocument();

      await act(async () => {
        await hooks.handleApplyGitIgnore();
      });

      expect(await screen.findByText(/apply failed/i)).toBeInTheDocument();
    });

    test('handleApplyGitIgnore uses fallback error on unknown failures', async () => {
      render(<CreateProject />);

      mockAxios.post.mockRejectedValueOnce({});

      const hooks = await waitForCreateProjectHooks();

      act(() => {
        hooks.setProgress({
          steps: [{ name: 'Step 1', completed: false }],
          completion: 0,
          status: 'pending',
          statusMessage: 'Waiting...'
        });
        hooks.setGitIgnoreSuggestion({
          projectId: 'proj-gitignore-fallback',
          entries: ['node_modules/'],
          detected: [],
          samplePaths: [],
          trackedFiles: []
        });
      });

      expect(await screen.findByText(/missing information in it's \.gitignore/i)).toBeInTheDocument();

      await act(async () => {
        await hooks.handleApplyGitIgnore();
      });

      expect(await screen.findByText(/failed to update \.gitignore/i)).toBeInTheDocument();
    });

    test('handleSkipGitIgnore surfaces setup failure errors', async () => {
      render(<CreateProject />);

      mockAxios.post.mockResolvedValueOnce({ data: { success: false, error: 'setup failed again' } });

      const hooks = await waitForCreateProjectHooks();

      act(() => {
        hooks.setProgress({
          steps: [{ name: 'Step 1', completed: false }],
          completion: 0,
          status: 'pending',
          statusMessage: 'Waiting...'
        });
        hooks.setGitIgnoreSuggestion({
          projectId: 'proj-gitignore-skip',
          entries: ['node_modules/'],
          detected: [],
          samplePaths: [],
          trackedFiles: []
        });
      });

      expect(await screen.findByText(/missing information in it's \.gitignore/i)).toBeInTheDocument();

      await act(async () => {
        await hooks.handleSkipGitIgnore();
      });

      expect(await screen.findByText(/setup failed again/i)).toBeInTheDocument();
    });

    test('handleSkipGitIgnore uses fallback message on unknown errors', async () => {
      render(<CreateProject />);

      mockAxios.post.mockRejectedValueOnce({});

      const hooks = await waitForCreateProjectHooks();

      act(() => {
        hooks.setProgress({
          steps: [{ name: 'Step 1', completed: false }],
          completion: 0,
          status: 'pending',
          statusMessage: 'Waiting...'
        });
        hooks.setGitIgnoreSuggestion({
          projectId: 'proj-gitignore-fallback',
          entries: ['node_modules/'],
          detected: [],
          samplePaths: [],
          trackedFiles: []
        });
      });

      expect(await screen.findByText(/missing information in it's \.gitignore/i)).toBeInTheDocument();

      await act(async () => {
        await hooks.handleSkipGitIgnore();
      });

      expect(await screen.findByText(/failed to complete project setup/i)).toBeInTheDocument();
    });

    test('handleSkipGitIgnore completes setup successfully', async () => {
      render(<CreateProject />);

      mockAxios.post.mockResolvedValueOnce({ data: { success: true, message: 'Setup done' } });

      const hooks = await waitForCreateProjectHooks();

      act(() => {
        hooks.setProgress({
          steps: [{ name: 'Step 1', completed: false }],
          completion: 0,
          status: 'pending',
          statusMessage: 'Waiting...'
        });
        hooks.setGitIgnoreSuggestion({
          projectId: 'proj-gitignore-skip-success',
          entries: ['node_modules/'],
          detected: [],
          samplePaths: [],
          trackedFiles: []
        });
      });

      expect(await screen.findByText(/missing information in it's \.gitignore/i)).toBeInTheDocument();

      await act(async () => {
        await hooks.handleSkipGitIgnore();
      });

      expect(mockAxios.post).toHaveBeenCalledWith('/api/projects/proj-gitignore-skip-success/setup');
      expect(await screen.findByText(/setup done/i)).toBeInTheDocument();
      await waitFor(() => {
        expect(mockShowMain).toHaveBeenCalled();
      }, { timeout: 3000 });
    });

    test('handleSkipGitIgnore surfaces response error details', async () => {
      render(<CreateProject />);

      mockAxios.post.mockRejectedValueOnce({ response: { data: { error: 'Setup response failed' } } });

      const hooks = await waitForCreateProjectHooks();

      act(() => {
        hooks.setProgress({
          steps: [{ name: 'Step 1', completed: false }],
          completion: 0,
          status: 'pending',
          statusMessage: 'Waiting...'
        });
        hooks.setGitIgnoreSuggestion({
          projectId: 'proj-gitignore-skip-error',
          entries: ['node_modules/'],
          detected: [],
          samplePaths: [],
          trackedFiles: []
        });
      });

      expect(await screen.findByText(/missing information in it's \.gitignore/i)).toBeInTheDocument();

      await act(async () => {
        await hooks.handleSkipGitIgnore();
      });

      expect(await screen.findByText(/setup response failed/i)).toBeInTheDocument();
    });

    test('skips test hook wiring outside test environments', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      const originalHooks = CreateProject.__testHooks;
      CreateProject.__testHooks = undefined;

      try {
        render(<CreateProject />);

        await waitFor(() => {
          expect(CreateProject.__testHooks).toBeUndefined();
        });
      } finally {
        process.env.NODE_ENV = originalEnv;
        CreateProject.__testHooks = originalHooks;
      }
    });

    test('test hook cleanup returns early when hooks are cleared', async () => {
      const { unmount } = render(<CreateProject />);

      const hooks = await waitForCreateProjectHooks();

      CreateProject.__testHooks = undefined;

      expect(hooks).toBeDefined();

      unmount();
    });

    test('handleContinueAfterGitIgnore resets state and navigates away', async () => {
      render(<CreateProject />);

      const hooks = await waitForCreateProjectHooks();

      act(() => {
        hooks.handleContinueAfterGitIgnore();
      });

      expect(mockShowMain).toHaveBeenCalled();
    });

    test('renders continue button when gitignore status is done', async () => {
      render(<CreateProject />);

      const hooks = await waitForCreateProjectHooks();

      act(() => {
        hooks.setProgress({
          steps: [{ name: 'Step 1', completed: true }],
          completion: 100,
          status: 'completed',
          statusMessage: 'Done'
        });
        hooks.setGitIgnoreSuggestion({
          projectId: 'proj-gitignore-continue',
          entries: ['node_modules/'],
          detected: [],
          samplePaths: [],
          trackedFiles: []
        });
        hooks.setGitIgnoreStatus({ state: 'done', error: '' });
      });

      expect(await screen.findByRole('button', { name: /continue to project/i })).toBeInTheDocument();
    });


    test('connects existing repo when global git settings need fallbacks', async () => {
      mockGitSettings = {
        ...defaultGitSettings,
        provider: '',
        username: null,
        defaultBranch: '   '
      };

      const { user } = renderComponent();
      mockImportProject.mockResolvedValue({
        project: { id: 'proj-cloud-fallbacks', name: 'My Project' },
        jobs: []
      });

      render(<CreateProject />);
      await ensureGitStep(user, { source: 'git' });
      await user.type(screen.getByLabelText('Repository URL *'), 'https://github.com/octocat/my-project.git');
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'global');

      await user.click(getNextButton());
      await user.click(getCreateProjectButton());

      await waitFor(() => {
        expect(mockImportProject).toHaveBeenCalledWith(expect.objectContaining({
          gitConnectionMode: 'global'
        }));
      });

      const postBody = mockImportProject.mock.calls[0][0];
      expect(postBody.gitProvider).toBe('github');
      expect(postBody.gitDefaultBranch).toBe('main');
    });

    test('defaults to main branch when global defaultBranch is blank', async () => {
      mockGitSettings = {
        ...defaultGitSettings,
        defaultBranch: ''
      };

      const { user } = renderComponent();
      mockImportProject.mockResolvedValue({
        project: { id: 'proj-cloud-defaultbranch-empty', name: 'My Project' },
        jobs: []
      });

      render(<CreateProject />);
      await ensureGitStep(user, { source: 'git' });
      await user.type(screen.getByLabelText('Repository URL *'), 'https://github.com/octocat/my-project.git');
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'global');

      await user.click(getNextButton());
      await user.click(getCreateProjectButton());

      await waitFor(() => {
        expect(mockImportProject).toHaveBeenCalledWith(expect.objectContaining({
          gitConnectionMode: 'global'
        }));
      });

      const postBody = mockImportProject.mock.calls[0][0];
      expect(postBody.gitDefaultBranch).toBe('main');
    });

    test('falls back to github provider when custom provider is blank', async () => {
      const { user } = renderComponent();
      mockImportProject.mockResolvedValue({
        project: { id: 'proj-cloud-custom-blank-provider', name: 'My Project' },
        jobs: []
      });

      render(<CreateProject />);
      await ensureGitStep(user, { source: 'git' });
      await user.type(screen.getByLabelText('Repository URL *'), 'https://github.com/octocat/my-project.git');
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'custom');

      fireEvent.change(screen.getByLabelText('Git Provider *'), { target: { value: '' } });

      await user.type(screen.getByLabelText('Personal Access Token *'), 'test-token');
      await user.click(getNextButton());
      await user.click(getCreateProjectButton());

      await waitFor(() => {
        expect(mockImportProject).toHaveBeenCalledWith(expect.objectContaining({
          gitConnectionMode: 'custom'
        }));
      });

      const postBody = mockImportProject.mock.calls[0][0];
      expect(postBody.gitProvider).toBe('github');
    });

    test('connects existing repo when using custom cloud workflow (includes token)', async () => {
      const { user } = renderComponent();
      mockImportProject.mockResolvedValue({
        project: { id: 'proj-cloud-custom-connect', name: 'My Project' },
        jobs: []
      });

      render(<CreateProject />);
      await ensureGitStep(user, { source: 'git' });
      await user.type(screen.getByLabelText('Repository URL *'), 'https://gitlab.com/octocat/my-project.git');
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'custom');
      await user.selectOptions(screen.getByLabelText('Git Provider *'), 'gitlab');
      await user.type(screen.getByLabelText('Personal Access Token *'), 'glpat-test');

      await user.click(getNextButton());
      await user.click(getCreateProjectButton());

      await waitFor(() => {
        expect(mockImportProject).toHaveBeenCalledWith(
          expect.objectContaining({
            gitConnectionMode: 'custom',
            gitUrl: 'https://gitlab.com/octocat/my-project.git',
            gitProvider: 'gitlab',
            gitDefaultBranch: 'main',
            gitToken: 'glpat-test'
          })
        );
      });
    });

    test('creates a remote repo when using custom cloud workflow', async () => {
      const { user } = renderComponent();
      mockAxios.post.mockResolvedValue(createSuccessResponse({ project: { id: 'proj-cloud-custom', name: 'My Project' } }));
      mockCreateProjectRemoteRepository.mockResolvedValueOnce({ success: true });

      render(<CreateProject />);
      await goToGitStep(user, 'My Project');
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'custom');
      await user.selectOptions(screen.getByLabelText('Git Provider *'), 'gitlab');
      await user.type(screen.getByLabelText('Personal Access Token *'), 'glpat-test');
      await user.type(screen.getByLabelText('Repository Name'), 'RepoName');

      await user.click(getNextButton());
      await user.click(getCreateProjectButton());

      await waitFor(() => {
        expect(mockCreateProjectRemoteRepository).toHaveBeenCalledWith(
          'proj-cloud-custom',
          expect.objectContaining({
            provider: 'gitlab',
            token: 'glpat-test'
          })
        );
      });
    });

    test('tolerates socket disconnect errors when closing progress stream', async () => {
      const { user } = renderComponent();
      mockAxios.post.mockResolvedValue(createSuccessResponse());

      socketConfig = {
        connectError: false,
        joinResponse: {},
        deferConnect: false,
        throwOnCreate: false,
        throwOnOff: false,
        throwOnDisconnect: true
      };

      render(<CreateProject />);
      await fillProjectName(user, 'My Project');
      await submitForm(user);

      await waitFor(() => {
        expect(mockSelectProject).toHaveBeenCalledWith(expect.objectContaining({ name: 'My Project' }));
      });

      expect(socketInstances.length).toBeGreaterThan(0);
    });

    test('creates project with minimal data (no description)', async () => {
      const { user } = renderComponent();
      mockAxios.post.mockResolvedValue(createSuccessResponse());

      render(<CreateProject />);
      await fillProjectName(user, 'Bare Project');
      await submitForm(user);

      await waitFor(() => {
        expect(mockAxios.post).toHaveBeenCalledWith('/api/projects', expect.objectContaining({
          name: 'Bare Project',
          description: '',
          progressKey: expect.any(String)
        }));
      });
    });

    test('handles missing git username during create flow', async () => {
      mockGitSettings = {
        ...defaultGitSettings,
        username: null
      };

      const { user } = renderComponent();
      mockAxios.post.mockResolvedValue(createSuccessResponse());

      render(<CreateProject />);
      await fillProjectName(user, 'No Username');
      await submitForm(user);

      await waitFor(() => {
        expect(mockAxios.post).toHaveBeenCalledWith('/api/projects', expect.objectContaining({
          name: 'No Username'
        }));
      });
    });

    test('imports a local folder with compatibility consent', async () => {
      const { user } = renderComponent();
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          plan: {
            needsChanges: true,
            changes: [
              { key: 'bind', description: 'Bind dev server to 0.0.0.0' },
              { description: 'No key change' }
            ],
            structure: { needsMove: false }
          }
        })
      });

      try {
        mockImportProject.mockResolvedValue({
          project: { id: 'proj-1', name: 'Local App' },
          jobs: []
        });

        render(<CreateProject />);

        await user.click(screen.getByText('Import a local folder'));
        await user.click(getNextButton());
        await user.type(screen.getByLabelText('Project Folder Path *'), 'C:/projects/local-app');
        await user.click(getNextButton());

        fireEvent.change(screen.getByLabelText('Project Name *'), { target: { value: 'Local App' } });
        await user.click(getCreateProjectButton());

        await screen.findByText('Compatibility updates');
        expect(screen.getByText('No key change')).toBeInTheDocument();
        await user.click(screen.getByText('Allow compatibility updates'));
        await user.click(screen.getByRole('button', { name: 'Import Project' }));

        await waitFor(() => {
          expect(mockImportProject).toHaveBeenCalledWith(expect.objectContaining({
            importMethod: 'local',
            importMode: 'copy',
            localPath: 'C:/projects/local-app',
            applyCompatibility: true,
            name: 'Local App'
          }));
        });
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('clones a repo and creates a new remote repo after import', async () => {
      const { user } = renderComponent();

      mockImportProject.mockResolvedValue({
        project: { id: 'proj-1', name: 'third-party' },
        jobs: []
      });

      render(<CreateProject />);

      await user.click(screen.getByText('Clone from Git'));
      await user.click(getNextButton());

      await user.type(screen.getByLabelText('Repository URL *'), 'https://github.com/third/party.git');
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'global');
      await user.click(screen.getByText('Create a new repo after cloning'));
      await user.type(screen.getByLabelText('Repository Name'), 'my-fork');

      await user.click(getNextButton());
      await user.click(getCreateProjectButton());

      await waitFor(() => {
        expect(mockImportProject).toHaveBeenCalledWith(expect.objectContaining({
          importMethod: 'git',
          gitUrl: 'https://github.com/third/party.git',
          gitConnectionMode: 'global'
        }));
      });

      await waitFor(() => {
        expect(mockCreateProjectRemoteRepository).toHaveBeenCalledWith('proj-1', expect.objectContaining({
          name: 'my-fork'
        }));
      });
    });

    test('trims whitespace from project name and description', async () => {
      const { user } = renderComponent();
      mockAxios.post.mockResolvedValue(createSuccessResponse());

      render(<CreateProject />);
      await fillProjectName(user, '   Spaced Name   ');
      await fillDescription(user, '   spaced description   ');
      await submitForm(user);

      await waitFor(() => {
        expect(mockAxios.post).toHaveBeenCalledWith('/api/projects', expect.objectContaining({
          name: 'Spaced Name',
          description: 'spaced description',
          progressKey: expect.any(String)
        }));
      });
    });

    test('clears polling suppression after progress updates', async () => {
      const { user } = renderComponent();
      mockAxios.post.mockResolvedValue(
        createSuccessResponse({
          progress: {
            steps: [{ name: 'Step 1', completed: false }],
            completion: 0,
            status: 'in-progress',
            statusMessage: 'Working...'
          }
        })
      );
      mockAxios.get.mockResolvedValue({ data: { success: false } });

      render(<CreateProject />);
      await fillProjectName(user, 'Polling Progress');
      await submitForm(user);

      expect(await screen.findByText('Working...')).toBeInTheDocument();

      await waitFor(() => {
        expect(mockShowMain).toHaveBeenCalled();
      }, { timeout: 3000 });
    });

    test('normalizes backend progress when server omits metrics', async () => {
      const { user } = renderComponent();
      mockAxios.post.mockResolvedValue(
        createSuccessResponse({
          progress: {
            steps: [],
            statusMessage: '',
            status: undefined,
            completion: undefined
          }
        })
      );

      render(<CreateProject />);
      await fillProjectName(user, 'Fallback Progress');
      await submitForm(user);

      await waitFor(() => {
        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
      });

      expect(screen.getByText('Project created successfully')).toBeInTheDocument();
      expect(screen.getByText('Creating directories')).toBeInTheDocument();
      expect(screen.getByText('Starting development servers')).toBeInTheDocument();
    });

    test('fills missing step names and derives completion when backend progress lacks details', async () => {
      const { user } = renderComponent();
      const partialSteps = [
        { completed: true },
        { completed: false },
        { name: '', completed: true },
        { name: null, completed: false },
        { name: undefined, completed: false },
        { completed: true }
      ];
      mockAxios.post.mockResolvedValue(
        createSuccessResponse({
          progress: {
            steps: partialSteps,
            completion: undefined,
            status: undefined,
            statusMessage: undefined
          }
        })
      );

      render(<CreateProject />);
      await fillProjectName(user, 'Partial Progress');
      await submitForm(user);

      await waitFor(() => {
        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
      });

      expect(screen.getByText('Creating directories')).toBeInTheDocument();
      expect(screen.getByText('Step 6')).toBeInTheDocument();
    });

    test('derives zero completion when backend progress has no completed steps', async () => {
      const { user } = renderComponent();
      const emptyProgressSteps = Array.from({ length: 5 }, (_, index) => ({
        name: `Custom Step ${index + 1}`,
        completed: false
      }));
      mockAxios.post.mockResolvedValue(
        createSuccessResponse({
          progress: {
            steps: emptyProgressSteps,
            completion: undefined,
            status: undefined,
            statusMessage: undefined
          }
        })
      );

      render(<CreateProject />);
      await fillProjectName(user, 'Zero Progress');
      await submitForm(user);

      await waitFor(() => {
        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
      });

      expect(screen.getByText('Custom Step 1')).toBeInTheDocument();
    });
  });

  describe('Loading States', () => {
    test('shows loading state during project creation', async () => {
      const { user } = renderComponent();
      let resolveRequest;
      mockAxios.post.mockReturnValue(new Promise((resolve) => {
        resolveRequest = resolve;
      }));

      render(<CreateProject />);
      await fillProjectName(user, 'Loading Project');
      await submitForm(user);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /creating project/i, hidden: true })).toBeDisabled();
      });

      resolveRequest({ data: { success: false } });
    });

    test('hides form and shows progress at top during creation', async () => {
      const { user } = renderComponent();
      let resolveRequest;
      mockAxios.post.mockReturnValue(new Promise((resolve) => {
        resolveRequest = resolve;
      }));

      render(<CreateProject />);
      await fillProjectName(user, 'Progress Project');
      await submitForm(user);

      await waitFor(() => {
        expect(screen.getByText('Creating your project...')).toBeInTheDocument();
        expect(screen.getByRole('form', { hidden: true })).not.toBeVisible();
      });

      resolveRequest({ data: { success: false } });
    });

    test('hides header during project creation', async () => {
      const { user } = renderComponent();
      let resolveRequest;
      mockAxios.post.mockReturnValue(new Promise((resolve) => {
        resolveRequest = resolve;
      }));

      render(<CreateProject />);
      await fillProjectName(user, 'Header Project');
      await submitForm(user);

      const header = screen.getByText('Add Project').closest('.create-project-header');
      await waitFor(() => expect(header).toHaveStyle({ display: 'none' }));

      resolveRequest({ data: { success: false } });
    });

    test('shows progress steps during creation', async () => {
      const { user } = renderComponent();
      let resolveRequest;
      mockAxios.post.mockReturnValue(new Promise((resolve) => {
        resolveRequest = resolve;
      }));

      render(<CreateProject />);
      await fillProjectName(user, 'Steps Project');
      await submitForm(user);

      await waitFor(() => {
        expect(screen.getByText('Creating directories')).toBeInTheDocument();
        expect(screen.getByText('Generating files')).toBeInTheDocument();
        expect(screen.getByText('Initializing git repository')).toBeInTheDocument();
        expect(screen.getByText('Installing dependencies')).toBeInTheDocument();
        expect(screen.getByText('Starting development servers')).toBeInTheDocument();
      });

      resolveRequest({ data: { success: false } });
    });

    test('shows progress bar during creation', async () => {
      const { user } = renderComponent();
      let resolveRequest;
      mockAxios.post.mockReturnValue(new Promise((resolve) => {
        resolveRequest = resolve;
      }));

      render(<CreateProject />);
      await fillProjectName(user, 'Progress Bar Project');
      await submitForm(user);

      await waitFor(() => {
        expect(screen.getByRole('progressbar')).toBeInTheDocument();
      });

      resolveRequest({ data: { success: false } });
    });

    test('disables form inputs during creation', async () => {
      const { user } = renderComponent();
      let resolveRequest;
      mockAxios.post.mockReturnValue(new Promise((resolve) => {
        resolveRequest = resolve;
      }));

      render(<CreateProject />);
      await fillProjectName(user, 'Disable Project');
      await submitForm(user);

      await waitFor(() => {
        expect(screen.getByLabelText('Project Name *')).toBeDisabled();
        expect(screen.getByText('Contacting backend server...')).toBeInTheDocument();
      });

      resolveRequest({ data: { success: false } });
    });

    test('shows form again after successful creation', async () => {
      const { user } = renderComponent();
      mockAxios.post.mockResolvedValue(createSuccessResponse());

      render(<CreateProject />);
      await fillProjectName(user, 'Success Project');
      await submitForm(user);

      await waitFor(() => expect(mockAxios.post).toHaveBeenCalled());
      await waitFor(() => expect(mockShowMain).toHaveBeenCalled(), { timeout: 3000 });
    });

    test('shows form again after creation error', async () => {
      const { user } = renderComponent();
      mockAxios.post.mockRejectedValue(new Error('creation failed'));

      render(<CreateProject />);
      await fillProjectName(user, 'Error Project');
      await submitForm(user);

      await waitFor(() => expect(screen.getByText('creation failed')).toBeInTheDocument());
      const header = screen.getByText('Add Project').closest('.create-project-header');
      expect(header).toHaveStyle({ display: 'block' });
    });
  });

  describe('Progress Reporting', () => {
    test('treats a non-object progress snapshot as empty and falls back to completed progress', async () => {
      const { user } = renderComponent();
      mockAxios.post.mockResolvedValue(
        createSuccessResponse({
          progress: 'not-an-object',
          message: 'All done'
        })
      );

      render(<CreateProject />);
      await fillProjectName(user, 'Progress Guard');
      await submitForm(user);

      await waitFor(() => {
        expect(screen.getByText('All done')).toBeInTheDocument();
        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
      });
    });

    test('treats an empty progress snapshot as empty and falls back to completed progress', async () => {
      const { user } = renderComponent();
      mockAxios.post.mockResolvedValue(
        createSuccessResponse({
          progress: {
            steps: [],
            status: null,
            completion: null,
            statusMessage: '',
            error: ''
          }
        })
      );

      render(<CreateProject />);
      await fillProjectName(user, 'Empty Snapshot');
      await submitForm(user);

      await waitFor(() => {
        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
        expect(screen.getByText('Project created successfully')).toBeInTheDocument();
      });
    });

    test('normalizes null progress events to a default pending progress snapshot', async () => {
      const { user } = renderComponent();
      let resolveRequest;
      mockAxios.post.mockReturnValue(
        new Promise((resolve) => {
          resolveRequest = resolve;
        })
      );

      render(<CreateProject />);
      await fillProjectName(user, 'Null Progress Event');
      await submitForm(user);

      await waitFor(() => expect(MockEventSource.instances.length).toBe(1));
      const stream = MockEventSource.instances[0];

      await act(async () => {
        stream.emitProgress(null);
      });

      expect(await screen.findByText('Working...')).toBeInTheDocument();
      resolveRequest({ data: { success: false } });
    });

    test('infers completion and status when all steps are completed without declaring status', async () => {
      const { user } = renderComponent();
      let resolveRequest;
      mockAxios.post.mockReturnValue(
        new Promise((resolve) => {
          resolveRequest = resolve;
        })
      );

      render(<CreateProject />);
      await fillProjectName(user, 'All Steps Completed');
      await submitForm(user);

      await waitFor(() => expect(MockEventSource.instances.length).toBe(1));

      await act(async () => {
        MockEventSource.instances[0].emitProgress({
          steps: [
            { name: 'Creating directories', completed: true },
            { name: 'Generating files', completed: true },
            { name: 'Initializing git repository', completed: true },
            { name: 'Installing dependencies', completed: true },
            { name: 'Starting development servers', completed: true }
          ]
        });
      });

      await waitFor(() => {
        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
        expect(screen.getByText('Project created successfully')).toBeInTheDocument();
      });

      resolveRequest({ data: { success: false } });
    });

    test('polling ignores transient errors (e.g. 404 before progress initializes)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));

      mockAxios.get.mockRejectedValue(new Error('not found'));

      let resolveRequest;
      mockAxios.post.mockReturnValue(
        new Promise((resolve) => {
          resolveRequest = resolve;
        })
      );

      render(<CreateProject />);
      goToGitStepWithFireEvent();
      fireEvent.change(screen.getByLabelText('Git Workflow *'), { target: { value: 'local' } });
      fireEvent.click(getNextButton());
      fireEvent.change(screen.getByLabelText('Project Name *'), {
        target: { value: 'Polling Error' }
      });
      fireEvent.click(getCreateProjectButton());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(260);
      });

      expect(mockAxios.get).toHaveBeenCalled();
      expect(screen.getByText('Contacting backend server...')).toBeInTheDocument();

      resolveRequest({ data: { success: false } });
      vi.useRealTimers();
    });

    test('polls for progress and suppresses polling when recent stream updates exist', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));

      mockAxios.get.mockResolvedValue({
        data: {
          success: true,
          progress: {
            status: 'in-progress',
            completion: 10,
            steps: [],
            statusMessage: 'Polled update'
          }
        }
      });

      let resolveRequest;
      mockAxios.post.mockReturnValue(
        new Promise((resolve) => {
          resolveRequest = resolve;
        })
      );

      render(<CreateProject />);
      goToGitStepWithFireEvent();
      fireEvent.change(screen.getByLabelText('Git Workflow *'), { target: { value: 'local' } });
      fireEvent.click(getNextButton());
      fireEvent.change(screen.getByLabelText('Project Name *'), {
        target: { value: 'Polling Project' }
      });
      fireEvent.click(getCreateProjectButton());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(260);
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(screen.getByText('Polled update')).toBeInTheDocument();
      const initialPollCalls = mockAxios.get.mock.calls.length;
      expect(initialPollCalls).toBeGreaterThan(0);

      // Interval tick at 1s should be suppressed because the last update was recent.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(740);
      });

      expect(mockAxios.get).toHaveBeenCalledTimes(initialPollCalls);

      // After enough time has passed, polling should resume.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1100);
      });

      expect(mockAxios.get.mock.calls.length).toBeGreaterThan(initialPollCalls);

      resolveRequest({ data: { success: false } });
      vi.useRealTimers();
    });

    test('skips interval polling when the timestamp guard is still within the suppression window', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);

      mockAxios.get.mockResolvedValue({ data: { success: false } });

      let resolveRequest;
      mockAxios.post.mockReturnValue(
        new Promise((resolve) => {
          resolveRequest = resolve;
        })
      );

      render(<CreateProject />);
      goToGitStepWithFireEvent();
      fireEvent.change(screen.getByLabelText('Git Workflow *'), { target: { value: 'local' } });
      fireEvent.click(getNextButton());
      fireEvent.change(screen.getByLabelText('Project Name *'), {
        target: { value: 'Timestamp Guard' }
      });
      fireEvent.click(getCreateProjectButton());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(260);
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(mockAxios.get).toHaveBeenCalledTimes(1);
      mockAxios.get.mockClear();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(740);
      });

      expect(mockAxios.get).not.toHaveBeenCalled();

      resolveRequest({ data: { success: false } });
      vi.useRealTimers();
    });

    test('ignores socket updates when payload has a null progress field', async () => {
      const { user } = renderComponent();
      socketConfig = {
        connectError: false,
        joinResponse: { ok: true, progressKey: 'ignored', progress: { steps: [], completion: 0 } }
      };

      let resolveRequest;
      mockAxios.post.mockReturnValue(
        new Promise((resolve) => {
          resolveRequest = resolve;
        })
      );

      render(<CreateProject />);
      await fillProjectName(user, 'Null Progress Payload');
      await submitForm(user);

      await waitFor(() => expect(socketInstances.length).toBe(1));

      await act(async () => {
        socketInstances[0].trigger('progress:update', { progress: null });
      });

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
      resolveRequest({ data: { success: false } });
    });

    test('shows backend connection status while waiting for response', async () => {
      const { user } = renderComponent();
      let resolveRequest;
      mockAxios.post.mockReturnValue(new Promise((resolve) => {
        resolveRequest = resolve;
      }));

      render(<CreateProject />);
      await fillProjectName(user, 'Status Project');
      await submitForm(user);

      await waitFor(() => {
        expect(screen.getByText('Contacting backend server...')).toBeInTheDocument();
      });

      resolveRequest({ data: { success: false } });
    });

    test('does not mark progress steps completed before backend responds', async () => {
      const { user } = renderComponent();
      let resolveRequest;
      mockAxios.post.mockReturnValue(new Promise((resolve) => {
        resolveRequest = resolve;
      }));

      render(<CreateProject />);
      await fillProjectName(user, 'Honest Progress Project');
      await submitForm(user);

      const step = await screen.findByText('Creating directories');
      const stepContainer = step.closest('.progress-step');
      expect(stepContainer).not.toHaveClass('completed');

      resolveRequest({ data: { success: false } });
    });

    test('uses backend provided progress data when available', async () => {
      const { user } = renderComponent();
      const serverProgress = {
        completion: 62,
        statusMessage: 'Scaffolding almost complete',
        steps: [
          { name: 'Creating directories', completed: true },
          { name: 'Generating files', completed: true },
          { name: 'Initializing git repository', completed: false },
          { name: 'Installing dependencies', completed: false },
          { name: 'Starting development servers', completed: false }
        ]
      };
      mockAxios.post.mockResolvedValue(createSuccessResponse({ progress: serverProgress }));

      render(<CreateProject />);
      await fillProjectName(user, 'Server Progress Project');
      await submitForm(user);

      await waitFor(() => {
        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '62');
        expect(screen.getByText('Scaffolding almost complete')).toBeInTheDocument();
      });

      const firstStep = screen.getByText('Creating directories').closest('.progress-step');
      const lastStep = screen.getByText('Starting development servers').closest('.progress-step');
      expect(firstStep).toHaveClass('completed');
      expect(lastStep).not.toHaveClass('completed');
    });

    test('opens a server-sent events stream for progress updates', async () => {
      const { user } = renderComponent();
      let resolveRequest;
      mockAxios.post.mockReturnValue(new Promise((resolve) => {
        resolveRequest = resolve;
      }));

      render(<CreateProject />);
      await fillProjectName(user, 'Stream Project');
      await submitForm(user);

      await waitFor(() => {
        expect(MockEventSource.instances.length).toBe(1);
      });
      expect(MockEventSource.instances[0].url).toMatch(/\/api\/projects\/progress\/.+\/stream$/);

      resolveRequest({ data: { success: false } });
    });

    test('cleans up the progress stream on unmount', async () => {
      const { user } = renderComponent();
      let resolveRequest;
      mockAxios.post.mockReturnValue(new Promise((resolve) => {
        resolveRequest = resolve;
      }));

      const { unmount } = render(<CreateProject />);
      await fillProjectName(user, 'Stream Cleanup');
      await submitForm(user);

      await waitFor(() => {
        expect(MockEventSource.instances.length).toBe(1);
      });

      const stream = MockEventSource.instances[0];
      expect(stream.closed).toBe(false);

      expect(() => unmount()).not.toThrow();
      expect(stream.closed).toBe(true);

      resolveRequest({ data: { success: false } });
    });

    test('tolerates socket disconnect errors on unmount', async () => {
      const { user } = renderComponent();
      let resolveRequest;
      mockAxios.post.mockReturnValue(new Promise((resolve) => {
        resolveRequest = resolve;
      }));

      socketConfig = {
        connectError: false,
        joinResponse: { ok: true, progressKey: 'ignored', progress: { steps: [], completion: 0 } },
        deferConnect: false,
        throwOnCreate: false,
        throwOnOff: false,
        throwOnDisconnect: true
      };

      const { unmount } = render(<CreateProject />);
      await fillProjectName(user, 'Socket Cleanup');
      await submitForm(user);

      await waitFor(() => {
        expect(socketInstances.length).toBe(1);
      });

      expect(() => unmount()).not.toThrow();

      resolveRequest({ data: { success: false } });
    });

    test('opens a socket stream for progress updates when available', async () => {
      const { user } = renderComponent();
      socketConfig = {
        connectError: false,
        joinResponse: { ok: true, progressKey: 'ignored', progress: { steps: [], completion: 0 } }
      };

      let resolveRequest;
      mockAxios.post.mockReturnValue(new Promise((resolve) => {
        resolveRequest = resolve;
      }));

      render(<CreateProject />);
      await fillProjectName(user, 'Socket Progress');
      await submitForm(user);

      await waitFor(() => {
        expect(socketInstances.length).toBe(1);
        expect(socketInstances[0].emitted.some((entry) => entry.event === 'progress:join')).toBe(true);
      });

      expect(MockEventSource.instances.length).toBe(0);

      resolveRequest({ data: { success: false } });
    });

    test('applies updates emitted through the socket progress stream', async () => {
      const { user } = renderComponent();
      socketConfig = {
        connectError: false,
        joinResponse: { ok: true, progressKey: 'ignored', progress: { steps: [], completion: 0 } }
      };

      let resolveRequest;
      mockAxios.post.mockReturnValue(new Promise((resolve) => {
        resolveRequest = resolve;
      }));

      render(<CreateProject />);
      await fillProjectName(user, 'Socket Updates');
      await submitForm(user);

      await waitFor(() => expect(socketInstances.length).toBe(1));

      await act(async () => {
        socketInstances[0].trigger('progress:update', {
          progress: {
            steps: [
              { name: 'Creating directories', completed: true },
              { name: 'Generating files', completed: false },
              { name: 'Initializing git repository', completed: false },
              { name: 'Installing dependencies', completed: false },
              { name: 'Starting development servers', completed: false }
            ],
            completion: 25,
            statusMessage: 'Directories ready'
          }
        });
        socketInstances[0].trigger('progress:update', null);
        socketInstances[0].trigger('progress:update', {
          steps: [],
          completion: 30,
          statusMessage: 'Plain progress payload'
        });
      });

      expect(await screen.findByText('Plain progress payload')).toBeInTheDocument();

      resolveRequest({ data: { success: false } });
    });

    test('ignores socket fallback when already settled', async () => {
      const { user } = renderComponent();
      socketConfig = {
        connectError: false,
        joinResponse: { ok: true, progressKey: 'ignored', progress: { steps: [], completion: 0 } },
        deferConnect: false,
        throwOnCreate: false,
        throwOnOff: false,
        throwOnDisconnect: false
      };

      let resolveRequest;
      mockAxios.post.mockReturnValue(new Promise((resolve) => {
        resolveRequest = resolve;
      }));

      render(<CreateProject />);
      await fillProjectName(user, 'Socket Settled');
      await submitForm(user);

      await waitFor(() => {
        expect(socketInstances.length).toBe(1);
        expect(socketInstances[0].emitted.some((entry) => entry.event === 'progress:join')).toBe(true);
      });

      await act(async () => {
        socketInstances[0].trigger('connect_error', new Error('late error'));
      });

      expect(MockEventSource.instances.length).toBe(0);

      resolveRequest({ data: { success: false } });
    });

    test('falls back to EventSource when socket join fails', async () => {
      const { user } = renderComponent();
      socketConfig = {
        connectError: false,
        joinResponse: { error: 'join failed' },
        deferConnect: false,
        throwOnCreate: false,
        throwOnOff: false,
        throwOnDisconnect: false
      };

      let resolveRequest;
      mockAxios.post.mockReturnValue(new Promise((resolve) => {
        resolveRequest = resolve;
      }));

      render(<CreateProject />);
      await fillProjectName(user, 'Socket Fallback');
      await submitForm(user);

      await waitFor(() => expect(MockEventSource.instances.length).toBe(1));
      expect(socketInstances[0].offCalls.map((call) => call.event)).toEqual(
        expect.arrayContaining(['connect', 'connect_error', 'progress:sync', 'progress:update'])
      );

      resolveRequest({ data: { success: false } });
    });

    test('falls back even when socket cleanup throws', async () => {
      const { user } = renderComponent();
      socketConfig = {
        connectError: false,
        joinResponse: { error: 'join failed' },
        deferConnect: false,
        throwOnCreate: false,
        throwOnOff: true,
        throwOnDisconnect: false
      };

      let resolveRequest;
      mockAxios.post.mockReturnValue(new Promise((resolve) => {
        resolveRequest = resolve;
      }));

      render(<CreateProject />);
      await fillProjectName(user, 'Socket Cleanup Throw');
      await submitForm(user);

      await waitFor(() => expect(MockEventSource.instances.length).toBe(1));

      resolveRequest({ data: { success: false } });
    });

    test('falls back to EventSource when socket client creation throws', async () => {
      const { user } = renderComponent();
      socketConfig = {
        connectError: false,
        joinResponse: { ok: true },
        deferConnect: false,
        throwOnCreate: true
      };

      let resolveRequest;
      mockAxios.post.mockReturnValue(new Promise((resolve) => {
        resolveRequest = resolve;
      }));

      render(<CreateProject />);
      await fillProjectName(user, 'Socket Throw');
      await submitForm(user);

      await waitFor(() => expect(MockEventSource.instances.length).toBe(1));
      expect(socketInstances.length).toBe(0);

      resolveRequest({ data: { success: false } });
    });

    test('applies updates emitted through the progress stream', async () => {
      const { user } = renderComponent();
      let resolveRequest;
      mockAxios.post.mockReturnValue(new Promise((resolve) => {
        resolveRequest = resolve;
      }));

      render(<CreateProject />);
      await fillProjectName(user, 'Live Update Project');
      await submitForm(user);

      await waitFor(() => {
        expect(MockEventSource.instances.length).toBe(1);
      });

      const payload = {
        steps: [
          { name: 'Creating directories', completed: true },
          { name: 'Generating files', completed: false },
          { name: 'Initializing git repository', completed: false },
          { name: 'Installing dependencies', completed: false },
          { name: 'Starting development servers', completed: false }
        ],
        completion: 25,
        statusMessage: 'Directories ready'
      };

      await act(async () => {
        MockEventSource.instances[0].emitProgress(payload);
      });

      expect(await screen.findByText('Directories ready')).toBeInTheDocument();
      const generatingStep = screen.getByText('Generating files').closest('.progress-step');
      expect(generatingStep).not.toHaveClass('completed');

      resolveRequest({ data: { success: false } });
    });

    test('displays progress error when stream reports failure', async () => {
      const { user } = renderComponent();
      let resolveRequest;
      mockAxios.post.mockReturnValue(new Promise((resolve) => {
        resolveRequest = resolve;
      }));

      render(<CreateProject />);
      await fillProjectName(user, 'Failed Stream');
      await submitForm(user);

      await waitFor(() => expect(MockEventSource.instances.length).toBe(1));
      const stream = MockEventSource.instances[0];

      await act(async () => {
        stream.emitProgress({
          status: 'failed',
          error: 'Stream exploded',
          steps: [],
          completion: 20
        });
      });

      await waitFor(() => {
        const matches = screen.getAllByText('Stream exploded');
        expect(matches.some((node) => node.classList.contains('progress-error'))).toBe(true);
      });
      expect(getCreateProjectButton()).not.toBeDisabled();
      expect(stream.closed).toBe(true);

      resolveRequest({ data: { success: false } });
    });

    test('closes progress stream when EventSource emits an error', async () => {
      const { user } = renderComponent();
      let resolveRequest;
      mockAxios.post.mockReturnValue(new Promise((resolve) => {
        resolveRequest = resolve;
      }));

      render(<CreateProject />);
      await fillProjectName(user, 'Stream Error');
      await submitForm(user);

      await waitFor(() => expect(MockEventSource.instances.length).toBe(1));
      const stream = MockEventSource.instances[0];

      await act(async () => {
        stream.emitError();
      });

      expect(stream.closed).toBe(true);
      resolveRequest({ data: { success: false } });
    });

    test('ignores malformed progress events from the stream', async () => {
      const { user } = renderComponent();
      let resolveRequest;
      mockAxios.post.mockReturnValue(new Promise((resolve) => {
        resolveRequest = resolve;
      }));

      render(<CreateProject />);
      await fillProjectName(user, 'Malformed Stream');
      await submitForm(user);

      await waitFor(() => expect(MockEventSource.instances.length).toBe(1));
      const stream = MockEventSource.instances[0];

      await act(async () => {
        stream.emitRaw('not json');
      });

      expect(screen.getByText('Contacting backend server...')).toBeInTheDocument();
      resolveRequest({ data: { success: false } });
    });

    test('uses onmessage fallback when addEventListener is unavailable', async () => {
      const { user } = renderComponent();
      const originalEventSource = window.EventSource;

      class LegacyEventSource extends MockEventSource {
        constructor(url) {
          super(url);
          this.addEventListener = undefined;
        }
      }

      window.EventSource = LegacyEventSource;

      let resolveRequest;
      mockAxios.post.mockReturnValue(new Promise((resolve) => {
        resolveRequest = resolve;
      }));

      try {
        render(<CreateProject />);
        await fillProjectName(user, 'Legacy Stream');
        await submitForm(user);

        await waitFor(() => expect(MockEventSource.instances.length).toBe(1));
        const stream = MockEventSource.instances[0];
        expect(typeof stream.onmessage).toBe('function');

        await act(async () => {
          stream.emitProgress({
            status: 'in-progress',
            completion: 10,
            steps: []
          });
        });
      } finally {
        window.EventSource = originalEventSource;
        resolveRequest({ data: { success: false } });
      }
    });

    test('skips progress streaming when EventSource API is missing', async () => {
      const { user } = renderComponent();
      const originalEventSource = window.EventSource;
      window.EventSource = undefined;

      let resolveRequest;
      mockAxios.post.mockReturnValue(new Promise((resolve) => {
        resolveRequest = resolve;
      }));

      try {
        render(<CreateProject />);
        await fillProjectName(user, 'No Stream Support');
        await submitForm(user);

        expect(MockEventSource.instances.length).toBe(0);
        expect(socketInstances.length).toBe(1);
        expect(await screen.findByText('Contacting backend server...')).toBeInTheDocument();
      } finally {
        window.EventSource = originalEventSource;
        resolveRequest({ data: { success: false } });
      }
    });

    test('uses socket streaming when EventSource API is missing', async () => {
      const { user } = renderComponent();
      const originalEventSource = window.EventSource;
      window.EventSource = undefined;
      socketConfig = {
        connectError: false,
        joinResponse: { ok: true, progressKey: 'ignored', progress: { steps: [], completion: 0 } }
      };

      let resolveRequest;
      mockAxios.post.mockReturnValue(new Promise((resolve) => {
        resolveRequest = resolve;
      }));

      try {
        render(<CreateProject />);
        await fillProjectName(user, 'No SSE Socket Progress');
        await submitForm(user);

        await waitFor(() => expect(socketInstances.length).toBe(1));
        expect(MockEventSource.instances.length).toBe(0);

        await act(async () => {
          socketInstances[0].trigger('progress:update', {
            progress: {
              steps: [],
              completion: 10,
              statusMessage: 'Socket only'
            }
          });
        });

        expect(await screen.findByText('Socket only')).toBeInTheDocument();
      } finally {
        window.EventSource = originalEventSource;
        resolveRequest({ data: { success: false } });
      }
    });

    test('continues when EventSource constructor throws', async () => {
      const { user } = renderComponent();
      const originalEventSource = window.EventSource;

      class ExplodingEventSource {
        constructor() {
          throw new Error('boom');
        }
      }

      window.EventSource = ExplodingEventSource;
      mockAxios.post.mockResolvedValue(createSuccessResponse());

      try {
        render(<CreateProject />);
        await fillProjectName(user, 'Exploding Stream');
        await submitForm(user);

        await waitFor(() => expect(mockAxios.post).toHaveBeenCalled());
        expect(MockEventSource.instances.length).toBe(0);
      } finally {
        window.EventSource = originalEventSource;
      }
    });

    test('uses timestamp-based progress keys when randomUUID is unavailable', async () => {
      const { user } = renderComponent();
      const originalRandomUUID = globalThis.crypto.randomUUID;
      globalThis.crypto.randomUUID = undefined;

      let resolveRequest;
      mockAxios.post.mockReturnValue(new Promise((resolve) => {
        resolveRequest = resolve;
      }));

      try {
        render(<CreateProject />);
        await fillProjectName(user, 'Key Fallback');
        await submitForm(user);

        await waitFor(() => expect(MockEventSource.instances.length).toBe(1));
        const match = MockEventSource.instances[0].url.match(/progress\/([^/]+)\/stream$/);
        expect(match).toBeTruthy();
        const progressKey = decodeURIComponent(match[1]);
        expect(progressKey.startsWith('progress-')).toBe(true);
      } finally {
        globalThis.crypto.randomUUID = originalRandomUUID;
        resolveRequest({ data: { success: false } });
      }
    });
  });

  describe('Error Handling', () => {
    test('shows error message on creation failure', async () => {
      const { user } = renderComponent();
      mockAxios.post.mockRejectedValue(new Error('Server down'));

      render(<CreateProject />);
      await fillProjectName(user, 'Fail Project');
      await submitForm(user);

      await waitFor(() => expect(screen.getByText('Server down')).toBeInTheDocument());
    });

    test('shows specific error message for duplicate project names', async () => {
      const { user } = renderComponent();
      mockAxios.post.mockRejectedValue({ response: { data: { error: 'Project name already exists' } } });

      render(<CreateProject />);
      await fillProjectName(user, 'Dup Project');
      await submitForm(user);

      await waitFor(() => expect(screen.getByText('Project name already exists')).toBeInTheDocument());
    });

    test('clears duplicate name error when project name is changed', async () => {
      const { user } = renderComponent();
      mockAxios.post.mockRejectedValue({ response: { data: { error: 'Project name already exists' } } });

      render(<CreateProject />);
      await fillProjectName(user, 'Dup Project');
      await submitForm(user);
      await waitFor(() => expect(screen.getByText('Project name already exists')).toBeInTheDocument());

      await user.click(within(screen.getByRole('form')).getByRole('button', { name: /back/i }));
      await fillProjectName(user, 'New Name');

      expect(screen.queryByText('Project name already exists')).not.toBeInTheDocument();
    });

    test('shows generic error message when no specific error provided', async () => {
      const { user } = renderComponent();
      mockAxios.post.mockRejectedValue({});

      render(<CreateProject />);
      await fillProjectName(user, 'Generic Project');
      await submitForm(user);

      await waitFor(() => expect(screen.getByText('Project creation failed')).toBeInTheDocument());
    });

    test('re-enables form after error', async () => {
      const { user } = renderComponent();
      mockAxios.post.mockRejectedValue(new Error('Server down'));

      render(<CreateProject />);
      await fillProjectName(user, 'Reenable Project');
      await submitForm(user);

      await waitFor(() => expect(screen.getByText('Server down')).toBeInTheDocument());
      expect(getCreateProjectButton()).not.toBeDisabled();
    });

    test('shows actionable error when backend server is unreachable', async () => {
      const { user } = renderComponent();
      const networkError = new Error('Network Error');
      networkError.code = 'ERR_NETWORK';
      networkError.request = {};
      mockAxios.post.mockRejectedValue(networkError);

      render(<CreateProject />);
      await fillProjectName(user, 'Offline Backend Project');
      await submitForm(user);

      await waitFor(() => expect(screen.getByText(BACKEND_UNAVAILABLE_MESSAGE)).toBeInTheDocument());
    });
  });

  describe('Navigation', () => {
    test('cancel button resets form and calls showMain', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await fillProjectName(user, 'Cancel Project');
      await fillDescription(user, 'Cancel description');
      await user.selectOptions(screen.getByLabelText('Frontend Language *'), 'typescript');
      await user.selectOptions(screen.getByLabelText('Backend Language *'), 'python');

      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.getByText('Project Source')).toBeInTheDocument();
      expect(screen.queryByLabelText('Project Name *')).not.toBeInTheDocument();
      expect(mockShowMain).toHaveBeenCalled();
    });

    test('close button calls showMain', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await user.click(screen.getByRole('button', { name: /close add project/i }));

      expect(mockShowMain).toHaveBeenCalled();
    });
  });

  describe('Technology Stack Options', () => {
    test('shows all available languages', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await ensureDetailsStep(user);
      const backendSelect = screen.getByLabelText('Backend Language *');
      const optionValues = within(backendSelect)
        .getAllByRole('option')
        .map((option) => option.value);

      expect(optionValues).toEqual([
        'javascript',
        'typescript',
        'python',
        'java',
        'csharp',
        'go',
        'rust',
        'php',
        'ruby',
        'swift'
      ]);
    });

    test('language options are properly capitalized', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await ensureDetailsStep(user);
      const backendSelect = screen.getByLabelText('Backend Language *');
      const optionLabels = within(backendSelect)
        .getAllByRole('option')
        .map((option) => option.textContent);

      expect(optionLabels.every((label) => label && label[0] === label[0].toUpperCase())).toBe(true);
    });

    test('framework options are properly capitalized', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await ensureDetailsStep(user);
      const frameworkSelect = screen.getByLabelText('Frontend Framework *');
      const optionLabels = within(frameworkSelect)
        .getAllByRole('option')
        .map((option) => option.textContent);

      expect(optionLabels.every((label) => label && label[0] === label[0].toUpperCase())).toBe(true);
    });

    test('falls back to React frameworks when frontend language has no mapping', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await ensureDetailsStep(user);
      const frontendLanguage = screen.getByLabelText('Frontend Language *');
      fireEvent.change(frontendLanguage, { target: { value: 'elm' } });

      const frontendFramework = screen.getByLabelText('Frontend Framework *');
      const optionValues = within(frontendFramework)
        .getAllByRole('option')
        .map((option) => option.value);

      expect(optionValues).toEqual(['react']);
      expect(frontendFramework).toHaveValue('react');
    });

    test('falls back to Express frameworks when backend language has no mapping', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await ensureDetailsStep(user);
      const backendLanguage = screen.getByLabelText('Backend Language *');
      fireEvent.change(backendLanguage, { target: { value: 'scala' } });

      const backendFramework = screen.getByLabelText('Backend Framework *');
      const optionValues = within(backendFramework)
        .getAllByRole('option')
        .map((option) => option.value);

      expect(optionValues).toEqual(['express']);
      expect(backendFramework).toHaveValue('express');
    });
  });

  describe('Accessibility', () => {
    test('form has proper labels', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await ensureDetailsStep(user);

      expect(screen.getByLabelText('Project Name *')).toBeInTheDocument();
      expect(screen.getByLabelText('Description')).toBeInTheDocument();
      expect(screen.getByLabelText('Frontend Language *')).toBeInTheDocument();
      expect(screen.getByLabelText('Frontend Framework *')).toBeInTheDocument();
      expect(screen.getByLabelText('Backend Language *')).toBeInTheDocument();
      expect(screen.getByLabelText('Backend Framework *')).toBeInTheDocument();
    });

    test('required fields are marked with asterisk', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await ensureDetailsStep(user);

      expect(screen.getByText('Project Name *')).toHaveTextContent('*');
      expect(screen.getByText('Frontend Language *')).toHaveTextContent('*');
      expect(screen.getByText('Frontend Framework *')).toHaveTextContent('*');
      expect(screen.getByText('Backend Language *')).toHaveTextContent('*');
      expect(screen.getByText('Backend Framework *')).toHaveTextContent('*');
    });

    test('form inputs have proper placeholders', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await ensureDetailsStep(user);

      expect(screen.getByPlaceholderText('Enter project name')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Brief description of your project')).toBeInTheDocument();
    });
  });

  describe('Compatibility UI', () => {
    let originalFetch;

    beforeEach(() => {
      originalFetch = global.fetch;
      global.fetch = vi.fn((url) => {
        if (typeof url === 'string' && url.includes('/api/projects/') && url.endsWith('/jobs')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ success: true, jobs: [] })
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, plan: null })
        });
      });
    });

    afterEach(() => {
      if (originalFetch) {
        global.fetch = originalFetch;
      }
    });

    test('shows repo creation fields for cloud workflows', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await ensureSourceStep(user);
      await user.click(screen.getByText('Create a new project'));
      await user.click(getNextButton());

      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'global');

      const repoNameInput = await screen.findByLabelText('Repository Name');
      const ownerInput = screen.getByLabelText('Owner / Org');
      const visibilitySelect = screen.getByLabelText('Visibility');

      await user.type(repoNameInput, 'repo-name');
      await user.type(ownerInput, 'octocat');
      await user.selectOptions(visibilitySelect, 'public');

      expect(visibilitySelect).toHaveValue('public');
    });

    test('shows compatibility changes and structure updates', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          plan: {
            needsChanges: true,
            changes: [{ key: 'host', description: 'Bind to 0.0.0.0' }],
            structure: { needsMove: true }
          }
        })
      });

      const { user } = renderComponent();

      render(<CreateProject />);
      await goToCompatibilityStep(user, 'C:/projects/local-app');

      expect(await screen.findByText('Bind to 0.0.0.0')).toBeInTheDocument();
      expect(screen.getByText('Frontend files will be moved into a frontend/ folder.')).toBeInTheDocument();
    });

    test('shows no compatibility changes when plan is empty', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          plan: { needsChanges: false, changes: [], structure: { needsMove: false } }
        })
      });

      const { user } = renderComponent();

      render(<CreateProject />);
      await goToCompatibilityStep(user, 'C:/projects/no-changes');

      expect(await screen.findByText('No compatibility changes required.')).toBeInTheDocument();
    });

    test('does not refetch compatibility when path trims to the same value', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await goToCompatibilityStep(user, 'C:/projects/local-app');

      const hooks = await waitForCreateProjectHooks();

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        hooks.setLocalPath('C:/projects/local-app ');
      });

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledTimes(1);
      });
    });

    test('clears compatibility plan when local path is emptied', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await goToCompatibilityStep(user, 'C:/projects/clear-path');

      const hooks = await waitForCreateProjectHooks();

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        hooks.setLocalPath('');
      });

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledTimes(1);
      });
    });

    test('shows setup waiting UI when local import returns setup jobs', async () => {
      global.fetch = vi.fn((url) => {
        if (typeof url === 'string' && url.includes('/api/projects/') && url.endsWith('/jobs')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              success: true,
              jobs: [
                { id: 'job-1', type: 'install', status: 'pending', displayName: 'Install dependencies' },
                { id: 'job-2', type: 'format', displayName: 'Format files' }
              ]
            })
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({ success: true, plan: null })
        });
      });

      mockImportProject.mockResolvedValue({
        project: { id: 'proj-local-setup', name: 'Local Import' },
        jobs: [
          { id: 'job-1', type: 'install', status: 'pending', displayName: 'Install dependencies' },
          { id: 'job-2', type: 'format', displayName: 'Format files' }
        ]
      });

      const { user } = renderComponent();

      render(<CreateProject />);
      await goToCompatibilityStep(user, 'C:/projects/setup-wait');

      await user.click(screen.getByRole('button', { name: /import project/i }));

      expect(await screen.findByText('Preparing your project')).toBeInTheDocument();
      expect(screen.getByText(/installing dependencies and getting everything ready/i)).toBeInTheDocument();
      expect(screen.getByText('Install dependencies')).toBeInTheDocument();
      expect(screen.getAllByText('pending')).toHaveLength(2);
      expect(screen.getByText(/waiting for setup to finish/i)).toBeInTheDocument();
    });

    test('falls back to empty setup jobs when jobs are missing', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, jobs: [] })
      });

      render(<CreateProject />);

      const hooks = await waitForCreateProjectHooks();

      act(() => {
        hooks.setSetupState({
          isWaiting: true,
          projectId: 'proj-missing-jobs',
          jobs: null,
          error: ''
        });
      });

      expect(await screen.findByText('Preparing your project')).toBeInTheDocument();
      expect(screen.getByText(/waiting for setup to finish/i)).toBeInTheDocument();
    });

    test('shows fallback error when setup jobs polling fails without a message', async () => {
      global.fetch = vi.fn().mockRejectedValueOnce({});

      render(<CreateProject />);

      const hooks = await waitForCreateProjectHooks();

      act(() => {
        hooks.setSetupState({
          isWaiting: true,
          projectId: 'proj-jobs-error',
          jobs: [],
          error: ''
        });
      });

      expect(await screen.findByText('Failed to load setup jobs')).toBeInTheDocument();
    });

    test('shows fallback setup jobs error when response omits details', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: false })
      });

      render(<CreateProject />);

      const hooks = await waitForCreateProjectHooks();

      act(() => {
        hooks.setSetupState({
          isWaiting: true,
          projectId: 'proj-jobs-response-error',
          jobs: [],
          error: ''
        });
      });

      expect(await screen.findByText('Failed to load setup jobs')).toBeInTheDocument();
    });

    test('falls back to empty setup jobs when payload is not an array', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, jobs: {} })
      });

      render(<CreateProject />);

      const hooks = await waitForCreateProjectHooks();

      act(() => {
        hooks.setSetupState({
          isWaiting: true,
          projectId: 'proj-jobs-nonarray',
          jobs: [],
          error: ''
        });
      });

      expect(await screen.findByText('Preparing your project')).toBeInTheDocument();
      expect(screen.getByText(/waiting for setup to finish/i)).toBeInTheDocument();
    });

    test('shows compatibility scan status while loading', async () => {
      let resolveFetch;
      global.fetch = vi.fn(
        () => new Promise((resolve) => {
          resolveFetch = resolve;
        })
      );

      const { user } = renderComponent();

      render(<CreateProject />);
      await goToCompatibilityStep(user, 'C:/projects/compat-loading');

      expect(await screen.findByText(/scanning for required changes/i)).toBeInTheDocument();

      await act(async () => {
        resolveFetch({
          ok: true,
          json: async () => ({
            success: true,
            plan: { needsChanges: false, changes: [], structure: { needsMove: false } }
          })
        });
      });
    });

    test('shows no compatibility changes and structure move note', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          plan: { needsChanges: false, changes: [], structure: { needsMove: true } }
        })
      });

      const { user } = renderComponent();

      render(<CreateProject />);
      await goToCompatibilityStep(user, 'C:/projects/no-changes');

      expect(await screen.findByText('No compatibility changes required.')).toBeInTheDocument();
      expect(screen.getByText('Frontend files will be moved into a frontend/ folder.')).toBeInTheDocument();

      const moveCheckbox = screen.getByRole('checkbox', { name: /move frontend files into a frontend folder/i });
      await user.click(moveCheckbox);
      expect(moveCheckbox).toBeChecked();
    });

    test('shows compatibility scan errors', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ success: false, error: 'Scan failed' })
      });

      const { user } = renderComponent();

      render(<CreateProject />);
      await goToCompatibilityStep(user, 'C:/projects/bad-scan');

      expect(await screen.findByText('Scan failed')).toBeInTheDocument();
    });

    test('uses fallback compatibility error message when error is missing', async () => {
      global.fetch.mockRejectedValueOnce({});

      const { user } = renderComponent();

      render(<CreateProject />);
      await goToCompatibilityStep(user, 'C:/projects/fallback-scan');

      expect(await screen.findByText('Failed to scan compatibility')).toBeInTheDocument();
    });

    test('uses fallback compatibility error when response omits details', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ success: false })
      });

      const { user } = renderComponent();

      render(<CreateProject />);
      await goToCompatibilityStep(user, 'C:/projects/fallback-response');

      expect(await screen.findByText('Failed to scan compatibility')).toBeInTheDocument();
    });
  });

  describe('Coverage branches', () => {
    test('does not guess a name for a root path', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await ensureGitStep(user, { source: 'local' });

      const pathInput = screen.getByLabelText('Project Folder Path *');
      await user.clear(pathInput);
      await user.type(pathInput, '/');

      await user.click(getNextButton());

      const nameInput = await screen.findByLabelText('Project Name *');
      expect(nameInput).toHaveValue('');
    });

    test('advances when linked path validation succeeds', async () => {
      const { user } = renderComponent();
      mockAxios.post.mockResolvedValueOnce({ data: { success: true } });

      render(<CreateProject />);
      await ensureGitStep(user, { source: 'local' });

      await user.type(screen.getByLabelText('Project Folder Path *'), 'C:/projects/linked');
      await user.click(screen.getByText('Link to existing folder'));
      await user.click(getNextButton());

      expect(await screen.findByLabelText('Project Name *')).toBeInTheDocument();
    });

    test('selects the copy import mode when chosen', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await ensureGitStep(user, { source: 'local' });

      const copyRadio = screen.getByDisplayValue('copy');
      await user.click(screen.getByText('Link to existing folder'));
      await user.click(screen.getByText('Copy into managed folder'));

      expect(copyRadio).toBeChecked();
    });

    test('closes the folder picker modal when canceled', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await ensureGitStep(user, { source: 'local' });

      await user.click(screen.getByRole('button', { name: /browse/i }));

      const dialog = await screen.findByRole('dialog', { name: /select folder/i });
      const cancelButton = within(dialog).getByRole('button', { name: /cancel/i });

      await user.click(cancelButton);

      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: /select folder/i })).not.toBeInTheDocument();
      });
    });

    test('shows default error when linked path validation fails without details', async () => {
      const { user } = renderComponent();
      mockAxios.post.mockRejectedValueOnce({});

      render(<CreateProject />);
      await ensureGitStep(user, { source: 'local' });

      await user.type(screen.getByLabelText('Project Folder Path *'), 'C:/projects/linked');
      await user.click(screen.getByText('Link to existing folder'));
      await user.click(getNextButton());

      expect(await screen.findByText('Invalid project path')).toBeInTheDocument();
    });

    test('defaults missing git connection mode on git imports', async () => {
      const { user } = renderComponent();
      mockImportProject.mockResolvedValue({
        project: { id: 'proj-git-mode', name: 'Git Mode' },
        jobs: []
      });

      render(<CreateProject />);
      await ensureGitStep(user, { source: 'git' });
      await user.type(screen.getByLabelText('Repository URL *'), 'https://github.com/org/repo.git');

      const hooks = await waitForCreateProjectHooks();
      act(() => {
        hooks.setGitConnectionMode('');
      });

      await user.click(getNextButton());
      await user.click(getCreateProjectButton());

      await waitFor(() => {
        expect(mockImportProject).toHaveBeenCalledWith(expect.objectContaining({
          gitConnectionMode: 'local'
        }));
      });
    });

    test('handles git imports when jobs are not an array', async () => {
      const { user } = renderComponent();
      mockImportProject.mockResolvedValue({
        project: { id: 'proj-git-jobs', name: 'Git Jobs' },
        jobs: null
      });

      render(<CreateProject />);
      await ensureGitStep(user, { source: 'git' });
      await user.type(screen.getByLabelText('Repository URL *'), 'https://github.com/org/repo.git');
      await user.click(getNextButton());
      await user.click(getCreateProjectButton());

      await waitFor(() => {
        expect(mockShowMain).toHaveBeenCalled();
      });
    });

    test('shows fallback error when git import fails without a message', async () => {
      const { user } = renderComponent();
      mockImportProject.mockRejectedValue({});

      render(<CreateProject />);
      await ensureGitStep(user, { source: 'git' });
      await user.type(screen.getByLabelText('Repository URL *'), 'https://github.com/org/repo.git');
      await user.click(getNextButton());
      await user.click(getCreateProjectButton());

      expect(await screen.findByText('Failed to import project')).toBeInTheDocument();
    });

    test('applies structure fixes during local import when consented', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          plan: { needsChanges: false, changes: [], structure: { needsMove: true } }
        })
      });

      mockImportProject.mockResolvedValue({
        project: { id: 'proj-structure', name: 'Local Import' },
        jobs: []
      });

      const { user } = renderComponent();

      render(<CreateProject />);
      await goToCompatibilityStep(user, 'C:/projects/structure-fix');

      await user.click(screen.getByText('Move frontend files into a frontend folder'));
      await user.click(screen.getByRole('button', { name: /import project/i }));

      await waitFor(() => {
        expect(mockImportProject).toHaveBeenCalledWith(expect.objectContaining({
          applyStructureFix: true
        }));
      });
    });

    test('defaults git connection mode for local import when missing', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          plan: { needsChanges: false, changes: [], structure: { needsMove: false } }
        })
      });

      mockImportProject.mockResolvedValue({
        project: { id: 'proj-local-mode', name: 'Local Import' },
        jobs: []
      });

      const { user } = renderComponent();

      render(<CreateProject />);
      await goToCompatibilityStep(user, 'C:/projects/local-mode');

      const hooks = await waitForCreateProjectHooks();
      act(() => {
        hooks.setGitConnectionMode('');
      });

      await user.click(screen.getByRole('button', { name: /import project/i }));

      await waitFor(() => {
        expect(mockImportProject).toHaveBeenCalledWith(expect.objectContaining({
          gitConnectionMode: 'local'
        }));
      });
    });

    test('uses custom git connection provider for local imports', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          plan: { needsChanges: false, changes: [], structure: { needsMove: false } }
        })
      });

      mockImportProject.mockResolvedValue({
        project: { id: 'proj-local-custom', name: 'Local Import' },
        jobs: []
      });

      const { user } = renderComponent();

      render(<CreateProject />);
      await ensureGitStep(user, { source: 'local' });
      await user.type(screen.getByLabelText('Project Folder Path *'), 'C:/projects/local-custom');
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'custom');
      await user.type(screen.getByLabelText('Repository URL *'), 'https://gitlab.com/org/repo.git');
      await user.selectOptions(screen.getByLabelText('Git Provider *'), 'gitlab');
      await user.type(screen.getByLabelText('Personal Access Token *'), 'glpat-test');

      await user.click(getNextButton());
      await user.type(screen.getByLabelText('Project Name *'), 'Local Import');
      await user.click(getCreateProjectButton());

      await user.click(screen.getByRole('button', { name: /import project/i }));

      await waitFor(() => {
        expect(mockImportProject).toHaveBeenCalledWith(expect.objectContaining({
          gitConnectionProvider: 'gitlab'
        }));
      });
    });

    test('uses global git provider fallback for local imports', async () => {
      mockGitSettings = {
        ...defaultGitSettings,
        provider: ''
      };

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          plan: { needsChanges: false, changes: [], structure: { needsMove: false } }
        })
      });

      mockImportProject.mockResolvedValue({
        project: { id: 'proj-local-global', name: 'Local Import' },
        jobs: []
      });

      const { user } = renderComponent();

      render(<CreateProject />);
      await ensureGitStep(user, { source: 'local' });
      await user.type(screen.getByLabelText('Project Folder Path *'), 'C:/projects/local-global');
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'global');
      await user.type(screen.getByLabelText('Repository URL *'), 'https://github.com/org/repo.git');

      await user.click(getNextButton());
      await user.type(screen.getByLabelText('Project Name *'), 'Local Import');
      await user.click(getCreateProjectButton());
      await user.click(screen.getByRole('button', { name: /import project/i }));

      await waitFor(() => {
        expect(mockImportProject).toHaveBeenCalledWith(expect.objectContaining({
          gitConnectionProvider: 'github'
        }));
      });
    });

    test('handles local import job payloads that are not arrays', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          plan: { needsChanges: false, changes: [], structure: { needsMove: false } }
        })
      });

      mockImportProject.mockResolvedValue({
        project: { id: 'proj-local-jobs', name: 'Local Import' },
        jobs: null
      });

      const { user } = renderComponent();

      render(<CreateProject />);
      await goToCompatibilityStep(user, 'C:/projects/local-jobs');
      await user.click(screen.getByRole('button', { name: /import project/i }));

      await waitFor(() => {
        expect(mockShowMain).toHaveBeenCalled();
      });
    });

    test('shows fallback error when local import fails without a message', async () => {
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          plan: { needsChanges: false, changes: [], structure: { needsMove: false } }
        })
      });

      mockImportProject.mockRejectedValue({});

      const { user } = renderComponent();

      render(<CreateProject />);
      await goToCompatibilityStep(user, 'C:/projects/local-error');
      await user.click(screen.getByRole('button', { name: /import project/i }));

      expect(await screen.findByText('Failed to import project')).toBeInTheDocument();
    });

    test('falls back to provider defaults when connect settings are missing', async () => {
      mockGitSettings = {
        ...defaultGitSettings,
        provider: '',
        defaultBranch: '   '
      };

      mockAxios.post.mockResolvedValue(createSuccessResponse({
        project: { id: 'proj-connect-defaults', name: 'Connect Defaults' }
      }));

      const { user } = renderComponent();

      render(<CreateProject />);
      await ensureGitStep(user, { source: 'new' });
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'custom');
      await user.type(screen.getByLabelText('Personal Access Token *'), 'glpat-test');
      fireEvent.change(screen.getByLabelText('Git Provider *'), { target: { value: '' } });

      const hooks = await waitForCreateProjectHooks();
      act(() => {
        hooks.setGitCloudMode('connect');
      });

      await user.type(screen.getByLabelText('Repository URL *'), 'https://github.com/org/repo.git');

      await user.click(getNextButton());
      await user.type(screen.getByLabelText('Project Name *'), 'Connect Defaults');
      await user.click(getCreateProjectButton());

      await waitFor(() => {
        expect(mockAxios.post).toHaveBeenCalledWith('/api/projects', expect.objectContaining({
          gitProvider: 'github',
          gitDefaultBranch: 'main'
        }));
      });
    });

    test('defaults connect branch when git settings omit defaultBranch', async () => {
      mockGitSettings = {
        ...defaultGitSettings,
        defaultBranch: null
      };

      mockAxios.post.mockResolvedValue(createSuccessResponse({
        project: { id: 'proj-connect-branch', name: 'Connect Branch' }
      }));

      const { user } = renderComponent();

      render(<CreateProject />);
      await ensureGitStep(user, { source: 'new' });
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'global');

      const hooks = await waitForCreateProjectHooks();
      act(() => {
        hooks.setGitCloudMode('connect');
      });

      await user.type(screen.getByLabelText('Repository URL *'), 'https://github.com/org/repo.git');
      await user.click(getNextButton());
      await user.type(screen.getByLabelText('Project Name *'), 'Connect Branch');
      await user.click(getCreateProjectButton());

      await waitFor(() => {
        expect(mockAxios.post).toHaveBeenCalledWith('/api/projects', expect.objectContaining({
          gitDefaultBranch: 'main'
        }));
      });
    });
  });
