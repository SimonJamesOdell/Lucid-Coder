import { vi } from 'vitest'

const buildDefaultState = () => ({
  isLLMConfigured: false,
  llmConfig: null,
  currentProject: null,
  projects: [],
  theme: 'dark',
  currentView: 'main',
  hasProject: false,
  canUseTools: false,
  canUseProjects: false,
  canUseSettings: false,
  configureLLM: vi.fn(),
  selectProject: vi.fn(),
  createProject: vi.fn(),
  importProject: vi.fn(),
  toggleTheme: vi.fn(),
  logout: vi.fn(),
  showMain: vi.fn(),
  showCreateProject: vi.fn(),
  showImportProject: vi.fn(),
  setView: vi.fn(),
  closeProject: vi.fn(),
})

let currentAppState = buildDefaultState()

export const setMockAppState = (overrides = {}) => {
  currentAppState = {
    ...buildDefaultState(),
    ...overrides,
  }
  return currentAppState
}

export const patchMockAppState = (overrides = {}) => {
  currentAppState = {
    ...currentAppState,
    ...overrides,
  }
  return currentAppState
}

export const resetMockAppState = () => setMockAppState()

export const getMockAppState = () => currentAppState

const MockProvider = ({ children }) => children

const useAppStateMock = () => currentAppState

export const createAppStateContextModule = () => ({
  AppStateProvider: MockProvider,
  useAppState: useAppStateMock,
})
