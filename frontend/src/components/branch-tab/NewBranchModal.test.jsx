import React from 'react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import NewBranchModal from './NewBranchModal';

const renderModal = (props = {}) => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onSubmit: vi.fn(),
    isSubmitting: false,
    errorMessage: null
  };
  return render(<NewBranchModal {...defaultProps} {...props} />);
};

describe('NewBranchModal', () => {
  beforeEach(() => {
    document.body.style.overflow = 'unset';
  });

  test('returns null when modal is closed', () => {
    const { container } = renderModal({ isOpen: false });
    expect(container).toBeEmptyDOMElement();
  });

  test('focuses input and sanitizes branch name', async () => {
    renderModal();
    const input = screen.getByTestId('branch-modal-name');

    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });

    await userEvent.type(input, 'My Feature Branch');
    expect(input).toHaveValue('My-Feature-Branch');
  });

  test('focuses input when requestAnimationFrame is unavailable', async () => {
    const originalRAF = window.requestAnimationFrame;
    // eslint-disable-next-line no-global-assign
    window.requestAnimationFrame = undefined;

    try {
      renderModal();
      const input = screen.getByTestId('branch-modal-name');
      expect(document.activeElement).toBe(input);
    } finally {
      // eslint-disable-next-line no-global-assign
      window.requestAnimationFrame = originalRAF;
    }
  });

  test('invokes onSubmit with trimmed payload', async () => {
    const onSubmit = vi.fn();
    renderModal({ onSubmit });

    const input = screen.getByTestId('branch-modal-name');
    const textarea = screen.getByTestId('branch-modal-description');
    await userEvent.type(input, 'feature login');
    await userEvent.type(textarea, '  add login form  ');

    const form = screen.getByTestId('branch-create-modal').querySelector('form');
    fireEvent.submit(form);
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'feature-login',
      description: 'add login form'
    });
  });

  test('backdrop click closes modal when not submitting', () => {
    const onClose = vi.fn();
    const { getByTestId } = renderModal({ onClose });

    fireEvent.mouseDown(getByTestId('branch-create-modal'));
    fireEvent.mouseUp(getByTestId('branch-create-modal'));
    fireEvent.click(getByTestId('branch-create-modal'));
    expect(onClose).toHaveBeenCalled();
  });

  test('backdrop click disabled while submitting', () => {
    const onClose = vi.fn();
    const { getByTestId } = renderModal({ onClose, isSubmitting: true });

    fireEvent.click(getByTestId('branch-create-modal'));
    expect(onClose).not.toHaveBeenCalled();
  });

  test('prevents submit while already submitting', () => {
    const onSubmit = vi.fn();
    renderModal({ onSubmit, isSubmitting: true });

    const modal = screen.getByTestId('branch-create-modal');
    const form = modal.querySelector('form');
    fireEvent.submit(form);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test('esc key closes modal when idle', () => {
    const onClose = vi.fn();
    renderModal({ onClose });

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  test('esc key does not close while submitting', () => {
    const onClose = vi.fn();
    renderModal({ onClose, isSubmitting: true });

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  test('renders error message when provided', () => {
    renderModal({ errorMessage: 'Duplicate branch' });
    expect(screen.getByTestId('branch-modal-error')).toHaveTextContent('Duplicate branch');
  });

  test('clicking cancel button triggers onClose', async () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    await userEvent.click(screen.getByTestId('branch-modal-cancel'));
    expect(onClose).toHaveBeenCalled();
  });
});
