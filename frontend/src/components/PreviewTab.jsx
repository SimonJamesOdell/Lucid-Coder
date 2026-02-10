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
  const [isPreviewFrozen, setIsPreviewFrozen] = useState(false);

  // ── UI state ─────────────────────────────────────────────────────────
  const [previewContextMenu, setPreviewContextMenu] = useState(null);
  const [restartStatus, setRestartStatus] = useState(null);
  const [startInFlight, setStartInFlight] = useState(false);
  const [hostnameOverride, setHostnameOverride] = useState(null);
  const [previewUrlOverride, setPreviewUrlOverride] = useState(null);
  const [isBackendLogsOpen, setIsBackendLogsOpen] = useState(false);

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
  const previewReadyRef = useRef(false);
  const previewEscapeCountRef = useRef(0);
  const previewEscapeWindowRef = useRef(0);

  const getIframeNode = useCallback(() => iframeNodeOverrideRef.current || iframeRef.current, []);

  const guessBackendOrigin = () => {
    if (typeof window === 'undefined') {
      return '';
    }

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
    for (const ref of [loadTimeoutRef, placeholderTimeoutRef, errorDelayRef, reloadTimeoutRef, reloadDebounceRef]) {
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

    if (typeof window !== 'undefined') {
      const origin = window.location?.origin;
      if (origin && origin !== 'null') {
        return `${origin}/preview/${encodeURIComponent(project.id)}`;
      }
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
      previewReadyRef.current = false;
      previewEscapeCountRef.current = 0;
      previewEscapeWindowRef.current = 0;
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
    if (title || message) {
      setPreviewFailureDetails({ kind: kind || 'generic', title: title || '', message: message || '' });
    }
    setPreviewPhase('error');
    previewReadyRef.current = false;
  };

  const handleProxyPlaceholderDetected = (details = {}) => {
    clearAllTimers();
    setPreviewPhase('loading');
    setPreviewFailureDetails(null);
    if (!isPlaceholderDetected) {
      setIsPlaceholderDetected(true);
    }
    if (!proxyPlaceholderFirstSeenRef.current) {
      proxyPlaceholderFirstSeenRef.current = Date.now();
    }

    setIsPreviewFrozen(true);
    suppressNextLoadRef.current = true;

    stopIframeContent();

    if (loadTimeoutRef.current) { clearTimeout(loadTimeoutRef.current); loadTimeoutRef.current = null; }

    if (!placeholderTimeoutRef.current) {
      placeholderTimeoutRef.current = setTimeout(() => {
        placeholderTimeoutRef.current = null;

        confirmError(
          details.title || 'Preview proxy error',
          details.message || 'The preview proxy is returning an error and cannot reach the dev server.',
          'proxy-placeholder'
        );
      }, 10000);
    }
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

  const markPreviewReady = useCallback(() => {
    clearAllTimers();
    proxyPlaceholderFirstSeenRef.current = 0;
    setIsPlaceholderDetected(false);
    setPreviewFailureDetails(null);
    setPreviewPhase('ready');
    previewReadyRef.current = true;
    setIsPreviewFrozen(false);
    updateDisplayedUrlFromIframe();
  }, [updateDisplayedUrlFromIframe]);

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

  const getPreviewProxyPrefix = useCallback(() => {
    if (!project?.id) {
      return null;
    }
    return `/preview/${encodeURIComponent(project.id)}`;
  }, [project?.id]);

  const isPreviewEscapeUrl = useCallback((href) => {
    if (!href) {
      return false;
    }
    const expectedOrigin = getExpectedPreviewOrigin();
    const prefix = getPreviewProxyPrefix();
    if (!expectedOrigin || !prefix) {
      return false;
    }
    try {
      const url = new URL(href);
      if (url.origin !== expectedOrigin) {
        return false;
      }
      return !url.pathname.startsWith(prefix);
    } catch {
      return false;
    }
  }, [getExpectedPreviewOrigin, getPreviewProxyPrefix]);

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

      if (payload.type === 'LUCIDCODER_PREVIEW_PROXY_ERROR') {
        handleProxyPlaceholderDetected({
          title: payload.title,
          message: payload.message
        });
        return;
      }

      if (payload.type === 'LUCIDCODER_PREVIEW_BRIDGE_READY') {
        markPreviewReady();
        return;
      }

      if (payload.type !== 'LUCIDCODER_PREVIEW_NAV') {
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

      if (previewReadyRef.current) {
        setPreviewPhase('ready');
      }
    };

    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [getExpectedPreviewOrigin, onPreviewNavigated, markPreviewReady]);

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
    setIsSoftReloading(false);
    // Cancel the main load timeout — we know the load failed.
    if (loadTimeoutRef.current) { clearTimeout(loadTimeoutRef.current); loadTimeoutRef.current = null; }

    // Brief 1.2 s delay so transient network hiccups don't flash the error card.
    if (!errorDelayRef.current) {
      errorDelayRef.current = setTimeout(() => {
        errorDelayRef.current = null;
        confirmError('', '');
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

    if (isPreviewFrozen) {
      return;
    }

    setIsSoftReloading(false);

    // Cancel any pending error delay — a load event supersedes it.
    if (errorDelayRef.current) { clearTimeout(errorDelayRef.current); errorDelayRef.current = null; }

    postPreviewBridgePing();

    let currentHref = '';
    try {
      currentHref = getIframeNode()?.contentWindow?.location?.href || '';
    } catch {
      currentHref = '';
    }

    if (isPreviewEscapeUrl(currentHref)) {
      const now = Date.now();
      if (!previewEscapeWindowRef.current || now - previewEscapeWindowRef.current > 5000) {
        previewEscapeWindowRef.current = now;
        previewEscapeCountRef.current = 0;
      }
      previewEscapeCountRef.current += 1;

      if (previewEscapeCountRef.current >= 3) {
        confirmError(
          'Preview redirected',
          'The preview keeps navigating to the LucidCoder UI. The project dev server is likely redirecting to the host origin.'
        );
        return;
      }

      reloadIframe();
      return;
    }

    // Proxy placeholder detection: the backend proxy serves a small HTML
    // page with a recognisable <title> when it can't reach the dev server.
    if (isLucidCoderProxyPlaceholderPage()) {
      // Capture error details NOW before stopIframeContent replaces the document.
      let capturedTitle = '';
      let capturedMessage = '';
      try {
        const doc = getIframeNode()?.contentDocument;
        capturedTitle = typeof doc?.title === 'string' ? doc.title : '';
        const code = doc?.querySelector?.('code');
        capturedMessage = typeof code?.textContent === 'string' ? code.textContent.trim() : '';
      } catch { /* ignore */ }

      handleProxyPlaceholderDetected({ title: capturedTitle, message: capturedMessage });
      return;
    }

    // ── Content loaded — wait for bridge ready before showing preview ──
    if (!previewReadyRef.current) {
      setPreviewPhase('loading');
      setPreviewFailureDetails(null);
      setIsPlaceholderDetected(false);
      return;
    }

    markPreviewReady();
  };

  // ── Reload helpers ──────────────────────────────────────────────────

  const reloadIframe = () => {
    clearAllTimers();
    suppressNextLoadRef.current = false;
    setRestartStatus(null);
    setPreviewPhase('loading');
    setIsSoftReloading(false);
    setIsPlaceholderDetected(false);
    setIsPreviewFrozen(false);
    setPreviewFailureDetails(null);
    proxyPlaceholderFirstSeenRef.current = 0;
    previewEscapeCountRef.current = 0;
    previewEscapeWindowRef.current = 0;
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
      setIsPreviewFrozen(false);
      setPreviewFailureDetails(null);
      proxyPlaceholderFirstSeenRef.current = 0;
      previewEscapeCountRef.current = 0;
      previewEscapeWindowRef.current = 0;

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
  const shouldAttemptPreview =
    !showNotRunningState &&
    !isStartingProject &&
    (isFrontendReadyForPreview || !isProcessInfoCurrent);
  const effectivePreviewUrl = shouldAttemptPreview && !isPreviewFrozen ? previewUrl : 'about:blank';

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

  if (showNotRunningState) {
    return (
      <div className="preview-tab">
        {renderUrlBar()}
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

  if (previewPhase === 'error') {
    const expectedUrl = previewUrl;
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
    const backendLogs = Array.isArray(processInfo?.processes?.backend?.logs)
      ? processInfo.processes.backend.logs
      : [];
    const backendLogText = backendLogs
      .map((entry) => entry?.message)
      .filter(Boolean)
      .join('\n');
    const shouldShowFailureDetails = (() => {
      if (!previewFailureDetails?.message) {
        return false;
      }
      const title = previewFailureDetails.title || '';
      const message = previewFailureDetails.message || '';
      if (title === 'Load timeout' && /preview didn['’]t finish loading/i.test(message)) {
        return false;
      }
      return true;
    })();

    return (
      <div className="preview-tab">
        {renderUrlBar()}
        <div className="preview-error">
          <div className="preview-loading-card">
            <h3>Failed to load preview</h3>

            {shouldShowFailureDetails && (
              <p className="expected-url">
                <strong>{previewFailureDetails.title || 'Details'}:</strong> {previewFailureDetails.message}
              </p>
            )}

            <p>
              The preview didn’t finish loading. This can happen if the dev server crashed, the URL is
              unreachable, or the app blocks embedding via security headers.
            </p>

            <div className="preview-error-actions">
              <button type="button" className="retry-button" onClick={reloadIframe}>
                Retry
              </button>

              <button type="button" className="retry-button" onClick={dispatchPreviewFixGoal}>
                Fix with AI
              </button>
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

            {backendLogs.length > 0 && (
              <div className="preview-log-actions" style={{ marginTop: '0.5rem' }}>
                <button
                  type="button"
                  className="preview-log-button"
                  onClick={() => setIsBackendLogsOpen(true)}
                >
                  Backend logs
                </button>
              </div>
            )}
          </div>
        </div>
        {isBackendLogsOpen && (
          <div className="preview-logs-modal-backdrop" onClick={() => setIsBackendLogsOpen(false)}>
            <div
              className="preview-logs-modal"
              role="dialog"
              aria-modal="true"
              aria-label="Backend logs"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="preview-logs-modal-header">
                <h4>Backend logs</h4>
                <button
                  type="button"
                  className="preview-logs-modal-close"
                  onClick={() => setIsBackendLogsOpen(false)}
                  aria-label="Close backend logs"
                >
                  &times;
                </button>
              </div>
              <div className="preview-logs-modal-body">
                <pre className="preview-logs-modal-pre">{backendLogText || '(no logs)'}</pre>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  const renderLoadingOverlay = () => {
    if (previewPhase !== 'loading' || (!previewUrl || previewUrl === 'about:blank') && !isPlaceholderDetected) {
      return null;
    }

    const title = isPlaceholderDetected
      ? 'Preview is not loading'
      : 'Loading preview…';

    return (
      <div className="preview-loading" data-testid="preview-loading">
        <div className="preview-loading-card">
          <h3>{title}</h3>
          {!isPlaceholderDetected && (
            <div className="preview-loading-bar" aria-hidden="true">
              <span className="preview-loading-bar-swoosh" />
            </div>
          )}
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

          {normalizedDisplayedUrl !== 'about:blank' && (
            <p className="expected-url">
              URL: <code>{normalizedDisplayedUrl}</code>
            </p>
          )}
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

  function handleBack() {
    if (historyIndex > 0) {
      const prevUrl = history[historyIndex - 1];
      setHistoryIndex(historyIndex - 1);
      setDisplayedUrl(prevUrl);
      postNavigateToIframe(prevUrl);
    }
  }

  function handleForward() {
    if (historyIndex < history.length - 1) {
      const nextUrl = history[historyIndex + 1];
      setHistoryIndex(historyIndex + 1);
      setDisplayedUrl(nextUrl);
      postNavigateToIframe(nextUrl);
    }
  }

  function handleUrlInputChange(event) {
    const raw = event.target.value;
    const origin = getUrlOrigin(urlBarValue);
    const normalized = normalizeUrlInput(raw, origin);
    setUrlInputValue(normalized);
  }

  function handleUrlInputKeyDown(event) {
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
  }

  function handleUrlInputFocus(event) {
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
  }

  function handleUrlInputBlur() {
    setIsEditingUrl(false);
    setUrlInputValue(urlBarValue || '');
  }

  function renderUrlBar() {
    return (
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
  }

  return (
    <div className="preview-tab">
      {renderUrlBar()}
      <div className="preview-canvas" ref={canvasRef}>
        {renderLoadingOverlay()}
        {renderContextMenu()}
        <iframe
          ref={iframeRef}
          data-testid="preview-iframe"
          className={`full-iframe${previewPhase !== 'ready' && !isSoftReloading ? ' full-iframe--loading' : ''}`}
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