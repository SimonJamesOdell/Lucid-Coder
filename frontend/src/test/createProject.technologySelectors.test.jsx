import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import TechnologySelectors from '../components/create-project/TechnologySelectors';

function renderComponent(overrides = {}) {
  const props = {
    createLoading: false,
    projectSource: 'new',
    newProject: {
      frontend: { language: 'javascript', framework: 'react' },
      backend: { language: 'javascript', framework: 'express' }
    },
    frontendLanguages: ['javascript', 'typescript'],
    backendLanguages: ['javascript', 'python'],
    getFrontendFrameworks: () => ['react', 'vue'],
    getBackendFrameworks: () => ['express', 'fastapi'],
    onFrontendLanguageChange: vi.fn(),
    onFrontendFrameworkChange: vi.fn(),
    onBackendLanguageChange: vi.fn(),
    onBackendFrameworkChange: vi.fn(),
    ...overrides
  };

  render(<TechnologySelectors {...props} />);
  return props;
}

describe('create-project TechnologySelectors', () => {
  test('renders language and framework controls', () => {
    renderComponent();

    expect(screen.getByLabelText('Frontend Language *')).toBeInTheDocument();
    expect(screen.getByLabelText('Frontend Framework *')).toBeInTheDocument();
    expect(screen.getByLabelText('Backend Language *')).toBeInTheDocument();
    expect(screen.getByLabelText('Backend Framework *')).toBeInTheDocument();
  });

  test('disables selectors for git project source', () => {
    renderComponent({ projectSource: 'git' });

    expect(screen.getByLabelText('Frontend Language *')).toBeDisabled();
    expect(screen.getByLabelText('Frontend Framework *')).toBeDisabled();
    expect(screen.getByLabelText('Backend Language *')).toBeDisabled();
    expect(screen.getByLabelText('Backend Framework *')).toBeDisabled();
  });

  test('forwards selection changes to handlers', async () => {
    const user = userEvent.setup();
    const props = renderComponent();

    await user.selectOptions(screen.getByLabelText('Frontend Language *'), 'typescript');
    await user.selectOptions(screen.getByLabelText('Frontend Framework *'), 'vue');
    await user.selectOptions(screen.getByLabelText('Backend Language *'), 'python');
    await user.selectOptions(screen.getByLabelText('Backend Framework *'), 'fastapi');

    expect(props.onFrontendLanguageChange).toHaveBeenCalled();
    expect(props.onFrontendFrameworkChange).toHaveBeenCalled();
    expect(props.onBackendLanguageChange).toHaveBeenCalled();
    expect(props.onBackendFrameworkChange).toHaveBeenCalled();
  });
});
