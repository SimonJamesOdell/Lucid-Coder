import React from 'react';
import ToolModal from './ToolModal';

const AddTestsToolModal = ({ isOpen, onClose }) => {
  return (
    <ToolModal
      isOpen={isOpen}
      onClose={onClose}
      title="Add Tests"
      subtitle="Create high-signal tests to lock in behavior."
      testId="tool-add-tests-modal"
      closeTestId="tool-add-tests-close"
      titleId="tool-add-tests-title"
    >
      <div className="tools-modal-placeholder">
        <h3>Coming soon</h3>
        <p>
          This tool will help you pick a target area and generate a focused test plan (unit/integration)
          with minimal mocking.
        </p>
        <ul>
          <li>Pick a module or failing scenario</li>
          <li>Choose Vitest / Playwright scope</li>
          <li>Generate a starter test and iterate</li>
        </ul>
      </div>
    </ToolModal>
  );
};

export default AddTestsToolModal;
