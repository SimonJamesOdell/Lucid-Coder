import React from 'react';
import ToolModal from './ToolModal';

const AuditSecurityToolModal = ({ isOpen, onClose }) => {
  return (
    <ToolModal
      isOpen={isOpen}
      onClose={onClose}
      title="Audit Security"
      subtitle="Scan for common issues and dependency vulnerabilities."
      testId="tool-audit-security-modal"
      closeTestId="tool-audit-security-close"
      titleId="tool-audit-security-title"
    >
      <div className="tools-modal-placeholder">
        <h3>Coming soon</h3>
        <p>
          This tool will summarize dependency vulnerabilities and highlight common security footguns
          in config and runtime behavior.
        </p>
        <ul>
          <li>Dependency audit summary</li>
          <li>Secrets and token handling checks</li>
          <li>Suggested remediations</li>
        </ul>
      </div>
    </ToolModal>
  );
};

export default AuditSecurityToolModal;
