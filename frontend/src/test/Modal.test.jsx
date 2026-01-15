import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, test, expect, vi } from 'vitest';
import Modal from '../components/Modal';

describe('Modal Component', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onConfirm: vi.fn(),
    title: 'Test Modal',
    message: 'This is a test message'
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('renders when isOpen is true', () => {
    render(<Modal {...defaultProps} />);
    
    expect(screen.getByTestId('modal-content')).toBeInTheDocument();
    expect(screen.getByText('Test Modal')).toBeInTheDocument();
    expect(screen.getByText('This is a test message')).toBeInTheDocument();
  });

  test('does not render when isOpen is false', () => {
    render(<Modal {...defaultProps} isOpen={false} />);
    
    expect(screen.queryByTestId('modal-content')).not.toBeInTheDocument();
  });

  test('calls onClose when close button is clicked', async () => {
    const user = userEvent.setup();
    render(<Modal {...defaultProps} />);
    
    const closeButton = screen.getByTestId('modal-close');
    await user.click(closeButton);
    
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  test('calls onClose when backdrop is clicked', async () => {
    const user = userEvent.setup();
    render(<Modal {...defaultProps} />);
    
    const backdrop = screen.getByTestId('modal-backdrop');
    await user.click(backdrop);
    
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  test('does not close when modal content is clicked', async () => {
    const user = userEvent.setup();
    render(<Modal {...defaultProps} />);
    
    const content = screen.getByTestId('modal-content');
    await user.click(content);
    
    expect(defaultProps.onClose).not.toHaveBeenCalled();
  });

  test('calls onConfirm when confirm button is clicked', async () => {
    const user = userEvent.setup();
    render(<Modal {...defaultProps} />);
    
    const confirmButton = screen.getByTestId('modal-confirm');
    await user.click(confirmButton);
    
    expect(defaultProps.onConfirm).toHaveBeenCalledTimes(1);
  });

  test('does not render a confirm button when onConfirm is not provided', () => {
    render(<Modal {...defaultProps} onConfirm={undefined} confirmText={undefined} />);

    expect(screen.getByTestId('modal-cancel')).toBeInTheDocument();
    expect(screen.queryByTestId('modal-confirm')).not.toBeInTheDocument();
  });

  test('calls onClose when cancel button is clicked', async () => {
    const user = userEvent.setup();
    render(<Modal {...defaultProps} />);
    
    const cancelButton = screen.getByTestId('modal-cancel');
    await user.click(cancelButton);
    
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  test('closes when Escape key is pressed', () => {
    render(<Modal {...defaultProps} />);
    
    fireEvent.keyDown(document, { key: 'Escape' });
    
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  test('renders custom button text', () => {
    render(
      <Modal 
        {...defaultProps} 
        confirmText="Delete Now" 
        cancelText="Keep It" 
      />
    );
    
    expect(screen.getByText('Delete Now')).toBeInTheDocument();
    expect(screen.getByText('Keep It')).toBeInTheDocument();
  });

  test('applies danger type styling', () => {
    render(<Modal {...defaultProps} type="danger" />);
    
    const content = screen.getByTestId('modal-content');
    expect(content).toHaveClass('modal-danger');
    
    const confirmButton = screen.getByTestId('modal-confirm');
    expect(confirmButton).toHaveClass('modal-btn-danger');
  });

  test('applies warning type styling', () => {
    render(<Modal {...defaultProps} type="warning" />);
    
    const content = screen.getByTestId('modal-content');
    expect(content).toHaveClass('modal-warning');
    
    const confirmButton = screen.getByTestId('modal-confirm');
    expect(confirmButton).toHaveClass('modal-btn-warning');
  });

  test('renders default button text when not provided', () => {
    render(<Modal {...defaultProps} confirmText={undefined} cancelText={undefined} />);

    expect(screen.getByText('Confirm')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  test('applies default type styling', () => {
    render(<Modal {...defaultProps} type={undefined} />);

    expect(screen.getByTestId('modal-content')).toHaveClass('modal-default');
    expect(screen.getByTestId('modal-confirm')).toHaveClass('modal-btn-default');
  });

  test('removes escape listener after closing', () => {
    const { rerender } = render(<Modal {...defaultProps} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);

    rerender(<Modal {...defaultProps} isOpen={false} />);
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  test('prevents body scroll when open', () => {
    const { rerender } = render(<Modal {...defaultProps} />);
    
    expect(document.body.style.overflow).toBe('hidden');
    
    rerender(<Modal {...defaultProps} isOpen={false} />);
    
    expect(document.body.style.overflow).toBe('unset');
  });

  test('renders processing state with custom messaging and disables actions', () => {
    render(
      <Modal
        {...defaultProps}
        isProcessing
        processingMessage="Deleting project..."
        confirmLoadingText="Deleting..."
      />
    );

    expect(screen.getByRole('status')).toHaveTextContent('Deleting project...');
    expect(screen.getByTestId('modal-confirm')).toHaveTextContent('Deleting...');
    expect(screen.getByTestId('modal-confirm')).toBeDisabled();
    expect(screen.getByTestId('modal-cancel')).toBeDisabled();
  });

  test('falls back to default processing message when none provided', () => {
    render(<Modal {...defaultProps} isProcessing />);

    expect(screen.getByText('Working on it...')).toBeInTheDocument();
  });
});