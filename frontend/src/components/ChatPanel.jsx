import React, { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import { useAppState } from '../context/AppStateContext';
import './ChatPanel.css';
import { agentRequest, fetchGoals, createGoal, createMetaGoalWithChildren } from '../utils/goalsApi';
import { handlePlanOnlyFeature, handleRegularFeature, processGoals } from '../services/goalAutomationService';
import { isNaturalLanguageCancel, isNaturalLanguagePause, isNaturalLanguageResume, handleChatCommand } from '../utils/chatCommandHelpers';
import { shouldSkipAutomationTests as shouldSkipAutomationTestsHelper } from './chatPanelCssOnly';

export const formatAgentStepMessage = (step) => {
  if (!step || typeof step !== 'object') {
    return null;
  }

  if (step.type === 'action') {
    if (step.action === 'read_file') {
      const target = step.target || 'a file';
      if (step.reason) {
        return `Agent is reading ${target} (${step.reason}).`;
      }
      return `Agent is reading ${target}.`;
    }
    return `Agent is performing action: ${step.action}.`;
  }

  if (step.type === 'observation') {
    if (step.action === 'read_file') {
      if (step.error) {
        return `Agent could not read ${step.target || 'file'}: ${step.error}`;
      }
      return null;
    }
    if (step.error) {
      return `Agent observation error: ${step.error}`;
    }
    return `Agent observation: ${step.summary || 'No details provided.'}`;
  }

  return null;
};

const ChatPanel = ({
  width = 320,
  side = 'left',
  onToggleSide,
  isResizing = false,
  agentTimeoutMs = 20000
}) => {
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [goalCount, setGoalCount] = useState(0);
  const [isSending, setIsSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [autoFixHalted, setAutoFixHalted] = useState(() => {
    /* c8 ignore next 3 */
    if (typeof window === 'undefined') {
      return false;
    }
    return window.__lucidcoderAutofixHalted === true;
  });
  const {
    currentProject,
    stageAiChange,
    setPreviewPanelTab,
    startAutomationJob,
    markTestRunIntent,
    requestEditorFocus,
    syncBranchOverview,
    workingBranches
  } = useAppState();
  const inputRef = useRef(null);
  const autoFixInFlightRef = useRef(false);
  const autoFixCancelRef = useRef(false);

  const shouldSkipAutomationTests = useCallback(() => {
    return shouldSkipAutomationTestsHelper({
      currentProject,
      workingBranches,
      syncBranchOverview
    });
  }, [currentProject, syncBranchOverview, workingBranches]);

  const setAutofixHaltFlag = useCallback((value) => {
    const next = value === true;
    if (typeof window !== 'undefined') {
      window.__lucidcoderAutofixHalted = next;
    }
    setAutoFixHalted(next);
    if (next) {
      autoFixCancelRef.current = true;
    }
  }, []);

  useEffect(() => {
    const projectId = currentProject?.id;
    if (!projectId) {
      setGoalCount(0);
      return undefined;
    }

    let disposed = false;

    fetchGoals(projectId)
      .then((data) => {
        if (disposed) {
          return;
        }
        setGoalCount(Array.isArray(data) ? data.length : 0);
      })
      .catch(() => {
        if (disposed) {
          return;
        }
        setGoalCount(0);
      });

    return () => {
      disposed = true;
    };
  }, [currentProject?.id]);

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      typeof window.addEventListener !== 'function' ||
      typeof window.removeEventListener !== 'function'
    ) {
      return undefined;
    }

    const handlePrefill = (event) => {
      const prompt = event?.detail?.prompt;
      if (typeof prompt !== 'string' || !prompt.trim()) {
        return;
      }
      setInputValue(prompt);
      setErrorMessage('');
      setTimeout(() => {
        inputRef.current?.focus?.();
      }, 0);
    };

    window.addEventListener('lucidcoder:prefill-chat', handlePrefill);
    return () => {
      window.removeEventListener('lucidcoder:prefill-chat', handlePrefill);
    };
  }, []);

  const createMessage = (sender, text, options = {}) => ({ id: `${sender}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text, sender, timestamp: new Date(), variant: options.variant || null });

  const panelClassName = `chat-panel ${side === 'right' ? 'chat-panel--right' : 'chat-panel--left'} ${isResizing ? 'chat-panel--resizing' : ''}`;
  const panelStyle = {
    width: typeof width === 'number' ? `${width}px` : width
  };

  const callAgentWithTimeout = async ({ projectId, prompt, timeoutMs = agentTimeoutMs }) => {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error('Agent request timed out'));
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([
        agentRequest({ projectId, prompt }),
        timeoutPromise
      ]);
      return result;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  };

  const appendAgentSteps = (steps = []) => {
    if (!Array.isArray(steps) || steps.length === 0) {
      return;
    }

    const formattedMessages = steps
      .map(formatAgentStepMessage)
      .filter(Boolean)
      .map((text) => createMessage('assistant', text, { variant: 'status' }));

    if (formattedMessages.length > 0) {
      setMessages((prev) => [...prev, ...formattedMessages]);
    }
  };

  const submitPrompt = useCallback(async (rawPrompt, { origin = 'user' } = {}) => {
    const trimmed = rawPrompt.trim();
    if (!trimmed) {
      return;
    }

    setInputValue('');
    setMessages((prev) => [...prev, createMessage('user', trimmed)]);

    // Handle natural language stop/pause/resume commands.
    if (isNaturalLanguageCancel(trimmed)) {
      setMessages((prev) => [...prev, createMessage('assistant', 'Nothing is currently running.', { variant: 'status' })]);
      setInputValue('');
      return;
    }

    if (isNaturalLanguagePause(trimmed) || isNaturalLanguageResume(trimmed)) {
      setMessages((prev) => [...prev, createMessage('assistant', 'Nothing is currently running.', { variant: 'status' })]);
      setInputValue('');
      return;
    }

    const commandResult = handleChatCommand(trimmed);
    if (commandResult?.handled) {
      if (commandResult.action === 'help') {
        setMessages((prev) => [
          ...prev,
          createMessage(
            'assistant',
            'Commands: /stop (or just type "stop")',
            { variant: 'status' }
          )
        ]);
      } else if (commandResult.action === 'cancel') {
        setMessages((prev) => [...prev, createMessage('assistant', 'Nothing is currently running.', { variant: 'status' })]);
      }
      setInputValue('');
      return;
    }

    setErrorMessage('');
    setIsSending(true);

    if (currentProject?.id) {
      try {
        const result = await callAgentWithTimeout({ projectId: currentProject.id, prompt: trimmed });

        if (Array.isArray(result.steps)) {
          appendAgentSteps(result.steps);
        }

        if (result.kind === 'question' && result.answer) {
          setMessages((prev) => [...prev, createMessage('assistant', result.answer)]);
        }

        if (result.kind === 'feature') {
          if (result.planOnly) {
            await handlePlanOnlyFeature(
              currentProject.id,
              currentProject,
              trimmed,
              setPreviewPanelTab,
              setGoalCount,
              createMessage,
              setMessages,
              { requestEditorFocus, syncBranchOverview }
            );
            return;
          }

          const execution = await handleRegularFeature(
            currentProject.id,
            currentProject,
            trimmed,
            result,
            setPreviewPanelTab,
            setGoalCount,
            createMessage,
            setMessages,
            { requestEditorFocus, syncBranchOverview }
          );

          if (execution?.success === true && typeof startAutomationJob === 'function') {
            const skipCssTests = await shouldSkipAutomationTests();
            if (skipCssTests) {
              setPreviewPanelTab?.('commits', { source: 'automation' });
              setMessages((prev) => [
                ...prev,
                createMessage('assistant', 'CSS-only update detected. Skipping automated test run and moving to commit stage.', { variant: 'status' })
              ]);
              return;
            }

            setPreviewPanelTab?.('tests', { source: 'automation' });
            setMessages((prev) => [
              ...prev,
              createMessage('assistant', 'Starting frontend + backend test runs…', { variant: 'status' })
            ]);

            // These suites are started automatically as part of an agent run.
            markTestRunIntent?.('automation');

            const settled = await Promise.allSettled([
              startAutomationJob('frontend:test', { projectId: currentProject.id }),
              startAutomationJob('backend:test', { projectId: currentProject.id })
            ]);

            const firstFailure = settled.find((entry) => entry.status === 'rejected');
            if (firstFailure && firstFailure.status === 'rejected') {
              const message = firstFailure.reason?.message || 'Failed to start automated test run.';
              setMessages((prev) => [
                ...prev,
                createMessage('assistant', message, { variant: 'error' })
              ]);
            }
          }
          return;
        }

        if (result.kind !== 'question' && result.kind !== 'feature' && stageAiChange) {
          await stageAiChange(currentProject.id, trimmed);
        }
      } catch (error) {
        console.warn('Failed to stage AI request', error);
        if (error.message && /timed out/i.test(error.message)) {
          setErrorMessage('The AI assistant took too long to respond. Please try again.');
        } else if (error.message && /did not provide an answer/i.test(error.message)) {
          setErrorMessage('The AI assistant could not generate an answer for that question. Please try rephrasing or be more specific.');
        } else {
          setErrorMessage('Sorry, the AI assistant is unavailable right now. Please try again.');
        }
      } finally {
        setIsSending(false);
      }
    } else {
      setIsSending(false);
    }
  }, [
    appendAgentSteps,
    callAgentWithTimeout,
    createMessage,
    currentProject,
    markTestRunIntent,
    setPreviewPanelTab,
    stageAiChange,
    shouldSkipAutomationTests,
    startAutomationJob
  ]);

  const runAutomatedTestFixGoal = useCallback(async (payload, { origin = 'automation' } = {}) => {
    const prompt = payload.prompt.trim();
    const childPrompts = Array.isArray(payload?.childPrompts)
      ? payload.childPrompts.map((value) => (typeof value === 'string' ? value.trim() : '')).filter(Boolean)
      : [];
    const failureContext = payload && typeof payload.failureContext === 'object' ? payload.failureContext : null;

    if (!prompt || !currentProject?.id) {
      return;
    }

    // When halted, ignore automation-driven retries (but still allow user-driven fixes).
    if (autoFixHalted && origin === 'automation') {
      return;
    }

    if (autoFixInFlightRef.current) {
      return;
    }

    autoFixInFlightRef.current = true;
    autoFixCancelRef.current = false;
    setErrorMessage('');
    setIsSending(true);

    try {
      setMessages((prev) => [
        ...prev,
        createMessage(
          'assistant',
          childPrompts.length > 0
            ? 'Creating fix goals for failing tests…'
            : 'Creating a fix goal for failing tests…',
          { variant: 'status' }
        )
      ]);

      let goalsToProcess = [];
      if (childPrompts.length > 0) {
        const planned = await createMetaGoalWithChildren({
          projectId: currentProject.id,
          prompt,
          childPrompts
        });
        const children = Array.isArray(planned?.children) ? planned.children : [];
        goalsToProcess = children;
        if (goalsToProcess.length === 0) {
          // Defensive fallback: if the backend returns no children, treat parent as the single goal.
          const parent = planned?.parent;
          if (parent?.id) {
            goalsToProcess = [parent];
          }
        }
      } else {
        const created = await createGoal(currentProject.id, prompt);
        const goal = created?.goal;
        if (!goal?.id) {
          throw new Error('Failed to create a goal for fixing failing tests.');
        }
        goalsToProcess = [goal];
      }

      if (goalsToProcess.length === 0) {
        throw new Error('Failed to create goals for fixing failing tests.');
      }

      if (autoFixCancelRef.current) {
        setMessages((prev) => [
          ...prev,
          createMessage('assistant', 'Auto-fix stopped.', { variant: 'status' })
        ]);
        return;
      }

      try {
        const data = await fetchGoals(currentProject.id);
        setGoalCount(Array.isArray(data) ? data.length : 0);
      } catch {
        // Best-effort; goal processing will still proceed.
      }

      const execution = await processGoals(
        goalsToProcess,
        currentProject.id,
        currentProject,
        setPreviewPanelTab,
        setGoalCount,
        createMessage,
        setMessages,
        {
          requestEditorFocus,
          syncBranchOverview,
          testFailureContext: failureContext
        }
      );

      if (autoFixCancelRef.current) {
        setMessages((prev) => [
          ...prev,
          createMessage('assistant', 'Auto-fix stopped.', { variant: 'status' })
        ]);
        return;
      }

      if (execution?.success !== true) {
        setMessages((prev) => [
          ...prev,
          createMessage('assistant', 'Fix goal did not complete successfully.', { variant: 'error' })
        ]);
        return;
      }

      if (typeof startAutomationJob === 'function') {
        const skipCssTests = await shouldSkipAutomationTests();
        if (skipCssTests) {
          setPreviewPanelTab?.('commits', { source: origin === 'automation' ? 'automation' : 'user' });
          setMessages((prev) => [
            ...prev,
            createMessage(
              'assistant',
              'CSS-only update detected. Skipping automated test run and moving to commit stage.',
              { variant: 'status' }
            )
          ]);
          return;
        }

        setPreviewPanelTab?.('tests', { source: origin === 'automation' ? 'automation' : 'user' });
        setMessages((prev) => [
          ...prev,
          createMessage('assistant', 'Re-running frontend + backend tests…', { variant: 'status' })
        ]);

        // Ensure TestTab can auto-continue the fix loop.
        markTestRunIntent?.('automation');

        const settled = await Promise.allSettled([
          startAutomationJob('frontend:test', { projectId: currentProject.id }),
          startAutomationJob('backend:test', { projectId: currentProject.id })
        ]);

        const firstFailure = settled.find((entry) => entry.status === 'rejected');
        if (firstFailure && firstFailure.status === 'rejected') {
          const message = firstFailure.reason?.message || 'Failed to start automated test run.';
          setMessages((prev) => [
            ...prev,
            createMessage('assistant', message, { variant: 'error' })
          ]);
        }
      }
    } catch (error) {
      console.warn('Automated test-fix goal failed', error);
      const message = error?.message || 'Failed to create/run a test-fix goal.';
      setMessages((prev) => [
        ...prev,
        createMessage('assistant', message, { variant: 'error' })
      ]);
    } finally {
      setIsSending(false);
      autoFixInFlightRef.current = false;
      setInputValue('');
    }
  }, [
    autoFixHalted,
    createMessage,
    currentProject,
    markTestRunIntent,
    requestEditorFocus,
    setPreviewPanelTab,
    shouldSkipAutomationTests,
    startAutomationJob,
    syncBranchOverview
  ]);

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      typeof window.addEventListener !== 'function' ||
      typeof window.removeEventListener !== 'function'
    ) {
      return undefined;
    }

    const handleRunPrompt = (event) => {
      const prompt = event?.detail?.prompt;
      if (typeof prompt !== 'string' || !prompt.trim()) {
        return;
      }
      const origin = event?.detail?.origin;
      submitPrompt(prompt, { origin: origin === 'automation' ? 'automation' : 'user' });
    };

    window.addEventListener('lucidcoder:run-prompt', handleRunPrompt);
    return () => {
      window.removeEventListener('lucidcoder:run-prompt', handleRunPrompt);
    };
  }, [submitPrompt]);

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      typeof window.addEventListener !== 'function' ||
      typeof window.removeEventListener !== 'function'
    ) {
      return undefined;
    }

    const handleAutoFixTests = (event) => {
      const payload = event?.detail;
      const prompt = payload?.prompt;
      if (typeof prompt !== 'string' || !prompt.trim()) {
        return;
      }
      const origin = event?.detail?.origin;

      const normalizedOrigin = origin === 'automation' ? 'automation' : 'user';
      runAutomatedTestFixGoal(payload, { origin: normalizedOrigin });
    };

    window.addEventListener('lucidcoder:autofix-tests', handleAutoFixTests);
    return () => {
      window.removeEventListener('lucidcoder:autofix-tests', handleAutoFixTests);
    };
  }, [autoFixHalted, runAutomatedTestFixGoal]);

  const handleSendMessage = async () => {
    await submitPrompt(inputValue, { origin: 'user' });
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  return (
    <div className={panelClassName} style={panelStyle} data-testid="chat-panel">
      <div className="chat-header">
        <h3>AI Assistant</h3>
        <button
          type="button"
          className="chat-autofix-toggle"
          data-testid="chat-autofix-toggle"
          onClick={() => setAutofixHaltFlag(!autoFixHalted)}
          title={autoFixHalted ? 'Resume automated test fixing' : 'Stop automated test fixing'}
        >
          {autoFixHalted ? 'Resume' : 'Stop'}
        </button>
        {onToggleSide && (
          <button
            type="button"
            className="chat-position-toggle"
            onClick={onToggleSide}
            data-testid="chat-position-toggle"
            aria-label={side === 'left' ? 'Move assistant to right side' : 'Move assistant to left side'}
          >
            {side === 'left' ? (
              <svg
                className="chat-toggle-icon"
                viewBox="0 0 16 16"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M5 3.5a.5.5 0 0 1 .8-.4l6 4.5a.5.5 0 0 1 0 .8l-6 4.5a.5.5 0 0 1-.8-.4z" />
              </svg>
            ) : (
              <svg
                className="chat-toggle-icon"
                viewBox="0 0 16 16"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M11 3.5a.5.5 0 0 0-.8-.4l-6 4.5a.5.5 0 0 0 0 .8l6 4.5a.5.5 0 0 0 .8-.4z" />
              </svg>
            )}
          </button>
        )}
      </div>
      
      <div className="chat-messages" data-testid="chat-messages">
        {messages.length === 0 ? (
          <div className="chat-welcome">
            <p>Welcome! Ask me anything about your project.</p>
            <p style={{ opacity: 0.8, fontSize: 12, marginTop: 6 }}>Tip: type /help for commands.</p>
          </div>
        ) : (
          messages.map(message => (
            <div
              key={message.id}
              className={`chat-message ${message.sender} ${message.variant ? `chat-message--${message.variant}` : ''}`}
            >
              <div className={`message-content ${message.variant === 'status' ? 'message-content--status' : ''}`}>
                {message.text}
              </div>
              <div className="message-time">
                {message.timestamp.toLocaleTimeString()}
              </div>
            </div>
          ))
        )}
      </div>

      {isSending && !errorMessage && (
        <div className="chat-status" data-testid="chat-status">
          Assistant is thinking about your request...
        </div>
      )}

      {errorMessage && (
        <div className="chat-error" data-testid="chat-error">
          {errorMessage}
        </div>
      )}

      <div className="chat-panel-controls" data-testid="chat-bottom-controls">
      </div>

      <div className="chat-input-container">
        <textarea
          data-testid="chat-input"
          className="chat-input"
          ref={inputRef}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyPress={handleKeyPress}
          placeholder="Ask about your project..."
          rows={3}
        />
        <button
          data-testid="chat-send-button"
          className="chat-send-button"
          onClick={handleSendMessage}
          disabled={!inputValue.trim() || isSending}
        >
          Send
        </button>
      </div>
    </div>
  );
};

export default ChatPanel;
