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
  ({ project, processInfo, onRestartProject, autoStartOnNotRunning = true, isProjectStopped = false, onPreviewNavigated }, ref) => {
  const [iframeError, setIframeError] = useState(false);
  const [iframeLoading, setIframeLoading] = useState(false);
  const [pendingIframeError, setPendingIframeError] = useState(false);
  const [hasConfirmedPreview, setHasConfirmedPreview] = useState(false);
  const [iframeKey, setIframeKey] = useState(0);
  const [restartStatus, setRestartStatus] = useState(null);
  const [previewFailureDetails, setPreviewFailureDetails] = useState(null);
  const [startInFlight, setStartInFlight] = useState(false);
  const [hostnameOverride, setHostnameOverride] = useState(null);
  const [previewUrlOverride, setPreviewUrlOverride] = useState(null);
  const reloadTimeoutRef = useRef(null);
  const loadTimeoutRef = useRef(null);
  const errorConfirmTimeoutRef = useRef(null);
  const errorGraceUntilRef = useRef(0);
  const proxyPlaceholderFirstSeenRef = useRef(0);
  const proxyPlaceholderLoadCountRef = useRef(0);
  const iframeRef = useRef(null);

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
    };
  }, []);

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

    const backendOrigin = guessBackendOrigin();
    if (!backendOrigin) {
      return 'about:blank';
    }

    return `${backendOrigin}/preview/${encodeURIComponent(project.id)}`;
  };

  const previewUrl = previewUrlOverride ?? getPreviewProxyUrl();
  const [displayedUrl, setDisplayedUrl] = useState(previewUrl);
  const previewUrlRef = useRef(previewUrl);
  const displayedUrlRef = useRef(previewUrl);

  useEffect(() => {
    displayedUrlRef.current = displayedUrl || previewUrlRef.current;
  }, [displayedUrl]);

  useEffect(() => {
    if (previewUrl !== previewUrlRef.current) {
      previewUrlRef.current = previewUrl;
      setDisplayedUrl(previewUrl);
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
        setDisplayedUrl(nextHref);
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

      if (payload.type !== 'LUCIDCODER_PREVIEW_NAV' && payload.type !== 'LUCIDCODER_PREVIEW_BRIDGE_READY') {
        return;
      }

      const href = payload.href;
      if (typeof href !== 'string' || !href) {
        return;
      }

      if (href !== displayedUrlRef.current) {
        setDisplayedUrl(href);
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
    __testHooks: {
      triggerIframeError: handleIframeError,
      triggerIframeLoad: handleIframeLoad,
      normalizeHostname,
      resolveFrontendPort: chooseFrontendPort,
      applyHostnameOverride,
      getIframeKey: () => iframeKey,
      setDisplayedUrlForTests: (url) => setDisplayedUrl(url),
      getDisplayedUrl: () => displayedUrlRef.current,
      setPreviewUrlOverride: (value) => setPreviewUrlOverride(value),
      toDevServerUrlForTests: (href) => toDevServerUrl(href),
      setPreviewFailureDetailsForTests: (value) => {
        setPreviewFailureDetails(value);
      },
      setIframeNodeForTests: (node) => {
        iframeRef.current = node;
      },
      isProxyPlaceholderPageForTests: () => isLucidCoderProxyPlaceholderPage(),
      setHasConfirmedPreviewForTests: (value) => {
        setHasConfirmedPreview(Boolean(value));
      },
      setErrorGracePeriodForTests: (value) => {
        setErrorGracePeriod(value);
      },
      getErrorGraceUntilForTests: () => errorGraceUntilRef.current,
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

    const currentHostname = normalizeHostname(window.location.hostname);
    const canSuggestLocalhost = currentHostname !== 'localhost' && !currentHostname.startsWith('127.');

    return (
      <div className="preview-tab">
        {renderStatusBanner()}
        <div className="preview-error">
          <div className="error-content">
            <h3>Failed to load preview</h3>
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
            <p className="expected-url">
              <a href={expectedUrl} target="_blank" rel="noopener noreferrer">
                Open preview in a new tab
              </a>
            </p>
            <div className="preview-error-actions">
              {canRestart && (
                <button type="button" className="retry-button" onClick={handleRestartProject}>
                  Restart project
                </button>
              )}
              <button type="button" className="retry-button" onClick={prefillChatWithPreviewHelp}>
                Ask AI to fix
              </button>
              <button type="button" className="retry-button" onClick={reloadIframe}>
                Retry
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

    return (
      <div className="preview-loading" data-testid="preview-loading">
        <div className="preview-loading-card">
          <h3>Loading preview…</h3>
          <div className="preview-loading-bar" aria-hidden="true">
            <span className="preview-loading-bar-swoosh" />
          </div>
          <p className="expected-url">
            URL: <code>{normalizedDisplayedUrl}</code>
          </p>
          <p className="expected-url">
            <a
              href={toDevServerUrl(normalizedDisplayedUrl) || normalizedDisplayedUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open in a new tab
            </a>
          </p>
        </div>
      </div>
    );
  };

  const renderUrlBar = () => (
    <div className="preview-url-bar" data-testid="preview-url-bar">
      {(() => {
        const normalized = normalizedDisplayedUrl;
        const devUrl = hasConfirmedPreview && !iframeLoading && !pendingIframeError && !iframeError
          ? (toDevServerUrl(normalized) || '')
          : '';
        const value = normalized === 'about:blank' ? 'about:blank' : devUrl;

        return (
      <input
        aria-label="Preview URL"
        className="preview-url-input"
        value={value}
        readOnly
        onFocus={(event) => event.target.select()}
      />
        );
      })()}
    </div>
  );

  return (
    <div className="preview-tab">
      {renderStatusBanner()}
      {renderUrlBar()}
      <div className="preview-canvas">
        {renderLoadingOverlay()}
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