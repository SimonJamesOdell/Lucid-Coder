import React, { useEffect } from 'react';
import '../styles/Modal.css';

const Modal = ({ 
  isOpen, 
  onClose, 
  onConfirm, 
  title, 
  message, 
  confirmText = 'Confirm', 
  cancelText = 'Cancel',
  type = 'default', // 'default', 'danger', 'warning'
  isProcessing = false,
  processingMessage = '',
  confirmLoadingText = 'Working...',
  dismissOnBackdrop = true,
  dismissOnEscape = true
}) => {
  useEffect(() => {
    const handleEscapeKey = (event) => {
      if (event.key === 'Escape' && !isProcessing && dismissOnEscape) {
        onClose();
      }
    };

    if (isOpen) {
      if (dismissOnEscape) {
        document.addEventListener('keydown', handleEscapeKey);
      }
      // Prevent background scrolling
      document.body.style.overflow = 'hidden';
    }

    return () => {
      if (dismissOnEscape) {
        document.removeEventListener('keydown', handleEscapeKey);
      }
      document.body.style.overflow = 'unset';
    };
  }, [isOpen, onClose, isProcessing, dismissOnEscape]);

  const handleBackdropClick = (event) => {
    if (!dismissOnBackdrop) {
      return;
    }
    if (event.target === event.currentTarget && !isProcessing) {
      onClose();
    }
  };

  const handleClose = () => {
    if (!isProcessing) {
      onClose();
    }
  };

  const handleConfirm = () => {
    if (!isProcessing && typeof onConfirm === 'function') {
      onConfirm();
    }
  };

  if (!isOpen) return null;

  const canConfirm = typeof onConfirm === 'function' && confirmText !== null && confirmText !== undefined && confirmText !== '';

  return (
    <div className="modal-backdrop" onClick={handleBackdropClick} data-testid="modal-backdrop">
      <div
        className={`modal-content modal-${type}`}
        data-testid="modal-content"
        aria-busy={isProcessing}
      >
        <div className="modal-header">
          <h3 className="modal-title">{title}</h3>
          <button 
            className="modal-close" 
            onClick={handleClose}
            disabled={isProcessing}
            aria-label="Close modal"
            data-testid="modal-close"
          >
            ×
          </button>
        </div>
        
        <div className="modal-body">
          {typeof message === 'string'
            ? <p className="modal-message">{message}</p>
            : message}
          {isProcessing && (
            <div className="modal-processing" role="status" aria-live="polite">
              <span className="modal-processing-spinner" aria-hidden="true"></span>
              <span>{processingMessage || 'Working on it...'}</span>
            </div>
          )}
        </div>
        
        <div className="modal-footer">
          <button 
            className="modal-btn modal-btn-cancel" 
            onClick={handleClose}
            disabled={isProcessing}
            data-testid="modal-cancel"
          >
            {cancelText}
          </button>
          {canConfirm && (
            <button 
              className={`modal-btn modal-btn-confirm modal-btn-${type}`}
              onClick={handleConfirm}
              disabled={isProcessing}
              data-testid="modal-confirm"
            >
              {isProcessing ? confirmLoadingText : confirmText}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default Modal;