import React from 'react';
import SettingsModal from '../SettingsModal';

const PreviewErrorView = ({
  showAutoRecoverSwoosh,
  autoRecoverCopy,
  failureDetails,
  showNotRunningState,
  handleStartProject,
  startInFlight,
  startLabel,
  reloadIframe,
  dispatchPreviewFixGoal,
  hasBackendLogs,
  setShowBackendLogsModal,
  frontendProcess,
  renderContextMenu,
  canvasRef,
  iframeRef,
  resolvedPreviewPhase,
  isSoftReloading,
  iframeKey,
  effectivePreviewUrl,
  project,
  handleIframeError,
  handleIframeLoad,
  showBackendLogsModal,
  backendLogsText
}) => {
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
};

export default PreviewErrorView;
