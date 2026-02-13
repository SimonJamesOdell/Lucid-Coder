import React from 'react'
import { describe, test, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { AppStateProvider, useAppState, __appStateTestHelpers } from '../context/AppStateContext'
import { mockApiResponse } from './setup'

const defaultGitSettingsPayload = {
  workflow: 'local',
  provider: 'github',
  remoteUrl: '',
  username: '',
  defaultBranch: 'main',
  token: ''
}

const defaultPortSettingsPayload = {
  frontendPortBase: 6100,
  backendPortBase: 6500
}

const defaultProcessStatusPayload = {
  projectId: 'p1',
  isRunning: false,
  processes: {
    frontend: null,
    backend: null
  },
  ports: {
    active: { frontend: null, backend: null },
    stored: { frontend: null, backend: null },
    preferred: { frontend: 5173, backend: 3000 }
  }
}

const renderUseAppState = () => renderHook(() => useAppState(), {
  wrapper: ({ children }) => <AppStateProvider>{children}</AppStateProvider>
})

const gitSettingsResponse = (overrides = {}) => mockApiResponse({
  success: true,
  settings: {
    ...defaultGitSettingsPayload,
    ...overrides
  }
})

const projectGitSettingsResponse = (overrides = {}, inheritsFromGlobal = true, globalOverrides = {}) => {
  const globalSettings = {
    ...defaultGitSettingsPayload,
    ...globalOverrides
  }
  const projectSettings = inheritsFromGlobal
    ? null
    : {
        ...defaultGitSettingsPayload,
        ...overrides
      }
  const effectiveSettings = inheritsFromGlobal
    ? globalSettings
    : {
        ...globalSettings,
        ...overrides
      }

  return mockApiResponse({
    success: true,
    inheritsFromGlobal,
    settings: effectiveSettings,
    effectiveSettings,
    projectSettings,
    globalSettings
  })
}

const portSettingsResponse = (overrides = {}) => mockApiResponse({
  success: true,
  settings: {
    ...defaultPortSettingsPayload,
    ...overrides
  }
})

const testingSettingsResponse = (overrides = {}) => mockApiResponse({
  success: true,
  settings: {
    coverageTarget: 100,
    ...overrides
  }
})

const processStatusResponse = (overrides = {}) => mockApiResponse({
  success: true,
  ...defaultProcessStatusPayload,
  ...overrides
})

let llmStatusPayload = null

describe('AppStateContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    llmStatusPayload = null
    fetch.mockReset()
    fetch.mockImplementation((url = '', options = {}) => {
      if (url === '/api/llm/status') {
        if (llmStatusPayload) {
          return Promise.resolve(mockApiResponse({
            success: true,
            configured: true,
            ready: Boolean(llmStatusPayload.ready),
            config: llmStatusPayload.config
          }))
        }
        return Promise.resolve(mockApiResponse({
          success: true,
          configured: false,
          ready: false,
          reason: 'No LLM configuration found'
        }))
      }
      if (url === '/api/projects' && (!options.method || options.method === 'GET')) {
        return Promise.resolve(mockApiResponse({ success: true, projects: [] }))
      }
      if (url === '/api/settings/git') {
        return Promise.resolve(gitSettingsResponse())
      }
      if (url === '/api/settings/ports') {
        return Promise.resolve(portSettingsResponse())
      }
      if (typeof url === 'string' && url.includes('/git-settings')) {
        return Promise.resolve(projectGitSettingsResponse({}, true))
      }
      if (typeof url === 'string' && url.includes('/git/status')) {
        return Promise.resolve(mockApiResponse({
          success: true,
          status: {
            branch: 'main',
            ahead: 0,
            behind: 0,
            hasRemote: true,
            dirty: false
          }
        }))
      }
      if (typeof url === 'string' && url.includes('/git/fetch')) {
        return Promise.resolve(mockApiResponse({
          success: true,
          status: {
            branch: 'main',
            ahead: 0,
            behind: 0,
            hasRemote: true,
            dirty: false
          }
        }))
      }
      if (typeof url === 'string' && url.includes('/git/pull')) {
        return Promise.resolve(mockApiResponse({
          success: true,
          status: {
            branch: 'main',
            ahead: 0,
            behind: 0,
            hasRemote: true,
            dirty: false
          },
          strategy: 'noop'
        }))
      }
      if (typeof url === 'string' && url.includes('/processes')) {
        const match = url.match(/\/api\/projects\/(.+?)\/processes/)
        const projectId = match?.[1] || 'p1'
        return Promise.resolve(processStatusResponse({ projectId }))
      }
      return Promise.resolve(mockApiResponse({ success: true }))
    })
    document.documentElement.setAttribute('data-theme', 'dark')
  })
 
  test('provides initial state correctly', async () => {
    const { result } = renderUseAppState()

    expect(result.current.isLLMConfigured).toBe(false)
    expect(result.current.currentProject).toBeNull()
    expect(result.current.projects).toEqual([])
    expect(result.current.theme).toBe('dark')
    expect(result.current.currentView).toBe('main')
    expect(result.current.canUseProjects).toBe(false)
  })

  test('reportBackendConnectivity ignores unknown status values', async () => {
    const { result } = renderUseAppState()

    await waitFor(() => {
      expect(result.current.backendConnectivity?.status).toBe('online')
    })

    await act(async () => {
      result.current.reportBackendConnectivity('unknown-status')
    })

    expect(result.current.backendConnectivity?.status).toBe('online')
  })

  test('reportBackendConnectivity stores string error payload when offline', async () => {
    const { result } = renderUseAppState()

    await waitFor(() => {
      expect(result.current.backendConnectivity?.status).toBe('online')
    })

    await act(async () => {
      result.current.reportBackendConnectivity('offline', 'explicit offline reason')
    })

    expect(result.current.backendConnectivity?.status).toBe('offline')
    expect(result.current.backendConnectivity?.lastError).toBe('explicit offline reason')
  })

  test('trackedFetch marks backend offline when responses are gateway errors', async () => {
    fetch.mockImplementation(() => Promise.resolve(mockApiResponse({ success: false }, false, 502)))

    const { result } = renderUseAppState()

    await waitFor(() => {
      expect(result.current.backendConnectivity?.status).toBe('offline')
    })
  })

  test('trackedFetch marks backend offline when responses are gateway errors (503/504)', async () => {
    fetch.mockImplementation(() => Promise.resolve(mockApiResponse({ success: false }, false, 503)))

    const { result, unmount } = renderUseAppState()

    await waitFor(() => {
      expect(result.current.backendConnectivity?.status).toBe('offline')
    })

    unmount()

    fetch.mockImplementation(() => Promise.resolve(mockApiResponse({ success: false }, false, 504)))
    const second = renderUseAppState()

    await waitFor(() => {
      expect(second.result.current.backendConnectivity?.status).toBe('offline')
    })
  })

  test('trackedFetch treats 404 on probe endpoints as offline (dev proxy)', async () => {
    fetch.mockImplementation(() => Promise.resolve(mockApiResponse({ success: true })))

    const { result } = renderUseAppState()

    fetch.mockImplementation(() => Promise.resolve(mockApiResponse({ success: false }, false, 404)))
    await act(async () => {
      await __appStateTestHelpers.trackedFetch('/api/projects')
    })

    await waitFor(() => {
      expect(result.current.backendConnectivity?.status).toBe('offline')
    })
  })

  test('trackedFetch does not treat non-string request URLs as connectivity probes', async () => {
    fetch.mockImplementation(() => Promise.resolve(mockApiResponse({ success: true })))

    const { result } = renderUseAppState()

    fetch.mockImplementation(() => Promise.resolve(mockApiResponse({ success: false }, false, 404)))
    await act(async () => {
      await __appStateTestHelpers.trackedFetch(new Request('/api/projects'))
    })

    await waitFor(() => {
      expect(result.current.backendConnectivity?.status).toBe('online')
    })
  })

  test('setPreviewPanelTab ignores invalid tab values', async () => {
    const { result } = renderUseAppState()

    const initial = result.current.previewPanelState
    expect(initial.activeTab).toBe('preview')
    expect(initial.followAutomation).toBe(true)

    await act(async () => {
      result.current.setPreviewPanelTab(null)
      result.current.setPreviewPanelTab('   ')
      result.current.setPreviewPanelTab('not-a-tab')
    })

    expect(result.current.previewPanelState).toEqual(initial)
  })

  test('setPreviewPanelTab normalizes aliases and only pauses automation on explicit user Goals click', async () => {
    const { result } = renderUseAppState()

    await act(async () => {
      result.current.setPreviewPanelTab('tests', { source: 'user' })
    })

    expect(result.current.previewPanelState.activeTab).toBe('test')
    expect(result.current.previewPanelState.followAutomation).toBe(true)

    await act(async () => {
      result.current.setPreviewPanelTab('files', { source: 'user' })
    })

    expect(result.current.previewPanelState.activeTab).toBe('files')
    expect(result.current.previewPanelState.followAutomation).toBe(true)

    await act(async () => {
      result.current.setPreviewPanelTab('goals', { source: 'user' })
    })

    expect(result.current.previewPanelState.activeTab).toBe('goals')
    expect(result.current.previewPanelState.followAutomation).toBe(false)

    await act(async () => {
      result.current.setPreviewPanelTab('branches', { source: 'user' })
    })

    expect(result.current.previewPanelState.activeTab).toBe('branch')
    expect(result.current.previewPanelState.followAutomation).toBe(false)

    await act(async () => {
      result.current.setPreviewPanelTab('llm usage', { source: 'user' })
    })

    expect(result.current.previewPanelState.activeTab).toBe('llm-usage')
    expect(result.current.previewPanelState.followAutomation).toBe(false)

    await act(async () => {
      result.current.setPreviewPanelTab('runs', { source: 'user' })
    })

    expect(result.current.previewPanelState.activeTab).toBe('llm-usage')
    expect(result.current.previewPanelState.followAutomation).toBe(false)
  })

  test('setPreviewPanelTab restores followAutomation for agent or automation sources', async () => {
    const { result } = renderUseAppState()

    await act(async () => {
      result.current.setPreviewPanelTab('goals', { source: 'user' })
    })
    expect(result.current.previewPanelState.followAutomation).toBe(false)

    await act(async () => {
      result.current.setPreviewPanelTab('files', { source: 'agent' })
    })
    expect(result.current.previewPanelState.activeTab).toBe('files')
    expect(result.current.previewPanelState.followAutomation).toBe(true)

    await act(async () => {
      result.current.setPreviewPanelTab('processes', { source: 'automation' })
    })
    expect(result.current.previewPanelState.activeTab).toBe('processes')
    expect(result.current.previewPanelState.followAutomation).toBe(true)
  })

  test('setPreviewPanelTab treats non-string sources as unknown and no-ops when state is unchanged', async () => {
    const { result } = renderUseAppState()

    await act(async () => {
      result.current.setPreviewPanelTab('files', { source: null })
    })

    const firstState = result.current.previewPanelState
    expect(firstState.activeTab).toBe('files')
    expect(firstState.followAutomation).toBe(true)

    await act(async () => {
      result.current.setPreviewPanelTab('files', { source: null })
    })

    expect(result.current.previewPanelState).toBe(firstState)
  })

  test('pausePreviewAutomation and resumePreviewAutomation are idempotent', async () => {
    const { result } = renderUseAppState()

    expect(result.current.previewPanelState.followAutomation).toBe(true)

    await act(async () => {
      result.current.pausePreviewAutomation()
    })
    expect(result.current.previewPanelState.followAutomation).toBe(false)

    await act(async () => {
      result.current.pausePreviewAutomation()
    })
    expect(result.current.previewPanelState.followAutomation).toBe(false)

    await act(async () => {
      result.current.resumePreviewAutomation()
    })
    expect(result.current.previewPanelState.followAutomation).toBe(true)

    await act(async () => {
      result.current.resumePreviewAutomation()
    })
    expect(result.current.previewPanelState.followAutomation).toBe(true)
  })

  test('reportBackendConnectivity sets online and uses default offline message fallback', async () => {
    const { result } = renderUseAppState()

    await waitFor(() => {
      expect(result.current.backendConnectivity?.status).toBe('online')
    })

    await act(async () => {
      result.current.reportBackendConnectivity('offline', {})
    })
    expect(result.current.backendConnectivity?.status).toBe('offline')
    expect(result.current.backendConnectivity?.lastError).toBe('Backend unreachable')

    await act(async () => {
      result.current.reportBackendConnectivity('online', new Error('ignored'))
    })
    expect(result.current.backendConnectivity?.status).toBe('online')
    expect(result.current.backendConnectivity?.lastError).toBeNull()
  })

  test('hydrates LLM config from backend and loads current project from localStorage', async () => {
    llmStatusPayload = {
      ready: true,
      config: {
        provider: 'groq',
        model: 'llama-3.1-70b-versatile',
        api_url: 'https://api.groq.com/openai/v1',
        requires_api_key: true,
        has_api_key: true
      }
    }
    const storedProject = { id: 'abc', name: 'Stored Project' }
    localStorage.setItem('currentProject', JSON.stringify(storedProject))

    const { result } = renderUseAppState()

    await waitFor(() => {
      expect(result.current.isLLMConfigured).toBe(true)
      expect(result.current.currentProject?.id).toBe('abc')
    })
  })

  test('configureLLM updates in-memory state', async () => {
    const { result } = renderUseAppState()
    const config = { provider: 'groq', model: 'llama-3.1-70b-versatile' }

    await act(async () => {
      result.current.configureLLM(config)
    })

    expect(result.current.isLLMConfigured).toBe(true)
    expect(result.current.llmConfig).toEqual(config)
  })

  test('selectProject updates state and makes API call to start project', async () => {
    const startResponse = { message: 'Project started' }
    fetch
      .mockResolvedValueOnce(mockApiResponse({ success: true, projects: [] })) // initial load
      .mockResolvedValueOnce(mockApiResponse({ success: true, configured: false, ready: false, reason: 'No LLM configuration found' })) // llm status
      .mockResolvedValueOnce(gitSettingsResponse())
      .mockResolvedValueOnce(portSettingsResponse())
      .mockResolvedValueOnce(testingSettingsResponse())
    const { result } = renderUseAppState()
    const project = { id: 'p1', name: 'Project One' }

    fetch
      .mockResolvedValueOnce(projectGitSettingsResponse({}, true))
      .mockResolvedValueOnce(mockApiResponse(startResponse))

    await act(async () => {
      await result.current.selectProject(project)
    })

    expect(result.current.currentProject?.id).toBe('p1')
    const startCall = fetch.mock.calls.find(([url]) => url === '/api/projects/p1/start')
    expect(startCall?.[0]).toBe('/api/projects/p1/start')
    expect(startCall?.[1]).toEqual(expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }))
  })

  test('createProject makes API call and updates state', async () => {
    const serverProject = {
      id: 'server-1',
      name: 'Server Project',
      description: '',
      frontend: { language: 'javascript', framework: 'react' },
      backend: { language: 'javascript', framework: 'express' }
    }

    fetch
      .mockResolvedValueOnce(mockApiResponse({ success: true, projects: [] })) // initial load
      .mockResolvedValueOnce(mockApiResponse({ success: true, configured: false, ready: false, reason: 'No LLM configuration found' })) // llm status
      .mockResolvedValueOnce(gitSettingsResponse())
      .mockResolvedValueOnce(portSettingsResponse())
      .mockResolvedValueOnce(testingSettingsResponse())
      .mockResolvedValueOnce(mockApiResponse({ success: true, project: serverProject })) // create
      .mockResolvedValueOnce(projectGitSettingsResponse({}, true))
      .mockResolvedValueOnce(mockApiResponse({ message: 'started' })) // start project

    const { result } = renderUseAppState()

    await act(async () => {
      await result.current.createProject({ name: 'Server Project' })
    })

    expect(result.current.projects).toHaveLength(1)
    expect(result.current.currentProject?.id).toBe('server-1')
    expect(fetch).toHaveBeenCalledWith('/api/projects', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }))
  })

  test('importProject calls backend and updates state', async () => {
    const serverProject = { id: 'imported', name: 'Imported Project' }

    fetch
      .mockResolvedValueOnce(mockApiResponse({ success: true, projects: [] }))
      .mockResolvedValueOnce(mockApiResponse({ success: true, configured: false, ready: false, reason: 'No LLM configuration found' }))
      .mockResolvedValueOnce(gitSettingsResponse())
      .mockResolvedValueOnce(portSettingsResponse())
      .mockResolvedValueOnce(testingSettingsResponse())
      .mockResolvedValueOnce(mockApiResponse({ success: true, project: serverProject }))
      .mockResolvedValueOnce(projectGitSettingsResponse({}, true))
      .mockResolvedValueOnce(mockApiResponse({ message: 'started' }))

    const { result } = renderUseAppState()

    await act(async () => {
      await result.current.importProject({ name: 'Imported Project' })
    })

    expect(result.current.projects).toHaveLength(1)
    expect(result.current.projects[0].name).toBe('Imported Project')
    expect(result.current.currentProject?.id).toBe('imported')
  })

  test('importProject uses backend project payload', async () => {
    const serverProject = { id: 'server-99', name: 'Backend Project' }

    fetch
      .mockResolvedValueOnce(mockApiResponse({ success: true, projects: [] }))
      .mockResolvedValueOnce(mockApiResponse({ success: true, configured: false, ready: false, reason: 'No LLM configuration found' }))
      .mockResolvedValueOnce(gitSettingsResponse())
      .mockResolvedValueOnce(portSettingsResponse())
      .mockResolvedValueOnce(testingSettingsResponse())
      .mockResolvedValueOnce(mockApiResponse({ success: true, project: serverProject }))
      .mockResolvedValueOnce(projectGitSettingsResponse({}, true))
      .mockResolvedValueOnce(mockApiResponse({ message: 'started' }))

    const { result } = renderUseAppState()

    await act(async () => {
      await result.current.importProject({ name: 'Backend Project' })
    })

    expect(result.current.projects[0].id).toBe('server-99')
  })

  test('toggleTheme switches between dark and light', async () => {
    const setAttributeSpy = vi.spyOn(document.documentElement, 'setAttribute')
    const { result } = renderUseAppState()

    await act(async () => {
      result.current.toggleTheme()
    })

    expect(result.current.theme).toBe('light')
    expect(setAttributeSpy).toHaveBeenCalledWith('data-theme', 'light')

    await act(async () => {
      result.current.toggleTheme()
    })

    expect(result.current.theme).toBe('dark')
    setAttributeSpy.mockRestore()
  })

  test('logout clears all state and localStorage', async () => {
    const { result } = renderUseAppState()

    fetch
      .mockResolvedValueOnce(mockApiResponse({ success: true, projects: [] }))
      .mockResolvedValueOnce(mockApiResponse({ success: true, configured: false, ready: false, reason: 'No LLM configuration found' }))
      .mockResolvedValueOnce(gitSettingsResponse())
      .mockResolvedValueOnce(portSettingsResponse())
      .mockResolvedValueOnce(mockApiResponse({ success: true, project: { id: '1', name: 'Demo' } }))
      .mockResolvedValueOnce(projectGitSettingsResponse({}, true))
      .mockResolvedValueOnce(mockApiResponse({ message: 'started' }))

    await act(async () => {
      result.current.configureLLM({ provider: 'groq' })
      await result.current.importProject({ name: 'Demo' })
    })

    await act(async () => {
      result.current.logout()
    })

    expect(result.current.isLLMConfigured).toBe(false)
    expect(result.current.currentProject).toBeNull()
    expect(result.current.projects).toEqual([])
    expect(localStorage.getItem('llmConfig')).toBeNull()
    expect(localStorage.getItem('currentProject')).toBeNull()
  })

  test('computed values update correctly', async () => {
    const { result } = renderUseAppState()

    expect(result.current.hasProject).toBe(false)
    expect(result.current.canUseTools).toBe(false)
    expect(result.current.canUseProjects).toBe(false)

    await act(async () => {
      result.current.configureLLM({ provider: 'groq' })
      fetch
        .mockResolvedValueOnce(projectGitSettingsResponse({}, true))
        .mockResolvedValueOnce(mockApiResponse({ message: 'started' }))
      result.current.selectProject({ id: 'active', name: 'Active Project' })
    })

    expect(result.current.hasProject).toBe(true)
    expect(result.current.canUseTools).toBe(true)
    expect(result.current.canUseProjects).toBe(true)
  })

  test('localStorage persistence works correctly for currentProject', async () => {
    const { result } = renderUseAppState()

    await act(async () => {
      fetch
        .mockResolvedValueOnce(projectGitSettingsResponse({}, true))
        .mockResolvedValueOnce(mockApiResponse({ message: 'started' }))
      result.current.selectProject({ id: 'persist', name: 'Persisted' })
    })

    expect(localStorage.getItem('currentProject')).toContain('persist')
  })

  test('git settings update and persist preferences', async () => {
    fetch
      .mockResolvedValueOnce(mockApiResponse({ success: true, projects: [] }))
      .mockResolvedValueOnce(mockApiResponse({ success: true, configured: false, ready: false, reason: 'No LLM configuration found' })) // llm status
      .mockResolvedValueOnce(gitSettingsResponse())
      .mockResolvedValueOnce(portSettingsResponse())
      .mockResolvedValueOnce(testingSettingsResponse())
      .mockResolvedValueOnce(gitSettingsResponse({ workflow: 'cloud', provider: 'gitlab' }))

    const { result } = renderUseAppState()

    expect(result.current.gitSettings.workflow).toBe('local')

    await act(async () => {
      await result.current.updateGitSettings({ workflow: 'cloud', provider: 'gitlab' })
    })

    expect(result.current.gitSettings.workflow).toBe('cloud')
    expect(result.current.gitSettings.provider).toBe('gitlab')
    expect(JSON.parse(localStorage.getItem('gitSettings')).autoPush).toBeUndefined()
  })

  test('git settings hydrate from localStorage when available', async () => {
    const stored = {
      workflow: 'cloud',
      provider: 'github',
      remoteUrl: 'https://github.com/octo/repo.git',
      defaultBranch: 'main'
    }
    localStorage.setItem('gitSettings', JSON.stringify(stored))

    const { result } = renderUseAppState()

    await waitFor(() => {
      expect(result.current.gitSettings).toMatchObject(stored)
    })
  })

  test('updateTestingSettings updates testing settings state', async () => {
    fetch
      .mockResolvedValueOnce(mockApiResponse({ success: true, projects: [] }))
      .mockResolvedValueOnce(mockApiResponse({ success: true, configured: false, ready: false, reason: 'No LLM configuration found' }))
      .mockResolvedValueOnce(gitSettingsResponse())
      .mockResolvedValueOnce(portSettingsResponse())
      .mockResolvedValueOnce(testingSettingsResponse())
      .mockResolvedValueOnce(testingSettingsResponse({ coverageTarget: 70 }))

    const { result } = renderUseAppState()

    await act(async () => {
      await result.current.updateTestingSettings({ coverageTarget: 70 })
    })

    expect(result.current.testingSettings.coverageTarget).toBe(70)
    expect(fetch).toHaveBeenCalledWith('/api/settings/testing', expect.objectContaining({
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' }
    }))
  })

  test('selectProject loads project-specific git settings when available', async () => {
    fetch
      .mockResolvedValueOnce(mockApiResponse({ success: true, projects: [] }))
      .mockResolvedValueOnce(mockApiResponse({ success: true, configured: false, ready: false, reason: 'No LLM configuration found' })) // llm status
      .mockResolvedValueOnce(gitSettingsResponse())
      .mockResolvedValueOnce(portSettingsResponse())
      .mockResolvedValueOnce(testingSettingsResponse())
      .mockResolvedValueOnce(projectGitSettingsResponse({ provider: 'gitlab', remoteUrl: 'https://gitlab.com/oss/repo.git' }, false))
      .mockResolvedValueOnce(mockApiResponse({ message: 'Project started' }))

    const { result } = renderUseAppState()
    const project = { id: 'project-42', name: 'Project 42' }

    await act(async () => {
      await result.current.selectProject(project)
    })

    await waitFor(() => {
      expect(result.current.projectGitSettings[project.id]).toMatchObject({ provider: 'gitlab' })
    })
  })

  test('getEffectiveGitSettings falls back to global when no override exists', async () => {
    fetch
      .mockResolvedValueOnce(mockApiResponse({ success: true, projects: [] }))
      .mockResolvedValueOnce(mockApiResponse({ success: true, configured: false, ready: false, reason: 'No LLM configuration found' })) // llm status
      .mockResolvedValueOnce(gitSettingsResponse({ workflow: 'cloud', provider: 'github', remoteUrl: 'https://github.com/org/repo.git' }))
      .mockResolvedValueOnce(portSettingsResponse())
      .mockResolvedValueOnce(projectGitSettingsResponse({}, true))
      .mockResolvedValueOnce(mockApiResponse({ message: 'Project started' }))

    const { result } = renderUseAppState()
    const project = { id: 'project-21', name: 'Fallback Project' }

    await act(async () => {
      await result.current.selectProject(project)
    })

    const effective = result.current.getEffectiveGitSettings(project.id)
    expect(effective.remoteUrl).toBeUndefined()
    expect(result.current.projectGitSettings[project.id]).toBeUndefined()
  })

  test('updateProjectGitSettings saves overrides and clears token locally', async () => {
    fetch
      .mockResolvedValueOnce(mockApiResponse({ success: true, projects: [] }))
      .mockResolvedValueOnce(mockApiResponse({ success: true, configured: false, ready: false, reason: 'No LLM configuration found' })) // llm status
      .mockResolvedValueOnce(gitSettingsResponse())
      .mockResolvedValueOnce(portSettingsResponse())
      .mockResolvedValueOnce(projectGitSettingsResponse({}, true))
      .mockResolvedValueOnce(mockApiResponse({ message: 'Project started' }))

    const { result } = renderUseAppState()
    const project = { id: 'project-88', name: 'Token Project' }

    await act(async () => {
      await result.current.selectProject(project)
    })

    const override = {
      workflow: 'cloud',
      provider: 'gitlab',
      remoteUrl: 'https://gitlab.com/work/repo.git',
      token: 'secret'
    }

    fetch.mockResolvedValueOnce(projectGitSettingsResponse({ ...override, token: '' }, false))

    await act(async () => {
      await result.current.updateProjectGitSettings(project.id, override)
    })

    expect(fetch).toHaveBeenCalledWith(
      `/api/projects/${project.id}/git-settings`,
      expect.objectContaining({ method: 'PUT' })
    )
    expect(result.current.projectGitSettings[project.id]).toMatchObject({ provider: 'gitlab', token: '' })
  })

  test('updateProjectGitSettings falls back to response settings when project overrides are missing', async () => {
    const defaultFetchImpl = fetch.getMockImplementation()
    fetch.mockImplementation((url = '', options = {}) => {
      if (typeof url === 'string' && url.includes('/proj-fallback/git-settings') && options?.method === 'PUT') {
        return Promise.resolve(mockApiResponse({
          success: true,
          projectSettings: null,
          settings: {
            ...defaultGitSettingsPayload,
            provider: 'bitbucket',
            workflow: 'hybrid',
            token: 'server-secret'
          }
        }))
      }
      return defaultFetchImpl ? defaultFetchImpl(url, options) : Promise.resolve(mockApiResponse({ success: true }))
    })

    const { result } = renderUseAppState()

    await act(async () => {
      await result.current.updateProjectGitSettings('proj-fallback', { provider: 'bitbucket' })
    })

    expect(result.current.projectGitSettings['proj-fallback']).toMatchObject({
      provider: 'bitbucket',
      workflow: 'hybrid',
      token: ''
    })
  })

  test('updateProjectTestingSettings updates project testing settings state', async () => {
    const settings = {
      frontend: { mode: 'custom', coverageTarget: 80, effectiveCoverageTarget: 80 },
      backend: { mode: 'global', coverageTarget: null, effectiveCoverageTarget: 100 }
    }

    fetch.mockImplementation((url = '', options = {}) => {
      if (typeof url === 'string' && url.includes('/api/projects/proj-testing/testing-settings') && options?.method === 'PUT') {
        return Promise.resolve(mockApiResponse({ success: true, settings }))
      }
      return Promise.resolve(mockApiResponse({ success: true }))
    })

    const { result } = renderUseAppState()

    await act(async () => {
      await result.current.updateProjectTestingSettings('proj-testing', {
        frontendMode: 'custom',
        frontendCoverageTarget: 80
      })
    })

    expect(result.current.projectTestingSettings['proj-testing']).toEqual(settings)
  })

  test('fetchProjectGitStatus updates project git status state', async () => {
    const { result } = renderUseAppState()

    fetch.mockResolvedValueOnce(mockApiResponse({
      success: true,
      status: {
        branch: 'main',
        ahead: 1,
        behind: 2,
        hasRemote: true
      }
    }))

    await act(async () => {
      await result.current.fetchProjectGitStatus('proj-status')
    })

    expect(result.current.projectGitStatus['proj-status']).toMatchObject({
      branch: 'main',
      ahead: 1,
      behind: 2,
      hasRemote: true
    })
  })

  test('hasGitNotification is true when current branch is behind', async () => {
    const { result } = renderUseAppState()
    const project = { id: 'proj-behind', name: 'Behind Project' }

    await act(async () => {
      await result.current.selectProject(project)
    })

    const defaultFetchImpl = fetch.getMockImplementation()
    fetch.mockImplementation((url = '', options = {}) => {
      if (typeof url === 'string' && url.includes(`/api/projects/${project.id}/git/status`)) {
        return Promise.resolve(mockApiResponse({
          success: true,
          status: { branch: 'main', ahead: 0, behind: 2, hasRemote: true }
        }))
      }
      return defaultFetchImpl ? defaultFetchImpl(url, options) : Promise.resolve(mockApiResponse({ success: true }))
    })

    await act(async () => {
      await result.current.fetchProjectGitStatus(project.id)
    })

    expect(result.current.hasGitNotification).toBe(true)
  })

  test('git remote polling ignores failures and stops after cleanup', async () => {
    vi.useFakeTimers()
    const intervalCallbacks = []
    const intervalSpy = vi.spyOn(global, 'setInterval').mockImplementation((callback) => {
      intervalCallbacks.push(callback)
      return 123
    })
    const clearSpy = vi.spyOn(global, 'clearInterval').mockImplementation(() => {})

    const defaultFetchImpl = fetch.getMockImplementation()
    fetch.mockImplementation((url = '', options = {}) => {
      if (typeof url === 'string' && url.includes('/git/fetch')) {
        return Promise.resolve(mockApiResponse({ success: false, error: 'boom' }))
      }
      if (typeof url === 'string' && url.includes('/git-settings')) {
        return Promise.resolve(projectGitSettingsResponse({ remoteUrl: 'https://github.com/lucid/repo.git' }, false))
      }
      return defaultFetchImpl ? defaultFetchImpl(url, options) : Promise.resolve(mockApiResponse({ success: true }))
    })

    const { result, unmount } = renderUseAppState()
    const project = { id: 'proj-poll', name: 'Poll Project' }

    await act(async () => {
      await result.current.selectProject(project)
    })

    await act(async () => {
      await Promise.resolve()
    })

    expect(intervalCallbacks.length).toBeGreaterThan(0)

    unmount()

    await act(async () => {
      await intervalCallbacks[0]()
    })

    intervalSpy.mockRestore()
    clearSpy.mockRestore()
    vi.useRealTimers()
  })

  test('pullProjectGitRemote updates status when payload includes status', async () => {
    const { result } = renderUseAppState()

    fetch.mockResolvedValueOnce(mockApiResponse({
      success: true,
      status: {
        branch: 'main',
        ahead: 0,
        behind: 0,
        hasRemote: true
      },
      strategy: 'ff-only'
    }))

    await act(async () => {
      await result.current.pullProjectGitRemote('proj-pull')
    })

    expect(result.current.projectGitStatus['proj-pull']).toMatchObject({
      branch: 'main',
      ahead: 0,
      behind: 0,
      hasRemote: true
    })
  })

  test('pullProjectGitRemote does not update status when response omits status', async () => {
    const { result } = renderUseAppState()

    fetch.mockResolvedValueOnce(mockApiResponse({
      success: true,
      status: null,
      strategy: 'noop'
    }))

    await act(async () => {
      await result.current.pullProjectGitRemote('proj-empty')
    })

    expect(result.current.projectGitStatus['proj-empty']).toBeUndefined()
  })

  test('stashProjectGitChanges updates status when payload includes status', async () => {
    const { result } = renderUseAppState()

    fetch.mockResolvedValueOnce(mockApiResponse({
      success: true,
      stashed: true,
      status: {
        branch: 'main',
        ahead: 0,
        behind: 0,
        hasRemote: true
      }
    }))

    await act(async () => {
      await result.current.stashProjectGitChanges('proj-stash')
    })

    expect(result.current.projectGitStatus['proj-stash']).toMatchObject({
      branch: 'main',
      ahead: 0,
      behind: 0,
      hasRemote: true
    })
  })

  test('discardProjectGitChanges updates status when payload includes status', async () => {
    const { result } = renderUseAppState()

    fetch.mockResolvedValueOnce(mockApiResponse({
      success: true,
      discarded: true,
      status: {
        branch: 'main',
        ahead: 0,
        behind: 0,
        hasRemote: true
      }
    }))

    await act(async () => {
      await result.current.discardProjectGitChanges('proj-discard', { confirm: true })
    })

    expect(result.current.projectGitStatus['proj-discard']).toMatchObject({
      branch: 'main',
      ahead: 0,
      behind: 0,
      hasRemote: true
    })
  })

  test('git polling fetches remote status when project has a remote url', async () => {
    vi.useFakeTimers()
    fetch
      .mockResolvedValueOnce(mockApiResponse({ success: true, projects: [] }))
      .mockResolvedValueOnce(mockApiResponse({ success: true, configured: false, ready: false, reason: 'No LLM configuration found' }))
      .mockResolvedValueOnce(gitSettingsResponse())
      .mockResolvedValueOnce(portSettingsResponse())
      .mockResolvedValueOnce(testingSettingsResponse())
      .mockResolvedValueOnce(projectGitSettingsResponse({ remoteUrl: 'https://github.com/demo/repo.git' }, false))
      .mockResolvedValueOnce(mockApiResponse({ message: 'Project started' }))

    const { result } = renderUseAppState()
    const project = { id: 'project-poll', name: 'Poll Project' }

    await act(async () => {
      await result.current.selectProject(project)
    })

    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()

    const initialFetches = fetch.mock.calls.filter(([url, options]) => (
      url === `/api/projects/${project.id}/git/fetch` && options?.method === 'POST'
    ))
    expect(initialFetches.length).toBeGreaterThanOrEqual(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120000)
    })

    const intervalFetches = fetch.mock.calls.filter(([url, options]) => (
      url === `/api/projects/${project.id}/git/fetch` && options?.method === 'POST'
    ))
    expect(intervalFetches.length).toBeGreaterThanOrEqual(2)

    vi.useRealTimers()
  })

  test('createProjectRemoteRepository persists returned overrides', async () => {
    fetch
      .mockResolvedValueOnce(mockApiResponse({ success: true, projects: [] }))
      .mockResolvedValueOnce(mockApiResponse({ success: true, configured: false, ready: false, reason: 'No LLM configuration found' })) // llm status
      .mockResolvedValueOnce(gitSettingsResponse())
      .mockResolvedValueOnce(portSettingsResponse())
      .mockResolvedValueOnce(projectGitSettingsResponse({}, true))
      .mockResolvedValueOnce(mockApiResponse({ message: 'Project started' }))

    const { result } = renderUseAppState()
    const project = { id: 'project-remote', name: 'Remote Project' }

    await act(async () => {
      await result.current.selectProject(project)
    })

    const remoteResponse = mockApiResponse({
      success: true,
      repository: { remoteUrl: 'https://github.com/demo/remote.git' },
      projectSettings: {
        ...defaultGitSettingsPayload,
        workflow: 'cloud',
        remoteUrl: 'https://github.com/demo/remote.git'
      }
    })

    fetch.mockResolvedValueOnce(remoteResponse)

    await act(async () => {
      await result.current.createProjectRemoteRepository(project.id, {
        provider: 'github',
        name: 'demo-remote',
        token: 'secret-token'
      })
    })

    expect(fetch).toHaveBeenCalledWith(
      `/api/projects/${project.id}/git/remotes`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          provider: 'github',
          name: 'demo-remote',
          token: 'secret-token'
        })
      })
    )

    expect(result.current.projectGitSettings[project.id]).toMatchObject({
      workflow: 'cloud',
      remoteUrl: 'https://github.com/demo/remote.git'
    })
  })

  test('clearProjectGitSettings removes project overrides', async () => {
    fetch
      .mockResolvedValueOnce(mockApiResponse({ success: true, projects: [] }))
      .mockResolvedValueOnce(mockApiResponse({ success: true, configured: false, ready: false, reason: 'No LLM configuration found' })) // llm status
      .mockResolvedValueOnce(gitSettingsResponse())
      .mockResolvedValueOnce(portSettingsResponse())
      .mockResolvedValueOnce(testingSettingsResponse())
      .mockResolvedValueOnce(projectGitSettingsResponse({ provider: 'gitlab' }, false))
      .mockResolvedValueOnce(mockApiResponse({ message: 'Project started' }))

    const { result } = renderUseAppState()
    const project = { id: 'project-77', name: 'Override Project' }

    await act(async () => {
      await result.current.selectProject(project)
    })

    expect(result.current.projectGitSettings[project.id]).toEqual(expect.any(Object))

    fetch.mockResolvedValueOnce(projectGitSettingsResponse({}, true))

    await act(async () => {
      await result.current.clearProjectGitSettings(project.id)
    })

    expect(fetch).toHaveBeenLastCalledWith(
      `/api/projects/${project.id}/git-settings`,
      expect.objectContaining({ method: 'DELETE' })
    )
    expect(result.current.projectGitSettings[project.id]).toBeUndefined()
  })

  test('clearProjectGitSettings surfaces backend error messages', async () => {
    const defaultFetchImpl = fetch.getMockImplementation()
    fetch.mockImplementation((url = '', options = {}) => {
      if (typeof url === 'string' && url.includes('/proj-error/git-settings') && options?.method === 'DELETE') {
        return Promise.resolve(mockApiResponse({ success: false, error: 'cannot clear overrides' }, true, 200))
      }
      return defaultFetchImpl ? defaultFetchImpl(url, options) : Promise.resolve(mockApiResponse({ success: true }))
    })

    const { result } = renderUseAppState()

    await expect(result.current.clearProjectGitSettings('proj-error')).rejects.toThrow('cannot clear overrides')
  })

  test('getProjectGitSettingsSnapshot reports inheritance state', async () => {
    fetch
      .mockResolvedValueOnce(mockApiResponse({ success: true, projects: [] }))
      .mockResolvedValueOnce(mockApiResponse({ success: true, configured: false, ready: false, reason: 'No LLM configuration found' })) // llm status
      .mockResolvedValueOnce(gitSettingsResponse({ remoteUrl: 'https://github.com/lucid/base.git' }))
      .mockResolvedValueOnce(portSettingsResponse())
      .mockResolvedValueOnce(testingSettingsResponse())
      .mockResolvedValueOnce(projectGitSettingsResponse({ remoteUrl: 'https://gitlab.com/team/project.git' }, false))
      .mockResolvedValueOnce(mockApiResponse({ message: 'Project started' }))

    const { result } = renderUseAppState()
    const project = { id: 'project-snap', name: 'Snapshot' }

    await act(async () => {
      await result.current.selectProject(project)
    })

    const snapshot = result.current.getProjectGitSettingsSnapshot(project.id)
    expect(snapshot.inheritsFromGlobal).toBe(false)
    expect(snapshot.projectSettings?.remoteUrl).toBe('https://gitlab.com/team/project.git')
    expect(snapshot.globalSettings.remoteUrl).toBeUndefined()

    const fallbackSnapshot = result.current.getProjectGitSettingsSnapshot('unknown')
    expect(fallbackSnapshot.inheritsFromGlobal).toBe(true)
    expect(fallbackSnapshot.projectSettings).toBeNull()
  })

  test('syncBranchOverview stores empty staged snapshots when backend omits files', async () => {
    const { result } = renderUseAppState()

    await act(async () => {
      result.current.syncBranchOverview('proj-empty', {
        workingBranches: [
          {
            name: 'feature/empty',
            status: 'active'
          }
        ]
      })
    })

    await waitFor(() => {
      expect(result.current.workspaceChanges['proj-empty']).toEqual({ stagedFiles: [] })
      expect(result.current.workingBranches['proj-empty'].stagedFiles).toEqual([])
    })
  })

  test('multiple projects can be created and managed', async () => {
    fetch
      .mockResolvedValueOnce(mockApiResponse({ success: true, projects: [] }))
      .mockResolvedValueOnce(mockApiResponse({ success: true, configured: false, ready: false, reason: 'No LLM configuration found' })) // llm status
      .mockResolvedValueOnce(gitSettingsResponse())
      .mockResolvedValueOnce(portSettingsResponse())
      .mockResolvedValueOnce(testingSettingsResponse())
      .mockResolvedValueOnce(mockApiResponse({ success: true, project: { id: 'a', name: 'First' } }))
      .mockResolvedValueOnce(projectGitSettingsResponse({}, true))
      .mockResolvedValueOnce(mockApiResponse({
        success: true,
        settings: {
          frontend: { mode: 'global', coverageTarget: null, effectiveCoverageTarget: 100 },
          backend: { mode: 'global', coverageTarget: null, effectiveCoverageTarget: 100 }
        }
      }))
      .mockResolvedValueOnce(mockApiResponse({ message: 'started a' }))
      .mockResolvedValueOnce(processStatusResponse({ projectId: 'a' }))
      .mockResolvedValueOnce(mockApiResponse({ success: true, project: { id: 'b', name: 'Second' } }))
      .mockResolvedValueOnce(projectGitSettingsResponse({}, true))
      .mockResolvedValueOnce(mockApiResponse({
        success: true,
        settings: {
          frontend: { mode: 'global', coverageTarget: null, effectiveCoverageTarget: 100 },
          backend: { mode: 'global', coverageTarget: null, effectiveCoverageTarget: 100 }
        }
      }))
      .mockResolvedValueOnce(mockApiResponse({ message: 'started b' }))
      .mockResolvedValueOnce(processStatusResponse({ projectId: 'b' }))

    const { result } = renderUseAppState()

    await act(async () => {
      await result.current.createProject({ name: 'First' })
      await result.current.createProject({ name: 'Second' })
    })

    expect(result.current.projects.map(p => p.id)).toEqual(['a', 'b'])
    expect(result.current.currentProject?.id).toBe('b')
  })

  test('context throws error when used outside provider', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => renderHook(() => useAppState())).toThrowError(/must be used within/)

    consoleSpy.mockRestore()
  })

  test('stageFileChange falls back with default error message when server omits copy', async () => {
    const defaultFetchImpl = fetch.getMockImplementation()
    fetch.mockImplementation((url = '', options = {}) => {
      if (typeof url === 'string' && url.includes('/branches/stage') && options?.method === 'POST') {
        return Promise.resolve(mockApiResponse({ success: false }))
      }
      return defaultFetchImpl ? defaultFetchImpl(url, options) : Promise.resolve(mockApiResponse({ success: true }))
    })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { result } = renderUseAppState()

    let response
    await act(async () => {
      response = await result.current.stageFileChange('proj-stage', 'src/fallback.js', 'editor')
    })

    expect(response).toBeNull()
    expect(warnSpy).toHaveBeenCalled()
    const warnCalls = warnSpy.mock.calls
    const errorArg = warnCalls[warnCalls.length - 1]?.[1]
    expect(errorArg?.message).toBe('Failed to stage file change')

    await waitFor(() => {
      const stagedFiles = result.current.workspaceChanges['proj-stage']?.stagedFiles || []
      expect(stagedFiles[0]?.path).toBe('src/fallback.js')
    })

    warnSpy.mockRestore()
  })

  test('clearStagedChanges prunes a single staged file when API succeeds', async () => {
    const defaultFetchImpl = fetch.getMockImplementation()
    fetch.mockImplementation((url = '', options = {}) => {
      if (typeof url === 'string' && url.includes('/branches/stage') && options?.method === 'DELETE') {
        return Promise.resolve(mockApiResponse({
          success: true,
          overview: {
            workingBranches: [
              {
                name: 'feature/prune',
                status: 'active',
                stagedFiles: [{ path: 'src/remaining.js', timestamp: 'later' }]
              }
            ]
          }
        }))
      }
      return defaultFetchImpl ? defaultFetchImpl(url, options) : Promise.resolve(mockApiResponse({ success: true }))
    })

    const { result } = renderUseAppState()

    await act(async () => {
      result.current.syncBranchOverview('proj-branch', {
        workingBranches: [
          {
            name: 'feature/prune',
            status: 'active',
            stagedFiles: [
              { path: 'src/remove.js', timestamp: 'now' },
              { path: 'src/remaining.js', timestamp: 'later' }
            ]
          }
        ]
      })
    })

    await act(async () => {
      await result.current.clearStagedChanges('proj-branch', { filePath: 'src/remove.js' })
    })

    const request = fetch.mock.calls.find(([, options]) => options?.method === 'DELETE')
    expect(JSON.parse(request?.[1]?.body)).toEqual({ filePath: 'src/remove.js' })

    await waitFor(() => {
      expect(result.current.workspaceChanges['proj-branch'].stagedFiles.map((file) => file.path)).toEqual(['src/remaining.js'])
    })
  })

  test('clearStagedChanges falls back to local cleanup when DELETE request fails', async () => {
    const defaultFetchImpl = fetch.getMockImplementation()
    fetch.mockImplementation((url = '', options = {}) => {
      if (typeof url === 'string' && url.includes('/branches/stage') && options?.method === 'DELETE') {
        return Promise.reject(new Error('disconnect'))
      }
      return defaultFetchImpl ? defaultFetchImpl(url, options) : Promise.resolve(mockApiResponse({ success: true }))
    })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { result } = renderUseAppState()

    await act(async () => {
      result.current.syncBranchOverview('proj-fallback', {
        workingBranches: [
          {
            name: 'feature/fallback',
            status: 'active',
            stagedFiles: [
              { path: 'src/first.js', timestamp: 'now' },
              { path: 'src/second.js', timestamp: 'later' }
            ]
          }
        ]
      })
    })

    await act(async () => {
      const response = await result.current.clearStagedChanges('proj-fallback')
      expect(response).toBeNull()
    })

    await waitFor(() => {
      expect(result.current.workspaceChanges['proj-fallback'].stagedFiles).toEqual([])
      expect(result.current.workingBranches['proj-fallback'].commits).toBe(0)
    })

    expect(warnSpy).toHaveBeenCalledWith('Falling back to clearing staged files locally', expect.any(Error))
    warnSpy.mockRestore()
  })

  test('clearStagedChanges normalizes file paths when pruning local staged entries', async () => {
    const defaultFetchImpl = fetch.getMockImplementation()
    fetch.mockImplementation((url = '', options = {}) => {
      if (typeof url === 'string' && url.includes('/branches/stage') && options?.method === 'DELETE') {
        return Promise.resolve(mockApiResponse({
          success: true,
          overview: {
            workingBranches: [
              {
                name: 'feature/normalize',
                status: 'active',
                stagedFiles: [{ path: 'frontend/src/Keep.css', timestamp: 'later' }]
              }
            ]
          }
        }))
      }
      return defaultFetchImpl ? defaultFetchImpl(url, options) : Promise.resolve(mockApiResponse({ success: true }))
    })

    const { result } = renderUseAppState()

    await act(async () => {
      result.current.syncBranchOverview('proj-normalize', {
        workingBranches: [
          {
            name: 'feature/normalize',
            status: 'active',
            stagedFiles: [
              { path: 'frontend\\src\\App.css', timestamp: 'now' },
              { path: 'frontend/src/Keep.css', timestamp: 'later' }
            ]
          }
        ]
      })
    })

    await act(async () => {
      await result.current.clearStagedChanges('proj-normalize', { filePath: 'frontend/src/App.css' })
    })

    const request = fetch.mock.calls.find(([, options]) => options?.method === 'DELETE')
    expect(JSON.parse(request?.[1]?.body)).toEqual({ filePath: 'frontend/src/App.css' })

    await waitFor(() => {
      expect(result.current.workspaceChanges['proj-normalize'].stagedFiles.map((file) => file.path)).toEqual([
        'frontend/src/Keep.css'
      ])
    })
  })

  test('handles API fetch failure gracefully', async () => {
    const fallbackProjects = [{ id: 'cached', name: 'Cached' }]
    localStorage.setItem('projects', JSON.stringify(fallbackProjects))
    fetch.mockRejectedValueOnce(new Error('Network error'))

    const { result } = renderUseAppState()

    await waitFor(() => {
      expect(result.current.projects).toEqual(fallbackProjects)
    })
  })

  test('theme changes update document attribute', async () => {
    const setAttributeSpy = vi.spyOn(document.documentElement, 'setAttribute')
    renderUseAppState()

    await waitFor(() => {
      expect(setAttributeSpy).toHaveBeenCalledWith('data-theme', 'dark')
    })

    setAttributeSpy.mockRestore()
  })

  describe('Port settings', () => {
    const buildPortAwareFetch = (restartResponse) => (url = '', options = {}) => {
      if (url === '/api/projects' && (!options.method || options.method === 'GET')) {
        return Promise.resolve(mockApiResponse({ success: true, projects: [] }))
      }
      if (url === '/api/settings/git') {
        return Promise.resolve(gitSettingsResponse())
      }
      if (url === '/api/settings/ports') {
        if (options.method === 'PUT') {
          return Promise.resolve(portSettingsResponse({ frontendPortBase: 5200, backendPortBase: 5400 }))
        }
        return Promise.resolve(portSettingsResponse())
      }
      if (typeof url === 'string' && url.includes('/git-settings')) {
        return Promise.resolve(projectGitSettingsResponse({}, true))
      }
      if (typeof url === 'string' && url.includes('/processes')) {
        const match = url.match(/\/api\/projects\/(.+?)\/processes/)
        const projectId = match?.[1] || 'active-project'
        return Promise.resolve(processStatusResponse({ projectId }))
      }
      if (url === '/api/projects/active-project/restart') {
        return Promise.resolve(restartResponse)
      }
      return Promise.resolve(mockApiResponse({ success: true }))
    }

    test('updatePortSettings restarts the active project when running', async () => {
      fetch.mockImplementation(buildPortAwareFetch(mockApiResponse({ success: true, message: 'restarted' })))

      const { result } = renderUseAppState()

      await act(async () => {
        result.current.setCurrentProject({ id: 'active-project', name: 'Active Project' })
      })

      await act(async () => {
        await result.current.updatePortSettings({ frontendPortBase: 5200, backendPortBase: 5400 })
      })

      const restartCall = fetch.mock.calls.find(([url]) => url === '/api/projects/active-project/restart')
        expect(restartCall?.[0]).toBe('/api/projects/active-project/restart')
      expect(restartCall?.[1]).toMatchObject({ method: 'POST' })
    })

    test('updatePortSettings surfaces restart failures to the caller', async () => {
      fetch.mockImplementation(
        buildPortAwareFetch(
          mockApiResponse({ success: false, error: 'restart failed' }, false, 500)
        )
      )

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const { result } = renderUseAppState()

      await act(async () => {
        result.current.setCurrentProject({ id: 'active-project', name: 'Active Project' })
      })

      let caughtError
      await act(async () => {
        try {
          await result.current.updatePortSettings({ frontendPortBase: 5200, backendPortBase: 5400 })
        } catch (error) {
          caughtError = error
        }
      })

      expect(caughtError).toBeInstanceOf(Error)
      expect(caughtError.message).toContain('Port settings saved but failed to restart project')

      consoleSpy.mockRestore()
    })
  })

  describe('Process status controls', () => {
    test('refreshProcessStatus updates process snapshot state', async () => {
      const { result } = renderUseAppState()
      const processes = {
        frontend: { status: 'running', port: 5400 },
        backend: null
      }

      fetch
        .mockResolvedValueOnce(processStatusResponse({
          projectId: 'process-test',
          isRunning: true,
          processes,
          ports: {
            active: { frontend: 5400, backend: null },
            stored: { frontend: null, backend: null },
            preferred: { frontend: 5200, backend: 5400 }
          }
        }))

      await act(async () => {
        await result.current.refreshProcessStatus('process-test')
      })

      expect(result.current.projectProcesses?.projectId).toBe('process-test')
      expect(result.current.projectProcesses?.ports.active.frontend).toBe(5400)
    })

    test('restartProject posts to API and refreshes snapshot', async () => {
      const { result } = renderUseAppState()
      const restartProcesses = {
        frontend: { status: 'running', port: 5800 },
        backend: { status: 'running', port: 5900 }
      }

      fetch
        .mockResolvedValueOnce(mockApiResponse({ success: true, processes: restartProcesses, message: 'restarted' }))
        .mockResolvedValueOnce(processStatusResponse({
          projectId: 'restart-test',
          isRunning: true,
          processes: restartProcesses,
          ports: {
            active: { frontend: 5800, backend: 5900 },
            stored: { frontend: 5800, backend: 5900 },
            preferred: { frontend: 5800, backend: 5900 }
          }
        }))

      await act(async () => {
        await result.current.restartProject('restart-test')
      })

      const restartCall = fetch.mock.calls.find(([url]) => url === '/api/projects/restart-test/restart')
      expect(restartCall).toBeTruthy()
      expect(result.current.projectProcesses?.ports.active.frontend).toBe(5800)
      expect(result.current.projectProcesses?.ports.active.backend).toBe(5900)
    })
  })

  describe('View Management', () => {
    test('setView updates currentView', async () => {
      const { result } = renderUseAppState()

      await act(async () => {
        result.current.setView('import-project')
      })

      expect(result.current.currentView).toBe('import-project')
    })

    test('showCreateProject sets view to create-project', async () => {
      const { result } = renderUseAppState()

      await act(async () => {
        result.current.showCreateProject()
      })

      expect(result.current.currentView).toBe('create-project')
    })

    test('showImportProject sets view to import-project', async () => {
      const { result } = renderUseAppState()

      await act(async () => {
        result.current.showImportProject()
      })

      expect(result.current.currentView).toBe('import-project')
    })

    test('showMain sets view to main', async () => {
      const { result } = renderUseAppState()

      await act(async () => {
        result.current.setView('create-project')
        result.current.showMain()
      })

      expect(result.current.currentView).toBe('main')
    })
  })

  describe('Close Project Functionality', () => {
    test('closeProject clears current project and calls stop API', async () => {
      fetch
        .mockResolvedValueOnce(mockApiResponse({ success: true, projects: [] }))
        .mockResolvedValueOnce(gitSettingsResponse())
        .mockResolvedValueOnce(portSettingsResponse())
        .mockResolvedValueOnce(projectGitSettingsResponse({}, true))
        .mockResolvedValueOnce(mockApiResponse({ message: 'started' }))
        .mockResolvedValueOnce(mockApiResponse({ message: 'stopped' }))

      const { result } = renderUseAppState()

      await act(async () => {
        await result.current.selectProject({ id: 'close-me', name: 'Close Me' })
      })

      await act(async () => {
        await result.current.closeProject()
      })

      expect(result.current.currentProject).toBeNull()
      expect(fetch).toHaveBeenLastCalledWith('/api/projects/close-me/stop', expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }))
    })

    test('closeProject updates localStorage', async () => {
      fetch
        .mockResolvedValueOnce(mockApiResponse({ success: true, projects: [] }))
        .mockResolvedValueOnce(gitSettingsResponse())
        .mockResolvedValueOnce(portSettingsResponse())
        .mockResolvedValueOnce(projectGitSettingsResponse({}, true))
        .mockResolvedValueOnce(mockApiResponse({ message: 'started' }))
        .mockResolvedValueOnce(mockApiResponse({ message: 'stopped' }))

      const { result } = renderUseAppState()

      await act(async () => {
        await result.current.selectProject({ id: 'persisted', name: 'Persist' })
      })

      expect(localStorage.getItem('currentProject')).toContain('persisted')

      await act(async () => {
        await result.current.closeProject()
      })

      expect(localStorage.getItem('currentProject')).toBeNull()
    })

    test('closeProject does not affect projects list', async () => {
      fetch.mockImplementation((url, options = {}) => {
        if (url === '/api/projects' && (!options.method || options.method === 'GET')) {
          return Promise.resolve(mockApiResponse({ success: true, projects: [] }))
        }
        if (url === '/api/settings/git') {
          return Promise.resolve(gitSettingsResponse())
        }
        if (url === '/api/settings/ports') {
          return Promise.resolve(portSettingsResponse())
        }
        if (url === '/api/projects/import' && options.method === 'POST') {
          return Promise.resolve(mockApiResponse({
            success: true,
            project: { id: 'keep', name: 'Keep Me' },
            jobs: []
          }))
        }
        if (typeof url === 'string' && url.includes('/git-settings')) {
          return Promise.resolve(projectGitSettingsResponse({}, true))
        }
        if (typeof url === 'string' && url.includes('/start')) {
          return Promise.resolve(mockApiResponse({ message: 'started' }))
        }
        if (typeof url === 'string' && url.includes('/stop')) {
          return Promise.resolve(mockApiResponse({ message: 'stopped' }))
        }
        return Promise.resolve(mockApiResponse({ success: true }))
      })

      const { result } = renderUseAppState()

      await act(async () => {
        await result.current.importProject({ name: 'Keep Me' })
      })

      await act(async () => {
        await result.current.closeProject()
      })

      await waitFor(() => {
        expect(result.current.projects).toHaveLength(1)
      })
      expect(result.current.projects[0].id).toBe('keep')
    })

    test('closeProject when no project is selected has no effect', async () => {
      const { result } = renderUseAppState()
      const initialCalls = fetch.mock.calls.length

      await act(async () => {
        await result.current.closeProject()
      })

      expect(result.current.currentProject).toBeNull()
      expect(fetch.mock.calls.length).toBe(initialCalls)
    })
  })

  describe('Automation Jobs', () => {
    test('startAutomationJob queues job and polls until completion', async () => {
      fetch
        .mockResolvedValueOnce(mockApiResponse({ success: true, projects: [] }))
        .mockResolvedValueOnce(gitSettingsResponse())
        .mockResolvedValueOnce(portSettingsResponse())

      const { result } = renderUseAppState()
      const project = { id: 'project-automation', name: 'Automation Project' }

      fetch
        .mockResolvedValueOnce(projectGitSettingsResponse({}, true))
        .mockResolvedValueOnce(mockApiResponse({ message: 'Project started' }))
        .mockResolvedValueOnce(mockApiResponse({ success: true, jobs: [] }))

      await act(async () => {
        await result.current.selectProject(project)
      })

      const runningJob = {
        id: 'job-1',
        type: 'frontend:test',
        status: 'running',
        command: 'npm',
        args: ['run', 'test'],
        cwd: '/tmp/frontend',
        createdAt: '2024-01-01T00:00:00.000Z',
        startedAt: '2024-01-01T00:00:00.000Z',
        logs: []
      }
      const completedJob = {
        ...runningJob,
        status: 'succeeded',
        completedAt: '2024-01-01T00:00:03.000Z'
      }

      fetch
        .mockResolvedValueOnce(mockApiResponse({ success: true, job: runningJob }))
        .mockResolvedValueOnce(mockApiResponse({ success: true, job: completedJob }))

      await act(async () => {
        await result.current.startAutomationJob('frontend:test')
      })

      expect(fetch).toHaveBeenCalledWith(
        `/api/projects/${project.id}/jobs`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ type: 'frontend:test' })
        })
      )

      await waitFor(() => {
        expect(fetch).toHaveBeenCalledWith(`/api/projects/${project.id}/jobs/job-1`)
      })

      await waitFor(() => {
        const jobs = result.current.getJobsForProject(project.id)
        expect(jobs[0].status).toBe('succeeded')
      })
    })

    test('startAutomationJob forwards payload metadata when provided', async () => {
      fetch
        .mockResolvedValueOnce(mockApiResponse({ success: true, projects: [] }))
        .mockResolvedValueOnce(gitSettingsResponse())
        .mockResolvedValueOnce(portSettingsResponse())

      const { result } = renderUseAppState()
      const project = { id: 'project-payload', name: 'Payload Project' }

      fetch
        .mockResolvedValueOnce(projectGitSettingsResponse({}, true))
        .mockResolvedValueOnce(mockApiResponse({ message: 'Project started' }))
        .mockResolvedValueOnce(mockApiResponse({ success: true, jobs: [] }))

      await act(async () => {
        await result.current.selectProject(project)
      })

      const runningJob = {
        id: 'job-2',
        type: 'frontend:add-package',
        status: 'running',
        command: 'npm',
        args: ['install', 'react', '--save-dev'],
        cwd: '/tmp/frontend',
        createdAt: '2024-01-01T00:00:00.000Z',
        startedAt: '2024-01-01T00:00:00.000Z',
        logs: []
      }
      const completedJob = { ...runningJob, status: 'succeeded', completedAt: '2024-01-01T00:00:02.000Z' }

      fetch
        .mockResolvedValueOnce(mockApiResponse({ success: true, job: runningJob }))
        .mockResolvedValueOnce(mockApiResponse({ success: true, job: completedJob }))

      await act(async () => {
        await result.current.startAutomationJob('frontend:add-package', {
          payload: {
            packageName: 'react',
            dev: true
          }
        })
      })

      expect(fetch).toHaveBeenCalledWith(
        `/api/projects/${project.id}/jobs`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            type: 'frontend:add-package',
            payload: { packageName: 'react', dev: true }
          })
        })
      )
    })

    test('cancelAutomationJob stops active job', async () => {
      fetch
        .mockResolvedValueOnce(mockApiResponse({ success: true, projects: [] }))
        .mockResolvedValueOnce(gitSettingsResponse())
        .mockResolvedValueOnce(portSettingsResponse())

      const { result } = renderUseAppState()
      const project = { id: 'project-cancel', name: 'Cancel Project' }

      fetch
        .mockResolvedValueOnce(projectGitSettingsResponse({}, true))
        .mockResolvedValueOnce(mockApiResponse({ message: 'Project started' }))
        .mockResolvedValueOnce(mockApiResponse({ success: true, jobs: [] }))

      await act(async () => {
        await result.current.selectProject(project)
      })

      const runningJob = {
        id: 'job-cancel',
        type: 'git:status',
        status: 'running',
        command: 'git',
        args: ['status'],
        cwd: '/tmp/project',
        createdAt: '2024-01-01T00:00:00.000Z',
        startedAt: '2024-01-01T00:00:00.000Z',
        logs: []
      }

      const cancelledJob = { ...runningJob, status: 'cancelled', completedAt: '2024-01-01T00:00:02.000Z' }

      fetch
        .mockResolvedValueOnce(mockApiResponse({ success: true, job: runningJob }))
        .mockResolvedValueOnce(mockApiResponse({ success: true, job: runningJob }))
        .mockResolvedValueOnce(mockApiResponse({ success: true, job: cancelledJob }))

      await act(async () => {
        await result.current.startAutomationJob('git:status')
      })

      await act(async () => {
        await result.current.cancelAutomationJob('job-cancel')
      })

      expect(fetch).toHaveBeenLastCalledWith(
        `/api/projects/${project.id}/jobs/job-cancel/cancel`,
        expect.objectContaining({ method: 'POST' })
      )

      const jobs = result.current.getJobsForProject(project.id)
      expect(jobs[0].status).toBe('cancelled')

    })

    test('refreshJobs surfaces errors', async () => {
      fetch
        .mockResolvedValueOnce(mockApiResponse({ success: true, projects: [] }))
        .mockResolvedValueOnce(gitSettingsResponse())
        .mockResolvedValueOnce(portSettingsResponse())

      const { result } = renderUseAppState()
      const project = { id: 'project-refresh', name: 'Refresh Project' }

      fetch
        .mockResolvedValueOnce(projectGitSettingsResponse({}, true))
        .mockResolvedValueOnce(mockApiResponse({ message: 'Project started' }))
        .mockResolvedValueOnce(mockApiResponse({ success: true, jobs: [] }))

      await act(async () => {
        await result.current.selectProject(project)
      })

      fetch.mockResolvedValueOnce(mockApiResponse({ success: false, error: 'boom' }, false, 500))

      await expect(result.current.refreshJobs(project.id)).rejects.toThrow('boom')
      await waitFor(() => {
        expect(result.current.jobState.error).toBe('boom')
      })
    })

    test('refreshJobs supports silent mode without toggling loading state', async () => {
      fetch
        .mockResolvedValueOnce(mockApiResponse({ success: true, projects: [] }))
        .mockResolvedValueOnce(gitSettingsResponse())
        .mockResolvedValueOnce(portSettingsResponse())

      const { result } = renderUseAppState()
      const project = { id: 'project-silent', name: 'Silent Refresh Project' }

      fetch
        .mockResolvedValueOnce(projectGitSettingsResponse({}, true))
        .mockResolvedValueOnce(mockApiResponse({ message: 'Project started' }))
        .mockResolvedValueOnce(mockApiResponse({ success: true, jobs: [] }))

      await act(async () => {
        await result.current.selectProject(project)
      })

      const jobs = [
        { id: 'job-silent', status: 'succeeded', createdAt: '2024-01-01T00:00:00.000Z' }
      ]

      fetch.mockResolvedValueOnce(mockApiResponse({ success: true, jobs }))

      const loadingBefore = result.current.jobState.isLoading
      await act(async () => {
        await result.current.refreshJobs(project.id, { silent: true })
      })

      await waitFor(() => {
        expect(result.current.getJobsForProject(project.id)).toHaveLength(1)
      })
      expect(result.current.jobState.isLoading).toBe(loadingBefore)
    })
  })
})
