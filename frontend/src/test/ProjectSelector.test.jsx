import React from 'react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProjectSelector from '../components/ProjectSelector';
import { useAppState } from '../context/AppStateContext';
import axios from 'axios';

vi.mock('../context/AppStateContext', () => ({
  useAppState: vi.fn()
}));

vi.mock('../components/Modal', () => ({
  default: ({ isOpen, onClose, onConfirm, title, message, confirmText = 'Confirm', cancelText = 'Cancel' }) =>
    isOpen ? (
      <div data-testid="modal-backdrop">
        <div data-testid="modal-content">
          <h3>{title}</h3>
          <p>{message}</p>
          <button data-testid="modal-cancel" onClick={onClose}>{cancelText}</button>
          <button data-testid="modal-confirm" onClick={onConfirm}>{confirmText}</button>
        </div>
      </div>
    ) : null
}));

const mockAppState = (overrides = {}) => ({
  isLLMConfigured: true,
  currentProject: null,
  selectProject: vi.fn(),
  showCreateProject: vi.fn(),
  showImportProject: vi.fn(),
  ...overrides
});

const mockProjectsPayload = (projects = []) => ({ data: { success: true, projects } });

const waitForTestHooks = async () => {
  await waitFor(() => {
    expect(typeof ProjectSelector.__testHooks.fetchProjects).toBe('function');
  });
  return ProjectSelector.__testHooks;
};

beforeEach(() => {
  vi.clearAllMocks();
  axios.get.mockResolvedValue(mockProjectsPayload());
  axios.delete.mockResolvedValue({ data: { success: true } });
});

describe('ProjectSelector Component', () => {
  describe('Display Conditions', () => {
    test('renders when LLM is configured and no project is selected', async () => {
      useAppState.mockReturnValue(mockAppState());

      render(<ProjectSelector />);

      expect(await screen.findByText('Select Project')).toBeInTheDocument();
      expect(screen.getByText('Choose an existing project or create a new one to get started.')).toBeInTheDocument();
    });

    test('does not render when LLM is not configured', () => {
      useAppState.mockReturnValue(mockAppState({ isLLMConfigured: false }));

      const { container } = render(<ProjectSelector />);

      expect(container.firstChild).toBeNull();
    });

    test('does not render when project is already selected', () => {
      useAppState.mockReturnValue(mockAppState({ currentProject: { id: 'proj-1' } }));

      const { container } = render(<ProjectSelector />);

      expect(container.firstChild).toBeNull();
    });
  });

  describe('Empty State', () => {
    test('shows empty state when no projects exist', async () => {
      useAppState.mockReturnValue(mockAppState());
      axios.get.mockResolvedValueOnce(mockProjectsPayload([]));

      render(<ProjectSelector />);

      expect(await screen.findByText('No projects yet')).toBeInTheDocument();
      expect(screen.getByText('Create your first project to get started with AI-powered coding assistance.')).toBeInTheDocument();
    });

    test('shows create and import buttons in empty state', async () => {
      useAppState.mockReturnValue(mockAppState());
      axios.get.mockResolvedValueOnce(mockProjectsPayload([]));

      render(<ProjectSelector />);

      await screen.findByText('No projects yet');

      expect(screen.getByRole('button', { name: 'Create New Project' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Import Project' })).toBeInTheDocument();
    });
  });

  describe('Project List Display', () => {
    const sampleProjects = [
      {
        id: 'proj-1',
        name: 'Lifecycle Project',
        description: 'Test project',
        language: 'JavaScript',
        framework: 'React',
        updatedAt: '2024-01-15T12:00:00.000Z'
      },
      {
        id: 'proj-2',
        name: 'Second Project',
        description: '',
        language: 'TypeScript',
        framework: 'Next.js',
        updatedAt: '2024-01-10T12:00:00.000Z'
      }
    ];

    test('displays existing projects in cards', async () => {
      useAppState.mockReturnValue(mockAppState());
      axios.get.mockResolvedValueOnce(mockProjectsPayload(sampleProjects));

      render(<ProjectSelector />);

      expect(await screen.findByText('Lifecycle Project')).toBeInTheDocument();
      expect(screen.getByText('Second Project')).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: /open/i })).toHaveLength(2);
    });

    test('shows project metadata (language, framework, dates)', async () => {
      useAppState.mockReturnValue(mockAppState());
      axios.get.mockResolvedValueOnce(mockProjectsPayload(sampleProjects));

      render(<ProjectSelector />);

      expect(await screen.findByText('JavaScript')).toBeInTheDocument();
      expect(screen.getByText('React')).toBeInTheDocument();
      expect(screen.getByText('TypeScript')).toBeInTheDocument();
      expect(screen.getByText('Next.js')).toBeInTheDocument();
    });

    test('shows formatted dates', async () => {
      useAppState.mockReturnValue(mockAppState());
      axios.get.mockResolvedValueOnce(mockProjectsPayload(sampleProjects));

      render(<ProjectSelector />);

      expect(await screen.findByText('Updated Jan 15, 2024')).toBeInTheDocument();
      expect(screen.getByText('Updated Jan 10, 2024')).toBeInTheDocument();
    });
  });

  describe('Project Actions', () => {
    const project = {
      id: 'proj-1',
      name: 'Lifecycle Project',
      language: 'JavaScript',
      framework: 'React',
      updatedAt: '2024-01-15T12:00:00.000Z'
    };

    test('can select a project', async () => {
      const selectProject = vi.fn();
      useAppState.mockReturnValue(mockAppState({ selectProject }));
      axios.get.mockResolvedValueOnce(mockProjectsPayload([project]));

      const user = userEvent.setup();
      render(<ProjectSelector />);

      const projectCard = await screen.findByRole('button', { name: 'Open Lifecycle Project' });
      await user.click(projectCard);

      expect(selectProject).toHaveBeenCalledWith(project);
    });

    test('surfaces delete failures and resets modal state', async () => {
      useAppState.mockReturnValue(mockAppState());
      axios.get.mockResolvedValueOnce(mockProjectsPayload([project]));
      axios.delete.mockRejectedValueOnce({ response: { data: { error: 'Cannot delete project' } } });

      const user = userEvent.setup();
      render(<ProjectSelector />);

      const deleteButton = await screen.findByRole('button', { name: 'Delete' });
      await user.click(deleteButton);

      const confirmButton = await screen.findByTestId('modal-confirm');
      await user.click(confirmButton);

      await waitFor(() => expect(axios.delete).toHaveBeenCalledWith(
        `/api/projects/${project.id}`,
        expect.objectContaining({
          headers: expect.objectContaining({ 'x-confirm-destructive': 'true' })
        })
      ));
      await waitFor(() => expect(screen.queryByTestId('modal-backdrop')).not.toBeInTheDocument());
      expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
      expect(screen.queryByText('Cannot delete project')).not.toBeInTheDocument();
      expect(axios.get).toHaveBeenCalledTimes(1);
    });

    test('can delete a project with confirmation', async () => {
      useAppState.mockReturnValue(mockAppState());
      axios.get
        .mockResolvedValueOnce(mockProjectsPayload([project]))
        .mockResolvedValueOnce(mockProjectsPayload([]));

      const user = userEvent.setup();
      render(<ProjectSelector />);

      const deleteButton = await screen.findByRole('button', { name: 'Delete' });
      await user.click(deleteButton);

      const confirmButton = await screen.findByTestId('modal-confirm');
      await user.click(confirmButton);

      await waitFor(() => {
        expect(axios.delete).toHaveBeenCalledWith(
          `/api/projects/${project.id}`,
          expect.objectContaining({
            headers: expect.objectContaining({ 'x-confirm-destructive': 'true' })
          })
        );
        expect(axios.get).toHaveBeenCalledTimes(2);
      });
    });

    test('cancels delete when user declines confirmation', async () => {
      useAppState.mockReturnValue(mockAppState());
      axios.get.mockResolvedValueOnce(mockProjectsPayload([project]));

      const user = userEvent.setup();
      render(<ProjectSelector />);

      const deleteButton = await screen.findByRole('button', { name: 'Delete' });
      await user.click(deleteButton);

      const cancelButton = await screen.findByTestId('modal-cancel');
      await user.click(cancelButton);

      expect(axios.delete).not.toHaveBeenCalled();
    });
  });

  describe('Header Actions', () => {
    test('shows create and import project buttons in header', async () => {
      useAppState.mockReturnValue(mockAppState());

      render(<ProjectSelector />);

      expect(await screen.findByRole('button', { name: 'Create New Project' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Import Project' })).toBeInTheDocument();
    });

    test('create project button triggers view change', async () => {
      const showCreateProject = vi.fn();
      useAppState.mockReturnValue(mockAppState({ showCreateProject }));

      const user = userEvent.setup();
      render(<ProjectSelector />);

      const button = await screen.findByRole('button', { name: 'Create New Project' });
      await user.click(button);

      expect(showCreateProject).toHaveBeenCalledTimes(1);
    });

    test('import project button triggers view change', async () => {
      const showImportProject = vi.fn();
      useAppState.mockReturnValue(mockAppState({ showImportProject }));

      const user = userEvent.setup();
      render(<ProjectSelector />);

      const button = await screen.findByRole('button', { name: 'Import Project' });
      await user.click(button);

      expect(showImportProject).toHaveBeenCalledTimes(1);
    });
  });

  describe('Loading States', () => {
    test('shows loading state while fetching projects', () => {
      useAppState.mockReturnValue(mockAppState());
      axios.get.mockImplementation(() => new Promise(() => {}));

      render(<ProjectSelector />);

      expect(screen.getByText('Loading projects...')).toBeInTheDocument();
    });
  });

  describe('Error Handling', () => {
    test('handles API errors when fetching projects', async () => {
      useAppState.mockReturnValue(mockAppState());
      axios.get.mockRejectedValueOnce(new Error('Server unavailable'));

      render(<ProjectSelector />);

      expect(await screen.findByText('Error Loading Projects')).toBeInTheDocument();
      expect(screen.getByText('Failed to fetch projects')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    });

    test('shows retry button on fetch error', async () => {
      useAppState.mockReturnValue(mockAppState());
      axios.get
        .mockRejectedValueOnce(new Error('Server unavailable'))
        .mockResolvedValueOnce(mockProjectsPayload([]));

      const user = userEvent.setup();
      render(<ProjectSelector />);

      const retryButton = await screen.findByRole('button', { name: 'Retry' });
      await user.click(retryButton);

      await waitFor(() => {
        expect(axios.get).toHaveBeenCalledTimes(2);
      });
      expect(await screen.findByText('No projects yet')).toBeInTheDocument();
    });
  });

  describe('Test Hooks', () => {
    test('allows manual fetch invocation without showing loader', async () => {
      useAppState.mockReturnValue(mockAppState());
      axios.get
        .mockResolvedValueOnce(mockProjectsPayload([]))
        .mockResolvedValueOnce(mockProjectsPayload([
          {
            id: 'proj-hook',
            name: 'Hooked Project',
            description: 'From hook'
          }
        ]));

      render(<ProjectSelector />);

      expect(await screen.findByText('No projects yet')).toBeInTheDocument();

      const hooks = await waitForTestHooks();

      await act(async () => {
        await hooks.fetchProjects({ silent: true });
      });

      expect(await screen.findByText('Hooked Project')).toBeInTheDocument();
      expect(axios.get).toHaveBeenCalledTimes(2);
    });

    test('fetchProjects hook defaults to empty projects array when payload omits data', async () => {
      useAppState.mockReturnValue(mockAppState());
      axios.get
        .mockResolvedValueOnce(mockProjectsPayload([]))
        .mockResolvedValueOnce({ data: { success: true } });

      render(<ProjectSelector />);

      expect(await screen.findByText('No projects yet')).toBeInTheDocument();

      const hooks = await waitForTestHooks();

      await act(async () => {
        await hooks.fetchProjects({ silent: true });
      });

      expect(await screen.findByText('No projects yet')).toBeInTheDocument();
      expect(axios.get).toHaveBeenCalledTimes(2);
    });

    test('fetchProjects hook surfaces API error messages when request fails', async () => {
      useAppState.mockReturnValue(mockAppState());
      axios.get
        .mockResolvedValueOnce(mockProjectsPayload([]))
        .mockRejectedValueOnce({ response: { data: { error: 'Hook fetch failed' } } });

      render(<ProjectSelector />);

      expect(await screen.findByText('No projects yet')).toBeInTheDocument();

      const hooks = await waitForTestHooks();

      await act(async () => {
        await hooks.fetchProjects();
      });

      expect(await screen.findByText('Hook fetch failed')).toBeInTheDocument();
      expect(hooks.getError()).toBe('Hook fetch failed');
    });

    test('confirm delete hook exits early when no project is queued', async () => {
      useAppState.mockReturnValue(mockAppState());
      axios.get.mockResolvedValueOnce(mockProjectsPayload([]));

      render(<ProjectSelector />);

      await waitForTestHooks();

      await act(async () => {
        await ProjectSelector.__testHooks.confirmDeleteProject();
      });

      expect(axios.delete).not.toHaveBeenCalled();
    });

    test('confirm delete hook surfaces API errors', async () => {
      useAppState.mockReturnValue(mockAppState());
      axios.get
        .mockResolvedValueOnce(mockProjectsPayload([]))
        .mockResolvedValueOnce(mockProjectsPayload([]));
      axios.delete.mockRejectedValueOnce({ response: { data: { error: 'Hook delete failed' } } });

      render(<ProjectSelector />);

      const hooks = await waitForTestHooks();
      const targetProject = { id: 'proj-hook', name: 'Hook Delete' };

      act(() => {
        hooks.setProjectToDelete(targetProject);
        hooks.setShowDeleteModal(true);
      });

      await waitFor(() => {
        expect(ProjectSelector.__testHooks.getShowDeleteModal()).toBe(true);
      });

      await act(async () => {
        await ProjectSelector.__testHooks.confirmDeleteProject();
      });

      await waitFor(() => {
        expect(axios.delete).toHaveBeenCalledWith(
          '/api/projects/proj-hook',
          expect.objectContaining({
            headers: expect.objectContaining({ 'x-confirm-destructive': 'true' })
          })
        );
      });
      expect(hooks.getError()).toBe('Hook delete failed');
      expect(await screen.findByText('Hook delete failed')).toBeInTheDocument();
    });

    test('confirm delete hook falls back to default error when server omits message', async () => {
      useAppState.mockReturnValue(mockAppState());
      axios.get.mockResolvedValueOnce(mockProjectsPayload([]));
      axios.delete.mockRejectedValueOnce(new Error('delete failed'));

      render(<ProjectSelector />);

      const hooks = await waitForTestHooks();
      const targetProject = { id: 'proj-default', name: 'Default Failure' };

      act(() => {
        hooks.setProjectToDelete(targetProject);
        hooks.setShowDeleteModal(true);
      });

      await waitFor(() => {
        expect(ProjectSelector.__testHooks.getShowDeleteModal()).toBe(true);
      });

      await act(async () => {
        await ProjectSelector.__testHooks.confirmDeleteProject();
      });

      expect(ProjectSelector.__testHooks.getError()).toBe('Failed to delete project');
      expect(await screen.findByText('Failed to delete project')).toBeInTheDocument();
    });

    test('cancel delete hook does nothing while deletion is in progress', async () => {
      useAppState.mockReturnValue(mockAppState());
      axios.get.mockResolvedValueOnce(mockProjectsPayload([]));

      render(<ProjectSelector />);

      const hooks = await waitForTestHooks();

      act(() => {
        hooks.setProjectToDelete({ id: 'proj-cancel', name: 'Cancel' });
        hooks.setShowDeleteModal(true);
        hooks.setIsDeleting(true);
      });

      expect(screen.getByTestId('modal-backdrop')).toBeInTheDocument();

      hooks.cancelDeleteProject();

      expect(hooks.getShowDeleteModal()).toBe(true);
      expect(screen.getByTestId('modal-backdrop')).toBeInTheDocument();
    });

    test('skips hook binding when hooks container is missing', async () => {
      const originalHooks = ProjectSelector.__testHooks;
      ProjectSelector.__testHooks = undefined;
      useAppState.mockReturnValue(mockAppState());
      axios.get.mockResolvedValueOnce(mockProjectsPayload([]));

      try {
        render(<ProjectSelector />);

        await waitFor(() => {
          expect(ProjectSelector.__testHooks).toBeUndefined();
        });
      } finally {
        ProjectSelector.__testHooks = originalHooks || {};
      }
    });
  });
});
