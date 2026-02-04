import React from 'react';
import SettingsModal from './SettingsModal';
import './ToolModal.css';

const ToolModal = ({
  isOpen,
  onClose,
  title,
  subtitle,
  testId,
  closeTestId,
  titleId,
  children
}) => {
  return (
    <SettingsModal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      testId={testId}
      closeTestId={closeTestId}
      titleId={titleId}
      panelClassName="tools-modal-panel"
      bodyClassName="tools-modal-body"
      closeLabel={`Close ${title}`}
    >
      <div className="tools-modal-content">
        {children}
      </div>
    </SettingsModal>
  );
};

export default ToolModal;
