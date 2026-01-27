import '@testing-library/jest-dom'
import { cleanup, configure } from '@testing-library/react'
import { prettyDOM } from '@testing-library/dom'
import { vi } from 'vitest'

// Suppress React act() warnings in tests - React Testing Library handles this automatically
const originalError = console.error
const originalConsoleMethods = {
  log: console.log,
  info: console.info,
  warn: console.warn
}
const originalStderrWrite = process.stderr.write.bind(process.stderr)

const suppressedErrorPatterns = [
  /Warning: An update to .+ was not wrapped in act/i,
  /useAppState must be used within/i,
  /Failed to restart project after updating port settings/i,
  /Error fetching project files/i,
  /Error fetching file content/i,
  /Failed to save file/i,

  // Happy DOM iframe/fetch noise (PreviewTab tests trigger aborts/connection refused).
  /DOMException \[AbortError\]/i,
  /DOMException \[NetworkError\]/i,
  /Failed to execute "fetch\(\)" on "Window"/i,
  /The operation was aborted\.?/i,
  /connect ECONNREFUSED/i,
  /Failed to execute 'startTask\(\)' on 'AsyncTaskManager'/i,
  /The asynchronous task manager has been destroyed/i
]

const normalizeConsoleArg = (value) => {
  if (typeof value === 'string') {
    return value
  }

  if (value instanceof Error) {
    return [
      `${value.name}: ${value.message}`,
      typeof value.stack === 'string' ? value.stack : ''
    ]
      .filter(Boolean)
      .join('\n')
  }

  if (
    value &&
    typeof value === 'object' &&
    typeof value.name === 'string' &&
    typeof value.message === 'string'
  ) {
    const stack = typeof value.stack === 'string' ? value.stack : ''
    return [`${value.name}: ${value.message}`, stack].filter(Boolean).join('\n')
  }

  if (value && typeof value === 'object' && typeof value.message === 'string') {
    return value.message
  }

  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      // ignore
    }
  }

  try {
    return String(value)
  } catch {
    return ''
  }
}

const shouldSuppressError = (args = []) => {
  const combined = args.map(normalizeConsoleArg).filter(Boolean).join(' ')
  if (!combined) {
    return false
  }

  return suppressedErrorPatterns.some((pattern) => pattern.test(combined))
}

const shouldSuppressStderr = (chunk) => {
  if (shouldEmitConsoleOutput()) {
    return false
  }

  if (!chunk) {
    return false
  }

  const message = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
  if (!message) {
    return false
  }

  return suppressedErrorPatterns.some((pattern) => pattern.test(message))
}

const shouldEmitConsoleOutput = () => process.env.VITE_VERBOSE_TEST_LOGS === 'true'

configure({
  getElementError: (message, container) => {
    if (shouldEmitConsoleOutput() && container) {
      const domSnapshot = prettyDOM(container)
      return new Error(`${message}\n\n${domSnapshot}`)
    }
    const error = new Error(message)
    error.name = 'TestingLibraryElementError'
    return error
  }
})

const suppressConsoleNoise = () => {
  console.log = (...args) => {
    if (shouldEmitConsoleOutput()) {
      originalConsoleMethods.log.apply(console, args)
    }
  }

  console.info = (...args) => {
    if (shouldEmitConsoleOutput()) {
      originalConsoleMethods.info.apply(console, args)
    }
  }

  console.warn = (...args) => {
    if (shouldEmitConsoleOutput()) {
      originalConsoleMethods.warn.apply(console, args)
    }
  }
}

console.error = (...args) => {
  if (shouldSuppressError(args)) {
    return
  }
  originalError.call(console, ...args)
}

process.stderr.write = (chunk, encoding, cb) => {
  if (shouldSuppressStderr(chunk)) {
    if (typeof cb === 'function') {
      cb()
    }
    return true
  }

  return originalStderrWrite(chunk, encoding, cb)
}

suppressConsoleNoise()

afterAll(() => {
  console.error = originalError
  console.log = originalConsoleMethods.log
  console.info = originalConsoleMethods.info
  console.warn = originalConsoleMethods.warn
  process.stderr.write = originalStderrWrite
})

// Mock localStorage with actual storage
const localStorageMock = (() => {
  let store = {}
  return {
    getItem: vi.fn((key) => store[key] || null),
    setItem: vi.fn((key, value) => {
      store[key] = value.toString()
    }),
    removeItem: vi.fn((key) => {
      delete store[key]
    }),
    clear: vi.fn(() => {
      store = {}
    }),
  }
})()
global.localStorage = localStorageMock

// Helper to create mock API responses that match the global mock shape
export const mockApiResponse = (data, ok = true, status = 200) => ({
  ok,
  status,
  json: () => Promise.resolve(data)
})

// Mock fetch globally with default empty projects response
global.fetch = vi.fn(() =>
  Promise.resolve(mockApiResponse({ success: true, projects: [] }))
)

// Mock axios
vi.mock('axios', () => ({
  default: {
    post: vi.fn(),
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  post: vi.fn(),
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}))

// Setup global test environment
global.ResizeObserver = vi.fn(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}))

// Mock window.prompt for project creation tests
global.prompt = vi.fn()

// Mock window.alert for notification tests
global.alert = vi.fn()

// Clean up after each test
afterEach(() => {
  vi.clearAllMocks()
  vi.clearAllTimers()
  vi.useRealTimers()
  localStorageMock.clear()
  localStorageMock.getItem.mockClear()
  localStorageMock.setItem.mockClear()
  localStorageMock.removeItem.mockClear()
  localStorageMock.clear.mockClear()
  
  // Reset fetch mock to default behavior
  global.fetch.mockClear()
  global.fetch.mockResolvedValue(
    mockApiResponse({ success: true, projects: [] }, true, 200)
  )

  cleanup()
})

// Clean up after all tests
afterAll(() => {
  vi.restoreAllMocks()
})