import React from 'react';

const PreviewLoadingOverlay = ({
  isFadingOut,
  title,
  subtitle,
  isPlaceholderDetected,
  reloadIframe,
  dispatchPreviewFixGoal
}) => {
  return (
    <div
      className={`preview-loading${isFadingOut ? ' preview-loading--fade-out' : ''}`}
      data-testid="preview-loading"
    >
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

      </div>
    </div>
  );
};

export default PreviewLoadingOverlay;
