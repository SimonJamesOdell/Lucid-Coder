import React, { useLayoutEffect, useState } from 'react';
import './PortSettingsModal.css';

const defaultSettings = {
  frontendPortBase: 6100,
  backendPortBase: 6500
};

const MIN_PORT = 1024;
const MAX_PORT = 65535;

const PortSettingsModal = ({ isOpen, onClose, settings = defaultSettings, onSave }) => {
  const [formState, setFormState] = useState(defaultSettings);
  const [error, setError] = useState('');

  useLayoutEffect(() => {
    if (isOpen) {
      setFormState({
        ...defaultSettings,
        ...settings
      });
      setError('');
    }
  }, [isOpen, settings]);

  if (!isOpen) {
    return null;
  }

  const handleFieldChange = (field) => (event) => {
    setFormState((prev) => ({
      ...prev,
      [field]: event.target.value
    }));
  };

  const validateForm = () => {
    const frontend = Number(formState.frontendPortBase);
    const backend = Number(formState.backendPortBase);

    if (!Number.isInteger(frontend) || frontend < MIN_PORT || frontend > MAX_PORT) {
      return `Frontend port base must be between ${MIN_PORT} and ${MAX_PORT}.`;
    }

    if (!Number.isInteger(backend) || backend < MIN_PORT || backend > MAX_PORT) {
      return `Backend port base must be between ${MIN_PORT} and ${MAX_PORT}.`;
    }

    if (frontend === backend) {
      return 'Frontend and backend port bases should differ to avoid collisions.';
    }

    return '';
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    const validationError = validateForm();
    if (validationError) {
      setError(validationError);
      return;
    }

    onSave({
      frontendPortBase: Number(formState.frontendPortBase),
      backendPortBase: Number(formState.backendPortBase)
    });
  };

  const handleBackdropClick = (event) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  return (
    <div
      className="port-settings-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="port-settings-title"
      onClick={handleBackdropClick}
      data-testid="port-settings-modal"
    >
      <div className="port-settings-panel">
        <div className="port-settings-header">
          <div>
            <h2 id="port-settings-title">Default Project Ports</h2>
            <p className="port-settings-subtitle">
              Control which port ranges Lucid Coder uses when starting new frontend and backend servers.
            </p>
          </div>
          <button
            type="button"
            className="port-settings-close"
            onClick={onClose}
            aria-label="Close port settings"
            data-testid="port-settings-close"
          >
            &times;
          </button>
        </div>

        <form onSubmit={handleSubmit} className="port-settings-form" data-testid="port-settings-form">
          <div className="port-settings-grid">
            <label className="port-settings-label">
              Frontend port base
              <input
                type="number"
                min={MIN_PORT}
                max={MAX_PORT}
                value={formState.frontendPortBase}
                onChange={handleFieldChange('frontendPortBase')}
                data-testid="port-frontend-input"
              />
              <span className="port-settings-hint">
                First port to try when launching Vite/React dev servers.
              </span>
            </label>

            <label className="port-settings-label">
              Backend port base
              <input
                type="number"
                min={MIN_PORT}
                max={MAX_PORT}
                value={formState.backendPortBase}
                onChange={handleFieldChange('backendPortBase')}
                data-testid="port-backend-input"
              />
              <span className="port-settings-hint">
                First port to try for Express/FastAPI development servers.
              </span>
            </label>
          </div>

          {error && (
            <div className="port-settings-error" role="alert" data-testid="port-settings-error">
              {error}
            </div>
          )}

          <div className="port-settings-footer">
            <button
              type="button"
              className="port-settings-button secondary"
              onClick={onClose}
              data-testid="port-settings-cancel"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="port-settings-button primary"
              data-testid="port-settings-save"
            >
              Save defaults
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default PortSettingsModal;
