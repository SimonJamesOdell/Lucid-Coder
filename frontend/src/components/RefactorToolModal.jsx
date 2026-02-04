import React from 'react';
import ToolModal from './ToolModal';

const RefactorToolModal = ({ isOpen, onClose }) => {
  return (
    <ToolModal
      isOpen={isOpen}
      onClose={onClose}
      title="Refactor"
      subtitle="Make targeted improvements without changing behavior."
      testId="tool-refactor-modal"
      closeTestId="tool-refactor-close"
      titleId="tool-refactor-title"
    >
      <div className="tools-modal-placeholder">
        <h3>Coming soon</h3>
        <p>
          This tool will guide safe refactors: renames, extractions, and small structure improvements
          with test verification.
        </p>
        <ul>
          <li>Select scope (file / folder / repo)</li>
          <li>Choose refactor type (rename, extract, simplify)</li>
          <li>Run tests before/after</li>
        </ul>
      </div>
    </ToolModal>
  );
};

export default RefactorToolModal;
