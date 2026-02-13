import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import SettingsModal from './SettingsModal';
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

const normalizeBrowserProtocol = (value) => {
  if (typeof value !== 'string') {
    return 'http:';
  }

  const trimmed = value.trim();
  if (trimmed === 'http:' || trimmed === 'https:') {
    return trimmed;
  }

  return 'http:';
};

export const getDevServerOriginFromWindow = ({ port, hostnameOverride } = {}) => {
  if (typeof window === 'undefined') {
    return null;
  }

  if (!Number.isInteger(port) || port <= 0) {
    return null;
  }

  const protocol = normalizeBrowserProtocol(window.location?.protocol || 'http:');
  const hostname = normalizeHostname(hostnameOverride || window.location?.hostname || 'localhost');
  return `${protocol}//${hostname}:${port}`;
};


const getBackendOriginFromEnv = () => {
  try {
    const raw = import.meta?.env?.VITE_API_TARGET;
    if (typeof raw !== 'string') {
      return null;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
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
  // ── Core lifecycle state machine ──────────────────────────────────────
  // previewPhase: 'loading' │ 'ready' │ 'error'
  //   loading → iframe is loading, overlay covers it
  //   ready   → preview loaded, iframe is visible
  //   error   → confirmed failure, error card shown, iframe stopped
  const [previewPhase, setPreviewPhase] = useState('loading');
  const [iframeKey, setIframeKey] = useState(0);
  const [isSoftReloading, setIsSoftReloading] = useState(false);
  const [isPlaceholderDetected, setIsPlaceholderDetected] = useState(false);
  const [previewFailureDetails, setPreviewFailureDetails] = useState(null);
  const [showBackendLogsModal, setShowBackendLogsModal] = useState(false);

  // ── Auto-recovery ────────────────────────────────────────────────────
  const [autoRecoverState, setAutoRecoverState] = useState({
    attempt: 0,
    mode: 'idle'
  });
  const [autoRecoverDisabled, setAutoRecoverDisabled] = useState(false);
  const autoRecoverDisabledRef = useRef(autoRecoverDisabled);
  const autoRecoverTimeoutRef = useRef(null);
  const autoRecoverAttemptRef = useRef(0);

  // ── UI state ─────────────────────────────────────────────────────────
  const [previewContextMenu, setPreviewContextMenu] = useState(null);
  const [restartStatus, setRestartStatus] = useState(null);
  const [startInFlight, setStartInFlight] = useState(false);
  const [hostnameOverride, setHostnameOverride] = useState(null);
  const [previewUrlOverride, setPreviewUrlOverride] = useState(null);

  // ── Timers ───────────────────────────────────────────────────────────
  const loadTimeoutRef = useRef(null);           // 8 s from iframe mount
  const placeholderTimeoutRef = useRef(null);    // 10 s proxy-placeholder escalation
  const errorDelayRef = useRef(null);            // 1.2 s error confirmation delay
  const reloadTimeoutRef = useRef(null);         // 400 ms scheduled reload after restart
  const reloadDebounceRef = useRef(null);        // 300 ms debounce for soft-reloads

  // ── Refs ──────────────────────────────────────────────────────────────
  const proxyPlaceholderFirstSeenRef = useRef(0);
  const suppressNextLoadRef = useRef(false);  // guards against synthetic load from doc.open/close
  const iframeRef = useRef(null);
  const iframeNodeOverrideRef = useRef(null);
  const canvasRef = useRef(null);

  const getIframeNode = useCallback(() => iframeNodeOverrideRef.current || iframeRef.current, []);

  useEffect(() => {
    autoRecoverDisabledRef.current = autoRecoverDisabled;
  }, [autoRecoverDisabled]);

  const guessBackendOrigin = () => {
    /* c8 ignore start */
    if (typeof window === 'undefined') {
      return '';
    }
    /* c8 ignore end */

    if (!window.location) {
      return '';
    }

    const rawOrigin = window.location?.origin || '';
    const origin = rawOrigin === 'null' ? '' : rawOrigin;
    const hostname = window.location?.hostname || 'localhost';
    const rawProtocol = window.location?.protocol || 'http:';
    const protocol = normalizeBrowserProtocol(rawProtocol);
    const port = window.location?.port || '';

    const resolvedHostname = normalizeHostname(hostnameOverride || hostname);

    const envOrigin = getBackendOriginFromEnv();
    if (envOrigin) {
      return envOrigin;
    }

    // Dev default: the LucidCoder frontend runs on 3000 and the backend runs on 5000.
    if ((port === '3000' || port === '5173') && resolvedHostname) {
      return `${protocol}//${resolvedHostname}:5000`;
    }

    // Packaged / webview environments can report non-http protocols (e.g. file:)
    // or the literal origin string "null". In those cases, fall back to the dev
    // default backend mapping so preview doesn't become about:blank.
    if ((rawProtocol !== protocol || !origin) && resolvedHostname) {
      return `${protocol}//${resolvedHostname}:5000`;
    }

    if (hostnameOverride) {
      const suffix = port ? `:${port}` : '';
      return `${protocol}//${resolvedHostname}${suffix}`;
    }

    return origin;
  };

  // ── Helpers ─────────────────────────────────────────────────────────
  const clearAllTimers = () => {
    for (const ref of [loadTimeoutRef, placeholderTimeoutRef, errorDelayRef, autoRecoverTimeoutRef, reloadTimeoutRef, reloadDebounceRef]) {
      if (ref.current) { clearTimeout(ref.current); ref.current = null; }
    }
  };

  const stopIframeContent = () => {
    try {
      const win = getIframeNode()?.contentWindow;
      if (win && typeof win.stop === 'function') { win.stop(); }
    } catch { /* cross-origin — ignore */ }

    // win.stop() only aborts in-flight resource loads — it does NOT clear
    // pending setTimeout callbacks.  The proxy placeholder page schedules
    // `setTimeout(location.reload(), 900)` which would survive win.stop()
    // and cause an endless load→reload→load strobe.  Replacing the document
    // via open/close destroys the page's JS execution context, killing every
    // pending timer and breaking the loop for good.
    try {
      const doc = getIframeNode()?.contentDocument;
      if (doc && typeof doc.open === 'function') {
        suppressNextLoadRef.current = true;
        doc.open();
        doc.write('<html><head><title>Preview loading</title></head><body></body></html>');
        doc.close();
      }
    } catch { /* cross-origin or sandboxed — ignore */ }
  };

  useEffect(() => {
    return () => { clearAllTimers(); };
  }, []);

  useEffect(() => {
    autoRecoverAttemptRef.current = Number(autoRecoverState.attempt) || 0;
  }, [autoRecoverState.attempt]);

  useEffect(() => {
    /* c8 ignore start */
    if (typeof window === 'undefined') {
      return;
    }
    /* c8 ignore end */

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
  const shouldAttemptPreview =
    !showNotRunningState &&
    !isStartingProject &&
    (isFrontendReadyForPreview || !isProcessInfoCurrent);
  const resolvedPreviewPhase = showNotRunningState ? 'error' : previewPhase;
  const backendLogs = Array.isArray(processInfo?.processes?.backend?.logs)
    ? processInfo.processes.backend.logs
    : [];
  const hasBackendLogs = backendLogs.length > 0;
  const backendLogsText = backendLogs
    .slice(-50)
    .map((entry) => entry?.message)
    .filter(Boolean)
    .join('\n');

  useEffect(() => {
    if (resolvedPreviewPhase !== 'error' && showBackendLogsModal) {
      setShowBackendLogsModal(false);
    }
  }, [resolvedPreviewPhase, showBackendLogsModal]);
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
  const effectivePreviewUrl = shouldAttemptPreview ? previewUrl : 'about:blank';
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
      // The lifecycle effect (which depends on previewUrl) will transition
      // the phase to 'loading' and set up the load timeout.
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

  const confirmError = (title, message, kind) => {
    clearAllTimers();
    stopIframeContent();
    setIsSoftReloading(false);
    setIsPlaceholderDetected(false);
    const hasDetails = Boolean(title || message);
    if (hasDetails) {
      setPreviewFailureDetails({ kind: kind || 'generic', title: title || '', message: message || '' });
    }
    setPreviewPhase('error');
  };

  const updateDisplayedUrlFromIframe = useCallback(() => {
    const iframe = getIframeNode();
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
    const iframeWindow = getIframeNode()?.contentWindow;
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
    const iframe = getIframeNode();
    if (!iframe) {
      return false;
    }

    try {
      const doc = iframe.contentDocument;
      const title = typeof doc?.title === 'string' ? doc.title : '';
      if (/^preview (proxy error|unavailable|starting)$/i.test(title)) {
        return true;
      }

      const h1 = doc?.querySelector?.('h1');
      const headingText = typeof h1?.textContent === 'string' ? h1.textContent : '';
      return /^preview (proxy error|unavailable|starting)$/i.test(headingText);
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
      const iframeWindow = getIframeNode()?.contentWindow;
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

      if (payload.type === 'LUCIDCODER_PREVIEW_BRIDGE_POINTER') {
        setPreviewContextMenu(null);
        window.dispatchEvent(new Event('lucidcoder:close-dropdowns'));
        return;
      }

      if (payload.type === 'LUCIDCODER_PREVIEW_HELPER_CONTEXT_MENU') {
        const iframe = getIframeNode();
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

      setPreviewPhase('ready');
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

  // ── Iframe lifecycle effect ─────────────────────────────────────────
  // Fires when the iframe is (re)mounted (iframeKey) or the target URL
  // changes. Sets up the loading phase and a single load timeout.
  useEffect(() => {
    // Clear timers from the previous load cycle.
    clearAllTimers();
    setIsPlaceholderDetected(false);
    proxyPlaceholderFirstSeenRef.current = 0;

    if (isStartingProject) {
      setPreviewPhase('loading');
      return;
    }

    if (showNotRunningState) {
      return;
    }

    if (!previewUrl || previewUrl === 'about:blank') {
      return;
    }

    setPreviewPhase('loading');
    loadTimeoutRef.current = setTimeout(() => {
      loadTimeoutRef.current = null;
      confirmError(
        'Load timeout',
        'The preview didn\u2019t finish loading. The dev server may have crashed or is unreachable.'
      );
    }, 8000);

    return () => {
      if (loadTimeoutRef.current) { clearTimeout(loadTimeoutRef.current); loadTimeoutRef.current = null; }
    };
  }, [previewUrl, iframeKey, showNotRunningState, isStartingProject]);

  // ── Iframe event handlers ───────────────────────────────────────────

  const handleIframeError = () => {
    if (!shouldAttemptPreview || !previewUrl || previewUrl === 'about:blank' || effectivePreviewUrl === 'about:blank') {
      return;
    }

    setIsSoftReloading(false);
    // Cancel the main load timeout — we know the load failed.
    if (loadTimeoutRef.current) { clearTimeout(loadTimeoutRef.current); loadTimeoutRef.current = null; }

    // Brief 1.2 s delay so transient network hiccups don't flash the error card.
    if (!errorDelayRef.current) {
      errorDelayRef.current = setTimeout(() => {
        errorDelayRef.current = null;
        confirmError(
          'Preview error',
          'The preview didn\u2019t finish loading. The dev server may have crashed or is unreachable.'
        );
      }, 1200);
    }
  };

  const handleIframeLoad = (options = {}) => {
    const ignoreSuppression = Boolean(options.ignoreSuppression);
    // After stopIframeContent() replaces the document via doc.open/close,
    // the browser fires a synthetic load event. Ignore it.
    if (suppressNextLoadRef.current) {
      suppressNextLoadRef.current = false;
      if (!ignoreSuppression) {
        return;
      }
    }

    if (!shouldAttemptPreview || !previewUrl || previewUrl === 'about:blank' || effectivePreviewUrl === 'about:blank') {
      return;
    }

    setIsSoftReloading(false);

    // Cancel any pending error delay — a load event supersedes it.
    if (errorDelayRef.current) { clearTimeout(errorDelayRef.current); errorDelayRef.current = null; }

    postPreviewBridgePing();

    // Proxy placeholder detection: the backend proxy serves a small HTML
    // page with a recognisable <title> when it can't reach the dev server.
    if (isLucidCoderProxyPlaceholderPage()) {
      setPreviewPhase('loading');
      setPreviewFailureDetails(null);
      if (!isPlaceholderDetected) {
        setIsPlaceholderDetected(true);
      }
      if (!proxyPlaceholderFirstSeenRef.current) {
        proxyPlaceholderFirstSeenRef.current = Date.now();
      }

      // Capture error details NOW before stopIframeContent replaces the document.
      let capturedTitle = '';
      let capturedMessage = '';
      try {
        const doc = getIframeNode()?.contentDocument;
        capturedTitle = typeof doc?.title === 'string' ? doc.title : '';
        const code = doc?.querySelector?.('code');
        capturedMessage = typeof code?.textContent === 'string' ? code.textContent.trim() : '';
      } catch { /* ignore */ }

      // Stop the placeholder's built-in reload script (900 ms setTimeout)
      // to prevent rapid-fire load events. Our own escalation timeout
      // handles the retry cadence.
      stopIframeContent();

      // Cancel the regular 8 s load timeout — the placeholder timeout
      // manages the deadline from here.
      if (loadTimeoutRef.current) { clearTimeout(loadTimeoutRef.current); loadTimeoutRef.current = null; }

      // Start a 10 s placeholder escalation timeout (once).
      if (!placeholderTimeoutRef.current) {
        placeholderTimeoutRef.current = setTimeout(() => {
          placeholderTimeoutRef.current = null;

          confirmError(
            capturedTitle || 'Preview proxy error',
            capturedMessage || 'The preview proxy is returning an error and cannot reach the dev server.',
            'proxy-placeholder'
          );
        }, 10000);
      }

      // Keep the loading phase active (overlay stays visible).
      return;
    }

    // ── Genuine content loaded — preview is ready ──
    clearAllTimers();
    proxyPlaceholderFirstSeenRef.current = 0;
    setIsPlaceholderDetected(false);
    setPreviewFailureDetails(null);
    setPreviewPhase('ready');
    autoRecoverAttemptRef.current = 0;
    setAutoRecoverState({ attempt: 0, mode: 'idle' });

    updateDisplayedUrlFromIframe();
  };

  // ── Reload helpers ──────────────────────────────────────────────────

  const reloadIframe = () => {
    clearAllTimers();
    suppressNextLoadRef.current = false;
    setRestartStatus(null);
    setPreviewPhase('loading');
    setIsSoftReloading(false);
    setIsPlaceholderDetected(false);
    setPreviewFailureDetails(null);
    proxyPlaceholderFirstSeenRef.current = 0;
    setIframeKey((prev) => prev + 1);
  };

  // Soft reload: reloads iframe content in-place without unmounting the
  // DOM element. The old content stays visible under the loading overlay
  // so users don't see a blank / black flash while the new page loads.
  const softReloadIframe = () => {
    const iframe = getIframeNode();
    if (!iframe) {
      reloadIframe();
      return;
    }

    try {
      const win = iframe.contentWindow;
      if (!win || typeof win.location?.reload !== 'function') {
        reloadIframe();
        return;
      }

      clearAllTimers();
      suppressNextLoadRef.current = false;
      setRestartStatus(null);
      setPreviewPhase('loading');
      setIsSoftReloading(true);
      setIsPlaceholderDetected(false);
      setPreviewFailureDetails(null);
      proxyPlaceholderFirstSeenRef.current = 0;

      loadTimeoutRef.current = setTimeout(() => {
        loadTimeoutRef.current = null;
        confirmError(
          'Load timeout',
          'The preview didn\u2019t finish loading after a reload.'
        );
      }, 8000);

      win.location.reload();
    } catch {
      reloadIframe();
    }
  };

  // Debounced version of softReloadIframe for external callers (saves, etc.)
  const debouncedReload = () => {
    if (reloadDebounceRef.current) {
      clearTimeout(reloadDebounceRef.current);
    }
    reloadDebounceRef.current = setTimeout(() => {
      reloadDebounceRef.current = null;
      softReloadIframe();
    }, 300);
  };

  // ── Auto-recovery ───────────────────────────────────────────────────

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
    if (previewPhase !== 'error') {
      return;
    }

    if (showNotRunningState || isStartingProject || isProjectStopped) {
      return;
    }

    scheduleAutoRecoveryAttempt();
  }, [
    previewPhase,
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

    const detailsTitle = previewFailureDetails?.title || (previewPhase === 'error' ? 'Failed to load preview' : 'Preview issue');
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

  const dispatchPreviewFixGoal = () => {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') {
      return;
    }
    const prompt = buildPreviewHelpPrompt();
    try {
      window.dispatchEvent(new CustomEvent('lucidcoder:run-prompt', { detail: { prompt } }));
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
    setPreviewPhase('loading');

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
    setPreviewPhase('loading');

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
    reloadPreview: debouncedReload,
    restartProject: handleRestartProject,
    getPreviewUrl: () => previewUrlRef.current,
    getDisplayedUrl: () => displayedUrlRef.current,
    getOpenInNewTabUrl: () => toDevServerUrl(displayedUrlRef.current) || toDevServerUrl(),
    __testHooks: {
      triggerIframeError: handleIframeError,
      triggerIframeLoad: () => handleIframeLoad({ ignoreSuppression: true }),
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
        iframeNodeOverrideRef.current = node;
      },
      setCanvasNodeForTests: (node) => {
        canvasRef.current = node;
      },
      copyTextToClipboardForTests: (value) => copyTextToClipboard(value),
      isProxyPlaceholderPageForTests: () => isLucidCoderProxyPlaceholderPage(),
      setHasConfirmedPreviewForTests: (value) => {
        if (Boolean(value)) {
          setPreviewPhase('ready');
        } else if (previewPhase === 'ready') {
          setPreviewPhase('loading');
        }
      },
      setErrorGracePeriodForTests: () => {
        // No-op: grace period eliminated in phase-based state machine.
      },
      getErrorGraceUntilForTests: () => 0,
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
        if (error === true) {
          setPreviewPhase('error');
        } else if (loading === true) {
          setPreviewPhase('loading');
        } else if (error === false && loading === false) {
          setPreviewPhase('ready');
        }
      },
      updateDisplayedUrlFromIframe,
      startNavigationPollingForTests: () => ensureNavigationPolling(),
      softReloadIframeForTests: softReloadIframe,
      hardReloadIframeForTests: reloadIframe,
      getIsSoftReloadingForTests: () => isSoftReloading,
      getStuckInPlaceholderLoopForTests: () => isPlaceholderDetected,
      setStuckInPlaceholderLoopForTests: (value) => setIsPlaceholderDetected(Boolean(value)),
      setPlaceholderCountersForTests: ({ firstSeen, loadCount } = {}) => {
        if (typeof firstSeen === 'number') {
          proxyPlaceholderFirstSeenRef.current = firstSeen;
        }
        // loadCount is no longer tracked — placeholder detection is time-based only.
      }
    }
  }));

  useEffect(() => {
    const cleanup = ensureNavigationPolling();
    return cleanup || undefined;
  }, [updateDisplayedUrlFromIframe]);

  const normalizedDisplayedUrl = displayedUrl || previewUrl || 'about:blank';

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

  /* c8 ignore next */
  const startLabel = startInFlight ? 'Starting…' : 'Start project';

  if (resolvedPreviewPhase === 'error') {
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
    const notRunningDetails = showNotRunningState
      ? {
          title: 'Project not running',
          message: 'The preview is unavailable because the project isn’t currently running.'
        }
      : null;
    const failureDetails = notRunningDetails || previewFailureDetails;
    const autoRecoverCopy = (() => {
      if (showNotRunningState) {
        return null;
      }
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

            {failureDetails?.message && (
              <p className="expected-url">
                {failureDetails.title ? (
                  <>
                    <strong>{failureDetails.title}</strong>: {failureDetails.message}
                  </>
                ) : (
                  <>
                    <strong>Details:</strong> {failureDetails.message}
                  </>
                )}
              </p>
            )}

            <div className="preview-error-actions">
              {showNotRunningState ? (
                <button
                  type="button"
                  className="retry-button"
                  onClick={handleStartProject}
                  disabled={startInFlight}
                >
                  {startLabel}
                </button>
              ) : (
                <>
                  <button type="button" className="retry-button" onClick={reloadIframe}>
                    Retry
                  </button>

                  <button type="button" className="retry-button" onClick={dispatchPreviewFixGoal}>
                    Fix with AI
                  </button>

                  {hasBackendLogs ? (
                    <button
                      type="button"
                      className="retry-button"
                      onClick={() => setShowBackendLogsModal(true)}
                    >
                      View backend logs
                    </button>
                  ) : null}
                </>
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
          </div>
        </div>
        {showNotRunningState ? (
          <div className="preview-canvas" ref={canvasRef}>
            {renderContextMenu()}
            <iframe
              ref={iframeRef}
              data-testid="preview-iframe"
              className={`full-iframe${resolvedPreviewPhase !== 'ready' && !isSoftReloading ? ' full-iframe--loading' : ''}`}
              key={iframeKey}
              src={effectivePreviewUrl}
              title={`${project?.name || 'Project'} Preview`}
              onError={handleIframeError}
              onLoad={handleIframeLoad}
              sandbox="allow-scripts allow-same-origin allow-forms"
            />
          </div>
        ) : null}
        <SettingsModal
          isOpen={showBackendLogsModal}
          onClose={() => setShowBackendLogsModal(false)}
          title="Backend logs"
          subtitle="Latest entries from the backend process"
          testId="preview-backend-logs-modal"
          panelClassName="preview-logs-modal-panel"
          bodyClassName="preview-logs-modal-body"
          closeLabel="Close backend logs"
        >
          <pre className="preview-logs-modal-content">
            {backendLogsText || 'No backend logs available.'}
          </pre>
        </SettingsModal>
      </div>
    );
  }

  const renderLoadingOverlay = () => {
    if (resolvedPreviewPhase !== 'loading' || (!project?.id && !isStartingProject)) {
      return null;
    }

    const newTabUrl = toDevServerUrl(normalizedDisplayedUrl) || toDevServerUrl();
    const shouldShowUrl = normalizedDisplayedUrl && normalizedDisplayedUrl !== 'about:blank';

    const showRecoveryCopy = autoRecoverState.mode === 'running' && (Number(autoRecoverState.attempt) || 0) > 0;
    const title = isPlaceholderDetected
      ? 'Preview is not loading'
      : showRecoveryCopy
        ? 'Recovering preview…'
        : 'Loading preview…';
    const subtitle = showRecoveryCopy ? `Attempt ${autoRecoverState.attempt}/3` : null;

    return (
      <div className="preview-loading" data-testid="preview-loading">
        <div className="preview-loading-card">
          <h3>{title}</h3>
          {!isPlaceholderDetected && (
            <div className="preview-loading-bar" aria-hidden="true">
              <span className="preview-loading-bar-swoosh" />
            </div>
          )}
          {subtitle ? <p className="expected-url">{subtitle}</p> : null}

          {isPlaceholderDetected && (
            <>
              <p>
                The project preview can't load. The dev server may have crashed
                or the project code has an error that prevents it from starting.
              </p>
              <div className="preview-error-actions" data-testid="preview-stuck-actions">
                <button type="button" className="retry-button" onClick={reloadIframe}>
                  Retry
                </button>
                <button type="button" className="retry-button" onClick={dispatchPreviewFixGoal}>
                  Fix with AI
                </button>
              </div>
            </>
          )}

          {shouldShowUrl && (
            <p className="expected-url">
              URL: <code>{normalizedDisplayedUrl}</code>
            </p>
          )}
          {newTabUrl && shouldShowUrl ? (
            <p className="expected-url">
              <a href={newTabUrl} target="_blank" rel="noopener noreferrer">
                Open in a new tab
              </a>
            </p>
          ) : null}
        </div>
      </div>
    );
  };

  const postNavigateToIframe = (url) => {
    const iframeWindow = getIframeNode()?.contentWindow;
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
      {renderUrlBar()}
      <div className="preview-canvas" ref={canvasRef}>
        {renderLoadingOverlay()}
        {renderContextMenu()}
        <iframe
          ref={iframeRef}
          data-testid="preview-iframe"
          className={`full-iframe${resolvedPreviewPhase !== 'ready' && !isSoftReloading ? ' full-iframe--loading' : ''}`}
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