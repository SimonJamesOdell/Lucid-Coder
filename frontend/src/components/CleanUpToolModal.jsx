import React from 'react';
import ToolModal from './ToolModal';

const CleanUpToolModal = ({ isOpen, onClose }) => {
  return (
    <ToolModal
      isOpen={isOpen}
      onClose={onClose}
      title="Clean Up"
      subtitle="Remove clutter and keep projects tidy."
      testId="tool-cleanup-modal"
      closeTestId="tool-cleanup-close"
      titleId="tool-cleanup-title"
    >
      <div className="tools-modal-placeholder">
        <h3>Coming soon</h3>
        <p>
          This tool will help you safely remove generated files, reset temporary state, and optionally
          standardize formatting.
        </p>
        <ul>
          <li>Preview changes before applying</li>
          <li>Clean common build artifacts</li>
          <li>Optionally re-run checks after cleanup</li>
        </ul>
      </div>
    </ToolModal>
  );
};

export default CleanUpToolModal;
