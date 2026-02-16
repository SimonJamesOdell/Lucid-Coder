import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AssetOptimizeModal from '../components/AssetOptimizeModal';

describe('AssetOptimizeModal', () => {
  test('does not render when closed', () => {
    render(
      <AssetOptimizeModal
        isOpen={false}
        asset={{ path: 'uploads/picture.png' }}
        onClose={vi.fn()}
      />
    );

    expect(screen.queryByTestId('asset-optimize-modal')).not.toBeInTheDocument();
  });

  test('renders selected asset path and default values', () => {
    render(
      <AssetOptimizeModal
        isOpen
        asset={{ path: 'uploads/picture.png' }}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByTestId('asset-optimize-modal')).toBeInTheDocument();
    expect(screen.getByText('uploads/picture.png')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /output type/i })).toHaveValue('auto');
    expect(screen.getByRole('slider', { name: /compression level/i })).toHaveValue('76');
    expect(screen.getByRole('slider', { name: /scaling/i })).toHaveValue('100');
  });

  test('submits manual optimize payload from controls', async () => {
    const user = userEvent.setup();
    const onManualOptimize = vi.fn();

    render(
      <AssetOptimizeModal
        isOpen
        asset={{ path: 'uploads/picture.png' }}
        onClose={vi.fn()}
        onManualOptimize={onManualOptimize}
      />
    );

    await user.selectOptions(screen.getByRole('combobox', { name: /output type/i }), 'webp');
    fireEvent.change(screen.getByRole('slider', { name: /compression level/i }), { target: { value: '61' } });
    fireEvent.change(screen.getByRole('slider', { name: /scaling/i }), { target: { value: '84' } });

    await user.click(screen.getByRole('button', { name: 'Optimize' }));

    expect(onManualOptimize).toHaveBeenCalledWith({
      quality: 61,
      scalePercent: 84,
      format: 'webp'
    });
  });

  test('runs auto optimize and close handlers', async () => {
    const user = userEvent.setup();
    const onAutoOptimize = vi.fn();
    const onClose = vi.fn();

    render(
      <AssetOptimizeModal
        isOpen
        asset={{ path: 'uploads/picture.png' }}
        onClose={onClose}
        onAutoOptimize={onAutoOptimize}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Auto Optimize' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onAutoOptimize).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('disables actions while optimizing and handles missing asset path', () => {
    render(
      <AssetOptimizeModal
        isOpen
        asset={{}}
        onClose={vi.fn()}
        onAutoOptimize={vi.fn()}
        onManualOptimize={vi.fn()}
        isAutoOptimizing
      />
    );

    expect(screen.getByRole('button', { name: 'Auto Optimizing…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Optimize' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });
});
