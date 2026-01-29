import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import './PreviewTab.css';

const PORT_MAP = {
  react: 5173,
  vue: 5173,
  nextjs: 3000,
  angular: 4200
};

export const normalizeHostname = (value) => {
  if (typeof value !== 'string') {
    return 'localhost';
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return 'localhost';
  }

  if (trimmed === '0.0.0.0') {
    return 'localhost';
  }

  return trimmed;
};

export const getDevServerOriginFromWindow = ({ port, hostnameOverride } = {}) => {
  if (typeof window === 'undefined') {
    return null;
  }

  if (!Number.isInteger(port) || port <= 0) {
    return null;
  }

  const protocol = window.location?.protocol || 'http:';
  const hostname = normalizeHostname(hostnameOverride || window.location?.hostname || 'localhost');
  return `${protocol}//${hostname}:${port}`;
};

const PreviewTab = forwardRef(
  (
    {
      project,
      processInfo,
      onRestartProject,
      onRefreshProcessStatus,
      onReloadPreview,
      onOpenInNewTab,
      autoStartOnNotRunning = true,
      isProjectStopped = false,
      onPreviewNavigated
    },
    ref
  ) => {
  const [iframeError, setIframeError] = useState(false);
  const [iframeLoading, setIframeLoading] = useState(false);
  const [pendingIframeError, setPendingIframeError] = useState(false);
  const [hasConfirmedPreview, setHasConfirmedPreview] = useState(false);
  const [iframeKey, setIframeKey] = useState(0);
    const [previewContextMenu, setPreviewContextMenu] = useState(null);
  const [restartStatus, setRestartStatus] = useState(null);
  const [previewFailureDetails, setPreviewFailureDetails] = useState(null);
  const [startInFlight, setStartInFlight] = useState(false);
  const [hostnameOverride, setHostnameOverride] = useState(null);
  const [previewUrlOverride, setPreviewUrlOverride] = useState(null);
  const [autoRecoverState, setAutoRecoverState] = useState({
    attempt: 0,
    mode: 'idle'
  });
  const [autoRecoverDisabled, setAutoRecoverDisabled] = useState(false);
  const autoRecoverDisabledRef = useRef(autoRecoverDisabled);
  const reloadTimeoutRef = useRef(null);
  const loadTimeoutRef = useRef(null);
  const errorConfirmTimeoutRef = useRef(null);
  const autoRecoverTimeoutRef = useRef(null);
  const autoRecoverAttemptRef = useRef(0);
  const errorGraceUntilRef = useRef(0);
  const proxyPlaceholderFirstSeenRef = useRef(0);
  const proxyPlaceholderLoadCountRef = useRef(0);
  const iframeRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    autoRecoverDisabledRef.current = autoRecoverDisabled;
  }, [autoRecoverDisabled]);

  const guessBackendOrigin = () => {
    if (typeof window === 'undefined') {
      return '';
    }

    const origin = window.location?.origin || '';
    const hostname = window.location?.hostname || 'localhost';
    const protocol = window.location?.protocol || 'http:';
    const port = window.location?.port || '';

    const resolvedHostname = normalizeHostname(hostnameOverride || hostname);

    // Dev default: the LucidCoder frontend runs on 3000 and the backend runs on 5000.
    if ((port === '3000' || port === '5173') && resolvedHostname) {
      return `${protocol}//${resolvedHostname}:5000`;
    }

    if (hostnameOverride) {
      const suffix = port ? `:${port}` : '';
      return `${protocol}//${resolvedHostname}${suffix}`;
    }

    return origin;
  };

  useEffect(() => {
    return () => {
      if (reloadTimeoutRef.current) {
        clearTimeout(reloadTimeoutRef.current);
        reloadTimeoutRef.current = null;
      }

      if (loadTimeoutRef.current) {
        clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
      }

      if (errorConfirmTimeoutRef.current) {
        clearTimeout(errorConfirmTimeoutRef.current);
        errorConfirmTimeoutRef.current = null;
      }

      if (autoRecoverTimeoutRef.current) {
        clearTimeout(autoRecoverTimeoutRef.current);
        autoRecoverTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    autoRecoverAttemptRef.current = Number(autoRecoverState.attempt) || 0;
  }, [autoRecoverState.attempt]);

  useEffect(() => {
    /* v8 ignore next */
    if (typeof window === 'undefined') {
      return;
    }

    if (!previewContextMenu) {
      return;
    }

    const handlePointerDown = () => {
      setPreviewContextMenu(null);
    };

    const handleEscape = (event) => {
      if (event?.key === 'Escape') {
        setPreviewContextMenu(null);
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [previewContextMenu]);

  const normalizeStatus = (status) => (status ? status : 'idle');

  const isProcessInfoCurrent = Boolean(project?.id && processInfo?.projectId === project.id);
  const resolvedPorts = isProcessInfoCurrent ? processInfo?.ports : null;

  const frontendProcess = isProcessInfoCurrent ? processInfo?.processes?.frontend : null;
  const frontendRawStatus = normalizeStatus(frontendProcess?.status);
  const frontendHasActivity = Boolean(
    frontendProcess?.port ||
    frontendProcess?.lastHeartbeat ||
    (Array.isArray(frontendProcess?.logs) && frontendProcess.logs.length > 0)
  );
  const frontendDisplayStatus =
    frontendRawStatus === 'starting' && frontendHasActivity ? 'running' : frontendRawStatus;

  const isFrontendReadyForPreview = Boolean(
    isProcessInfoCurrent &&
    (frontendDisplayStatus === 'running' || frontendDisplayStatus === 'starting')
  );

  // When processInfo is missing or stale (e.g. right after a hard refresh or project switch),
  // treat the runtime status as "unknown" and attempt to load the preview anyway.
  // The backend preview proxy will return a clear "Preview unavailable" response if needed.
  const isStartingProject = Boolean(
    startInFlight ||
    (isProcessInfoCurrent && frontendRawStatus === 'starting')
  );

  const showNotRunningState = Boolean(
    isProjectStopped &&
      project?.id &&
      onRestartProject &&
      isProcessInfoCurrent &&
      !isFrontendReadyForPreview &&
      !isStartingProject
  );
  const resolvePortValue = (portBundle, key) => {
    if (!portBundle) {
      return null;
    }
    return portBundle[key] ?? null;
  };
  const autoStartAttemptRef = useRef({ projectId: null, attempted: false });

  useEffect(() => {
    const projectId = project?.id ?? null;
    if (autoStartAttemptRef.current.projectId !== projectId) {
      autoStartAttemptRef.current = { projectId, attempted: false };
      if (autoRecoverTimeoutRef.current) {
        clearTimeout(autoRecoverTimeoutRef.current);
        autoRecoverTimeoutRef.current = null;
      }
      autoRecoverAttemptRef.current = 0;
      setAutoRecoverState({ attempt: 0, mode: 'idle' });
      setAutoRecoverDisabled(false);
    }
  }, [project?.id]);

  const shouldAutoStartOnIdle = Boolean(
    autoStartOnNotRunning &&
    !isProjectStopped &&
    project?.id &&
    onRestartProject &&
    isProcessInfoCurrent &&
    !isFrontendReadyForPreview &&
    !isStartingProject
  );

  useEffect(() => {
    if (!shouldAutoStartOnIdle) {
      return;
    }

    if (autoStartAttemptRef.current.attempted) {
      return;
    }

    /* v8 ignore next */
    autoStartAttemptRef.current.attempted = true;
    /* v8 ignore next */
    handleStartProject();
  }, [shouldAutoStartOnIdle]);


  const chooseFrontendPort = () => {
    if (!project) {
      return null;
    }
    const framework = (project.frontend?.framework || 'react').toLowerCase();
    const defaultPort = PORT_MAP[framework] || PORT_MAP.react;

    return (
      resolvePortValue(resolvedPorts?.active, 'frontend') ??
      resolvePortValue(resolvedPorts?.stored, 'frontend') ??
      resolvePortValue(resolvedPorts?.preferred, 'frontend') ??
      defaultPort
    );
  };

  const getPreviewProxyUrl = () => {
    if (!project?.id) {
      return 'about:blank';
    }

    const backendOrigin = guessBackendOrigin();
    if (!backendOrigin) {
      return 'about:blank';
    }

    return `${backendOrigin}/preview/${encodeURIComponent(project.id)}`;
  };

  const previewUrl = previewUrlOverride ?? getPreviewProxyUrl();
  // Navigation history state
  const [displayedUrl, setDisplayedUrl] = useState(previewUrl);
  const previewUrlRef = useRef(previewUrl);
  const displayedUrlRef = useRef(previewUrl);
  const [history, setHistory] = useState([previewUrl]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const historyIndexRef = useRef(0);
  const [urlInputValue, setUrlInputValue] = useState('');
  const [isEditingUrl, setIsEditingUrl] = useState(false);


  // Keep displayedUrlRef in sync
  useEffect(() => {
    displayedUrlRef.current = displayedUrl || previewUrlRef.current;
  }, [displayedUrl]);

  useEffect(() => {
    historyIndexRef.current = historyIndex;
  }, [historyIndex]);

  // When previewUrl changes (project switch, reload, etc), reset history
  useEffect(() => {
    if (previewUrl !== previewUrlRef.current) {
      previewUrlRef.current = previewUrl;
      setDisplayedUrl(previewUrl);
      setHistory([previewUrl]);
      setHistoryIndex(0);
      setHasConfirmedPreview(false);
    }
  }, [previewUrl]);

  const getDevServerOrigin = () => getDevServerOriginFromWindow({
    port: chooseFrontendPort(),
    hostnameOverride
  });

  const toDevServerUrl = (href) => {
    const origin = getDevServerOrigin();
    if (!origin) {
      return null;
    }

    if (!project?.id) {
      return origin;
    }

    let parsed;
    try {
      parsed = new URL(typeof href === 'string' && href ? href : previewUrlRef.current);
    } catch {
      return `${origin}/`;
    }

    const prefix = `/preview/${encodeURIComponent(project.id)}`;
    const pathname = parsed.pathname || '/';
    let strippedPath = pathname;
    if (pathname.startsWith(prefix)) {
      strippedPath = pathname.slice(prefix.length);
    }
    if (!strippedPath) {
      strippedPath = '/';
    }
    if (!strippedPath.startsWith('/')) {
      strippedPath = `/${strippedPath}`;
    }

    return `${origin}${strippedPath}${parsed.search || ''}${parsed.hash || ''}`;
  };

  const clearLoadTimeout = () => {
    if (loadTimeoutRef.current) {
      clearTimeout(loadTimeoutRef.current);
      loadTimeoutRef.current = null;
    }
  };

  const clearErrorConfirmTimeout = () => {
    if (errorConfirmTimeoutRef.current) {
      clearTimeout(errorConfirmTimeoutRef.current);
      errorConfirmTimeoutRef.current = null;
    }
  };

  const setErrorGracePeriod = (durationMs) => {
    const safeDuration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
    errorGraceUntilRef.current = Date.now() + safeDuration;
  };

  const scheduleErrorConfirmation = () => {
    setIframeLoading(true);
    setPendingIframeError(true);
    clearErrorConfirmTimeout();

    const now = Date.now();
    const graceUntil = errorGraceUntilRef.current || 0;
    const graceDelay = Math.max(0, graceUntil - now);
    const confirmDelay = graceDelay + 1200;

    errorConfirmTimeoutRef.current = setTimeout(() => {
      errorConfirmTimeoutRef.current = null;
      setPendingIframeError(false);
      setIframeLoading(false);
      setIframeError(true);
    }, confirmDelay);
  };

  const updateDisplayedUrlFromIframe = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) {
      return;
    }

    try {
      const nextHref = iframe.contentWindow?.location?.href;
      if (typeof nextHref === 'string' && nextHref && nextHref !== displayedUrlRef.current) {
        setIsEditingUrl(false);
        setDisplayedUrl(nextHref);
        // Only push to history if not navigating via back/forward
        setHistory((prev) => {
          const baseIndex = historyIndexRef.current;
          if (prev[baseIndex] === nextHref) return prev;
          const newHistory = prev.slice(0, baseIndex + 1).concat(nextHref);
          setHistoryIndex(newHistory.length - 1);
          return newHistory;
        });
        onPreviewNavigated?.(nextHref, { source: 'poll' });
      }
    } catch {
      // Ignore cross-origin access errors. We fall back to the last known preview URL.
    }
  }, [setDisplayedUrl, onPreviewNavigated]);

  const getExpectedPreviewOrigin = useCallback(() => {
    const current = previewUrlRef.current;
    if (typeof current !== 'string' || !current) {
      return null;
    }

    try {
      return new URL(current).origin;
    } catch {
      return null;
    }
  }, []);

  const postPreviewBridgePing = useCallback(() => {
    const iframeWindow = iframeRef.current?.contentWindow;
    if (!iframeWindow || typeof iframeWindow.postMessage !== 'function') {
      return;
    }

    try {
      iframeWindow.postMessage({
        type: 'LUCIDCODER_PREVIEW_BRIDGE_PING',
        nonce: Math.random().toString(16).slice(2)
      }, '*');
    } catch {
      // ignore
    }
  }, []);

  const buildSimpleSelector = (payload = {}) => {
    const rawTag = typeof payload.tagName === 'string' ? payload.tagName : '';
    const tag = rawTag ? rawTag.toLowerCase() : 'element';
    const id = typeof payload.id === 'string' ? payload.id.trim() : '';
    if (id) {
      return `${tag}#${id}`;
    }

    const rawClass = typeof payload.className === 'string' ? payload.className : '';
    const firstClass = rawClass
      .split(/\s+/)
      .map((value) => value.trim())
      .filter(Boolean)[0];
    if (firstClass) {
      return `${tag}.${firstClass}`;
    }

    return tag;
  };

  const copyTextToClipboard = async (text) => {
    if (typeof text !== 'string' || !text) {
      return false;
    }

    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // fall back
    }

    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      const success = document.execCommand?.('copy');
      document.body.removeChild(textarea);
      return Boolean(success);
    } catch {
      return false;
    }
  };

  const isLucidCoderProxyPlaceholderPage = () => {
    const iframe = iframeRef.current;
    if (!iframe) {
      return false;
    }

    try {
      const doc = iframe.contentDocument;
      const title = typeof doc?.title === 'string' ? doc.title : '';
      if (/^preview proxy error$/i.test(title) || /^preview unavailable$/i.test(title)) {
        return true;
      }

      const h1 = doc?.querySelector?.('h1');
      const headingText = typeof h1?.textContent === 'string' ? h1.textContent : '';
      return /^preview proxy error$/i.test(headingText) || /^preview unavailable$/i.test(headingText);
    } catch {
      return false;
    }
  };

  useEffect(() => {
    /* v8 ignore next */
    if (typeof window === 'undefined') {
      return;
    }

    const handleMessage = (event) => {
      const iframeWindow = iframeRef.current?.contentWindow;
      if (!iframeWindow || event.source !== iframeWindow) {
        return;
      }

      const expectedOrigin = getExpectedPreviewOrigin();
      const origin = typeof event.origin === 'string' ? event.origin : '';
      if (expectedOrigin && origin && origin !== expectedOrigin) {
        return;
      }

      const payload = event.data;
      if (!payload || typeof payload !== 'object') {
        return;
      }

      if (payload.type === 'LUCIDCODER_PREVIEW_HELPER_CONTEXT_MENU') {
        const iframe = iframeRef.current;
        const canvas = canvasRef.current;
        if (!iframe || !canvas) {
          return;
        }

        const clientX = Number.isFinite(payload.clientX) ? payload.clientX : 0;
        const clientY = Number.isFinite(payload.clientY) ? payload.clientY : 0;
        const iframeRect = iframe.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();
        const x = iframeRect.left - canvasRect.left + clientX;
        const y = iframeRect.top - canvasRect.top + clientY;

        const selector = buildSimpleSelector(payload);
        const href = typeof payload.href === 'string' ? payload.href : '';

        setPreviewContextMenu({ x, y, selector, href });
        return;
      }

      if (payload.type !== 'LUCIDCODER_PREVIEW_NAV' && payload.type !== 'LUCIDCODER_PREVIEW_BRIDGE_READY') {
        return;
      }

      const href = payload.href;
      if (typeof href !== 'string' || !href) {
        return;
      }

      setPreviewContextMenu(null);

      if (href !== displayedUrlRef.current) {
        setIsEditingUrl(false);
        setDisplayedUrl(href);
        // Only push to history if not navigating via back/forward
        setHistory((prev) => {
          const baseIndex = historyIndexRef.current;
          if (prev[baseIndex] === href) return prev;
          const newHistory = prev.slice(0, baseIndex + 1).concat(href);
          setHistoryIndex(newHistory.length - 1);
          return newHistory;
        });
        onPreviewNavigated?.(href, { source: 'message', type: payload.type });
      }

      setHasConfirmedPreview(true);
      setIframeLoading(false);
      setIframeError(false);
      setPendingIframeError(false);
    };

    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [getExpectedPreviewOrigin, onPreviewNavigated]);

  const renderContextMenu = () => {
    if (!previewContextMenu) {
      return null;
    }

    const { x, y, selector, href } = previewContextMenu;

    return (
      <>
        <div
          className="preview-context-menu-backdrop"
          data-testid="preview-context-menu-backdrop"
          onMouseDown={() => setPreviewContextMenu(null)}
        />
        <div
          className="preview-context-menu"
          data-testid="preview-context-menu"
          style={{ left: Math.max(0, x), top: Math.max(0, y) }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="preview-context-menu__item"
            onClick={async () => {
              await copyTextToClipboard(selector);
              setPreviewContextMenu(null);
            }}
          >
            Copy selector
          </button>
          <button
            type="button"
            className="preview-context-menu__item"
            onClick={async () => {
              await copyTextToClipboard(href);
              setPreviewContextMenu(null);
            }}
            disabled={!href}
          >
            Copy href
          </button>
        </div>
      </>
    );
  };

  const ensureNavigationPolling = () => {
    if (
      typeof window === 'undefined' ||
      typeof window.setInterval !== 'function' ||
      typeof window.clearInterval !== 'function'
    ) {
      return null;
    }

    const intervalId = window.setInterval(() => {
      updateDisplayedUrlFromIframe();
    }, 1500);

    return () => {
      window.clearInterval(intervalId);
    };
  };

  useEffect(() => {
    clearLoadTimeout();
    clearErrorConfirmTimeout();
    setPendingIframeError(false);

    if (isStartingProject) {
      setIframeError(false);
      setIframeLoading(true);
      return;
    }

    if (showNotRunningState || iframeError) {
      setIframeLoading(false);
      return;
    }

    if (!previewUrl || previewUrl === 'about:blank') {
      setIframeLoading(false);
      return;
    }

    setIframeLoading(true);
    loadTimeoutRef.current = setTimeout(() => {
      loadTimeoutRef.current = null;
      scheduleErrorConfirmation();
    }, 8000);

    return () => {
      clearLoadTimeout();
    };
  }, [previewUrl, iframeKey, showNotRunningState, iframeError, isStartingProject]);

  const handleIframeError = () => {
    clearLoadTimeout();
    scheduleErrorConfirmation();
  };

  const handleIframeLoad = () => {
    postPreviewBridgePing();

    // If the preview proxy is still warming up, it may briefly serve a same-origin
    // placeholder page that auto-reloads. Keep the loading overlay up so users don't
    // see error-page flashes while the dev server comes online.
    if (isLucidCoderProxyPlaceholderPage()) {
      proxyPlaceholderLoadCountRef.current += 1;
      if (!proxyPlaceholderFirstSeenRef.current) {
        proxyPlaceholderFirstSeenRef.current = Date.now();
      }

      const placeholderAgeMs = Date.now() - (proxyPlaceholderFirstSeenRef.current || Date.now());
      const shouldEscalate = placeholderAgeMs > 12000 || proxyPlaceholderLoadCountRef.current > 12;

      if (shouldEscalate) {
        let title = '';
        let message = '';
        try {
          const doc = iframeRef.current?.contentDocument;
          title = typeof doc?.title === 'string' ? doc.title : '';
          const code = doc?.querySelector?.('code');
          message = typeof code?.textContent === 'string' ? code.textContent.trim() : '';
        } catch {
          // ignore
        }

        setPreviewFailureDetails({
          kind: 'proxy-placeholder',
          title: title || 'Preview proxy error',
          message: message || 'The preview proxy is returning an error and cannot reach the dev server.'
        });

        clearLoadTimeout();
        clearErrorConfirmTimeout();
        setPendingIframeError(false);
        setIframeLoading(false);
        setIframeError(true);
        return;
      }

      setIframeError(false);
      setIframeLoading(true);
      setPendingIframeError(false);
      clearErrorConfirmTimeout();
      return;
    }

    clearLoadTimeout();
    clearErrorConfirmTimeout();
    setIframeLoading(false);
    setIframeError(false);
    setPendingIframeError(false);
    setHasConfirmedPreview(true);
    errorGraceUntilRef.current = 0;
    proxyPlaceholderFirstSeenRef.current = 0;
    proxyPlaceholderLoadCountRef.current = 0;
    setPreviewFailureDetails(null);

    if (autoRecoverTimeoutRef.current) {
      clearTimeout(autoRecoverTimeoutRef.current);
      autoRecoverTimeoutRef.current = null;
    }
    autoRecoverAttemptRef.current = 0;
    setAutoRecoverState({ attempt: 0, mode: 'idle' });

    updateDisplayedUrlFromIframe();
  };

  const reloadIframe = () => {
    setRestartStatus(null);
    setIframeError(false);
    setIframeLoading(true);
    setPendingIframeError(false);
    clearErrorConfirmTimeout();
    setErrorGracePeriod(4000);
    setHasConfirmedPreview(false);
    proxyPlaceholderFirstSeenRef.current = 0;
    proxyPlaceholderLoadCountRef.current = 0;
    setPreviewFailureDetails(null);
    setIframeKey((prev) => prev + 1);
  };

  const scheduleAutoRecoveryAttempt = useCallback(() => {
    const projectId = project?.id;
    if (!projectId) {
      return;
    }

    if (typeof onRefreshProcessStatus !== 'function') {
      return;
    }

    if (autoRecoverDisabledRef.current) {
      return;
    }

    if (autoRecoverTimeoutRef.current) {
      return;
    }

    const MAX_ATTEMPTS = 3;
    const nextAttempt = autoRecoverAttemptRef.current + 1;
    if (nextAttempt > MAX_ATTEMPTS) {
      setAutoRecoverState((prev) => ({ ...prev, mode: 'exhausted' }));
      return;
    }

    const delayMs = Math.min(8000, 900 * Math.pow(2, Math.max(0, nextAttempt - 1)));
    setAutoRecoverState({ attempt: autoRecoverAttemptRef.current, mode: 'scheduled' });

    autoRecoverTimeoutRef.current = setTimeout(async () => {
      autoRecoverTimeoutRef.current = null;

      if (autoRecoverDisabledRef.current) {
        setAutoRecoverState((prev) => ({ ...prev, mode: 'paused' }));
        return;
      }

      setAutoRecoverState({ attempt: nextAttempt, mode: 'running' });
      autoRecoverAttemptRef.current = nextAttempt;

      try {
        await onRefreshProcessStatus(projectId);
      } catch {
        // ignore
      }

      reloadIframe();
    }, delayMs);
  }, [project?.id, onRefreshProcessStatus]);

  useEffect(() => {
    if (!iframeError || iframeLoading || pendingIframeError) {
      return;
    }

    if (showNotRunningState || isStartingProject || isProjectStopped) {
      return;
    }

    scheduleAutoRecoveryAttempt();
  }, [
    iframeError,
    iframeLoading,
    pendingIframeError,
    showNotRunningState,
    isStartingProject,
    isProjectStopped,
    scheduleAutoRecoveryAttempt
  ]);

  const buildPreviewHelpPrompt = () => {
    const projectLabel = project?.name ? `${project.name} (${project.id})` : String(project?.id || 'unknown');
    const frontend = processInfo?.processes?.frontend || null;
    const backend = processInfo?.processes?.backend || null;

    const formatLogs = (proc) => {
      const logs = Array.isArray(proc?.logs) ? proc.logs : [];
      const tail = logs.slice(-20);
      return tail
        .map((entry) => {
          const ts = typeof entry?.timestamp === 'string' ? entry.timestamp : '';
          const stream = typeof entry?.stream === 'string' ? entry.stream : '';
          const msg = typeof entry?.message === 'string' ? entry.message : '';
          const prefix = [ts, stream].filter(Boolean).join(' ');
          return (prefix ? `${prefix} ` : '') + msg;
        })
        .filter(Boolean)
        .join('\n');
    };

    const detailsTitle = previewFailureDetails?.title || (iframeError ? 'Failed to load preview' : 'Preview issue');
    const detailsMessage = previewFailureDetails?.message || '';
    const expected = previewUrlRef.current || previewUrl;
    const displayed = displayedUrlRef.current || displayedUrl || expected;

    return [
      `The project preview is failing to load for project ${projectLabel}.`,
      '',
      `Observed: ${detailsTitle}${detailsMessage ? `\n${detailsMessage}` : ''}`,
      '',
      `Expected preview proxy URL: ${expected}`,
      `Last displayed URL: ${displayed}`,
      '',
      `Process snapshot (from Processes tab):`,
      `- Frontend: status=${frontend?.status || 'unknown'} port=${frontend?.port ?? 'unknown'} pid=${frontend?.pid ?? 'unknown'}`,
      `- Backend: status=${backend?.status || 'unknown'} port=${backend?.port ?? 'unknown'} pid=${backend?.pid ?? 'unknown'}`,
      '',
      `Frontend logs (tail):`,
      formatLogs(frontend) || '(no logs)',
      '',
      `Backend logs (tail):`,
      formatLogs(backend) || '(no logs)',
      '',
      `Please diagnose why the preview proxy returns 502/Bad Gateway (or why the dev server is unreachable), and suggest a fix.`
    ].join('\n');
  };

  const prefillChatWithPreviewHelp = () => {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') {
      return;
    }
    const prompt = buildPreviewHelpPrompt();
    try {
      window.dispatchEvent(new CustomEvent('lucidcoder:prefill-chat', { detail: { prompt } }));
    } catch {
      // ignore
    }
  };

  const applyHostnameOverride = (value) => {
    setHostnameOverride(value);
    reloadIframe();
  };

  const scheduleReloadIframe = () => {
    if (reloadTimeoutRef.current) {
      clearTimeout(reloadTimeoutRef.current);
    }
    reloadTimeoutRef.current = setTimeout(() => {
      reloadTimeoutRef.current = null;
      reloadIframe();
    }, 400);
  };

  const handleRestartProject = async () => {
    if (!project?.id || !onRestartProject) {
      return;
    }

    setRestartStatus(null);
    setIframeLoading(true);
    setErrorGracePeriod(4000);
    setHasConfirmedPreview(false);

    try {
      await onRestartProject(project.id);
      setRestartStatus(null);
      scheduleReloadIframe();
    } catch (error) {
      const message = error?.message || 'Failed to restart project';
      setRestartStatus({ type: 'error', message });
    }
  };

  const handleRefreshAndRetry = async () => {
    if (!project?.id) {
      return;
    }

    if (autoRecoverTimeoutRef.current) {
      clearTimeout(autoRecoverTimeoutRef.current);
      autoRecoverTimeoutRef.current = null;
    }

    setRestartStatus(null);

    // Surface a helpful loading copy while we refresh.
    setAutoRecoverState((prev) => ({
      attempt: Math.max(1, Number(prev.attempt) || 0),
      mode: 'running'
    }));

    try {
      await onRefreshProcessStatus?.(project.id);
    } catch {
      // ignore
    }

    reloadIframe();
  };

  const handleStartProject = async () => {
    setStartInFlight(true);
    setRestartStatus(null);
    setIframeLoading(true);
    setErrorGracePeriod(4000);
    setHasConfirmedPreview(false);

    try {
      await onRestartProject(project.id);
      setRestartStatus(null);
      scheduleReloadIframe();
    } catch (error) {
      const message = error?.message || 'Failed to start project';
      setRestartStatus({ type: 'error', message });
    } finally {
      setStartInFlight(false);
    }
  };

  useImperativeHandle(ref, () => ({
    reloadPreview: reloadIframe,
    restartProject: handleRestartProject,
    getPreviewUrl: () => previewUrlRef.current,
    getDisplayedUrl: () => displayedUrlRef.current,
    getOpenInNewTabUrl: () => toDevServerUrl(displayedUrlRef.current) || toDevServerUrl(),
    __testHooks: {
      triggerIframeError: handleIframeError,
      triggerIframeLoad: handleIframeLoad,
      triggerRefreshAndRetryForTests: handleRefreshAndRetry,
      normalizeHostname,
      resolveFrontendPort: chooseFrontendPort,
      applyHostnameOverride,
      getIframeKey: () => iframeKey,
      setDisplayedUrlForTests: (url) => setDisplayedUrl(url),
      getDisplayedUrl: () => displayedUrlRef.current,
      setPreviewUrlOverride: (value) => setPreviewUrlOverride(value),
      toDevServerUrlForTests: (href) => toDevServerUrl(href),
      toPreviewProxyUrlForTests: (href) => toPreviewProxyUrl(href),
      normalizeUrlInputForTests: (raw, origin) => normalizeUrlInput(raw, origin),
      getUrlOriginForTests: (value) => getUrlOrigin(value),
      setPreviewFailureDetailsForTests: (value) => {
        setPreviewFailureDetails(value);
      },
      setIframeNodeForTests: (node) => {
        iframeRef.current = node;
      },
      setCanvasNodeForTests: (node) => {
        canvasRef.current = node;
      },
      copyTextToClipboardForTests: (value) => copyTextToClipboard(value),
      isProxyPlaceholderPageForTests: () => isLucidCoderProxyPlaceholderPage(),
      setHasConfirmedPreviewForTests: (value) => {
        setHasConfirmedPreview(Boolean(value));
      },
      setErrorGracePeriodForTests: (value) => {
        setErrorGracePeriod(value);
      },
      getErrorGraceUntilForTests: () => errorGraceUntilRef.current,
      setAutoRecoverDisabledForTests: (value) => {
        setAutoRecoverDisabled(Boolean(value));
      },
      setAutoRecoverStateForTests: (value) => {
        setAutoRecoverState(value);
      },
      setAutoRecoverAttemptForTests: (value) => {
        const nextValue = Number(value);
        autoRecoverAttemptRef.current = Number.isFinite(nextValue) ? nextValue : 0;
      },
      setErrorStateForTests: ({ error, loading, pending } = {}) => {
        if (typeof error === 'boolean') {
          setIframeError(error);
        }
        if (typeof loading === 'boolean') {
          setIframeLoading(loading);
        }
        if (typeof pending === 'boolean') {
          setPendingIframeError(pending);
        }
      },
      updateDisplayedUrlFromIframe,
      startNavigationPollingForTests: () => ensureNavigationPolling()
    }
  }));

  useEffect(() => {
    const cleanup = ensureNavigationPolling();
    return cleanup || undefined;
  }, [updateDisplayedUrlFromIframe]);

  const normalizedDisplayedUrl = displayedUrl || previewUrl || 'about:blank';
  const shouldAttemptPreview =
    !showNotRunningState &&
    !isStartingProject &&
    (isFrontendReadyForPreview || !isProcessInfoCurrent);
  const effectivePreviewUrl = shouldAttemptPreview ? previewUrl : 'about:blank';

  const urlBarValue = (() => {
    const normalized = normalizedDisplayedUrl;
    if (normalized === 'about:blank') {
      return 'about:blank';
    }

    return toDevServerUrl(normalized) || toDevServerUrl() || '';
  })();

  const getUrlOrigin = (value) => {
    if (!value || value === 'about:blank') return '';
    try {
      return new URL(value).origin;
    } catch {
      return '';
    }
  };

  const toPreviewProxyUrl = (href) => {
    if (!project?.id) return null;
    const previewBase = previewUrlRef.current;
    if (!previewBase) return null;

    let previewOrigin = '';
    try {
      previewOrigin = new URL(previewBase).origin;
    } catch {
      return null;
    }

    let parsed;
    try {
      parsed = new URL(href);
    } catch {
      return null;
    }

    const prefix = `/preview/${encodeURIComponent(project.id)}`;
    let path = parsed.pathname || '/';
    if (!path.startsWith('/')) {
      path = `/${path}`;
    }

    let currentPath = '';
    try {
      const currentHref = displayedUrlRef.current || previewUrlRef.current || '';
      currentPath = new URL(currentHref).pathname || '';
    } catch {
      currentPath = '';
    }

    const shouldUsePrefix = Boolean(prefix && currentPath.startsWith(prefix));
    const finalPath = shouldUsePrefix
      ? (path.startsWith(prefix) ? path : `${prefix}${path}`)
      : path;

    return `${previewOrigin}${finalPath}${parsed.search || ''}${parsed.hash || ''}`;
  };

  const normalizeUrlInput = (raw, origin) => {
    if (!origin) return raw;
    if (!raw) return `${origin}/`;
    if (raw === 'about:blank') return raw;
    if (raw.startsWith(origin)) return raw;

    try {
      const parsed = new URL(raw);
      raw = `${parsed.pathname || ''}${parsed.search || ''}${parsed.hash || ''}`;
    } catch {
      // ignore, treat as path
    }

    let path = String(raw);
    if (!path.startsWith('/') && !path.startsWith('?') && !path.startsWith('#')) {
      path = `/${path}`;
    }
    if (path.startsWith('?') || path.startsWith('#')) {
      path = `/${path}`;
    }
    return `${origin}${path}`;
  };

  useEffect(() => {
    if (!isEditingUrl) {
      setUrlInputValue(urlBarValue || '');
    }
  }, [urlBarValue, isEditingUrl]);

  const renderStatusBanner = () => (
    restartStatus?.type === 'error' && (
      <div className={`preview-status ${restartStatus.type}`} data-testid="preview-status">
        {restartStatus.message}
      </div>
    )
  );

  /* c8 ignore next */
  const startLabel = startInFlight ? 'Starting…' : 'Start project';

  if (showNotRunningState) {
    return (
      <div className="preview-tab">
        {renderStatusBanner()}
        <div className="preview-not-running" data-testid="preview-not-running">
          <div className="preview-not-running-card">
            <h3>Project not running</h3>
            <p>The preview is unavailable because the project isn’t currently running.</p>
            <button
              type="button"
              className="retry-button"
              onClick={handleStartProject}
              disabled={startInFlight}
            >
              {startLabel}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (iframeError && !iframeLoading && !pendingIframeError) {
    const expectedUrl = previewUrl;
    const canRestart = Boolean(project?.id && onRestartProject);
    const canRefresh = Boolean(project?.id && typeof onRefreshProcessStatus === 'function');
    const canAutoRecover = canRefresh && !autoRecoverDisabled;
    const showAutoRecoverSwoosh = canAutoRecover && (autoRecoverState.mode === 'scheduled' || autoRecoverState.mode === 'running');

    const currentHostname = normalizeHostname(window.location.hostname);
    const canSuggestLocalhost = currentHostname !== 'localhost' && !currentHostname.startsWith('127.');

    const expectedNewTabUrl = toDevServerUrl(expectedUrl) || expectedUrl;
    const processSummary = (() => {
      if (!isProcessInfoCurrent) {
        return null;
      }

      const frontendPort = frontendProcess?.port ?? resolvedPorts?.active?.frontend ?? resolvedPorts?.stored?.frontend ?? null;
      const backendProcess = processInfo?.processes?.backend || null;
      const backendPort = backendProcess?.port ?? resolvedPorts?.active?.backend ?? resolvedPorts?.stored?.backend ?? null;

      const frontendLabel = `Frontend: ${frontendDisplayStatus}${frontendPort ? ` (:${frontendPort})` : ''}`;
      const backendLabel = `Backend: ${normalizeStatus(backendProcess?.status)}${backendPort ? ` (:${backendPort})` : ''}`;
      return `${frontendLabel} • ${backendLabel}`;
    })();
    const autoRecoverCopy = (() => {
      if (!canRefresh) {
        return null;
      }
      if (autoRecoverDisabled) {
        return 'Auto-recovery is paused.';
      }
      if (autoRecoverState.mode === 'exhausted') {
        return 'Auto-recovery paused after repeated failures.';
      }
      if (autoRecoverState.mode === 'running') {
        return `Attempting recovery… (attempt ${autoRecoverAttemptRef.current}/3)`;
      }
      if (autoRecoverState.mode === 'scheduled') {
        return 'Attempting recovery…';
      }
      return null;
    })();

    return (
      <div className="preview-tab">
        {renderStatusBanner()}
        <div className="preview-error">
          <div className="preview-loading-card">
            <h3>Failed to load preview</h3>

            {showAutoRecoverSwoosh && (
              <div className="preview-loading-bar" aria-hidden="true">
                <span className="preview-loading-bar-swoosh" />
              </div>
            )}

            {autoRecoverCopy ? (
              <p className="expected-url">{autoRecoverCopy}</p>
            ) : null}

            {previewFailureDetails?.message && (
              <p className="expected-url">
                <strong>{previewFailureDetails.title || 'Details'}:</strong> {previewFailureDetails.message}
              </p>
            )}

            <p>
              The preview didn’t finish loading. This can happen if the dev server crashed, the URL is
              unreachable, or the app blocks embedding via security headers.
            </p>

            <p className="expected-url">
              Expected URL: <code>{expectedUrl}</code>
            </p>

            {processSummary ? (
              <p className="expected-url">{processSummary}</p>
            ) : null}

            <p className="expected-url">
              <a href={expectedNewTabUrl} target="_blank" rel="noopener noreferrer">
                Open preview in a new tab
              </a>
            </p>

            <div className="preview-error-actions">
              {canRefresh && (
                <button type="button" className="retry-button" onClick={handleRefreshAndRetry}>
                  Refresh + retry
                </button>
              )}

              <button type="button" className="retry-button" onClick={reloadIframe}>
                Retry
              </button>

              {canRestart && (
                <button type="button" className="retry-button" onClick={handleRestartProject}>
                  Restart project
                </button>
              )}

              <button type="button" className="retry-button" onClick={prefillChatWithPreviewHelp}>
                Ask AI to fix
              </button>

              {canSuggestLocalhost && (
                <button
                  type="button"
                  className="retry-button"
                  onClick={() => applyHostnameOverride('localhost')}
                >
                  Try localhost
                </button>
              )}

              {canSuggestLocalhost && (
                <button
                  type="button"
                  className="retry-button"
                  onClick={() => applyHostnameOverride('127.0.0.1')}
                >
                  Try 127.0.0.1
                </button>
              )}

              {canAutoRecover && (
                <button
                  type="button"
                  className="retry-button"
                  onClick={() => setAutoRecoverDisabled(true)}
                >
                  Pause auto-retry
                </button>
              )}

              {canRefresh && autoRecoverDisabled && (
                <button
                  type="button"
                  className="retry-button"
                  onClick={() => {
                    setAutoRecoverDisabled(false);
                    autoRecoverAttemptRef.current = 0;
                    setAutoRecoverState({ attempt: 0, mode: 'idle' });
                  }}
                >
                  Resume auto-retry
                </button>
              )}
            </div>

            {(Array.isArray(frontendProcess?.logs) && frontendProcess.logs.length > 0) && (
              <details className="expected-url" style={{ marginTop: '0.75rem' }}>
                <summary>Frontend logs</summary>
                <pre style={{ whiteSpace: 'pre-wrap', marginTop: '0.5rem' }}>
                  {frontendProcess.logs
                    .slice(-20)
                    .map((entry) => entry?.message)
                    .filter(Boolean)
                    .join('\n')}
                </pre>
              </details>
            )}

            {(Array.isArray(processInfo?.processes?.backend?.logs) && processInfo.processes.backend.logs.length > 0) && (
              <details className="expected-url" style={{ marginTop: '0.5rem' }}>
                <summary>Backend logs</summary>
                <pre style={{ whiteSpace: 'pre-wrap', marginTop: '0.5rem' }}>
                  {processInfo.processes.backend.logs
                    .slice(-20)
                    .map((entry) => entry?.message)
                    .filter(Boolean)
                    .join('\n')}
                </pre>
              </details>
            )}
          </div>
        </div>
      </div>
    );
  }

  const renderLoadingOverlay = () => {
    if (!iframeLoading || !previewUrl || previewUrl === 'about:blank') {
      return null;
    }

    const newTabUrl = toDevServerUrl(normalizedDisplayedUrl) || toDevServerUrl();

    const showRecoveryCopy = autoRecoverState.mode === 'running' && (Number(autoRecoverState.attempt) || 0) > 0;
    const title = showRecoveryCopy ? 'Recovering preview…' : 'Loading preview…';
    const subtitle = showRecoveryCopy ? `Attempt ${autoRecoverState.attempt}/3` : null;

    return (
      <div className="preview-loading" data-testid="preview-loading">
        <div className="preview-loading-card">
          <h3>{title}</h3>
          <div className="preview-loading-bar" aria-hidden="true">
            <span className="preview-loading-bar-swoosh" />
          </div>
          {subtitle ? <p className="expected-url">{subtitle}</p> : null}
          <p className="expected-url">
            URL: <code>{normalizedDisplayedUrl}</code>
          </p>
          <p className="expected-url">
            {newTabUrl ? (
              <a href={newTabUrl} target="_blank" rel="noopener noreferrer">
                Open in a new tab
              </a>
            ) : null}
          </p>
        </div>
      </div>
    );
  };

  const postNavigateToIframe = (url) => {
    const iframeWindow = iframeRef.current?.contentWindow;
    if (iframeWindow && typeof iframeWindow.postMessage === 'function') {
      try {
        iframeWindow.postMessage({ type: 'LUCIDCODER_PREVIEW_NAVIGATE', href: url }, '*');
      } catch {}
    }
  };

  const handleBack = () => {
    if (historyIndex > 0) {
      const prevUrl = history[historyIndex - 1];
      setHistoryIndex(historyIndex - 1);
      setDisplayedUrl(prevUrl);
      postNavigateToIframe(prevUrl);
    }
  };

  const handleForward = () => {
    if (historyIndex < history.length - 1) {
      const nextUrl = history[historyIndex + 1];
      setHistoryIndex(historyIndex + 1);
      setDisplayedUrl(nextUrl);
      postNavigateToIframe(nextUrl);
    }
  };

  const handleUrlInputChange = (event) => {
    const raw = event.target.value;
    const origin = getUrlOrigin(urlBarValue);
    const normalized = normalizeUrlInput(raw, origin);
    setUrlInputValue(normalized);
  };

  const handleUrlInputKeyDown = (event) => {
    if (event.key !== 'Enter') {
      return;
    }

    event.preventDefault();
    const origin = getUrlOrigin(urlBarValue);
    const devTarget = normalizeUrlInput(urlInputValue, origin);
    if (!devTarget || devTarget === 'about:blank') {
      return;
    }

    const proxyTarget = toPreviewProxyUrl(devTarget);
    if (!proxyTarget) {
      return;
    }

    setIsEditingUrl(false);
    setUrlInputValue(devTarget);
    setDisplayedUrl(proxyTarget);
    setHistory((prev) => {
      const baseIndex = historyIndexRef.current;
      if (prev[baseIndex] === proxyTarget) return prev;
      const newHistory = prev.slice(0, baseIndex + 1).concat(proxyTarget);
      setHistoryIndex(newHistory.length - 1);
      return newHistory;
    });
    postNavigateToIframe(proxyTarget);
  };

  const handleUrlInputFocus = (event) => {
    setIsEditingUrl(true);
    const origin = getUrlOrigin(urlBarValue);
    const prefix = origin ? `${origin}/` : '';
    const value = event.target.value || '';
    if (origin && value.startsWith(prefix) && typeof event.target.setSelectionRange === 'function') {
      const start = prefix.length;
      event.target.setSelectionRange(start, value.length);
      return;
    }
    if (typeof event.target.select === 'function') {
      event.target.select();
    }
  };

  const handleUrlInputBlur = () => {
    setIsEditingUrl(false);
    setUrlInputValue(urlBarValue || '');
  };

  const renderUrlBar = () => (
    <div className="preview-url-bar" data-testid="preview-url-bar">
      <div className="preview-url-actions preview-url-actions-left">
        <button
          type="button"
          className="preview-nav-btn preview-nav-back"
          aria-label="Back"
          onClick={handleBack}
          disabled={historyIndex <= 0}
          tabIndex={historyIndex <= 0 ? -1 : 0}
        >
          <span className="preview-nav-icon">&#8592;</span>
        </button>
        <button
          type="button"
          className="preview-nav-btn preview-nav-forward"
          aria-label="Forward"
          onClick={handleForward}
          disabled={historyIndex >= history.length - 1}
          tabIndex={historyIndex >= history.length - 1 ? -1 : 0}
        >
          <span className="preview-nav-icon">&#8594;</span>
        </button>
      </div>
      <input
        aria-label="Preview URL"
        className="preview-url-input"
        value={urlInputValue}
        readOnly={!urlBarValue || urlBarValue === 'about:blank'}
        onChange={handleUrlInputChange}
        onKeyDown={handleUrlInputKeyDown}
        onFocus={handleUrlInputFocus}
        onBlur={handleUrlInputBlur}
      />
      <div className="preview-url-actions preview-url-actions-right">
        <button
          type="button"
          className="preview-nav-btn preview-nav-refresh"
          aria-label="Reload preview"
          onClick={onReloadPreview}
          disabled={!project || typeof onReloadPreview !== 'function'}
          tabIndex={!project || typeof onReloadPreview !== 'function' ? -1 : 0}
          data-testid="reload-preview"
        >
          <span className="preview-nav-icon preview-nav-icon--lowered">&#8635;</span>
        </button>
        <button
          type="button"
          className="preview-nav-btn preview-nav-open"
          aria-label="Open preview in new tab"
          onClick={onOpenInNewTab}
          disabled={!project || typeof onOpenInNewTab !== 'function'}
          tabIndex={!project || typeof onOpenInNewTab !== 'function' ? -1 : 0}
          data-testid="open-preview-tab"
        >
          <svg
            className="preview-nav-icon preview-nav-icon--lowered"
            viewBox="0 0 24 24"
            width="18"
            height="18"
            aria-hidden="true"
            focusable="false"
          >
            <path
              fill="currentColor"
              d="M14 3h7v7h-2V6.41l-9.29 9.3-1.42-1.42 9.3-9.29H14V3ZM5 5h6v2H7v10h10v-4h2v6H5V5Z"
            />
          </svg>
        </button>
      </div>
    </div>
  );

  return (
    <div className="preview-tab">
      {renderStatusBanner()}
      {renderUrlBar()}
      <div className="preview-canvas" ref={canvasRef}>
        {renderLoadingOverlay()}
        {renderContextMenu()}
        <iframe
          ref={iframeRef}
          data-testid="preview-iframe"
          className={`full-iframe${iframeLoading || pendingIframeError || !hasConfirmedPreview ? ' full-iframe--loading' : ''}`}
          key={iframeKey}
          src={effectivePreviewUrl}
          title={`${project?.name || 'Project'} Preview`}
          onError={handleIframeError}
          onLoad={handleIframeLoad}
          sandbox="allow-scripts allow-same-origin allow-forms"
        />
      </div>
    </div>
  );
});

PreviewTab.displayName = 'PreviewTab';

export default PreviewTab;