import React from 'react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
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

    test('falls back to unknown date when updatedAt is invalid', async () => {
      useAppState.mockReturnValue(mockAppState());
      axios.get.mockResolvedValueOnce(mockProjectsPayload([
        {
          id: 'proj-3',
          name: 'Invalid Date Project',
          description: '',
          language: 'JavaScript',
          framework: 'React',
          updatedAt: 'not-a-date'
        }
      ]));

      render(<ProjectSelector />);

      expect(await screen.findByText('Updated Unknown date')).toBeInTheDocument();
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

    test('supports keyboard activation and blocks interactions while deleting', async () => {
      const selectProject = vi.fn();
      useAppState.mockReturnValue(mockAppState({ selectProject }));
      axios.get.mockResolvedValueOnce(mockProjectsPayload([project]));

      const user = userEvent.setup();
      render(<ProjectSelector />);

      const projectCard = await screen.findByRole('button', { name: 'Open Lifecycle Project' });

      fireEvent.keyDown(projectCard, { key: 'Enter' });
      fireEvent.keyDown(projectCard, { key: ' ' });
      expect(selectProject).toHaveBeenCalledTimes(2);

      let resolveDelete;
      axios.delete.mockImplementation(() => new Promise((resolve) => { resolveDelete = resolve; }));

      await user.click(screen.getByRole('button', { name: 'Delete' }));
      await user.click(screen.getByTestId('modal-confirm'));

      await waitFor(() => expect(axios.delete).toHaveBeenCalled());

      await user.click(projectCard);
      fireEvent.keyDown(projectCard, { key: 'Enter' });

      expect(selectProject).toHaveBeenCalledTimes(2);

      await act(async () => {
        resolveDelete({ data: { success: true } });
      });
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

    test('shows cleanup warning when deletion leaves files behind', async () => {
      useAppState.mockReturnValue(mockAppState());
      axios.get
        .mockResolvedValueOnce(mockProjectsPayload([project]))
        .mockResolvedValueOnce(mockProjectsPayload([]));
      axios.delete.mockResolvedValueOnce({
        data: {
          success: true,
          message: 'Project deleted, but cleanup failed. See cleanup details.',
          cleanup: {
            success: false,
            failures: [{ target: 'C:/projects/demo', code: 'EPERM', message: 'access denied' }]
          }
        }
      });

      const user = userEvent.setup();
      render(<ProjectSelector />);

      const deleteButton = await screen.findByRole('button', { name: 'Delete' });
      await user.click(deleteButton);

      const confirmButton = await screen.findByTestId('modal-confirm');
      await user.click(confirmButton);

      expect(await screen.findByText('Cleanup incomplete')).toBeInTheDocument();
      expect(screen.getByText(/view cleanup log/i)).toBeInTheDocument();

      await user.click(screen.getByText(/view cleanup log/i));
      expect(screen.getByText(/EPERM/i)).toBeInTheDocument();
    });

    test('falls back to default cleanup warning message when details are missing', async () => {
      useAppState.mockReturnValue(mockAppState());
      axios.get
        .mockResolvedValueOnce(mockProjectsPayload([project]))
        .mockResolvedValueOnce(mockProjectsPayload([]));
      axios.delete.mockResolvedValueOnce({
        data: {
          success: true,
          cleanup: {
            success: false,
            failures: null
          }
        }
      });

      const user = userEvent.setup();
      render(<ProjectSelector />);

      const deleteButton = await screen.findByRole('button', { name: 'Delete' });
      await user.click(deleteButton);

      const confirmButton = await screen.findByTestId('modal-confirm');
      await user.click(confirmButton);

      expect(await screen.findByText('Cleanup incomplete')).toBeInTheDocument();
      expect(screen.getByText(/some files may remain/i)).toBeInTheDocument();
      expect(screen.queryByText(/view cleanup log/i)).not.toBeInTheDocument();
    });

    test('renders cleanup log fallbacks when failure details are missing', async () => {
      useAppState.mockReturnValue(mockAppState());
      axios.get
        .mockResolvedValueOnce(mockProjectsPayload([project]))
        .mockResolvedValueOnce(mockProjectsPayload([]));
      axios.delete.mockResolvedValueOnce({
        data: {
          success: true,
          message: 'Project deleted, but cleanup failed. See cleanup details.',
          cleanup: {
            success: false,
            failures: [{}]
          }
        }
      });

      const user = userEvent.setup();
      render(<ProjectSelector />);

      const deleteButton = await screen.findByRole('button', { name: 'Delete' });
      await user.click(deleteButton);

      const confirmButton = await screen.findByTestId('modal-confirm');
      await user.click(confirmButton);

      const toggle = await screen.findByRole('button', { name: /view cleanup log/i });
      await user.click(toggle);

      expect(screen.getByText(/unknown path/i)).toBeInTheDocument();
    });

    test('retries cleanup when the user clicks retry', async () => {
      useAppState.mockReturnValue(mockAppState());
      axios.get
        .mockResolvedValueOnce(mockProjectsPayload([project]))
        .mockResolvedValueOnce(mockProjectsPayload([]));
      axios.delete.mockResolvedValueOnce({
        data: {
          success: true,
          message: 'Project deleted, but cleanup failed. See cleanup details.',
          cleanup: {
            success: false,
            failures: [{ target: 'C:/projects/demo', message: 'EPERM: access denied' }]
          }
        }
      });
      axios.post.mockResolvedValueOnce({
        data: {
          success: true,
          cleanup: { success: true, failures: [] },
          message: 'Cleanup completed successfully'
        }
      });

      const user = userEvent.setup();
      render(<ProjectSelector />);

      const deleteButton = await screen.findByRole('button', { name: 'Delete' });
      await user.click(deleteButton);

      const confirmButton = await screen.findByTestId('modal-confirm');
      await user.click(confirmButton);

      const retryButton = await screen.findByRole('button', { name: /retry cleanup/i });
      await user.click(retryButton);

      await waitFor(() => {
        expect(axios.post).toHaveBeenCalledWith(
          `/api/projects/${project.id}/cleanup`,
          { targets: ['C:/projects/demo'] },
          expect.objectContaining({ headers: { 'x-confirm-destructive': 'true' } })
        );
      });

      await waitFor(() => {
        expect(screen.queryByText('Cleanup incomplete')).not.toBeInTheDocument();
      });
    });

    test('shows retry warning when cleanup still fails', async () => {
      useAppState.mockReturnValue(mockAppState());
      axios.get
        .mockResolvedValueOnce(mockProjectsPayload([project]))
        .mockResolvedValueOnce(mockProjectsPayload([]));
      axios.delete.mockResolvedValueOnce({
        data: {
          success: true,
          message: 'Project deleted, but cleanup failed. See cleanup details.',
          cleanup: {
            success: false,
            failures: [{ target: 'C:/projects/demo' }]
          }
        }
      });
      axios.post.mockResolvedValueOnce({
        data: {
          success: true,
          cleanup: { success: false, failures: [{}] },
          message: 'Cleanup failed. See cleanup details.'
        }
      });

      const user = userEvent.setup();
      render(<ProjectSelector />);

      const deleteButton = await screen.findByRole('button', { name: 'Delete' });
      await user.click(deleteButton);

      const confirmButton = await screen.findByTestId('modal-confirm');
      await user.click(confirmButton);

      const retryButton = await screen.findByRole('button', { name: /retry cleanup/i });
      await user.click(retryButton);

      expect(await screen.findByText(/cleanup still failed/i)).toBeInTheDocument();
    });

    test('coerces retry cleanup failures to an empty list when failures is not an array', async () => {
      useAppState.mockReturnValue(mockAppState());
      axios.get
        .mockResolvedValueOnce(mockProjectsPayload([project]))
        .mockResolvedValueOnce(mockProjectsPayload([]));
      axios.delete.mockResolvedValueOnce({
        data: {
          success: true,
          message: 'Project deleted, but cleanup failed. See cleanup details.',
          cleanup: {
            success: false,
            failures: [{ target: 'C:/projects/demo' }]
          }
        }
      });
      axios.post.mockResolvedValueOnce({
        data: {
          success: true,
          cleanup: { success: false, failures: 'not-an-array' },
          message: 'Cleanup failed. See cleanup details.'
        }
      });

      const user = userEvent.setup();
      render(<ProjectSelector />);

      const deleteButton = await screen.findByRole('button', { name: 'Delete' });
      await user.click(deleteButton);

      const confirmButton = await screen.findByTestId('modal-confirm');
      await user.click(confirmButton);

      const retryButton = await screen.findByRole('button', { name: /retry cleanup/i });
      await user.click(retryButton);

      expect(await screen.findByText(/cleanup failed\. see cleanup details\./i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /view cleanup log/i })).not.toBeInTheDocument();
    });

    test('uses default message when retry response omits error details', async () => {
      useAppState.mockReturnValue(mockAppState());
      axios.get
        .mockResolvedValueOnce(mockProjectsPayload([project]))
        .mockResolvedValueOnce(mockProjectsPayload([]));
      axios.delete.mockResolvedValueOnce({
        data: {
          success: true,
          cleanup: { success: false, failures: [{ target: 'C:/projects/demo' }] }
        }
      });
      axios.post.mockResolvedValueOnce({ data: { success: false } });

      const user = userEvent.setup();
      render(<ProjectSelector />);

      const deleteButton = await screen.findByRole('button', { name: 'Delete' });
      await user.click(deleteButton);

      const confirmButton = await screen.findByTestId('modal-confirm');
      await user.click(confirmButton);

      const retryButton = await screen.findByRole('button', { name: /retry cleanup/i });
      await user.click(retryButton);

      expect(await screen.findByText(/failed to retry cleanup/i)).toBeInTheDocument();
    });

    test('uses fallback warning when retry cleanup still fails without message', async () => {
      useAppState.mockReturnValue(mockAppState());
      axios.get
        .mockResolvedValueOnce(mockProjectsPayload([project]))
        .mockResolvedValueOnce(mockProjectsPayload([]));
      axios.delete.mockResolvedValueOnce({
        data: {
          success: true,
          cleanup: { success: false, failures: [{ target: 'C:/projects/demo' }] }
        }
      });
      axios.post.mockResolvedValueOnce({
        data: {
          success: true,
          cleanup: { success: false, failures: [] }
        }
      });

      const user = userEvent.setup();
      render(<ProjectSelector />);

      const deleteButton = await screen.findByRole('button', { name: 'Delete' });
      await user.click(deleteButton);

      const confirmButton = await screen.findByTestId('modal-confirm');
      await user.click(confirmButton);

      const retryButton = await screen.findByRole('button', { name: /retry cleanup/i });
      await user.click(retryButton);

      expect(await screen.findByText(/cleanup failed\. see cleanup details\./i)).toBeInTheDocument();
    });

    test('falls back to default retry error when request fails without details', async () => {
      useAppState.mockReturnValue(mockAppState());
      axios.get
        .mockResolvedValueOnce(mockProjectsPayload([project]))
        .mockResolvedValueOnce(mockProjectsPayload([]));
      axios.delete.mockResolvedValueOnce({
        data: {
          success: true,
          cleanup: { success: false, failures: [{ target: 'C:/projects/demo' }] }
        }
      });
      axios.post.mockRejectedValueOnce({});

      const user = userEvent.setup();
      render(<ProjectSelector />);

      const deleteButton = await screen.findByRole('button', { name: 'Delete' });
      await user.click(deleteButton);

      const confirmButton = await screen.findByTestId('modal-confirm');
      await user.click(confirmButton);

      const retryButton = await screen.findByRole('button', { name: /retry cleanup/i });
      await user.click(retryButton);

      expect(await screen.findByText(/failed to retry cleanup/i)).toBeInTheDocument();
    });

    test('surfaces response error details when retry cleanup request fails', async () => {
      useAppState.mockReturnValue(mockAppState());
      axios.get
        .mockResolvedValueOnce(mockProjectsPayload([project]))
        .mockResolvedValueOnce(mockProjectsPayload([]));
      axios.delete.mockResolvedValueOnce({
        data: {
          success: true,
          cleanup: { success: false, failures: [{ target: 'C:/projects/demo' }] }
        }
      });
      axios.post.mockRejectedValueOnce({ response: { data: { error: 'Cleanup retry response error' } } });

      const user = userEvent.setup();
      render(<ProjectSelector />);

      const deleteButton = await screen.findByRole('button', { name: 'Delete' });
      await user.click(deleteButton);

      const confirmButton = await screen.findByTestId('modal-confirm');
      await user.click(confirmButton);

      const retryButton = await screen.findByRole('button', { name: /retry cleanup/i });
      await user.click(retryButton);

      expect(await screen.findByText(/cleanup retry response error/i)).toBeInTheDocument();
    });

    test('skips retry when cleanup warning is missing a project id', async () => {
      const projectWithoutId = { ...project, id: undefined };
      useAppState.mockReturnValue(mockAppState());
      axios.get
        .mockResolvedValueOnce(mockProjectsPayload([projectWithoutId]))
        .mockResolvedValueOnce(mockProjectsPayload([]));
      axios.delete.mockResolvedValueOnce({
        data: {
          success: true,
          message: 'Project deleted, but cleanup failed. See cleanup details.',
          cleanup: {
            success: false,
            failures: [{ target: 'C:/projects/demo' }]
          }
        }
      });

      const user = userEvent.setup();
      render(<ProjectSelector />);

      const deleteButton = await screen.findByRole('button', { name: 'Delete' });
      await user.click(deleteButton);

      const confirmButton = await screen.findByTestId('modal-confirm');
      await user.click(confirmButton);

      const retryButton = await screen.findByRole('button', { name: /retry cleanup/i });
      await user.click(retryButton);

      expect(axios.post).not.toHaveBeenCalled();
    });

    test('shows retry error when cleanup retry fails', async () => {
      useAppState.mockReturnValue(mockAppState());
      axios.get
        .mockResolvedValueOnce(mockProjectsPayload([project]))
        .mockResolvedValueOnce(mockProjectsPayload([]));
      axios.delete.mockResolvedValueOnce({
        data: {
          success: true,
          message: 'Project deleted, but cleanup failed. See cleanup details.',
          cleanup: {
            success: false,
            failures: [{ target: 'C:/projects/demo', message: 'EPERM: access denied' }]
          }
        }
      });
      axios.post.mockResolvedValueOnce({
        data: {
          success: false,
          error: 'Cleanup retry failed'
        }
      });

      const user = userEvent.setup();
      render(<ProjectSelector />);

      const deleteButton = await screen.findByRole('button', { name: 'Delete' });
      await user.click(deleteButton);

      const confirmButton = await screen.findByTestId('modal-confirm');
      await user.click(confirmButton);

      const retryButton = await screen.findByRole('button', { name: /retry cleanup/i });
      await user.click(retryButton);

      expect(await screen.findByText(/cleanup retry failed/i)).toBeInTheDocument();
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

    test('surfaces API error messages when response includes details', async () => {
      useAppState.mockReturnValue(mockAppState());
      axios.get.mockRejectedValueOnce({ response: { data: { error: 'Backend offline' } } });

      render(<ProjectSelector />);

      expect(await screen.findByText('Error Loading Projects')).toBeInTheDocument();
      expect(screen.getByText('Backend offline')).toBeInTheDocument();
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
