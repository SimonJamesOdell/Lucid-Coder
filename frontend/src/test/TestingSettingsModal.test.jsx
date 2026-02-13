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
        settings={{ coverageTarget: 100 }}
      />
    );

    expect(screen.queryByTestId('testing-settings-modal')).toBeNull();
  });

  test('renders provided coverage target when open', () => {
    render(
      <TestingSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={{ coverageTarget: 70 }}
      />
    );

    expect(screen.getByTestId('testing-coverage-slider')).toHaveValue('70');
    expect(screen.getByTestId('testing-coverage-value')).toHaveTextContent('70%');
  });

  test('falls back to default coverage target when provided value is falsy', () => {
    render(
      <TestingSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={{ coverageTarget: 0 }}
      />
    );

    expect(screen.getByTestId('testing-coverage-slider')).toHaveValue('100');
    expect(screen.getByTestId('testing-coverage-value')).toHaveTextContent('100%');
  });

  test('submits selected coverage target', () => {
    render(
      <TestingSettingsModal
        isOpen
        onClose={onClose}
        onSave={onSave}
        settings={{ coverageTarget: 100 }}
      />
    );

    fireEvent.change(screen.getByTestId('testing-coverage-slider'), { target: { value: '80' } });
    fireEvent.submit(screen.getByTestId('testing-settings-form'));

    expect(onSave).toHaveBeenCalledWith({ coverageTarget: 80 });
  });
});
