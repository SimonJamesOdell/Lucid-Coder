// React template generators
export default {
  javascript: {
    packageJson: (name) => ({
      name: `${name}-frontend`,
      private: true,
      version: "0.0.0",
      type: "module",
      scripts: {
        dev: "vite",
        build: "vite build",
        lint: "eslint . --ext js,jsx --report-unused-disable-directives --max-warnings 0",
        preview: "vite preview",
        test: "vitest run",
        "test:watch": "vitest",
        "test:ui": "vitest --ui",
        "test:run": "vitest run",
        "test:coverage": "vitest run --coverage",
        "test:e2e": "playwright test"
      },
      dependencies: {
        react: "18.2.0",
        "react-dom": "18.2.0",
        axios: "^1.6.0"
      },
      devDependencies: {
        "@types/react": "^18.2.43",
        "@types/react-dom": "^18.2.17",
        "@vitejs/plugin-react": "^4.2.1",
        "@testing-library/react": "^13.4.0",
        "@testing-library/jest-dom": "^6.1.4",
        "@testing-library/user-event": "^14.5.1",
        "@vitest/coverage-v8": "^1.0.4",
        "@vitest/ui": "^1.0.4",
        eslint: "^8.55.0",
        "eslint-plugin-react": "^7.33.2",
        "eslint-plugin-react-hooks": "^4.6.0",
        "eslint-plugin-react-refresh": "^0.4.5",
        jsdom: "^23.0.1",
        "@playwright/test": "^1.49.1",
        vite: "^5.0.8",
        vitest: "^1.0.4"
      }
    }),
    playwrightConfig: `import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5173',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 60_000
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ]
})
`,
    e2eTest: (name) => `import { test, expect } from '@playwright/test'

test('${name} loads', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: '${name}' })).toBeVisible()
})
`,
    viteConfig: `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      }
    }
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.{test,spec}.{js,jsx,ts,tsx}'],
    coverage: {
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'src/test/'
      ]
    }
  }
})`,
    vitestConfig: `import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.{test,spec}.{js,jsx,ts,tsx}'],
    coverage: {
      reporter: ['text', 'json', 'html']
    }
  }
})`,
    indexHtml: (name) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${name}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>`,
    mainJsx: `import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)`,
    appJsx: (name) => `import { useState, useEffect } from 'react'
import axios from 'axios'
import './App.css'

function App() {
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchMessage()
  }, [])

  const fetchMessage = async () => {
    try {
      const response = await axios.get('/api/health')
      setMessage(response.data.message)
    } catch (error) {
      setMessage('Failed to connect to backend')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="App">
      <header className="App-header">
        <h1>${name}</h1>
        <p>{loading ? 'Connecting to backend...' : message}</p>
        <p>
          Edit <code>src/App.jsx</code> and save to test HMR
        </p>
      </header>
    </div>
  )
}

export default App`,
    appCss: `#root {
  max-width: 1280px;
  margin: 0 auto;
  padding: 2rem;
  text-align: center;
}

.App-header {
  background-color: #282c34;
  padding: 20px;
  color: white;
  border-radius: 8px;
}

.App-header h1 {
  font-size: 2rem;
  margin-bottom: 1rem;
}

.App-header p {
  font-size: 1.1rem;
  margin: 0.5rem 0;
}

.App-header code {
  background-color: #444;
  padding: 2px 4px;
  border-radius: 4px;
}`,
    indexCss: `body {
  margin: 0;
  display: flex;
  place-items: center;
  min-width: 320px;
  min-height: 100vh;
  font-family: Inter, system-ui, Avenir, Helvetica, Arial, sans-serif;
  line-height: 1.5;
  font-weight: 400;
  color-scheme: light dark;
  color: rgba(255, 255, 255, 0.87);
  background-color: #242424;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  -webkit-text-size-adjust: 100%;
}`,
    testSetup: `import '@testing-library/jest-dom'

// Mock environment variables for tests
process.env.NODE_ENV = 'test'

// Global test utilities can be added here`,
    appTestJsx: (name) => `import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from '../App'
import axios from 'axios'

describe('${name} App', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('renders the project heading', () => {
    render(<App />)
    expect(screen.getByRole('heading', { level: 1, name: '${name}' })).toBeInTheDocument()
  })

  test('shows the loading message before the health check resolves', () => {
    vi.spyOn(axios, 'get').mockImplementation(() => new Promise(() => {}))
    render(<App />)
    expect(screen.getByText('Connecting to backend...')).toBeInTheDocument()
  })

  test('displays backend status when the request succeeds', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ data: { message: 'Backend ready' } })
    render(<App />)
    expect(await screen.findByText('Backend ready')).toBeInTheDocument()
  })

  test('falls back to an error state when the request fails', async () => {
    vi.spyOn(axios, 'get').mockRejectedValue(new Error('boom'))
    render(<App />)
    expect(await screen.findByText(/Failed to connect to backend/i)).toBeInTheDocument()
  })
})`,
    utilsTestJs: `import { describe, test, expect } from 'vitest'

const formatCurrency = (amount) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount)

const isValidEmail = (email) => /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)

const buildApiResponse = (data, success = true) => ({
  success,
  data,
  timestamp: new Date().toISOString()
})

describe('Utility helpers', () => {
  test('formats currency in USD', () => {
    expect(formatCurrency(123.45)).toBe('$123.45')
    expect(formatCurrency(0)).toBe('$0.00')
  })

  test('validates email addresses', () => {
    expect(isValidEmail('test@example.com')).toBe(true)
    expect(isValidEmail('invalid-email')).toBe(false)
  })

  test('wraps API responses with metadata', () => {
    const response = buildApiResponse({ id: 1 })
    expect(response.success).toBe(true)
    expect(response.data).toEqual({ id: 1 })
    expect(response).toHaveProperty('timestamp')
  })
})`
  },
  typescript: {
    packageJson: (name) => ({
      name: `${name}-frontend`,
      private: true,
      version: "0.0.0",
      type: "module",
      scripts: {
        dev: "vite",
        build: "tsc && vite build",
        lint: "eslint . --ext ts,tsx --report-unused-disable-directives --max-warnings 0",
        preview: "vite preview",
        test: "vitest run",
        "test:watch": "vitest",
        "test:ui": "vitest --ui",
        "test:run": "vitest run",
        "test:coverage": "vitest run --coverage",
        "test:e2e": "playwright test"
      },
      dependencies: {
        react: "18.2.0",
        "react-dom": "18.2.0",
        axios: "^1.6.0"
      },
      devDependencies: {
        "@types/react": "^18.2.43",
        "@types/react-dom": "^18.2.17",
        "@typescript-eslint/eslint-plugin": "^6.14.0",
        "@typescript-eslint/parser": "^6.14.0",
        "@vitejs/plugin-react": "^4.2.1",
        "@testing-library/react": "^13.4.0",
        "@testing-library/jest-dom": "^6.1.4",
        "@testing-library/user-event": "^14.5.1",
        "@vitest/coverage-v8": "^1.0.4",
        "@vitest/ui": "^1.0.4",
        eslint: "^8.55.0",
        "eslint-plugin-react-hooks": "^4.6.0",
        "eslint-plugin-react-refresh": "^0.4.5",
        jsdom: "^23.0.1",
        "@playwright/test": "^1.49.1",
        typescript: "^5.2.2",
        vite: "^5.0.8",
        vitest: "^1.0.4"
      }
    }),
    playwrightConfig: `import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5173',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 60_000
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ]
})
`,
    e2eTest: (name) => `import { test, expect } from '@playwright/test'

test('${name} loads', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: '${name}' })).toBeVisible()
})
`,
    tsConfig: {
      compilerOptions: {
        target: "ES2020",
        useDefineForClassFields: true,
        lib: ["ES2020", "DOM", "DOM.Iterable"],
        module: "ESNext",
        skipLibCheck: true,
        moduleResolution: "bundler",
        allowImportingTsExtensions: true,
        resolveJsonModule: true,
        isolatedModules: true,
        noEmit: true,
        jsx: "react-jsx",
        strict: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        noFallthroughCasesInSwitch: true
      },
      include: ["src"],
      references: [{ path: "./tsconfig.node.json" }]
    },
    tsConfigNode: {
      compilerOptions: {
        composite: true,
        skipLibCheck: true,
        module: "ESNext",
        moduleResolution: "bundler",
        allowSyntheticDefaultImports: true
      },
      include: ["vite.config.ts"]
    },
    mainTsx: `import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)`,
    appTsx: (name) => `import { useState, useEffect } from 'react'
import axios from 'axios'
import './App.css'

interface HealthResponse {
  message: string;
}

function App() {
  const [message, setMessage] = useState<string>('')
  const [loading, setLoading] = useState<boolean>(true)

  useEffect(() => {
    fetchMessage()
  }, [])

  const fetchMessage = async () => {
    try {
      const response = await axios.get<HealthResponse>('/api/health')
      setMessage(response.data.message)
    } catch (error) {
      setMessage('Failed to connect to backend')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="App">
      <header className="App-header">
        <h1>${name}</h1>
        <p>{loading ? 'Connecting to backend...' : message}</p>
        <p>
          Edit <code>src/App.tsx</code> and save to test HMR
        </p>
      </header>
    </div>
  )
}

export default App`,
    viteConfig: `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      }
    }
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{js,jsx,ts,tsx}'],
    coverage: {
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'src/test/'
      ]
    }
  }
})`,
    vitestConfig: `import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{js,jsx,ts,tsx}'],
    coverage: {
      reporter: ['text', 'json', 'html']
    }
  }
})`,
    indexHtml: (name) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${name}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`,
    appCss: `#root {
  max-width: 1280px;
  margin: 0 auto;
  padding: 2rem;
  text-align: center;
}

.App-header {
  background-color: #282c34;
  padding: 20px;
  color: white;
  border-radius: 8px;
}

.App-header h1 {
  font-size: 2rem;
  margin-bottom: 1rem;
}

.App-header p {
  font-size: 1.1rem;
  margin: 0.5rem 0;
}

.App-header code {
  background-color: #444;
  padding: 2px 4px;
  border-radius: 4px;
}`,
    indexCss: `body {
  margin: 0;
  display: flex;
  place-items: center;
  min-width: 320px;
  min-height: 100vh;
  font-family: Inter, system-ui, Avenir, Helvetica, Arial, sans-serif;
  line-height: 1.5;
  font-weight: 400;
  color-scheme: light dark;
  color: rgba(255, 255, 255, 0.87);
  background-color: #242424;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  -webkit-text-size-adjust: 100%;
}`,
    testSetupTs: `import '@testing-library/jest-dom'

// Mock environment variables for tests
process.env.NODE_ENV = 'test'

// Global test utilities can be added here`,
    appTestTsx: (name) => `import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from '../App'
import axios from 'axios'

describe('${name} App', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('renders the project heading', () => {
    render(<App />)
    expect(screen.getByRole('heading', { level: 1, name: '${name}' })).toBeInTheDocument()
  })

  test('shows the loading message before the health check resolves', () => {
    vi.spyOn(axios, 'get').mockImplementation(() => new Promise(() => {}))
    render(<App />)
    expect(screen.getByText('Connecting to backend...')).toBeInTheDocument()
  })

  test('displays backend status when the request succeeds', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ data: { message: 'Backend ready' } })
    render(<App />)
    expect(await screen.findByText('Backend ready')).toBeInTheDocument()
  })

  test('falls back to an error state when the request fails', async () => {
    vi.spyOn(axios, 'get').mockRejectedValue(new Error('boom'))
    render(<App />)
    expect(await screen.findByText(/Failed to connect to backend/i)).toBeInTheDocument()
  })
})`,
    utilsTestTs: `import { describe, test, expect } from 'vitest'

const formatCurrency = (amount: number): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount)

const isValidEmail = (email: string): boolean => /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)

interface ApiResponse<T> {
  success: boolean
  data: T
  timestamp: string
}

const buildApiResponse = <T>(data: T, success = true): ApiResponse<T> => ({
  success,
  data,
  timestamp: new Date().toISOString()
})

describe('Utility helpers', () => {
  test('formats currency in USD', () => {
    expect(formatCurrency(123.45)).toBe('$123.45')
    expect(formatCurrency(0)).toBe('$0.00')
  })

  test('validates email addresses', () => {
    expect(isValidEmail('test@example.com')).toBe(true)
    expect(isValidEmail('invalid-email')).toBe(false)
  })

  test('wraps API responses with metadata', () => {
    const response = buildApiResponse({ id: 1 })
    expect(response.success).toBe(true)
    expect(response.data).toEqual({ id: 1 })
    expect(response.timestamp).toEqual(expect.any(String))
  })
})`
  }
};
