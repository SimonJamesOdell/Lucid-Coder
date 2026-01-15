import React, { useEffect, useRef, useState } from 'react';
import './NewBranchModal.css';

const initialState = {
  name: '',
  description: ''
};

const sanitizeBranchName = (value) => value.replace(/\s+/g, '-');

const NewBranchModal = ({
  isOpen,
  onClose,
  onSubmit,
  isSubmitting = false,
  errorMessage = null
}) => {
  const [formState, setFormState] = useState(initialState);
  const nameInputRef = useRef(null);

  useEffect(() => {
    if (!isOpen) {
      if (typeof document !== 'undefined') {
        document.body.style.overflow = 'unset';
      }
      return undefined;
    }

    setFormState(initialState);

    const focusInput = () => {
      nameInputRef.current?.focus();
    };

    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(focusInput);
    } else {
      focusInput();
    }

    if (typeof document !== 'undefined') {
      document.body.style.overflow = 'hidden';
    }

    return () => {
      if (typeof document !== 'undefined') {
        document.body.style.overflow = 'unset';
      }
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }
    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !isSubmitting) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isSubmitting, onClose]);

  if (!isOpen) {
    return null;
  }

  const handleFieldChange = (field) => (event) => {
    const value = event.target.value;
    setFormState((prev) => ({
      ...prev,
      [field]: field === 'name' ? sanitizeBranchName(value) : value
    }));
  };

  const handleBackdropClick = (event) => {
    if (event.target === event.currentTarget && !isSubmitting) {
      onClose();
    }
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    if (isSubmitting) {
      return;
    }
    onSubmit({
      name: formState.name.trim(),
      description: formState.description.trim()
    });
  };

  return (
    <div
      className="branch-modal-backdrop"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="branch-modal-title"
      data-testid="branch-create-modal"
    >
      <div className="branch-modal-panel">
        <div className="branch-modal-header">
          <div>
            <p className="branch-modal-eyebrow">Working branch</p>
            <h2 id="branch-modal-title">Create a new branch</h2>
          </div>
          <button
            type="button"
            className="branch-modal-close"
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="Close create branch modal"
            data-testid="branch-modal-close"
          >
            &times;
          </button>
        </div>

        <form className="branch-modal-form" onSubmit={handleSubmit}>
          <label className="branch-modal-label">
            Branch name
            <input
              ref={nameInputRef}
              type="text"
              value={formState.name}
              onChange={handleFieldChange('name')}
              placeholder="feature/assistant-ui"
              disabled={isSubmitting}
              data-testid="branch-modal-name"
            />
            <span className="branch-modal-hint">Leave blank to auto-generate a descriptive name.</span>
          </label>

          <label className="branch-modal-label">
            Description (optional)
            <textarea
              rows="3"
              value={formState.description}
              onChange={handleFieldChange('description')}
              placeholder="Explain what you plan to build"
              disabled={isSubmitting}
              data-testid="branch-modal-description"
            />
          </label>

          {errorMessage && (
            <div className="branch-modal-error" role="alert" data-testid="branch-modal-error">
              {errorMessage}
            </div>
          )}

          <div className="branch-modal-footer">
            <button
              type="button"
              className="branch-modal-button ghost"
              onClick={onClose}
              disabled={isSubmitting}
              data-testid="branch-modal-cancel"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="branch-modal-button primary"
              disabled={isSubmitting}
              data-testid="branch-modal-submit"
            >
              {isSubmitting ? 'Creating…' : 'Create branch'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default NewBranchModal;
