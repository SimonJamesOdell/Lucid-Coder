import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import GoalsTab from '../components/GoalsTab.jsx';
import { useAppState } from '../context/AppStateContext.jsx';

const goalsPanelSpy = vi.fn();

vi.mock('../context/AppStateContext.jsx', () => ({
  useAppState: vi.fn()
}));

vi.mock('../components/GoalsPanel', () => ({
  default: (props) => {
    goalsPanelSpy(props);
    return <div data-testid="mock-goals-panel" />;
  }
}));

describe('GoalsTab', () => {
  beforeEach(() => {
    goalsPanelSpy.mockClear();
    vi.clearAllMocks();
  });

  it('passes automationPaused=true when followAutomation is false', () => {
    const resumePreviewAutomation = vi.fn();
    useAppState.mockReturnValue({
      previewPanelState: { followAutomation: false },
      resumePreviewAutomation
    });

    render(<GoalsTab />);

    expect(screen.getByTestId('mock-goals-panel')).toBeInTheDocument();
    expect(goalsPanelSpy).toHaveBeenCalledTimes(1);

    const props = goalsPanelSpy.mock.calls[0][0];
    expect(props.mode).toBe('tab');
    expect(props.automationPaused).toBe(true);
    expect(props.onResumeAutomation).toBe(resumePreviewAutomation);
  });

  it('passes automationPaused=false when followAutomation is true or missing', () => {
    const resumePreviewAutomation = vi.fn();
    useAppState.mockReturnValue({
      previewPanelState: { followAutomation: true },
      resumePreviewAutomation
    });

    render(<GoalsTab />);

    const props = goalsPanelSpy.mock.calls[0][0];
    expect(props.automationPaused).toBe(false);

    goalsPanelSpy.mockClear();
    useAppState.mockReturnValue({
      previewPanelState: null,
      resumePreviewAutomation
    });

    render(<GoalsTab />);

    const props2 = goalsPanelSpy.mock.calls[0][0];
    expect(props2.automationPaused).toBe(false);
  });
});
