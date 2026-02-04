import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axios from 'axios'
import App from '../App'
import { mockApiResponse } from './setup'

const defaultLLMStatus = {
  success: true,
  configured: true,
  ready: true,
  config: {
    provider: 'groq',
    model: 'llama-3.1-70b-versatile',
    api_url: 'https://api.groq.com/openai/v1',
    requires_api_key: true,
    has_api_key: true
  }
}

const queueAxiosProjects = (projects = [], success = true) => {
  axios.get.mockResolvedValueOnce({ data: { success, projects } })
}

const queueAxiosPost = (responseData, success = true) => {
  if (success) {
    axios.post.mockResolvedValueOnce({ data: responseData })
  } else {
    axios.post.mockRejectedValueOnce(responseData)
  }
}

const renderApp = () => render(<App />)

describe('App Component Integration', () => {
  let llmStatusResponse
  let projectsResponse
  let projectsRejectOnce
  let projectsDelayMs
  let startProjectResponse

  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()

    llmStatusResponse = { ...defaultLLMStatus }
    projectsResponse = { success: true, projects: [] }
    projectsRejectOnce = null
    projectsDelayMs = 0
    startProjectResponse = { success: true, message: 'Project started' }

    fetch.mockImplementation((url) => {
      if (url === '/api/llm/status') {
        return Promise.resolve(mockApiResponse(llmStatusResponse))
      }

      if (url === '/api/projects') {
        if (projectsRejectOnce) {
          const error = projectsRejectOnce
          projectsRejectOnce = null
          return Promise.reject(error)
        }

        if (projectsDelayMs > 0) {
          return new Promise((resolve) => {
            setTimeout(() => resolve(mockApiResponse(projectsResponse)), projectsDelayMs)
          })
        }

        return Promise.resolve(mockApiResponse(projectsResponse))
      }

      if (typeof url === 'string' && url.endsWith('/start')) {
        return Promise.resolve(mockApiResponse(startProjectResponse))
      }

      if (url === '/api/projects/import') {
        return Promise.resolve(mockApiResponse({
          success: true,
          project: { id: 'imported-1', name: 'Imported Project' },
          jobs: []
        }))
      }

      return Promise.resolve(mockApiResponse({ success: true }))
    })

    axios.get.mockResolvedValue({ data: { success: true, projects: [] } })
    axios.post.mockResolvedValue({ data: { success: true } })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('View Management', () => {
    test('renders main view by default with empty projects list', async () => {
      projectsResponse = { success: true, projects: [] }
      queueAxiosProjects([])

      render(<App />)

      await waitFor(() => {
        expect(screen.getByText('Select Project')).toBeInTheDocument()
      })

      await waitFor(() => {
        expect(screen.getByText('No projects yet')).toBeInTheDocument()
      })

      expect(fetch).toHaveBeenCalledWith('/api/projects')
    })

    test('shows backend offline banner when backend is unreachable', async () => {
      fetch.mockRejectedValue(new Error('Failed to fetch'))

      render(<App />)

      await waitFor(() => {
        expect(screen.getByTestId('backend-offline-overlay')).toBeInTheDocument()
      })

      // The backend gate should block the rest of the UI while offline.
      expect(screen.queryByLabelText('Provider')).not.toBeInTheDocument()
    })

    test('shows backend offline overlay while settings are still loading', async () => {
      // Even if settings are in-flight, the early backend availability gate should
      // block the app if /api/health cannot be reached.
      let resolveLlmStatus
      const llmStatusDeferred = new Promise((resolve) => {
        resolveLlmStatus = resolve
      })

      fetch.mockImplementation((url) => {
        if (url === '/api/llm/status') {
          return llmStatusDeferred
        }

        return Promise.reject(new Error('Failed to fetch'))
      })

      render(<App />)

      await waitFor(() => {
        expect(screen.getByTestId('backend-offline-overlay')).toBeInTheDocument()
      })

      resolveLlmStatus(mockApiResponse({ ...defaultLLMStatus }))
    })

    test('Retry re-hydrates LLM status after backend starts (no refresh needed)', async () => {
      const user = userEvent.setup()

      let healthCalls = 0
      let llmCalls = 0

      fetch.mockImplementation((url) => {
        if (url === '/api/health') {
          healthCalls += 1
          if (healthCalls === 1) {
            return Promise.reject(new Error('Backend unreachable'))
          }
          return Promise.resolve(mockApiResponse({ ok: true }))
        }

        if (url === '/api/llm/status') {
          llmCalls += 1
          if (llmCalls === 1) {
            return Promise.reject(new Error('Backend unreachable'))
          }
          return Promise.resolve(mockApiResponse({ ...defaultLLMStatus }))
        }

        if (url === '/api/projects') {
          return Promise.resolve(mockApiResponse({ success: true, projects: [] }))
        }

        return Promise.resolve(mockApiResponse({ success: true }))
      })

      render(<App />)

      await waitFor(() => {
        expect(screen.getByTestId('backend-offline-overlay')).toBeInTheDocument()
      })

      await user.click(screen.getByTestId('backend-retry'))

      await waitFor(() => {
        expect(screen.queryByTestId('backend-offline-overlay')).not.toBeInTheDocument()
      })

      await screen.findByText('Select Project')
      expect(screen.queryByLabelText('Provider')).not.toBeInTheDocument()
    })

    test('shows backend offline overlay when backend is down behind a proxy (502)', async () => {
      fetch.mockResolvedValue(mockApiResponse({ success: false }, false, 502))

      render(<App />)

      await waitFor(() => {
        expect(screen.getByTestId('backend-offline-overlay')).toBeInTheDocument()
      })
    })

    test('renders main view with existing projects', async () => {
      const mockProjects = [
        { id: '1', name: 'Test Project 1', description: 'First test project' },
        { id: '2', name: 'Test Project 2', description: 'Second test project' },
      ]

      projectsResponse = { success: true, projects: mockProjects }
      queueAxiosProjects(mockProjects)

      render(<App />)

      await waitFor(() => {
        expect(screen.getByText('Select Project')).toBeInTheDocument()
      })

      await waitFor(() => {
        expect(screen.getByText('Test Project 1')).toBeInTheDocument()
        expect(screen.getByText('Test Project 2')).toBeInTheDocument()
      })

      expect(screen.queryByText('No projects yet')).not.toBeInTheDocument()
    })

    test('navigates to create project view when create button clicked', async () => {
      const user = userEvent.setup()

      render(<App />)

      await waitFor(() => {
        expect(screen.getByText('Create New Project')).toBeInTheDocument()
      })

      await user.click(screen.getByText('Create New Project'))

      await waitFor(() => {
        expect(screen.getByText('Set up a new project with AI-powered coding assistance.')).toBeInTheDocument()
        expect(screen.getByLabelText('Project Name *')).toBeInTheDocument()
      })
    })

    test('navigates to import project view when import button clicked', async () => {
      const user = userEvent.setup()

      render(<App />)

      await waitFor(() => {
        expect(screen.getByText('Import Project')).toBeInTheDocument()
      })

      await user.click(screen.getByText('Import Project'))

      await waitFor(() => {
        expect(screen.getByText('Import an existing project from your local machine or a Git repository.')).toBeInTheDocument()
        expect(screen.getByText('Choose an import source')).toBeInTheDocument()
      })
    })

    test('navigates back to main view from create project', async () => {
      const user = userEvent.setup()

      render(<App />)

      await waitFor(() => {
        expect(screen.getByText('Create New Project')).toBeInTheDocument()
      })

      await user.click(screen.getByText('Create New Project'))

      await waitFor(() => {
        expect(screen.getByText('Set up a new project with AI-powered coding assistance.')).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: /close create project/i }))

      await waitFor(() => {
        expect(screen.getByText('Select Project')).toBeInTheDocument()
      })
    })

    test('navigates back to main view from import project', async () => {
      const user = userEvent.setup()

      render(<App />)

      await waitFor(() => {
        expect(screen.getByText('Import Project')).toBeInTheDocument()
      })

      await user.click(screen.getByText('Import Project'))

      await waitFor(() => {
        expect(screen.getByText('Import an existing project from your local machine or a Git repository.')).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: 'Close import' }))

      await waitFor(() => {
        expect(screen.getByText('Select Project')).toBeInTheDocument()
      })
    })

    test('cancels create project and returns to main view', async () => {
      const user = userEvent.setup()

      render(<App />)

      await waitFor(() => {
        expect(screen.getByText('Create New Project')).toBeInTheDocument()
      })

      await user.click(screen.getByText('Create New Project'))

      await waitFor(() => {
        expect(screen.getByText('Set up a new project with AI-powered coding assistance.')).toBeInTheDocument()
      })

      await user.type(screen.getByLabelText('Project Name *'), 'Temp Project')

      await user.click(screen.getByText('Cancel'))

      await waitFor(() => {
        expect(screen.getByText('Select Project')).toBeInTheDocument()
      })
    })

    test('cancels import project and returns to main view', async () => {
      const user = userEvent.setup()

      render(<App />)

      await waitFor(() => {
        expect(screen.getByText('Import Project')).toBeInTheDocument()
      })

      await user.click(screen.getByText('Import Project'))

      await waitFor(() => {
        expect(screen.getByText('Import an existing project from your local machine or a Git repository.')).toBeInTheDocument()
      })

      await user.click(screen.getByText('Cancel'))

      await waitFor(() => {
        expect(screen.getByText('Select Project')).toBeInTheDocument()
      })
    })
  })

  describe('Project Creation Integration', () => {
    test('successfully creates project and handles response', async () => {
      const user = userEvent.setup()

      const mockProject = {
        id: '123',
        name: 'Test Project',
        description: 'Test description',
        frontend: { language: 'javascript', framework: 'react' },
        backend: { language: 'javascript', framework: 'express' },
      }

      projectsResponse = { success: true, projects: [] }
      queueAxiosProjects([])
      queueAxiosPost({ success: true, project: mockProject })

      renderApp()

      await waitFor(() => {
        expect(screen.getByText('Create New Project')).toBeInTheDocument()
      })

      await user.click(screen.getByText('Create New Project'))

      await user.type(screen.getByLabelText('Project Name *'), 'Test Project')
      await user.type(screen.getByLabelText('Description'), 'Test description')
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'local')

      await user.click(screen.getByText('Create Project'))

      await waitFor(() => {
        expect(
          screen.queryByText('Project Inspector') ||
          screen.queryByText('Creating your project...') ||
          screen.queryByText('Select Project')
        ).not.toBeNull()
      })

      expect(axios.post).toHaveBeenCalledWith('/api/projects', expect.objectContaining({
        name: 'Test Project',
        description: 'Test description',
      }))
    })

    test('shows validation errors for missing required fields', async () => {
      const user = userEvent.setup()

      queueAxiosProjects([])
      renderApp()

      await waitFor(() => {
        expect(screen.getByText('Create New Project')).toBeInTheDocument()
      })

      await user.click(screen.getByText('Create New Project'))

      await user.click(screen.getByText('Create Project'))

      await waitFor(() => {
        expect(screen.getByText('Project name is required')).toBeInTheDocument()
      })

      expect(axios.post).not.toHaveBeenCalled()
    })

    test('handles backend error response properly', async () => {
      const user = userEvent.setup()

      queueAxiosProjects([])
      renderApp()

      await waitFor(() => {
        expect(screen.getByText('Create New Project')).toBeInTheDocument()
      })

      await user.click(screen.getByText('Create New Project'))

      await user.type(screen.getByLabelText('Project Name *'), 'Duplicate Project')
      await user.type(screen.getByLabelText('Description'), 'Test description')
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'local')

      axios.post.mockRejectedValueOnce({
        response: {
          status: 400,
          data: { error: 'Project name already exists' },
        },
      })

      await user.click(screen.getByText('Create Project'))

      await waitFor(() => {
        expect(screen.getByText('Set up a new project with AI-powered coding assistance.')).toBeInTheDocument()
      })

      expect(axios.post).toHaveBeenCalled()
    })

    test('handles network error during project creation', async () => {
      const user = userEvent.setup()

      queueAxiosProjects([])
      renderApp()

      await waitFor(() => {
        expect(screen.getByText('Create New Project')).toBeInTheDocument()
      })

      await user.click(screen.getByText('Create New Project'))

      await user.type(screen.getByLabelText('Project Name *'), 'Flaky Project')
      await user.type(screen.getByLabelText('Description'), 'Flaky description')
      await user.selectOptions(screen.getByLabelText('Git Workflow *'), 'local')

      axios.post.mockRejectedValueOnce(new Error('Network error'))

      await user.click(screen.getByText('Create Project'))

      await waitFor(() => {
        const stillOnForm = screen.queryByText('Set up a new project with AI-powered coding assistance.')
        const backToMain = screen.queryByText('Select Project')
        expect(stillOnForm || backToMain).not.toBeNull()
      })
    })
  })

  describe('Project Import Integration', () => {
    test('shows import form with proper validation', async () => {
      const user = userEvent.setup()

      queueAxiosProjects([])
      renderApp()

      await waitFor(() => {
        expect(screen.getByText('Import Project')).toBeInTheDocument()
      })

      await user.click(screen.getByText('Import Project'))

      await waitFor(() => {
        expect(screen.getByText('Import an existing project from your local machine or a Git repository.')).toBeInTheDocument()
      })

      await user.click(screen.getByText('Next'))
      await user.click(screen.getByText('Next'))
      expect(await screen.findByText('Project path is required')).toBeInTheDocument()
    })

    test('switches between import methods correctly', async () => {
      const user = userEvent.setup()

      renderApp()

      await waitFor(() => {
        expect(screen.getByText('Import Project')).toBeInTheDocument()
      })

      await user.click(screen.getByText('Import Project'))

      await waitFor(() => {
        expect(screen.getByText('Choose an import source')).toBeInTheDocument()
      })

      expect(screen.getByRole('tab', { name: 'Local Folder' })).toHaveAttribute('aria-selected', 'true')

      await user.click(screen.getByRole('tab', { name: 'GitHub / GitLab' }))
      expect(screen.getByRole('tab', { name: 'GitHub / GitLab' })).toHaveAttribute('aria-selected', 'true')

      await user.click(screen.getByText('Next'))
      expect(await screen.findByLabelText('Git Repository URL *')).toBeInTheDocument()

      await user.click(screen.getByText('Back'))
      await user.click(screen.getByRole('tab', { name: 'Local Folder' }))
      await user.click(screen.getByText('Next'))
      expect(await screen.findByLabelText('Project Folder Path *')).toBeInTheDocument()
    })

    test('successfully imports project with valid data', async () => {
      const user = userEvent.setup()

      renderApp()

      await waitFor(() => {
        expect(screen.getByText('Import Project')).toBeInTheDocument()
      })

      await user.click(screen.getByText('Import Project'))

      await waitFor(() => {
        expect(screen.getByText('Import an existing project from your local machine or a Git repository.')).toBeInTheDocument()
      })

      await user.click(screen.getByText('Next'))
      await user.type(screen.getByLabelText('Project Folder Path *'), '/test/path')
      await user.click(screen.getByText('Next'))
      fireEvent.change(screen.getByLabelText('Project Name *'), { target: { value: 'Imported Project' } })
      await user.type(screen.getByLabelText('Description'), 'Test imported project')
      await user.click(screen.getByText('Next'))
      await user.click(screen.getByText('Next'))
      await user.click(screen.getByText('Next'))
      await user.click(screen.getByText('Import Project'))

      await waitFor(() => {
        expect(screen.getByTestId('project-inspector')).toBeInTheDocument()
      })
    })
  })

  describe('Project Selection', () => {
    test('can select existing project', async () => {
      const user = userEvent.setup()

      const mockProjects = [
        { id: '1', name: 'Existing Project', description: 'Test project' },
      ]

      projectsResponse = { success: true, projects: mockProjects }
      queueAxiosProjects(mockProjects)
      startProjectResponse = { success: true, message: 'Project started' }

      renderApp()

      await waitFor(() => {
        expect(screen.getByText('Existing Project')).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: 'Open Existing Project' }))

      await waitFor(() => {
        const inspector = screen.queryByTestId('project-inspector')
        const loading = screen.queryByText(/Loading/i)
        const main = screen.queryByText('Select Project')
        expect(inspector || loading || main).not.toBeNull()
      })

      expect(fetch).toHaveBeenCalledWith('/api/projects/1/start', expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }))
    })
  })

  describe('LLM Configuration State', () => {
    test('app works correctly when LLM is properly configured', async () => {
      queueAxiosProjects([])
      renderApp()

      await waitFor(() => {
        expect(screen.getByText('Select Project')).toBeInTheDocument()
      })

      expect(screen.getByText('Create New Project')).toBeInTheDocument()
      expect(screen.getByText('Import Project')).toBeInTheDocument()
    })

    test('handles unconfigured LLM state appropriately', async () => {
      llmStatusResponse = {
        success: true,
        configured: false,
        ready: false,
        reason: 'No LLM configuration found'
      }
      queueAxiosProjects([])

      renderApp()

      await waitFor(() => {
        expect(screen.getByLabelText('Provider')).toBeInTheDocument()
      })
    })
  })

  describe('Error Handling', () => {
    test('handles API failure gracefully', async () => {
      projectsRejectOnce = new Error('Network error')

      renderApp()

      await waitFor(() => {
        const hasContent = screen.queryByText('Select Project') ||
          screen.queryByText(/error/i) ||
          screen.queryByText('Loading') ||
          screen.queryByLabelText('Provider')
        expect(hasContent).not.toBeNull()
      })

      expect(fetch).toHaveBeenCalledWith('/api/projects')
    })

    test('handles slow API response', async () => {
      projectsDelayMs = 100

      vi.useFakeTimers()

      try {
        renderApp()

        await act(async () => {
          await vi.advanceTimersByTimeAsync(100)
        })

        vi.useRealTimers()

        await waitFor(() => {
          expect(screen.getByText('Select Project')).toBeInTheDocument()
        })
      } finally {
        vi.useRealTimers()
      }
    })
  })
})