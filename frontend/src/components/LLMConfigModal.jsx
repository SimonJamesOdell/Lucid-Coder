import React from 'react';
import GettingStarted from './StatusPanel';
import './LLMConfigModal.css';

const LLMConfigModal = ({ isOpen, onClose }) => {
  if (!isOpen) {
    return null;
  }

  const handleBackdropClick = (event) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  return (
    <div
      className="llm-config-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="llm-config-title"
      onClick={handleBackdropClick}
      data-testid="llm-config-modal"
    >
      <div className="llm-config-panel">
        <div className="llm-config-header">
          <div>
            <h2 id="llm-config-title">Configure LLM</h2>
            <p className="llm-config-subtitle">
              Update your provider, model, or API credentials at any time.
            </p>
          </div>
          <button
            type="button"
            className="llm-config-close"
            onClick={onClose}
            aria-label="Close LLM configuration"
            data-testid="llm-config-close"
          >
            &times;
          </button>
        </div>
        <div className="llm-config-body">
          <GettingStarted allowConfigured onConfigured={onClose} />
        </div>
      </div>
    </div>
  );
};

export default LLMConfigModal;
