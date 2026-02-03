import { act } from 'react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ImportProject, {
  resolveFrontendFrameworks,
  resolveBackendFrameworks,
  guessProjectName
} from '../components/ImportProject';

const mockImportProject = vi.fn();
const mockShowMain = vi.fn();
let mockGitSettings;
let mockGitConnectionStatus;

vi.mock('../context/AppStateContext', () => ({
  useAppState: () => ({
    importProject: mockImportProject,
    showMain: mockShowMain,
    gitSettings: mockGitSettings,
    gitConnectionStatus: mockGitConnectionStatus
  })
}));

const mockFetch = (url) => {
  if (typeof url === 'string' && url.startsWith('/api/fs/detect-tech')) {
    return Promise.resolve({
      ok: true,
      json: async () => ({
        success: true,
        frontend: { language: 'javascript', framework: 'react' },
        backend: { language: 'javascript', framework: 'express' }
      })
    });
  }

  if (typeof url === 'string' && url.startsWith('/api/fs/compatibility')) {
    return Promise.resolve({
      ok: true,
      json: async () => ({
        success: true,
        plan: {
          needsChanges: false,
          changes: [],
          structure: { needsMove: false }
        }
      })
    });
  }

  if (typeof url === 'string' && url.startsWith('/api/fs/roots')) {
    return Promise.resolve({
      ok: true,
      json: async () => ({ success: true, roots: [] })
    });
  }

  if (typeof url === 'string' && url.startsWith('/api/fs/list')) {
    return Promise.resolve({
      ok: true,
      json: async () => ({ success: true, path: 'C:/', directories: [] })
    });
  }

  return Promise.resolve({
    ok: true,
    json: async () => ({ success: true })
  });
};

const renderComponent = (props) => {
  const user = userEvent.setup();
  render(<ImportProject {...props} />);
  return { user };
};

const clickNext = async (user) => {
  await user.click(screen.getByRole('button', { name: 'Next' }));
};

const goToSourceStep = async (user, tab = 'local') => {
  if (tab === 'git') {
    await user.click(screen.getByRole('tab', { name: 'GitHub / GitLab' }));
  }
  await clickNext(user);
};

const goToDetailsStep = async (user, { tab = 'local', path = 'C:/Projects/demo', gitUrl = 'https://github.com/user/repo.git' } = {}) => {
  await goToSourceStep(user, tab);
  if (tab === 'git') {
    const input = screen.getByLabelText('Git Repository URL *');
    await user.clear(input);
    await user.type(input, gitUrl);
  } else {
    const input = screen.getByLabelText('Project Folder Path *');
    await user.clear(input);
    await user.type(input, path);
  }
  await clickNext(user);
};

const goToTechStep = async (user, { tab = 'local', name = 'My Project', path = 'C:/Projects/demo', gitUrl = 'https://github.com/user/repo.git' } = {}) => {
  await goToDetailsStep(user, { tab, path, gitUrl });
  const nameInput = screen.getByLabelText('Project Name *');
  fireEvent.change(nameInput, { target: { value: name } });
  await clickNext(user);
};

const goToCompatibilityStep = async (user, options = {}) => {
  await goToTechStep(user, options);
  await clickNext(user);
};

const goToGitConfigStep = async (user, options = {}) => {
  await goToCompatibilityStep(user, options);
  await clickNext(user);
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGitSettings = { provider: 'github', defaultBranch: 'main', tokenPresent: false };
  mockGitConnectionStatus = null;
  vi.stubGlobal('fetch', vi.fn(mockFetch));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ImportProject Component', () => {
  describe('Initial Render', () => {
    test('renders step header and tabs', () => {
      render(<ImportProject />);

      expect(screen.getByText('Import Existing Project')).toBeInTheDocument();
      expect(screen.getByText('Step 1 of 6')).toBeInTheDocument();
      expect(screen.getByText('Choose an import source')).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Local Folder' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'GitHub / GitLab' })).toBeInTheDocument();
    });

    test('shows back and cancel buttons', () => {
      render(<ImportProject />);
      expect(screen.getByRole('button', { name: /back to projects/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    });

    test('shows next button on the first step', () => {
      render(<ImportProject />);
      expect(screen.getByRole('button', { name: 'Next' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Import Project' })).not.toBeInTheDocument();
    });
  });

  test('guessProjectName returns empty when trailing colon has no name', () => {
    expect(guessProjectName('path:')).toBe('');
  });

  test('guessProjectName returns empty when path is only separators', () => {
    expect(guessProjectName('///')).toBe('');
  });

  test('guessProjectName returns empty when path is only backslashes', () => {
    expect(guessProjectName('\\\\')).toBe('');
  });

  describe('Import Tabs', () => {
    test('local folder tab is selected by default', () => {
      render(<ImportProject />);

      expect(screen.getByRole('tab', { name: 'Local Folder' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: 'GitHub / GitLab' })).toHaveAttribute('aria-selected', 'false');
    });

    test('can switch to git tab', async () => {
      const { user } = renderComponent();
      await user.click(screen.getByRole('tab', { name: 'GitHub / GitLab' }));

      expect(screen.getByRole('tab', { name: 'GitHub / GitLab' })).toHaveAttribute('aria-selected', 'true');
    });

    test('initial import method supports git', () => {
      render(<ImportProject initialImportMethod="git" />);

      expect(screen.getByRole('tab', { name: 'GitHub / GitLab' })).toHaveAttribute('aria-selected', 'true');
    });

    test('invalid initial import method falls back to local', () => {
      render(<ImportProject initialImportMethod="unknown" />);

      expect(screen.getByRole('tab', { name: 'Local Folder' })).toHaveAttribute('aria-selected', 'true');
    });
  });

  test('falls back to local-only when git connection is missing a remote URL', async () => {
    let testHooks;
    const user = userEvent.setup();
    mockImportProject.mockResolvedValue({ project: { id: 1 }, jobs: [] });

    render(
      <ImportProject
        __testHooks={(hooks) => {
          testHooks = hooks;
        }}
      />
    );

    await act(async () => {
      testHooks.setStateForTests({
        currentStep: 5,
        activeTab: 'local',
        importData: {
          name: 'Local Project',
          path: 'C:/Projects/local',
          description: ''
        },
        gitConnectionMode: 'custom',
        gitConnectionRemoteUrl: ''
      });
    });

    await user.click(screen.getByRole('button', { name: 'Import Project' }));

    expect(mockImportProject).toHaveBeenCalledWith(
      expect.objectContaining({
        gitConnectionMode: 'local',
        gitRemoteUrl: ''
      })
    );
  });

  test('falls back to local connection when global Git is not configured', async () => {
    let testHooks;
    const user = userEvent.setup();
    mockImportProject.mockResolvedValue({ project: { id: 1 }, jobs: [] });

    render(
      <ImportProject
        __testHooks={(hooks) => {
          testHooks = hooks;
        }}
      />
    );

    await act(async () => {
      testHooks.setStateForTests({
        currentStep: 5,
        activeTab: 'local',
        importData: {
          name: 'Global Mode Project',
          path: 'C:/Projects/global-mode',
          description: ''
        },
        gitConnectionMode: 'global',
        gitConnectionRemoteUrl: 'https://github.com/org/repo.git'
      });
    });

    await user.click(screen.getByRole('button', { name: 'Import Project' }));

    expect(mockImportProject).toHaveBeenCalledWith(
      expect.objectContaining({
        gitConnectionMode: 'local',
        gitRemoteUrl: ''
      })
    );
  });

  test('uses the global git provider when global connection is configured', async () => {
    let testHooks;
    const user = userEvent.setup();
    mockGitSettings = { provider: 'gitlab', defaultBranch: 'main', tokenPresent: true };
    mockImportProject.mockResolvedValue({ project: { id: 1 }, jobs: [] });

    render(
      <ImportProject
        __testHooks={(hooks) => {
          testHooks = hooks;
        }}
      />
    );

    await act(async () => {
      testHooks.setStateForTests({
        currentStep: 5,
        activeTab: 'local',
        importData: {
          name: 'Global Provider Project',
          path: 'C:/Projects/global-provider',
          description: ''
        },
        gitConnectionMode: 'global',
        gitConnectionRemoteUrl: 'https://github.com/org/repo.git'
      });
    });

    await user.click(screen.getByRole('button', { name: 'Import Project' }));

    expect(mockImportProject).toHaveBeenCalledWith(
      expect.objectContaining({
        gitConnectionMode: 'global',
        gitConnectionProvider: 'gitlab'
      })
    );
  });

  test('uses connection status provider when git settings are missing', async () => {
    let testHooks;
    const user = userEvent.setup();
    mockGitSettings = { defaultBranch: 'main', tokenPresent: false };
    mockGitConnectionStatus = { provider: 'gitlab' };
    mockImportProject.mockResolvedValue({ project: { id: 1 }, jobs: [] });

    render(
      <ImportProject
        __testHooks={(hooks) => {
          testHooks = hooks;
        }}
      />
    );

    await act(async () => {
      testHooks.setStateForTests({
        currentStep: 5,
        activeTab: 'local',
        importData: {
          name: 'Status Provider Project',
          path: 'C:/Projects/status-provider',
          description: ''
        },
        gitConnectionMode: 'global',
        gitConnectionRemoteUrl: 'https://github.com/org/repo.git'
      });
    });

    await user.click(screen.getByRole('button', { name: 'Import Project' }));

    expect(mockImportProject).toHaveBeenCalledWith(
      expect.objectContaining({
        gitConnectionMode: 'global',
        gitConnectionProvider: 'gitlab'
      })
    );
  });

  test('uses github when no global provider is available', async () => {
    let testHooks;
    const user = userEvent.setup();
    mockGitSettings = { defaultBranch: 'main', tokenPresent: true };
    mockGitConnectionStatus = {};
    mockImportProject.mockResolvedValue({ project: { id: 1 }, jobs: [] });

    render(
      <ImportProject
        __testHooks={(hooks) => {
          testHooks = hooks;
        }}
      />
    );

    await act(async () => {
      testHooks.setStateForTests({
        currentStep: 5,
        activeTab: 'local',
        importData: {
          name: 'Default Provider Project',
          path: 'C:/Projects/default-provider',
          description: ''
        },
        gitConnectionMode: 'global',
        gitConnectionRemoteUrl: 'https://github.com/org/repo.git'
      });
    });

    await user.click(screen.getByRole('button', { name: 'Import Project' }));

    expect(mockImportProject).toHaveBeenCalledWith(
      expect.objectContaining({
        gitConnectionMode: 'global',
        gitConnectionProvider: 'github'
      })
    );
  });

  test('falls back to main branch when git settings omit the default branch', async () => {
    let testHooks;
    const user = userEvent.setup();
    mockGitSettings = { provider: 'github', tokenPresent: true };
    mockImportProject.mockResolvedValue({ project: { id: 1 }, jobs: [] });

    render(
      <ImportProject
        __testHooks={(hooks) => {
          testHooks = hooks;
        }}
      />
    );

    await act(async () => {
      testHooks.setStateForTests({
        currentStep: 5,
        activeTab: 'local',
        gitConnectionDefaultBranch: '   ',
        importData: {
          name: 'Fallback Branch Project',
          path: 'C:/Projects/fallback-branch',
          description: ''
        }
      });
    });

    await user.click(screen.getByRole('button', { name: 'Import Project' }));

    expect(mockImportProject).toHaveBeenCalledWith(
      expect.objectContaining({
        gitDefaultBranch: 'main'
      })
    );
  });

  describe('Project Source Fields', () => {
    test('shows folder path input on local source step', async () => {
      const { user } = renderComponent();
      await goToSourceStep(user, 'local');

      expect(screen.getByLabelText('Project Folder Path *')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Browse' })).toBeInTheDocument();
    });

    test('shows git URL input on git source step', async () => {
      const { user } = renderComponent();
      await goToSourceStep(user, 'git');

      expect(screen.getByLabelText('Git Repository URL *')).toBeInTheDocument();
      expect(screen.getByLabelText('Git Provider')).toBeInTheDocument();
    });

    test('shows git configuration copy and warnings', async () => {
      let testHooks;
      render(<ImportProject __testHooks={(hooks) => { testHooks = hooks; }} />);

      await waitFor(() => expect(testHooks).toBeTruthy());

      await act(async () => {
        testHooks.setStateForTests({
          currentStep: 5,
          activeTab: 'local',
          gitConnectionMode: 'global'
        });
      });

      expect(screen.getByText('Configure Git')).toBeInTheDocument();
      expect(screen.getByText('LucidCoder will initialize Git if needed and can connect the repo to a remote.')).toBeInTheDocument();
      expect(screen.getByText('Global connection is not configured. This import will fall back to local-only Git.')).toBeInTheDocument();

      await act(async () => {
        testHooks.setStateForTests({
          currentStep: 5,
          activeTab: 'git',
          gitConnectionMode: 'custom',
          gitConnectionRemoteUrl: ''
        });
      });

      expect(screen.getByText('Configure Git connection')).toBeInTheDocument();
      expect(screen.getByText('Decide whether to keep this clone local or connect it to a cloud workflow.')).toBeInTheDocument();
      expect(screen.getByText('No remote URL provided. This import will default to local-only Git.')).toBeInTheDocument();
    });

    test('prefills git remote URL from the git repository URL', async () => {
      const { user } = renderComponent();
      const gitUrl = 'https://github.com/test/repo.git';

      await goToGitConfigStep(user, { tab: 'git', name: 'Git Project', gitUrl });

      await user.click(screen.getByRole('radio', { name: /Use custom connection/i }));

      expect(screen.getByLabelText('Remote Repository URL *')).toHaveValue(gitUrl);
    });

    test('selecting local-only mode triggers the local radio handler', async () => {
      let testHooks;
      const user = userEvent.setup();
      render(<ImportProject __testHooks={(hooks) => { testHooks = hooks; }} />);

      await act(async () => {
        testHooks.setStateForTests({
          currentStep: 5,
          activeTab: 'local',
          gitConnectionMode: 'custom'
        });
      });

      await user.click(screen.getByRole('radio', { name: /Local only/i }));

      expect(screen.getByRole('radio', { name: /Local only/i })).toBeChecked();
    });

    test('changing git provider uses the git config select handler', async () => {
      let testHooks;
      const user = userEvent.setup();
      render(<ImportProject __testHooks={(hooks) => { testHooks = hooks; }} />);

      await act(async () => {
        testHooks.setStateForTests({
          currentStep: 5,
          activeTab: 'local',
          gitConnectionMode: 'custom',
          gitConnectionProvider: 'github'
        });
      });

      const providerSelect = screen.getByLabelText('Git Provider');
      await user.selectOptions(providerSelect, 'gitlab');

      expect(providerSelect).toHaveValue('gitlab');
    });

    test('renders framework options for selected languages', async () => {
      let testHooks;
      render(<ImportProject __testHooks={(hooks) => { testHooks = hooks; }} />);

      await act(async () => {
        testHooks.setStateForTests({
          currentStep: 3,
          activeTab: 'local',
          importData: {
            name: 'Tech Project',
            description: '',
            path: 'C:/Projects/tech',
            gitUrl: '',
            gitUsername: '',
            gitToken: '',
            frontend: { language: 'javascript', framework: 'react' },
            backend: { language: 'javascript', framework: 'express' }
          }
        });
      });

      const frontendSelect = screen.getByLabelText('Frontend Framework *');
      const backendSelect = screen.getByLabelText('Backend Framework *');

      expect(within(frontendSelect).getByRole('option', { name: /react/i })).toBeInTheDocument();
      expect(within(backendSelect).getByRole('option', { name: /express/i })).toBeInTheDocument();
    });

    test('restores the default branch when cleared', async () => {
      let testHooks;
      const user = userEvent.setup();
      mockImportProject.mockResolvedValue({ project: { id: 1 }, jobs: [] });

      render(
        <ImportProject
          __testHooks={(hooks) => {
            testHooks = hooks;
          }}
        />
      );

      await act(async () => {
        testHooks.setStateForTests({
          currentStep: 5,
          activeTab: 'local',
          gitConnectionDefaultBranch: '',
          importData: {
            name: 'Default Branch Project',
            path: 'C:/Projects/default-branch',
            description: ''
          }
        });
      });

      await user.click(screen.getByRole('button', { name: 'Import Project' }));

      expect(mockImportProject).toHaveBeenCalledWith(
        expect.objectContaining({
          gitDefaultBranch: 'main'
        })
      );
    });

    test('switching to global connection resets provider to the global setting', async () => {
      let testHooks;
      const user = userEvent.setup();
      render(<ImportProject __testHooks={(hooks) => { testHooks = hooks; }} />);

      await waitFor(() => expect(testHooks).toBeTruthy());

      await act(async () => {
        testHooks.setStateForTests({
          currentStep: 5,
          activeTab: 'local',
          gitConnectionMode: 'custom',
          gitConnectionProvider: 'gitlab'
        });
      });

      const providerSelect = screen.getByLabelText('Git Provider');
      expect(providerSelect).toHaveValue('gitlab');

      await user.click(screen.getByRole('radio', { name: /Use global connection/i }));

      expect(providerSelect).toHaveValue('github');
      expect(providerSelect).toBeDisabled();
    });

    test('typing a custom remote URL updates the git connection value', async () => {
      const { user } = renderComponent();
      const gitUrl = 'https://github.com/test/repo.git';

      await goToGitConfigStep(user, { tab: 'git', name: 'Git Project', gitUrl });

      await user.click(screen.getByRole('radio', { name: /Use custom connection/i }));

      const remoteInput = screen.getByLabelText('Remote Repository URL *');
      await user.clear(remoteInput);
      await user.type(remoteInput, 'https://gitlab.com/org/new.git');

      expect(remoteInput).toHaveValue('https://gitlab.com/org/new.git');
    });

    test('uses the default git branch set through test hooks', async () => {
      let testHooks;
      const user = userEvent.setup();
      mockImportProject.mockResolvedValue({ project: { id: 1 }, jobs: [] });

      render(
        <ImportProject
          __testHooks={(hooks) => {
            testHooks = hooks;
          }}
        />
      );

      await waitFor(() => expect(testHooks).toBeTruthy());

      await act(async () => {
        testHooks.setStateForTests({
          currentStep: 5,
          activeTab: 'local',
          gitConnectionDefaultBranch: 'develop',
          importData: {
            name: 'Branch Project',
            description: '',
            path: 'C:/Projects/branch-project',
            gitUrl: '',
            gitUsername: '',
            gitToken: '',
            frontend: { language: 'javascript', framework: 'react' },
            backend: { language: 'javascript', framework: 'express' }
          }
        });
      });

      await user.click(screen.getByRole('button', { name: 'Import Project' }));

      expect(mockImportProject).toHaveBeenCalledWith(
        expect.objectContaining({
          gitDefaultBranch: 'develop'
        })
      );
    });

    test('opens the folder picker when browsing for a path', async () => {
      const { user } = renderComponent();
      await goToSourceStep(user, 'local');

      await user.click(screen.getByRole('button', { name: 'Browse' }));

      expect(await screen.findByText('Select a folder')).toBeInTheDocument();
    });

    test('selecting a folder updates the path and closes the picker', async () => {
      const fetchMock = vi.fn((url) => {
        if (url === '/api/fs/roots') {
          return Promise.resolve({
            ok: true,
            json: async () => ({ success: true, roots: [{ name: 'C:', path: 'C:\\' }] })
          });
        }
        if (url === '/api/fs/list?path=C%3A%5C') {
          return Promise.resolve({
            ok: true,
            json: async () => ({ success: true, path: 'C:\\', directories: [] })
          });
        }
        return mockFetch(url);
      });
      vi.stubGlobal('fetch', fetchMock);

      const { user } = renderComponent();
      await goToSourceStep(user, 'local');

      await user.click(screen.getByRole('button', { name: 'Browse' }));
      await user.click(await screen.findByText('C:'));
      await user.click(screen.getByRole('button', { name: 'Select' }));

      expect(screen.getByLabelText('Project Folder Path *')).toHaveValue('C:\\');
      expect(screen.queryByText('Select a folder')).toBeNull();
    });

    test('fires form handlers for inputs, submit, and modal close', async () => {
      let testHooks;
      const user = userEvent.setup();
      render(<ImportProject __testHooks={(hooks) => { testHooks = hooks; }} />);
      await waitFor(() => expect(testHooks).toBeTruthy());

      // Step 2 (source, local): submit form, change path, toggle radio, open/close modal
      await goToSourceStep(user, 'local');
      fireEvent.submit(screen.getByRole('form'));

      const pathInput = screen.getByLabelText('Project Folder Path *');
      await user.clear(pathInput);
      await user.type(pathInput, 'C:/NewPath');

      await user.click(screen.getByRole('radio', { name: /Link to existing folder/i }));
      await user.click(screen.getByRole('radio', { name: /Copy into managed folder/i }));

      await user.click(screen.getByRole('button', { name: 'Browse' }));
      const modal = await screen.findByRole('dialog', { name: 'Select folder' });
      await user.click(within(modal).getByRole('button', { name: 'Cancel' }));

      // Step 2 (source, git): render git source step directly and exercise its handlers
      await act(async () => {
        testHooks.setStateForTests({
          currentStep: 1,
          activeTab: 'git'
        });
      });

      await user.selectOptions(screen.getByLabelText('Git Provider'), 'gitlab');
      const gitUrlInput = screen.getByLabelText('Git Repository URL *');
      await user.clear(gitUrlInput);
      await user.type(gitUrlInput, 'https://gitlab.com/org/repo.git');

      await user.type(screen.getByLabelText('Username (optional)'), 'git-user');
      await user.type(screen.getByLabelText('Personal Access Token'), 'git-token');
      await user.click(screen.getByRole('radio', { name: /SSH/i }));
      await user.click(screen.getByRole('radio', { name: /PAT \(HTTPS\)/i }));

      // Step 3 (details): change description
      await act(async () => {
        testHooks.setStateForTests({
          currentStep: 2,
          activeTab: 'local',
          importData: {
            name: 'My Project',
            description: '',
            path: 'C:/NewPath',
            gitUrl: '',
            gitUsername: '',
            gitToken: '',
            frontend: { language: 'javascript', framework: 'react' },
            backend: { language: 'javascript', framework: 'express' }
          }
        });
      });

      const descriptionInput = screen.getByLabelText('Description');
      await user.clear(descriptionInput);
      await user.type(descriptionInput, 'Updated description');

      // Step 1 (source tabs): ensure the local tab onClick is exercised
      await act(async () => {
        testHooks.setStateForTests({ currentStep: 0, activeTab: 'git' });
      });
      await user.click(screen.getByRole('tab', { name: 'Local Folder' }));
    });
  });

  test('keeps existing stack when tech detection payload omits languages and frameworks', async () => {
    const fetchMock = vi.fn((url) => {
      if (typeof url === 'string' && url.startsWith('/api/fs/detect-tech')) {
        return Promise.resolve({ ok: true, json: async () => ({ success: true, frontend: {}, backend: {} }) });
      }
      return mockFetch(url);
    });
    vi.stubGlobal('fetch', fetchMock);

    let testHooks;
    render(<ImportProject __testHooks={(hooks) => { testHooks = hooks; }} />);
    await waitFor(() => expect(testHooks).toBeTruthy());

    await act(async () => {
      testHooks.setStateForTests({ currentStep: 3, activeTab: 'local', importData: {
        name: '',
        description: '',
        path: 'C:/Projects/demo',
        gitUrl: '',
        gitUsername: '',
        gitToken: '',
        frontend: { language: 'javascript', framework: 'react' },
        backend: { language: 'javascript', framework: 'express' }
      } });
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/fs/detect-tech')));

    await screen.findByText('Tech stack detected.');

    const frontendLanguageSelect = await screen.findByLabelText(/Frontend Language/i);
    expect(frontendLanguageSelect).toHaveValue('javascript');
    expect(screen.getByLabelText(/Frontend Framework/i)).toHaveValue('react');
    expect(screen.getByLabelText(/Backend Language/i)).toHaveValue('javascript');
    expect(screen.getByLabelText(/Backend Framework/i)).toHaveValue('express');
  });

  test('keeps existing stack when tech detection payload omits frontend and backend objects', async () => {
    const fetchMock = vi.fn((url) => {
      if (typeof url === 'string' && url.startsWith('/api/fs/detect-tech')) {
        return Promise.resolve({ ok: true, json: async () => ({ success: true, frontend: null, backend: null }) });
      }
      return mockFetch(url);
    });
    vi.stubGlobal('fetch', fetchMock);

    let testHooks;
    render(<ImportProject __testHooks={(hooks) => { testHooks = hooks; }} />);
    await waitFor(() => expect(testHooks).toBeTruthy());

    await act(async () => {
      testHooks.setStateForTests({
        currentStep: 3,
        activeTab: 'local',
        importData: {
          name: '',
          description: '',
          path: 'C:/Projects/demo',
          gitUrl: '',
          gitUsername: '',
          gitToken: '',
          frontend: { language: 'javascript', framework: 'react' },
          backend: { language: 'javascript', framework: 'express' }
        }
      });
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/fs/detect-tech')));
    await screen.findByText('Tech stack detected.');

    expect(screen.getByLabelText(/Frontend Language/i)).toHaveValue('javascript');
    expect(screen.getByLabelText(/Frontend Framework/i)).toHaveValue('react');
    expect(screen.getByLabelText(/Backend Language/i)).toHaveValue('javascript');
    expect(screen.getByLabelText(/Backend Framework/i)).toHaveValue('express');
  });

  test('updates stack when tech detection returns values', async () => {
    const fetchMock = vi.fn((url) => {
      if (typeof url === 'string' && url.startsWith('/api/fs/detect-tech')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            frontend: { language: 'typescript', framework: 'nextjs' },
            backend: { language: 'python', framework: 'django' }
          })
        });
      }
      return mockFetch(url);
    });
    vi.stubGlobal('fetch', fetchMock);

    let testHooks;
    render(<ImportProject __testHooks={(hooks) => { testHooks = hooks; }} />);
    await waitFor(() => expect(testHooks).toBeTruthy());

    await act(async () => {
      testHooks.setStateForTests({
        currentStep: 3,
        activeTab: 'local',
        importData: {
          name: '',
          description: '',
          path: 'C:/Projects/demo',
          gitUrl: '',
          gitUsername: '',
          gitToken: '',
          frontend: { language: 'javascript', framework: 'react' },
          backend: { language: 'javascript', framework: 'express' }
        }
      });
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/fs/detect-tech')));
    await screen.findByText('Tech stack detected.');

    expect(screen.getByLabelText(/Frontend Language/i)).toHaveValue('typescript');
    expect(screen.getByLabelText(/Frontend Framework/i)).toHaveValue('nextjs');
    expect(screen.getByLabelText(/Backend Language/i)).toHaveValue('python');
    expect(screen.getByLabelText(/Backend Framework/i)).toHaveValue('django');
  });

  test('skips repeated tech and compatibility scans for the same path', async () => {
    const fetchMock = vi.fn((url) => {
      if (typeof url === 'string' && url.startsWith('/api/fs/detect-tech')) {
        return Promise.resolve({ ok: true, json: async () => ({ success: true, frontend: {}, backend: {} }) });
      }
      if (typeof url === 'string' && url.startsWith('/api/fs/compatibility')) {
        return Promise.resolve({ ok: true, json: async () => ({ success: true, plan: null }) });
      }
      return mockFetch(url);
    });
    vi.stubGlobal('fetch', fetchMock);

    const baseImportData = {
      name: 'Demo',
      description: '',
      path: 'C:/Projects/demo',
      gitUrl: '',
      gitUsername: '',
      gitToken: '',
      frontend: { language: 'javascript', framework: 'react' },
      backend: { language: 'javascript', framework: 'express' }
    };

    let testHooks;
    render(<ImportProject __testHooks={(hooks) => { testHooks = hooks; }} />);
    await waitFor(() => expect(testHooks).toBeTruthy());

    // First tech detect call
    await act(async () => {
      testHooks.setStateForTests({ currentStep: 3, activeTab: 'local', importData: baseImportData });
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/fs/detect-tech')));

    fetchMock.mockClear();

    // Same path should not trigger another tech detect
    await act(async () => {
      testHooks.setStateForTests({ currentStep: 3, activeTab: 'local', importData: baseImportData });
    });
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());

    // First compatibility call
    await act(async () => {
      testHooks.setStateForTests({ currentStep: 4, activeTab: 'local', importData: baseImportData });
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/fs/compatibility')));

    fetchMock.mockClear();

    // Same path should not trigger another compatibility call
    await act(async () => {
      testHooks.setStateForTests({ currentStep: 4, activeTab: 'local', importData: baseImportData });
    });
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
  });

  test('clears compatibility plan when the response omits plan data', async () => {
    const fetchMock = vi.fn((url) => {
      if (typeof url === 'string' && url.startsWith('/api/fs/compatibility')) {
        return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
      }
      return mockFetch(url);
    });
    vi.stubGlobal('fetch', fetchMock);

    let testHooks;
    render(<ImportProject __testHooks={(hooks) => { testHooks = hooks; }} />);
    await waitFor(() => expect(testHooks).toBeTruthy());

    await act(async () => {
      testHooks.setStateForTests({ currentStep: 4, activeTab: 'local', importData: {
        name: 'Demo',
        description: '',
        path: 'C:/Projects/demo',
        gitUrl: '',
        gitUsername: '',
        gitToken: '',
        frontend: { language: 'javascript', framework: 'react' },
        backend: { language: 'javascript', framework: 'express' }
      } });
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/fs/compatibility')));

    await waitFor(() => expect(screen.getByLabelText(/Allow compatibility updates/i)).not.toBeDisabled());
    expect(screen.queryByText('No compatibility changes required.')).not.toBeInTheDocument();
  });

  test('uses compatibility plan when the response includes plan data', async () => {
    const fetchMock = vi.fn((url) => {
      if (typeof url === 'string' && url.startsWith('/api/fs/compatibility')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            plan: { needsChanges: false, changes: [], structure: { needsMove: false } }
          })
        });
      }
      return mockFetch(url);
    });
    vi.stubGlobal('fetch', fetchMock);

    let testHooks;
    render(<ImportProject __testHooks={(hooks) => { testHooks = hooks; }} />);
    await waitFor(() => expect(testHooks).toBeTruthy());

    await act(async () => {
      testHooks.setStateForTests({
        currentStep: 4,
        activeTab: 'local',
        importData: {
          name: 'Demo',
          description: '',
          path: 'C:/Projects/demo',
          gitUrl: '',
          gitUsername: '',
          gitToken: '',
          frontend: { language: 'javascript', framework: 'react' },
          backend: { language: 'javascript', framework: 'express' }
        }
      });
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/fs/compatibility')));
    expect(await screen.findByText('No compatibility changes required.')).toBeInTheDocument();
  });

  describe('Project Details', () => {
    test('shows project name and description fields', async () => {
      const { user } = renderComponent();
      await goToDetailsStep(user, { tab: 'local' });

      expect(screen.getByLabelText('Project Name *')).toBeInTheDocument();
      expect(screen.getByLabelText('Description')).toBeInTheDocument();
    });

    test('can update project name and description', async () => {
      const { user } = renderComponent();
      await goToDetailsStep(user, { tab: 'local' });

      const nameInput = screen.getByLabelText('Project Name *');
      const descriptionInput = screen.getByLabelText('Description');
      fireEvent.change(nameInput, { target: { value: 'New Project' } });
      await user.type(descriptionInput, 'New description');

      expect(nameInput).toHaveValue('New Project');
      expect(descriptionInput).toHaveValue('New description');
    });
  });

  describe('Tech Stack', () => {
    test('shows frontend and backend selects with defaults', async () => {
      const { user } = renderComponent();
      await goToTechStep(user, { tab: 'local' });

      expect(screen.getByLabelText('Frontend Language *')).toHaveValue('javascript');
      expect(screen.getByLabelText('Frontend Framework *')).toHaveValue('react');
      expect(screen.getByLabelText('Backend Language *')).toHaveValue('javascript');
      expect(screen.getByLabelText('Backend Framework *')).toHaveValue('express');
    });

    test('frontend language change updates available frameworks', async () => {
      const { user } = renderComponent();
      await goToTechStep(user, { tab: 'local' });

      await user.selectOptions(screen.getByLabelText('Frontend Language *'), 'typescript');
      const options = within(screen.getByLabelText('Frontend Framework *')).getAllByRole('option');
      expect(options.map((option) => option.value)).toEqual(['react', 'vue', 'angular', 'svelte', 'nextjs', 'nuxtjs', 'vite']);
    });

    test('backend language change updates available frameworks', async () => {
      const { user } = renderComponent();
      await goToTechStep(user, { tab: 'local' });

      await user.selectOptions(screen.getByLabelText('Backend Language *'), 'python');
      const options = within(screen.getByLabelText('Backend Framework *')).getAllByRole('option');
      expect(options.map((option) => option.value)).toEqual(['django', 'flask', 'fastapi', 'pyramid', 'tornado']);
    });
  });

  describe('Form Validation', () => {
    test('shows error when folder path is empty on source step', async () => {
      const { user } = renderComponent();
      await goToSourceStep(user, 'local');

      await clickNext(user);

      expect(await screen.findByText('Project path is required')).toBeInTheDocument();
    });

    test('shows error when git URL is empty on source step', async () => {
      const { user } = renderComponent();
      await goToSourceStep(user, 'git');

      await clickNext(user);

      expect(await screen.findByText('Git repository URL is required')).toBeInTheDocument();
    });

    test('auto-fills project name from the local path', async () => {
      const { user } = renderComponent();
      await goToDetailsStep(user, { tab: 'local', path: 'C:/Projects/auto-name' });

      expect(await screen.findByDisplayValue('auto-name')).toBeInTheDocument();
    });

    test('does not auto-fill project name when the path is not usable', async () => {
      const { user } = renderComponent();
      await goToDetailsStep(user, { tab: 'local', path: 'C:/' });

      const nameInput = screen.getByLabelText('Project Name *');
      expect(nameInput).toHaveValue('');
    });

    test('shows error when project name is missing on details step', async () => {
      const { user } = renderComponent();
      await goToDetailsStep(user, { tab: 'local', path: 'C:/' });

      await clickNext(user);

      expect(await screen.findByText('Project name is required')).toBeInTheDocument();
    });

    test('updates frontend framework selection', async () => {
      const { user } = renderComponent();
      await goToTechStep(user, { tab: 'local', path: 'C:/Projects/demo' });

      const frameworkSelect = screen.getByLabelText('Frontend Framework *');
      await user.selectOptions(frameworkSelect, 'vue');

      expect(frameworkSelect).toHaveValue('vue');
    });

    test('updates backend framework selection', async () => {
      const { user } = renderComponent();
      await goToTechStep(user, { tab: 'local', path: 'C:/Projects/demo' });

      const frameworkSelect = screen.getByLabelText('Backend Framework *');
      await user.selectOptions(frameworkSelect, 'fastify');

      expect(frameworkSelect).toHaveValue('fastify');
    });
  });

  describe('Import validation hooks', () => {
    test('reports missing project name on submit', async () => {
      let testHooks;
      render(<ImportProject __testHooks={(hooks) => { testHooks = hooks; }} />);

      await waitFor(() => expect(testHooks).toBeTruthy());
      await act(async () => {
        testHooks.setStateForTests({
          currentStep: 5,
          activeTab: 'local',
          nameTouched: true,
          importData: { name: '', path: 'C:/Projects/demo' },
          compatibilityPlan: { needsChanges: false, structure: { needsMove: false } },
          compatibilityConsent: true,
          structureConsent: true
        });
      });

      await waitFor(() => expect(screen.getByText('Step 6 of 6')).toBeInTheDocument());

      await act(async () => {
        await testHooks.triggerImportForTests();
      });

      expect(await screen.findByText('Project name is required')).toBeInTheDocument();
    });

    test('reports missing local path on submit', async () => {
      let testHooks;
      render(<ImportProject __testHooks={(hooks) => { testHooks = hooks; }} />);

      await waitFor(() => expect(testHooks).toBeTruthy());
      await act(async () => {
        testHooks.setStateForTests({
          currentStep: 5,
          activeTab: 'local',
          nameTouched: true,
          importData: { name: 'Demo', path: '' },
          compatibilityPlan: { needsChanges: false, structure: { needsMove: false } },
          compatibilityConsent: true,
          structureConsent: true
        });
      });

      await waitFor(() => expect(screen.getByText('Step 6 of 6')).toBeInTheDocument());

      await act(async () => {
        await testHooks.triggerImportForTests();
      });

      expect(await screen.findByText('Project path is required')).toBeInTheDocument();
    });

    test('reports missing git URL on submit', async () => {
      let testHooks;
      render(<ImportProject __testHooks={(hooks) => { testHooks = hooks; }} />);

      await waitFor(() => expect(testHooks).toBeTruthy());
      await act(async () => {
        testHooks.setStateForTests({
          currentStep: 5,
          activeTab: 'git',
          nameTouched: true,
          importData: { name: 'Demo', gitUrl: '' }
        });
      });

      await waitFor(() => expect(screen.getByText('Step 6 of 6')).toBeInTheDocument());

      await act(async () => {
        testHooks.setStateForTests({
          compatibilityConsent: true,
          structureConsent: true
        });
      });

      await act(async () => {
        await testHooks.triggerImportForTests();
      });

      expect(await screen.findByText('Git repository URL is required')).toBeInTheDocument();
    });

    test('clears import errors when step changes', async () => {
      let testHooks;
      render(<ImportProject __testHooks={(hooks) => { testHooks = hooks; }} />);

      await waitFor(() => expect(testHooks).toBeTruthy());
      await act(async () => {
        testHooks.setStateForTests({
          currentStep: 2
        });
      });

      await act(async () => {
        testHooks.setStateForTests({
          importError: 'Forced error'
        });
      });

      expect(await screen.findByText('Forced error')).toBeInTheDocument();

      await act(async () => {
        testHooks.setStateForTests({ currentStep: 3 });
      });

      await waitFor(() => expect(screen.queryByText('Forced error')).toBeNull());
    });

    test('clears import error when test hooks set an empty string', async () => {
      let testHooks;
      render(<ImportProject __testHooks={(hooks) => { testHooks = hooks; }} />);

      await waitFor(() => expect(testHooks).toBeTruthy());
      await act(async () => {
        testHooks.setStateForTests({
          currentStep: 2,
          nameTouched: true
        });
      });

      await act(async () => {
        testHooks.setStateForTests({
          importError: 'Forced error'
        });
      });

      await waitFor(() => expect(screen.getByText('Forced error')).toBeInTheDocument());

      await act(async () => {
        testHooks.setStateForTests({
          importError: ''
        });
      });

      await waitFor(() => expect(screen.queryByText('Forced error')).toBeNull());
    });

    test('clears import errors when tab changes', async () => {
      let testHooks;
      render(<ImportProject __testHooks={(hooks) => { testHooks = hooks; }} />);

      await waitFor(() => expect(testHooks).toBeTruthy());
      await act(async () => {
        testHooks.setStateForTests({
          currentStep: 2,
          activeTab: 'local'
        });
      });

      await act(async () => {
        testHooks.setStateForTests({
          importError: 'Forced error'
        });
      });

      expect(await screen.findByText('Forced error')).toBeInTheDocument();

      await act(async () => {
        testHooks.setStateForTests({ activeTab: 'git' });
      });

      await waitFor(() => expect(screen.queryByText('Forced error')).toBeNull());
    });

    test('skips tech detection when path is empty', async () => {
      let testHooks;
      const fetchSpy = vi.fn(mockFetch);
      vi.stubGlobal('fetch', fetchSpy);
      render(<ImportProject __testHooks={(hooks) => { testHooks = hooks; }} />);

      await waitFor(() => expect(testHooks).toBeTruthy());
      await act(async () => {
        testHooks.setStateForTests({
          currentStep: 3,
          activeTab: 'local',
          importData: { path: '   ' }
        });
      });

      await waitFor(() => expect(screen.getByText('Step 4 of 6')).toBeInTheDocument());

      const detectCalls = fetchSpy.mock.calls.filter(([url]) => String(url).startsWith('/api/fs/detect-tech'));
      expect(detectCalls).toHaveLength(0);
    });

    test('does not rescan compatibility for the same path', async () => {
      let testHooks;
      const fetchSpy = vi.fn(mockFetch);
      vi.stubGlobal('fetch', fetchSpy);
      render(<ImportProject __testHooks={(hooks) => { testHooks = hooks; }} />);

      await waitFor(() => expect(testHooks).toBeTruthy());
      await act(async () => {
        testHooks.setStateForTests({
          currentStep: 4,
          activeTab: 'local',
          importData: { path: 'C:/Projects/demo' }
        });
      });

      await waitFor(() => {
        const calls = fetchSpy.mock.calls.filter(([url]) => String(url).startsWith('/api/fs/compatibility'));
        expect(calls.length).toBe(1);
      });

      await act(async () => {
        testHooks.setStateForTests({
          importData: { path: 'C:/Projects/demo' }
        });
      });

      const callsAfter = fetchSpy.mock.calls.filter(([url]) => String(url).startsWith('/api/fs/compatibility'));
      expect(callsAfter.length).toBe(1);
    });

    test('skips compatibility scan when returning to step 4 with the same path', async () => {
      let testHooks;
      const fetchSpy = vi.fn(mockFetch);
      vi.stubGlobal('fetch', fetchSpy);
      render(<ImportProject __testHooks={(hooks) => { testHooks = hooks; }} />);

      await waitFor(() => expect(testHooks).toBeTruthy());
      await act(async () => {
        testHooks.setStateForTests({
          currentStep: 4,
          activeTab: 'local',
          importData: { path: 'C:/Projects/demo' }
        });
      });

      await waitFor(() => {
        const calls = fetchSpy.mock.calls.filter(([url]) => String(url).startsWith('/api/fs/compatibility'));
        expect(calls.length).toBe(1);
      });

      await act(async () => {
        testHooks.setStateForTests({ currentStep: 3 });
      });

      await act(async () => {
        testHooks.setStateForTests({ currentStep: 4 });
      });

      const callsAfter = fetchSpy.mock.calls.filter(([url]) => String(url).startsWith('/api/fs/compatibility'));
      expect(callsAfter.length).toBe(1);
    });

    test('resets compatibility consent when switching to git on step 4', async () => {
      let testHooks;
      render(<ImportProject __testHooks={(hooks) => { testHooks = hooks; }} />);

      await waitFor(() => expect(testHooks).toBeTruthy());
      await act(async () => {
        testHooks.setStateForTests({
          currentStep: 4,
          activeTab: 'local',
          importData: { path: 'C:/Projects/demo' },
          compatibilityConsent: true
        });
      });

      await waitFor(() => expect(screen.getByText('Step 5 of 6')).toBeInTheDocument());
      expect(screen.getByRole('checkbox', { name: /Allow compatibility updates/i })).toBeChecked();

      await act(async () => {
        testHooks.setStateForTests({ activeTab: 'git' });
      });

      await waitFor(() => {
        expect(screen.getByRole('checkbox', { name: /Allow compatibility updates/i })).not.toBeChecked();
      });
    });

    test('skips compatibility scan when path is empty', async () => {
      let testHooks;
      const fetchSpy = vi.fn(mockFetch);
      vi.stubGlobal('fetch', fetchSpy);
      render(<ImportProject __testHooks={(hooks) => { testHooks = hooks; }} />);

      await waitFor(() => expect(testHooks).toBeTruthy());
      await act(async () => {
        testHooks.setStateForTests({
          currentStep: 4,
          activeTab: 'local',
          importData: { path: '   ' }
        });
      });

      await waitFor(() => expect(screen.getByText('Step 5 of 6')).toBeInTheDocument());

      const calls = fetchSpy.mock.calls.filter(([url]) => String(url).startsWith('/api/fs/compatibility'));
      expect(calls).toHaveLength(0);
    });

    test('ignores import attempts before the final step', async () => {
      let testHooks;
      render(<ImportProject __testHooks={(hooks) => { testHooks = hooks; }} />);

      await waitFor(() => expect(testHooks).toBeTruthy());
      await act(async () => {
        testHooks.setStateForTests({
          currentStep: 3,
          activeTab: 'local',
          importData: { name: 'Demo', path: 'C:/Projects/demo' }
        });
      });

      await act(async () => {
        await testHooks.triggerImportForTests();
      });

      expect(mockImportProject).not.toHaveBeenCalled();
    });

    test('requires compatibility consent when required', async () => {
      let testHooks;
      render(<ImportProject __testHooks={(hooks) => { testHooks = hooks; }} />);

      await waitFor(() => expect(testHooks).toBeTruthy());
      await act(async () => {
        testHooks.setStateForTests({
          currentStep: 5,
          activeTab: 'git',
          importData: { name: 'Demo', gitUrl: 'https://github.com/test/repo.git' },
          compatibilityConsent: false,
          structureConsent: true
        });
      });

      await waitFor(() => expect(screen.getByText('Step 6 of 6')).toBeInTheDocument());

      await act(async () => {
        await testHooks.triggerImportForTests();
      });

      expect(await screen.findByText('Please allow compatibility updates to continue')).toBeInTheDocument();
    });

    test('requires structure consent when required', async () => {
      let testHooks;
      render(<ImportProject __testHooks={(hooks) => { testHooks = hooks; }} />);

      await waitFor(() => expect(testHooks).toBeTruthy());
      await act(async () => {
        testHooks.setStateForTests({
          currentStep: 5,
          activeTab: 'git',
          importData: { name: 'Demo', gitUrl: 'https://github.com/test/repo.git' },
          compatibilityConsent: true,
          structureConsent: false
        });
      });

      await waitFor(() => expect(screen.getByText('Step 6 of 6')).toBeInTheDocument());

      await act(async () => {
        testHooks.setStateForTests({
          compatibilityConsent: true,
          structureConsent: false
        });
      });

      await act(async () => {
        await testHooks.triggerImportForTests();
      });

      expect(await screen.findByText('Please allow moving frontend files into a frontend folder')).toBeInTheDocument();
    });

    test('sets import error and local mode via test hooks', async () => {
      let testHooks;
      render(<ImportProject __testHooks={(hooks) => { testHooks = hooks; }} />);

      await waitFor(() => expect(testHooks).toBeTruthy());
      await act(async () => {
        testHooks.setStateForTests({
          currentStep: 1,
          activeTab: 'local',
          localImportMode: 'link'
        });
      });

      await waitFor(() => expect(screen.getByText('Step 2 of 6')).toBeInTheDocument());

      await act(async () => {
        testHooks.setStateForTests({
          importError: 'Forced error'
        });
      });

      expect(await screen.findByText('Forced error')).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: /Link to existing folder/i })).toBeChecked();
    });

    test('sets git provider and auth method via test hooks', async () => {
      let testHooks;
      render(<ImportProject __testHooks={(hooks) => { testHooks = hooks; }} />);

      await waitFor(() => expect(testHooks).toBeTruthy());
      await act(async () => {
        testHooks.setStateForTests({
          currentStep: 1,
          activeTab: 'git',
          gitProvider: 'gitlab',
          gitAuthMethod: 'ssh'
        });
      });

      await waitFor(() => expect(screen.getByText('Step 2 of 6')).toBeInTheDocument());

      expect(screen.getByLabelText('Git Provider')).toHaveValue('gitlab');
      expect(screen.getByRole('radio', { name: /SSH/i })).toBeChecked();
    });

    test('honors frontend and backend touched flags during tech detection', async () => {
      let testHooks;
      render(<ImportProject __testHooks={(hooks) => { testHooks = hooks; }} />);

      await waitFor(() => expect(testHooks).toBeTruthy());
      await act(async () => {
        testHooks.setStateForTests({
          currentStep: 3,
          activeTab: 'local',
          importData: {
            name: 'Demo',
            path: 'C:/Projects/demo',
            frontend: { language: 'javascript', framework: 'vue' },
            backend: { language: 'javascript', framework: 'fastify' }
          },
          frontendTouched: true,
          backendTouched: true
        });
      });

      await waitFor(() => expect(screen.getByText('Step 4 of 6')).toBeInTheDocument());

      const frontendSelect = screen.getByLabelText('Frontend Framework *');
      const backendSelect = screen.getByLabelText('Backend Framework *');

      await waitFor(() => {
        expect(frontendSelect).toHaveValue('vue');
        expect(backendSelect).toHaveValue('fastify');
      });
    });

    test('ignores stale import attempts in the error handler', async () => {
      let testHooks;
      let rejectImport;
      mockImportProject.mockImplementation(() => new Promise((_, reject) => {
        rejectImport = reject;
      }));

      render(<ImportProject __testHooks={(hooks) => { testHooks = hooks; }} />);

      await waitFor(() => expect(testHooks).toBeTruthy());
      await act(async () => {
        testHooks.setStateForTests({
          currentStep: 5,
          activeTab: 'local',
          nameTouched: true,
          importData: { name: 'Demo', path: 'C:/Projects/demo' },
          compatibilityPlan: { needsChanges: false, structure: { needsMove: false } },
          compatibilityConsent: true,
          structureConsent: true
        });
      });

      await waitFor(() => expect(screen.getByText('Step 6 of 6')).toBeInTheDocument());

      let importPromise;
      await act(async () => {
        importPromise = testHooks.triggerImportForTests();
      });

      await waitFor(() => expect(mockImportProject).toHaveBeenCalled());

      testHooks.setAttemptIdForTests(999);

      await act(async () => {
        rejectImport(new Error('Import failed'));
      });

      await act(async () => {
        await importPromise;
      });

      expect(screen.queryByText('Import failed')).toBeNull();
    });

    test('skips tech/compatibility fetch on early-return branches', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      let testHooks;
      render(<ImportProject __testHooks={(hooks) => { testHooks = hooks; }} />);
      await waitFor(() => expect(testHooks).toBeTruthy());

      const baseImportData = {
        name: 'Demo',
        description: '',
        path: 'C:/Projects/demo',
        gitUrl: '',
        gitUsername: '',
        gitToken: '',
        frontend: { language: 'javascript', framework: 'react' },
        backend: { language: 'javascript', framework: 'express' }
      };

      // currentStep !== 3 branch
      await act(async () => { testHooks.setStateForTests({ currentStep: 1 }); });

      // activeTab !== 'local' branch for tech detection
      await act(async () => {
        testHooks.setStateForTests({ currentStep: 3, activeTab: 'git', importData: baseImportData });
      });

      // empty path branch for tech detection
      await act(async () => {
        testHooks.setStateForTests({ currentStep: 3, activeTab: 'local', importData: { ...baseImportData, path: '' } });
      });

      // activeTab !== 'local' branch for compatibility
      await act(async () => {
        testHooks.setStateForTests({ currentStep: 4, activeTab: 'git', importData: baseImportData });
      });

      // empty path branch for compatibility
      await act(async () => {
        testHooks.setStateForTests({ currentStep: 4, activeTab: 'local', importData: { ...baseImportData, path: '' } });
      });

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('Tech detection and compatibility checks', () => {
    test('resets compatibility consent when leaving the local tab (covers compatibility early-exit branch)', async () => {
      const fetchMock = vi.fn((url) => {
        if (typeof url === 'string' && url.startsWith('/api/fs/compatibility')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              success: true,
              plan: {
                needsChanges: true,
                changes: [],
                structure: { needsMove: false }
              }
            })
          });
        }
        return mockFetch(url);
      });
      vi.stubGlobal('fetch', fetchMock);

      let testHooks;
      render(<ImportProject __testHooks={(hooks) => { testHooks = hooks; }} />);
      await waitFor(() => expect(testHooks).toBeTruthy());

      await act(async () => {
        testHooks.setStateForTests({
          currentStep: 4,
          activeTab: 'local',
          importData: { name: 'Demo', path: 'C:/Projects/demo' },
          compatibilityConsent: true
        });
      });

      await waitFor(() => expect(screen.getByText('Step 5 of 6')).toBeInTheDocument());
      await waitFor(() => expect(screen.getByRole('checkbox', { name: /Allow compatibility updates/i })).toBeChecked());

      await act(async () => {
        testHooks.setStateForTests({ activeTab: 'git' });
      });

      await waitFor(() => expect(screen.getByRole('checkbox', { name: /Allow compatibility updates/i })).not.toBeChecked());
    });

    test('shows an error when compatibility scan returns ok but success is false', async () => {
      const fetchMock = vi.fn((url) => {
        if (typeof url === 'string' && url.startsWith('/api/fs/compatibility')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ success: false, error: 'Compatibility not successful' })
          });
        }
        return mockFetch(url);
      });
      vi.stubGlobal('fetch', fetchMock);

      const { user } = renderComponent();
      await goToCompatibilityStep(user, { tab: 'local', path: 'C:/Projects/demo' });

      expect(await screen.findByText('Compatibility not successful')).toBeInTheDocument();
    });
    test('shows an error when tech detection fails', async () => {
      const fetchMock = vi.fn((url) => {
        if (typeof url === 'string' && url.startsWith('/api/fs/detect-tech')) {
          return Promise.resolve({
            ok: false,
            json: async () => ({ success: false, error: 'Detect failed' })
          });
        }
        return mockFetch(url);
      });
      vi.stubGlobal('fetch', fetchMock);

      const { user } = renderComponent();
      await goToTechStep(user, { tab: 'local', path: 'C:/Projects/demo' });

      expect(await screen.findByText('Detect failed')).toBeInTheDocument();
    });

    test('falls back to a default message when tech detection throws without a message', async () => {
      const fetchMock = vi.fn((url) => {
        if (typeof url === 'string' && url.startsWith('/api/fs/detect-tech')) {
          return Promise.reject(new Error(''));
        }
        return mockFetch(url);
      });
      vi.stubGlobal('fetch', fetchMock);

      const { user } = renderComponent();
      await goToTechStep(user, { tab: 'local', path: 'C:/Projects/demo' });

      expect(await screen.findByText('Failed to detect tech stack')).toBeInTheDocument();
    });

    test('falls back to a default message when tech detection has no error details', async () => {
      const fetchMock = vi.fn((url) => {
        if (typeof url === 'string' && url.startsWith('/api/fs/detect-tech')) {
          return Promise.resolve({
            ok: false,
            json: async () => ({ success: false })
          });
        }
        return mockFetch(url);
      });
      vi.stubGlobal('fetch', fetchMock);

      const { user } = renderComponent();
      await goToTechStep(user, { tab: 'local', path: 'C:/Projects/demo' });

      expect(await screen.findByText('Failed to detect tech stack')).toBeInTheDocument();
    });

    test('shows an error when compatibility scan fails', async () => {
      const fetchMock = vi.fn((url) => {
        if (typeof url === 'string' && url.startsWith('/api/fs/compatibility')) {
          return Promise.resolve({
            ok: false,
            json: async () => ({ success: false, error: 'Compatibility failed' })
          });
        }
        return mockFetch(url);
      });
      vi.stubGlobal('fetch', fetchMock);

      const { user } = renderComponent();
      await goToCompatibilityStep(user, { tab: 'local', path: 'C:/Projects/demo' });

      expect(await screen.findByText('Compatibility failed')).toBeInTheDocument();
    });

    test('falls back to a default message when compatibility scan has no error details', async () => {
      const fetchMock = vi.fn((url) => {
        if (typeof url === 'string' && url.startsWith('/api/fs/compatibility')) {
          return Promise.resolve({
            ok: false,
            json: async () => ({ success: false })
          });
        }
        return mockFetch(url);
      });
      vi.stubGlobal('fetch', fetchMock);

      const { user } = renderComponent();
      await goToCompatibilityStep(user, { tab: 'local', path: 'C:/Projects/demo' });

      expect(await screen.findByText('Failed to scan compatibility')).toBeInTheDocument();
    });

    test('falls back to a default message when compatibility scan throws without a message', async () => {
      const fetchMock = vi.fn((url) => {
        if (typeof url === 'string' && url.startsWith('/api/fs/compatibility')) {
          return Promise.reject(new Error(''));
        }
        return mockFetch(url);
      });
      vi.stubGlobal('fetch', fetchMock);

      const { user } = renderComponent();
      await goToCompatibilityStep(user, { tab: 'local', path: 'C:/Projects/demo' });

      expect(await screen.findByText('Failed to scan compatibility')).toBeInTheDocument();
    });

    test('renders compatibility changes and structure warnings', async () => {
      const fetchMock = vi.fn((url) => {
        if (typeof url === 'string' && url.startsWith('/api/fs/compatibility')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              success: true,
              plan: {
                needsChanges: true,
                changes: [
                  { key: 'bind-host', description: 'Update dev server host binding' },
                  { key: 'add-cross-env', description: 'Add cross-env for HOST binding' },
                  { description: 'Default change label is used' }
                ],
                structure: { needsMove: true }
              }
            })
          });
        }
        return mockFetch(url);
      });
      vi.stubGlobal('fetch', fetchMock);

      const { user } = renderComponent();
      await goToCompatibilityStep(user, { tab: 'local', path: 'C:/Projects/demo' });

      expect(await screen.findByText('Update dev server host binding')).toBeInTheDocument();
      expect(screen.getByText('Add cross-env for HOST binding')).toBeInTheDocument();
      expect(screen.getByText('Default change label is used')).toBeInTheDocument();
      expect(screen.getByText('Frontend files will be moved into a frontend/ folder.')).toBeInTheDocument();
    });

    test('shows no compatibility changes when payload changes is not an array', async () => {
      const fetchMock = vi.fn((url) => {
        if (typeof url === 'string' && url.startsWith('/api/fs/compatibility')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              success: true,
              plan: {
                needsChanges: false,
                changes: null,
                structure: { needsMove: false }
              }
            })
          });
        }
        return mockFetch(url);
      });
      vi.stubGlobal('fetch', fetchMock);

      const { user } = renderComponent();
      await goToCompatibilityStep(user, { tab: 'local', name: 'Job Project', path: 'C:/Projects/job' });

      expect(await screen.findByText('No compatibility changes required.')).toBeInTheDocument();
    });
  });

  describe('Project Import', () => {
    test('imports project with local method', async () => {
      mockImportProject.mockResolvedValue({ project: { id: 'new-project' }, jobs: [] });
      const { user } = renderComponent();
      await goToGitConfigStep(user, { tab: 'local', name: 'Folder Project', path: 'C:/Projects/folder' });

      const importButton = screen.getByRole('button', { name: 'Import Project' });
      expect(importButton).toBeEnabled();

      await user.click(importButton);

      expect(mockImportProject).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Folder Project',
          importMethod: 'local',
          localPath: 'C:/Projects/folder'
        })
      );
      expect(mockShowMain).toHaveBeenCalled();
    });

    test('imports project with git method once consents are checked', async () => {
      mockImportProject.mockResolvedValue({ project: { id: 'git-project' }, jobs: [] });
      const { user } = renderComponent();
      await goToCompatibilityStep(user, { tab: 'git', name: 'Git Project', gitUrl: 'https://github.com/test/repo.git' });

      await user.click(screen.getByRole('checkbox', { name: /Allow compatibility updates/i }));
      await user.click(screen.getByRole('checkbox', { name: /Move frontend files into a frontend folder/i }));

      await user.click(screen.getByRole('button', { name: 'Next' }));
      const importButton = screen.getByRole('button', { name: 'Import Project' });
      expect(importButton).toBeEnabled();
      await user.click(importButton);

      expect(mockImportProject).toHaveBeenCalledWith(
        expect.objectContaining({
          importMethod: 'git',
          gitUrl: 'https://github.com/test/repo.git',
          applyCompatibility: true,
          applyStructureFix: true
        })
      );
    });

    test('trims whitespace from inputs', async () => {
      mockImportProject.mockResolvedValue({ project: { id: 'trimmed' }, jobs: [] });
      const { user } = renderComponent();
      await goToGitConfigStep(user, { tab: 'local', name: '   Trim Project   ', path: '   C:/Trim   ' });

      await user.click(screen.getByRole('button', { name: 'Import Project' }));

      const lastCall = mockImportProject.mock.calls.at(-1)?.[0];
      expect(lastCall.name).toBe('Trim Project');
      expect(lastCall.localPath).toBe('C:/Trim');
    });

    test('shows loading state while import request is pending', async () => {
      let resolveImport;
      mockImportProject.mockImplementation(() => new Promise((resolve) => { resolveImport = resolve; }));
      const { user } = renderComponent();
      await goToGitConfigStep(user, { tab: 'local' });

      await user.click(screen.getByRole('button', { name: 'Import Project' }));

      const loadingButton = screen.getByRole('button', { name: 'Importing Project...' });
      expect(loadingButton).toBeDisabled();

      await act(async () => {
        resolveImport({ project: { id: 'async-import' }, jobs: [] });
      });

      await screen.findByRole('button', { name: 'Import Project' });
    });

    test('shows setup jobs when import returns background tasks', async () => {
      const jobs = [
        { id: 'job-1', displayName: 'Install deps', status: 'running' },
        { id: 'job-2', type: 'backend:install' }
      ];
      mockImportProject.mockResolvedValue({ project: { id: 'job-project' }, jobs });

      const fetchMock = vi.fn((url) => {
        if (typeof url === 'string' && url.startsWith('/api/projects/job-project/jobs')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ success: true, jobs })
          });
        }
        return mockFetch(url);
      });
      vi.stubGlobal('fetch', fetchMock);

      const { user } = renderComponent();
      await goToGitConfigStep(user, { tab: 'local', name: 'Job Project', path: 'C:/Projects/job' });

      await user.click(screen.getByRole('button', { name: 'Import Project' }));

      expect(await screen.findByText('Preparing your project')).toBeInTheDocument();
      expect(screen.getByText('Install deps')).toBeInTheDocument();
      expect(screen.getByText('backend:install')).toBeInTheDocument();
      expect(screen.getByText('pending')).toBeInTheDocument();
      expect(screen.getByText('Waiting for setup to finish…')).toBeInTheDocument();
    });

    test('skips setup waiting when project id is missing', async () => {
      const jobs = [{ id: 'job-1', displayName: 'Install deps', status: 'running' }];
      mockImportProject.mockResolvedValue({ project: null, jobs });

      const { user } = renderComponent();
      await goToGitConfigStep(user, { tab: 'local', name: 'Job Project', path: 'C:/Projects/job' });

      await user.click(screen.getByRole('button', { name: 'Import Project' }));

      expect(mockShowMain).toHaveBeenCalled();
      expect(screen.queryByText('Preparing your project')).toBeNull();
    });

    test('skips setup waiting when jobs payload is not an array', async () => {
      mockImportProject.mockResolvedValue({ project: { id: 'job-project' }, jobs: null });

      const { user } = renderComponent();
      await goToGitConfigStep(user, { tab: 'local', name: 'Job Project', path: 'C:/Projects/job' });

      await user.click(screen.getByRole('button', { name: 'Import Project' }));

      expect(mockShowMain).toHaveBeenCalled();
      expect(screen.queryByText('Preparing your project')).toBeNull();
    });

    test('shows default error message when import fails without details', async () => {
      const err = new Error('');
      err.message = '';
      mockImportProject.mockRejectedValue(err);

      const { user } = renderComponent();
      await goToGitConfigStep(user, { tab: 'local', name: 'Job Project', path: 'C:/Projects/job' });

      await user.click(screen.getByRole('button', { name: 'Import Project' }));

      expect(await screen.findByText('Failed to import project')).toBeInTheDocument();
    });
  });

  describe('Setup job polling', () => {
    test('keeps previous setupState when setStateForTests receives a falsy setupState', async () => {
      let testHooks;
      render(<ImportProject __testHooks={(hooks) => { testHooks = hooks; }} />);

      await waitFor(() => expect(testHooks).toBeTruthy());
      await act(async () => {
        testHooks.setStateForTests({
          setupState: {
            isWaiting: true,
            projectId: null,
            jobs: []
          }
        });
      });

      await waitFor(() => expect(screen.getByText('Preparing your project')).toBeInTheDocument());

      await act(async () => {
        testHooks.setStateForTests({ setupState: null });
      });

      await waitFor(() => expect(screen.getByText('Preparing your project')).toBeInTheDocument());
    });

    test('normalizes setup jobs to an empty array when setup state omits jobs', async () => {
      let testHooks;
      render(<ImportProject __testHooks={(hooks) => { testHooks = hooks; }} />);

      await waitFor(() => expect(testHooks).toBeTruthy());
      await act(async () => {
        testHooks.setStateForTests({
          setupState: {
            isWaiting: true,
            projectId: null,
            jobs: null
          }
        });
      });

      await waitFor(() => expect(screen.getByText('Preparing your project')).toBeInTheDocument());
      expect(screen.queryByText('Install deps')).toBeNull();
    });

    test('shows an error when polling setup jobs fails', async () => {
      const jobs = [{ id: 'job-1', displayName: 'Install deps', status: 'running' }];
      mockImportProject.mockResolvedValue({ project: { id: 'job-project' }, jobs });

      const fetchMock = vi.fn((url) => {
        if (typeof url === 'string' && url.startsWith('/api/projects/job-project/jobs')) {
          return Promise.resolve({
            ok: false,
            json: async () => ({ success: false, error: 'Jobs unavailable' })
          });
        }
        return mockFetch(url);
      });
      vi.stubGlobal('fetch', fetchMock);

      const { user } = renderComponent();
      await goToGitConfigStep(user, { tab: 'local', name: 'Job Project', path: 'C:/Projects/job' });
      await user.click(screen.getByRole('button', { name: 'Import Project' }));

      expect(await screen.findByText('Jobs unavailable')).toBeInTheDocument();
    });

    test('falls back to a default error message when polling has no error details', async () => {
      const jobs = [{ id: 'job-1', displayName: 'Install deps', status: 'running' }];
      mockImportProject.mockResolvedValue({ project: { id: 'job-project' }, jobs });

      const fetchMock = vi.fn((url) => {
        if (typeof url === 'string' && url.startsWith('/api/projects/job-project/jobs')) {
          return Promise.resolve({
            ok: false,
            json: async () => ({ success: false })
          });
        }
        return mockFetch(url);
      });
      vi.stubGlobal('fetch', fetchMock);

      const { user } = renderComponent();
      await goToGitConfigStep(user, { tab: 'local', name: 'Job Project', path: 'C:/Projects/job' });
      await user.click(screen.getByRole('button', { name: 'Import Project' }));

      expect(await screen.findByText('Failed to load setup jobs')).toBeInTheDocument();
    });

    test('falls back to a default error message when polling throws without a message', async () => {
      const jobs = [{ id: 'job-1', displayName: 'Install deps', status: 'running' }];
      mockImportProject.mockResolvedValue({ project: { id: 'job-project' }, jobs });

      const fetchMock = vi.fn((url) => {
        if (typeof url === 'string' && url.startsWith('/api/projects/job-project/jobs')) {
          return Promise.reject(null);
        }
        return mockFetch(url);
      });
      vi.stubGlobal('fetch', fetchMock);

      const { user } = renderComponent();
      await goToGitConfigStep(user, { tab: 'local', name: 'Job Project', path: 'C:/Projects/job' });
      await user.click(screen.getByRole('button', { name: 'Import Project' }));

      expect(await screen.findByText('Failed to load setup jobs')).toBeInTheDocument();
    });

    test('shows an error when polling returns success false', async () => {
      const jobs = [{ id: 'job-1', displayName: 'Install deps', status: 'running' }];
      mockImportProject.mockResolvedValue({ project: { id: 'job-project' }, jobs });

      const fetchMock = vi.fn((url) => {
        if (typeof url === 'string' && url.startsWith('/api/projects/job-project/jobs')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ success: false, error: 'Jobs failed' })
          });
        }
        return mockFetch(url);
      });
      vi.stubGlobal('fetch', fetchMock);

      const { user } = renderComponent();
      await goToGitConfigStep(user, { tab: 'local', name: 'Job Project', path: 'C:/Projects/job' });
      await user.click(screen.getByRole('button', { name: 'Import Project' }));

      expect(await screen.findByText('Jobs failed')).toBeInTheDocument();
    });

    test('normalizes polling jobs to an empty array when missing', async () => {
      const jobs = [{ id: 'job-1', displayName: 'Install deps', status: 'running' }];
      mockImportProject.mockResolvedValue({ project: { id: 'job-project' }, jobs });

      const fetchMock = vi.fn((url) => {
        if (typeof url === 'string' && url.startsWith('/api/projects/job-project/jobs')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ success: true, jobs: null })
          });
        }
        return mockFetch(url);
      });
      vi.stubGlobal('fetch', fetchMock);

      const { user } = renderComponent();
      await goToGitConfigStep(user, { tab: 'local', name: 'Job Project', path: 'C:/Projects/job' });
      await user.click(screen.getByRole('button', { name: 'Import Project' }));

      await waitFor(() => expect(screen.queryByText('Install deps')).toBeNull());
      expect(mockShowMain).not.toHaveBeenCalled();
    });

    test('completes setup when jobs are finished', async () => {
      const jobs = [{ id: 'job-1', displayName: 'Install deps', status: 'running' }];
      mockImportProject.mockResolvedValue({ project: { id: 'job-project' }, jobs });

      const fetchMock = vi.fn((url) => {
        if (typeof url === 'string' && url.startsWith('/api/projects/job-project/jobs')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ success: true, jobs: [{ id: 'job-1', status: 'succeeded' }] })
          });
        }
        return mockFetch(url);
      });
      vi.stubGlobal('fetch', fetchMock);

      const { user } = renderComponent();
      await goToGitConfigStep(user, { tab: 'local', name: 'Job Project', path: 'C:/Projects/job' });
      await user.click(screen.getByRole('button', { name: 'Import Project' }));

      await waitFor(() => expect(mockShowMain).toHaveBeenCalled());
    });

    test('ignores job updates after unmount', async () => {
      const jobs = [{ id: 'job-1', displayName: 'Install deps', status: 'running' }];
      mockImportProject.mockResolvedValue({ project: { id: 'job-project' }, jobs });

      let resolveJobs;
      const jobsPromise = new Promise((resolve) => { resolveJobs = resolve; });
      const fetchMock = vi.fn((url) => {
        if (typeof url === 'string' && url.startsWith('/api/projects/job-project/jobs')) {
          return jobsPromise;
        }
        return mockFetch(url);
      });
      vi.stubGlobal('fetch', fetchMock);

      const user = userEvent.setup();
      const renderResult = render(<ImportProject />);
      await goToGitConfigStep(user, { tab: 'local', name: 'Job Project', path: 'C:/Projects/job' });
      await user.click(screen.getByRole('button', { name: 'Import Project' }));

      renderResult.unmount();
      resolveJobs({
        ok: true,
        json: async () => ({ success: true, jobs: [{ id: 'job-1', status: 'running' }] })
      });

      await act(async () => { await Promise.resolve(); });
      expect(mockShowMain).not.toHaveBeenCalled();
    });
  });

  describe('Navigation', () => {
    test('cancel button resets and returns to main view', async () => {
      const { user } = renderComponent();
      await goToDetailsStep(user, { tab: 'local' });

      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(mockShowMain).toHaveBeenCalled();
    });

    test('back button returns to the previous step', async () => {
      const { user } = renderComponent();
      await goToDetailsStep(user, { tab: 'local' });

      expect(await screen.findByText('Step 3 of 6')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Back' }));
      expect(await screen.findByText('Step 2 of 6')).toBeInTheDocument();
    });

    test('back button triggers navigation', async () => {
      const { user } = renderComponent();
      await user.click(screen.getByRole('button', { name: /back to projects/i }));

      expect(mockShowMain).toHaveBeenCalled();
    });
  });

  describe('Accessibility', () => {
    test('form has proper labels and placeholders on relevant steps', async () => {
      const { user } = renderComponent();
      await goToSourceStep(user, 'local');

      expect(screen.getByRole('form')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Enter the path to your project folder')).toBeInTheDocument();

      await goToDetailsStep(user, { tab: 'local' });
      expect(screen.getByPlaceholderText('Enter project name')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Brief description of your project')).toBeInTheDocument();
    });
  });

  describe('Helper functions', () => {
    test('resolveFrontendFrameworks returns fallback when language unknown', () => {
      expect(resolveFrontendFrameworks('unknown')).toEqual(['none']);
    });

    test('resolveBackendFrameworks returns fallback when language unknown', () => {
      expect(resolveBackendFrameworks('unknown')).toEqual(['none']);
    });

    test('guessProjectName returns empty for non-string or empty inputs', () => {
      expect(guessProjectName()).toBe('');
      expect(guessProjectName(123)).toBe('');
      expect(guessProjectName('   ')).toBe('');
    });

    test('guessProjectName returns empty when cleaned value is empty', () => {
      expect(guessProjectName('?')).toBe('');
      expect(guessProjectName('#')).toBe('');
    });

    test('guessProjectName returns the last segment for normal paths', () => {
      expect(guessProjectName('C:/Projects/demo')).toBe('demo');
    });

    test('guessProjectName handles colon segments', () => {
      expect(guessProjectName('C:/Projects:Demo')).toBe('Demo');
      expect(guessProjectName('C:/Projects:')).toBe('');
    });
  });
});
