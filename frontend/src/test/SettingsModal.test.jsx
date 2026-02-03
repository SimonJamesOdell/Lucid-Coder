import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, test, expect, vi } from 'vitest';
import SettingsModal from '../components/SettingsModal.jsx';

describe('SettingsModal', () => {
  test('renders title, subtitle, and header content', () => {
    const onClose = vi.fn();

    render(
      <SettingsModal
        isOpen
        onClose={onClose}
        title="Configure Git"
        subtitle="Test subtitle"
        headerContent={<span data-testid="header-extra">Extra</span>}
        testId="settings-modal"
        closeTestId="settings-close"
        titleId="settings-title"
      >
        <div>Body content</div>
      </SettingsModal>
    );

    expect(screen.getByRole('heading', { name: /configure git/i })).toBeInTheDocument();
    expect(screen.getByText('Test subtitle')).toBeInTheDocument();
    expect(screen.getByTestId('header-extra')).toBeInTheDocument();
    expect(screen.getByTestId('settings-close')).toBeInTheDocument();
    expect(screen.getByText('Body content')).toBeInTheDocument();
  });
});
