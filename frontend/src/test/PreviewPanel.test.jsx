import React, { forwardRef, useImperativeHandle, act } from 'react';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PreviewPanel from '../components/PreviewPanel';
import { useAppState } from '../context/AppStateContext';
import { startAgentUiBridge } from '../utils/agentUiBridge';

vi.mock('../context/AppStateContext', () => ({
  useAppState: vi.fn()
}));

vi.mock('../utils/agentUiBridge', () => ({
  startAgentUiBridge: vi.fn()
}));

const reloadPreviewMock = vi.fn();
const restartProjectMock = vi.fn();
const getPreviewUrlMock = vi.fn(() => 'http://localhost:5173');
const filesTabControls = {
  onFileSaved: null,
  registerSaveHandler: null
};
const testTabControls = {
  register: null
};

const createAppState = (overrides = {}) => ({
  currentProject: null,
  hasBranchNotification: false,
  workspaceChanges: {},
  requestEditorFocus: vi.fn(),
  projectProcesses: null,
  refreshProcessStatus: vi.fn(),
  restartProject: vi.fn(),
  reportBackendConnectivity: vi.fn(),
  editorFocusRequest: null,
  clearEditorFocusRequest: vi.fn(),
  ...overrides
});

vi.mock('../components/PreviewTab', () => ({
  __esModule: true,
  default: forwardRef((props, ref) => {
    useImperativeHandle(ref, () => ({
      reloadPreview: reloadPreviewMock,
      restartProject: restartProjectMock,
      getPreviewUrl: getPreviewUrlMock
    }));
    return <div data-testid="mock-preview-tab" />;
  })
}));

vi.mock('../components/GoalsTab', () => ({
  __esModule: true,
  default: () => <div data-testid="mock-goals-tab" />
}));

vi.mock('../components/FilesTab', () => ({
  __esModule: true,
  default: (props) => {
    filesTabControls.onFileSaved = props.onFileSaved;
    filesTabControls.registerSaveHandler = props.registerSaveHandler;
    return <div data-testid="mock-files-tab" />;
  }
}));

vi.mock('../components/TestTab', () => ({
  __esModule: true,
  default: (props) => {
    testTabControls.register = props.registerTestActions;
    return <div data-testid="mock-test-tab" />;
  }
}));

const branchTabPropsRef = { current: null };

vi.mock('../components/BranchTab', () => ({
  __esModule: true,
  default: (props) => {
    branchTabPropsRef.current = props;
    return <div data-testid="mock-branch-tab" />;
  }
}));

const commitsTabPropsRef = { current: null };

vi.mock('../components/CommitsTab', () => ({
  __esModule: true,
  default: (props) => {
    commitsTabPropsRef.current = props;
    return <div data-testid="mock-commits-tab" />;
  }
}));

vi.mock('../components/GitTab', () => ({
  __esModule: true,
  default: () => <div data-testid="mock-git-tab" />
}));

const processesTabPropsRef = { current: null };

vi.mock('../components/ProcessesTab', () => ({
  __esModule: true,
  default: (props) => {
    processesTabPropsRef.current = props;
    return <div data-testid="mock-processes-tab" />;
  }
}));

vi.mock('../components/PackageTab', () => ({
  __esModule: true,
  default: () => <div data-testid="mock-packages-tab" />
}));

vi.mock('../components/LLMUsageTab', () => ({
  __esModule: true,
  default: () => <div data-testid="mock-llm-usage-tab" />
}));

describe('PreviewPanel', () => {
  const originalWindowOpen = window.open;
  let latestBridgeOptions;
  const stopBridgeMock = vi.fn();

  const flushPromises = async (count = 10) => {
    for (let i = 0; i < count; i += 1) {
      await Promise.resolve();
    }
  };

  beforeEach(() => {
    vi.clearAllMocks();
    PreviewPanel.__testHooks = {};
    window.open = vi.fn();
    latestBridgeOptions = null;
    stopBridgeMock.mockClear();
    startAgentUiBridge.mockImplementation((options) => {
      latestBridgeOptions = options;
      return stopBridgeMock;
    });
    reloadPreviewMock.mockClear();
    restartProjectMock.mockClear();
    getPreviewUrlMock.mockClear();
    getPreviewUrlMock.mockReturnValue('http://localhost:5173');
    filesTabControls.onFileSaved = null;
    filesTabControls.registerSaveHandler = null;
    testTabControls.register = null;
    branchTabPropsRef.current = null;
  });

  test('agent UI bridge does not start when no project is selected', async () => {
    useAppState.mockReturnValue(createAppState({ currentProject: null }));

    await act(async () => {
      render(<PreviewPanel />);
      await flushPromises();
    });

    expect(startAgentUiBridge).not.toHaveBeenCalled();
  });

  test('agent UI bridge can provide snapshots and trigger preview reload', async () => {
    const reportBackendConnectivity = vi.fn();

    useAppState.mockReturnValue(
      createAppState({
        currentProject: { id: 10, name: 'Agent Bridge' },
        reportBackendConnectivity
      })
    );

    await act(async () => {
      render(<PreviewPanel />);
      await flushPromises();
    });

    expect(startAgentUiBridge).toHaveBeenCalledTimes(1);
    expect(latestBridgeOptions?.projectId).toBe(10);

    await act(async () => {
      latestBridgeOptions.onBackendStatusChange('online');
      await flushPromises();
    });

    await act(async () => {
      latestBridgeOptions.executeCommand({ type: 'PREVIEW_RELOAD' });
      await flushPromises();
    });

    expect(reloadPreviewMock).toHaveBeenCalledTimes(1);
    expect(reportBackendConnectivity).toHaveBeenCalledWith('online');

    const snapshot = latestBridgeOptions.getSnapshot();
    expect(snapshot).toEqual(
      expect.objectContaining({
        activeTab: 'preview',
        hasBranchNotification: false,
        availableBranchActions: [],
        availableTestActions: []
      })
    );
  });

  test('agent UI bridge reports backend offline when bridge signals offline', async () => {
    const reportBackendConnectivity = vi.fn();

    useAppState.mockReturnValue(
      createAppState({
        currentProject: { id: 11, name: 'Agent Offline' },
        reportBackendConnectivity
      })
    );

    await act(async () => {
      render(<PreviewPanel />);
      await flushPromises();
    });

    const error = new Error('offline');
    await act(async () => {
      latestBridgeOptions.onBackendStatusChange('offline', error);
      await flushPromises();
    });

    expect(reportBackendConnectivity).toHaveBeenCalledWith('offline', error);
  });

  test('agent UI bridge ignores backend status when reportBackendConnectivity is not a function', async () => {
    useAppState.mockReturnValue(
      createAppState({
        currentProject: { id: 12, name: 'No Connectivity Reporter' },
        reportBackendConnectivity: null
      })
    );

    await act(async () => {
      render(<PreviewPanel />);
      await flushPromises();
    });

    await act(async () => {
      latestBridgeOptions.onBackendStatusChange('online');
      latestBridgeOptions.onBackendStatusChange('offline', new Error('offline'));
      await flushPromises();
    });

    expect(startAgentUiBridge).toHaveBeenCalledTimes(1);
  });

  test('agent UI bridge snapshot filters test actions to functions only', async () => {
    useAppState.mockReturnValue(
      createAppState({ currentProject: { id: 15, name: 'Snapshot Filtering' } })
    );

    await act(async () => {
      render(<PreviewPanel />);
      await flushPromises();
    });

    await act(async () => {
      PreviewPanel.__testHooks.setActiveTab('test');
      await flushPromises();
    });

    await act(async () => {
      testTabControls.register({
        onRefresh: vi.fn(),
        refreshDisabled: false,
        cancelDisabled: true,
        isRefreshing: false,
        notAFunction: 123
      });
      await flushPromises();
    });

    const snapshot = latestBridgeOptions.getSnapshot();
    expect(snapshot).toEqual(
      expect.objectContaining({
        availableTestActions: expect.arrayContaining(['onRefresh'])
      })
    );
    expect(snapshot.availableTestActions).not.toContain('refreshDisabled');
    expect(snapshot.availableTestActions).not.toContain('notAFunction');
  });

  test('delegates tab selection to setPreviewPanelTab when provided', async () => {
    const setPreviewPanelTab = vi.fn();

    useAppState.mockReturnValue(
      createAppState({
        currentProject: { id: 99, name: 'Tabs' },
        setPreviewPanelTab
      })
    );

    const user = userEvent.setup();

    await act(async () => {
      render(<PreviewPanel />);
      await flushPromises();
    });

    // Clicking Goals should call setPreviewPanelTab and keep local tab unchanged.
    await act(async () => {
      await user.click(screen.getByTestId('goals-tab'));
      await flushPromises();
    });

    expect(setPreviewPanelTab).toHaveBeenCalledWith('goals', expect.objectContaining({ source: 'user' }));
    expect(screen.getByTestId('mock-preview-tab')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-goals-tab')).not.toBeInTheDocument();
  });

  test('ignores agent executeCommand when followAutomation is disabled by user selecting Goals', async () => {
    useAppState.mockReturnValue(
      createAppState({
        currentProject: { id: 101, name: 'Automation Off' },
        previewPanelState: null
      })
    );

    const user = userEvent.setup();

    await act(async () => {
      render(<PreviewPanel />);
      await flushPromises();
    });

    // User selects Goals tab -> followAutomation becomes false.
    await act(async () => {
      await user.click(screen.getByTestId('goals-tab'));
      await flushPromises();
    });

    expect(screen.getByTestId('mock-goals-tab')).toBeInTheDocument();

    // Agent tries to navigate away; should no-op because followAutomationRef.current is false.
    await act(async () => {
      latestBridgeOptions.executeCommand({ type: 'NAVIGATE_TAB', payload: { tab: 'files' } });
      await flushPromises();
    });

    expect(screen.getByTestId('mock-goals-tab')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-files-tab')).not.toBeInTheDocument();
  });

  test('agent UI bridge OPEN_FILE requests editor focus and switches to Files', async () => {
    const requestEditorFocus = vi.fn();

    useAppState.mockReturnValue(
      createAppState({ currentProject: { id: 11, name: 'Open File' }, requestEditorFocus })
    );

    await act(async () => {
      render(<PreviewPanel />);
      await flushPromises();
    });

    await act(async () => {
      latestBridgeOptions.executeCommand({
        type: 'OPEN_FILE',
        payload: { filePath: 'src/App.jsx' }
      });
      await flushPromises();
    });

    expect(requestEditorFocus).toHaveBeenCalledWith(11, 'src/App.jsx', { source: 'agent', highlight: 'editor' });
    expect(await screen.findByTestId('mock-files-tab')).toBeInTheDocument();
  });

  test('agent UI bridge OPEN_FILE focuses editor and switches to Files even when Goals tab is active', async () => {
    const requestEditorFocus = vi.fn();

    useAppState.mockReturnValue(
      createAppState({ currentProject: { id: 12, name: 'Open File from Goals' }, requestEditorFocus })
    );

    await act(async () => {
      render(<PreviewPanel />);
      await flushPromises();
    });

    await act(async () => {
      latestBridgeOptions.executeCommand({ type: 'NAVIGATE_TAB', payload: { tab: 'goals' } });
      await flushPromises();
    });

    expect(await screen.findByTestId('mock-goals-tab')).toBeInTheDocument();

    await act(async () => {
      latestBridgeOptions.executeCommand({ type: 'OPEN_FILE', payload: { filePath: 'src/App.jsx' } });
      await flushPromises();
    });

    expect(requestEditorFocus).toHaveBeenCalledWith(12, 'src/App.jsx', { source: 'agent', highlight: 'editor' });
    expect(await screen.findByTestId('mock-files-tab')).toBeInTheDocument();
  });

  test('agent UI bridge NAVIGATE_TAB switches tabs and ignores invalid tab payloads', async () => {
    useAppState.mockReturnValue(
      createAppState({ currentProject: { id: 13, name: 'Navigate Tab' } })
    );

    await act(async () => {
      render(<PreviewPanel />);
      await flushPromises();
    });

    await act(async () => {
      latestBridgeOptions.executeCommand({ type: 'NAVIGATE_TAB', payload: { tab: 'commits' } });
      await flushPromises();
    });
    expect(await screen.findByTestId('mock-commits-tab')).toBeInTheDocument();

    await act(async () => {
      latestBridgeOptions.executeCommand({ type: 'NAVIGATE_TAB', payload: { tab: 'tests' } });
      await flushPromises();
    });
    expect(await screen.findByTestId('mock-test-tab')).toBeInTheDocument();

    await act(async () => {
      latestBridgeOptions.executeCommand({ type: 'NAVIGATE_TAB', payload: { tab: 'branches' } });
      await flushPromises();
    });
    expect(await screen.findByTestId('mock-branch-tab')).toBeInTheDocument();

    await act(async () => {
      latestBridgeOptions.executeCommand({ type: 'NAVIGATE_TAB', payload: { tab: 123 } });
      await flushPromises();
    });
    expect(screen.getByTestId('mock-branch-tab')).toBeInTheDocument();

    await act(async () => {
      latestBridgeOptions.executeCommand({ type: 'NAVIGATE_TAB', payload: { tab: '   ' } });
      await flushPromises();
    });
    expect(screen.getByTestId('mock-branch-tab')).toBeInTheDocument();
  });

  test('agent UI bridge NAVIGATE_TAB files auto-focuses latest staged file when available', async () => {
    const requestEditorFocus = vi.fn();

    useAppState.mockReturnValue(
      createAppState({
        currentProject: { id: 131, name: 'Navigate Files Focus' },
        requestEditorFocus,
        workspaceChanges: {
          131: {
            stagedFiles: [
              { path: 'src/Old.jsx' },
              { path: 'src/New.jsx' }
            ]
          }
        }
      })
    );

    await act(async () => {
      render(<PreviewPanel />);
      await flushPromises();
    });

    await act(async () => {
      latestBridgeOptions.executeCommand({ type: 'NAVIGATE_TAB', payload: { tab: 'files' } });
      await flushPromises();
    });

    expect(requestEditorFocus).toHaveBeenCalledWith(131, 'src/New.jsx', { source: 'agent', highlight: 'editor' });
    expect(await screen.findByTestId('mock-files-tab')).toBeInTheDocument();
  });

  test('test hook focusLatestStagedFile uses diff highlight for commits source', async () => {
    const requestEditorFocus = vi.fn();

    useAppState.mockReturnValue(
      createAppState({
        currentProject: { id: 231, name: 'Hook Focus Diff' },
        requestEditorFocus,
        workspaceChanges: {
          231: {
            stagedFiles: [{ path: 'src/FocusedFromCommits.jsx' }]
          }
        }
      })
    );

    await act(async () => {
      render(<PreviewPanel />);
      await flushPromises();
    });

    await act(async () => {
      PreviewPanel.__testHooks.focusLatestStagedFile?.({ source: 'commits' });
      await flushPromises();
    });

    expect(requestEditorFocus).toHaveBeenCalledWith(231, 'src/FocusedFromCommits.jsx', {
      source: 'commits',
      highlight: 'diff'
    });
  });

  test('agent UI bridge NAVIGATE_TAB files does not re-focus the same latest staged file twice', async () => {
    const requestEditorFocus = vi.fn();

    useAppState.mockReturnValue(
      createAppState({
        currentProject: { id: 171, name: 'Navigate Files Dedup Focus' },
        requestEditorFocus,
        workspaceChanges: {
          171: {
            stagedFiles: [{ path: 'src/Dupe.jsx' }]
          }
        }
      })
    );

    await act(async () => {
      render(<PreviewPanel />);
      await flushPromises();
    });

    await act(async () => {
      latestBridgeOptions.executeCommand({ type: 'NAVIGATE_TAB', payload: { tab: 'files' } });
      await flushPromises();
    });

    await act(async () => {
      latestBridgeOptions.executeCommand({ type: 'NAVIGATE_TAB', payload: { tab: 'files' } });
      await flushPromises();
    });

    expect(await screen.findByTestId('mock-files-tab')).toBeInTheDocument();
    expect(requestEditorFocus).toHaveBeenCalledTimes(1);
    expect(requestEditorFocus).toHaveBeenCalledWith(171, 'src/Dupe.jsx', { source: 'agent', highlight: 'editor' });
  });

  test('agent UI bridge NAVIGATE_TAB files does not focus when there are no staged files', async () => {
    const requestEditorFocus = vi.fn();

    useAppState.mockReturnValue(
      createAppState({
        currentProject: { id: 141, name: 'Navigate Files No Staged' },
        requestEditorFocus,
        workspaceChanges: {
          141: {
            stagedFiles: []
          }
        }
      })
    );

    await act(async () => {
      render(<PreviewPanel />);
      await flushPromises();
    });

    await act(async () => {
      latestBridgeOptions.executeCommand({ type: 'NAVIGATE_TAB', payload: { tab: 'files' } });
      await flushPromises();
    });

    expect(await screen.findByTestId('mock-files-tab')).toBeInTheDocument();
    expect(requestEditorFocus).not.toHaveBeenCalled();
  });

  test('agent UI bridge NAVIGATE_TAB files does not focus when latest staged entry has no string path', async () => {
    const requestEditorFocus = vi.fn();

    useAppState.mockReturnValue(
      createAppState({
        currentProject: { id: 151, name: 'Navigate Files Bad Path' },
        requestEditorFocus,
        workspaceChanges: {
          151: {
            stagedFiles: [{ path: 'src/Ok.jsx' }, { path: null }]
          }
        }
      })
    );

    await act(async () => {
      render(<PreviewPanel />);
      await flushPromises();
    });

    await act(async () => {
      latestBridgeOptions.executeCommand({ type: 'NAVIGATE_TAB', payload: { tab: 'files' } });
      await flushPromises();
    });

    expect(await screen.findByTestId('mock-files-tab')).toBeInTheDocument();
    expect(requestEditorFocus).not.toHaveBeenCalled();
  });

  test('agent UI bridge NAVIGATE_TAB files covers focusLatestStagedFile early return when projectId becomes unavailable', async () => {
    const requestEditorFocus = vi.fn();

    let shouldReturnNullId = false;
    const currentProject = { name: 'Mutable Id Project' };
    Object.defineProperty(currentProject, 'id', {
      configurable: true,
      enumerable: true,
      get() {
        return shouldReturnNullId ? null : 710;
      }
    });

    useAppState.mockReturnValue(
      createAppState({
        currentProject,
        requestEditorFocus,
        workspaceChanges: {
          710: {
            stagedFiles: [{ path: 'src/WouldHaveFocused.jsx' }]
          }
        }
      })
    );

    await act(async () => {
      render(<PreviewPanel />);
      await flushPromises();
    });

    // Simulate project id being cleared after mount without re-rendering.
    shouldReturnNullId = true;

    await act(async () => {
      latestBridgeOptions.executeCommand({ type: 'NAVIGATE_TAB', payload: { tab: 'files' } });
      await flushPromises();
    });

    expect(await screen.findByTestId('mock-files-tab')).toBeInTheDocument();
    expect(requestEditorFocus).not.toHaveBeenCalled();
  });

  test('NAVIGATE_TAB files covers focusLatestStagedFile early return when requestEditorFocus is not a function', async () => {
    useAppState.mockReturnValue(
      createAppState({
        currentProject: { id: 610, name: 'No Editor Focus Handler' },
        requestEditorFocus: null,
        workspaceChanges: {
          610: {
            stagedFiles: [{ path: 'src/NeverFocused.jsx' }]
          }
        }
      })
    );

    await act(async () => {
      render(<PreviewPanel />);
      await flushPromises();
    });

    await act(async () => {
      latestBridgeOptions.executeCommand({ type: 'NAVIGATE_TAB', payload: { tab: 'files' } });
      await flushPromises();
    });

    expect(await screen.findByTestId('mock-files-tab')).toBeInTheDocument();
  });

  test('auto-focuses latest staged file when already on Files tab and automation is enabled', async () => {
    const requestEditorFocus = vi.fn();

    useAppState.mockReturnValue(
      createAppState({
        currentProject: { id: 202, name: 'Files Auto Focus Effect' },
        requestEditorFocus,
        previewPanelState: { activeTab: 'files', followAutomation: true },
        workspaceChanges: {
          202: {
            stagedFiles: [{ path: 'src/Before.jsx' }, { path: 'src/After.jsx' }]
          }
        }
      })
    );

    await act(async () => {
      render(<PreviewPanel />);
      await flushPromises();
    });

    expect(await screen.findByTestId('mock-files-tab')).toBeInTheDocument();
    expect(requestEditorFocus).toHaveBeenCalledWith(202, 'src/After.jsx', { source: 'automation', highlight: 'editor' });
  });

  test('does not auto-focus latest staged file when on Files tab but automation is disabled', async () => {
    const requestEditorFocus = vi.fn();

    useAppState.mockReturnValue(
      createAppState({
        currentProject: { id: 212, name: 'Files Auto Focus Disabled' },
        requestEditorFocus,
        previewPanelState: { activeTab: 'files', followAutomation: false },
        workspaceChanges: {
          212: {
            stagedFiles: [{ path: 'src/NeverFocused.jsx' }]
          }
        }
      })
    );

    await act(async () => {
      render(<PreviewPanel />);
      await flushPromises();
    });

    expect(await screen.findByTestId('mock-files-tab')).toBeInTheDocument();
    expect(requestEditorFocus).not.toHaveBeenCalled();
  });

  test('respects previewPanelState.followAutomation=false by ignoring agent commands', async () => {
    const requestEditorFocus = vi.fn();

    useAppState.mockReturnValue(
      createAppState({
        currentProject: { id: 303, name: 'Automation Locked Off' },
        requestEditorFocus,
        previewPanelState: { activeTab: 'preview', followAutomation: false },
        workspaceChanges: {
          303: {
            stagedFiles: [{ path: 'src/WouldHaveFocused.jsx' }]
          }
        }
      })
    );

    await act(async () => {
      render(<PreviewPanel />);
      await flushPromises();
    });

    expect(startAgentUiBridge).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('mock-preview-tab')).toBeInTheDocument();

    await act(async () => {
      latestBridgeOptions.executeCommand({ type: 'NAVIGATE_TAB', payload: { tab: 'files' } });
      await flushPromises();
    });

    expect(screen.getByTestId('mock-preview-tab')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-files-tab')).not.toBeInTheDocument();
    expect(requestEditorFocus).not.toHaveBeenCalled();
  });

  test('agent UI bridge can execute TEST_ACTION callbacks once registered', async () => {
    const actionSpy = vi.fn();

    useAppState.mockReturnValue(
      createAppState({ currentProject: { id: 14, name: 'Test Actions' } })
    );

    const { unmount } = render(<PreviewPanel />);

    const user = userEvent.setup();
    await user.click(screen.getByTestId('test-tab'));
    expect(await screen.findByTestId('mock-test-tab')).toBeInTheDocument();

    await act(async () => {
      testTabControls.register({
        onRefresh: actionSpy,
        refreshDisabled: false,
        cancelDisabled: true,
        isRefreshing: false
      });
    });

    await act(async () => {
      latestBridgeOptions.executeCommand({ type: 'TEST_ACTION', payload: { action: 'onRefresh' } });
      latestBridgeOptions.executeCommand({ type: 'TEST_ACTION', payload: { action: 42 } });
      await flushPromises();
    });

    expect(actionSpy).toHaveBeenCalledTimes(1);

    unmount();
  });

  test('does not render the test refresh timestamp meta (timestamp removed)', async () => {
    useAppState.mockReturnValue(
      createAppState({ currentProject: { id: 15, name: 'Test Refresh Meta' } })
    );

    const user = userEvent.setup();
    render(<PreviewPanel />);

    await user.click(screen.getByTestId('test-tab'));
    expect(await screen.findByTestId('mock-test-tab')).toBeInTheDocument();

    await act(async () => {
      testTabControls.register({
        onRefresh: vi.fn(),
        refreshDisabled: false,
        cancelDisabled: false,
        isRefreshing: false,
        lastFetchedAt: 1700000000000
      });
    });

    expect(screen.queryByTestId('test-refresh-meta')).toBeNull();
  });

  test('agent UI bridge can execute branch toolbar actions once registered', async () => {
    const actionSpy = vi.fn();

    useAppState.mockReturnValue(
      createAppState({ currentProject: { id: 12, name: 'Branch Actions' } })
    );

    const { unmount } = render(<PreviewPanel />);

    const user = userEvent.setup();
    await user.click(screen.getByTestId('branch-tab'));
    expect(await screen.findByTestId('mock-branch-tab')).toBeInTheDocument();

    await act(async () => {
      branchTabPropsRef.current.registerBranchActions({
        merge: { onClick: actionSpy }
      });
    });

    await act(async () => {
      latestBridgeOptions.executeCommand({
        type: 'BRANCH_TOOLBAR_ACTION',
        payload: { action: 'merge' }
      });
      latestBridgeOptions.executeCommand({
        type: 'BRANCH_TOOLBAR_ACTION',
        payload: { action: 42 }
      });
      await flushPromises();
    });

    expect(actionSpy).toHaveBeenCalledTimes(1);

    unmount();
  });

  test('agent UI bridge snapshots include available actions after registration', async () => {
    const baseState = createAppState({ currentProject: { id: 21, name: 'Snapshot Actions' } });
    useAppState.mockReturnValue(baseState);

    const { rerender } = render(<PreviewPanel />);

    const user = userEvent.setup();
    await user.click(screen.getByTestId('test-tab'));
    expect(await screen.findByTestId('mock-test-tab')).toBeInTheDocument();

    await act(async () => {
      testTabControls.register({
        onRefresh: vi.fn(),
        refreshDisabled: false,
        cancelDisabled: true,
        isRefreshing: false
      });
      await flushPromises();
    });

    await user.click(screen.getByTestId('branch-tab'));
    expect(await screen.findByTestId('mock-branch-tab')).toBeInTheDocument();

    await act(async () => {
      branchTabPropsRef.current.registerBranchActions({
        merge: { onClick: vi.fn() }
      });
      await flushPromises();
    });

    // Force the bridge effect to restart so getSnapshot runs after refs are populated.
    useAppState.mockReturnValue({ ...baseState, hasBranchNotification: true });
    await act(async () => {
      rerender(<PreviewPanel />);
      await flushPromises();
    });

    const snapshot = latestBridgeOptions.getSnapshot();
    expect(snapshot.hasBranchNotification).toBe(true);
    expect(snapshot.availableBranchActions).toContain('merge');
    expect(snapshot.availableTestActions).toContain('onRefresh');
    expect(snapshot.availableTestActions).not.toContain('refreshDisabled');
  });

  test('preview panel skips wiring test hooks when helpers are unavailable', () => {
    PreviewPanel.__testHooks = null;
    useAppState.mockReturnValue(
      createAppState({ currentProject: { id: 901, name: 'Test Hooks Optional' } })
    );

    expect(() => render(<PreviewPanel />)).not.toThrow();
    expect(PreviewPanel.__testHooks).toBeNull();
  });
  afterEach(() => {
    window.open = originalWindowOpen;
    vi.useRealTimers();
  });

  test('opens preview in new tab when button is clicked', async () => {
    useAppState.mockReturnValue(
      createAppState({ currentProject: { id: 1, name: 'Test Project' } })
    );

    const user = userEvent.setup();
    render(<PreviewPanel />);

    const button = screen.getByTestId('open-preview-tab');
    expect(button).toBeEnabled();

    await user.click(button);

    expect(window.open).toHaveBeenCalledWith('http://localhost:5173', '_blank', 'noopener,noreferrer');
  });

  test('does not open a new tab when preview URL is blank', async () => {
    getPreviewUrlMock.mockReturnValue('about:blank');
    useAppState.mockReturnValue(
      createAppState({ currentProject: { id: 2, name: 'No Preview' } })
    );

    const user = userEvent.setup();
    render(<PreviewPanel />);

    const button = screen.getByTestId('open-preview-tab');
    expect(button).toBeEnabled();

    await user.click(button);

    expect(window.open).not.toHaveBeenCalled();
  });

  test('shows git tab content when selected', async () => {
    useAppState.mockReturnValue(
      createAppState({ currentProject: { id: 9, name: 'Git Project' } })
    );

    const user = userEvent.setup();
    render(<PreviewPanel />);

    const gitTab = screen.getByTestId('git-tab');
    await user.click(gitTab);

    expect(screen.getByTestId('mock-git-tab')).toBeInTheDocument();
  });

  test('shows commits tab content when selected', async () => {
    useAppState.mockReturnValue(
      createAppState({ currentProject: { id: 11, name: 'History Project' } })
    );

    const user = userEvent.setup();
    render(<PreviewPanel />);

    await user.click(screen.getByTestId('commits-tab'));

    expect(screen.getByTestId('mock-commits-tab')).toBeInTheDocument();
  });

  test('selecting the commits tab requests a commit message autofill', async () => {
    useAppState.mockReturnValue(
      createAppState({ currentProject: { id: 21, name: 'Autofill Project' } })
    );

    const user = userEvent.setup();
    render(<PreviewPanel />);

    await user.click(screen.getByTestId('commits-tab'));

    expect(await screen.findByTestId('mock-commits-tab')).toBeInTheDocument();
    await waitFor(() => {
      expect(commitsTabPropsRef.current.autofillRequestId).toBe(1);
    });
  });

  test('automation navigation to the commits tab also requests a commit message autofill', async () => {
    useAppState.mockReturnValue(
      createAppState({ currentProject: { id: 22, name: 'Automation Autofill' } })
    );

    await act(async () => {
      render(<PreviewPanel />);
      await flushPromises();
    });

    await act(async () => {
      latestBridgeOptions.executeCommand({ type: 'NAVIGATE_TAB', payload: { tab: 'commits' } });
      await flushPromises();
    });

    expect(await screen.findByTestId('mock-commits-tab')).toBeInTheDocument();
    await waitFor(() => {
      expect(commitsTabPropsRef.current.autofillRequestId).toBe(1);
    });
  });

  test('changing projects while the commits tab is active requests another commit autofill', async () => {
    const appState = createAppState({ currentProject: { id: 23, name: 'Autofill Switch' } });
    useAppState.mockImplementation(() => appState);

    const user = userEvent.setup();
    const { rerender } = render(<PreviewPanel />);

    await user.click(screen.getByTestId('commits-tab'));

    await waitFor(() => {
      expect(commitsTabPropsRef.current.autofillRequestId).toBe(1);
    });

    appState.currentProject = { id: 24, name: 'Autofill Switch Next' };

    await act(async () => {
      rerender(<PreviewPanel />);
      await flushPromises();
    });

    await waitFor(() => {
      expect(commitsTabPropsRef.current.autofillRequestId).toBe(2);
    });
  });

  test('BranchTab can request navigation to Commits tab', async () => {
    useAppState.mockReturnValue(createAppState({
      currentProject: { id: 'proj-1', name: 'Demo' }
    }));

    await act(async () => {
      render(<PreviewPanel />);
    });

    const user = userEvent.setup();
    await user.click(screen.getByTestId('branch-tab'));
    expect(screen.getByTestId('mock-branch-tab')).toBeInTheDocument();

    await act(async () => {
      branchTabPropsRef.current.onRequestCommitsTab();
      branchTabPropsRef.current.onRequestCommitsTab();
    });

    expect(await screen.findByTestId('mock-commits-tab')).toBeInTheDocument();

    await act(async () => {
      commitsTabPropsRef.current.onConsumeAutofillRequest();
    });
  });

  test('shows packages tab with package manager controls', async () => {
    useAppState.mockReturnValue(
      createAppState({ currentProject: { id: 17, name: 'Packages Project' } })
    );

    const user = userEvent.setup();
    render(<PreviewPanel />);

    await user.click(screen.getByTestId('packages-tab'));

    expect(screen.getByTestId('mock-packages-tab')).toBeInTheDocument();
  });

  test('can render LLM usage tab content when selected programmatically', async () => {
    useAppState.mockReturnValue(
      createAppState({ currentProject: { id: 18, name: 'Usage Project' } })
    );

    await act(async () => {
      render(<PreviewPanel />);
      await flushPromises();
    });

    await act(async () => {
      PreviewPanel.__testHooks.setActiveTab?.('llm-usage');
      await flushPromises();
    });

    expect(await screen.findByTestId('mock-llm-usage-tab')).toBeInTheDocument();
  });

  test('shows files save button in header when files tab is active', async () => {
    useAppState.mockReturnValue(
      createAppState({ currentProject: { id: 9, name: 'Project' } })
    );

    const user = userEvent.setup();
    render(<PreviewPanel />);

    await user.click(screen.getByTestId('files-tab'));

    expect(screen.getByTestId('files-save-button')).toBeDisabled();
  });

  test('files tab save controls register handlers and clean up', async () => {
    useAppState.mockReturnValue(
      createAppState({ currentProject: { id: 19, name: 'Saver' } })
    );

    const user = userEvent.setup();
    render(<PreviewPanel />);

    await user.click(screen.getByTestId('files-tab'));

    const saveButton = screen.getByTestId('files-save-button');
    expect(saveButton).toBeDisabled();

    const handleSave = vi.fn();
    let cleanup;
    act(() => {
      cleanup = filesTabControls.registerSaveHandler?.({ handleSave, isDisabled: false });
    });

    expect(saveButton).toBeEnabled();
    await user.click(saveButton);
    expect(handleSave).toHaveBeenCalledTimes(1);

    act(() => cleanup?.());
    expect(saveButton).toBeDisabled();
  });

  test('files save handler resets when registration receives a null payload', async () => {
    useAppState.mockReturnValue(
      createAppState({ currentProject: { id: 29, name: 'Saver Reset' } })
    );

    const user = userEvent.setup();
    render(<PreviewPanel />);

    await user.click(screen.getByTestId('files-tab'));
    const saveButton = screen.getByTestId('files-save-button');

    act(() => {
      filesTabControls.registerSaveHandler?.({ handleSave: vi.fn(), isDisabled: false });
    });
    expect(saveButton).toBeEnabled();

    act(() => {
      filesTabControls.registerSaveHandler?.(null);
    });

    expect(saveButton).toBeDisabled();
  });

  test('reloads preview after saving a file once preview tab is reopened', async () => {
    useAppState.mockReturnValue(
      createAppState({ currentProject: { id: 'preview-project', name: 'Project' } })
    );

    const user = userEvent.setup();
    render(<PreviewPanel />);

    await user.click(screen.getByTestId('files-tab'));
    expect(screen.getByTestId('mock-files-tab')).toBeInTheDocument();
    expect(typeof filesTabControls.onFileSaved).toBe('function');

    filesTabControls.onFileSaved?.('src/App.jsx');
    expect(reloadPreviewMock).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('preview-tab'));
    expect(reloadPreviewMock).toHaveBeenCalledTimes(1);
  });

  test('reloads preview immediately when a file saves while preview is active', async () => {
    useAppState.mockReturnValue(
      createAppState({ currentProject: { id: 'immediate-preview', name: 'Project' } })
    );

    const user = userEvent.setup();
    render(<PreviewPanel />);

    await user.click(screen.getByTestId('files-tab'));
    const onFileSaved = filesTabControls.onFileSaved;
    expect(typeof onFileSaved).toBe('function');

    await user.click(screen.getByTestId('preview-tab'));
    reloadPreviewMock.mockClear();

    act(() => {
      onFileSaved?.('src/App.jsx');
    });

    expect(reloadPreviewMock).toHaveBeenCalledTimes(1);
  });

  test('routes branch file open requests to the editor', async () => {
    const requestEditorFocus = vi.fn();
    useAppState.mockReturnValue(
      createAppState({ currentProject: { id: 77, name: 'Branch Project' }, requestEditorFocus })
    );

    const user = userEvent.setup();
    render(<PreviewPanel />);

    await user.click(screen.getByTestId('branch-tab'));

    expect(typeof branchTabPropsRef.current?.onRequestFileOpen).toBe('function');
    branchTabPropsRef.current.onRequestFileOpen('src/App.jsx');

    expect(requestEditorFocus).toHaveBeenCalledWith(77, 'src/App.jsx', { source: 'branches' });
    await waitFor(() => expect(screen.getByTestId('mock-files-tab')).toBeInTheDocument());
  });

  test('ignores branch file open requests that lack a file path', async () => {
    const requestEditorFocus = vi.fn();
    useAppState.mockReturnValue(
      createAppState({ currentProject: { id: 78, name: 'Branch Guard' }, requestEditorFocus })
    );

    const user = userEvent.setup();
    render(<PreviewPanel />);

    await user.click(screen.getByTestId('branch-tab'));

    expect(typeof branchTabPropsRef.current?.onRequestFileOpen).toBe('function');
    branchTabPropsRef.current.onRequestFileOpen('');
    branchTabPropsRef.current.onRequestFileOpen(null);

    expect(requestEditorFocus).not.toHaveBeenCalled();
  });

  test('handleReload ignores requests while preview tab is inactive', async () => {
    useAppState.mockReturnValue(
      createAppState({ currentProject: { id: 501, name: 'Reload Guard' } })
    );

    const user = userEvent.setup();
    render(<PreviewPanel />);

    await user.click(screen.getByTestId('files-tab'));
    await waitFor(() => expect(screen.getByTestId('mock-files-tab')).toBeInTheDocument());

    reloadPreviewMock.mockClear();

    act(() => {
      PreviewPanel.__testHooks.handleReload?.();
    });

    expect(reloadPreviewMock).not.toHaveBeenCalled();
  });

  test('handleReload refreshes the preview when active tab is preview', () => {
    useAppState.mockReturnValue(
      createAppState({ currentProject: { id: 502, name: 'Reload Active' } })
    );

    render(<PreviewPanel />);
    reloadPreviewMock.mockClear();

    act(() => {
      PreviewPanel.__testHooks.handleReload?.();
    });

    expect(reloadPreviewMock).toHaveBeenCalledTimes(1);
  });

  test('displays a branch notification indicator when pending branch work exists', () => {
    useAppState.mockReturnValue(
      createAppState({ currentProject: { id: 41, name: 'Branch Signals' }, hasBranchNotification: true })
    );

    render(<PreviewPanel />);

    expect(screen.getByTestId('branch-spot-indicator')).toBeInTheDocument();
  });

  test('switches to files tab when editor focus request targets current project', async () => {
    const appState = createAppState({ currentProject: { id: 88, name: 'Focus Project' } });
    useAppState.mockReturnValue(appState);

    const user = userEvent.setup();
    const { rerender } = render(<PreviewPanel />);

    await user.click(screen.getByTestId('commits-tab'));
    expect(screen.getByTestId('mock-commits-tab')).toBeInTheDocument();

    appState.editorFocusRequest = {
      projectId: 88,
      filePath: 'src/main.tsx',
      source: 'commits'
    };

    rerender(<PreviewPanel />);

    await waitFor(() => {
      expect(screen.getByTestId('mock-files-tab')).toBeInTheDocument();
    });
  });

  test('passes process snapshots to ProcessesTab and wires refresh controls', async () => {
    const refreshProcessStatus = vi.fn();
    const restartProject = vi.fn();
    const projectProcesses = {
      projectId: 55,
      isRunning: false,
      processes: { frontend: { status: 'stopped' }, backend: null },
      ports: { active: { frontend: 5173, backend: null } }
    };

    useAppState.mockReturnValue(createAppState({
      currentProject: { id: 55, name: 'Process Project' },
      refreshProcessStatus,
      restartProject,
      projectProcesses
    }));

    const user = userEvent.setup();
    render(<PreviewPanel />);

    await user.click(screen.getByTestId('processes-tab'));

    expect(screen.getByTestId('mock-processes-tab')).toBeInTheDocument();
    expect(processesTabPropsRef.current?.processInfo).toBe(projectProcesses);

    processesTabPropsRef.current?.onRefreshStatus?.(55);
    expect(refreshProcessStatus).toHaveBeenCalledWith(55);

    processesTabPropsRef.current?.onRestartProject?.(55);
    expect(restartProject).toHaveBeenCalledWith(55);
  });

  test('registers test tab actions so header controls call through to handlers', async () => {
    useAppState.mockReturnValue(createAppState({ currentProject: { id: 101, name: 'Test Actions' } }));

    const user = userEvent.setup();
    render(<PreviewPanel />);

    await user.click(screen.getByTestId('test-tab'));
    expect(screen.getByTestId('mock-test-tab')).toBeInTheDocument();
    expect(typeof testTabControls.register).toBe('function');

    const onRefresh = vi.fn();
    const onCancel = vi.fn();

    act(() => {
      testTabControls.register?.({
        onRefresh,
        onCancelActiveRuns: onCancel,
        refreshDisabled: false,
        cancelDisabled: true,
        isRefreshing: true
      });
    });

    const refreshButton = screen.getByTestId('test-refresh-button');
    expect(refreshButton).toHaveTextContent('Refreshing…');
    expect(refreshButton).toBeEnabled();
    await user.click(refreshButton);
    expect(onRefresh).toHaveBeenCalled();

    const cancelButton = screen.getByTestId('test-cancel-button');
    expect(cancelButton).toBeDisabled();

    act(() => {
      testTabControls.register?.({
        onRefresh,
        onCancelActiveRuns: onCancel,
        refreshDisabled: true,
        cancelDisabled: false,
        isRefreshing: false
      });
    });

    expect(screen.getByTestId('test-refresh-button')).toBeDisabled();
    const enabledCancelButton = screen.getByTestId('test-cancel-button');
    expect(enabledCancelButton).toBeEnabled();
    await user.click(enabledCancelButton);
    expect(onCancel).toHaveBeenCalled();
  });

  test('test tab actions clear out when registration passes null', async () => {
    useAppState.mockReturnValue(createAppState({ currentProject: { id: 102, name: 'Test Reset' } }));

    const user = userEvent.setup();
    render(<PreviewPanel />);

    await user.click(screen.getByTestId('test-tab'));
    expect(typeof testTabControls.register).toBe('function');

    act(() => {
      testTabControls.register?.({
        onRefresh: vi.fn(),
        onCancelActiveRuns: vi.fn(),
        refreshDisabled: false,
        cancelDisabled: false,
        isRefreshing: false
      });
    });

    const refreshButton = screen.getByTestId('test-refresh-button');
    expect(refreshButton).toBeEnabled();

    act(() => {
      testTabControls.register?.(null);
    });

    expect(screen.getByTestId('test-refresh-button')).toBeDisabled();
    expect(screen.getByTestId('test-cancel-button')).toBeDisabled();
  });

  test('branch action registrations render header buttons and toggle tabs', async () => {
    useAppState.mockReturnValue(
      createAppState({ currentProject: { id: 131, name: 'Branch Actions' } })
    );

    const user = userEvent.setup();
    render(<PreviewPanel />);

    await user.click(screen.getByTestId('branch-tab'));

    const createBranch = vi.fn();
    const deleteBranch = vi.fn();
    let cleanup;

    act(() => {
      cleanup = branchTabPropsRef.current?.registerBranchActions?.({
        createBranch: { label: 'Create', onClick: createBranch, testId: 'branch-create', variant: 'success' },
        deleteBranch: { label: 'Delete', onClick: deleteBranch, disabled: true }
      });
    });

    const createButton = screen.getByTestId('branch-create');
    expect(createButton).toBeEnabled();
    await user.click(createButton);
    expect(createBranch).toHaveBeenCalledTimes(1);

    const deleteButton = screen.getByTestId('branch-delete');
    expect(deleteButton).toBeDisabled();

    act(() => cleanup?.());
    expect(screen.queryByTestId('branch-create')).toBeNull();

    branchTabPropsRef.current?.onRequestTestsTab?.();
    await waitFor(() => expect(screen.getByTestId('mock-test-tab')).toBeInTheDocument());
  });

  test('branch action registration clears buttons when payload is null', async () => {
    useAppState.mockReturnValue(
      createAppState({ currentProject: { id: 132, name: 'Branch Clear' } })
    );

    const user = userEvent.setup();
    render(<PreviewPanel />);

    await user.click(screen.getByTestId('branch-tab'));

    const createBranch = vi.fn();
    act(() => {
      branchTabPropsRef.current?.registerBranchActions?.({
        createBranch: { label: 'Create', onClick: createBranch, testId: 'branch-create' }
      });
    });

    expect(screen.getByTestId('branch-create')).toBeInTheDocument();

    act(() => {
      branchTabPropsRef.current?.registerBranchActions?.(null);
    });

    expect(screen.queryByTestId('branch-create')).toBeNull();
  });

  test('falls back to the preview tab for any unknown tab keys', async () => {
    useAppState.mockReturnValue(createAppState({ currentProject: { id: 12, name: 'Fallback' } }));

    render(<PreviewPanel />);

    await waitFor(() => {
      expect(typeof PreviewPanel.__testHooks.setActiveTab).toBe('function');
    });

    act(() => {
      PreviewPanel.__testHooks.setActiveTab?.('unknown-tab');
    });

    expect(screen.getByTestId('mock-preview-tab')).toBeInTheDocument();
  });

  test('reload handler ignores requests when preview tab is hidden', async () => {
    useAppState.mockReturnValue(createAppState({ currentProject: { id: 201, name: 'Reload Guard' } }));

    render(<PreviewPanel />);

    await waitFor(() => {
      expect(typeof PreviewPanel.__testHooks.setActiveTab).toBe('function');
      expect(typeof PreviewPanel.__testHooks.handleReload).toBe('function');
    });

    act(() => {
      PreviewPanel.__testHooks.setActiveTab?.('files');
    });

    await waitFor(() => expect(screen.getByTestId('mock-files-tab')).toBeInTheDocument());

    reloadPreviewMock.mockClear();
    act(() => {
      PreviewPanel.__testHooks.handleReload?.();
    });

    expect(reloadPreviewMock).not.toHaveBeenCalled();
  });

  test('setActiveTab falls back to unknown source when options.source is not a string', async () => {
    useAppState.mockReturnValue(createAppState({ currentProject: { id: 203, name: 'Source Fallback' } }));

    render(<PreviewPanel />);

    await waitFor(() => {
      expect(typeof PreviewPanel.__testHooks.setActiveTab).toBe('function');
    });

    act(() => {
      PreviewPanel.__testHooks.setActiveTab?.('files', { source: null });
    });

    await waitFor(() => expect(screen.getByTestId('mock-files-tab')).toBeInTheDocument());
  });

  test('open-in-new-tab handler no-ops when preview is inactive', async () => {
    useAppState.mockReturnValue(createAppState({ currentProject: { id: 202, name: 'Open Guard' } }));

    render(<PreviewPanel />);

    await waitFor(() => {
      expect(typeof PreviewPanel.__testHooks.setActiveTab).toBe('function');
      expect(typeof PreviewPanel.__testHooks.handleOpenInNewTab).toBe('function');
    });

    act(() => {
      PreviewPanel.__testHooks.setActiveTab?.('files');
    });

    await waitFor(() => expect(screen.getByTestId('mock-files-tab')).toBeInTheDocument());

    window.open.mockClear();
    act(() => {
      PreviewPanel.__testHooks.handleOpenInNewTab?.();
    });

    expect(window.open).not.toHaveBeenCalled();
  });

});
