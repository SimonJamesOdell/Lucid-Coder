import React, { useState, useEffect } from 'react';
import './ApprovalPanel.css';

export default function ApprovalModal({ decision, onClose }) {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    // only show modal for medium-confidence 'suggest_router_with_approval' decisions with valid data
    if (decision && decision.decision === 'suggest_router_with_approval' && decision.recommendation) {
      setIsOpen(true);
    }
  }, [decision]);

  if (!isOpen) {
    return null;
  }

  const handleApprove = () => {
    window.dispatchEvent(new CustomEvent('lucidcoder:apply-recommendation', { detail: decision }));
    setIsOpen(false);
    onClose?.();
  };

  const handleShowDiff = () => {
    window.dispatchEvent(new CustomEvent('lucidcoder:show-diff', { detail: decision }));
  };

  const handleDismiss = () => {
    setIsOpen(false);
    onClose?.();
  };

  return (
    <>
      {/* modal backdrop */}
      <div 
        className="approval-modal__backdrop" 
        onClick={handleDismiss} 
        aria-hidden="true"
      />
      {/* modal dialog */}
      <div 
        className="approval-modal" 
        role="dialog" 
        aria-modal="true"
        aria-label="Agent suggestion"
        data-testid="approval-modal"
      >
        <div className="approval-modal__content">
          <h2 className="approval-modal__title">Agent Suggestion</h2>
          <p className="approval-modal__message">{decision.recommendation}</p>
          <p className="approval-modal__rationale">{decision.rationale}</p>
          <div className="approval-modal__actions">
            <button 
              className="approval-modal__btn approval-modal__btn--primary"
              onClick={handleApprove} 
              data-testid="approve-recommendation"
            >
              Approve
            </button>
            <button 
              className="approval-modal__btn"
              onClick={handleShowDiff} 
              data-testid="show-diff"
            >
              Show diff
            </button>
            <button 
              className="approval-modal__btn"
              onClick={handleDismiss} 
              data-testid="dismiss-recommendation"
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
