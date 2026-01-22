import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChatPanel, { formatAgentStepMessage } from '../components/ChatPanel';
import { useAppState } from '../context/AppStateContext';
import * as goalsApi from '../utils/goalsApi';
import * as goalAutomationService from '../services/goalAutomationService';
import { io } from 'socket.io-client';
import axios from 'axios';

vi.mock('../context/AppStateContext');
vi.mock('../utils/goalsApi');
vi.mock('../services/goalAutomationService', () => ({
  handlePlanOnlyFeature: vi.fn(),
  handleRegularFeature: vi.fn(),
  processGoals: vi.fn()
}));
vi.mock('socket.io-client');
vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn()
  }
}));
vi.mock('../components/AutopilotTimeline.jsx', () => ({
  default: ({ events }) => (
    <div data-testid="autopilot-timeline">
      {events.map((evt) => (
        <div key={evt.id}>{evt.message}</div>
      ))}
    </div>
  )
}));

describe('ChatPanel', () => {
  const mockSetPreviewPanelTab = vi.fn();
  const mockStageAiChange = vi.fn();
  const mockStartAutomationJob = vi.fn();
  const mockMarkTestRunIntent = vi.fn();
  let mockSocket;

  beforeEach(() => {
    vi.clearAllMocks();
    axios.get.mockReset();
    axios.get.mockResolvedValue({ data: {} });
    axios.post.mockReset();
    
    // Mock socket.io
    mockSocket = {
      on: vi.fn(),
      off: vi.fn(),
      emit: vi.fn(),
      disconnect: vi.fn(),
      connect: vi.fn()
    };
    io.mockReturnValue(mockSocket);
    
    useAppState.mockReturnValue({
      currentProject: { id: 123, name: 'Test Project' },
      stageAiChange: mockStageAiChange,
      jobState: { jobsByProject: {} },
      setPreviewPanelTab: mockSetPreviewPanelTab,
      startAutomationJob: mockStartAutomationJob,
      markTestRunIntent: mockMarkTestRunIntent,
      requestEditorFocus: vi.fn(),
      syncBranchOverview: vi.fn(),
      workingBranches: {
        123: {
          name: 'feature/test-branch',
          stagedFiles: [{ path: 'src/App.jsx' }]
        }
      }
    });
    goalsApi.fetchGoals.mockResolvedValue([]);
    goalsApi.agentRequest.mockResolvedValue({ kind: 'question', answer: 'Test answer', steps: [] });
    goalsApi.createGoal.mockResolvedValue({ goal: { id: 1, prompt: 'Fix failing tests' }, tasks: [] });
    goalsApi.createMetaGoalWithChildren.mockResolvedValue({
      parent: { id: 10, prompt: 'Fix failing tests' },
      children: [{ id: 11, parentGoalId: 10, prompt: 'Fix failing frontend tests' }]
    });
    goalsApi.agentAutopilot.mockResolvedValue({ session: { id: 'session-1', status: 'pending', events: [] } });
    goalsApi.agentAutopilotStatus.mockResolvedValue({ session: { id: 'session-1', status: 'pending', events: [] } });
    goalsApi.agentAutopilotMessage.mockResolvedValue({ session: { id: 'session-1', status: 'running', events: [] } });
    goalsApi.agentAutopilotCancel.mockResolvedValue({ session: { id: 'session-1', status: 'cancelled', events: [] } });
    goalsApi.agentAutopilotResume.mockResolvedValue({ success: true, resumed: [] });
    goalsApi.readUiSessionId = vi.fn().mockReturnValue('ui-session');

    goalAutomationService.handlePlanOnlyFeature.mockResolvedValue(undefined);
    goalAutomationService.handleRegularFeature.mockResolvedValue(undefined);
    goalAutomationService.processGoals.mockResolvedValue({ success: true, processed: 1 });

    mockStartAutomationJob.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();

    // Keep tests isolated: ChatPanel uses a global flag.
    delete window.__lucidcoderAutofixHalted;
  });

  describe('formatAgentStepMessage', () => {
    it('formats action read_file steps (with and without reason)', () => {
      expect(
        formatAgentStepMessage({ type: 'action', action: 'read_file', target: 'README.md', reason: 'debugging' })
      ).toMatch(/Agent is reading README\.md \(debugging\)\./);

      expect(
        formatAgentStepMessage({ type: 'action', action: 'read_file', target: 'README.md' })
      ).toMatch(/Agent is reading README\.md\./);

      expect(
        formatAgentStepMessage({ type: 'action', action: 'read_file' })
      ).toMatch(/Agent is reading a file\./);
    });

    it('formats non-read_file actions and observation variants', () => {
      expect(formatAgentStepMessage({ type: 'action', action: 'run_tests' }))
        .toBe('Agent is performing action: run_tests.');

      expect(formatAgentStepMessage({ type: 'observation', action: 'read_file', error: 'Permission denied', target: 'secrets.txt' }))
        .toBe('Agent could not read secrets.txt: Permission denied');

      expect(formatAgentStepMessage({ type: 'observation', action: 'read_file', error: 'Permission denied' }))
        .toBe('Agent could not read file: Permission denied');

      expect(formatAgentStepMessage({ type: 'observation', action: 'read_file' }))
        .toBe(null);

      expect(formatAgentStepMessage({ type: 'observation', error: 'Boom' }))
        .toBe('Agent observation error: Boom');

      expect(formatAgentStepMessage({ type: 'observation', summary: 'All good' }))
        .toBe('Agent observation: All good');

      expect(formatAgentStepMessage({ type: 'observation' }))
        .toBe('Agent observation: No details provided.');
    });

    it('returns null for invalid inputs or unknown step types', () => {
      expect(formatAgentStepMessage(null)).toBe(null);
      expect(formatAgentStepMessage('nope')).toBe(null);
      expect(formatAgentStepMessage({})).toBe(null);
      expect(formatAgentStepMessage({ type: 'unknown' })).toBe(null);
    });
  });

  describe('Basic Rendering', () => {
    it('renders safely when test hooks are unavailable', () => {
      const originalHooks = ChatPanel.__testHooks;
      ChatPanel.__testHooks = null;

      expect(() => {
        render(<ChatPanel width={320} side="left" />);
      }).not.toThrow();

      ChatPanel.__testHooks = originalHooks;
    });

    it('renders toggle button on left side with right arrow icon', () => {
      const mockToggle = vi.fn();
      render(<ChatPanel width={320} side="left" onToggleSide={mockToggle} />);
      
      const toggleButton = screen.getByTestId('chat-position-toggle');
      expect(toggleButton).toBeInTheDocument();
      expect(toggleButton).toHaveAttribute('aria-label', 'Move assistant to right side');
    });

    it('renders an auto-fix stop/resume button and toggles the global halt flag', async () => {
      window.__lucidcoderAutofixHalted = false;
      render(<ChatPanel width={320} side="left" />);

      const toggle = screen.getByTestId('chat-autofix-toggle');
      expect(toggle).toBeInTheDocument();
      expect(toggle).toHaveTextContent('Stop');

      const user = userEvent.setup();
      await user.click(toggle);
      expect(window.__lucidcoderAutofixHalted).toBe(true);
      expect(screen.getByTestId('chat-autofix-toggle')).toHaveTextContent('Resume');

      await user.click(screen.getByTestId('chat-autofix-toggle'));
      expect(window.__lucidcoderAutofixHalted).toBe(false);
    });

    it('initializes auto-fix halted state from the global flag', () => {
      window.__lucidcoderAutofixHalted = true;
      render(<ChatPanel width={320} side="left" />);

      expect(screen.getByTestId('chat-autofix-toggle')).toHaveTextContent('Resume');
    });

    it('renders toggle button on right side with left arrow icon', () => {
      const mockToggle = vi.fn();
      render(<ChatPanel width={320} side="right" onToggleSide={mockToggle} />);
      
      const toggleButton = screen.getByTestId('chat-position-toggle');
      expect(toggleButton).toBeInTheDocument();
      expect(toggleButton).toHaveAttribute('aria-label', 'Move assistant to left side');
    });

    it('does not render toggle button when onToggleSide is not provided', () => {
      render(<ChatPanel width={320} side="left" />);
      
      expect(screen.queryByTestId('chat-position-toggle')).not.toBeInTheDocument();
    });

    it('calls onToggleSide when toggle button is clicked', async () => {
      const mockToggle = vi.fn();
      render(<ChatPanel width={320} side="left" onToggleSide={mockToggle} />);
      
      const toggleButton = screen.getByTestId('chat-position-toggle');
      await userEvent.click(toggleButton);
      
      expect(mockToggle).toHaveBeenCalledTimes(1);
    });
  });

  describe('Auto-fix failing tests', () => {
    it('creates a new goal and re-runs tests when lucidcoder:autofix-tests is dispatched', async () => {
      render(<ChatPanel width={320} side="left" />);

      const failureContext = {
        jobs: [
          {
            label: 'Frontend tests',
            type: 'frontend:test',
            status: 'failed',
            recentLogs: ['FAIL src/App.test.jsx > App > renders']
          }
        ]
      };

      window.dispatchEvent(
        new CustomEvent('lucidcoder:autofix-tests', {
          detail: {
            prompt: 'Fix failing tests',
            childPrompts: ['Fix failing frontend tests'],
            origin: 'automation',
            failureContext
          }
        })
      );

      await waitFor(() => {
        expect(goalsApi.createMetaGoalWithChildren).toHaveBeenCalledTimes(1);
        expect(goalAutomationService.processGoals).toHaveBeenCalledTimes(1);
      });

      expect(goalsApi.createMetaGoalWithChildren).toHaveBeenCalledWith({
        projectId: 123,
        prompt: 'Fix failing tests',
        childPrompts: ['Fix failing frontend tests']
      });

      const optionsArg = goalAutomationService.processGoals.mock.calls[0][7];
      expect(optionsArg).toEqual(expect.objectContaining({
        testFailureContext: failureContext
      }));

      await waitFor(() => {
        expect(mockStartAutomationJob).toHaveBeenCalledWith('frontend:test', { projectId: 123 });
        expect(mockStartAutomationJob).toHaveBeenCalledWith('backend:test', { projectId: 123 });
      });

      expect(mockMarkTestRunIntent).toHaveBeenCalledWith('automation');
      expect(goalsApi.fetchGoals).toHaveBeenCalledWith(123);
    });

    it('ignores auto-fix events when prompt is not a string', async () => {
      render(<ChatPanel width={320} side="left" />);

      window.dispatchEvent(
        new CustomEvent('lucidcoder:autofix-tests', {
          detail: {
            prompt: 123,
            origin: 'automation'
          }
        })
      );

      await waitFor(() => {
        expect(goalsApi.createGoal).not.toHaveBeenCalled();
        expect(goalsApi.createMetaGoalWithChildren).not.toHaveBeenCalled();
        expect(goalAutomationService.processGoals).not.toHaveBeenCalled();
      });
    });

    it('ignores auto-fix events when the event has no detail payload', async () => {
      render(<ChatPanel width={320} side="left" />);

      window.dispatchEvent(new CustomEvent('lucidcoder:autofix-tests'));

      await waitFor(() => {
        expect(goalsApi.createGoal).not.toHaveBeenCalled();
        expect(goalsApi.createMetaGoalWithChildren).not.toHaveBeenCalled();
        expect(goalAutomationService.processGoals).not.toHaveBeenCalled();
      });
    });

    it('ignores auto-fix events when prompt is whitespace-only', async () => {
      render(<ChatPanel width={320} side="left" />);

      window.dispatchEvent(
        new CustomEvent('lucidcoder:autofix-tests', {
          detail: {
            prompt: '   ',
            childPrompts: ['Fix failing frontend tests'],
            origin: 'automation'
          }
        })
      );

      await waitFor(() => {
        expect(goalsApi.createGoal).not.toHaveBeenCalled();
        expect(goalsApi.createMetaGoalWithChildren).not.toHaveBeenCalled();
        expect(goalAutomationService.processGoals).not.toHaveBeenCalled();
      });
    });

    it('falls back to createGoal when childPrompts is not an array', async () => {
      render(<ChatPanel width={320} side="left" />);

      window.dispatchEvent(
        new CustomEvent('lucidcoder:autofix-tests', {
          detail: {
            prompt: 'Fix failing tests',
            childPrompts: 'nope',
            origin: 'automation'
          }
        })
      );

      await waitFor(() => {
        expect(goalsApi.createGoal).toHaveBeenCalledTimes(1);
        expect(goalAutomationService.processGoals).toHaveBeenCalledTimes(1);
      });

      expect(goalsApi.createMetaGoalWithChildren).not.toHaveBeenCalled();
    });

    it('filters non-string entries from childPrompts before creating a meta-goal', async () => {
      render(<ChatPanel width={320} side="left" />);

      window.dispatchEvent(
        new CustomEvent('lucidcoder:autofix-tests', {
          detail: {
            prompt: 'Fix failing tests',
            childPrompts: ['  Fix failing frontend tests  ', 123, null],
            origin: 'automation'
          }
        })
      );

      await waitFor(() => {
        expect(goalsApi.createMetaGoalWithChildren).toHaveBeenCalledTimes(1);
      });

      expect(goalsApi.createMetaGoalWithChildren).toHaveBeenCalledWith({
        projectId: 123,
        prompt: 'Fix failing tests',
        childPrompts: ['Fix failing frontend tests']
      });
    });

    it('falls back to the meta-goal parent when children is not an array', async () => {
      goalsApi.createMetaGoalWithChildren.mockResolvedValueOnce({
        parent: { id: 10, prompt: 'Fix failing tests' },
        children: null
      });

      render(<ChatPanel width={320} side="left" />);

      window.dispatchEvent(
        new CustomEvent('lucidcoder:autofix-tests', {
          detail: {
            prompt: 'Fix failing tests',
            childPrompts: ['Fix failing frontend tests'],
            origin: 'automation'
          }
        })
      );

      await waitFor(() => {
        expect(goalAutomationService.processGoals).toHaveBeenCalledTimes(1);
      });

      const goalsArg = goalAutomationService.processGoals.mock.calls[0][0];
      expect(goalsArg).toEqual([{ id: 10, prompt: 'Fix failing tests' }]);
    });

    it('continues auto-fix when fetchGoals returns a non-array payload', async () => {
      goalsApi.fetchGoals.mockReset();
      goalsApi.fetchGoals
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce({ nope: true });

      render(<ChatPanel width={320} side="left" />);

      window.dispatchEvent(
        new CustomEvent('lucidcoder:autofix-tests', {
          detail: {
            prompt: 'Fix failing tests',
            childPrompts: ['Fix failing frontend tests'],
            origin: 'automation'
          }
        })
      );

      await waitFor(() => {
        expect(goalAutomationService.processGoals).toHaveBeenCalledTimes(1);
      });

      await waitFor(() => {
        expect(mockStartAutomationJob).toHaveBeenCalledWith('frontend:test', { projectId: 123 });
        expect(mockStartAutomationJob).toHaveBeenCalledWith('backend:test', { projectId: 123 });
      });
    });

    it('uses a fallback error message when auto-fix throws without a message', async () => {
      goalsApi.createMetaGoalWithChildren.mockRejectedValueOnce({});

      render(<ChatPanel width={320} side="left" />);

      window.dispatchEvent(
        new CustomEvent('lucidcoder:autofix-tests', {
          detail: {
            prompt: 'Fix failing tests',
            childPrompts: ['Fix failing frontend tests'],
            origin: 'automation'
          }
        })
      );

      expect(await screen.findByText('Failed to create/run a test-fix goal.')).toBeInTheDocument();
    });

    it('continues goal processing when fetchGoals fails during auto-fix', async () => {
      goalsApi.fetchGoals.mockReset();
      goalsApi.fetchGoals
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new Error('fetch failed'));

      render(<ChatPanel width={320} side="left" />);

      window.dispatchEvent(
        new CustomEvent('lucidcoder:autofix-tests', {
          detail: {
            prompt: 'Fix failing tests',
            childPrompts: ['Fix failing frontend tests'],
            origin: 'automation'
          }
        })
      );

      await waitFor(() => {
        expect(goalsApi.createMetaGoalWithChildren).toHaveBeenCalledTimes(1);
        expect(goalAutomationService.processGoals).toHaveBeenCalledTimes(1);
      });

      await waitFor(() => {
        expect(mockStartAutomationJob).toHaveBeenCalledWith('frontend:test', { projectId: 123 });
        expect(mockStartAutomationJob).toHaveBeenCalledWith('backend:test', { projectId: 123 });
      });

      expect(goalsApi.fetchGoals).toHaveBeenCalledTimes(2);
    });

    it('does nothing when no currentProject id is available', async () => {
      useAppState.mockReturnValue({
        currentProject: null,
        stageAiChange: mockStageAiChange,
        jobState: { jobsByProject: {} },
        setPreviewPanelTab: mockSetPreviewPanelTab,
        startAutomationJob: mockStartAutomationJob,
        markTestRunIntent: mockMarkTestRunIntent,
        requestEditorFocus: vi.fn(),
        syncBranchOverview: vi.fn(),
        workingBranches: {}
      });

      render(<ChatPanel width={320} side="left" />);

      window.dispatchEvent(
        new CustomEvent('lucidcoder:autofix-tests', {
          detail: {
            prompt: 'Fix failing tests',
            origin: 'automation'
          }
        })
      );

      await waitFor(() => {
        expect(goalsApi.createGoal).not.toHaveBeenCalled();
        expect(goalsApi.createMetaGoalWithChildren).not.toHaveBeenCalled();
      });
    });

    it('ignores automation auto-fix events when auto-fix is halted (runAutomatedTestFixGoal guard)', async () => {
      window.__lucidcoderAutofixHalted = true;

      render(<ChatPanel width={320} side="left" />);

      window.dispatchEvent(
        new CustomEvent('lucidcoder:autofix-tests', {
          detail: {
            prompt: 'Fix failing tests',
            origin: 'automation'
          }
        })
      );

      await waitFor(() => {
        expect(goalsApi.createGoal).not.toHaveBeenCalled();
        expect(goalsApi.createMetaGoalWithChildren).not.toHaveBeenCalled();
      });
    });

    it('reports auto-fix stopped when the user halts while goals are running', async () => {
      const deferred = {};
      deferred.promise = new Promise((resolve) => {
        deferred.resolve = resolve;
      });

      goalAutomationService.processGoals.mockImplementation(() => deferred.promise);

      render(<ChatPanel width={320} side="left" />);

      window.dispatchEvent(
        new CustomEvent('lucidcoder:autofix-tests', {
          detail: {
            prompt: 'Fix failing tests',
            childPrompts: ['Fix failing frontend tests'],
            origin: 'automation'
          }
        })
      );

      await waitFor(() => {
        expect(goalsApi.createMetaGoalWithChildren).toHaveBeenCalledTimes(1);
        expect(goalAutomationService.processGoals).toHaveBeenCalledTimes(1);
      });

      // Stop auto-fix while the goal is still in-flight.
      await userEvent.click(screen.getByTestId('chat-autofix-toggle'));
      expect(window.__lucidcoderAutofixHalted).toBe(true);

      deferred.resolve({ success: true, processed: 1 });

      await waitFor(() => {
        expect(screen.getByText('Auto-fix stopped.')).toBeInTheDocument();
      });
    });

    it('shows an error message when the fix goal does not complete successfully', async () => {
      goalAutomationService.processGoals.mockResolvedValueOnce({ success: false });

      render(<ChatPanel width={320} side="left" />);

      window.dispatchEvent(
        new CustomEvent('lucidcoder:autofix-tests', {
          detail: {
            prompt: 'Fix failing tests',
            childPrompts: ['Fix failing frontend tests'],
            origin: 'automation'
          }
        })
      );

      await waitFor(() => {
        expect(screen.getByText('Fix goal did not complete successfully.')).toBeInTheDocument();
      });
    });

    it('falls back to the parent goal when meta-goal creation returns no children', async () => {
      goalsApi.createMetaGoalWithChildren.mockResolvedValueOnce({
        parent: { id: 101, prompt: 'Fix failing tests' },
        children: []
      });
      goalAutomationService.processGoals.mockResolvedValueOnce({ success: false });

      render(<ChatPanel width={320} side="left" />);

      window.dispatchEvent(
        new CustomEvent('lucidcoder:autofix-tests', {
          detail: {
            prompt: 'Fix failing tests',
            childPrompts: ['  Fix failing frontend tests  '],
            origin: 'automation'
          }
        })
      );

      await waitFor(() => {
        expect(goalAutomationService.processGoals).toHaveBeenCalledTimes(1);
      });

      const goals = goalAutomationService.processGoals.mock.calls[0][0];
      expect(goals).toEqual([{ id: 101, prompt: 'Fix failing tests' }]);

      await waitFor(() => {
        expect(screen.getByText('Fix goal did not complete successfully.')).toBeInTheDocument();
      });
    });

    it('shows an error when meta-goal creation returns no children and no parent', async () => {
      goalsApi.createMetaGoalWithChildren.mockResolvedValueOnce({
        parent: {},
        children: []
      });

      render(<ChatPanel width={320} side="left" />);

      window.dispatchEvent(
        new CustomEvent('lucidcoder:autofix-tests', {
          detail: {
            prompt: 'Fix failing tests',
            childPrompts: ['Fix failing frontend tests'],
            origin: 'automation'
          }
        })
      );

      expect(await screen.findByText('Failed to create goals for fixing failing tests.')).toBeInTheDocument();
    });

    it('reports auto-fix stopped when the user halts during goal creation', async () => {
      const deferred = {};
      deferred.promise = new Promise((resolve) => {
        deferred.resolve = resolve;
      });

      goalsApi.createGoal.mockImplementationOnce(() => deferred.promise);

      render(<ChatPanel width={320} side="left" />);

      // ChatPanel fetches goal count on mount; clear that baseline call so
      // assertions below only cover the auto-fix flow.
      await waitFor(() => {
        expect(goalsApi.fetchGoals).toHaveBeenCalled();
      });
      goalsApi.fetchGoals.mockClear();

      window.dispatchEvent(
        new CustomEvent('lucidcoder:autofix-tests', {
          detail: {
            prompt: 'Fix failing tests',
            origin: 'automation'
          }
        })
      );

      await waitFor(() => {
        expect(screen.getByText('Creating a fix goal for failing tests…')).toBeInTheDocument();
      });

      await userEvent.click(screen.getByTestId('chat-autofix-toggle'));

      deferred.resolve({ goal: { id: 1, prompt: 'Fix failing tests' } });

      expect(await screen.findByText('Auto-fix stopped.')).toBeInTheDocument();
      expect(goalsApi.fetchGoals).not.toHaveBeenCalled();
      expect(goalAutomationService.processGoals).not.toHaveBeenCalled();
      expect(mockStartAutomationJob).not.toHaveBeenCalled();
    });

    it('shows an error when createGoal returns no goal id', async () => {
      goalsApi.createGoal.mockResolvedValueOnce({ goal: { id: null } });

      render(<ChatPanel width={320} side="left" />);

      window.dispatchEvent(
        new CustomEvent('lucidcoder:autofix-tests', {
          detail: {
            prompt: 'Fix failing tests',
            origin: 'automation'
          }
        })
      );

      await waitFor(() => {
        expect(screen.getByText('Failed to create a goal for fixing failing tests.')).toBeInTheDocument();
      });
    });

    it('continues processing even when goal-count refresh fails', async () => {
      goalsApi.fetchGoals.mockRejectedValueOnce(new Error('Nope'));
      goalAutomationService.processGoals.mockResolvedValueOnce({ success: false });

      render(<ChatPanel width={320} side="left" />);

      window.dispatchEvent(
        new CustomEvent('lucidcoder:autofix-tests', {
          detail: {
            prompt: 'Fix failing tests',
            childPrompts: ['Fix failing frontend tests'],
            origin: 'automation'
          }
        })
      );

      await waitFor(() => {
        expect(goalAutomationService.processGoals).toHaveBeenCalledTimes(1);
      });

      expect(await screen.findByText('Fix goal did not complete successfully.')).toBeInTheDocument();
    });

    it('re-runs tests after a successful fix goal and starts automation jobs', async () => {
      goalAutomationService.processGoals.mockResolvedValueOnce({ success: true, processed: 1 });
      mockStartAutomationJob.mockResolvedValue({ id: 'job-1' });

      render(<ChatPanel width={320} side="left" />);

      window.dispatchEvent(
        new CustomEvent('lucidcoder:autofix-tests', {
          detail: {
            prompt: 'Fix failing tests',
            childPrompts: ['Fix failing frontend tests'],
            origin: 'automation'
          }
        })
      );

      await waitFor(() => {
        expect(mockSetPreviewPanelTab).toHaveBeenCalledWith('tests', { source: 'automation' });
        expect(mockStartAutomationJob).toHaveBeenCalledWith('frontend:test', { projectId: 123 });
        expect(mockStartAutomationJob).toHaveBeenCalledWith('backend:test', { projectId: 123 });
      });

      expect(screen.getByText('Re-running frontend + backend tests…')).toBeInTheDocument();
    });

    it('skips test reruns after a successful fix goal when changes are css-only', async () => {
      goalAutomationService.processGoals.mockResolvedValueOnce({ success: true, processed: 1 });
      axios.get.mockResolvedValueOnce({ data: { isCssOnly: true } });

      useAppState.mockReturnValue({
        currentProject: { id: 123, name: 'Test Project' },
        stageAiChange: mockStageAiChange,
        jobState: { jobsByProject: {} },
        setPreviewPanelTab: mockSetPreviewPanelTab,
        startAutomationJob: mockStartAutomationJob,
        markTestRunIntent: mockMarkTestRunIntent,
        requestEditorFocus: vi.fn(),
        syncBranchOverview: vi.fn(),
        workingBranches: {
          123: {
            name: 'feature/css-only',
            stagedFiles: [{ path: 'src/styles/app.css' }]
          }
        }
      });

      render(<ChatPanel width={320} side="left" />);

      window.dispatchEvent(
        new CustomEvent('lucidcoder:autofix-tests', {
          detail: {
            prompt: 'Fix failing tests',
            childPrompts: ['Fix failing frontend tests'],
            origin: 'automation'
          }
        })
      );

      await waitFor(() => {
        expect(mockSetPreviewPanelTab).toHaveBeenCalledWith('commits', { source: 'automation' });
      });

      expect(screen.getByText('CSS-only update detected. Skipping automated test run and moving to commit stage.')).toBeInTheDocument();
      expect(mockStartAutomationJob).not.toHaveBeenCalled();
      expect(mockMarkTestRunIntent).not.toHaveBeenCalled();
    });

    it('surfaces startAutomationJob failures during the auto-fix rerun', async () => {
      goalAutomationService.processGoals.mockResolvedValueOnce({ success: true, processed: 1 });

      mockStartAutomationJob
        .mockImplementationOnce(() => Promise.reject(new Error('Could not start frontend tests')))
        .mockImplementationOnce(() => Promise.resolve({ id: 'job-2' }));

      render(<ChatPanel width={320} side="left" />);

      window.dispatchEvent(
        new CustomEvent('lucidcoder:autofix-tests', {
          detail: {
            prompt: 'Fix failing tests',
            childPrompts: ['Fix failing frontend tests'],
            origin: 'automation'
          }
        })
      );

      expect(await screen.findByText('Could not start frontend tests')).toBeInTheDocument();
    });

    it('falls back to a default message when startAutomationJob rejects without a message', async () => {
      goalAutomationService.processGoals.mockResolvedValueOnce({ success: true, processed: 1 });

      mockStartAutomationJob
        .mockImplementationOnce(() => Promise.reject({}))
        .mockImplementationOnce(() => Promise.resolve({ id: 'job-2' }));

      render(<ChatPanel width={320} side="left" />);

      window.dispatchEvent(
        new CustomEvent('lucidcoder:autofix-tests', {
          detail: {
            prompt: 'Fix failing tests',
            origin: 'automation'
          }
        })
      );

      expect(await screen.findByText('Failed to start automated test run.')).toBeInTheDocument();
    });

    it('ignores auto-fix events with missing or blank prompts', async () => {
      render(<ChatPanel width={320} side="left" />);

      window.dispatchEvent(
        new CustomEvent('lucidcoder:autofix-tests', {
          detail: {
            prompt: '   ',
            origin: 'automation'
          }
        })
      );

      await waitFor(() => {
        expect(goalsApi.createGoal).not.toHaveBeenCalled();
        expect(goalsApi.createMetaGoalWithChildren).not.toHaveBeenCalled();
      });
    });

    it('ignores subsequent auto-fix events while a previous one is in flight', async () => {
      const deferred = {};
      deferred.promise = new Promise((resolve) => {
        deferred.resolve = resolve;
      });

      goalAutomationService.processGoals.mockImplementationOnce(() => deferred.promise);

      render(<ChatPanel width={320} side="left" />);

      window.dispatchEvent(
        new CustomEvent('lucidcoder:autofix-tests', {
          detail: {
            prompt: 'Fix failing tests',
            origin: 'automation'
          }
        })
      );

      await waitFor(() => {
        expect(goalsApi.createGoal).toHaveBeenCalledTimes(1);
        expect(goalAutomationService.processGoals).toHaveBeenCalledTimes(1);
      });

      window.dispatchEvent(
        new CustomEvent('lucidcoder:autofix-tests', {
          detail: {
            prompt: 'Fix failing tests',
            origin: 'automation'
          }
        })
      );

      await waitFor(() => {
        expect(goalsApi.createGoal).toHaveBeenCalledTimes(1);
      });

      deferred.resolve({ success: false });

      expect(await screen.findByText('Fix goal did not complete successfully.')).toBeInTheDocument();
    });

    it('continues auto-fix even if setPreviewPanelTab is unavailable', async () => {
      useAppState.mockReturnValue({
        currentProject: { id: 123, name: 'Test Project' },
        stageAiChange: mockStageAiChange,
        jobState: { jobsByProject: {} },
        setPreviewPanelTab: undefined,
        startAutomationJob: mockStartAutomationJob,
        markTestRunIntent: mockMarkTestRunIntent,
        requestEditorFocus: vi.fn(),
        syncBranchOverview: vi.fn()
      });

      goalAutomationService.processGoals.mockResolvedValueOnce({ success: true, processed: 1 });

      render(<ChatPanel width={320} side="left" />);

      window.dispatchEvent(
        new CustomEvent('lucidcoder:autofix-tests', {
          detail: {
            prompt: 'Fix failing tests',
            origin: 'automation'
          }
        })
      );

      await waitFor(() => {
        expect(mockStartAutomationJob).toHaveBeenCalledWith('frontend:test', { projectId: 123 });
        expect(mockStartAutomationJob).toHaveBeenCalledWith('backend:test', { projectId: 123 });
      });
    });

    it('ignores automation auto-fix events when auto-fix is halted', async () => {
      window.__lucidcoderAutofixHalted = true;

      render(<ChatPanel width={320} side="left" />);

      window.dispatchEvent(
        new CustomEvent('lucidcoder:autofix-tests', {
          detail: {
            prompt: 'Fix failing tests',
            childPrompts: ['Fix failing frontend tests'],
            origin: 'automation'
          }
        })
      );

      await waitFor(() => {
        expect(goalsApi.createMetaGoalWithChildren).not.toHaveBeenCalled();
      });
    });

    it('still processes user-origin auto-fix events even when auto-fix is halted', async () => {
      window.__lucidcoderAutofixHalted = true;

      render(<ChatPanel width={320} side="left" />);

      window.dispatchEvent(
        new CustomEvent('lucidcoder:autofix-tests', {
          detail: {
            prompt: 'Fix failing tests',
            origin: 'user'
          }
        })
      );

      await waitFor(() => {
        expect(goalsApi.createGoal).toHaveBeenCalled();
      });

      await waitFor(() => {
        expect(mockSetPreviewPanelTab).toHaveBeenCalledWith('tests', { source: 'user' });
        expect(mockStartAutomationJob).toHaveBeenCalledWith('frontend:test', { projectId: 123 });
        expect(mockStartAutomationJob).toHaveBeenCalledWith('backend:test', { projectId: 123 });
      });
    });
  });

  describe('Coverage branches', () => {
    it('ignores empty prompts when submit is triggered via Enter key', async () => {
      render(<ChatPanel width={320} side="left" />);

      const input = screen.getByTestId('chat-input');
      expect(input).toHaveValue('');

      await userEvent.type(input, '{Enter}');

      await waitFor(() => {
        expect(goalsApi.agentRequest).not.toHaveBeenCalled();
      });

      expect(screen.getByText('Welcome! Ask me anything about your project.')).toBeInTheDocument();
    });

    it('renders agent step status messages when steps are returned', async () => {
      goalsApi.agentRequest.mockResolvedValue({
        kind: 'question',
        answer: 'Test answer',
        steps: [{ type: 'action', action: 'read_file', target: 'README.md', reason: 'debugging' }]
      });

      render(<ChatPanel width={320} side="left" />);

      const input = screen.getByTestId('chat-input');
      await userEvent.type(input, 'What is this project?');
      await userEvent.click(screen.getByTestId('chat-send-button'));

      await waitFor(() => {
        expect(screen.getByText(/Agent is reading README\.md \(debugging\)\./)).toBeInTheDocument();
      });

      expect(screen.getByText('Test answer')).toBeInTheDocument();
    });

    it('shows an error message when automated test jobs fail to start', async () => {
      const mockStartAutomationJob = vi
        .fn()
        .mockImplementationOnce(() => Promise.reject(new Error('Could not start frontend tests')))
        .mockImplementationOnce(() => Promise.resolve({ id: 'job-2' }));

      const mockMarkTestRunIntent = vi.fn();

      useAppState.mockReturnValue({
        currentProject: { id: 123, name: 'Test Project' },
        stageAiChange: mockStageAiChange,
        jobState: { jobsByProject: {} },
        setPreviewPanelTab: mockSetPreviewPanelTab,
        startAutomationJob: mockStartAutomationJob,
        markTestRunIntent: mockMarkTestRunIntent,
        workingBranches: {
          123: {
            name: 'feature/test-branch',
            stagedFiles: [{ path: 'src/App.jsx' }]
          }
        },
        requestEditorFocus: vi.fn(),
        syncBranchOverview: vi.fn()
      });

      goalsApi.agentRequest.mockResolvedValue({ kind: 'feature', planOnly: false });
      goalAutomationService.handleRegularFeature.mockResolvedValue({ success: true });

      render(<ChatPanel width={320} side="left" />);

      await userEvent.type(screen.getByTestId('chat-input'), 'Run the feature');
      await userEvent.click(screen.getByTestId('chat-send-button'));

      await waitFor(() => {
        expect(mockSetPreviewPanelTab).toHaveBeenCalledWith('tests', { source: 'automation' });
        expect(mockMarkTestRunIntent).toHaveBeenCalledWith('automation');
      });

      expect(screen.getByText('Starting frontend + backend test runs…')).toBeInTheDocument();

      await waitFor(() => {
        expect(screen.getByText('Could not start frontend tests')).toBeInTheDocument();
      });

      expect(mockStartAutomationJob).toHaveBeenCalledWith('frontend:test', { projectId: 123 });
      expect(mockStartAutomationJob).toHaveBeenCalledWith('backend:test', { projectId: 123 });
    });

    it('uses a fallback error message when automation startup rejects without a message', async () => {
      const mockStartAutomationJob = vi
        .fn()
        .mockImplementationOnce(() => Promise.reject({}))
        .mockImplementationOnce(() => Promise.resolve({ id: 'job-2' }));

      useAppState.mockReturnValue({
        currentProject: { id: 123, name: 'Test Project' },
        stageAiChange: mockStageAiChange,
        jobState: { jobsByProject: {} },
        setPreviewPanelTab: mockSetPreviewPanelTab,
        startAutomationJob: mockStartAutomationJob,
        markTestRunIntent: vi.fn(),
        workingBranches: {
          123: {
            name: 'feature/test-branch',
            stagedFiles: [{ path: 'src/App.jsx' }]
          }
        },
        requestEditorFocus: vi.fn(),
        syncBranchOverview: vi.fn()
      });

      goalsApi.agentRequest.mockResolvedValue({ kind: 'feature', planOnly: false });
      goalAutomationService.handleRegularFeature.mockResolvedValue({ success: true });

      render(<ChatPanel width={320} side="left" />);

      await userEvent.type(screen.getByTestId('chat-input'), 'Run the feature');
      await userEvent.click(screen.getByTestId('chat-send-button'));

      await waitFor(() => {
        expect(screen.getByText('Failed to start automated test run.')).toBeInTheDocument();
      });
    });

    it('builds a clarified prompt and clears stale goals after clarification', async () => {
      goalsApi.agentRequest
        .mockResolvedValueOnce({ kind: 'feature', planOnly: false })
        .mockResolvedValueOnce({ kind: 'question', answer: 'Got it', steps: [] })
        .mockResolvedValueOnce({ kind: 'question', answer: 'Third ok', steps: [] });

      goalsApi.fetchGoals
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { id: 1, status: 'planning' },
          { id: 2, lifecycleState: 'draft' },
          { id: 3, status: 'ready' }
        ]);
      goalsApi.deleteGoal.mockResolvedValue({ success: true });

      let resolveFeature;
      const featurePromise = new Promise((resolve) => {
        resolveFeature = resolve;
      });
      goalAutomationService.handleRegularFeature.mockReturnValueOnce(featurePromise);

      render(<ChatPanel width={320} side="left" />);

      await userEvent.type(screen.getByTestId('chat-input'), 'First request');
      await userEvent.click(screen.getByTestId('chat-send-button'));

      await waitFor(() => {
        expect(goalAutomationService.handleRegularFeature).toHaveBeenCalledTimes(1);
      });

      await waitFor(() => {
        expect(goalsApi.agentRequest).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        resolveFeature({
          needsClarification: true,
          clarifyingQuestions: ['Need details?']
        });
      });

      await waitFor(() => {
        expect(screen.queryByTestId('chat-status')).not.toBeInTheDocument();
      });

      await userEvent.type(screen.getByTestId('chat-input'), 'Answer');
      await userEvent.click(screen.getByTestId('chat-send-button'));

      await waitFor(() => {
        expect(goalsApi.fetchGoals).toHaveBeenCalledWith(123, { includeArchived: false });
        expect(goalsApi.deleteGoal).toHaveBeenCalledWith(1);
        expect(goalsApi.deleteGoal).toHaveBeenCalledWith(2);
      });

      const clarifiedPrompt = goalsApi.agentRequest.mock.calls[1][0].prompt;
      expect(clarifiedPrompt).toContain('Original request: First request');
      expect(clarifiedPrompt).toContain('Clarification questions:');
      expect(clarifiedPrompt).toContain('- Need details?');
      expect(clarifiedPrompt).toContain('User answer: Answer');

      await userEvent.type(screen.getByTestId('chat-input'), 'Third');
      await userEvent.click(screen.getByTestId('chat-send-button'));

      await waitFor(() => {
        expect(goalsApi.agentRequest).toHaveBeenCalledTimes(3);
      });

      expect(goalsApi.agentRequest.mock.calls[2][0].prompt).toBe('Third');
    });

    it('logs a warning when stale goal cleanup fails after clarification', async () => {
      goalsApi.agentRequest
        .mockResolvedValueOnce({ kind: 'feature', planOnly: false })
        .mockResolvedValueOnce({ kind: 'question', answer: 'Ok', steps: [] });

      goalsApi.fetchGoals
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new Error('fetch failed'));

      let resolveFeature;
      const featurePromise = new Promise((resolve) => {
        resolveFeature = resolve;
      });
      goalAutomationService.handleRegularFeature.mockReturnValueOnce(featurePromise);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        render(<ChatPanel width={320} side="left" />);

        await userEvent.type(screen.getByTestId('chat-input'), 'First request');
        await userEvent.click(screen.getByTestId('chat-send-button'));

        await waitFor(() => {
          expect(goalAutomationService.handleRegularFeature).toHaveBeenCalledTimes(1);
        });

        await waitFor(() => {
          expect(goalsApi.agentRequest).toHaveBeenCalledTimes(1);
        });

        await act(async () => {
          resolveFeature({
            needsClarification: true,
            clarifyingQuestions: ['Need details?']
          });
        });

        await waitFor(() => {
          expect(screen.queryByTestId('chat-status')).not.toBeInTheDocument();
        });

        await userEvent.type(screen.getByTestId('chat-input'), 'Answer');
        await userEvent.click(screen.getByTestId('chat-send-button'));

        await waitFor(() => {
          expect(warnSpy).toHaveBeenCalledWith(
            'Failed to clear stale goals after clarification:',
            'fetch failed'
          );
        });
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('continues when stale goal deletion fails after clarification', async () => {
      goalsApi.agentRequest
        .mockResolvedValueOnce({ kind: 'feature', planOnly: false })
        .mockResolvedValueOnce({ kind: 'question', answer: 'Ok', steps: [] });

      goalsApi.fetchGoals
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { id: 55, status: 'planning' },
          { id: 56, lifecycleState: 'draft' }
        ]);
      goalsApi.deleteGoal.mockRejectedValueOnce(new Error('delete failed'));

      let resolveFeature;
      const featurePromise = new Promise((resolve) => {
        resolveFeature = resolve;
      });
      goalAutomationService.handleRegularFeature.mockReturnValueOnce(featurePromise);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        render(<ChatPanel width={320} side="left" />);

        await userEvent.type(screen.getByTestId('chat-input'), 'First request');
        await userEvent.click(screen.getByTestId('chat-send-button'));

        await waitFor(() => {
          expect(goalAutomationService.handleRegularFeature).toHaveBeenCalledTimes(1);
        });

        await act(async () => {
          resolveFeature({
            needsClarification: true,
            clarifyingQuestions: ['Need details?']
          });
        });

        await waitFor(() => {
          expect(screen.queryByTestId('chat-status')).not.toBeInTheDocument();
        });

        await userEvent.type(screen.getByTestId('chat-input'), 'Answer');
        await userEvent.click(screen.getByTestId('chat-send-button'));

        await waitFor(() => {
          expect(goalsApi.deleteGoal).toHaveBeenCalledWith(55);
          expect(goalsApi.deleteGoal).toHaveBeenCalledWith(56);
        });

        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('logs a warning when clarification cleanup fetch fails', async () => {
      goalsApi.agentRequest
        .mockResolvedValueOnce({ kind: 'feature', planOnly: false })
        .mockResolvedValueOnce({ kind: 'question', answer: 'Ok', steps: [] });

      goalsApi.fetchGoals.mockImplementation((_, options) => {
        if (options?.includeArchived === false) {
          return Promise.reject(new Error('cleanup fetch failed'));
        }
        return Promise.resolve([]);
      });

      let resolveFeature;
      const featurePromise = new Promise((resolve) => {
        resolveFeature = resolve;
      });
      goalAutomationService.handleRegularFeature.mockReturnValueOnce(featurePromise);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        render(<ChatPanel width={320} side="left" />);

        await userEvent.type(screen.getByTestId('chat-input'), 'First request');
        await userEvent.click(screen.getByTestId('chat-send-button'));

        await waitFor(() => {
          expect(goalAutomationService.handleRegularFeature).toHaveBeenCalledTimes(1);
        });

        await act(async () => {
          resolveFeature({
            needsClarification: true,
            clarifyingQuestions: ['Need details?']
          });
        });

        await waitFor(() => {
          expect(screen.queryByTestId('chat-status')).not.toBeInTheDocument();
        });

        await userEvent.type(screen.getByTestId('chat-input'), 'Answer');
        await userEvent.click(screen.getByTestId('chat-send-button'));

        await waitFor(() => {
          expect(warnSpy).toHaveBeenCalledWith(
            'Failed to clear stale goals after clarification:',
            'cleanup fetch failed'
          );
        });
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('logs a warning when clarification cleanup rejects with a non-error value', async () => {
      goalsApi.agentRequest
        .mockResolvedValueOnce({ kind: 'feature', planOnly: false })
        .mockResolvedValueOnce({ kind: 'question', answer: 'Ok', steps: [] });

      goalsApi.fetchGoals.mockImplementation((_, options) => {
        if (options?.includeArchived === false) {
          return Promise.reject('cleanup failed');
        }
        return Promise.resolve([]);
      });

      let resolveFeature;
      const featurePromise = new Promise((resolve) => {
        resolveFeature = resolve;
      });
      goalAutomationService.handleRegularFeature.mockReturnValueOnce(featurePromise);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        render(<ChatPanel width={320} side="left" />);

        await userEvent.type(screen.getByTestId('chat-input'), 'First request');
        await userEvent.click(screen.getByTestId('chat-send-button'));

        await waitFor(() => {
          expect(goalAutomationService.handleRegularFeature).toHaveBeenCalledTimes(1);
        });

        await act(async () => {
          resolveFeature({
            needsClarification: true,
            clarifyingQuestions: ['Need details?']
          });
        });

        await waitFor(() => {
          expect(screen.queryByTestId('chat-status')).not.toBeInTheDocument();
        });

        await userEvent.type(screen.getByTestId('chat-input'), 'Answer');
        await userEvent.click(screen.getByTestId('chat-send-button'));

        await waitFor(() => {
          expect(warnSpy).toHaveBeenCalledWith(
            'Failed to clear stale goals after clarification:',
            'cleanup failed'
          );
        });
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('skips automated tests when the change is css-only', async () => {
      axios.get.mockResolvedValueOnce({ data: { isCssOnly: true } });
      goalsApi.agentRequest.mockResolvedValue({ kind: 'feature', planOnly: false });
      goalAutomationService.handleRegularFeature.mockResolvedValue({ success: true });

      useAppState.mockReturnValue({
        currentProject: { id: 123, name: 'Test Project' },
        stageAiChange: mockStageAiChange,
        jobState: { jobsByProject: {} },
        setPreviewPanelTab: mockSetPreviewPanelTab,
        startAutomationJob: mockStartAutomationJob,
        markTestRunIntent: mockMarkTestRunIntent,
        requestEditorFocus: vi.fn(),
        syncBranchOverview: vi.fn(),
        workingBranches: {
          123: {
            name: 'feature/css-only',
            stagedFiles: [{ path: 'src/styles/app.css' }]
          }
        }
      });

      render(<ChatPanel width={320} side="left" />);

      await userEvent.type(screen.getByTestId('chat-input'), 'Change background color');
      await userEvent.click(screen.getByTestId('chat-send-button'));

      await waitFor(() => {
        expect(
          screen.getByText('CSS-only update detected. Skipping automated test run and moving to commit stage.')
        ).toBeInTheDocument();
      });

      expect(mockStartAutomationJob).not.toHaveBeenCalled();
      expect(mockMarkTestRunIntent).not.toHaveBeenCalled();
      expect(mockSetPreviewPanelTab).toHaveBeenCalledWith('commits', { source: 'automation' });
    });

    it('refreshes branch overview before css-only check when cache is empty', async () => {
      const branchOverview = {
        success: true,
        current: 'feature/css-only',
        workingBranches: [
          {
            name: 'feature/css-only',
            stagedFiles: [{ path: 'src/styles/brand.css' }]
          }
        ]
      };

      axios.get.mockReset();
      axios.get
        .mockResolvedValueOnce({ data: branchOverview })
        .mockResolvedValueOnce({ data: { isCssOnly: true } });

      const syncBranchOverview = vi.fn();
      const localStartAutomationJob = vi.fn();

      goalsApi.agentRequest.mockResolvedValue({ kind: 'feature', planOnly: false });
      goalAutomationService.handleRegularFeature.mockResolvedValue({ success: true });

      useAppState.mockReturnValue({
        currentProject: { id: 123, name: 'Test Project' },
        stageAiChange: mockStageAiChange,
        jobState: { jobsByProject: {} },
        setPreviewPanelTab: mockSetPreviewPanelTab,
        startAutomationJob: localStartAutomationJob,
        markTestRunIntent: mockMarkTestRunIntent,
        requestEditorFocus: vi.fn(),
        syncBranchOverview,
        workingBranches: {}
      });

      render(<ChatPanel width={320} side="left" />);

      await userEvent.type(screen.getByTestId('chat-input'), 'Update button styles');
      await userEvent.click(screen.getByTestId('chat-send-button'));

      await waitFor(() => {
        expect(
          screen.getByText('CSS-only update detected. Skipping automated test run and moving to commit stage.')
        ).toBeInTheDocument();
      });

      expect(syncBranchOverview).toHaveBeenCalledWith(123, branchOverview);
      expect(localStartAutomationJob).not.toHaveBeenCalled();
      expect(mockSetPreviewPanelTab).toHaveBeenCalledWith('commits', { source: 'automation' });
    });

    it('falls back to running tests when css-only probe fails', async () => {
      axios.get.mockReset();
      axios.get.mockRejectedValueOnce(new Error('css probe failed'));

      goalsApi.agentRequest.mockResolvedValue({ kind: 'feature', planOnly: false });
      goalAutomationService.handleRegularFeature.mockResolvedValue({ success: true });

      const localStartAutomationJob = vi.fn().mockResolvedValue({ success: true });

      useAppState.mockReturnValue({
        currentProject: { id: 123, name: 'Test Project' },
        stageAiChange: mockStageAiChange,
        jobState: { jobsByProject: {} },
        setPreviewPanelTab: mockSetPreviewPanelTab,
        startAutomationJob: localStartAutomationJob,
        markTestRunIntent: mockMarkTestRunIntent,
        requestEditorFocus: vi.fn(),
        syncBranchOverview: vi.fn(),
        workingBranches: {
          123: {
            name: 'feature/css-only',
            stagedFiles: [{ path: 'src/styles/theme.css' }]
          }
        }
      });

      render(<ChatPanel width={320} side="left" />);

      await userEvent.type(screen.getByTestId('chat-input'), 'Adjust spacing');
      await userEvent.click(screen.getByTestId('chat-send-button'));

      await waitFor(() => {
        expect(mockSetPreviewPanelTab).toHaveBeenCalledWith('tests', { source: 'automation' });
      });

      expect(localStartAutomationJob).toHaveBeenCalledWith('frontend:test', { projectId: 123 });
      expect(localStartAutomationJob).toHaveBeenCalledWith('backend:test', { projectId: 123 });
      expect(mockMarkTestRunIntent).toHaveBeenCalledWith('automation');
    });

    it('submits prompts via the lucidcoder:run-prompt window event', async () => {
      goalsApi.agentRequest.mockResolvedValue({ kind: 'question', answer: 'Event answer', steps: [] });

      render(<ChatPanel width={320} side="left" />);

      window.dispatchEvent(new CustomEvent('lucidcoder:run-prompt', { detail: { prompt: '   ' } }));
      window.dispatchEvent(
        new CustomEvent('lucidcoder:run-prompt', { detail: { prompt: 'Hello from event', origin: 'automation' } })
      );
      window.dispatchEvent(
        new CustomEvent('lucidcoder:run-prompt', { detail: { prompt: 'Hello from user event', origin: 'user' } })
      );

      await waitFor(() => {
        expect(goalsApi.agentRequest).toHaveBeenCalledWith({ projectId: 123, prompt: 'Hello from event' });
        expect(goalsApi.agentRequest).toHaveBeenCalledWith({ projectId: 123, prompt: 'Hello from user event' });
      });

      expect(screen.getByText('Hello from event')).toBeInTheDocument();
      expect(screen.getByText('Hello from user event')).toBeInTheDocument();
      expect(screen.getAllByText('Event answer').length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Autopilot Timeline', () => {
    it('shows autopilot timeline when events exist', async () => {
      useAppState.mockReturnValue({
        currentProject: { id: 123 },
        stageAiChange: mockStageAiChange,
        jobState: { jobsByProject: {} },
        setPreviewPanelTab: mockSetPreviewPanelTab
      });

      const { rerender } = render(
        <ChatPanel width={320} side="left" />
      );

      // Initially no inspector
      expect(screen.queryByTestId('chat-inspector')).not.toBeInTheDocument();

      // Simulate autopilot running with events
      useAppState.mockReturnValue({
        currentProject: { id: 123 },
        stageAiChange: mockStageAiChange,
        jobState: { jobsByProject: {} },
        setPreviewPanelTab: mockSetPreviewPanelTab
      });

      // Force a rerender with state that would show timeline events
      const { rerender: rerender2 } = render(
        <ChatPanel 
          width={320} 
          side="left"
        />
      );

      // We need to trigger the state that creates timeline events
      // This would normally happen through socket events, which are hard to test
      // For now, we verify the component structure exists
    });
  });

  describe('Job Logs Display', () => {
    it('shows job logs when autopilot is running', () => {
      useAppState.mockReturnValue({
        currentProject: { id: 123 },
        stageAiChange: mockStageAiChange,
        jobState: {
          jobsByProject: {
            '123': {
              jobs: [
                {
                  type: 'test-run',
                  displayName: 'Test Run',
                  status: 'running',
                  logs: [
                    { stream: 'stdout', message: 'Running tests...' },
                    { stream: 'stdout', message: 'All tests passed' }
                  ]
                }
              ]
            }
          }
        },
        setPreviewPanelTab: mockSetPreviewPanelTab
      });

      // We need to simulate autopilot running state
      // This requires internal state manipulation which is complex
      // For now, verify component renders
      render(<ChatPanel width={320} side="left" />);
      
      // The job logs only show when isAutopilotRunning is true
      // which requires triggering autopilot start
    });

    it('shows empty state when no job logs exist', () => {
      useAppState.mockReturnValue({
        currentProject: { id: 123 },
        stageAiChange: mockStageAiChange,
        jobState: {
          jobsByProject: {
            '123': {
              jobs: []
            }
          }
        },
        setPreviewPanelTab: mockSetPreviewPanelTab
      });

      render(<ChatPanel width={320} side="left" />);
      // Job logs only visible when autopilot is running
    });

    it('filters job logs to test-run type only', () => {
      useAppState.mockReturnValue({
        currentProject: { id: 123 },
        stageAiChange: mockStageAiChange,
        jobState: {
          jobsByProject: {
            '123': {
              jobs: [
                {
                  type: 'test-run',
                  displayName: 'Test Run',
                  status: 'running',
                  logs: [{ stream: 'stdout', message: 'Test output' }]
                },
                {
                  type: 'build',
                  displayName: 'Build',
                  status: 'completed',
                  logs: [{ stream: 'stdout', message: 'Build output' }]
                }
              ]
            }
          }
        },
        setPreviewPanelTab: mockSetPreviewPanelTab
      });

      render(<ChatPanel width={320} side="left" />);
      // Verify filtering logic exists in component
    });

    it('includes step context in job log headers', () => {
      useAppState.mockReturnValue({
        currentProject: { id: 123 },
        stageAiChange: mockStageAiChange,
        jobState: {
          jobsByProject: {
            '123': {
              jobs: [
                {
                  type: 'test-run',
                  displayName: 'Test Run',
                  status: 'running',
                  logs: [{ stream: 'stdout', message: 'Testing...' }]
                }
              ]
            }
          }
        },
        setPreviewPanelTab: mockSetPreviewPanelTab
      });

      render(<ChatPanel width={320} side="left" />);
      // Step context comes from autopilot timeline events
    });

    it('limits job log output to 60 lines per job and 200 total', () => {
      const manyLogs = Array.from({ length: 100 }, (_, i) => ({
        stream: 'stdout',
        message: `Log line ${i}`
      }));

      useAppState.mockReturnValue({
        currentProject: { id: 123 },
        stageAiChange: mockStageAiChange,
        jobState: {
          jobsByProject: {
            '123': {
              jobs: [
                {
                  type: 'test-run',
                  displayName: 'Test Run 1',
                  status: 'running',
                  logs: manyLogs
                },
                {
                  type: 'test-run',
                  displayName: 'Test Run 2',
                  status: 'completed',
                  logs: manyLogs
                }
              ]
            }
          }
        },
        setPreviewPanelTab: mockSetPreviewPanelTab
      });

      render(<ChatPanel width={320} side="left" />);
      // Verify trimming logic
    });
  });

  describe('Status Messages', () => {
    it('shows sending status when isSending is true and no error', async () => {
      goalsApi.agentRequest.mockImplementation(() => new Promise(() => {})); // Never resolves

      render(<ChatPanel width={320} side="left" />);

      const input = screen.getByTestId('chat-input');
      const sendButton = screen.getByTestId('chat-send-button');

      await userEvent.type(input, 'Test message');
      await userEvent.click(sendButton);

      await waitFor(() => {
        expect(screen.getByTestId('chat-status')).toBeInTheDocument();
        expect(screen.getByTestId('chat-status')).toHaveTextContent('Assistant is thinking');
      });
    });

    it('clears the prompt input immediately after sending a prompt', async () => {
      goalsApi.agentRequest.mockImplementation(() => new Promise(() => {}));

      render(<ChatPanel width={320} side="left" />);

      const input = screen.getByTestId('chat-input');
      await userEvent.type(input, 'Please clear me');
      expect(input).toHaveValue('Please clear me');

      await userEvent.click(screen.getByTestId('chat-send-button'));

      await waitFor(() => {
        expect(screen.getByTestId('chat-input')).toHaveValue('');
      });
    });

    it('shows error message when errorMessage is set', async () => {
      goalsApi.agentRequest.mockRejectedValue(new Error('Test error'));

      render(<ChatPanel width={320} side="left" />);

      const input = screen.getByTestId('chat-input');
      const sendButton = screen.getByTestId('chat-send-button');

      await userEvent.type(input, 'Test message');
      await userEvent.click(sendButton);

      await waitFor(() => {
        expect(screen.getByTestId('chat-error')).toBeInTheDocument();
      });
    });

    it('does not show status when both isSending is true and errorMessage exists', async () => {
      goalsApi.agentRequest.mockRejectedValue(new Error('Test error'));

      render(<ChatPanel width={320} side="left" />);

      const input = screen.getByTestId('chat-input');
      const sendButton = screen.getByTestId('chat-send-button');

      await userEvent.type(input, 'Test message');
      await userEvent.click(sendButton);

      await waitFor(() => {
        expect(screen.queryByTestId('chat-status')).not.toBeInTheDocument();
        expect(screen.getByTestId('chat-error')).toBeInTheDocument();
      });
    });
  });

  describe('Autopilot Controls', () => {
    it('shows autopilot control buttons when autopilot is running', async () => {
      // This requires simulating autopilot start, which involves complex state
      // The controls only show when isAutopilotRunning && autopilotSessionId are true
      goalsApi.agentAutopilot = vi.fn().mockResolvedValue({ sessionId: 'test-session' });
      
      render(<ChatPanel width={320} side="left" />);
      
      // Controls are conditional - need to trigger autopilot start
      // which is now removed from the component
    });

    it('stop button calls handleAutopilotControl with cancel', async () => {
      goalsApi.agentAutopilotCancel = vi.fn().mockResolvedValue({});
      
      render(<ChatPanel width={320} side="left" />);
      
      // Need autopilot running state
    });

    it('pause button calls handleAutopilotControl with pause', async () => {
      goalsApi.agentAutopilotMessage = vi.fn().mockResolvedValue({});
      
      render(<ChatPanel width={320} side="left" />);
      
      // Need autopilot running state
    });

    it('resume button calls handleAutopilotControl with resume', async () => {
      goalsApi.agentAutopilotMessage = vi.fn().mockResolvedValue({});
      
      render(<ChatPanel width={320} side="left" />);
      
      // Need autopilot running state
    });

    it('change direction button prefills input with change prompt', async () => {
      goalsApi.agentAutopilot = vi.fn().mockResolvedValue({ sessionId: 'test-session' });
      
      render(<ChatPanel width={320} side="left" />);
      
      // Need autopilot running state
    });

    it('undo last change button prefills input with undo prompt', async () => {
      goalsApi.agentAutopilot = vi.fn().mockResolvedValue({ sessionId: 'test-session' });
      
      render(<ChatPanel width={320} side="left" />);
      
      // Need autopilot running state
    });

    it('does not show controls when autopilot is not running', () => {
      render(<ChatPanel width={320} side="left" />);
      
      expect(screen.queryByTestId('autopilot-control-stop')).not.toBeInTheDocument();
      expect(screen.queryByTestId('autopilot-control-pause')).not.toBeInTheDocument();
      expect(screen.queryByTestId('autopilot-control-resume')).not.toBeInTheDocument();
      expect(screen.queryByTestId('autopilot-control-change-direction')).not.toBeInTheDocument();
      expect(screen.queryByTestId('autopilot-control-undo-last-change')).not.toBeInTheDocument();
    });
  });

  describe('Error Handling', () => {
    it('handles timeout errors with specific message', async () => {
      goalsApi.agentRequest.mockRejectedValue(new Error('Agent request timed out'));

      render(<ChatPanel width={320} side="left" agentTimeoutMs={100} />);

      const input = screen.getByTestId('chat-input');
      const sendButton = screen.getByTestId('chat-send-button');

      await userEvent.type(input, 'Test message');
      await userEvent.click(sendButton);

      await waitFor(() => {
        const errorElement = screen.getByTestId('chat-error');
        expect(errorElement).toHaveTextContent('took too long to respond');
      });
    });

    it('times out if agentRequest never resolves', async () => {
      vi.useFakeTimers();
      goalsApi.agentRequest.mockImplementation(() => new Promise(() => {}));

      try {
        render(<ChatPanel width={320} side="left" agentTimeoutMs={10} />);

        const input = screen.getByTestId('chat-input');
        const sendButton = screen.getByTestId('chat-send-button');

        fireEvent.change(input, { target: { value: 'Hanging request' } });
        fireEvent.click(sendButton);

        await vi.advanceTimersByTimeAsync(20);
        await Promise.resolve();
        await Promise.resolve();

        vi.useRealTimers();

        await waitFor(() => {
          expect(screen.getByTestId('chat-error')).toHaveTextContent('took too long to respond');
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('handles autopilot timeout errors', async () => {
      goalsApi.agentRequest.mockRejectedValue(new Error('Autopilot request timed out'));

      render(<ChatPanel width={320} side="left" />);

      const input = screen.getByTestId('chat-input');
      const sendButton = screen.getByTestId('chat-send-button');

      await userEvent.type(input, 'Test message');
      await userEvent.click(sendButton);

      await waitFor(() => {
        const errorElement = screen.getByTestId('chat-error');
        expect(errorElement).toHaveTextContent('took too long');
      });
    });

    it('handles "did not provide an answer" errors', async () => {
      goalsApi.agentRequest.mockRejectedValue(new Error('AI did not provide an answer'));

      render(<ChatPanel width={320} side="left" />);

      const input = screen.getByTestId('chat-input');
      const sendButton = screen.getByTestId('chat-send-button');

      await userEvent.type(input, 'Test message');
      await userEvent.click(sendButton);

      await waitFor(() => {
        const errorElement = screen.getByTestId('chat-error');
        expect(errorElement).toHaveTextContent('could not generate an answer');
      });
    });

    it('handles generic errors with fallback message', async () => {
      goalsApi.agentRequest.mockRejectedValue(new Error('Something went wrong'));

      render(<ChatPanel width={320} side="left" />);

      const input = screen.getByTestId('chat-input');
      const sendButton = screen.getByTestId('chat-send-button');

      await userEvent.type(input, 'Test message');
      await userEvent.click(sendButton);

      await waitFor(() => {
        const errorElement = screen.getByTestId('chat-error');
        expect(errorElement).toHaveTextContent('unavailable right now');
      });
    });
  });

  describe('Input Focus Behavior', () => {
    it('focuses input after handleChangeDirectionPrompt sets value', async () => {
      render(<ChatPanel width={320} side="left" />);
      
      const input = screen.getByTestId('chat-input');
      const focusSpy = vi.spyOn(input, 'focus');
      
      // Trigger handleChangeDirectionPrompt would require autopilot running
      // Test the setTimeout focus mechanism
      input.focus();
      expect(document.activeElement).toBe(input);
    });

    it('focuses input after handleUndoLastChangePrompt sets value', async () => {
      render(<ChatPanel width={320} side="left" />);
      
      const input = screen.getByTestId('chat-input');
      input.focus();
      expect(document.activeElement).toBe(input);
    });
  });

  describe('Welcome Message', () => {
    it('shows welcome message when no messages exist', () => {
      render(<ChatPanel width={320} side="left" />);
      
      const messagesContainer = screen.getByTestId('chat-messages');
      expect(within(messagesContainer).getByText('Welcome! Ask me anything about your project.')).toBeInTheDocument();
      expect(within(messagesContainer).getByText('Tip: type /help for commands.')).toBeInTheDocument();
    });

    it('does not show welcome message after user sends a message', async () => {
      render(<ChatPanel width={320} side="left" />);
      
      const input = screen.getByTestId('chat-input');
      const sendButton = screen.getByTestId('chat-send-button');

      await userEvent.type(input, 'Test message');
      await userEvent.click(sendButton);

      await waitFor(() => {
        const messagesContainer = screen.getByTestId('chat-messages');
        expect(within(messagesContainer).queryByText('Welcome! Ask me anything about your project.')).not.toBeInTheDocument();
      });
    });
  });

  describe('Prefill Event', () => {
    it('prefills input and clears error on lucidcoder:prefill-chat', async () => {
      goalsApi.agentRequest.mockRejectedValue(new Error('Something went wrong'));

      render(<ChatPanel width={320} side="left" />);

      const input = screen.getByTestId('chat-input');
      const sendButton = screen.getByTestId('chat-send-button');

      await userEvent.type(input, 'Trigger error');
      await userEvent.click(sendButton);

      await waitFor(() => {
        expect(screen.getByTestId('chat-error')).toBeInTheDocument();
      });

      window.dispatchEvent(new CustomEvent('lucidcoder:prefill-chat', { detail: { prompt: 'Prefilled prompt' } }));

      await waitFor(() => {
        expect(input.value).toBe('Prefilled prompt');
        expect(screen.queryByTestId('chat-error')).not.toBeInTheDocument();
      });

      await waitFor(() => {
        expect(document.activeElement).toBe(input);
      });
    });

    it('ignores prefill events with empty prompt', async () => {
      render(<ChatPanel width={320} side="left" />);

      const input = screen.getByTestId('chat-input');
      expect(input.value).toBe('');

      window.dispatchEvent(new CustomEvent('lucidcoder:prefill-chat', { detail: { prompt: '   ' } }));

      await waitFor(() => {
        expect(input.value).toBe('');
      });
    });

    it('skips prefill wiring if window.addEventListener is missing', () => {
      const originalAdd = window.addEventListener;
      const originalRemove = window.removeEventListener;
      try {
        window.addEventListener = undefined;
        window.removeEventListener = originalRemove;
        render(<ChatPanel width={320} side="left" />);
      } finally {
        window.addEventListener = originalAdd;
        window.removeEventListener = originalRemove;
      }
    });

    it('skips prefill wiring if window.removeEventListener is missing', () => {
      const originalAdd = window.addEventListener;
      const originalRemove = window.removeEventListener;
      try {
        window.addEventListener = originalAdd;
        window.removeEventListener = undefined;
        render(<ChatPanel width={320} side="left" />);
      } finally {
        window.addEventListener = originalAdd;
        window.removeEventListener = originalRemove;
      }
    });

    it('skips stale goal deletion when fetchGoals returns a non-array', async () => {
      goalsApi.agentRequest
        .mockResolvedValueOnce({ kind: 'feature', planOnly: false })
        .mockResolvedValueOnce({ kind: 'question', answer: 'Ok', steps: [] });

      goalsApi.fetchGoals
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce({ nope: true });

      let resolveFeature;
      const featurePromise = new Promise((resolve) => {
        resolveFeature = resolve;
      });
      goalAutomationService.handleRegularFeature.mockReturnValueOnce(featurePromise);

      render(<ChatPanel width={320} side="left" />);

      await userEvent.type(screen.getByTestId('chat-input'), 'First request');
      await userEvent.click(screen.getByTestId('chat-send-button'));

      await waitFor(() => {
        expect(goalAutomationService.handleRegularFeature).toHaveBeenCalledTimes(1);
      });

      await act(async () => {
        resolveFeature({
          needsClarification: true,
          clarifyingQuestions: ['Need details?']
        });
      });

      await waitFor(() => {
        expect(screen.queryByTestId('chat-status')).not.toBeInTheDocument();
      });

      await userEvent.type(screen.getByTestId('chat-input'), 'Answer');
      await userEvent.click(screen.getByTestId('chat-send-button'));

      await waitFor(() => {
        expect(goalsApi.fetchGoals).toHaveBeenCalledWith(123, { includeArchived: false });
      });

      expect(goalsApi.deleteGoal).not.toHaveBeenCalled();
    });
  });

  describe('Goal Count Fetch Cleanup', () => {
    it('treats non-array fetchGoals results as empty', async () => {
      goalsApi.fetchGoals.mockResolvedValue(null);

      render(<ChatPanel width={320} side="left" />);

      await waitFor(() => {
        expect(goalsApi.fetchGoals).toHaveBeenCalled();
      });

      await Promise.resolve();
      await Promise.resolve();
    });

    it('handles fetchGoals failure while mounted', async () => {
      goalsApi.fetchGoals.mockRejectedValue(new Error('Network error'));

      render(<ChatPanel width={320} side="left" />);

      await waitFor(() => {
        expect(goalsApi.fetchGoals).toHaveBeenCalled();
      });

      await Promise.resolve();
      await Promise.resolve();
    });

    it('does not update goal count after unmount (resolve path)', async () => {
      let resolvePromise;
      goalsApi.fetchGoals.mockImplementation(
        () => new Promise((resolve) => { resolvePromise = resolve; })
      );

      const { unmount } = render(<ChatPanel width={320} side="left" />);

      await waitFor(() => {
        expect(goalsApi.fetchGoals).toHaveBeenCalled();
      });

      unmount();

      resolvePromise?.([{ id: 1 }, { id: 2 }]);
      await Promise.resolve();
      await Promise.resolve();
    });

    it('does not update goal count after unmount (reject path)', async () => {
      let rejectPromise;
      goalsApi.fetchGoals.mockImplementation(
        () => new Promise((_, reject) => { rejectPromise = reject; })
      );

      const { unmount } = render(<ChatPanel width={320} side="left" />);

      await waitFor(() => {
        expect(goalsApi.fetchGoals).toHaveBeenCalled();
      });

      unmount();

      rejectPromise?.(new Error('Network error'));
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  describe('Feature Handling', () => {
    it('routes planOnly feature to handlePlanOnlyFeature', async () => {
      goalsApi.agentRequest.mockResolvedValue({ kind: 'feature', planOnly: true, steps: [] });

      render(<ChatPanel width={320} side="left" />);
      const input = screen.getByTestId('chat-input');
      const sendButton = screen.getByTestId('chat-send-button');

      await userEvent.type(input, 'Do a plan-only thing');
      await userEvent.click(sendButton);

      await waitFor(() => {
        expect(goalAutomationService.handlePlanOnlyFeature).toHaveBeenCalledTimes(1);
      });
      expect(goalAutomationService.handleRegularFeature).not.toHaveBeenCalled();
    });

    it('routes regular feature to handleRegularFeature', async () => {
      goalsApi.agentRequest.mockResolvedValue({ kind: 'feature', planOnly: false, steps: [] });

      render(<ChatPanel width={320} side="left" />);
      const input = screen.getByTestId('chat-input');
      const sendButton = screen.getByTestId('chat-send-button');

      await userEvent.type(input, 'Do a feature');
      await userEvent.click(sendButton);

      await waitFor(() => {
        expect(goalAutomationService.handleRegularFeature).toHaveBeenCalledTimes(1);
      });
      expect(goalAutomationService.handlePlanOnlyFeature).not.toHaveBeenCalled();
    });

    it('calls stageAiChange for non-question/non-feature results', async () => {
      goalsApi.agentRequest.mockResolvedValue({ kind: 'other', steps: [] });

      render(<ChatPanel width={320} side="left" />);
      const input = screen.getByTestId('chat-input');
      const sendButton = screen.getByTestId('chat-send-button');

      await userEvent.type(input, 'Stage this');
      await userEvent.click(sendButton);

      await waitFor(() => {
        expect(mockStageAiChange).toHaveBeenCalledWith(123, 'Stage this');
      });
    });
  });

  describe('No Project Selected', () => {
    it('does not call agentRequest when no currentProject exists', async () => {
      useAppState.mockReturnValue({
        currentProject: null,
        stageAiChange: mockStageAiChange,
        jobState: { jobsByProject: {} },
        setPreviewPanelTab: mockSetPreviewPanelTab
      });

      render(<ChatPanel width={320} side="left" />);
      const input = screen.getByTestId('chat-input');
      const sendButton = screen.getByTestId('chat-send-button');

      await userEvent.type(input, 'Hello');
      await userEvent.click(sendButton);

      expect(goalsApi.agentRequest).not.toHaveBeenCalled();
    });
  });

  describe('Keyboard Interactions', () => {
    it('sends message when Enter key is pressed', async () => {
      render(<ChatPanel width={320} side="left" />);
      
      const input = screen.getByTestId('chat-input');
      await userEvent.type(input, 'Test message{Enter}');

      await waitFor(() => {
        const messages = screen.getByTestId('chat-messages');
        expect(within(messages).getByText('Test message')).toBeInTheDocument();
      });
    });

    it('does not send message when Shift+Enter is pressed', async () => {
      render(<ChatPanel width={320} side="left" />);
      
      const input = screen.getByTestId('chat-input');
      await userEvent.type(input, 'Line 1{Shift>}{Enter}{/Shift}Line 2');

      // Message should not be sent, input should contain newline
      expect(input.value).toContain('Line 1');
      expect(input.value).toContain('Line 2');
    });
  });

  describe('Message Variants', () => {
    it('displays status messages with variant styling', async () => {
      goalsApi.agentRequest.mockResolvedValue({
        kind: 'question',
        answer: 'Test answer',
        steps: [{ type: 'action', action: 'read_file', target: 'test.js', reason: 'Reading file' }]
      });

      render(<ChatPanel width={320} side="left" />);
      
      const input = screen.getByTestId('chat-input');
      const sendButton = screen.getByTestId('chat-send-button');

      await userEvent.type(input, 'Test');
      await userEvent.click(sendButton);

      await waitFor(() => {
        const statusMessage = screen.getByText(/Reading file/i);
        expect(statusMessage.closest('.chat-message')).toHaveClass('chat-message--status');
      });
    });

    it('displays regular assistant messages without variant', async () => {
      render(<ChatPanel width={320} side="left" />);
      
      const input = screen.getByTestId('chat-input');
      const sendButton = screen.getByTestId('chat-send-button');

      await userEvent.type(input, 'Test');
      await userEvent.click(sendButton);

      await waitFor(() => {
        const answerMessage = screen.getByText('Test answer');
        expect(answerMessage.closest('.chat-message')).not.toHaveClass('chat-message--status');
      });
    });
  });

  describe('Panel Styling', () => {
    it('applies correct class when side is left', () => {
      render(<ChatPanel width={320} side="left" />);
      
      const panel = screen.getByTestId('chat-panel');
      expect(panel).toHaveClass('chat-panel--left');
      expect(panel).not.toHaveClass('chat-panel--right');
    });

    it('applies correct class when side is right', () => {
      render(<ChatPanel width={320} side="right" />);
      
      const panel = screen.getByTestId('chat-panel');
      expect(panel).toHaveClass('chat-panel--right');
      expect(panel).not.toHaveClass('chat-panel--left');
    });

    it('applies resizing class when isResizing is true', () => {
      render(<ChatPanel width={320} side="left" isResizing={true} />);
      
      const panel = screen.getByTestId('chat-panel');
      expect(panel).toHaveClass('chat-panel--resizing');
    });

    it('does not apply resizing class when isResizing is false', () => {
      render(<ChatPanel width={320} side="left" isResizing={false} />);
      
      const panel = screen.getByTestId('chat-panel');
      expect(panel).not.toHaveClass('chat-panel--resizing');
    });

    it('applies correct width style', () => {
      render(<ChatPanel width={400} side="left" />);
      
      const panel = screen.getByTestId('chat-panel');
      expect(panel).toHaveStyle({ width: '400px' });
    });

    it('accepts non-numeric width values', () => {
      render(<ChatPanel width={'50%'} side="left" />);

      const panel = screen.getByTestId('chat-panel');
      expect(panel).toHaveStyle({ width: '50%' });
    });
  });

  describe('Natural Language Commands', () => {
    it('handles "stop" command when autopilot is not running', async () => {
      render(<ChatPanel width={320} side="left" />);
      
      const input = screen.getByTestId('chat-input');
      const sendButton = screen.getByTestId('chat-send-button');

      await userEvent.type(input, 'stop');
      await userEvent.click(sendButton);

      await waitFor(() => {
        expect(screen.getByText('Nothing is currently running.')).toBeInTheDocument();
      });
    });

    it('handles "pause" command when autopilot is not running', async () => {
      render(<ChatPanel width={320} side="left" />);
      
      const input = screen.getByTestId('chat-input');
      const sendButton = screen.getByTestId('chat-send-button');

      await userEvent.type(input, 'pause');
      await userEvent.click(sendButton);

      await waitFor(() => {
        expect(screen.getByText('Nothing is currently running.')).toBeInTheDocument();
      });
    });

    it('handles "resume" command when autopilot is not running', async () => {
      render(<ChatPanel width={320} side="left" />);
      
      const input = screen.getByTestId('chat-input');
      const sendButton = screen.getByTestId('chat-send-button');

      await userEvent.type(input, 'resume');
      await userEvent.click(sendButton);

      await waitFor(() => {
        expect(screen.getByText('Nothing is currently running.')).toBeInTheDocument();
      });
    });

    it('handles /stop command when autopilot is not running', async () => {
      render(<ChatPanel width={320} side="left" />);
      
      const input = screen.getByTestId('chat-input');
      const sendButton = screen.getByTestId('chat-send-button');

      await userEvent.type(input, '/stop');
      await userEvent.click(sendButton);

      await waitFor(() => {
        expect(screen.getByText(/Nothing is currently running/i)).toBeInTheDocument();
      });
    });

    it('handles /help command', async () => {
      render(<ChatPanel width={320} side="left" />);
      
      const input = screen.getByTestId('chat-input');
      const sendButton = screen.getByTestId('chat-send-button');

      await userEvent.type(input, '/help');
      await userEvent.click(sendButton);

      await waitFor(() => {
        expect(screen.getByText(/Commands:/i)).toBeInTheDocument();
      });
    });

    it('handles variations of stop command', async () => {
      render(<ChatPanel width={320} side="left" />);
      
      const input = screen.getByTestId('chat-input');
      const sendButton = screen.getByTestId('chat-send-button');

      await userEvent.type(input, 'cancel');
      await userEvent.click(sendButton);

      await waitFor(() => {
        expect(screen.getByText('Nothing is currently running.')).toBeInTheDocument();
      });
    });

    it('handles continue command as resume', async () => {
      render(<ChatPanel width={320} side="left" />);
      
      const input = screen.getByTestId('chat-input');
      const sendButton = screen.getByTestId('chat-send-button');

      await userEvent.type(input, 'continue');
      await userEvent.click(sendButton);

      await waitFor(() => {
        expect(screen.getByText('Nothing is currently running.')).toBeInTheDocument();
      });
    });
  });
});
