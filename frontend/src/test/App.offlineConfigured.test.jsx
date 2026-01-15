import React from 'react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from '../App';

const useAppStateMock = vi.fn();

vi.mock('../context/AppStateContext', () => ({
  AppStateProvider: ({ children }) => <>{children}</>,
  useAppState: () => useAppStateMock()
}));

vi.mock('../components/Navigation', () => ({
  default: () => <div data-testid="nav" />
}));

vi.mock('../components/StatusPanel', () => ({
  default: () => <div data-testid="getting-started" />
}));

vi.mock('../components/ProjectSelector', () => ({
  default: () => <div data-testid="project-selector" />
}));

vi.mock('../components/CreateProject', () => ({
  default: () => <div data-testid="create-project" />
}));

vi.mock('../components/ImportProject', () => ({
  default: () => <div data-testid="import-project" />
}));

vi.mock('../components/ProjectInspector', () => ({
  default: () => <div data-testid="project-inspector" />
}));

describe('App (configured) backend offline overlay', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    global.fetch = vi.fn((url) => {
      if (url === '/api/health') {
        return Promise.reject(new Error('Backend unreachable'));
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) });
    });

    useAppStateMock.mockReturnValue({
      currentView: 'main',
      currentProject: null,
      backendConnectivity: {
        status: 'offline',
        lastError: 'Backend unreachable'
      },
      isLLMConfigured: true,
      llmStatusLoaded: true,
      llmStatus: {
        configured: true,
        ready: true,
        reason: null
      }
    });
  });

  test('shows the backend offline overlay even when LLM is configured', () => {
    render(<App />);

    expect(screen.getByTestId('backend-offline-overlay')).toBeInTheDocument();
    expect(screen.getByText('Backend unavailable')).toBeInTheDocument();
    expect(screen.getByText('Backend unreachable')).toBeInTheDocument();

    // Early backend check blocks the main shell.
    expect(screen.queryByTestId('nav')).not.toBeInTheDocument();
    expect(screen.queryByTestId('project-selector')).not.toBeInTheDocument();
  });
});
