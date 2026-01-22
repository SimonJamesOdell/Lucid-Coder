import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AppStateProvider, useAppState } from './context/AppStateContext'
import Navigation from './components/Navigation'
import GettingStarted from './components/StatusPanel' // This file contains GettingStarted component now
import ProjectSelector from './components/ProjectSelector'
import CreateProject from './components/CreateProject'
import ImportProject from './components/ImportProject'
import ProjectInspector from './components/ProjectInspector'
import './App.css'

const OFFLINE_BACKEND_POLL_INTERVAL_MS = 5000;

function AppContent() {
  const {
    currentView,
    currentProject,
    backendConnectivity,
    isLLMConfigured,
    llmStatusLoaded,
    llmStatus,
    refreshLLMStatus,
    reportBackendConnectivity
  } = useAppState();

  const isLLMConfiguredRef = useRef(isLLMConfigured);
  const llmStatusLoadedRef = useRef(llmStatusLoaded);
  const refreshLLMStatusRef = useRef(refreshLLMStatus);

  useEffect(() => {
    isLLMConfiguredRef.current = isLLMConfigured;
    llmStatusLoadedRef.current = llmStatusLoaded;
    refreshLLMStatusRef.current = refreshLLMStatus;
  }, [isLLMConfigured, llmStatusLoaded, refreshLLMStatus]);

  const [backendCheck, setBackendCheck] = useState({
    status: 'checking',
    error: null
  });

  const backendCheckRef = useRef(backendCheck);

  useEffect(() => {
    backendCheckRef.current = backendCheck;
  }, [backendCheck]);

  const [backendVersionLabel, setBackendVersionLabel] = useState(null);

  const checkBackendNow = useCallback(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);

    setBackendCheck({ status: 'checking', error: null });

    try {
      const response = await fetch('/api/health', { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Backend unavailable (${response.status})`);
      }

      // We only care that *a server* answered with JSON.
      // If the backend is down, Vite/proxy often returns HTML or the request fails.
      const data = await response.json().catch(() => null);
      if (!data || typeof data !== 'object') {
        throw new Error('Backend returned an invalid health response');
      }

      // If the backend was previously unreachable, re-hydrate LLM settings before
      // unblocking the UI. This prevents the app from briefly showing the
      // Getting Started / Configure LLM screen until the next full refresh.
      if (llmStatusLoadedRef.current && !isLLMConfiguredRef.current) {
        await refreshLLMStatusRef.current?.();
      }

      setBackendCheck({ status: 'online', error: null });
      reportBackendConnectivity?.('online');
    } catch (error) {
      const message = error?.name === 'AbortError'
        ? 'Backend check timed out'
        : (error?.message || 'Backend unreachable');
      setBackendCheck({ status: 'offline', error: message });
      reportBackendConnectivity?.('offline', message);
    } finally {
      clearTimeout(timeout);
    }
  }, []);

  useEffect(() => {
    checkBackendNow();
  }, [checkBackendNow]);

  useEffect(() => {
    if (backendCheck.status === 'online') {
      return undefined;
    }

    const intervalId = setInterval(() => {
      if (backendCheckRef.current.status === 'checking') {
        return;
      }
      checkBackendNow();
    }, OFFLINE_BACKEND_POLL_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [backendCheck.status, checkBackendNow]);

  useEffect(() => {
    if (backendCheck.status !== 'online') {
      setBackendVersionLabel(null);
      return;
    }

    let didCancel = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);

    (async () => {
      try {
        const response = await fetch('/api/version', { signal: controller.signal });
        if (!response.ok) {
          return;
        }

        const data = await response.json().catch(() => null);
        if (!data || typeof data !== 'object') {
          return;
        }

        const candidate = typeof data?.version === 'string'
          ? data.version
          : typeof data?.versionFile === 'string'
            ? data.versionFile
            : null;

        if (!didCancel) {
          setBackendVersionLabel(candidate);
        }
      } catch (error) {
        // Ignore version probe errors.
      } finally {
        clearTimeout(timeout);
      }
    })();

    return () => {
      didCancel = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [backendCheck.status]);

  const showBackendOfflineBanner = backendConnectivity?.status === 'offline';
  const backendIsOnline = backendConnectivity?.status === 'online';
  const backendErrorText = backendConnectivity?.lastError;

  if (backendCheck.status !== 'online') {
    const detail = backendCheck.error || backendErrorText;
    return (
      <div className="App">
        <div className="backend-offline-overlay" role="alert" aria-live="assertive" data-testid="backend-offline-overlay">
          <div className="backend-offline-overlay-panel">
            <div className="backend-offline-overlay-header">
              <span className="backend-offline-overlay-dot" aria-hidden="true" />
              <div className="backend-offline-overlay-title">Backend unavailable</div>
            </div>
            <div className="backend-offline-overlay-message">Start the backend server to continue.</div>
            {detail && <div className="backend-offline-overlay-detail">{detail}</div>}
            <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
              <button type="button" onClick={checkBackendNow} disabled={backendCheck.status === 'checking'} data-testid="backend-retry">
                {backendCheck.status === 'checking' ? 'Checking…' : 'Retry'}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const isSettingsLoading = !llmStatusLoaded;

  if (isSettingsLoading) {
    return (
      <div className="App">
        {showBackendOfflineBanner && (
          <div className="backend-offline-overlay" role="alert" aria-live="assertive" data-testid="backend-offline-overlay">
            <div className="backend-offline-overlay-panel">
              <div className="backend-offline-overlay-header">
                <span className="backend-offline-overlay-dot" aria-hidden="true" />
                <div className="backend-offline-overlay-title">Backend unavailable</div>
              </div>
              <div className="backend-offline-overlay-message">LucidCoder can’t reach the backend right now. Start it to continue.</div>
              <div className="backend-offline-overlay-detail">{backendErrorText}</div>
            </div>
          </div>
        )}
        <main className="main-content">
          <div className="content-area">
            <div className="settings-loading" role="status" aria-live="polite" data-testid="settings-loading">
              <div className="settings-loading-title">Loading settings…</div>
              <div className="settings-loading-subtitle">Checking LLM configuration</div>
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (!isLLMConfigured && !backendIsOnline) {
    return (
      <div className="App">
        <div className="backend-offline-overlay" role="alert" aria-live="assertive" data-testid="backend-offline-overlay">
          <div className="backend-offline-overlay-panel">
            <div className="backend-offline-overlay-header">
              <span className="backend-offline-overlay-dot" aria-hidden="true" />
              <div className="backend-offline-overlay-title">Backend unavailable</div>
            </div>
            <div className="backend-offline-overlay-message">LucidCoder can’t reach the backend right now. Start it to continue.</div>
            <div className="backend-offline-overlay-detail">{backendErrorText}</div>
          </div>
        </div>
        <main className="main-content">
          <div className="content-area">
            <div className="settings-loading" role="status" aria-live="polite" data-testid="settings-loading">
              <div className="settings-loading-title">Waiting for backend…</div>
              <div className="settings-loading-subtitle">LLM configuration can’t be checked while offline</div>
            </div>
            {llmStatus?.reason && (
              <div className="backend-offline-banner" role="status" aria-live="polite" data-testid="llm-status-reason">
                {llmStatus.reason}
              </div>
            )}
          </div>
        </main>
      </div>
    );
  }

  if (!isLLMConfigured) {
    return (
      <div className="App">
        <main className="main-content">
          <div className="content-area">
            <GettingStarted allowConfigured />
            {llmStatus?.reason && (
              <div className="backend-offline-banner" role="status" aria-live="polite" data-testid="llm-status-reason">
                {llmStatus.reason}
              </div>
            )}
          </div>
        </main>
      </div>
    );
  }

  const renderCurrentView = () => {
    switch (currentView) {
      case 'create-project':
        return <CreateProject />;
      case 'import-project':
        return <ImportProject />;
      case 'main':
      default:
        // If a project is selected, show the ProjectInspector
        if (currentProject) {
          return <ProjectInspector />;
        }
        
        // Otherwise show the project selection interface
        return (
          <>
            <GettingStarted />
            <ProjectSelector />
          </>
        );
    }
  };

  const isProjectInspectorActive = currentProject && currentView === 'main';

  return (
    <div className="App">
      <Navigation versionLabel={backendVersionLabel} />
      {showBackendOfflineBanner && (
        <div className="backend-offline-overlay" role="alert" aria-live="assertive" data-testid="backend-offline-overlay">
          <div className="backend-offline-overlay-panel">
            <div className="backend-offline-overlay-header">
              <span className="backend-offline-overlay-dot" aria-hidden="true" />
              <div className="backend-offline-overlay-title">Backend unavailable</div>
            </div>
            <div className="backend-offline-overlay-message">LucidCoder can’t reach the backend right now. Start it to continue.</div>
            <div className="backend-offline-overlay-detail">{backendErrorText}</div>
          </div>
        </div>
      )}
      <main className={`main-content ${isProjectInspectorActive ? 'project-inspector-active' : ''}`}>
        {isProjectInspectorActive ? (
          renderCurrentView()
        ) : (
          <div className="content-area">
            {renderCurrentView()}
          </div>
        )}
      </main>
    </div>
  );
}

function App() {
  return (
    <AppStateProvider>
      <AppContent />
    </AppStateProvider>
  )
}

export { AppContent }
export default App