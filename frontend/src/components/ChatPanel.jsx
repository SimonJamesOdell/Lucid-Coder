import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import axios from 'axios';
import { useAppState } from '../context/AppStateContext';
import './ChatPanel.css';
import {
  agentRequest,
  agentRequestStream,
  fetchGoals,
  createGoal,
  createMetaGoalWithChildren,
  agentAutopilot,
  deleteGoal
} from '../utils/goalsApi';
import AutopilotTimeline from './AutopilotTimeline.jsx';
import { handlePlanOnlyFeature, handleRegularFeature, processGoals } from '../services/goalAutomationService';
import { isNaturalLanguageCancel, isNaturalLanguagePause, isNaturalLanguageResume, handleChatCommand } from '../utils/chatCommandHelpers';
import { shouldSkipAutomationTests as shouldSkipAutomationTestsHelper } from './chatPanelCssOnly';
import { useAutopilotSession } from './chatPanel/useAutopilotSession';
import {
  formatAgentStepMessage,
  parseClarificationOptions,
  persistChatMessages,
  readStoredChatMessages
} from './chatPanel/chatPanelUtils';
import { buildAutopilotJobLogLines } from './chatPanel/jobLogs.js';
import { updateChatPanelTestHooks } from './chatPanel/testHooks.js';

export { formatAgentStepMessage };

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
  const [showAgentDebug, setShowAgentDebug] = useState(false);
  const [pendingClarification, setPendingClarification] = useState(null);
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
    workingBranches,
    jobState,
    projectProcesses
  } = useAppState();
  const inputRef = useRef(null);
  const autoFixInFlightRef = useRef(false);
  const autoFixCancelRef = useRef(false);
  const lastProjectIdRef = useRef(null);
  const messagesRef = useRef([]);
  const {
    autopilotSession,
    autopilotEvents,
    autopilotStatusNote,
    autopilotIsActive,
    autopilotStepSnapshot,
    isAutopilotBusy,
    autopilotResumeAttemptedRef,
    setAutopilotBusy,
    setAutopilotStatusNote,
    setAutopilotSession,
    setAutopilotEvents,
    hydrateAutopilot,
    stopAutopilotPoller,
    clearStoredAutopilotSession,
    persistAutopilotSession,
    loadStoredAutopilotSession,
    applyAutopilotSummary,
    refreshAutopilotStatus,
    handleAutopilotMessage,
    handleAutopilotControl
  } = useAutopilotSession({ currentProjectId: currentProject?.id });

  const createMessage = (sender, text, options = {}) => ({
    id: `${sender}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text,
    sender,
    timestamp: new Date(),
    variant: options.variant || null
  });

  const extractClarificationOptions = useCallback((question) => {
    return parseClarificationOptions(question);
  }, []);
  const messagesContainerRef = useRef(null);
  const autoScrollEnabledRef = useRef(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const streamingTimersRef = useRef(new Map());
  const streamingMessageIdRef = useRef(null);
  const streamingTextRef = useRef('');
  /* c8 ignore next */
  const isTestEnv = typeof import.meta !== 'undefined'
    /* c8 ignore next */
    ? import.meta.env?.MODE === 'test'
    /* c8 ignore next */
    : false;
  const prefersReducedMotion = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

  const hasBackend = useMemo(() => {
    const backendCapability = projectProcesses?.capabilities?.backend?.exists;
    if (backendCapability === false) {
      return false;
    }
    const projectBackend = currentProject?.backend;
    if (projectBackend === null) {
      return false;
    }
    if (typeof projectBackend?.exists === 'boolean') {
      return projectBackend.exists;
    }
    return true;
  }, [currentProject?.backend, projectProcesses?.capabilities?.backend?.exists]);

  const isMessagesScrolledToBottom = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) {
      return true;
    }
    const threshold = 24;
    return container.scrollHeight - container.scrollTop - container.clientHeight <= threshold;
  }, []);

  const handleMessagesScroll = useCallback(() => {
    const atBottom = isMessagesScrolledToBottom();
    autoScrollEnabledRef.current = atBottom;
    setShowScrollToBottom(!atBottom);
  }, [isMessagesScrolledToBottom]);

  const scrollMessagesToBottom = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) {
      return;
    }
    container.scrollTop = container.scrollHeight;
    autoScrollEnabledRef.current = true;
    setShowScrollToBottom(false);
  }, []);

  const scrollMessagesToBottomIfEnabled = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container || !autoScrollEnabledRef.current) {
      return;
    }
    container.scrollTop = container.scrollHeight;
    setShowScrollToBottom(false);
  }, []);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) {
      return;
    }
    if (autoScrollEnabledRef.current) {
      container.scrollTop = container.scrollHeight;
      setShowScrollToBottom(false);
    } else {
      setShowScrollToBottom(true);
    }
  }, [messages.length]);

  useEffect(() => () => {
    streamingTimersRef.current.forEach((timerId) => clearInterval(timerId));
    streamingTimersRef.current.clear();
  }, []);

  const resetStreamingMessage = useCallback(() => {
    streamingMessageIdRef.current = null;
    streamingTextRef.current = '';
  }, []);

  const appendStreamingChunk = useCallback((chunk) => {
    if (typeof chunk !== 'string' || !chunk) {
      return;
    }

    if (!streamingMessageIdRef.current) {
      const message = createMessage('assistant', '');
      streamingMessageIdRef.current = message.id;
      streamingTextRef.current = '';
      setMessages((prev) => [...prev, message]);
    }

    streamingTextRef.current += chunk;
    const nextText = streamingTextRef.current;

    setMessages((prev) => prev.map((item) => (
      item.id === streamingMessageIdRef.current ? { ...item, text: nextText } : item
    )));
    scrollMessagesToBottomIfEnabled();
  }, [createMessage, scrollMessagesToBottomIfEnabled, setMessages]);

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

  const readStoredChat = useCallback((projectId) => {
    return readStoredChatMessages(projectId);
  }, []);

  const persistChat = useCallback((projectId, nextMessages) => {
    persistChatMessages(projectId, nextMessages);
  }, []);

  useEffect(() => {
    const projectId = currentProject?.id || null;
    if (projectId === lastProjectIdRef.current) {
      return;
    }
    lastProjectIdRef.current = projectId;
    if (!projectId) {
      setMessages([]);
      return;
    }
    setMessages(readStoredChat(projectId));
  }, [currentProject?.id, readStoredChat]);

  useEffect(() => {
    const projectId = currentProject?.id;
    if (!projectId) {
      return;
    }
    persistChat(projectId, messages);
  }, [currentProject?.id, messages, persistChat]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

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


  useEffect(() => {
    if (ChatPanel.__testHooks) {
      ChatPanel.__testHooks.hydrateAutopilot = hydrateAutopilot;
      return () => {
        delete ChatPanel.__testHooks.hydrateAutopilot;
      };
    }
    return undefined;
  }, [hydrateAutopilot]);

  const handleStartAutopilot = useCallback(async () => {
    const prompt = inputValue.trim();
    if (!prompt) {
      setErrorMessage('Describe the feature you want before starting autopilot.');
      return;
    }
    if (!currentProject?.id) {
      setErrorMessage('Select a project before starting autopilot.');
      return;
    }

    setErrorMessage('');
    setAutopilotBusy(true);
    try {
      const result = await agentAutopilot({ projectId: currentProject.id, prompt });
      const summary = result?.session || result;
      if (!summary?.id) {
        throw new Error('Autopilot session did not return an id.');
      }
      setInputValue('');
      setMessages((prev) => [
        ...prev,
        createMessage('assistant', 'Autopilot is working on that goal.', { variant: 'status' })
      ]);
      const normalized = applyAutopilotSummary(summary);
      if (normalized?.id) {
        refreshAutopilotStatus(normalized.id, { immediate: true });
      }
    } catch (error) {
      console.warn('Failed to start autopilot', error);
      setMessages((prev) => [
        ...prev,
        createMessage('assistant', error?.message || 'Failed to start autopilot.', { variant: 'error' })
      ]);
    } finally {
      setAutopilotBusy(false);
    }
  }, [applyAutopilotSummary, createMessage, currentProject?.id, inputValue, refreshAutopilotStatus, setMessages]);

  const handleChangeDirectionPrompt = useCallback(() => {
    if (!autopilotIsActive) {
      setAutopilotStatusNote('Autopilot must be running before changing direction.');
      return;
    }
    setInputValue((prev) => (prev && prev.trim() ? prev : 'Please change direction by '));
    setTimeout(() => {
      inputRef.current?.focus?.();
    }, 0);
  }, [autopilotIsActive]);

  const handleUndoLastChangePrompt = useCallback(() => {
    if (!autopilotIsActive) {
      setAutopilotStatusNote('Autopilot must be running before undoing a change.');
      return;
    }
    setInputValue('Undo the last change and explain what will be rolled back.');
    setTimeout(() => {
      inputRef.current?.focus?.();
    }, 0);
  }, [autopilotIsActive]);

  updateChatPanelTestHooks(ChatPanel, {
    handleStartAutopilot,
    handleChangeDirectionPrompt,
    handleUndoLastChangePrompt,
    handleAutopilotMessage,
    handleAutopilotControl,
    appendStreamingChunk,
    autopilotResumeAttemptedRef,
    isMessagesScrolledToBottom,
    messagesRef,
    messagesContainerRef,
    scrollMessagesToBottom,
    streamingMessageIdRef,
    streamingTextRef,
    refreshAutopilotStatus,
    stopAutopilotPoller,
    setAutopilotSession,
    setAutopilotEvents,
    clearStoredAutopilotSession,
    persistAutopilotSession,
    loadStoredAutopilotSession,
    applyAutopilotSummary,
    persistChat,
    readStoredChat
  });

  const autopilotJobLogs = useMemo(() => {
    if (!autopilotIsActive || !currentProject?.id) {
      return [];
    }

    const jobs = jobState?.jobsByProject?.[String(currentProject.id)]?.jobs;
    if (!Array.isArray(jobs) || jobs.length === 0) {
      return [];
    }

    return buildAutopilotJobLogLines(jobs);
  }, [autopilotIsActive, currentProject?.id, jobState]);

  const autopilotStatusValue = autopilotSession?.status || 'idle';
  const autopilotCanPause = autopilotStatusValue === 'running';
  const autopilotCanResume = autopilotStatusValue === 'paused';

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

    if (!showAgentDebug) {
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

  const buildAgentDiagnostics = (meta) => {
    if (!meta || typeof meta !== 'object') {
      return null;
    }
    const entries = [];
    if (meta.classificationError) {
      entries.push(`classification: ${meta.classificationError}`);
    }
    if (meta.questionError) {
      entries.push(`question: ${meta.questionError}`);
    }
    if (meta.planningError) {
      entries.push(`planning: ${meta.planningError}`);
    }
    if (meta.fallbackPlanningError) {
      entries.push(`fallback planning: ${meta.fallbackPlanningError}`);
    }
    if (!entries.length) {
      return null;
    }
    return `Diagnostics: ${entries.join(' | ')}`;
  };

  const streamAssistantMessage = useCallback((text, options = {}) => {
    if (typeof text !== 'string' || !text) {
      return;
    }

    if (isTestEnv || prefersReducedMotion) {
      setMessages((prev) => [...prev, createMessage('assistant', text, options)]);
      return;
    }

    const message = createMessage('assistant', '', options);
    const fullText = text;
    setMessages((prev) => [...prev, { ...message, fullText }]);

    const totalLength = fullText.length;
    const chunkSize = Math.max(2, Math.ceil(totalLength / 120));
    let offset = 0;

    const tick = () => {
      offset = Math.min(totalLength, offset + chunkSize);
      const nextText = fullText.slice(0, offset);
      setMessages((prev) => prev.map((item) => (item.id === message.id ? { ...item, text: nextText } : item)));
      scrollMessagesToBottomIfEnabled();

      if (offset >= totalLength) {
        const timerId = streamingTimersRef.current.get(message.id);
        if (timerId) {
          clearInterval(timerId);
          streamingTimersRef.current.delete(message.id);
        }
      }
    };

    tick();
    const timerId = setInterval(tick, 16);
    streamingTimersRef.current.set(message.id, timerId);
  }, [createMessage, isTestEnv, prefersReducedMotion, scrollMessagesToBottomIfEnabled]);

  const runAgentRequestStream = useCallback(async ({ projectId, prompt }) => {
    let result = null;
    let streamError = null;
    await agentRequestStream({
      projectId,
      prompt,
      onChunk: appendStreamingChunk,
      onComplete: (payload) => {
        result = payload;
      },
      onError: (message) => {
        streamError = message || 'Agent request failed';
      }
    });

    if (streamError) {
      throw new Error(streamError);
    }

    if (!result) {
      throw new Error('Streaming request did not return a result');
    }

    return result;
  }, [appendStreamingChunk]);

  const handleAgentResult = useCallback(async (result, { streamedAnswer = false, prompt, resolvedPrompt } = {}) => {
    if (!result) {
      return;
    }

    if (Array.isArray(result.steps)) {
      appendAgentSteps(result.steps);
    }

    if (result.kind === 'question' && result.answer) {
      if (!streamedAnswer) {
        streamAssistantMessage(result.answer);
      } else {
        const streamedText = streamingTextRef.current?.trim() || '';
        const finalText = result.answer.trim();
        if (!streamedText || finalText.length > streamedText.length) {
          streamingTextRef.current = result.answer;
          if (streamingMessageIdRef.current) {
            setMessages((prev) => prev.map((item) => (
              item.id === streamingMessageIdRef.current ? { ...item, text: result.answer } : item
            )));
          } else {
            streamAssistantMessage(result.answer);
          }
        }
      }
      const diagnostics = buildAgentDiagnostics(result.meta);
      if (diagnostics && showAgentDebug) {
        console.warn('[Agent] Diagnostics:', result.meta);
        setMessages((prev) => [...prev, createMessage('assistant', diagnostics, { variant: 'status' })]);
      }
      return;
    }

    if (result.kind === 'feature') {
      if (result.planOnly) {
        await handlePlanOnlyFeature(
          currentProject.id,
          currentProject,
          prompt,
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
        resolvedPrompt,
        result,
        setPreviewPanelTab,
        setGoalCount,
        createMessage,
        setMessages,
        { requestEditorFocus, syncBranchOverview }
      );

      if (execution?.needsClarification) {
        if (execution?.clarifyingQuestions?.length) {
          setPendingClarification({
            projectId: currentProject.id,
            prompt: resolvedPrompt,
            questions: execution.clarifyingQuestions
          });
        }
        return;
      }

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
          createMessage(
            'assistant',
            hasBackend ? 'Starting frontend + backend test runs…' : 'Starting frontend tests…',
            { variant: 'status' }
          )
        ]);

        markTestRunIntent?.('automation');

        const testJobs = [
          startAutomationJob('frontend:test', { projectId: currentProject.id })
        ];
        if (hasBackend) {
          testJobs.push(startAutomationJob('backend:test', { projectId: currentProject.id }));
        }
        const settled = await Promise.allSettled(testJobs);

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
      await stageAiChange(currentProject.id, prompt);
    }
  }, [
    appendAgentSteps,
    createMessage,
    currentProject,
    handlePlanOnlyFeature,
    handleRegularFeature,
    markTestRunIntent,
    requestEditorFocus,
    setMessages,
    setPendingClarification,
    setPreviewPanelTab,
    setGoalCount,
    stageAiChange,
    startAutomationJob,
    shouldSkipAutomationTests,
    streamAssistantMessage,
    syncBranchOverview
  ]);

  const submitPrompt = useCallback(async (rawPrompt, { origin = 'user' } = {}) => {
    const trimmed = typeof rawPrompt === 'string' ? rawPrompt.trim() : '';
    if (!trimmed) {
      return;
    }

    const buildConversationContext = () => {
      const recent = (messagesRef.current || [])
        .filter((msg) => msg?.sender && msg?.text && msg.variant !== 'status')
        .slice(-4);
      if (!recent.length) {
        return '';
      }
      const lines = recent.map((msg) => `${msg.sender === 'assistant' ? 'Assistant' : 'User'}: ${msg.text}`);
      return `Conversation context:\n${lines.join('\n')}`;
    };

    const respondNoRun = () => {
      setMessages((prev) => [
        ...prev,
        createMessage('assistant', 'Nothing is currently running.', { variant: 'status' })
      ]);
    };

    const handleControlCommand = async (action) => {
      if (autopilotIsActive) {
        await handleAutopilotControl(action);
      } else {
        respondNoRun();
      }
    };

    if (isNaturalLanguageCancel(trimmed)) {
      await handleControlCommand('cancel');
      setInputValue('');
      return;
    }

    if (isNaturalLanguagePause(trimmed)) {
      await handleControlCommand('pause');
      setInputValue('');
      return;
    }

    if (isNaturalLanguageResume(trimmed)) {
      await handleControlCommand('resume');
      setInputValue('');
      return;
    }

    const commandResult = handleChatCommand(trimmed);
    if (commandResult?.handled) {
      if (commandResult.action === 'help') {
        setMessages((prev) => [
          ...prev,
          createMessage('assistant', 'Commands: /stop, /pause, /resume', { variant: 'status' })
        ]);
      } else if (commandResult.action === 'cancel') {
        await handleControlCommand('cancel');
      }
      setInputValue('');
      return;
    }

    setInputValue('');
    setMessages((prev) => [...prev, createMessage('user', trimmed)]);

    if (autopilotIsActive) {
      await handleAutopilotMessage(trimmed);
      return;
    }

    setErrorMessage('');
    setIsSending(true);

    if (currentProject?.id) {
      try {
        if (pendingClarification) {
          try {
            const existingGoals = await fetchGoals(currentProject.id, { includeArchived: false });
            const staleGoals = Array.isArray(existingGoals)
              ? existingGoals.filter((goal) =>
                goal?.status === 'planning' || goal?.lifecycleState === 'draft'
              )
              : [];

            await Promise.allSettled(staleGoals.map((goal) => deleteGoal(goal.id)));
          } catch (error) {
            console.warn('Failed to clear stale goals after clarification:', error?.message || error);
          }
        }

        const resolvedPrompt = pendingClarification
          ? [
            `Original request: ${pendingClarification.prompt}`,
            'Clarification questions:',
            ...pendingClarification.questions.map((question) => `- ${question}`),
            `User answer: ${trimmed}`
          ].join('\n')
          : [buildConversationContext(), `Current request: ${trimmed}`]
            .filter(Boolean)
            .join('\n\n');

        if (pendingClarification) {
          setPendingClarification(null);
        }

        let streamedAnswer = false;
        resetStreamingMessage();

        const result = await callAgentWithTimeout({ projectId: currentProject.id, prompt: resolvedPrompt });
        await handleAgentResult(result, {
          streamedAnswer,
          prompt: trimmed,
          resolvedPrompt
        });
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
    autopilotIsActive,
    callAgentWithTimeout,
    createMessage,
    currentProject,
    hasBackend,
    handleAutopilotControl,
    handleAutopilotMessage,
    handleAgentResult,
    markTestRunIntent,
    resetStreamingMessage,
    runAgentRequestStream,
    setPreviewPanelTab,
    stageAiChange,
    shouldSkipAutomationTests,
    startAutomationJob,
    streamAssistantMessage
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
          createMessage(
            'assistant',
            hasBackend ? 'Re-running frontend + backend tests…' : 'Re-running frontend tests…',
            { variant: 'status' }
          )
        ]);

        // Ensure TestTab can auto-continue the fix loop.
        markTestRunIntent?.('automation');

        const testJobs = [
          startAutomationJob('frontend:test', { projectId: currentProject.id })
        ];
        if (hasBackend) {
          testJobs.push(startAutomationJob('backend:test', { projectId: currentProject.id }));
        }
        const settled = await Promise.allSettled(testJobs);

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
    hasBackend,
    markTestRunIntent,
    requestEditorFocus,
    setPreviewPanelTab,
    shouldSkipAutomationTests,
    startAutomationJob,
    syncBranchOverview
  ]);

  if (ChatPanel.__testHooks?.handlers) {
    ChatPanel.__testHooks.handlers.submitPrompt = submitPrompt;
    ChatPanel.__testHooks.handlers.runAutomatedTestFixGoal = runAutomatedTestFixGoal;
    ChatPanel.__testHooks.handlers.runAgentRequestStream = runAgentRequestStream;
    ChatPanel.__testHooks.handlers.handleAgentResult = handleAgentResult;
  }

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
        <div className="chat-header-actions">
          <button
            type="button"
            className="chat-autofix-toggle"
            data-testid="chat-autofix-toggle"
            onClick={() => setAutofixHaltFlag(!autoFixHalted)}
            title={autoFixHalted ? 'Resume automated test fixing' : 'Stop automated test fixing'}
          >
            {autoFixHalted ? 'Resume' : '■'}
          </button>
          <button
            type="button"
            className={`chat-debug-toggle${showAgentDebug ? ' is-active' : ''}`}
            onClick={() => setShowAgentDebug((prev) => !prev)}
            aria-pressed={showAgentDebug}
            data-testid="chat-debug-toggle"
          >
            {showAgentDebug ? 'Hide debug details' : '...'}
          </button>
          {onToggleSide && (
            <button
              type="button"
              className="chat-position-toggle"
              onClick={onToggleSide}
              data-testid="chat-position-toggle"
              aria-label={side === 'left' ? 'Move assistant to right side' : 'Move assistant to left side'}
            >
              <span className="chat-toggle-icon" aria-hidden="true">
                {side === 'left' ? '◧' : '◨'}
              </span>
            </button>
          )}
        </div>
        {isSending ? (
          <div className="chat-typing" data-testid="chat-typing">
            <span className="chat-typing__label">Assistant is thinking</span>
            <span className="chat-typing__dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </div>
        ) : null}
      </div>
      
      <div
        className="chat-messages"
        data-testid="chat-messages"
        ref={messagesContainerRef}
        onScroll={handleMessagesScroll}
      >
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
              <div className="chat-message-row">
                <div className={`message-content ${message.variant === 'status' ? 'message-content--status' : ''}`}>
                  {message.sender === 'assistant' ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {message.text}
                    </ReactMarkdown>
                  ) : (
                    message.text
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
      {showScrollToBottom ? (
        <button
          type="button"
          className="chat-scroll-bottom"
          onClick={scrollMessagesToBottom}
          aria-label="Scroll to latest message"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M8 12L3 7L4.4 5.6L8 9.2L11.6 5.6L13 7L8 12Z" fill="currentColor"/>
          </svg>
        </button>
      ) : null}

      {autopilotSession ? (
        <div className="chat-inspector" data-testid="chat-inspector">
          <details open>
            <summary className="chat-inspector__summary">
              Autopilot · {autopilotSession.statusMessage || autopilotSession.status || 'pending'}
            </summary>
            <div className="chat-inspector__status-rows">
              <div className="chat-inspector__status-row">
                Session ID: {autopilotSession.id}
              </div>
              {autopilotStepSnapshot.currentStep ? (
                <div className="chat-inspector__status-row">
                  Current step: {autopilotStepSnapshot.currentStep}
                </div>
              ) : null}
              {autopilotStepSnapshot.nextStep ? (
                <div className="chat-inspector__status-row">
                  Next step: {autopilotStepSnapshot.nextStep}
                </div>
              ) : null}
            </div>
            <AutopilotTimeline events={autopilotEvents} />
          </details>
        </div>
      ) : null}

      {autopilotIsActive && autopilotJobLogs.length > 0 && (
        <div className="chat-job-logs" data-testid="chat-job-logs">
          <div className="chat-job-logs__title">
            Autopilot test runs
            {autopilotStepSnapshot.currentStep ? ` · ${autopilotStepSnapshot.currentStep}` : ''}
          </div>
          <div className="chat-job-logs__body">
            {autopilotJobLogs.map((line) => (
              <div
                key={line.key}
                className={`chat-job-logs__line${line.variant === 'header' ? ' chat-job-logs__line--header' : ''}`}
              >
                {line.text}
              </div>
            ))}
          </div>
        </div>
      )}

      {pendingClarification ? (
        <div className="chat-clarification" data-testid="chat-clarification">
          <div className="chat-clarification__title">Clarification needed</div>
          {pendingClarification.questions.map((question, index) => {
            const options = extractClarificationOptions(question);
            return (
              <div key={`clarify-${index}`} className="chat-clarification__question">
                <div className="chat-clarification__text">{question}</div>
                {options.length > 0 ? (
                  <div className="chat-clarification__options">
                    {options.map((option) => (
                      <button
                        key={option}
                        type="button"
                        className="chat-clarification__option"
                        onClick={() => submitPrompt(option, { origin: 'clarification-option' })}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {errorMessage && (
        <div className="chat-error" data-testid="chat-error">
          {errorMessage}
        </div>
      )}

      {autopilotIsActive || autopilotStatusNote ? (
        <div className="chat-panel-controls" data-testid="chat-bottom-controls">
          {autopilotIsActive ? (
            <>
              <button
                type="button"
                className="chat-autopilot-button"
                data-testid="autopilot-control-stop"
                onClick={() => handleAutopilotControl('cancel')}
                disabled={isAutopilotBusy}
              >
                Stop
              </button>
              {autopilotCanPause && (
                <button
                  type="button"
                  className="chat-autopilot-button"
                  data-testid="autopilot-control-pause"
                  onClick={() => handleAutopilotControl('pause')}
                  disabled={isAutopilotBusy}
                >
                  Pause
                </button>
              )}
              {autopilotCanResume && (
                <button
                  type="button"
                  className="chat-autopilot-button"
                  data-testid="autopilot-control-resume"
                  onClick={() => handleAutopilotControl('resume')}
                  disabled={isAutopilotBusy}
                >
                  Resume
                </button>
              )}
              <button
                type="button"
                className="chat-autopilot-button"
                data-testid="autopilot-control-change-direction"
                onClick={handleChangeDirectionPrompt}
                disabled={isAutopilotBusy}
              >
                Change Direction
              </button>
              <button
                type="button"
                className="chat-autopilot-button"
                data-testid="autopilot-control-undo-last-change"
                onClick={handleUndoLastChangePrompt}
                disabled={isAutopilotBusy}
              >
                Undo Last Change
              </button>
            </>
          ) : null}
          {autopilotStatusNote ? (
            <div className="chat-autopilot-note" data-testid="autopilot-status-note">
              {autopilotStatusNote}
            </div>
          ) : null}
        </div>
      ) : null}

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

ChatPanel.__testHooks = ChatPanel.__testHooks || {};
Object.assign(ChatPanel.__testHooks, {
  getLatestInstance: () => ChatPanel.__testHooks.latestInstance || null,
  clearLatestInstance: () => {
    delete ChatPanel.__testHooks.latestInstance;
  }
});

export default ChatPanel;
