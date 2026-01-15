import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AppContent } from '../App';
import { useAppState } from '../context/AppStateContext';

vi.mock('../context/AppStateContext', () => ({
  useAppState: vi.fn()
}));

const originalFetch = global.fetch;

const buildState = (overrides = {}) => ({
  currentView: 'main',
  currentProject: null,
  backendConnectivity: { status: 'online', lastError: null },
  isLLMConfigured: true,
  llmStatusLoaded: true,
  llmStatus: {},
  refreshLLMStatus: vi.fn(),
  projects: [],
  canUseProjects: true,
  canUseTools: true,
  canUseSettings: true,
  theme: 'dark',
  selectProject: vi.fn(),
  closeProject: vi.fn(),
  createProject: vi.fn(),
  importProject: vi.fn(),
  toggleTheme: vi.fn(),
  setPreviewPanelTab: vi.fn(),
  gitSettings: {},
  updateGitSettings: vi.fn(),
  portSettings: { frontendPortBase: 6100, backendPortBase: 6500 },
  updatePortSettings: vi.fn(),
  projectShutdownState: { isStopping: false, projectId: null, projectName: '', error: null },
  ...overrides
});

describe('AppContent navigation integration', () => {
  beforeEach(() => {
    useAppState.mockReset();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true })
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  test('renders Navigation after backend health check succeeds', async () => {
    useAppState.mockReturnValue(buildState());

    render(<AppContent />);

    await waitFor(() => {
      expect(screen.getByRole('navigation')).toBeInTheDocument();
    });

    expect(global.fetch).toHaveBeenCalledWith('/api/health', expect.any(Object));
  });
});
