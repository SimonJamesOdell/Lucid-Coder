import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import BranchTab from '../components/BranchTab';
import { AppStateContext } from '../context/AppStateContext';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn()
  }
}));

const mockProject = { id: 'project-123', name: 'Demo Project' };
const baseOverview = {
  branches: [
    { name: 'main', status: 'protected', isCurrent: true, stagedFileCount: 1 },
    { name: 'feature-login', status: 'active', isCurrent: false, stagedFileCount: 2 }
  ],
  current: 'main',
  workingBranches: [
    {
      name: 'feature-login',
      description: 'Improve login experience',
      status: 'active',
      mergeBlockedReason: 'Tests must pass before merge',
      lastTestStatus: null,
      lastTestSummary: null,
      lastTestCompletedAt: null,
      stagedFiles: [
        { path: 'src/login.tsx', source: 'editor', timestamp: '2025-01-01T10:00:00.000Z' }
      ]
    }
  ]
};

const readyOverview = {
  branches: [
    { name: 'main', status: 'protected', isCurrent: true, stagedFileCount: 1 },
    { name: 'feature-login', status: 'ready-for-merge', isCurrent: false, stagedFileCount: 0 }
  ],
  current: 'main',
  workingBranches: [
    {
      name: 'feature-login',
      description: 'Improve login experience',
      status: 'ready-for-merge',
      mergeBlockedReason: null,
      lastTestStatus: 'passed',
      lastTestSummary: { total: 12, passed: 12, failed: 0, skipped: 0 },
      lastTestCompletedAt: '2025-01-03T12:00:00.000Z',
      stagedFiles: []
    }
  ]
};

const provenStagedOverview = {
  branches: [
    { name: 'main', status: 'protected', isCurrent: true, stagedFileCount: 1 },
    { name: 'feature-login', status: 'ready-for-merge', isCurrent: false, stagedFileCount: 2 }
  ],
  current: 'main',
  workingBranches: [
    {
      name: 'feature-login',
      description: 'Improve login experience',
      status: 'ready-for-merge',
      mergeBlockedReason: null,
      lastTestStatus: 'passed',
      lastTestSummary: { total: 12, passed: 12, failed: 0, skipped: 0 },
      lastTestCompletedAt: '2025-01-03T12:00:00.000Z',
      stagedFiles: baseOverview.workingBranches[0].stagedFiles
    }
  ]
};

const invalidatedOverview = {
  branches: [
    { name: 'main', status: 'protected', isCurrent: true, stagedFileCount: 0 },
    { name: 'feature-login', status: 'active', isCurrent: false, stagedFileCount: 1 }
  ],
  current: 'main',
  workingBranches: [
    {
      name: 'feature-login',
      status: 'active',
      lastTestStatus: 'passed',
      mergeBlockedReason: null,
      stagedFiles: [{ path: 'src/app.tsx', source: 'editor', timestamp: '2025-01-05T10:00:00.000Z' }]
    }
  ]
};

const passedWithStagedOverview = {
  branches: [
    { name: 'main', status: 'protected', isCurrent: true, stagedFileCount: 1 },
    { name: 'feature-login', status: 'active', isCurrent: false, stagedFileCount: 1 }
  ],
  current: 'main',
  workingBranches: [
    {
      name: 'feature-login',
      description: 'Improve login experience',
      status: 'active',
      mergeBlockedReason: 'Tests must pass before merge',
      lastTestStatus: 'passed',
      lastTestSummary: { total: 12, passed: 12, failed: 0, skipped: 0 },
      lastTestCompletedAt: '2025-01-03T12:00:00.000Z',
      stagedFiles: [
        { path: 'src/login.tsx', source: 'editor', timestamp: '2025-01-01T10:00:00.000Z' }
      ]
    }
  ]
};

const mockContext = (overrides = {}) => ({
  clearStagedChanges: vi.fn().mockResolvedValue({}),
  syncBranchOverview: vi.fn(),
  projectShutdownState: {},
  isProjectStopping: vi.fn(() => false),
  workspaceChanges: {},
  workingBranches: {},
  startAutomationJob: vi.fn().mockResolvedValue({ id: 'job-1' }),
  isLLMConfigured: false,
  ...overrides
});

const renderBranchTab = async ({ overview = baseOverview, contextOverrides = {}, props = {}, skipDefaultGetMock = false } = {}) => {
  if (!skipDefaultGetMock) {
    axios.get.mockResolvedValue({ data: { success: true, ...overview } });
  }

  let currentContextValue = mockContext(contextOverrides);
  let currentProps = { project: mockProject, ...props };

  const Wrapper = () => (
    <AppStateContext.Provider value={currentContextValue}>
      <BranchTab {...currentProps} />
    </AppStateContext.Provider>
  );

  const renderResult = render(<Wrapper />);

  await waitFor(() => expect(axios.get).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/branches`));

  // BranchTab renders branch list asynchronously after the overview fetch resolves.
  // Waiting for a stable element avoids races where tests click before the sidebar is ready.
  await screen.findByTestId('branch-list-item-main');

  const rerenderTree = () => {
    renderResult.rerender(<Wrapper />);
  };

  const updateContext = (overrides = {}) => {
    currentContextValue = { ...currentContextValue, ...overrides };
    rerenderTree();
    return currentContextValue;
  };

  const updateProps = (overrides = {}) => {
    currentProps = { ...currentProps, ...overrides };
    rerenderTree();
  };

  const reemitOverview = (newOverview) => {
    axios.get.mockResolvedValue({ data: { success: true, ...newOverview } });
    rerenderTree();
  };

  return {
    contextValue: currentContextValue,
    getContextValue: () => currentContextValue,
    updateContext,
    updateProps,
    reemitOverview
  };
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  axios.get.mockReset();
  axios.post.mockReset();
  axios.delete.mockReset();
});

describe('BranchTab', () => {
  test('starts tests via Begin testing CTA and stays on Tests when tests pass', async () => {
    const onRequestTestsTab = vi.fn();
    const onRequestCommitsTab = vi.fn();

    axios.get
      .mockResolvedValueOnce({ data: { success: true, ...baseOverview } })
      .mockResolvedValueOnce({ data: { success: true, ...readyOverview } })
      .mockResolvedValue({ data: { success: true, ...readyOverview } });
    axios.post.mockImplementation((url) => {
      if (url.endsWith('/tests')) {
        return Promise.resolve({ data: { success: true, testRun: { status: 'passed' } } });
      }
      return Promise.resolve({ data: { success: true } });
    });

    await renderBranchTab({ props: { onRequestTestsTab, onRequestCommitsTab }, skipDefaultGetMock: true });
    await userEvent.click(screen.getByTestId('branch-list-item-feature-login'));

    expect(screen.queryByTestId('branch-commit-input')).not.toBeInTheDocument();
    const beginButton = await screen.findByTestId('branch-begin-testing');
    await userEvent.click(beginButton);

    await waitFor(() => {
      expect(onRequestTestsTab).toHaveBeenCalled();
      expect(axios.post).toHaveBeenCalledWith(
        `/api/projects/${mockProject.id}/branches/feature-login/tests`
      );
    });

    expect(onRequestCommitsTab).not.toHaveBeenCalled();

    expect(screen.queryByTestId('branch-commit-subject')).not.toBeInTheDocument();
  });

  test('shows Skip testing CTA and hint when staged changes are CSS only', async () => {
    const onRequestCommitsTab = vi.fn();
    const cssOnlyOverview = {
      ...baseOverview,
      branches: [
        { name: 'main', status: 'protected', isCurrent: true, stagedFileCount: 1 },
        { name: 'feature-login', status: 'active', isCurrent: false, stagedFileCount: 1 }
      ],
      workingBranches: [
        {
          ...baseOverview.workingBranches[0],
          stagedFiles: [
            { path: 'src/components/BranchTab.css', source: 'editor', timestamp: '2025-01-01T10:00:00.000Z' }
          ]
        }
      ]
    };

    await renderBranchTab({ overview: cssOnlyOverview, props: { onRequestCommitsTab } });
    await userEvent.click(screen.getByTestId('branch-list-item-feature-login'));

    expect(await screen.findByTestId('branch-begin-testing')).toBeInTheDocument();
    expect(screen.getByTestId('branch-skip-testing')).toBeInTheDocument();
    expect(screen.getByText('(Branch is CSS only skip test available)')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('branch-skip-testing'));
    expect(onRequestCommitsTab).toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalledWith(
      `/api/projects/${mockProject.id}/branches/feature-login/merge`
    );
  });

  test('runs tests when Begin testing is clicked even if Skip testing is available (CSS-only branch)', async () => {
    const onRequestTestsTab = vi.fn();
    const onRequestCommitsTab = vi.fn();

    const cssOnlyOverview = {
      ...baseOverview,
      branches: [
        { name: 'main', status: 'protected', isCurrent: true, stagedFileCount: 1 },
        { name: 'feature-login', status: 'active', isCurrent: false, stagedFileCount: 1 }
      ],
      workingBranches: [
        {
          ...baseOverview.workingBranches[0],
          stagedFiles: [
            { path: 'src/components/BranchTab.css', source: 'editor', timestamp: '2025-01-01T10:00:00.000Z' }
          ]
        }
      ]
    };

    axios.get
      .mockResolvedValueOnce({ data: { success: true, ...cssOnlyOverview } })
      .mockResolvedValue({ data: { success: true, ...cssOnlyOverview } });
    axios.post.mockImplementation((url) => {
      if (url.endsWith('/tests')) {
        return Promise.resolve({ data: { success: true, testRun: { status: 'passed' } } });
      }
      return Promise.resolve({ data: { success: true } });
    });

    await renderBranchTab({ props: { onRequestTestsTab, onRequestCommitsTab }, skipDefaultGetMock: true });
    await userEvent.click(screen.getByTestId('branch-list-item-feature-login'));

    const beginButton = await screen.findByTestId('branch-begin-testing');
    await userEvent.click(beginButton);

    await waitFor(() => {
      expect(onRequestTestsTab).toHaveBeenCalled();
      expect(axios.post).toHaveBeenCalledWith(
        `/api/projects/${mockProject.id}/branches/feature-login/tests`
      );
    });

    expect(onRequestCommitsTab).not.toHaveBeenCalled();
  });

  test('hides Skip testing CTA and hint when staged changes include non-CSS files', async () => {
    await renderBranchTab({ overview: baseOverview });
    await userEvent.click(screen.getByTestId('branch-list-item-feature-login'));

    expect(await screen.findByTestId('branch-begin-testing')).toBeInTheDocument();
    expect(screen.queryByTestId('branch-skip-testing')).toBeNull();
    expect(screen.queryByText('(Branch is CSS only skip test available)')).toBeNull();
  });

  test('test & merge button hides when branch has no staged files', async () => {
    let latestBranchActions = null;
    const registerBranchActions = vi.fn((payload) => {
      latestBranchActions = payload;
      return () => {};
    });

    axios.get
      .mockResolvedValueOnce({ data: { success: true, ...readyOverview } })
      .mockResolvedValueOnce({ data: { success: true, ...readyOverview } })
      .mockResolvedValue({ data: { success: true, ...readyOverview } });
    await renderBranchTab({ skipDefaultGetMock: true, props: { registerBranchActions } });
    await userEvent.click(screen.getByTestId('branch-list-item-feature-login'));

    await waitFor(() => {
      expect(latestBranchActions?.testAndMerge).toBeFalsy();
      expect(latestBranchActions?.runTests).toBeFalsy();
      expect(latestBranchActions?.merge).toBeFalsy();
    });
  });

  test('disables Begin testing CTA when branch has no staged changes', async () => {
    await renderBranchTab({ overview: readyOverview });
    await userEvent.click(screen.getByTestId('branch-list-item-feature-login'));

    const beginButton = await screen.findByTestId('branch-begin-testing');
    expect(beginButton).toBeDisabled();
  });

  test('registers a create branch action for the toolbar', async () => {
    let latestBranchActions = null;
    const registerBranchActions = vi.fn((payload) => {
      latestBranchActions = payload;
      return () => {};
    });

    await renderBranchTab({ props: { registerBranchActions } });

    await waitFor(() => {
      expect(latestBranchActions?.createBranch).toBeTruthy();
    });

    expect(latestBranchActions.createBranch.label).toBe('New branch');
    expect(latestBranchActions.createBranch.disabled).toBe(false);
    expect(latestBranchActions.createBranch.variant).toBe('success');
  });

  test('create branch action opens modal and posts to API', async () => {
    let latestBranchActions = null;
    const registerBranchActions = vi.fn((payload) => {
      latestBranchActions = payload;
      return () => {};
    });

    axios.post.mockImplementation((url, body) => {
      if (url === `/api/projects/${mockProject.id}/branches`) {
        expect(body).toEqual({ name: 'feature-ai', description: 'Ship AI helper' });
        return Promise.resolve({
          data: {
            success: true,
            branch: { name: 'feature-ai' },
            overview: {
              ...baseOverview,
              current: 'feature-ai',
              branches: [
                ...baseOverview.branches,
                { name: 'feature-ai', status: 'active', isCurrent: true, stagedFileCount: 0 }
              ],
              workingBranches: [
                {
                  name: 'feature-ai',
                  description: 'Ship AI helper',
                  status: 'active',
                  stagedFiles: []
                }
              ]
            }
          }
        });
      }
      return Promise.resolve({ data: { success: true } });
    });

    await renderBranchTab({ props: { registerBranchActions } });

    await waitFor(() => expect(latestBranchActions?.createBranch).toBeTruthy());

    await latestBranchActions.createBranch.onClick();

    const modal = await screen.findByTestId('branch-create-modal');
    expect(modal).toBeInTheDocument();

    const nameInput = screen.getByTestId('branch-modal-name');
    const descriptionInput = screen.getByTestId('branch-modal-description');
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'feature ai');
    await userEvent.type(descriptionInput, 'Ship AI helper');

    await userEvent.click(screen.getByTestId('branch-modal-submit'));

    await waitFor(() => {
      expect(axios.post).toHaveBeenCalledWith(
        `/api/projects/${mockProject.id}/branches`,
        { name: 'feature-ai', description: 'Ship AI helper' }
      );
    });
  });

  test('merge action is never registered on the branches tab', async () => {
    let latestBranchActions = null;
    const registerBranchActions = vi.fn((payload) => {
      latestBranchActions = payload;
      return () => {};
    });

    await renderBranchTab({ overview: readyOverview, props: { registerBranchActions } });
    await userEvent.click(screen.getByTestId('branch-list-item-feature-login'));

    await waitFor(() => {
      expect(latestBranchActions?.merge).toBeFalsy();
      expect(latestBranchActions?.runTests).toBeFalsy();
      expect(latestBranchActions?.testAndMerge).toBeFalsy();
    });
  });

  test('merge action is not registered even if tests pass with no staged files', async () => {
    let latestBranchActions = null;
    const registerBranchActions = vi.fn((payload) => {
      latestBranchActions = payload;
      return () => {};
    });

    const overview = {
      branches: [
        { name: 'main', status: 'protected', isCurrent: true, stagedFileCount: 0 },
        { name: 'feature-login', status: 'active', isCurrent: false, stagedFileCount: 0 }
      ],
      current: 'main',
      workingBranches: [
        {
          name: 'feature-login',
          status: 'active',
          lastTestStatus: 'passed',
          mergeBlockedReason: null,
          stagedFiles: []
        }
      ]
    };

    await renderBranchTab({ overview, props: { registerBranchActions } });
    await userEvent.click(screen.getByTestId('branch-list-item-feature-login'));

    await waitFor(() => {
      expect(latestBranchActions?.merge).toBeFalsy();
    });
  });

  test('test & merge header action is not registered (Begin testing CTA replaces it)', async () => {
    let latestBranchActions = null;
    const registerBranchActions = vi.fn((payload) => {
      latestBranchActions = payload;
      return () => {};
    });

    await renderBranchTab({ props: { registerBranchActions } });
    await userEvent.click(screen.getByTestId('branch-list-item-feature-login'));

    await waitFor(() => {
      expect(latestBranchActions?.testAndMerge).toBeFalsy();
    });
  });

  test('merge action hides when staged files invalidate tests', async () => {
    let latestBranchActions = null;
    const registerBranchActions = vi.fn((payload) => {
      latestBranchActions = payload;
      return () => {};
    });

    await renderBranchTab({ overview: invalidatedOverview, props: { registerBranchActions } });
    await userEvent.click(screen.getByTestId('branch-list-item-feature-login'));

    await waitFor(() => {
      expect(latestBranchActions?.merge).toBeFalsy();
      expect(screen.getByTestId('branch-file-list')).toBeInTheDocument();
    });
  });

  test('external overview refresh never introduces a merge action on branches tab', async () => {
    let latestBranchActions = null;
    const registerBranchActions = vi.fn((payload) => {
      latestBranchActions = payload;
      return () => {};
    });

    // Initial invalidated state
    await renderBranchTab({ overview: invalidatedOverview, props: { registerBranchActions } });
    await userEvent.click(screen.getByTestId('branch-list-item-feature-login'));

    await waitFor(() => expect(latestBranchActions?.merge).toBeFalsy());

    // Re-render with ready overview to simulate fresh fetch
    cleanup();

    await renderBranchTab({ overview: readyOverview, props: { registerBranchActions } });
    await userEvent.click(screen.getByTestId('branch-list-item-feature-login'));

    await waitFor(() => {
      expect(latestBranchActions?.merge).toBeFalsy();
      expect(screen.queryByTestId('branch-warning')).toBeNull();
    });
  });

  test('renders branch list and selects current branch', async () => {
    await renderBranchTab();

    expect(screen.getByTestId('branch-list')).toBeInTheDocument();
    expect(screen.getByTestId('branch-list-item-main')).toHaveClass('selected');
    expect(screen.getByTestId('branch-main-info')).toBeInTheDocument();
    expect(screen.getByTestId('branch-main-message')).toBeInTheDocument();
    expect(screen.queryByTestId('branch-begin-testing-card')).toBeNull();
  });

  test('opens staged file via callback when file row is clicked', async () => {
    const onRequestFileOpen = vi.fn();
    await renderBranchTab({ props: { onRequestFileOpen } });
    await userEvent.click(screen.getByTestId('branch-list-item-feature-login'));

    const fileButton = await screen.findByTestId('branch-file-src-login-tsx');
    await userEvent.click(fileButton);
    expect(onRequestFileOpen).toHaveBeenCalledWith('src/login.tsx');
  });

  test('selecting a working branch exposes its staged files', async () => {
    await renderBranchTab();

    await userEvent.click(screen.getByTestId('branch-list-item-feature-login'));

    expect(screen.getByTestId('branch-list-item-feature-login')).toHaveClass('selected');
    expect(screen.getByTestId('branch-file-src-login-tsx')).toBeInTheDocument();
    expect(screen.getByTestId('branch-file-clear-src-login-tsx')).toBeEnabled();
    expect(screen.getByText('Clear all')).toBeInTheDocument();
  });

  test('clear staged buttons call workspace API', async () => {
    const clearStagedChanges = vi.fn().mockResolvedValue({ overview: baseOverview });

    await renderBranchTab({ contextOverrides: { clearStagedChanges } });
    await userEvent.click(screen.getByTestId('branch-list-item-feature-login'));

    await userEvent.click(await screen.findByTestId('clear-staged-inline'));

    await waitFor(() => {
      expect(clearStagedChanges).toHaveBeenCalledWith(mockProject.id, {
        branchName: 'feature-login'
      });
    });

    await userEvent.click(screen.getByTestId('branch-file-clear-src-login-tsx'));

    await waitFor(() => {
      expect(clearStagedChanges).toHaveBeenLastCalledWith(mockProject.id, {
        branchName: 'feature-login',
        filePath: 'src/login.tsx'
      });
    });
  });


  test('no status note is rendered for selected branch', async () => {
    const overview = {
      ...baseOverview,
      workingBranches: [
        {
          name: 'feature-login',
          description: 'Improve login experience',
          status: 'ready-for-merge',
          mergeBlockedReason: 'Resolve failing tests before merging',
          lastTestStatus: 'failed',
          lastTestSummary: { total: 5, passed: 4, failed: 1, skipped: 0 },
          lastTestCompletedAt: '2025-01-04T10:00:00.000Z',
          stagedFiles: [
            { path: 'src/login.tsx', source: 'editor', timestamp: '2025-01-01T10:00:00.000Z' }
          ]
        }
      ]
    };

    await renderBranchTab({ overview });
    await userEvent.click(screen.getByTestId('branch-list-item-feature-login'));

    expect(screen.queryByTestId('branch-status-note')).not.toBeInTheDocument();
  });

  test('run tests header action is not registered (Begin testing CTA replaces it)', async () => {
    let latestBranchActions = null;
    const registerBranchActions = vi.fn((payload) => {
      latestBranchActions = payload;
      return () => {};
    });

    await renderBranchTab({ props: { registerBranchActions } });
    await userEvent.click(screen.getByTestId('branch-list-item-feature-login'));

    await waitFor(() => {
      expect(registerBranchActions).toHaveBeenCalled();
      expect(latestBranchActions?.runTests).toBeFalsy();
    });
  });

  test('clear all button clears staged files for the selected branch', async () => {
    const clearStagedChanges = vi.fn().mockResolvedValue({});
    await renderBranchTab({ contextOverrides: { clearStagedChanges } });

    await userEvent.click(screen.getByTestId('branch-list-item-feature-login'));
    await userEvent.click(screen.getByTestId('clear-staged-inline'));

    expect(clearStagedChanges).toHaveBeenCalledWith(mockProject.id, {
      branchName: 'feature-login'
    });
  });

  test('per-file clear button reverts a single staged file', async () => {
    const clearStagedChanges = vi.fn().mockResolvedValue({});
    await renderBranchTab({ contextOverrides: { clearStagedChanges } });

    await userEvent.click(screen.getByTestId('branch-list-item-feature-login'));
    await userEvent.click(await screen.findByTestId('branch-file-clear-src-login-tsx'));

    expect(clearStagedChanges).toHaveBeenCalledWith(mockProject.id, {
      branchName: 'feature-login',
      filePath: 'src/login.tsx'
    });
  });

  test('ready-to-merge badge does not show until tests pass with no staged files', async () => {
    const overview = {
      branches: [
        { name: 'main', status: 'protected', isCurrent: true, stagedFileCount: 0 },
        { name: 'feature-login', status: 'ready-for-merge', isCurrent: false, stagedFileCount: 1 }
      ],
      current: 'main',
      workingBranches: [
        {
          name: 'feature-login',
          status: 'ready-for-merge',
          mergeBlockedReason: 'Tests must pass before merge',
          stagedFiles: [{ path: 'src/app.tsx', source: 'editor', timestamp: '2025-01-01T11:00:00.000Z' }]
        }
      ]
    };

    await renderBranchTab({ overview });
    await userEvent.click(screen.getByTestId('branch-list-item-feature-login'));

    const branchButton = screen.getByTestId('branch-list-item-feature-login');
    expect(branchButton).not.toHaveTextContent('Ready to Merge');
  });

  test('delete branch removes it and refreshes overview', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    axios.get.mockResolvedValue({ data: { success: true, ...baseOverview } });
    axios.delete.mockResolvedValue({ data: { success: true, overview: baseOverview } });

    await renderBranchTab();
    await userEvent.click(screen.getByTestId('branch-list-item-feature-login'));
    const deleteButton = await screen.findByTestId('branch-delete');
    await userEvent.click(deleteButton);

    await waitFor(() => {
      expect(axios.delete).toHaveBeenCalledWith(
        `/api/projects/${mockProject.id}/branches/feature-login`,
        expect.objectContaining({
          headers: expect.objectContaining({ 'x-confirm-destructive': 'true' })
        })
      );
    });
  });

  test('deleting the current branch checks out main', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const currentBranchOverview = {
      branches: [
        { name: 'main', status: 'protected', isCurrent: false, stagedFileCount: 0 },
        { name: 'feature-login', status: 'active', isCurrent: true, stagedFileCount: 2 }
      ],
      current: 'feature-login',
      workingBranches: [
        {
          name: 'feature-login',
          status: 'active',
          stagedFiles: [
            { path: 'frontend/src/App.jsx', source: 'editor', timestamp: '2025-01-02T12:00:00.000Z' }
          ]
        }
      ]
    };

    const postDeleteOverview = {
      branches: [
        { name: 'main', status: 'protected', isCurrent: true, stagedFileCount: 0 }
      ],
      current: 'main',
      workingBranches: []
    };

    axios.delete.mockResolvedValue({ data: { success: true, overview: postDeleteOverview } });
    axios.post.mockResolvedValue({ data: { success: true, overview: postDeleteOverview } });

  await renderBranchTab({ overview: currentBranchOverview });
    await userEvent.click(screen.getByTestId('branch-list-item-feature-login'));
  const deleteButton = await screen.findByTestId('branch-delete');
  await userEvent.click(deleteButton);

    await waitFor(() => {
      expect(axios.post).toHaveBeenCalledWith(
        `/api/projects/${mockProject.id}/branches/main/checkout`
      );
    });
  });

  test('merged branches are hidden from the branches list', async () => {
    const mergedOverview = {
      ...baseOverview,
      branches: [
        { name: 'main', status: 'protected', isCurrent: true, stagedFileCount: 1 },
        { name: 'feature-old', status: 'merged', isCurrent: false, stagedFileCount: 0 }
      ],
      workingBranches: []
    };

    await renderBranchTab({ overview: mergedOverview });

    expect(screen.getByTestId('branch-list-item-main')).toBeInTheDocument();
    expect(screen.queryByTestId('branch-list-item-feature-old')).toBeNull();
  });

  test('selecting a non-current branch does not show staged files from another branch', async () => {
    const overview = {
      ...baseOverview,
      branches: [
        { name: 'main', status: 'protected', isCurrent: false, stagedFileCount: 0 },
        { name: 'feature-login', status: 'active', isCurrent: true, stagedFileCount: 2 }
      ],
      current: 'feature-login'
    };

    await renderBranchTab({ overview });
    await userEvent.click(screen.getByTestId('branch-list-item-main'));

    expect(screen.getByTestId('branch-list-item-main')).toHaveClass('selected');
    expect(screen.getByTestId('branch-main-info')).toBeInTheDocument();
    expect(screen.queryByTestId('branch-file-src-login-tsx')).not.toBeInTheDocument();
    expect(screen.queryByTestId('branch-begin-testing-card')).toBeNull();
  });

  test('current branch uses local staged files fallback', async () => {
    const workspaceChanges = {
      [mockProject.id]: {
        stagedFiles: [
          { path: 'src/app.tsx', source: 'editor', timestamp: '2025-01-02T12:00:00.000Z' }
        ]
      }
    };
    const workingBranches = {
      [mockProject.id]: {
        name: 'main'
      }
    };

    await renderBranchTab({ contextOverrides: { workspaceChanges, workingBranches } });

    expect(screen.getByTestId('branch-list-item-main')).toHaveClass('selected');
    expect(screen.getByTestId('branch-main-info')).toBeInTheDocument();
    expect(screen.queryByTestId('branch-file-src-app-tsx')).toBeNull();
    expect(screen.queryByTestId('branch-begin-testing-card')).toBeNull();
  });

  test('local staged fallback only applies to tracked branch', async () => {
    const overview = {
      branches: [
        { name: 'main', status: 'protected', isCurrent: true, stagedFileCount: 0 },
        { name: 'feature-login', status: 'active', isCurrent: false, stagedFileCount: 0 }
      ],
      current: 'main',
      workingBranches: []
    };

    const workspaceChanges = {
      [mockProject.id]: {
        stagedFiles: [
          { path: 'frontend/src/App.jsx', source: 'editor', timestamp: '2025-01-02T12:00:00.000Z' }
        ]
      }
    };

    const workingBranches = {
      [mockProject.id]: {
        name: 'feature-login'
      }
    };

    await renderBranchTab({ overview, contextOverrides: { workspaceChanges, workingBranches } });

    // Current branch is main but fallback should not trigger because tracked branch is feature-login
    expect(screen.getByTestId('branch-list-item-main')).toHaveClass('selected');
    expect(screen.getByTestId('branch-main-info')).toBeInTheDocument();
    expect(screen.queryByTestId('branch-file-frontend-src-app-jsx')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('branch-list-item-feature-login'));

    expect(screen.getByTestId('branch-list-item-feature-login')).toHaveClass('selected');
    expect(screen.getByTestId('branch-file-frontend-src-app-jsx')).toBeInTheDocument();
  });

  test('overview refresh keeps local staged files when API omits them', async () => {
    const localStaged = [
      { path: 'src/login.tsx', source: 'editor', timestamp: '2025-01-06T15:00:00.000Z' }
    ];
    const syncBranchOverview = vi.fn();
    const workspaceChanges = {
      [mockProject.id]: {
        stagedFiles: localStaged
      }
    };
    const workingBranches = {
      [mockProject.id]: {
        name: 'feature-login'
      }
    };

    const overviewWithoutStaged = {
      ...baseOverview,
      workingBranches: [
        {
          ...baseOverview.workingBranches[0],
          stagedFiles: []
        }
      ]
    };

    await renderBranchTab({
      overview: overviewWithoutStaged,
      contextOverrides: { workspaceChanges, workingBranches, syncBranchOverview }
    });

    await userEvent.click(screen.getByTestId('branch-list-item-feature-login'));

    expect(screen.getByTestId('branch-file-src-login-tsx')).toBeInTheDocument();
    expect(syncBranchOverview).toHaveBeenCalled();
    const [, recordedOverview] = syncBranchOverview.mock.calls[0];
    expect(recordedOverview.workingBranches[0].stagedFiles).toEqual(localStaged);
  });

  test('clear all removes local-only staged files for tracked branch', async () => {
    const localStaged = [
      { path: 'notes/ai-request-1764680169744.md', source: 'ai', timestamp: '2025-01-06T15:00:00.000Z' }
    ];

    const workspaceChanges = {
      [mockProject.id]: {
        stagedFiles: localStaged
      }
    };
    const workingBranches = {
      [mockProject.id]: {
        name: 'feature-login'
      }
    };

    const { getContextValue } = await renderBranchTab({ contextOverrides: { workspaceChanges, workingBranches } });

    await userEvent.click(screen.getByTestId('branch-list-item-feature-login'));
    expect(screen.getByTestId('branch-file-notes-ai-request-1764680169744-md')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('clear-staged-inline'));

    await waitFor(() => {
      const ctx = getContextValue();
      // AppStateContext.clearStagedChanges should have been called with branchName only
      expect(ctx.clearStagedChanges).toHaveBeenCalledWith(mockProject.id, {
        branchName: 'feature-login'
      });
    });
  });

  test('re-opens last selected branch when returning to the tab', async () => {
    await renderBranchTab();
    await userEvent.click(screen.getByTestId('branch-list-item-feature-login'));

    expect(screen.getByTestId('branch-list-item-feature-login')).toHaveClass('selected');
    expect(localStorage.getItem('branchTab:selected:project-123')).toBe('feature-login');

    cleanup();
    axios.get.mockClear();
    axios.post.mockClear();
    axios.delete.mockClear();

    await renderBranchTab();

    await waitFor(() => {
      expect(screen.getByTestId('branch-list-item-feature-login')).toHaveClass('selected');
    });

    cleanup();
  });
});
