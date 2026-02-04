import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import CreateProject, { BACKEND_UNAVAILABLE_MESSAGE } from '../components/CreateProject';

const mockCreateProject = vi.fn();
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
let socketConfig = {
  connectError: true,
  joinResponse: { error: 'connect failed' },
  deferConnect: false,
  throwOnCreate: false,
  throwOnOff: false,
  throwOnDisconnect: false
};

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

const renderComponent = () => {
  return {
    user: userEvent.setup()
  };
};

const fillProjectName = async (user, value = 'My Project') => {
  const nameInput = screen.getByLabelText('Project Name *');
  await user.clear(nameInput);
  await user.type(nameInput, value);
  return nameInput;
};

const fillDescription = async (user, value = 'A sample project') => {
  const descInput = screen.getByLabelText('Description');
  await user.clear(descInput);
  await user.type(descInput, value);
  return descInput;
};

const submitForm = async (user) => {
  const workflowSelect = screen.queryByLabelText('Git Workflow *');
  if (workflowSelect && !workflowSelect.value) {
    await user.selectOptions(workflowSelect, 'local');
  }
  await user.click(
    within(screen.getByRole('form')).getByRole('button', { name: /create project/i })
  );
};

const getCreateProjectButton = () =>
  within(screen.getByRole('form')).getByRole('button', { name: /create project/i });

const createSuccessResponse = (overrides = {}) => ({
  data: {
    success: true,
    project: {
      id: 'proj-1',
      name: 'My Project',
      ...overrides.project
    },
    processes: {
      frontend: { port: 3000 },
      backend: { port: 4000 },
      ...overrides.processes
    },
    ...overrides
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  MockEventSource.instances = [];
  global.EventSource = MockEventSource;
  mockGitSettings = { ...defaultGitSettings };
  socketInstances.length = 0;
  socketConfig = {
    connectError: true,
    joinResponse: { error: 'connect failed' },
    deferConnect: false,
    throwOnCreate: false,
    throwOnOff: false,
    throwOnDisconnect: false
  };
});

afterEach(() => {
  vi.useRealTimers();
  MockEventSource.instances.forEach((instance) => {
    if (!instance.closed) {
      instance.close();
    }
  });
});

describe('CreateProject Component', () => {
  describe('Initial Render', () => {
    test('renders create project form with all required fields', () => {
      render(<CreateProject />);

      expect(screen.getByLabelText('Project Name *')).toBeInTheDocument();
      expect(screen.getByLabelText('Description')).toBeInTheDocument();
      expect(screen.getByLabelText('Frontend Language *')).toBeInTheDocument();
      expect(screen.getByLabelText('Frontend Framework *')).toBeInTheDocument();
      expect(screen.getByLabelText('Backend Language *')).toBeInTheDocument();
      expect(screen.getByLabelText('Backend Framework *')).toBeInTheDocument();
      expect(screen.getByLabelText('Git Workflow *')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
      expect(getCreateProjectButton()).toBeInTheDocument();
    });

    test('has proper form sections', () => {
      render(<CreateProject />);

      expect(screen.getByText('Project Details')).toBeInTheDocument();
      expect(screen.getByText('Git Setup')).toBeInTheDocument();
      expect(screen.getByText('Frontend Technology')).toBeInTheDocument();
      expect(screen.getByText('Backend Technology')).toBeInTheDocument();
    });

    test('shows close button', () => {
      render(<CreateProject />);

      expect(screen.getByRole('button', { name: /close create project/i })).toBeInTheDocument();
    });

    test('has autofocus on project name input', () => {
      render(<CreateProject />);

      expect(screen.getByLabelText('Project Name *')).toHaveFocus();
    });

    test('has default frontend and backend technologies selected', () => {
      render(<CreateProject />);

      expect(screen.getByLabelText('Frontend Language *')).toHaveValue('javascript');
      expect(screen.getByLabelText('Frontend Framework *')).toHaveValue('react');
      expect(screen.getByLabelText('Backend Language *')).toHaveValue('javascript');
      expect(screen.getByLabelText('Backend Framework *')).toHaveValue('express');
    });
  });

  describe('Form Validation', () => {
    test('shows error when git workflow is not selected', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await fillProjectName(user, 'My Project');

      await user.click(
        within(screen.getByRole('form')).getByRole('button', { name: /create project/i })
      );

      expect(screen.getByText(/git workflow selection is required/i)).toBeInTheDocument();
      expect(mockAxios.post).not.toHaveBeenCalled();
    });

    test('shows error when cloud remote setup is not selected', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await fillProjectName(user, 'My Project');
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'global');

      await user.click(
        within(screen.getByRole('form')).getByRole('button', { name: /create project/i })
      );

      expect(screen.getByText(/remote setup selection is required/i)).toBeInTheDocument();
      expect(mockAxios.post).not.toHaveBeenCalled();
    });

    test('shows error when connecting cloud repo without URL', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await fillProjectName(user, 'My Project');
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'global');
      await user.selectOptions(screen.getByLabelText('Remote Setup *'), 'connect');

      await user.click(
        within(screen.getByRole('form')).getByRole('button', { name: /create project/i })
      );

      expect(screen.getByText(/repository url is required/i)).toBeInTheDocument();
      expect(mockAxios.post).not.toHaveBeenCalled();
    });

    test('shows error when custom cloud workflow omits PAT', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await fillProjectName(user, 'My Project');
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'custom');
      await user.selectOptions(screen.getByLabelText('Remote Setup *'), 'create');

      await user.click(
        within(screen.getByRole('form')).getByRole('button', { name: /create project/i })
      );

      expect(screen.getByText(/personal access token is required/i)).toBeInTheDocument();
      expect(mockAxios.post).not.toHaveBeenCalled();
    });

    test('clears git setup validation errors as the user selects options and types', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await fillProjectName(user, 'My Project');

      await user.click(getCreateProjectButton());
      expect(screen.getByText(/git workflow selection is required/i)).toBeInTheDocument();

      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'global');
      expect(screen.queryByText(/git workflow selection is required/i)).not.toBeInTheDocument();
      expect(screen.getByLabelText('Remote Setup *')).toBeInTheDocument();

      await user.click(getCreateProjectButton());
      expect(screen.getByText(/remote setup selection is required/i)).toBeInTheDocument();

      await user.selectOptions(screen.getByLabelText('Remote Setup *'), 'connect');
      expect(screen.queryByText(/remote setup selection is required/i)).not.toBeInTheDocument();
      expect(screen.getByLabelText('Repository URL *')).toBeInTheDocument();

      await user.click(getCreateProjectButton());
      expect(screen.getByText(/repository url is required/i)).toBeInTheDocument();

      await user.type(screen.getByLabelText('Repository URL *'), 'https://example.com/org/repo.git');
      await waitFor(() => {
        expect(screen.queryByText(/repository url is required/i)).not.toBeInTheDocument();
      });
    });

    test('clears custom workflow errors and covers repo create metadata edits', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await fillProjectName(user, 'My Project');
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'custom');
      await user.selectOptions(screen.getByLabelText('Remote Setup *'), 'create');

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

      mockAxios.post.mockRejectedValueOnce(new Error('boom'));
      await user.click(getCreateProjectButton());
      expect(await screen.findByText('boom')).toBeInTheDocument();

      await user.type(screen.getByLabelText('Repository Name'), 'RepoName');
      await waitFor(() => {
        expect(screen.queryByText('boom')).not.toBeInTheDocument();
      });

      mockAxios.post.mockRejectedValueOnce(new Error('boom'));
      await user.click(getCreateProjectButton());
      expect(await screen.findByText('boom')).toBeInTheDocument();

      await user.type(screen.getByLabelText('Owner / Org'), 'octocat');
      await waitFor(() => {
        expect(screen.queryByText('boom')).not.toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText('Visibility'), 'public');
      expect(screen.getByLabelText('Visibility')).toHaveValue('public');
    });

    test('shows error when project name is empty', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await submitForm(user);

      expect(screen.getByText('Project name is required')).toBeInTheDocument();
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

    test('submit button is enabled to allow validation', () => {
      render(<CreateProject />);

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

    test('shows repository name placeholder when project name is blank', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);

      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'global');
      await user.selectOptions(screen.getByLabelText('Remote Setup *'), 'create');

      const repoNameInput = screen.getByLabelText('Repository Name');
      expect(repoNameInput).toHaveAttribute('placeholder', 'Repository name');
    });

    test('updates frontend language selection and resets framework', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
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
      const frontendFramework = screen.getByLabelText('Frontend Framework *');
      await user.selectOptions(frontendFramework, 'vue');

      expect(frontendFramework).toHaveValue('vue');
    });

    test('shows correct frontend frameworks for selected language', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      const frontendLanguage = screen.getByLabelText('Frontend Language *');
      await user.selectOptions(frontendLanguage, 'typescript');

      const frameworkSelect = screen.getByLabelText('Frontend Framework *');
      const options = within(frameworkSelect).getAllByRole('option');
      const optionValues = options.map((option) => option.value);

      expect(optionValues).toEqual(['react', 'vue', 'angular', 'svelte', 'nextjs', 'nuxtjs', 'vanilla']);
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

      expect(mockSelectProject).toHaveBeenCalledWith(expect.objectContaining({ name: 'My Project' }));
      expect(mockFetchProjects).toHaveBeenCalled();
    });

    test('connects existing repo when using global cloud workflow', async () => {
      const { user } = renderComponent();
      mockAxios.post.mockResolvedValue(createSuccessResponse({ project: { id: 'proj-cloud-global', name: 'My Project' } }));
      mockUpdateProjectGitSettings.mockResolvedValueOnce({});

      render(<CreateProject />);
      await fillProjectName(user, 'My Project');
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'global');
      await user.selectOptions(screen.getByLabelText('Remote Setup *'), 'connect');
      await user.type(screen.getByLabelText('Repository URL *'), 'https://github.com/octocat/my-project.git');

      await user.click(
        within(screen.getByRole('form')).getByRole('button', { name: /create project/i })
      );

      await waitFor(() => {
        expect(mockUpdateProjectGitSettings).toHaveBeenCalledWith(
          'proj-cloud-global',
          expect.objectContaining({
            workflow: 'cloud',
            provider: 'github',
            remoteUrl: 'https://github.com/octocat/my-project.git',
            defaultBranch: 'main'
          })
        );
      });
    });

    test('connects existing repo when global git settings need fallbacks', async () => {
      mockGitSettings = {
        ...defaultGitSettings,
        provider: '',
        username: null,
        defaultBranch: '   '
      };

      const { user } = renderComponent();
      mockAxios.post.mockResolvedValue(createSuccessResponse({ project: { id: 'proj-cloud-fallbacks', name: 'My Project' } }));
      mockUpdateProjectGitSettings.mockResolvedValueOnce({});

      render(<CreateProject />);
      await fillProjectName(user, 'My Project');
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'global');
      await user.selectOptions(screen.getByLabelText('Remote Setup *'), 'connect');
      await user.type(screen.getByLabelText('Repository URL *'), 'https://github.com/octocat/my-project.git');

      await user.click(
        within(screen.getByRole('form')).getByRole('button', { name: /create project/i })
      );

      await waitFor(() => {
        expect(mockUpdateProjectGitSettings).toHaveBeenCalled();
      });

      const updates = mockUpdateProjectGitSettings.mock.calls[0][1];
      expect(updates.provider).toBe('github');
      expect(updates.defaultBranch).toBe('main');
      expect('username' in updates).toBe(false);
    });

    test('defaults to main branch when global defaultBranch is blank', async () => {
      mockGitSettings = {
        ...defaultGitSettings,
        defaultBranch: ''
      };

      const { user } = renderComponent();
      mockAxios.post.mockResolvedValue(createSuccessResponse({ project: { id: 'proj-cloud-defaultbranch-empty', name: 'My Project' } }));
      mockUpdateProjectGitSettings.mockResolvedValueOnce({});

      render(<CreateProject />);
      await fillProjectName(user, 'My Project');
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'global');
      await user.selectOptions(screen.getByLabelText('Remote Setup *'), 'connect');
      await user.type(screen.getByLabelText('Repository URL *'), 'https://github.com/octocat/my-project.git');

      await user.click(
        within(screen.getByRole('form')).getByRole('button', { name: /create project/i })
      );

      await waitFor(() => {
        expect(mockUpdateProjectGitSettings).toHaveBeenCalled();
      });

      const updates = mockUpdateProjectGitSettings.mock.calls[0][1];
      expect(updates.defaultBranch).toBe('main');
    });

    test('falls back to github provider when custom provider is blank', async () => {
      const { user } = renderComponent();
      mockAxios.post.mockResolvedValue(createSuccessResponse({ project: { id: 'proj-cloud-custom-blank-provider', name: 'My Project' } }));
      mockUpdateProjectGitSettings.mockResolvedValueOnce({});

      render(<CreateProject />);
      await fillProjectName(user, 'My Project');
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'custom');
      await user.selectOptions(screen.getByLabelText('Remote Setup *'), 'connect');

      fireEvent.change(screen.getByLabelText('Git Provider *'), { target: { value: '' } });

      await user.type(screen.getByLabelText('Personal Access Token *'), 'test-token');
      await user.type(screen.getByLabelText('Repository URL *'), 'https://github.com/octocat/my-project.git');

      await user.click(
        within(screen.getByRole('form')).getByRole('button', { name: /create project/i })
      );

      await waitFor(() => {
        expect(mockUpdateProjectGitSettings).toHaveBeenCalled();
      });

      const updates = mockUpdateProjectGitSettings.mock.calls[0][1];
      expect(updates.provider).toBe('github');
    });

    test('connects existing repo when using custom cloud workflow (includes token)', async () => {
      const { user } = renderComponent();
      mockAxios.post.mockResolvedValue(createSuccessResponse({ project: { id: 'proj-cloud-custom-connect', name: 'My Project' } }));
      mockUpdateProjectGitSettings.mockResolvedValueOnce({});

      render(<CreateProject />);
      await fillProjectName(user, 'My Project');
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'custom');
      await user.selectOptions(screen.getByLabelText('Remote Setup *'), 'connect');
      await user.selectOptions(screen.getByLabelText('Git Provider *'), 'gitlab');
      await user.type(screen.getByLabelText('Personal Access Token *'), 'glpat-test');
      await user.type(screen.getByLabelText('Repository URL *'), 'https://gitlab.com/octocat/my-project.git');

      await user.click(
        within(screen.getByRole('form')).getByRole('button', { name: /create project/i })
      );

      await waitFor(() => {
        expect(mockUpdateProjectGitSettings).toHaveBeenCalledWith(
          'proj-cloud-custom-connect',
          expect.objectContaining({
            workflow: 'cloud',
            provider: 'gitlab',
            remoteUrl: 'https://gitlab.com/octocat/my-project.git',
            defaultBranch: 'main',
            token: 'glpat-test'
          })
        );
      });
    });

    test('creates a remote repo when using custom cloud workflow', async () => {
      const { user } = renderComponent();
      mockAxios.post.mockResolvedValue(createSuccessResponse({ project: { id: 'proj-cloud-custom', name: 'My Project' } }));
      mockCreateProjectRemoteRepository.mockResolvedValueOnce({ success: true });

      render(<CreateProject />);
      await fillProjectName(user, 'My Project');
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'custom');
      await user.selectOptions(screen.getByLabelText('Remote Setup *'), 'create');
      await user.selectOptions(screen.getByLabelText('Git Provider *'), 'gitlab');
      await user.type(screen.getByLabelText('Personal Access Token *'), 'glpat-test');

      await user.click(
        within(screen.getByRole('form')).getByRole('button', { name: /create project/i })
      );

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

      const header = screen.getByText('Create New Project').closest('.create-project-header');
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
        expect(screen.getByLabelText('Frontend Language *')).toBeDisabled();
        expect(screen.getByLabelText('Backend Language *')).toBeDisabled();
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
      const header = screen.getByText('Create New Project').closest('.create-project-header');
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
      fireEvent.change(screen.getByLabelText('Project Name *'), {
        target: { value: 'Polling Error' }
      });
      fireEvent.change(screen.getByLabelText('Git Workflow *'), {
        target: { value: 'local' }
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

      fireEvent.change(screen.getByLabelText('Project Name *'), {
        target: { value: 'Polling Project' }
      });
      fireEvent.change(screen.getByLabelText('Git Workflow *'), {
        target: { value: 'local' }
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
      fireEvent.change(screen.getByLabelText('Project Name *'), {
        target: { value: 'Timestamp Guard' }
      });
      fireEvent.change(screen.getByLabelText('Git Workflow *'), {
        target: { value: 'local' }
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
      const originalEventSource = global.EventSource;

      class LegacyEventSource extends MockEventSource {
        constructor(url) {
          super(url);
          this.addEventListener = undefined;
        }
      }

      global.EventSource = LegacyEventSource;

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
        global.EventSource = originalEventSource;
        resolveRequest({ data: { success: false } });
      }
    });

    test('skips progress streaming when EventSource API is missing', async () => {
      const { user } = renderComponent();
      const originalEventSource = global.EventSource;
      global.EventSource = undefined;

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
        global.EventSource = originalEventSource;
        resolveRequest({ data: { success: false } });
      }
    });

    test('uses socket streaming when EventSource API is missing', async () => {
      const { user } = renderComponent();
      const originalEventSource = global.EventSource;
      global.EventSource = undefined;
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
        global.EventSource = originalEventSource;
        resolveRequest({ data: { success: false } });
      }
    });

    test('continues when EventSource constructor throws', async () => {
      const { user } = renderComponent();
      const originalEventSource = global.EventSource;

      class ExplodingEventSource {
        constructor() {
          throw new Error('boom');
        }
      }

      global.EventSource = ExplodingEventSource;
      mockAxios.post.mockResolvedValue(createSuccessResponse());

      try {
        render(<CreateProject />);
        await fillProjectName(user, 'Exploding Stream');
        await submitForm(user);

        await waitFor(() => expect(mockAxios.post).toHaveBeenCalled());
        expect(MockEventSource.instances.length).toBe(0);
      } finally {
        global.EventSource = originalEventSource;
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

      expect(screen.getByLabelText('Project Name *')).toHaveValue('');
      expect(screen.getByLabelText('Description')).toHaveValue('');
      expect(screen.getByLabelText('Frontend Language *')).toHaveValue('javascript');
      expect(screen.getByLabelText('Backend Language *')).toHaveValue('javascript');
      expect(mockShowMain).toHaveBeenCalled();
    });

    test('close button calls showMain', async () => {
      const { user } = renderComponent();

      render(<CreateProject />);
      await user.click(screen.getByRole('button', { name: /close create project/i }));

      expect(mockShowMain).toHaveBeenCalled();
    });
  });

  describe('Technology Stack Options', () => {
    test('shows all available languages', () => {
      render(<CreateProject />);
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

    test('language options are properly capitalized', () => {
      render(<CreateProject />);
      const backendSelect = screen.getByLabelText('Backend Language *');
      const optionLabels = within(backendSelect)
        .getAllByRole('option')
        .map((option) => option.textContent);

      expect(optionLabels.every((label) => label && label[0] === label[0].toUpperCase())).toBe(true);
    });

    test('framework options are properly capitalized', async () => {
      render(<CreateProject />);
      const frameworkSelect = screen.getByLabelText('Frontend Framework *');
      const optionLabels = within(frameworkSelect)
        .getAllByRole('option')
        .map((option) => option.textContent);

      expect(optionLabels.every((label) => label && label[0] === label[0].toUpperCase())).toBe(true);
    });

    test('falls back to React frameworks when frontend language has no mapping', () => {
      render(<CreateProject />);
      const frontendLanguage = screen.getByLabelText('Frontend Language *');
      fireEvent.change(frontendLanguage, { target: { value: 'elm' } });

      const frontendFramework = screen.getByLabelText('Frontend Framework *');
      const optionValues = within(frontendFramework)
        .getAllByRole('option')
        .map((option) => option.value);

      expect(optionValues).toEqual(['react']);
      expect(frontendFramework).toHaveValue('react');
    });

    test('falls back to Express frameworks when backend language has no mapping', () => {
      render(<CreateProject />);
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
    test('form has proper labels', () => {
      render(<CreateProject />);

      expect(screen.getByLabelText('Project Name *')).toBeInTheDocument();
      expect(screen.getByLabelText('Description')).toBeInTheDocument();
      expect(screen.getByLabelText('Frontend Language *')).toBeInTheDocument();
      expect(screen.getByLabelText('Frontend Framework *')).toBeInTheDocument();
      expect(screen.getByLabelText('Backend Language *')).toBeInTheDocument();
      expect(screen.getByLabelText('Backend Framework *')).toBeInTheDocument();
    });

    test('required fields are marked with asterisk', () => {
      render(<CreateProject />);

      expect(screen.getByText('Project Name *')).toHaveTextContent('*');
      expect(screen.getByText('Frontend Language *')).toHaveTextContent('*');
      expect(screen.getByText('Frontend Framework *')).toHaveTextContent('*');
      expect(screen.getByText('Backend Language *')).toHaveTextContent('*');
      expect(screen.getByText('Backend Framework *')).toHaveTextContent('*');
    });

    test('form inputs have proper placeholders', () => {
      render(<CreateProject />);

      expect(screen.getByPlaceholderText('Enter project name')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Brief description of your project')).toBeInTheDocument();
    });
  });
});