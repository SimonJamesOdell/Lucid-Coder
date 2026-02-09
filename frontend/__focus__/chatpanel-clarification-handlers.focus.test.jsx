import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChatPanel from '../src/components/ChatPanel';
import { useAppState } from '../src/context/AppStateContext';
import * as goalsApi from '../src/utils/goalsApi';
import * as goalAutomationService from '../src/services/goalAutomationService';
import { io } from 'socket.io-client';
import axios from 'axios';

vi.mock('../src/context/AppStateContext');
vi.mock('../src/utils/goalsApi');
vi.mock('../src/services/goalAutomationService', () => ({
  handlePlanOnlyFeature: vi.fn(),
  handleRegularFeature: vi.fn(),
  processGoals: vi.fn()
}));
vi.mock('socket.io-client');
vi.mock('axios');

let mockSocket;
const mockStageAiChange = vi.fn();
const mockSetPreviewPanelTab = vi.fn();
const mockStartAutomationJob = vi.fn();
const mockMarkTestRunIntent = vi.fn();

describe('ChatPanel clarification handlers', () => {
  beforeEach(() => {
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
    goalsApi.agentRequest.mockResolvedValue({ kind: 'question', answer: 'Ok', steps: [] });
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

    axios.get.mockResolvedValue({ data: {} });
    axios.post.mockResolvedValue({ data: {} });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete window.__lucidcoderAutofixHalted;
  });

  it('closes the clarification modal via the SettingsModal close button', async () => {
    goalsApi.agentRequest
      .mockResolvedValueOnce({ kind: 'feature', planOnly: false })
      .mockResolvedValueOnce({ kind: 'question', answer: 'Ok', steps: [] });

    let resolveFeature;
    const featurePromise = new Promise((resolve) => {
      resolveFeature = resolve;
    });
    goalAutomationService.handleRegularFeature.mockReturnValueOnce(featurePromise);

    render(<ChatPanel width={320} side="left" />);

    await userEvent.type(screen.getByTestId('chat-input'), 'First request');
    await userEvent.click(screen.getByTestId('chat-send-button'));

    await act(async () => {
      resolveFeature({
        needsClarification: true,
        clarifyingQuestions: ['Pick one:\n- Option A\n- Option B']
      });
    });

    const closeButton = await screen.findByTestId('chat-clarification-close');
    await userEvent.click(closeButton);

    expect(await screen.findByTestId('chat-clarification-paused')).toBeInTheDocument();
  });

  it('updates clarification text input on change', async () => {
    goalsApi.agentRequest
      .mockResolvedValueOnce({ kind: 'feature', planOnly: false })
      .mockResolvedValueOnce({ kind: 'question', answer: 'Ok', steps: [] });

    let resolveFeature;
    const featurePromise = new Promise((resolve) => {
      resolveFeature = resolve;
    });
    goalAutomationService.handleRegularFeature.mockReturnValueOnce(featurePromise);

    render(<ChatPanel width={320} side="left" />);

    await userEvent.type(screen.getByTestId('chat-input'), 'First request');
    await userEvent.click(screen.getByTestId('chat-send-button'));

    await act(async () => {
      resolveFeature({
        needsClarification: true,
        clarifyingQuestions: ['Describe the expected behavior']
      });
    });

    const answerField = await screen.findByLabelText('Your answer');
    await userEvent.type(answerField, 'It should do the thing.');
    expect(answerField).toHaveValue('It should do the thing.');
  });
});
