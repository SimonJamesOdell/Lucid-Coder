import React from 'react'
import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import App from '../App'

const useAppStateMock = vi.fn()

vi.mock('../context/AppStateContext', () => ({
  AppStateProvider: ({ children }) => <>{children}</>,
  useAppState: () => useAppStateMock()
}))

vi.mock('../components/Navigation', () => ({
  default: () => <div data-testid="nav" />
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
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
    })

    useAppStateMock.mockReturnValue({
      currentView: 'main',
      currentProject: null,
      backendConnectivity: { status: 'online', lastError: null },
      isLLMConfigured: true,
      llmStatusLoaded: true,
      llmStatus: { configured: true, ready: true, reason: null },
      refreshLLMStatus: vi.fn()
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
      refreshLLMStatus
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
      refreshLLMStatus: vi.fn()
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
      refreshLLMStatus: vi.fn()
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
      refreshLLMStatus: vi.fn()
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
      refreshLLMStatus: vi.fn()
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
      refreshLLMStatus: vi.fn()
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
      refreshLLMStatus: vi.fn()
    })

    view.rerender(<App />)
    expect(await screen.findByTestId('project-inspector')).toBeInTheDocument()
  })

  test('shows the persistent backend-offline banner while the app is otherwise usable', async () => {
    useAppStateMock.mockReturnValue({
      currentView: 'main',
      currentProject: { id: 123, name: 'Project' },
      backendConnectivity: { status: 'offline', lastError: 'Backend unreachable' },
      isLLMConfigured: true,
      llmStatusLoaded: true,
      llmStatus: { configured: true, ready: true, reason: null },
      refreshLLMStatus: vi.fn()
    })

    render(<App />)

    expect(await screen.findByTestId('nav')).toBeInTheDocument()
    expect(screen.getByTestId('backend-offline-overlay')).toBeInTheDocument()
    expect(screen.getByText('Backend unreachable')).toBeInTheDocument()
  })
})
