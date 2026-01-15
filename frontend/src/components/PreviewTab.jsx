import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import './PreviewTab.css';

const PORT_MAP = {
  react: 5173,
  vue: 5173,
  nextjs: 3000,
  angular: 4200
};

const PreviewTab = forwardRef(
  ({ project, processInfo, onRestartProject }, ref) => {
  const [iframeError, setIframeError] = useState(false);
  const [iframeLoading, setIframeLoading] = useState(false);
  const [iframeKey, setIframeKey] = useState(0);
  const [restartStatus, setRestartStatus] = useState(null);
  const [startInFlight, setStartInFlight] = useState(false);
  const [hostnameOverride, setHostnameOverride] = useState(null);
  const [previewUrlOverride, setPreviewUrlOverride] = useState(null);
  const reloadTimeoutRef = useRef(null);
  const loadTimeoutRef = useRef(null);
  const iframeRef = useRef(null);

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

  const showNotRunningState = Boolean(project?.id && onRestartProject && !isFrontendReadyForPreview);
  const resolvePortValue = (portBundle, key) => {
    if (!portBundle) {
      return null;
    }
    return portBundle[key] ?? null;
  };

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

  const normalizeHostname = (value) => {
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

  const getFrontendUrl = () => {
    if (!project) return 'about:blank';

    const port = chooseFrontendPort();
    if (!port) {
      return 'about:blank';
    }

    const currentHostname = normalizeHostname(window.location.hostname);
    const hostname = normalizeHostname(hostnameOverride || currentHostname);
    return `${window.location.protocol}//${hostname}:${port}`;
  };

  const previewUrl = previewUrlOverride ?? getFrontendUrl();
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
    }
  }, [previewUrl]);

  const clearLoadTimeout = () => {
    if (loadTimeoutRef.current) {
      clearTimeout(loadTimeoutRef.current);
      loadTimeoutRef.current = null;
    }
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
      }
    } catch {
      // Ignore cross-origin access errors. We fall back to the last known preview URL.
    }
  }, [setDisplayedUrl]);

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
    setIframeLoading(false);

    if (showNotRunningState || iframeError) {
      return;
    }

    if (!previewUrl || previewUrl === 'about:blank') {
      return;
    }

    setIframeLoading(true);
    loadTimeoutRef.current = setTimeout(() => {
      loadTimeoutRef.current = null;
      setIframeLoading(false);
      setIframeError(true);
    }, 8000);

    return () => {
      clearLoadTimeout();
    };
  }, [previewUrl, iframeKey, showNotRunningState, iframeError]);

  const handleIframeError = () => {
    clearLoadTimeout();
    setIframeLoading(false);
    setIframeError(true);
  };

  const handleIframeLoad = () => {
    clearLoadTimeout();
    setIframeLoading(false);
    setIframeError(false);
    updateDisplayedUrlFromIframe();
  };

  const reloadIframe = () => {
    setRestartStatus(null);
    setIframeError(false);
    setIframeLoading(false);
    setIframeKey((prev) => prev + 1);
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

    setRestartStatus({ type: 'info', message: 'Restarting project…' });

    try {
      await onRestartProject(project.id);
      setRestartStatus({ type: 'success', message: 'Project restarted. Reloading preview…' });
      scheduleReloadIframe();
    } catch (error) {
      const message = error?.message || 'Failed to restart project';
      setRestartStatus({ type: 'error', message });
    }
  };

  const handleStartProject = async () => {
    setStartInFlight(true);
    setRestartStatus({ type: 'info', message: 'Starting project…' });

    try {
      await onRestartProject(project.id);
      setRestartStatus({ type: 'success', message: 'Project started. Loading preview…' });
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
    getPreviewUrl: () => getFrontendUrl(),
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
      setIframeNodeForTests: (node) => {
        iframeRef.current = node;
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

  const renderStatusBanner = () => (
    restartStatus && (
      <div className={`preview-status ${restartStatus.type}`} data-testid="preview-status">
        {restartStatus.message}
      </div>
    )
  );

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
              {startInFlight ? 'Starting…' : 'Start project'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (iframeError) {
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
          <p className="expected-url">
            URL: <code>{normalizedDisplayedUrl}</code>
          </p>
          <p className="expected-url">
            <a href={normalizedDisplayedUrl} target="_blank" rel="noopener noreferrer">
              Open in a new tab
            </a>
          </p>
        </div>
      </div>
    );
  };

  const renderUrlBar = () => (
    <div className="preview-url-bar" data-testid="preview-url-bar">
      <input
        aria-label="Preview URL"
        className="preview-url-input"
        value={normalizedDisplayedUrl}
        readOnly
        onFocus={(event) => event.target.select()}
      />
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
          className="full-iframe"
          key={iframeKey}
          src={previewUrl}
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