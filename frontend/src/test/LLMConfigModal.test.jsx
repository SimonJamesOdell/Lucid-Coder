import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import LLMConfigModal from '../components/LLMConfigModal.jsx';

const mockStatusPanel = vi.fn();

vi.mock('../components/StatusPanel', () => ({
  __esModule: true,
  default: (props) => {
    mockStatusPanel(props);
    return (
      <div
        data-testid="mock-status-panel"
        onClick={() => props.onConfigured?.()}
      >
        Mock Status Panel
      </div>
    );
  }
}));

describe('LLMConfigModal', () => {
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('does not render when closed', () => {
    render(<LLMConfigModal isOpen={false} onClose={onClose} />);
    expect(screen.queryByTestId('llm-config-modal')).toBeNull();
    expect(mockStatusPanel).not.toHaveBeenCalled();
  });

  test('renders header and status panel when open', () => {
    render(<LLMConfigModal isOpen onClose={onClose} />);

    expect(screen.getByRole('heading', { name: /configure llm/i })).toBeInTheDocument();
    expect(screen.getByText(/Update your provider/i)).toBeInTheDocument();
    expect(screen.getByTestId('mock-status-panel')).toBeInTheDocument();
    expect(mockStatusPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        allowConfigured: true,
        onConfigured: expect.any(Function)
      })
    );
  });

  test('closes when close button is clicked', async () => {
    const user = userEvent.setup();
    render(<LLMConfigModal isOpen onClose={onClose} />);

    const closeButton = screen.getByTestId('llm-config-close');
    await user.click(closeButton);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('closes when backdrop is clicked', async () => {
    const user = userEvent.setup();
    render(<LLMConfigModal isOpen onClose={onClose} />);

    const backdrop = screen.getByTestId('llm-config-modal');
    await user.click(backdrop);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('does not close when clicking inside the panel', async () => {
    const user = userEvent.setup();
    render(<LLMConfigModal isOpen onClose={onClose} />);

    await user.click(screen.getByRole('heading', { name: /configure llm/i }));
    expect(onClose).not.toHaveBeenCalled();
  });

  test('closes when status panel reports configuration success', async () => {
    const user = userEvent.setup();
    render(<LLMConfigModal isOpen onClose={onClose} />);

    const statusPanel = screen.getByTestId('mock-status-panel');
    await user.click(statusPanel);

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
