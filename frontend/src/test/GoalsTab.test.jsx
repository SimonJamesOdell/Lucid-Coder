import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import GoalsTab from '../components/GoalsTab.jsx';

const goalsPanelSpy = vi.fn();

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

  it('renders the goals panel in tab mode', () => {
    render(<GoalsTab />);

    expect(screen.getByTestId('mock-goals-panel')).toBeInTheDocument();
    expect(goalsPanelSpy).toHaveBeenCalledTimes(1);

    const props = goalsPanelSpy.mock.calls[0][0];
    expect(props.mode).toBe('tab');
  });
});
