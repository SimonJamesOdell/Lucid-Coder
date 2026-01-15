import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import PreviewPanel from './PreviewPanel';

vi.mock('./PreviewTab', () => ({
  default: React.forwardRef(function PreviewTabStub(_props, _ref) {
    return <div data-testid="preview-tab-stub">Preview</div>;
  }),
}));

vi.mock('./GoalsTab', () => ({
  default: function GoalsTabStub() {
    return <div data-testid="goals-tab-stub">Goals</div>;
  }
}));

vi.mock('../context/AppStateContext', () => {
  return {
    useAppState: () => ({
      currentProject: { id: 123, name: 'Demo Project' },
      previewPanelState: { activeTab: 'preview', followAutomation: true },
      setPreviewPanelTab: vi.fn(),
      pausePreviewAutomation: vi.fn(),
      resumePreviewAutomation: vi.fn(),
      requestEditorFocus: vi.fn(),
      editorFocusRequest: null,
      hasBranchNotification: false,
      projectProcesses: null,
      refreshProcessStatus: vi.fn(),
      restartProject: vi.fn(),
      stopProjectProcess: vi.fn(),
      reportBackendConnectivity: vi.fn(),
      projectFiles: [],
      selectedFile: null,
      setSelectedFile: vi.fn(),
      testResults: null,
      gitBranches: [],
      gitCommits: [],
      gitStatus: null,
      processes: [],
      packages: [],
    }),
  };
});

describe('PreviewPanel goals button placement', () => {
  it('does not render the goals button in PreviewPanel', () => {
    render(<PreviewPanel />);

    expect(screen.queryByTestId('open-goals-modal')).toBeNull();
  });
});
