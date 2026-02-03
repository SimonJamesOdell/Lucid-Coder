import React from 'react';
import GettingStarted from './StatusPanel';
import SettingsModal from './SettingsModal';
import './LLMConfigModal.css';

const LLMConfigModal = ({ isOpen, onClose }) => {
  return (
    <SettingsModal
      isOpen={isOpen}
      onClose={onClose}
      title="Configure LLM"
      subtitle="Update your provider, model, or API credentials at any time."
      testId="llm-config-modal"
      closeTestId="llm-config-close"
      titleId="llm-config-title"
      panelClassName="llm-config-panel"
      bodyClassName="llm-config-body"
      closeLabel="Close LLM configuration"
    >
      <GettingStarted allowConfigured onConfigured={onClose} />
    </SettingsModal>
  );
};

export default LLMConfigModal;
