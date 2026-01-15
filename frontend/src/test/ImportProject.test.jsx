import { act } from 'react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ImportProject, { resolveFrontendFrameworks, resolveBackendFrameworks } from '../components/ImportProject';

const mockImportProject = vi.fn();
const mockSelectProject = vi.fn();
const mockShowMain = vi.fn();

vi.mock('../context/AppStateContext', () => ({
  useAppState: () => ({
    importProject: mockImportProject,
    selectProject: mockSelectProject,
    showMain: mockShowMain
  })
}));

const renderComponent = (props) => {
  const user = userEvent.setup();
  render(<ImportProject {...props} />);
  return { user };
};

const fillName = async (user, value = 'My Project') => {
  const input = screen.getByLabelText('Project Name *');
  await user.clear(input);
  await user.type(input, value);
  return input;
};

const fillPath = async (user, value = 'C:/Projects/demo') => {
  const input = screen.getByLabelText('Project Folder Path *');
  await user.clear(input);
  await user.type(input, value);
  return input;
};

const clickGitMethod = async (user) => {
  const gitRadio = screen.getByRole('radio', { name: /Git Repository/ });
  await user.click(gitRadio);
};

const fillGitUrl = async (user, value = 'https://github.com/user/repo.git') => {
  const input = screen.getByLabelText('Git Repository URL *');
  await user.clear(input);
  await user.type(input, value);
  return input;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ImportProject Component', () => {
  describe('Initial Render', () => {
    test('renders import project form with all required sections', () => {
      render(<ImportProject />);

      expect(screen.getByText('Import Method')).toBeInTheDocument();
      expect(screen.getByText('Project Source')).toBeInTheDocument();
      expect(screen.getByText('Project Details')).toBeInTheDocument();
      expect(screen.getByText('Frontend Technology')).toBeInTheDocument();
      expect(screen.getByText('Backend Technology')).toBeInTheDocument();
    });

    test('shows back button', () => {
      render(<ImportProject />);
      expect(screen.getByRole('button', { name: /back to projects/i })).toBeInTheDocument();
    });

    test('shows import and cancel buttons', () => {
      render(<ImportProject />);

      expect(screen.getByRole('button', { name: 'Import Project' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    });
  });

  describe('Import Methods', () => {
    test('shows all import method options', () => {
      render(<ImportProject />);

      expect(screen.getByText('Local Folder')).toBeInTheDocument();
      expect(screen.getByText('Git Repository')).toBeInTheDocument();
      expect(screen.getByText('ZIP Archive')).toBeInTheDocument();
    });

    test('local folder is selected by default', () => {
      render(<ImportProject />);

      expect(screen.getByRole('radio', { name: /Local Folder/ })).toBeChecked();
    });

    test('can select git repository method', async () => {
      const { user } = renderComponent();

      await clickGitMethod(user);

      expect(screen.getByRole('radio', { name: /Git Repository/ })).toBeChecked();
    });

    test('zip method is disabled', () => {
      render(<ImportProject />);

      expect(screen.getByRole('radio', { name: /ZIP Archive/ })).toBeDisabled();
    });

    test('zip method can be preselected for testing purposes', () => {
      render(<ImportProject initialImportMethod="zip" />);

      const zipRadio = screen.getByRole('radio', { name: /ZIP Archive/ });
      expect(zipRadio).toBeChecked();
      expect(zipRadio).toBeDisabled();
      expect(zipRadio.closest('label')).toHaveClass('selected');
    });

    test('zip option onChange handler can be triggered (coverage)', () => {
      render(<ImportProject />);

      expect(screen.getByRole('radio', { name: /Local Folder/ })).toBeChecked();
      expect(screen.getByLabelText('Project Folder Path *')).toBeInTheDocument();

      const zipRadio = screen.getByRole('radio', { name: /ZIP Archive/ });
      expect(zipRadio).toBeDisabled();

      // Force-enable to exercise the inline onChange handler for coverage.
      zipRadio.disabled = false;
      zipRadio.removeAttribute('disabled');
      fireEvent.click(zipRadio);

      expect(screen.getByRole('radio', { name: /ZIP Archive/ })).toBeChecked();
      expect(screen.queryByLabelText('Project Folder Path *')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Git Repository URL *')).not.toBeInTheDocument();
    });

    test('invalid initial import method falls back to folder', () => {
      render(<ImportProject initialImportMethod="unknown" />);

      expect(screen.getByRole('radio', { name: /Local Folder/ })).toBeChecked();
      expect(screen.getByRole('radio', { name: /ZIP Archive/ })).toBeDisabled();
    });

    test('method selection updates form fields', async () => {
      const { user } = renderComponent();

      expect(screen.getByLabelText('Project Folder Path *')).toBeInTheDocument();
      await clickGitMethod(user);
      expect(screen.getByLabelText('Git Repository URL *')).toBeInTheDocument();
    });

    test('can switch from git back to local folder', async () => {
      const { user } = renderComponent();

      await clickGitMethod(user);
      expect(screen.getByRole('radio', { name: /Git Repository/ })).toBeChecked();
      expect(screen.getByLabelText('Git Repository URL *')).toBeInTheDocument();

      const folderRadio = screen.getByRole('radio', { name: /Local Folder/ });
      await user.click(folderRadio);

      expect(screen.getByRole('radio', { name: /Local Folder/ })).toBeChecked();
      expect(screen.getByLabelText('Project Folder Path *')).toBeInTheDocument();
    });
  });

  describe('Project Source Fields', () => {
    describe('Local Folder Method', () => {
      test('shows folder path input and browse button', () => {
        render(<ImportProject />);

        expect(screen.getByLabelText('Project Folder Path *')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Browse' })).toBeInTheDocument();
      });

      test('browse button shows not implemented message', async () => {
        const { user } = renderComponent();

        await user.click(screen.getByRole('button', { name: 'Browse' }));

        expect(screen.getByText('Folder selection not yet implemented')).toBeInTheDocument();
      });

      test('can type folder path manually', async () => {
        const { user } = renderComponent();
        await fillPath(user, 'C:/workspace/app');

        expect(screen.getByLabelText('Project Folder Path *')).toHaveValue('C:/workspace/app');
      });
    });

    describe('Git Repository Method', () => {
      test('shows git URL input when git method selected', async () => {
        const { user } = renderComponent();
        await clickGitMethod(user);

        expect(screen.getByLabelText('Git Repository URL *')).toBeInTheDocument();
      });

      test('can type git URL', async () => {
        const { user } = renderComponent();
        await clickGitMethod(user); 
        await fillGitUrl(user, 'https://gitlab.com/demo/repo.git');

        expect(screen.getByLabelText('Git Repository URL *')).toHaveValue('https://gitlab.com/demo/repo.git');
      });
    });
  });

  describe('Project Details', () => {
    test('shows project name and description fields', () => {
      render(<ImportProject />);

      expect(screen.getByLabelText('Project Name *')).toBeInTheDocument();
      expect(screen.getByLabelText('Description')).toBeInTheDocument();
    });

    test('can update project name and description', async () => {
      const { user } = renderComponent();

      await fillName(user, 'New Project');
      const description = screen.getByLabelText('Description');
      await user.type(description, 'New description');

      expect(screen.getByLabelText('Project Name *')).toHaveValue('New Project');
      expect(description).toHaveValue('New description');
    });
  });

  describe('Frontend Technology', () => {
    test('shows frontend language and framework selects with defaults', () => {
      render(<ImportProject />);

      expect(screen.getByLabelText('Frontend Language *')).toHaveValue('javascript');
      expect(screen.getByLabelText('Frontend Framework *')).toHaveValue('react');
    });

    test('frontend language change updates available frameworks', async () => {
      const { user } = renderComponent();
      await user.selectOptions(screen.getByLabelText('Frontend Language *'), 'typescript');

      const options = within(screen.getByLabelText('Frontend Framework *')).getAllByRole('option');
      expect(options.map((option) => option.value)).toEqual(['react', 'vue', 'angular', 'svelte', 'nextjs', 'nuxtjs', 'vite']);
    });

    test('allows selecting a different frontend framework', async () => {
      const { user } = renderComponent();

      await user.selectOptions(screen.getByLabelText('Frontend Framework *'), 'vue');

      expect(screen.getByLabelText('Frontend Framework *')).toHaveValue('vue');
    });

    test('resets frontend framework to the first option when language changes', async () => {
      const { user } = renderComponent();

      await user.selectOptions(screen.getByLabelText('Frontend Framework *'), 'vue');
      await user.selectOptions(screen.getByLabelText('Frontend Language *'), 'typescript');

      expect(screen.getByLabelText('Frontend Framework *')).toHaveValue('react');
    });

    test('shows available frontend languages', () => {
      render(<ImportProject />);

      const options = within(screen.getByLabelText('Frontend Language *')).getAllByRole('option');
      expect(options.map((option) => option.value)).toEqual(['javascript', 'typescript']);
    });
  });

  describe('Backend Technology', () => {
    test('shows backend language and framework selects with defaults', () => {
      render(<ImportProject />);

      expect(screen.getByLabelText('Backend Language *')).toHaveValue('javascript');
      expect(screen.getByLabelText('Backend Framework *')).toHaveValue('express');
    });

    test('backend language change updates available frameworks', async () => {
      const { user } = renderComponent();

      await user.selectOptions(screen.getByLabelText('Backend Language *'), 'python');

      const frameworks = within(screen.getByLabelText('Backend Framework *')).getAllByRole('option');
      expect(frameworks.map((option) => option.value)).toEqual(['django', 'flask', 'fastapi', 'pyramid', 'tornado']);
    });

    test('allows selecting a different backend framework', async () => {
      const { user } = renderComponent();

      await user.selectOptions(screen.getByLabelText('Backend Framework *'), 'koa');

      expect(screen.getByLabelText('Backend Framework *')).toHaveValue('koa');
    });

    test('resets backend framework to the first option when language changes', async () => {
      const { user } = renderComponent();

      await user.selectOptions(screen.getByLabelText('Backend Framework *'), 'koa');
      await user.selectOptions(screen.getByLabelText('Backend Language *'), 'python');

      expect(screen.getByLabelText('Backend Framework *')).toHaveValue('django');
    });

    test('shows all available backend languages', () => {
      render(<ImportProject />);
      const options = within(screen.getByLabelText('Backend Language *')).getAllByRole('option');

      expect(options.map((option) => option.value)).toEqual([
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
  });

  describe('Form Validation', () => {
    test('submit button disabled when project name is empty', () => {
      render(<ImportProject />);

      expect(screen.getByRole('button', { name: 'Import Project' })).toBeDisabled();
    });

    test('submit button disabled when folder path is empty (folder method)', async () => {
      const { user } = renderComponent();
      await fillName(user);

      expect(screen.getByRole('button', { name: 'Import Project' })).toBeDisabled();
    });

    test('submit button disabled when git URL is empty (git method)', async () => {
      const { user } = renderComponent();
      await clickGitMethod(user);
      await fillName(user);

      expect(screen.getByRole('button', { name: 'Import Project' })).toBeDisabled();
    });

    test('submit button enabled when all required fields filled (folder method)', async () => {
      const { user } = renderComponent();
      await fillName(user);
      await fillPath(user);

      expect(screen.getByRole('button', { name: 'Import Project' })).toBeEnabled();
    });

    test('submit button enabled when all required fields filled (git method)', async () => {
      const { user } = renderComponent();
      await clickGitMethod(user);
      await fillName(user);
      await fillGitUrl(user);

      expect(screen.getByRole('button', { name: 'Import Project' })).toBeEnabled();
    });

    test('shows error when name is empty on submit', async () => {
      const { user } = renderComponent();
      await fillPath(user);

      fireEvent.submit(screen.getByRole('form'));

      expect(await screen.findByText('Project name is required')).toBeInTheDocument();
    });

    test('shows error when folder path is empty on submit', async () => {
      const { user } = renderComponent();
      await fillName(user);

      fireEvent.submit(screen.getByRole('form'));

      expect(await screen.findByText('Project path is required')).toBeInTheDocument();
    });

    test('shows error when git URL is empty on submit', async () => {
      const { user } = renderComponent();
      await clickGitMethod(user);
      await fillName(user);

      fireEvent.submit(screen.getByRole('form'));

      expect(await screen.findByText('Git repository URL is required')).toBeInTheDocument();
    });
  });

  describe('Project Import', () => {
    test('imports project with folder method', async () => {
      mockImportProject.mockReturnValue({ id: 'new-project' });
      const { user } = renderComponent();
      await fillName(user, 'Folder Project');
      await fillPath(user, 'C:/Projects/folder');

      await user.click(screen.getByRole('button', { name: 'Import Project' }));

      expect(mockImportProject).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Folder Project',
          importMethod: 'folder',
          source: 'C:/Projects/folder'
        })
      );
      expect(mockSelectProject).toHaveBeenCalledWith({ id: 'new-project' });
      expect(mockShowMain).toHaveBeenCalled();
    });

    test('imports project with git method', async () => {
      mockImportProject.mockReturnValue({ id: 'git-project' });
      const { user } = renderComponent();
      await clickGitMethod(user);
      await fillName(user, 'Git Project');
      await fillGitUrl(user, 'https://github.com/test/repo.git');

      await user.click(screen.getByRole('button', { name: 'Import Project' }));

      expect(mockImportProject).toHaveBeenCalledWith(
        expect.objectContaining({
          importMethod: 'git',
          source: 'https://github.com/test/repo.git'
        })
      );
      expect(mockSelectProject).toHaveBeenCalledWith({ id: 'git-project' });
    });

    test('trims whitespace from inputs', async () => {
      mockImportProject.mockReturnValue({ id: 'trimmed' });
      const { user } = renderComponent();
      await fillName(user, '   Trim Project   ');
      await fillPath(user, '   C:/Trim   ');

      await user.click(screen.getByRole('button', { name: 'Import Project' }));

      const lastCall = mockImportProject.mock.calls.at(-1)?.[0];
      expect(lastCall.name).toBe('Trim Project');
      expect(lastCall.source).toBe('C:/Trim');
    });

    test('shows loading state while import request is pending', async () => {
      let resolveImport;
      mockImportProject.mockImplementation(() => new Promise((resolve) => { resolveImport = resolve; }));
      const { user } = renderComponent();
      await fillName(user);
      await fillPath(user);

      await user.click(screen.getByRole('button', { name: 'Import Project' }));

      const loadingButton = screen.getByRole('button', { name: 'Importing Project...' });
      expect(loadingButton).toBeDisabled();

      await act(async () => {
        resolveImport({ id: 'async-import' });
      });

      await screen.findByRole('button', { name: 'Import Project' });
    });
  });

  describe('Navigation', () => {
    test('cancel button resets form', async () => {
      const { user } = renderComponent();
      await fillName(user, 'Cancel Project');
      await fillPath(user, 'C:/Cancel');

      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.getByLabelText('Project Name *')).toHaveValue('');
      expect(screen.getByLabelText('Project Folder Path *')).toHaveValue('');
      expect(mockShowMain).toHaveBeenCalled();
    });

    test('back button triggers navigation', async () => {
      const { user } = renderComponent();
      await user.click(screen.getByRole('button', { name: /back to projects/i }));

      expect(mockShowMain).toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    test('shows error message on import failure', async () => {
      mockImportProject.mockImplementation(() => {
        throw new Error('Import failed');
      });
      const { user } = renderComponent();
      await fillName(user);
      await fillPath(user);

      await user.click(screen.getByRole('button', { name: 'Import Project' }));

      expect(screen.getByText('Import failed')).toBeInTheDocument();
    });

    test('re-enables form after error', async () => {
      mockImportProject.mockImplementation(() => {
        throw new Error('Import failed');
      });
      const { user } = renderComponent();
      await fillName(user);
      await fillPath(user);

      await user.click(screen.getByRole('button', { name: 'Import Project' }));

      expect(screen.getByRole('button', { name: 'Import Project' })).toBeEnabled();
    });

    test('falls back to generic error message when exception lacks detail', async () => {
      mockImportProject.mockImplementation(() => {
        throw {};
      });
      const { user } = renderComponent();
      await fillName(user);
      await fillPath(user);

      await user.click(screen.getByRole('button', { name: 'Import Project' }));

      expect(screen.getByText('Failed to import project')).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    test('form has proper labels and structure', () => {
      render(<ImportProject />);

      expect(screen.getByRole('form')).toBeInTheDocument();
      expect(screen.getByLabelText('Project Name *')).toBeInTheDocument();
      expect(screen.getByLabelText('Project Folder Path *')).toBeInTheDocument();
    });

    test('required fields marked with asterisk', () => {
      render(<ImportProject />);

      expect(screen.getByText('Project Name *')).toBeInTheDocument();
      expect(screen.getByText('Project Folder Path *')).toBeInTheDocument();
      expect(screen.getByText('Frontend Language *')).toBeInTheDocument();
      expect(screen.getByText('Backend Language *')).toBeInTheDocument();
    });

    test('radio buttons have proper labels', () => {
      render(<ImportProject />);

      expect(screen.getByRole('radio', { name: /Local Folder/ })).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: /Git Repository/ })).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: /ZIP Archive/ })).toBeInTheDocument();
    });

    test('form inputs have proper placeholders', () => {
      render(<ImportProject />);

      expect(screen.getByPlaceholderText('Enter project name')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Brief description of your project')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Select or enter the path to your project folder')).toBeInTheDocument();
    });
  });

  describe('Visual Elements', () => {
    test('shows method icons and descriptions', () => {
      render(<ImportProject />);

      expect(screen.getByText('Import from a folder on your computer')).toBeInTheDocument();
      expect(screen.getByText('Clone from GitHub, GitLab, or other Git hosts')).toBeInTheDocument();
      expect(screen.getByText('Import from a ZIP file (Coming Soon)')).toBeInTheDocument();
    });

    test('shows proper section headings', () => {
      render(<ImportProject />);

      expect(screen.getByText('Import Method')).toBeInTheDocument();
      expect(screen.getByText('Project Source')).toBeInTheDocument();
      expect(screen.getByText('Project Details')).toBeInTheDocument();
    });
  });

  describe('Helper functions', () => {
    test('resolveFrontendFrameworks returns fallback when language unknown', () => {
      expect(resolveFrontendFrameworks('unknown')).toEqual(['none']);
    });

    test('resolveBackendFrameworks returns fallback when language unknown', () => {
      expect(resolveBackendFrameworks('unknown')).toEqual(['none']);
    });
  });
});