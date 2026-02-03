import React from 'react';
import '../styles/SettingsModal.css';

const SettingsModal = ({
  isOpen,
  onClose,
  title,
  subtitle,
  children,
  testId,
  closeTestId,
  titleId,
  panelClassName = '',
  bodyClassName = '',
  headerContent = null,
  closeLabel
}) => {
  if (!isOpen) {
    return null;
  }

  const handleBackdropClick = (event) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  const finalLabel = closeLabel || 'Close settings';
  const panelClasses = ['settings-modal-panel', panelClassName].filter(Boolean).join(' ');
  const bodyClasses = ['settings-modal-body', bodyClassName].filter(Boolean).join(' ');

  return (
    <div
      className="settings-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={handleBackdropClick}
      data-testid={testId}
    >
      <div className={panelClasses}>
        <div className="settings-modal-header">
          <div className="settings-modal-title-block">
            <h2 id={titleId} className="settings-modal-title">{title}</h2>
            {subtitle ? <p className="settings-modal-subtitle">{subtitle}</p> : null}
            {headerContent ? (
              <div className="settings-modal-header-extra">
                {headerContent}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="settings-modal-close"
            onClick={onClose}
            aria-label={finalLabel}
            data-testid={closeTestId}
          >
            &times;
          </button>
        </div>
        <div className={bodyClasses}>
          {children}
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
