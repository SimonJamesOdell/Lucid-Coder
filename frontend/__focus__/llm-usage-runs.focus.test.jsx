import React from 'react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LLMUsageTab from '../src/components/LLMUsageTab';

vi.mock('../src/components/RunsTab', () => ({
  __esModule: true,
  default: () => <div data-testid="mock-runs-tab" />
}));

describe('LLMUsageTab', () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, metrics: { counters: {} } })
    });
  });

  test('switches between usage and runs views', async () => {
    const user = userEvent.setup();
    render(<LLMUsageTab project={{ id: 1 }} />);

    const usageTab = screen.getByTestId('llm-usage-tab-usage');
    const runsTab = screen.getByTestId('llm-usage-tab-runs');

    expect(usageTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('LLM Usage')).toBeInTheDocument();

    await user.click(runsTab);

    expect(runsTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('mock-runs-tab')).toBeInTheDocument();
    expect(screen.queryByText('LLM Usage')).toBeNull();
  });
});
