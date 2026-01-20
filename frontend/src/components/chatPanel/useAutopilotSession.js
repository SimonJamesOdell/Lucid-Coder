import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  agentAutopilotCancel,
  agentAutopilotMessage,
  agentAutopilotResume,
  agentAutopilotStatus,
  readUiSessionId
} from '../../utils/goalsApi';

const AUTOPILOT_STORAGE_KEY = 'lucidcoder.autopilotSession';
const AUTOPILOT_ACTIVE_STATUSES = new Set(['pending', 'running', 'paused']);
const AUTOPILOT_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

const buildAutopilotStepSnapshot = (events) => {
  const safeEvents = Array.isArray(events) ? events : [];
  const planned = [];
  const completed = new Set();
  let current = null;

  for (const evt of safeEvents) {
    if (!evt || typeof evt !== 'object') {
      continue;
    }

    if (evt.type === 'plan') {
      const steps = Array.isArray(evt.payload?.steps) ? evt.payload.steps : [];
      if (steps.length) {
        planned.length = 0;
        for (const raw of steps) {
          const value = typeof raw === 'string' ? raw.trim() : '';
          if (value) {
            planned.push(value);
          }
        }
      }
      continue;
    }

    if (evt.type === 'step:start') {
      const prompt = typeof evt.payload?.prompt === 'string' ? evt.payload.prompt.trim() : '';
      if (prompt) {
        current = prompt;
      }
      continue;
    }

    if (evt.type === 'step:done') {
      const prompt = typeof evt.payload?.prompt === 'string' ? evt.payload.prompt.trim() : '';
      if (prompt) {
        completed.add(prompt);
        if (current === prompt) {
          current = null;
        }
      }
    }
  }

  let next = null;
  if (planned.length) {
    const startIdx = current ? planned.indexOf(current) + 1 : 0;
    for (let idx = Math.max(0, startIdx); idx < planned.length; idx += 1) {
      const candidate = planned[idx];
      if (candidate && !completed.has(candidate)) {
        next = candidate;
        break;
      }
    }
  }

  return { currentStep: current, nextStep: next };
};

export const useAutopilotSession = ({ currentProjectId }) => {
  const [autopilotSession, setAutopilotSession] = useState(null);
  const [autopilotEvents, setAutopilotEvents] = useState([]);
  const [isAutopilotBusy, setAutopilotBusy] = useState(false);
  const [autopilotStatusNote, setAutopilotStatusNote] = useState('');
  const autopilotPollRef = useRef(null);
  const autopilotResumeAttemptedRef = useRef(false);
  const cancelledRef = useRef(false);

  const autopilotIsActive = useMemo(
    () => Boolean(autopilotSession?.id && AUTOPILOT_ACTIVE_STATUSES.has(autopilotSession.status)),
    [autopilotSession?.id, autopilotSession?.status]
  );

  const autopilotStepSnapshot = useMemo(() => buildAutopilotStepSnapshot(autopilotEvents), [autopilotEvents]);

  const stopAutopilotPoller = useCallback(() => {
    if (autopilotPollRef.current) {
      clearTimeout(autopilotPollRef.current);
      autopilotPollRef.current = null;
    }
  }, []);

  const clearStoredAutopilotSession = useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      window.sessionStorage?.removeItem?.(AUTOPILOT_STORAGE_KEY);
    } catch {
      // Ignore storage failures.
    }
  }, []);

  const persistAutopilotSession = useCallback((session) => {
    if (typeof window === 'undefined' || !session?.id || !currentProjectId) {
      return;
    }
    if (!AUTOPILOT_ACTIVE_STATUSES.has(session.status)) {
      return;
    }
    try {
      window.sessionStorage?.setItem?.(
        AUTOPILOT_STORAGE_KEY,
        JSON.stringify({ sessionId: session.id, projectId: currentProjectId })
      );
    } catch {
      // Ignore storage failures.
    }
  }, [currentProjectId]);

  const loadStoredAutopilotSession = useCallback(() => {
    if (typeof window === 'undefined' || !currentProjectId) {
      return null;
    }
    try {
      const raw = window.sessionStorage?.getItem?.(AUTOPILOT_STORAGE_KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw);
      if (!parsed?.sessionId) {
        return null;
      }
      if (parsed.projectId && String(parsed.projectId) !== String(currentProjectId)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }, [currentProjectId]);

  const applyAutopilotSummary = useCallback((summary, { persist = true } = {}) => {
    if (!summary) {
      stopAutopilotPoller();
      setAutopilotSession(null);
      setAutopilotEvents([]);
      setAutopilotStatusNote('');
      clearStoredAutopilotSession();
      return null;
    }

    const normalized = {
      ...summary,
      id: String(summary.id || summary.sessionId || ''),
      status: summary.status || 'pending',
      statusMessage: summary.statusMessage || summary.status_message || '',
      events: Array.isArray(summary.events) ? summary.events : []
    };

    setAutopilotSession(normalized);
    setAutopilotEvents(normalized.events);
    setAutopilotStatusNote(normalized.statusMessage || '');

    if (persist) {
      if (AUTOPILOT_ACTIVE_STATUSES.has(normalized.status)) {
        persistAutopilotSession(normalized);
      } else {
        clearStoredAutopilotSession();
      }
    }

    if (AUTOPILOT_TERMINAL_STATUSES.has(normalized.status)) {
      stopAutopilotPoller();
    }

    return normalized;
  }, [clearStoredAutopilotSession, persistAutopilotSession, stopAutopilotPoller]);

  const refreshAutopilotStatus = useCallback(async (sessionId, options = {}) => {
    if (!sessionId || !currentProjectId) {
      return null;
    }

    const delayMs = options.immediate === true ? 1000 : 2000;

    stopAutopilotPoller();
    try {
      const data = await agentAutopilotStatus({ projectId: currentProjectId, sessionId });
      const summary = data?.session || data;
      const normalized = applyAutopilotSummary(summary);
      if (normalized && AUTOPILOT_ACTIVE_STATUSES.has(normalized.status)) {
        autopilotPollRef.current = setTimeout(() => {
          refreshAutopilotStatus(sessionId);
        }, delayMs);
      }
      return normalized;
    } catch (error) {
      console.warn('Failed to refresh autopilot session', error);
      autopilotPollRef.current = setTimeout(() => {
        refreshAutopilotStatus(sessionId);
      }, 4000);
      return null;
    }
  }, [applyAutopilotSummary, currentProjectId, stopAutopilotPoller]);

  const hydrateAutopilot = useCallback(async () => {
    if (!currentProjectId) {
      return;
    }

    const stored = loadStoredAutopilotSession();
    if (stored?.sessionId) {
      await refreshAutopilotStatus(stored.sessionId);
      return;
    }

    if (autopilotResumeAttemptedRef.current) {
      return;
    }

    autopilotResumeAttemptedRef.current = true;
    const uiSessionId = readUiSessionId?.();
    if (!uiSessionId) {
      return;
    }

    try {
      const resumed = await agentAutopilotResume({ projectId: currentProjectId, uiSessionId, limit: 1 });
      if (cancelledRef.current) {
        return;
      }
      const first = resumed?.resumed?.[0];
      if (first?.id) {
        applyAutopilotSummary(first);
        await refreshAutopilotStatus(first.id);
      }
    } catch (error) {
      console.warn('Failed to resume autopilot session', error);
    }
  }, [applyAutopilotSummary, currentProjectId, loadStoredAutopilotSession, refreshAutopilotStatus]);

  useEffect(() => {
    stopAutopilotPoller();

    if (!currentProjectId) {
      setAutopilotSession(null);
      setAutopilotEvents([]);
      setAutopilotStatusNote('');
      clearStoredAutopilotSession();
      return undefined;
    }

    cancelledRef.current = false;
    hydrateAutopilot();

    return () => {
      cancelledRef.current = true;
      autopilotResumeAttemptedRef.current = false;
      stopAutopilotPoller();
    };
  }, [clearStoredAutopilotSession, currentProjectId, hydrateAutopilot, stopAutopilotPoller]);

  useEffect(() => () => {
    stopAutopilotPoller();
  }, [stopAutopilotPoller]);

  const handleAutopilotMessage = useCallback(
    async (message, options = {}) => {
      if (!autopilotSession?.id || !currentProjectId) {
        setAutopilotStatusNote('Autopilot is not running.');
        return null;
      }

      const trimmed = typeof message === 'string' ? message.trim() : '';
      if (!trimmed) {
        return null;
      }

      setAutopilotBusy(true);
      let normalizedResult = null;

      try {
        const data = await agentAutopilotMessage({
          projectId: currentProjectId,
          sessionId: autopilotSession.id,
          message: trimmed,
          kind: options.kind,
          metadata: options.metadata
        });
        const summary = data?.session || data;
        normalizedResult = applyAutopilotSummary(summary);
        if (normalizedResult?.id) {
          refreshAutopilotStatus(normalizedResult.id, { immediate: true });
        }
        setAutopilotStatusNote('Guidance sent to autopilot.');
      } catch (error) {
        console.warn('Failed to send autopilot guidance', error);
        setAutopilotStatusNote('Failed to send guidance to autopilot.');
        normalizedResult = null;
      }

      setAutopilotBusy(false);
      return normalizedResult;
    },
    [applyAutopilotSummary, autopilotSession?.id, currentProjectId, refreshAutopilotStatus]
  );

  const handleAutopilotControl = useCallback(
    async (action) => {
      if (!autopilotSession?.id || !currentProjectId) {
        setAutopilotStatusNote('Autopilot is not running.');
        return;
      }

      const normalizedAction = typeof action === 'string' ? action.trim().toLowerCase() : '';
      const isCancelAction = normalizedAction === 'cancel';
      const isPauseOrResume = normalizedAction === 'pause' || normalizedAction === 'resume';

      if (!isCancelAction && !isPauseOrResume) {
        setAutopilotStatusNote('Unsupported autopilot control.');
        return;
      }

      setAutopilotBusy(true);
      try {
        if (isCancelAction) {
          const data = await agentAutopilotCancel({
            projectId: currentProjectId,
            sessionId: autopilotSession.id,
            reason: 'User requested stop'
          });
          applyAutopilotSummary(data?.session || data);
        } else if (isPauseOrResume) {
          const data = await agentAutopilotMessage({
            projectId: currentProjectId,
            sessionId: autopilotSession.id,
            message: normalizedAction,
            kind: normalizedAction
          });
          applyAutopilotSummary(data?.session || data);
        }

        refreshAutopilotStatus(autopilotSession.id, { immediate: true });
        setAutopilotStatusNote(
          isCancelAction ? 'Autopilot cancellation requested.' : `Autopilot ${normalizedAction} requested.`
        );
      } catch (error) {
        console.warn(`Failed to ${normalizedAction} autopilot`, error);
        setAutopilotStatusNote(`Failed to ${normalizedAction} autopilot.`);
      }

      setAutopilotBusy(false);
    },
    [applyAutopilotSummary, autopilotSession?.id, currentProjectId, refreshAutopilotStatus]
  );

  return {
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
  };
};
