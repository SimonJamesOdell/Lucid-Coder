import React from 'react';
import { useAppState } from '../context/AppStateContext';
import GoalsPanel from './GoalsPanel';
import './GoalsTab.css';

const GoalsTab = () => {
  const { previewPanelState, resumePreviewAutomation } = useAppState();
  const automationPaused = Boolean(previewPanelState && previewPanelState.followAutomation === false);

  return (
    <GoalsPanel
      mode="tab"
      automationPaused={automationPaused}
      onResumeAutomation={resumePreviewAutomation}
    />
  );
};

export default GoalsTab;
