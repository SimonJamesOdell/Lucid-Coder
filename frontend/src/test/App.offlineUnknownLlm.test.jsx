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

describe('App (unknown LLM status) backend offline startup', () => {
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
      isLLMConfigured: false,
      llmStatusLoaded: true,
      llmStatus: {
        configured: false,
        ready: false,
        reason: 'Backend unreachable',
        requiresApiKey: null,
        hasApiKey: null
      }
    });
  });

  test('blocks on backend unavailable instead of showing LLM configuration flow', () => {
    render(<App />);

    expect(screen.getByTestId('backend-offline-overlay')).toBeInTheDocument();
    expect(screen.getByText('Backend unavailable')).toBeInTheDocument();
    expect(screen.getAllByText('Backend unreachable').length).toBeGreaterThan(0);

    // Should not show the GettingStarted/LLM configuration flow while offline.
    expect(screen.queryByTestId('getting-started')).not.toBeInTheDocument();
  });
});

describe('App (unknown backend connectivity) startup', () => {
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
        status: 'unknown',
        lastError: null
      },
      isLLMConfigured: false,
      llmStatusLoaded: true,
      llmStatus: {
        configured: false,
        ready: false,
        reason: null,
        requiresApiKey: null,
        hasApiKey: null
      }
    });
  });

  test('blocks on backend unavailable instead of showing LLM configuration flow', () => {
    render(<App />);

    expect(screen.getByTestId('backend-offline-overlay')).toBeInTheDocument();
    expect(screen.getByText('Backend unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('getting-started')).not.toBeInTheDocument();
  });
});
