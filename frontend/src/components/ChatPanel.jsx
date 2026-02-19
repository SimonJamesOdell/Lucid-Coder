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
import { ClarificationTracker } from '../utils/ClarificationTracker';
import AutopilotTimeline from './AutopilotTimeline.jsx';
import SettingsModal from './SettingsModal';
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
import {
  createChatMessage,
  callAgentWithTimeout as callAgentWithTimeoutHelper,
  resolveAgentErrorMessage,
  buildAgentDiagnostics
} from './chatPanel/agentUtils.js';
import { buildAutopilotJobLogLines } from './chatPanel/jobLogs.js';
import { updateChatPanelTestHooks } from './chatPanel/testHooks.js';
import {
  ASSISTANT_ASSET_CONTEXT_CHANGED_EVENT,
  clearAssistantAssetContextPaths,
  getAssistantAssetContextPaths
} from '../utils/assistantAssetContext';
import { AUTOMATION_LOG_EVENT } from '../services/goalAutomation/automationUtils';

export { formatAgentStepMessage };

const createSuiteFlags = () => ({ frontend: false, backend: false });

const hasAnySuiteFlag = (flags) => Boolean(flags?.frontend || flags?.backend);

const mergeSuiteFlags = (...flagsList) => {
  const merged = createSuiteFlags();
  for (const flags of flagsList) {
    if (!flags || typeof flags !== 'object') {
      continue;
    }
    if (flags.frontend) {
      merged.frontend = true;
    }
    if (flags.backend) {
      merged.backend = true;
    }
  }
  return merged;
};

const classifyPathSuites = (rawPath, { hasBackend } = {}) => {
  const path = typeof rawPath === 'string' ? rawPath.trim().replace(/\\/g, '/') : '';
  const flags = createSuiteFlags();
  if (!path) {
    return flags;
  }

  if (path.startsWith('frontend/')) {
    flags.frontend = true;
    return flags;
  }
  if (path.startsWith('backend/')) {
    flags.backend = true;
    return flags;
  }
  if (path.startsWith('shared/')) {
    flags.frontend = true;
    flags.backend = Boolean(hasBackend);
    return flags;
  }

  const normalized = path.toLowerCase();
  if (normalized === 'package.json' || normalized === 'version' || normalized === 'changelog.md') {
    flags.frontend = true;
    flags.backend = Boolean(hasBackend);
  }

  return flags;
};

const deriveSuitesFromStagedDiff = (previousSet, currentSet, { hasBackend } = {}) => {
  const touched = createSuiteFlags();
  const prev = previousSet instanceof Set ? previousSet : new Set();
  const curr = currentSet instanceof Set ? currentSet : new Set();

  for (const path of curr) {
    if (!prev.has(path)) {
      Object.assign(touched, mergeSuiteFlags(touched, classifyPathSuites(path, { hasBackend })));
    }
  }
  for (const path of prev) {
    if (!curr.has(path)) {
      Object.assign(touched, mergeSuiteFlags(touched, classifyPathSuites(path, { hasBackend })));
    }
  }

  return touched;
};

const extractFailingSuitesFromFixPayload = (payload, { hasBackend } = {}) => {
  const failing = createSuiteFlags();
  const metadata = payload && typeof payload.childPromptMetadata === 'object' ? payload.childPromptMetadata : null;
  if (metadata) {
    for (const value of Object.values(metadata)) {
      const kind = typeof value?.testFailure?.kind === 'string' ? value.testFailure.kind.toLowerCase() : '';
      if (kind === 'frontend') {
        failing.frontend = true;
      }
      if (kind === 'backend') {
        failing.backend = true;
      }
    }
  }

  if (!hasAnySuiteFlag(failing)) {
    const childPrompts = Array.isArray(payload?.childPrompts) ? payload.childPrompts : [];
    for (const prompt of childPrompts) {
      const text = typeof prompt === 'string' ? prompt.toLowerCase() : '';
      if (text.includes('frontend tests')) {
        failing.frontend = true;
      }
      if (text.includes('backend tests')) {
        failing.backend = true;
      }
    }
  }

  if (!hasBackend) {
    failing.backend = false;
  }

  return failing;
};

const resolveSuitesToRun = ({ hasBackend, executionTouched, stagedTouched, pendingFailures, fallbackAll }) => {
  let suites = createSuiteFlags();
  suites = mergeSuiteFlags(suites, pendingFailures, executionTouched, stagedTouched);

  if (fallbackAll && !hasAnySuiteFlag(suites)) {
    suites = {
      frontend: true,
      backend: Boolean(hasBackend)
    };
  }

  if (!hasBackend) {
    suites.backend = false;
  }

  return suites;
};

const formatAutomationRunMessage = (phase, suites, hasBackend) => {
  const isRerun = phase === 'rerun';
  if (suites.frontend && suites.backend && hasBackend) {
    return isRerun ? 'Re-running frontend + backend tests…' : 'Starting frontend + backend test runs…';
  }
  if (suites.backend && hasBackend) {
    return isRerun ? 'Re-running backend tests…' : 'Starting backend test runs…';
  }
  return isRerun ? 'Re-running frontend tests…' : 'Starting frontend tests…';
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
  const [thinkingTopic, setThinkingTopic] = useState('');
  const [thinkingAutomationTopic, setThinkingAutomationTopic] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [showAgentDebug, setShowAgentDebug] = useState(false);
  const [pendingClarification, setPendingClarification] = useState(null);
  const [clarificationAnswers, setClarificationAnswers] = useState([]);
  const [clarificationPaused, setClarificationPaused] = useState(false);
  const [autoFixHalted, setAutoFixHalted] = useState(() => {
    /* c8 ignore next 3 */
    if (typeof window === 'undefined') {
      return false;
    }
    return window.__lucidcoderAutofixHalted === true;
  });
  const autoFixHaltedRef = useRef(autoFixHalted);
  const clarificationTrackerRef = useRef(new ClarificationTracker());
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
  const filePickerRef = useRef(null);
  const autoFixInFlightRef = useRef(false);
  const autoFixCancelRef = useRef(false);
  const lastAutomatedStagedPathsRef = useRef(new Set());
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

  const createMessage = createChatMessage;

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

  const getCurrentStagedPathSet = useCallback(() => {
    const projectId = currentProject?.id;
    if (!projectId) {
      return new Set();
    }
    const activeBranch = workingBranches?.[projectId];
    const stagedFiles = Array.isArray(activeBranch?.stagedFiles) ? activeBranch.stagedFiles : [];
    return new Set(
      stagedFiles
        .map((entry) => (typeof entry?.path === 'string' ? entry.path.trim() : ''))
        .filter(Boolean)
    );
  }, [currentProject?.id, workingBranches]);

  useEffect(() => {
    lastAutomatedStagedPathsRef.current = getCurrentStagedPathSet();
  }, [currentProject?.id, getCurrentStagedPathSet]);

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

  useEffect(() => {
    if (!pendingClarification?.questions?.length) {
      setClarificationAnswers([]);
      setClarificationPaused(false);
      return;
    }
    setClarificationAnswers(pendingClarification.questions.map(() => ''));
    setClarificationPaused(false);
  }, [pendingClarification]);

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
    autoFixHaltedRef.current = next;
    setAutoFixHalted(next);
  }, []);

  useEffect(() => {
    autoFixHaltedRef.current = autoFixHalted;
  }, [autoFixHalted]);

  const readStoredChat = useCallback((projectId) => {
    return readStoredChatMessages(projectId);
  }, []);

  const toBase64 = useCallback(async (file) => {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;

    for (let index = 0; index < bytes.length; index += chunkSize) {
      const chunk = bytes.subarray(index, index + chunkSize);
      binary += String.fromCharCode(...chunk);
    }

    return btoa(binary);
  }, []);

  const sanitizeUploadFileName = useCallback((name) => {
    const normalized = String(name || 'file').replace(/[\\/]+/g, '-').trim();
    const fallback = normalized || 'file';
    return fallback.replace(/[^a-zA-Z0-9._-]/g, '_');
  }, []);

  const buildUniqueUploadPath = useCallback((fileName, attempt = 0) => {
    const safeName = sanitizeUploadFileName(fileName);
    const dotIndex = safeName.lastIndexOf('.');
    const hasExtension = dotIndex > 0;
    const stem = hasExtension ? safeName.slice(0, dotIndex) : safeName;
    const extension = hasExtension ? safeName.slice(dotIndex) : '';
    const suffix = attempt > 0 ? `-${attempt}` : '';
    return `uploads/${stem}${suffix}${extension}`;
  }, [sanitizeUploadFileName]);

  const createProjectFileFromUpload = useCallback(async (projectId, file, attempt = 0) => {
    const filePath = buildUniqueUploadPath(file.name, attempt);
    const contentBase64 = await toBase64(file);

    try {
      await axios.post(`/api/projects/${projectId}/files-ops/create-file`, {
        filePath,
        contentBase64,
        encoding: 'base64',
        openInEditor: false
      });
      return filePath;
    } catch (error) {
      if (error?.response?.status === 409) {
        return createProjectFileFromUpload(projectId, file, attempt + 1);
      }
      throw error;
    }
  }, [buildUniqueUploadPath, toBase64]);

  const handleAttachFilesClick = useCallback(() => {
    filePickerRef.current?.click?.();
  }, []);

  const handleAttachFilesSelected = useCallback(async (event) => {
    const selected = Array.from(event?.target?.files || []);
    if (!selected.length || !currentProject?.id) {
      if (event?.target) {
        event.target.value = '';
      }
      return;
    }

    setIsSending(true);
    setErrorMessage('');
    try {
      const uploadedPaths = await Promise.all(
        selected.map((file) => createProjectFileFromUpload(currentProject.id, file))
      );

      setPreviewPanelTab?.('assets', { source: 'user' });
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent('lucidcoder:assets-updated', {
          detail: { projectId: currentProject.id, paths: uploadedPaths }
        }));
      }

      setMessages((prev) => [
        ...prev,
        createMessage('assistant', `Added files to project:\n${uploadedPaths.map((path) => `- ${path}`).join('\n')}`, { variant: 'status' })
      ]);
    } catch (error) {
      console.error('Failed to attach files:', error);
      setMessages((prev) => [
        ...prev,
        createMessage('assistant', 'Failed to add one or more files to the project.', { variant: 'error' })
      ]);
    } finally {
      setIsSending(false);
      if (event?.target) {
        event.target.value = '';
      }
    }
  }, [createMessage, createProjectFileFromUpload, currentProject?.id, setPreviewPanelTab]);

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

  const handleClearAssistantContext = useCallback(() => {
    if (!currentProject?.id) {
      return;
    }
    clearAssistantAssetContextPaths(currentProject.id);
    setSelectedAssistantAssetPaths([]);
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
    autoFixCancelRef,
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
    setClarificationAnswers,
    setPendingClarification,
    setClarificationPaused,
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
  const assistantToggleLabel = autopilotIsActive
    ? (autopilotCanResume ? 'Resume' : 'Pause')
    : (autoFixHalted ? 'Resume' : '■');
  const assistantToggleTitle = autopilotIsActive
    ? (autopilotCanResume ? 'Resume autopilot' : 'Pause autopilot')
    : (autoFixHalted ? 'Resume automated test fixing' : 'Stop automated test fixing');
  const assistantToggleDisabled = autopilotIsActive && !autopilotCanPause && !autopilotCanResume;
  const [selectedAssistantAssetPaths, setSelectedAssistantAssetPaths] = useState([]);
  const selectedAssistantAssetPath = selectedAssistantAssetPaths[0] || '';

  useEffect(() => {
    if (!currentProject?.id) {
      setSelectedAssistantAssetPaths([]);
      return;
    }

    setSelectedAssistantAssetPaths(getAssistantAssetContextPaths(currentProject.id));
  }, [currentProject?.id]);

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      typeof window.addEventListener !== 'function' ||
      typeof window.removeEventListener !== 'function'
    ) {
      return undefined;
    }

    const handleAutomationLog = (event) => {
      const bannerText = typeof event?.detail?.bannerText === 'string'
        ? event.detail.bannerText.trim()
        : '';
      if (!bannerText) {
        return;
      }
      setThinkingAutomationTopic(bannerText);
    };

    window.addEventListener(AUTOMATION_LOG_EVENT, handleAutomationLog);
    return () => {
      window.removeEventListener(AUTOMATION_LOG_EVENT, handleAutomationLog);
    };
  }, []);

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      typeof window.addEventListener !== 'function' ||
      typeof window.removeEventListener !== 'function'
    ) {
      return undefined;
    }

    const handleAssistantAssetContextChanged = (event) => {
      if (!currentProject?.id) {
        setSelectedAssistantAssetPaths([]);
        return;
      }

      const detailProjectId = event?.detail?.projectId;
      if (detailProjectId && String(detailProjectId) !== String(currentProject.id)) {
        return;
      }

      const detailPaths = Array.isArray(event?.detail?.paths)
        ? event.detail.paths.filter((path) => typeof path === 'string' && path.trim())
        : getAssistantAssetContextPaths(currentProject.id);

      setSelectedAssistantAssetPaths(detailPaths);
    };

    window.addEventListener(ASSISTANT_ASSET_CONTEXT_CHANGED_EVENT, handleAssistantAssetContextChanged);
    return () => {
      window.removeEventListener(ASSISTANT_ASSET_CONTEXT_CHANGED_EVENT, handleAssistantAssetContextChanged);
    };
  }, [currentProject?.id]);

  const handleAssistantToggle = async () => {
    if (autopilotIsActive) {
      if (autopilotCanResume) {
        await handleAutopilotControl('resume');
      } else if (autopilotCanPause) {
        await handleAutopilotControl('pause');
      }
      return;
    }
    setAutofixHaltFlag(!autoFixHalted);
  };

  const handleClearPendingAgentActions = useCallback(() => {
    autoFixCancelRef.current = true;
    setAutofixHaltFlag(false);
    setThinkingAutomationTopic('');
    setThinkingTopic('');
    setIsSending(false);
    setMessages((prev) => [
      ...prev,
      createMessage('assistant', 'Cleared pending agent actions.', { variant: 'status' })
    ]);
  }, [createMessage, setAutofixHaltFlag]);

  const panelClassName = `chat-panel ${side === 'right' ? 'chat-panel--right' : 'chat-panel--left'} ${isResizing ? 'chat-panel--resizing' : ''}`;
  const panelStyle = {
    width: typeof width === 'number' ? `${width}px` : width
  };

  const callAgentWithTimeout = useCallback(
    ({ projectId, prompt, timeoutMs = agentTimeoutMs }) => callAgentWithTimeoutHelper({
      projectId,
      prompt,
      timeoutMs,
      agentRequestFn: agentRequest
    }),
    [agentTimeoutMs]
  );

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

      const executionTouchTracker = { frontend: false, backend: false, __observed: false };
      const execution = await handleRegularFeature(
        currentProject.id,
        currentProject,
        prompt,
        result,
        setPreviewPanelTab,
        setGoalCount,
        createMessage,
        setMessages,
        { requestEditorFocus, syncBranchOverview, touchTracker: executionTouchTracker }
      );

      if (execution?.needsClarification) {
        if (execution?.clarifyingQuestions?.length) {
          // [FAILURE PREVENTION] Check for duplicate clarifications
          const tracker = clarificationTrackerRef.current;
          const category = `goal_${currentProject.id}`;
          
          const questionsToAsk = [];
          const answersToUse = [];
          
          for (const question of execution.clarifyingQuestions) {
            const questionText = typeof question === 'string' ? question : String(question ?? '');
            if (tracker.hasAsked(category, questionText)) {
              // This question was already asked - use cached answer
              const cachedAnswer = tracker.getAnswer(category, questionText);
              answersToUse.push(cachedAnswer);
              console.log('[Clarification] Using cached answer for:', questionText.slice(0, 50));
            } else {
              // New question - need to ask
              questionsToAsk.push(questionText);
            }
          }
          
          if (questionsToAsk.length === 0 && answersToUse.length > 0) {
            // All questions have cached answers - use them automatically
            console.log('[Clarification] All questions have cached answers - auto-submitting');
            const answerText = execution.clarifyingQuestions
              .map((question, index) => {
                const answer = answersToUse[index];
                return `Q: ${question}\nA: ${answer}`;
              })
              .join('\n\n');
            await submitPrompt(answerText, { origin: 'clarification-cached' });
            return;
          }
          
          // Show modal with questions (new + any we still need to confirm)
          setPendingClarification({
            projectId: currentProject.id,
            prompt,
            questions: questionsToAsk
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

        const currentStagedPaths = getCurrentStagedPathSet();
        const stagedTouchedSuites = deriveSuitesFromStagedDiff(
          lastAutomatedStagedPathsRef.current,
          currentStagedPaths,
          { hasBackend }
        );
        const executionTouchedSuites = executionTouchTracker.__observed
          ? {
              frontend: Boolean(executionTouchTracker.frontend),
              backend: Boolean(executionTouchTracker.backend)
            }
          : null;

        const suitesToRun = resolveSuitesToRun({
          hasBackend,
          executionTouched: executionTouchedSuites,
          stagedTouched: stagedTouchedSuites,
          pendingFailures: null,
          fallbackAll: !executionTouchTracker.__observed
        });

        if (!hasAnySuiteFlag(suitesToRun)) {
          setPreviewPanelTab?.('commits', { source: 'automation' });
          setMessages((prev) => [
            ...prev,
            createMessage(
              'assistant',
              'No frontend/backend files changed since the last passing run. Skipping automated tests.',
              { variant: 'status' }
            )
          ]);
          return;
        }

        setPreviewPanelTab?.('tests', { source: 'automation' });
        setMessages((prev) => [
          ...prev,
          createMessage(
            'assistant',
            formatAutomationRunMessage('start', suitesToRun, hasBackend),
            { variant: 'status' }
          )
        ]);

        markTestRunIntent?.('automation');

        const testJobs = [];
        if (suitesToRun.frontend) {
          testJobs.push(startAutomationJob('frontend:test', { projectId: currentProject.id }));
        }
        if (suitesToRun.backend && hasBackend) {
          testJobs.push(startAutomationJob('backend:test', { projectId: currentProject.id }));
        }
        const settled = await Promise.allSettled(testJobs);
        lastAutomatedStagedPathsRef.current = currentStagedPaths;

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
    getCurrentStagedPathSet,
    hasBackend,
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
    setThinkingAutomationTopic('');
    setThinkingTopic(trimmed);
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
            (() => {
              const originalRequest = typeof pendingClarification.prompt === 'string'
                ? pendingClarification.prompt.trim()
                : '';
              const originalRequestLine = originalRequest.startsWith('Current request:')
                ? originalRequest
                : `Current request: ${originalRequest}`;
              return `Original request: ${originalRequestLine}`;
            })(),
            'Clarification questions:',
            ...pendingClarification.questions.map((question) => `- ${question}`),
            ...(() => {
              const selectedAssetPaths = getAssistantAssetContextPaths(currentProject.id);
              return selectedAssetPaths.length
                ? [
                  'Selected project assets:',
                  ...selectedAssetPaths.map((path) => `- ${path}`),
                  'Asset URL policy: when referencing selected assets in web code, use root-relative URLs like /uploads/<filename>.'
                ]
                : [];
            })(),
            `User answer: ${trimmed}`
          ].join('\n')
          : [
            buildConversationContext(),
            (() => {
              const selectedAssetPaths = getAssistantAssetContextPaths(currentProject.id);
              return selectedAssetPaths.length
                ? [
                  'Selected project assets:',
                  ...selectedAssetPaths.map((path) => `- ${path}`),
                  'Asset URL policy: when referencing selected assets in web code, use root-relative URLs like /uploads/<filename>.'
                ].join('\n')
                : '';
            })(),
            `Current request: ${trimmed}`
          ]
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
        setErrorMessage(resolveAgentErrorMessage(error));
      } finally {
        setThinkingAutomationTopic('');
        setThinkingTopic('');
        setIsSending(false);
      }
    } else {
      setThinkingAutomationTopic('');
      setThinkingTopic('');
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
    const childPromptMetadata = payload && typeof payload.childPromptMetadata === 'object'
      ? payload.childPromptMetadata
      : null;
    const failureContext = payload && typeof payload.failureContext === 'object' ? payload.failureContext : null;
    const failingSuites = extractFailingSuitesFromFixPayload(payload, { hasBackend });

    if (!prompt || !currentProject?.id) {
      return;
    }

    if (autoFixInFlightRef.current) {
      return;
    }

    autoFixInFlightRef.current = true;
    autoFixCancelRef.current = false;
    setErrorMessage('');
    setThinkingAutomationTopic('');
    setThinkingTopic(prompt);
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
          childPrompts,
          childPromptMetadata,
          parentMetadataOverrides: { suppressClarifyingQuestions: true }
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

      const executionTouchTracker = { frontend: false, backend: false, __observed: false };
      const execution = await processGoals(
        goalsToProcess,
        currentProject.id,
        currentProject,
        setPreviewPanelTab,
        setGoalCount,
        createMessage,
        setMessages,
        {
          touchTracker: executionTouchTracker,
          requestEditorFocus,
          syncBranchOverview,
          testFailureContext: childPromptMetadata ? null : failureContext,
          shouldPause: () => autoFixHaltedRef.current,
          shouldCancel: () => autoFixCancelRef.current
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

        const executionTouched = executionTouchTracker.__observed
          ? {
              frontend: Boolean(executionTouchTracker.frontend),
              backend: Boolean(executionTouchTracker.backend)
            }
          : null;
        const currentStagedPaths = getCurrentStagedPathSet();
        const stagedTouchedSuites = deriveSuitesFromStagedDiff(
          lastAutomatedStagedPathsRef.current,
          currentStagedPaths,
          { hasBackend }
        );
        const suitesToRun = resolveSuitesToRun({
          hasBackend,
          executionTouched,
          stagedTouched: stagedTouchedSuites,
          pendingFailures: failingSuites,
          fallbackAll: !hasAnySuiteFlag(failingSuites) && !executionTouchTracker.__observed && !hasAnySuiteFlag(stagedTouchedSuites)
        });

        if (!hasAnySuiteFlag(suitesToRun)) {
          setPreviewPanelTab?.('commits', { source: origin === 'automation' ? 'automation' : 'user' });
          setMessages((prev) => [
            ...prev,
            createMessage(
              'assistant',
              'No frontend/backend files changed since the last passing suite. Skipping test rerun.',
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
            formatAutomationRunMessage('rerun', suitesToRun, hasBackend),
            { variant: 'status' }
          )
        ]);

        // Ensure TestTab can auto-continue the fix loop.
        markTestRunIntent?.('automation');

        const testJobs = [];
        if (suitesToRun.frontend) {
          testJobs.push(startAutomationJob('frontend:test', { projectId: currentProject.id }));
        }
        if (suitesToRun.backend && hasBackend) {
          testJobs.push(startAutomationJob('backend:test', { projectId: currentProject.id }));
        }
        const settled = await Promise.allSettled(testJobs);
        lastAutomatedStagedPathsRef.current = currentStagedPaths;

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
      setThinkingAutomationTopic('');
      setThinkingTopic('');
      setIsSending(false);
      autoFixInFlightRef.current = false;
      setInputValue('');
    }
  }, [
    autoFixHalted,
    createMessage,
    currentProject,
    getCurrentStagedPathSet,
    hasBackend,
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

    const handleAutoFixResume = () => {
      if (autoFixHaltedRef.current) {
        setAutofixHaltFlag(false);
      }
    };

    const handleAutoFixTests = (event) => {
      const payload = event?.detail;
      const prompt = payload?.prompt;
      if (typeof prompt !== 'string' || !prompt.trim()) {
        return;
      }
      const origin = event?.detail?.origin;

      const normalizedOrigin = origin === 'automation' ? 'automation' : 'user';
      if (normalizedOrigin === 'user' && autoFixHaltedRef.current) {
        setAutofixHaltFlag(false);
      }
      runAutomatedTestFixGoal(payload, { origin: normalizedOrigin });
    };

    window.addEventListener('lucidcoder:autofix-resume', handleAutoFixResume);
    window.addEventListener('lucidcoder:autofix-tests', handleAutoFixTests);
    return () => {
      window.removeEventListener('lucidcoder:autofix-resume', handleAutoFixResume);
      window.removeEventListener('lucidcoder:autofix-tests', handleAutoFixTests);
    };
  }, [autoFixHalted, runAutomatedTestFixGoal, setAutofixHaltFlag]);

  const handleSendMessage = async () => {
    await submitPrompt(inputValue, { origin: 'user' });
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleClarificationAnswerChange = (index, value) => {
    setClarificationAnswers((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  };

  const handleClarificationOptionPick = (index, option) => {
    handleClarificationAnswerChange(index, option);
  };

  const handleClarificationSubmit = async () => {
    if (!pendingClarification) {
      return;
    }
    
    // [FAILURE PREVENTION] Record answers for deduplication
    const tracker = clarificationTrackerRef.current;
    
    const answerText = pendingClarification.questions
      .map((question, index) => {
        const questionText = typeof question === 'string' ? question : String(question ?? '');
        const answer = typeof clarificationAnswers[index] === 'string'
          ? clarificationAnswers[index].trim()
          : '';
        
        // Track that we asked this question and record the answer
        const category = `goal_${pendingClarification.projectId || 'default'}`;
        const intent = questionText;
        tracker.record(category, intent, questionText, answer || '(no answer provided)');
        
        return `Q: ${questionText}\nA: ${answer || '(no answer provided)'}`;
      })
      .join('\n\n');

    await submitPrompt(answerText, { origin: 'clarification' });
  };

  if (ChatPanel.__testHooks?.handlers) {
    ChatPanel.__testHooks.handlers.submitPrompt = submitPrompt;
    ChatPanel.__testHooks.handlers.handleClearAssistantContext = handleClearAssistantContext;
    ChatPanel.__testHooks.handlers.handleClarificationSubmit = handleClarificationSubmit;
    ChatPanel.__testHooks.handlers.runAutomatedTestFixGoal = runAutomatedTestFixGoal;
    ChatPanel.__testHooks.handlers.runAgentRequestStream = runAgentRequestStream;
    ChatPanel.__testHooks.handlers.handleAgentResult = handleAgentResult;
    ChatPanel.__testHooks.handlers.sanitizeUploadFileName = sanitizeUploadFileName;
    ChatPanel.__testHooks.handlers.buildUniqueUploadPath = buildUniqueUploadPath;
    ChatPanel.__testHooks.handlers.handleAttachFilesSelected = handleAttachFilesSelected;
  }

  return (
    <div className={panelClassName} style={panelStyle} data-testid="chat-panel">
      <div className="chat-header">
        <h3>AI Assistant</h3>
        <div className="chat-header-actions">
          <button
            type="button"
            className="chat-autofix-toggle"
            data-testid="chat-autofix-toggle"
            onClick={handleAssistantToggle}
            title={assistantToggleTitle}
            disabled={assistantToggleDisabled}
          >
            {assistantToggleLabel}
          </button>
          {!autopilotIsActive && autoFixHalted ? (
            <button
              type="button"
              className="chat-autofix-clear"
              data-testid="chat-autofix-clear"
              onClick={handleClearPendingAgentActions}
              title="Clear pending agent actions"
            >
              Clear
            </button>
          ) : null}
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
        {isSending ? (
          <div className="chat-typing" data-testid="chat-typing">
            {/* c8 ignore start */}
            {thinkingAutomationTopic || thinkingTopic ? (
              <span className="chat-typing__topic" data-testid="chat-typing-topic">
                Thinking about: {thinkingAutomationTopic || thinkingTopic}
              </span>
            ) : null}
            {/* c8 ignore stop */}
            <span className="chat-typing__dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </div>
        ) : null}
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

      {pendingClarification && !clarificationPaused ? (
        <SettingsModal
          isOpen={true}
          onClose={() => setClarificationPaused(true)}
          title="Clarification needed"
          subtitle="Answer each question so I can continue with the task."
          panelClassName="chat-clarification-modal"
          bodyClassName="chat-clarification-body"
          testId="chat-clarification-modal"
          closeTestId="chat-clarification-close"
        >
          <div className="chat-clarification" data-testid="chat-clarification">
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
                          onClick={() => handleClarificationOptionPick(index, option)}
                        >
                          {option}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <label className="chat-clarification__input-label" htmlFor={`clarification-input-${index}`}>
                    Your answer
                  </label>
                  <textarea
                    id={`clarification-input-${index}`}
                    className="chat-clarification__input"
                    rows={2}
                    value={clarificationAnswers[index] || ''}
                    onChange={(event) => handleClarificationAnswerChange(index, event.target.value)}
                  />
                </div>
              );
            })}
            <div className="chat-clarification__footer">
              <button
                type="button"
                className="chat-clarification__cancel"
                onClick={() => setClarificationPaused(true)}
              >
                Close for now
              </button>
              <button
                type="button"
                className="chat-clarification__submit"
                onClick={handleClarificationSubmit}
                disabled={clarificationAnswers.some((answer) => !String(answer || '').trim())}
              >
                Submit answers
              </button>
            </div>
          </div>
        </SettingsModal>
      ) : null}

      {pendingClarification && clarificationPaused ? (
        <div className="chat-clarification-paused" data-testid="chat-clarification-paused">
          <span>Clarification paused.</span>
          <div className="chat-clarification-paused__actions">
            <button
              type="button"
              className="chat-clarification-cancel"
              onClick={() => {
                setPendingClarification(null);
                setClarificationPaused(false);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="chat-clarification-resume"
              onClick={() => setClarificationPaused(false)}
            >
              Resume clarification
            </button>
          </div>
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

      {selectedAssistantAssetPath ? (
        <div className="chat-context-indicator" data-testid="chat-context-indicator">
          <span className="chat-context-indicator__text">
            Included in context: {selectedAssistantAssetPath}
          </span>
          <button
            type="button"
            className="chat-context-indicator__clear"
            data-testid="chat-context-clear"
            aria-label="Clear included context"
            onClick={handleClearAssistantContext}
          >
            ×
          </button>
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
        <div className="chat-input-actions">
          <button
            data-testid="chat-send-button"
            className="chat-send-button"
            onClick={handleSendMessage}
            disabled={!inputValue.trim() || isSending}
          >
            Send
          </button>
          <button
            type="button"
            data-testid="chat-attach-button"
            className="chat-attach-button"
            onClick={handleAttachFilesClick}
            disabled={isSending || !currentProject?.id}
            aria-label="Add files"
            title="Add files to project"
          >
            +
          </button>
          <input
            ref={filePickerRef}
            type="file"
            multiple
            className="chat-file-picker"
            onChange={handleAttachFilesSelected}
          />
        </div>
      </div>
    </div>
  );
};

ChatPanel.__testHooks = ChatPanel.__testHooks || {};
Object.assign(ChatPanel.__testHooks, {
  getLatestInstance: () => ChatPanel.__testHooks.latestInstance || null,
  clearLatestInstance: () => {
    delete ChatPanel.__testHooks.latestInstance;
  },
  suiteHelpers: {
    classifyPathSuites,
    deriveSuitesFromStagedDiff,
    extractFailingSuitesFromFixPayload,
    resolveSuitesToRun,
    formatAutomationRunMessage
  }
});

export default ChatPanel;
