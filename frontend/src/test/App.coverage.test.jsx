import React from 'react'
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import App from '../App'
import { VERSION } from '../../../shared/version.mjs'

const useAppStateMock = vi.fn()

vi.mock('../context/AppStateContext', () => ({
  AppStateProvider: ({ children }) => <>{children}</>,
  useAppState: () => useAppStateMock()
}))

vi.mock('../components/Navigation', () => ({
  default: (props) => <div data-testid="nav" data-version={props?.versionLabel || ''} />
}))

vi.mock('../components/StatusPanel', () => ({
  default: (props) => <div data-testid="getting-started" data-allow-configured={props?.allowConfigured ? 'true' : 'false'} />
}))

vi.mock('../components/ProjectSelector', () => ({
  default: () => <div data-testid="project-selector" />
}))

vi.mock('../components/CreateProject', () => ({
  default: () => <div data-testid="create-project" />
}))

vi.mock('../components/ImportProject', () => ({
  default: () => <div data-testid="import-project" />
}))

vi.mock('../components/ProjectInspector', () => ({
  default: () => <div data-testid="project-inspector" />
}))

describe('App coverage branches', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    global.fetch = vi.fn((url) => {
      if (url === '/api/health') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
      }
      if (url === '/api/version') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ version: VERSION }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
    })

    useAppStateMock.mockReturnValue({
      currentView: 'main',
      currentProject: null,
      backendConnectivity: { status: 'online', lastError: null },
      isLLMConfigured: true,
      llmStatusLoaded: true,
      llmStatus: { configured: true, ready: true, reason: null },
      refreshLLMStatus: vi.fn(),
      reportBackendConnectivity: vi.fn()
    })
  })

  test('refreshes LLM status after backend returns online when previously configured state was missing', async () => {
    const refreshLLMStatus = vi.fn().mockResolvedValue(undefined)

    useAppStateMock.mockReturnValue({
      currentView: 'main',
      currentProject: null,
      backendConnectivity: { status: 'online', lastError: null },
      isLLMConfigured: false,
      llmStatusLoaded: true,
      llmStatus: { configured: false, ready: false, reason: null },
      refreshLLMStatus,
      reportBackendConnectivity: vi.fn()
    })

    render(<App />)

    await waitFor(() => {
      expect(refreshLLMStatus).toHaveBeenCalledTimes(1)
    })

    expect(screen.getByTestId('getting-started')).toBeInTheDocument()
  })

  test('shows backend overlay when /api/health responds non-OK', async () => {
    global.fetch = vi.fn((url) => {
      if (url === '/api/health') {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({ ok: false }) })
      }
      if (url === '/api/version') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ version: VERSION }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
    })

    render(<App />)

    expect(await screen.findByTestId('backend-offline-overlay')).toBeInTheDocument()
    expect(screen.getByText('Backend unavailable')).toBeInTheDocument()
    expect(screen.getByText('Backend unavailable (500)')).toBeInTheDocument()
    expect(screen.getByTestId('backend-retry')).toBeInTheDocument()
  })

  test('shows backend overlay when /api/health returns invalid JSON', async () => {
    global.fetch = vi.fn((url) => {
      if (url === '/api/health') {
        return Promise.resolve({ ok: true, status: 200, json: async () => 'not-an-object' })
      }
      if (url === '/api/version') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ version: VERSION }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
    })

    render(<App />)

    expect(await screen.findByTestId('backend-offline-overlay')).toBeInTheDocument()
    expect(screen.getByText('Backend returned an invalid health response')).toBeInTheDocument()
  })

  test('shows backend overlay when the backend check times out (AbortError)', async () => {
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' })
    global.fetch = vi.fn((url) => {
      if (url === '/api/health') {
        return Promise.reject(abortError)
      }
      if (url === '/api/version') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ version: VERSION }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
    })

    render(<App />)

    expect(await screen.findByTestId('backend-offline-overlay')).toBeInTheDocument()
    expect(screen.getByText('Backend check timed out')).toBeInTheDocument()
  })

  test('shows backend overlay with fallback copy when fetch rejects without an error message', async () => {
    global.fetch = vi.fn((url) => {
      if (url === '/api/health') {
        return Promise.reject({})
      }
      if (url === '/api/version') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ version: VERSION }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
    })

    render(<App />)

    expect(await screen.findByTestId('backend-offline-overlay')).toBeInTheDocument()
    expect(screen.getByText('Backend unreachable')).toBeInTheDocument()
  })

  test('shows settings loading while LLM status is still hydrating', async () => {
    useAppStateMock.mockReturnValue({
      currentView: 'main',
      currentProject: null,
      backendConnectivity: { status: 'offline', lastError: 'Backend unreachable' },
      isLLMConfigured: false,
      llmStatusLoaded: false,
      llmStatus: { configured: false, ready: false, reason: null },
      refreshLLMStatus: vi.fn(),
      reportBackendConnectivity: vi.fn()
    })

    render(<App />)

    expect(await screen.findByTestId('settings-loading')).toBeInTheDocument()
    expect(screen.getByTestId('backend-offline-overlay')).toBeInTheDocument()
    expect(screen.getByText('Backend unreachable')).toBeInTheDocument()
  })

  test('shows waiting-for-backend screen when offline and LLM is not configured', async () => {
    useAppStateMock.mockReturnValue({
      currentView: 'main',
      currentProject: null,
      backendConnectivity: { status: 'offline', lastError: 'Backend unreachable' },
      isLLMConfigured: false,
      llmStatusLoaded: true,
      llmStatus: { configured: false, ready: false, reason: 'LLM unavailable' },
      refreshLLMStatus: vi.fn(),
      reportBackendConnectivity: vi.fn()
    })

    render(<App />)

    expect(await screen.findByText('Waiting for backend…')).toBeInTheDocument()
    expect(screen.getByTestId('llm-status-reason')).toHaveTextContent('LLM unavailable')
  })

  test('renders create/import/main views when configured', async () => {
    useAppStateMock.mockReturnValue({
      currentView: 'create-project',
      currentProject: null,
      backendConnectivity: { status: 'online', lastError: null },
      isLLMConfigured: true,
      llmStatusLoaded: true,
      llmStatus: { configured: true, ready: true, reason: null },
      refreshLLMStatus: vi.fn(),
      reportBackendConnectivity: vi.fn()
    })

    const view = render(<App />)

    expect(await screen.findByTestId('nav')).toBeInTheDocument()
    expect(screen.getByTestId('create-project')).toBeInTheDocument()

    useAppStateMock.mockReturnValue({
      currentView: 'import-project',
      currentProject: null,
      backendConnectivity: { status: 'online', lastError: null },
      isLLMConfigured: true,
      llmStatusLoaded: true,
      llmStatus: { configured: true, ready: true, reason: null },
      refreshLLMStatus: vi.fn(),
      reportBackendConnectivity: vi.fn()
    })

    view.rerender(<App />)
    expect(await screen.findByTestId('import-project')).toBeInTheDocument()

    useAppStateMock.mockReturnValue({
      currentView: 'main',
      currentProject: null,
      backendConnectivity: { status: 'online', lastError: null },
      isLLMConfigured: true,
      llmStatusLoaded: true,
      llmStatus: { configured: true, ready: true, reason: null },
      refreshLLMStatus: vi.fn(),
      reportBackendConnectivity: vi.fn()
    })

    view.rerender(<App />)
    expect(await screen.findByTestId('project-selector')).toBeInTheDocument()
    expect(screen.getByTestId('getting-started')).toBeInTheDocument()

    useAppStateMock.mockReturnValue({
      currentView: 'main',
      currentProject: { id: 123, name: 'Project' },
      backendConnectivity: { status: 'online', lastError: null },
      isLLMConfigured: true,
      llmStatusLoaded: true,
      llmStatus: { configured: true, ready: true, reason: null },
      refreshLLMStatus: vi.fn(),
      reportBackendConnectivity: vi.fn()
    })

    view.rerender(<App />)
    expect(await screen.findByTestId('project-inspector')).toBeInTheDocument()
  })

  test('passes backend version label to navigation when /api/version responds', async () => {
    render(<App />)

    await waitFor(() => {
      expect(screen.getByTestId('nav')).toHaveAttribute('data-version', VERSION)
    })

    expect(global.fetch).toHaveBeenCalledWith('/api/version', expect.any(Object))
  })

  test('falls back to versionFile when /api/version omits version', async () => {
    global.fetch = vi.fn((url) => {
      if (url === '/api/health') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
      }
      if (url === '/api/version') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ versionFile: VERSION }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
    })

    render(<App />)

    await waitFor(() => {
      expect(screen.getByTestId('nav')).toHaveAttribute('data-version', VERSION)
    })
  })

  test('keeps navigation version empty when /api/version is non-OK', async () => {
    global.fetch = vi.fn((url) => {
      if (url === '/api/health') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
      }
      if (url === '/api/version') {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({ ok: false }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
    })

    render(<App />)

    await waitFor(() => {
      expect(screen.getByTestId('nav')).toHaveAttribute('data-version', '')
    })
  })

  test('keeps navigation version empty when /api/version returns invalid JSON', async () => {
    global.fetch = vi.fn((url) => {
      if (url === '/api/health') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
      }
      if (url === '/api/version') {
        return Promise.resolve({ ok: true, status: 200, json: async () => 'not-an-object' })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
    })

    render(<App />)

    await waitFor(() => {
      expect(screen.getByTestId('nav')).toHaveAttribute('data-version', '')
    })
  })

  test('keeps navigation version empty when /api/version fetch rejects', async () => {
    global.fetch = vi.fn((url) => {
      if (url === '/api/health') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
      }
      if (url === '/api/version') {
        return Promise.reject(new Error('nope'))
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
    })

    render(<App />)

    await waitFor(() => {
      expect(screen.getByTestId('nav')).toHaveAttribute('data-version', '')
    })
  })

  test('shows the persistent backend-offline banner while the app is otherwise usable', async () => {
    useAppStateMock.mockReturnValue({
      currentView: 'main',
      currentProject: { id: 123, name: 'Project' },
      backendConnectivity: { status: 'offline', lastError: 'Backend unreachable' },
      isLLMConfigured: true,
      llmStatusLoaded: true,
      llmStatus: { configured: true, ready: true, reason: null },
      refreshLLMStatus: vi.fn(),
      reportBackendConnectivity: vi.fn()
    })

    render(<App />)

    expect(await screen.findByTestId('nav')).toBeInTheDocument()
    expect(screen.getByTestId('backend-offline-overlay')).toBeInTheDocument()
    expect(screen.getByText('Backend unreachable')).toBeInTheDocument()
  })

  test('polls for backend recovery while offline', async () => {
    vi.useFakeTimers()

    const healthResponses = [
      Promise.reject(new Error('Backend unreachable')),
      Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
    ]

    global.fetch = vi.fn((url) => {
      if (url === '/api/health') {
        return healthResponses.shift()
      }
      if (url === '/api/version') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ version: VERSION }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
    })

    render(<App />)

    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()

    expect(screen.getByTestId('backend-offline-overlay')).toBeInTheDocument()

    await vi.advanceTimersByTimeAsync(5000)
    await Promise.resolve()

    const healthCalls = global.fetch.mock.calls.filter(([url]) => url === '/api/health')
    expect(healthCalls.length).toBe(2)

    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()

    expect(screen.queryByTestId('backend-offline-overlay')).not.toBeInTheDocument()

    vi.useRealTimers()
  })

  test('skips polling when a backend check is already in flight', async () => {
    vi.useFakeTimers()

    let resolveHealth
    const pendingHealth = new Promise((resolve) => {
      resolveHealth = resolve
    })

    global.fetch = vi.fn((url) => {
      if (url === '/api/health') {
        return pendingHealth
      }
      if (url === '/api/version') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ version: VERSION }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
    })

    render(<App />)

    await vi.advanceTimersByTimeAsync(5000)

    const healthCalls = global.fetch.mock.calls.filter(([url]) => url === '/api/health')
    expect(healthCalls.length).toBe(1)

    resolveHealth({ ok: false, status: 503, json: async () => ({ ok: false }) })

    await vi.runOnlyPendingTimersAsync()

    vi.useRealTimers()
  })
})
