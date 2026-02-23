import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import TestingSettingsModal from '../components/TestingSettingsModal.jsx';

describe('TestingSettingsModal', () => {
  const onClose = vi.fn();
  const onSave = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('does not render when closed', () => {
    render(
      <TestingSettingsModal
        isOpen={false}
        onClose={onClose}
        onSave={onSave}
        settings={{ coverageTarget: 100, maxSteps: 8 }}
      />
    );

    expect(screen.queryByTestId('testing-settings-modal')).toBeNull();
  });

  test('renders provided coverage target and max steps when open', () => {
    render(
      <TestingSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={{ coverageTarget: 70, maxSteps: 12 }}
      />
    );

    expect(screen.getByTestId('testing-coverage-slider')).toHaveValue('70');
    expect(screen.getByTestId('testing-coverage-value')).toHaveTextContent('70%');
    expect(screen.getByTestId('testing-max-steps-input')).toHaveValue(12);
  });

  test('falls back to default values when provided settings are invalid', () => {
    render(
      <TestingSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={{ coverageTarget: 0, maxSteps: 1 }}
      />
    );

    expect(screen.getByTestId('testing-coverage-slider')).toHaveValue('100');
    expect(screen.getByTestId('testing-coverage-value')).toHaveTextContent('100%');
    expect(screen.getByTestId('testing-max-steps-input')).toHaveValue(2);
  });

  test('falls back to default max steps when provided max steps is non-numeric', () => {
    render(
      <TestingSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={{ coverageTarget: 90, maxSteps: 'invalid-value' }}
      />
    );

    expect(screen.getByTestId('testing-max-steps-input')).toHaveValue(8);
    expect(screen.getByTestId('testing-max-steps-value')).toHaveTextContent('8');
  });

  test('submits selected coverage target and max steps', () => {
    render(
      <TestingSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={{ coverageTarget: 100, maxSteps: 8 }}
      />
    );

    fireEvent.change(screen.getByTestId('testing-coverage-slider'), { target: { value: '80' } });
    fireEvent.change(screen.getByTestId('testing-max-steps-input'), { target: { value: '16' } });
    fireEvent.submit(screen.getByTestId('testing-settings-form'));

    expect(onSave).toHaveBeenCalledWith({ coverageTarget: 80, maxSteps: 16 });
  });
});
