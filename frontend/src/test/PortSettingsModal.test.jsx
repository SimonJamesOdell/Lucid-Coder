import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import PortSettingsModal from '../components/PortSettingsModal.jsx';

describe('PortSettingsModal', () => {
  const onClose = vi.fn();
  const onSave = vi.fn();
  const defaultSettings = {
    frontendPortBase: 5100,
    backendPortBase: 5500
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('does not render when closed', () => {
    render(
      <PortSettingsModal
        isOpen={false}
        onClose={onClose}
        onSave={onSave}
        settings={defaultSettings}
      />
    );

    expect(screen.queryByTestId('port-settings-modal')).toBeNull();
  });

  test('renders form inputs with provided defaults when open', () => {
    render(
      <PortSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={{ frontendPortBase: 5200, backendPortBase: 5600 }}
      />
    );

    expect(screen.getByRole('heading', { name: /default project ports/i })).toBeInTheDocument();
    expect(screen.getByTestId('port-frontend-input')).toHaveValue(5200);
    expect(screen.getByTestId('port-backend-input')).toHaveValue(5600);
  });

  test('validates and reports errors before saving', async () => {
    const user = userEvent.setup();
    render(
      <PortSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={defaultSettings}
      />
    );

    const frontendInput = screen.getByTestId('port-frontend-input');
    const backendInput = screen.getByTestId('port-backend-input');

    await user.clear(frontendInput);
    await user.type(frontendInput, '80');
    await user.clear(backendInput);
    await user.type(backendInput, '80');
    await user.click(screen.getByTestId('port-settings-save'));

    expect(onSave).not.toHaveBeenCalled();

    await user.clear(frontendInput);
    await user.type(frontendInput, '5300');
    await user.clear(backendInput);
    await user.type(backendInput, '5300');
    await user.click(screen.getByTestId('port-settings-save'));

    expect(onSave).not.toHaveBeenCalled();
  });

  test('shows specific error message when frontend port is outside range', async () => {
    const user = userEvent.setup();
    render(
      <PortSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={defaultSettings}
      />
    );

    const form = screen.getByTestId('port-settings-form');
    await user.clear(screen.getByTestId('port-frontend-input'));
    await user.type(screen.getByTestId('port-frontend-input'), '70000');
    fireEvent.submit(form);

    const error = await screen.findByTestId('port-settings-error');
    expect(error).toHaveTextContent('Frontend port base must be between 1024 and 65535.');
    expect(onSave).not.toHaveBeenCalled();
  });

  test('blocks save with backend range error when backend is invalid', async () => {
    const user = userEvent.setup();
    render(
      <PortSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={defaultSettings}
      />
    );

    const form = screen.getByTestId('port-settings-form');
    await user.clear(screen.getByTestId('port-backend-input'));
    await user.type(screen.getByTestId('port-backend-input'), '80');
    fireEvent.submit(form);

    const error = await screen.findByTestId('port-settings-error');
    expect(error).toHaveTextContent('Backend port base must be between 1024 and 65535.');
    expect(onSave).not.toHaveBeenCalled();
  });

  test('prevents saving when frontend and backend port bases collide', async () => {
    const user = userEvent.setup();
    render(
      <PortSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={defaultSettings}
      />
    );

    const frontendInput = screen.getByTestId('port-frontend-input');
    const backendInput = screen.getByTestId('port-backend-input');

    await user.clear(frontendInput);
    await user.type(frontendInput, '5300');
    await user.clear(backendInput);
    await user.type(backendInput, '5300');

    fireEvent.submit(screen.getByTestId('port-settings-form'));

    const error = await screen.findByTestId('port-settings-error');
    expect(error).toHaveTextContent('Frontend and backend port bases should differ to avoid collisions.');
    expect(onSave).not.toHaveBeenCalled();
  });

  test('submits numerical values when valid', async () => {
    const user = userEvent.setup();
    const updatedSettings = { frontendPortBase: 5400, backendPortBase: 5900 };
    render(
      <PortSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={updatedSettings}
      />
    );

    await waitFor(() => expect(screen.getByTestId('port-frontend-input')).toHaveValue(5400));
    await waitFor(() => expect(screen.getByTestId('port-backend-input')).toHaveValue(5900));

    fireEvent.submit(screen.getByTestId('port-settings-form'));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(onSave).toHaveBeenCalledWith(updatedSettings);
  });

  test('close actions dismiss modal without saving', async () => {
    const user = userEvent.setup();
    render(
      <PortSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={defaultSettings}
      />
    );

    await user.click(screen.getByTestId('port-settings-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();

    onClose.mockClear();
    await user.click(screen.getByTestId('port-settings-cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId('port-settings-modal'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
