import React, { useEffect } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChatPanel from '../components/ChatPanel';
import Navigation from '../components/Navigation';
import SettingsModal from '../components/SettingsModal';
import TestTab from '../components/TestTab';
import useBranchTabState from '../components/branch-tab/useBranchTabState';
import { shouldSkipAutomationTests } from '../components/chatPanelCssOnly';
import { fetchProjectsFromBackend } from '../context/appState/projects';
import { useAppState } from '../context/AppStateContext';
import * as goalAutomationService from '../services/goalAutomationService';
import axios from 'axios';

vi.mock('../context/AppStateContext', () => ({
  useAppState: vi.fn()
}));

vi.mock('../utils/goalsApi', () => ({
  fetchGoals: vi.fn().mockResolvedValue([]),
  agentRequest: vi.fn().mockResolvedValue({ kind: 'question', answer: 'Test', steps: [] }),
  createGoal: vi.fn().mockResolvedValue({ goal: { id: 1, prompt: 'Fix failing tests' }, tasks: [] }),
  createMetaGoalWithChildren: vi.fn().mockResolvedValue({
    parent: { id: 10, prompt: 'Fix failing tests' },
    children: [{ id: 11, parentGoalId: 10, prompt: 'Fix failing frontend tests' }]
  }),
  agentAutopilot: vi.fn().mockResolvedValue({ session: { id: 'session-1', status: 'pending', events: [] } }),
  agentAutopilotStatus: vi.fn().mockResolvedValue({ session: { id: 'session-1', status: 'pending', events: [] } }),
  agentAutopilotMessage: vi.fn().mockResolvedValue({ session: { id: 'session-1', status: 'running', events: [] } }),
  agentAutopilotCancel: vi.fn().mockResolvedValue({ session: { id: 'session-1', status: 'cancelled', events: [] } }),
  agentAutopilotResume: vi.fn().mockResolvedValue({ success: true, resumed: [] }),
  readUiSessionId: vi.fn().mockReturnValue('ui-session')
}));

vi.mock('../services/goalAutomationService', () => ({
  handlePlanOnlyFeature: vi.fn(),
  handleRegularFeature: vi.fn(),
  processGoals: vi.fn().mockResolvedValue({ success: true, processed: 1 })
}));

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
    connect: vi.fn()
  }))
}));

vi.mock('../components/AutopilotTimeline.jsx', () => ({
  default: () => <div data-testid="autopilot-timeline" />
}));

vi.mock('../components/chatPanelCssOnly', () => ({
  shouldSkipAutomationTests: vi.fn().mockResolvedValue(false)
}));

vi.mock('axios', () => {
  const mock = {
    get: vi.fn(),
    post: vi.fn()
  };
  return {
    default: mock,
    ...mock
  };
});

const buildChatState = (overrides = {}) => ({
  currentProject: { id: 123, name: 'Test Project', backend: { exists: true } },
  stageAiChange: vi.fn(),
  jobState: { jobsByProject: {} },
  setPreviewPanelTab: vi.fn(),
  startAutomationJob: vi.fn(),
  markTestRunIntent: vi.fn(),
  requestEditorFocus: vi.fn(),
  syncBranchOverview: vi.fn(),
  workingBranches: {},
  projectProcesses: null,
  ...overrides
});

const buildNavState = (overrides = {}) => ({
  isLLMConfigured: true,
  currentProject: null,
  projects: [],
  canUseProjects: true,
  canUseTools: true,
  canUseSettings: true,
  theme: 'dark',
  selectProject: vi.fn(),
  closeProject: vi.fn(),
  showCreateProject: vi.fn(),
  showImportProject: vi.fn(),
  toggleTheme: vi.fn(),
  setPreviewPanelTab: vi.fn(),
  gitSettings: {
    workflow: 'local',
    provider: 'github',
    remoteUrl: '',
    username: '',
    token: '',
    defaultBranch: 'main'
  },
  gitConnectionStatus: { provider: '', account: null, message: '', testedAt: '' },
  updateGitSettings: vi.fn(),
  testGitConnection: vi.fn(),
  registerGitConnectionStatus: vi.fn(),
  portSettings: { frontendPortBase: 6100, backendPortBase: 6500 },
  updatePortSettings: vi.fn(),
  projectShutdownState: {
    isStopping: false,
    projectId: null,
    projectName: '',
    startedAt: null,
    error: null
  },
  ...overrides
});

const buildTestContext = (overrides = {}) => ({
  startAutomationJob: vi.fn().mockResolvedValue({}),
  cancelAutomationJob: vi.fn().mockResolvedValue({}),
  getJobsForProject: vi.fn().mockReturnValue([]),
  jobState: { isLoading: false, error: null, jobsByProject: {} },
  workspaceChanges: {},
  workingBranches: {},
  syncBranchOverview: vi.fn(),
  markTestRunIntent: vi.fn(),
  testRunIntent: { source: 'user', updatedAt: '2024-01-01T00:00:00.000Z' },
  projectProcesses: null,
  ...overrides
});

const HookHarness = ({ project, onState }) => {
  const state = useBranchTabState({
    project,
    onRequestTestsTab: vi.fn(),
    onRequestCommitsTab: vi.fn(),
    onRequestFileOpen: vi.fn(),
    getCommitMessageForBranch: vi.fn(),
    clearCommitMessageForBranch: vi.fn()
  });

  useEffect(() => {
    onState(state);
  }, [onState, state]);

  return null;
};

describe('coverage shard 0.4.9', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    axios.get.mockResolvedValue({ data: {} });
    axios.post.mockReset();
    shouldSkipAutomationTests.mockResolvedValue(false);
    ChatPanel.__testHooks = ChatPanel.__testHooks || {};
    ChatPanel.__testHooks.handlers = ChatPanel.__testHooks.handlers || {};
  });

  afterEach(() => {
    delete window.__lucidcoderAutofixHalted;
  });

  it('handles missing backend capability in ChatPanel', () => {
    useAppState.mockReturnValue(buildChatState({
      projectProcesses: { capabilities: { backend: { exists: false } } }
    }));

    render(<ChatPanel width={320} side="left" />);

    expect(screen.getByTestId('chat-input')).toBeInTheDocument();
  });

  it('handles null backend metadata in ChatPanel', () => {
    useAppState.mockReturnValue(buildChatState({
      currentProject: { id: 123, name: 'Test Project', backend: null }
    }));

    render(<ChatPanel width={320} side="left" />);

    expect(screen.getByTestId('chat-input')).toBeInTheDocument();
  });

  it('handles explicit backend exists flag in ChatPanel', () => {
    useAppState.mockReturnValue(buildChatState({
      currentProject: { id: 123, name: 'Test Project', backend: { exists: false } }
    }));

    render(<ChatPanel width={320} side="left" />);

    expect(screen.getByTestId('chat-input')).toBeInTheDocument();
  });

  it('shows create project view even if closeProject fails', async () => {
    const closeProject = vi.fn().mockRejectedValue(new Error('boom'));
    const showCreateProject = vi.fn();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    useAppState.mockReturnValue(buildNavState({
      currentProject: { id: 'proj-1', name: 'Test' },
      closeProject,
      showCreateProject
    }));

    const user = userEvent.setup();
    render(<Navigation />);

    await user.click(screen.getByRole('button', { name: /projects/i }));
    await user.click(screen.getByText('Add project'));

    await waitFor(() => {
      expect(showCreateProject).toHaveBeenCalledTimes(1);
    });

    consoleSpy.mockRestore();
  });

  it('starts automated tests when a feature execution succeeds', async () => {
    const startAutomationJob = vi.fn().mockResolvedValue({ success: true });
    goalAutomationService.handleRegularFeature.mockResolvedValue({ success: true });

    useAppState.mockReturnValue(buildChatState({
      startAutomationJob,
      projectProcesses: { capabilities: { backend: { exists: true } } }
    }));

    render(<ChatPanel width={320} side="left" />);

    await waitFor(() => {
      expect(ChatPanel.__testHooks?.handlers?.handleAgentResult).toBeInstanceOf(Function);
    });

    await act(async () => {
      await ChatPanel.__testHooks.handlers.handleAgentResult(
        { kind: 'feature', planOnly: false },
        { prompt: 'test', resolvedPrompt: 'test' }
      );
    });

    expect(startAutomationJob).toHaveBeenCalledWith('frontend:test', { projectId: 123 });
    expect(startAutomationJob).toHaveBeenCalledWith('backend:test', { projectId: 123 });
    expect(screen.getByText(/Starting frontend \+ backend test runs/i)).toBeInTheDocument();
  });

  it('starts frontend-only tests when backend is unavailable', async () => {
    const startAutomationJob = vi.fn().mockResolvedValue({ success: true });
    goalAutomationService.handleRegularFeature.mockResolvedValue({ success: true });

    useAppState.mockReturnValue(buildChatState({
      startAutomationJob,
      currentProject: { id: 123, name: 'Test Project', backend: null },
      projectProcesses: { capabilities: { backend: { exists: false } } }
    }));

    render(<ChatPanel width={320} side="left" />);

    await waitFor(() => {
      expect(ChatPanel.__testHooks?.handlers?.handleAgentResult).toBeInstanceOf(Function);
    });

    await act(async () => {
      await ChatPanel.__testHooks.handlers.handleAgentResult(
        { kind: 'feature', planOnly: false },
        { prompt: 'test', resolvedPrompt: 'test' }
      );
    });

    expect(startAutomationJob).toHaveBeenCalledWith('frontend:test', { projectId: 123 });
    expect(startAutomationJob).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Starting frontend tests/i)).toBeInTheDocument();
  });

  it('re-runs frontend-only tests when automation fixes complete', async () => {
    const startAutomationJob = vi.fn().mockResolvedValue({ success: true });
    goalAutomationService.processGoals.mockResolvedValue({ success: true });

    useAppState.mockReturnValue(buildChatState({
      startAutomationJob,
      currentProject: { id: 123, name: 'Test Project', backend: { exists: false } },
      projectProcesses: { capabilities: { backend: { exists: false } } }
    }));

    render(<ChatPanel width={320} side="left" />);

    await waitFor(() => {
      expect(ChatPanel.__testHooks?.handlers?.runAutomatedTestFixGoal).toBeInstanceOf(Function);
    });

    await act(async () => {
      await ChatPanel.__testHooks.handlers.runAutomatedTestFixGoal({
        prompt: 'Fix failing tests',
        childPrompts: []
      });
    });

    expect(startAutomationJob).toHaveBeenCalledWith('frontend:test', { projectId: 123 });
    expect(screen.getByText(/Re-running frontend tests/i)).toBeInTheDocument();
  });

  it('closes SettingsModal on backdrop click', () => {
    const onClose = vi.fn();

    render(
      <SettingsModal
        isOpen
        onClose={onClose}
        title="Configure"
        subtitle="Sub"
        testId="settings-modal"
        closeTestId="settings-close"
        titleId="settings-title"
      >
        <div>Body content</div>
      </SettingsModal>
    );

    fireEvent.click(screen.getByTestId('settings-modal'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('uses the provided close label in SettingsModal', () => {
    const onClose = vi.fn();

    render(
      <SettingsModal
        isOpen
        onClose={onClose}
        title="Configure"
        subtitle="Sub"
        testId="settings-modal"
        closeTestId="settings-close"
        titleId="settings-title"
        closeLabel="Close config"
      >
        <div>Body content</div>
      </SettingsModal>
    );

    expect(screen.getByTestId('settings-close')).toHaveAttribute('aria-label', 'Close config');
  });

  it('renders SettingsModal without optional header content', () => {
    const onClose = vi.fn();

    render(
      <SettingsModal
        isOpen
        onClose={onClose}
        title="Configure"
        testId="settings-modal"
        closeTestId="settings-close"
        titleId="settings-title"
      >
        <div>Body content</div>
      </SettingsModal>
    );

    expect(screen.queryByText('Sub')).toBeNull();
  });

  it('ignores SettingsModal body clicks', () => {
    const onClose = vi.fn();

    render(
      <SettingsModal
        isOpen
        onClose={onClose}
        title="Configure"
        subtitle="Sub"
        testId="settings-modal"
        closeTestId="settings-close"
        titleId="settings-title"
      >
        <div>Body content</div>
      </SettingsModal>
    );

    fireEvent.click(screen.getByText('Body content'));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('skips backend test runs when project has no backend', async () => {
    const startAutomationJob = vi.fn().mockResolvedValue({});

    useAppState.mockReturnValue(buildTestContext({
      startAutomationJob
    }));

    render(<TestTab project={{ id: 'proj-1', name: 'Demo', backend: null }} />);

    await waitFor(() => {
      expect(typeof TestTab.__testHooks?.handleRun).toBe('function');
    });

    await act(async () => {
      await TestTab.__testHooks.handleRun('backend:test');
    });

    expect(startAutomationJob).not.toHaveBeenCalled();
  });

  it('skips backend test runs when backend capability is disabled', async () => {
    const startAutomationJob = vi.fn().mockResolvedValue({});

    useAppState.mockReturnValue(buildTestContext({
      startAutomationJob,
      projectProcesses: { capabilities: { backend: { exists: false } } }
    }));

    render(<TestTab project={{ id: 'proj-2', name: 'Demo' }} />);

    await waitFor(() => {
      expect(typeof TestTab.__testHooks?.handleRun).toBe('function');
    });

    await act(async () => {
      await TestTab.__testHooks.handleRun('backend:test');
    });

    expect(startAutomationJob).not.toHaveBeenCalled();
  });

  it('hides backend tests when backend capability is disabled', () => {
    useAppState.mockReturnValue(buildTestContext({
      projectProcesses: { capabilities: { backend: { exists: false } } }
    }));

    render(<TestTab project={{ id: 'proj-3', name: 'Demo', backend: { exists: true } }} />);

    expect(screen.queryByTestId('test-card-backend:test')).toBeNull();
    expect(screen.getByTestId('test-card-frontend:test')).toBeInTheDocument();
  });

  it('honors explicit backend exists flag on the project', () => {
    useAppState.mockReturnValue(buildTestContext({
      projectProcesses: { capabilities: { backend: { exists: true } } }
    }));

    render(
      <TestTab
        project={{ id: 'proj-4', name: 'Demo', backend: { exists: false } }}
      />
    );

    expect(screen.queryByTestId('test-card-backend:test')).toBeNull();
    expect(screen.getByTestId('test-card-frontend:test')).toBeInTheDocument();
  });

  it('computes hasBackend as false when backend capability is disabled', async () => {
    vi.resetModules();
    const useAppStateMock = vi.fn(() => buildTestContext({
      projectProcesses: { capabilities: { backend: { exists: false } } }
    }));
    vi.doMock('../context/AppStateContext', () => ({
      useAppState: useAppStateMock
    }));

    const { default: FreshTestTab } = await import('../components/TestTab.jsx');

    render(<FreshTestTab project={{ id: 'proj-cap', name: 'Demo' }} />);

    expect(screen.queryByTestId('test-card-backend:test')).toBeNull();
  });

  it('shows frontend proof guidance when backend is disabled', async () => {
    axios.post.mockRejectedValueOnce({ message: 'Resolve failing tests' });
    const createdAt = new Date(Date.now() + 50).toISOString();
    const completedAt = new Date(Date.now() + 100).toISOString();
    const onRequestCommitsTab = vi.fn();

    const project = { id: 'proj-1', name: 'Demo', backend: null };

    const workingBranches = {
      [project.id]: {
        name: 'feature/front-only',
        stagedFiles: [{ path: 'src/App.jsx' }]
      }
    };

    const workspaceChanges = {
      [project.id]: {
        stagedFiles: [{ path: 'src/App.jsx' }]
      }
    };

    const projectProcesses = { capabilities: { backend: { exists: false } } };

    useAppState
      .mockReturnValueOnce(buildTestContext({
        workingBranches,
        workspaceChanges,
        projectProcesses,
        getJobsForProject: vi.fn().mockReturnValue([
          { type: 'frontend:test', status: 'running', logs: [], createdAt }
        ])
      }))
      .mockReturnValueOnce(buildTestContext({
        testRunIntent: { source: 'automation', updatedAt: completedAt },
        workingBranches,
        workspaceChanges,
        projectProcesses,
        getJobsForProject: vi.fn().mockReturnValue([
          { type: 'frontend:test', status: 'succeeded', logs: [], createdAt, completedAt }
        ])
      }));

    const view = render(
      <TestTab project={project} onRequestCommitsTab={onRequestCommitsTab} />
    );

    view.rerender(
      <TestTab project={project} onRequestCommitsTab={onRequestCommitsTab} />
    );

    await screen.findByTestId('modal-content');

    const user = userEvent.setup();
    await user.click(screen.getByTestId('modal-confirm'));

    await waitFor(() => {
      const modal = screen.getByTestId('modal-content');
      expect(within(modal).getByText('Tests required before commit')).toBeInTheDocument();
      expect(within(modal).getByText('Run frontend tests again before committing this branch so the server can record a passing proof.')).toBeInTheDocument();
    });
  });

  it('handles empty test suite lists safely', async () => {
    vi.resetModules();
    vi.doMock('../components/test-tab/helpers.jsx', async () => {
      const actual = await vi.importActual('../components/test-tab/helpers.jsx');
      return { ...actual, TEST_JOB_TYPES: [] };
    });
    vi.doMock('../context/AppStateContext', () => ({
      useAppState: vi.fn()
    }));

    const { useAppState: mockedUseAppState } = await import('../context/AppStateContext');
    const { default: FreshTestTab } = await import('../components/TestTab.jsx');

    mockedUseAppState.mockReturnValue(buildTestContext());

    render(<FreshTestTab project={{ id: 'proj-empty', name: 'Empty' }} />);

    expect(screen.queryByTestId(/test-card/)).toBeNull();
  });

  it('skips backend automation in branch tab when backend is null', async () => {
    const startAutomationJob = vi.fn().mockResolvedValue({});
    axios.get.mockResolvedValueOnce({ data: { isCssOnly: false } });

    useAppState.mockReturnValue({
      clearStagedChanges: vi.fn().mockResolvedValue({}),
      syncBranchOverview: vi.fn(),
      projectShutdownState: {},
      isProjectStopping: vi.fn(() => false),
      workspaceChanges: {},
      workingBranches: {},
      startAutomationJob,
      markTestRunIntent: vi.fn(),
      projectProcesses: null
    });

    render(
      <HookHarness
        project={{ id: 'proj-hook', name: 'Hook Project', backend: null }}
        onState={() => {}}
      />
    );

    await waitFor(() => {
      expect(useBranchTabState.__testHooks?.getLatestInstance?.()).toBeTruthy();
    });

    await act(async () => {
      const latestState = useBranchTabState.__testHooks.getLatestInstance();
      await latestState.triggerAutomationSuites('main');
    });

    expect(startAutomationJob).toHaveBeenCalledWith(
      'frontend:test',
      expect.objectContaining({ projectId: 'proj-hook', branchName: 'main' })
    );
    expect(startAutomationJob).toHaveBeenCalledTimes(1);
  });

  it('skips backend automation when backend exists flag is false', async () => {
    const startAutomationJob = vi.fn().mockResolvedValue({});
    axios.get.mockResolvedValueOnce({ data: { isCssOnly: false } });

    useAppState.mockReturnValue({
      clearStagedChanges: vi.fn().mockResolvedValue({}),
      syncBranchOverview: vi.fn(),
      projectShutdownState: {},
      isProjectStopping: vi.fn(() => false),
      workspaceChanges: {},
      workingBranches: {},
      startAutomationJob,
      markTestRunIntent: vi.fn(),
      projectProcesses: null
    });

    render(
      <HookHarness
        project={{ id: 'proj-hook-2', name: 'Hook Project', backend: { exists: false } }}
        onState={() => {}}
      />
    );

    await waitFor(() => {
      expect(useBranchTabState.__testHooks?.getLatestInstance?.()).toBeTruthy();
    });

    await act(async () => {
      const latestState = useBranchTabState.__testHooks.getLatestInstance();
      await latestState.triggerAutomationSuites('main');
    });

    expect(startAutomationJob).toHaveBeenCalledWith(
      'frontend:test',
      expect.objectContaining({ projectId: 'proj-hook-2', branchName: 'main' })
    );
    expect(startAutomationJob).toHaveBeenCalledTimes(1);
  });

  it('falls back to localStorage when projects payload parsing fails', async () => {
    const trackedFetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('boom');
      }
    }));

    const storage = {
      getItem: vi.fn().mockReturnValue('[{"id":"proj-local"}]')
    };
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });

    const setProjects = vi.fn();

    await fetchProjectsFromBackend({ trackedFetch, setProjects });

    expect(setProjects).toHaveBeenCalledWith([{ id: 'proj-local' }]);
  });

  it('keeps existing projects when backend returns empty list', async () => {
    const trackedFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, projects: [] })
    }));

    let projects = [{ id: 'proj-1', name: 'Saved' }];
    const setProjects = vi.fn((next) => {
      projects = typeof next === 'function' ? next(projects) : next;
    });

    await fetchProjectsFromBackend({ trackedFetch, setProjects });

    expect(projects).toEqual([{ id: 'proj-1', name: 'Saved' }]);
  });

  it('merges previous projects when backend returns updates', async () => {
    const trackedFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        projects: [{ id: 'proj-2', name: 'Next' }]
      })
    }));

    let projects = [{ id: 'proj-1', name: 'Saved' }];
    const setProjects = vi.fn((next) => {
      projects = typeof next === 'function' ? next(projects) : next;
    });

    await fetchProjectsFromBackend({ trackedFetch, setProjects });

    expect(projects).toEqual([
      { id: 'proj-1', name: 'Saved' },
      { id: 'proj-2', name: 'Next' }
    ]);
  });
});
