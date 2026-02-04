// @ts-check
const os = require('node:os')
const path = require('node:path')
const { defineConfig, devices } = require('@playwright/test')

const repoRoot = __dirname
const defaultDbPath = path.join(repoRoot, 'backend', 'e2e-lucidcoder.db')
const defaultProjectsDir = path.join(os.tmpdir(), `lucidcoder-e2e-projects-full-${Date.now()}`)

if (!process.env.E2E_DB_PATH) {
  process.env.E2E_DB_PATH = defaultDbPath
}

if (!process.env.E2E_PROJECTS_DIR) {
  process.env.E2E_PROJECTS_DIR = defaultProjectsDir
}

// Use dedicated default ports for E2E to avoid colliding with the normal dev
// servers (commonly 3000/5000) and to make reuseExistingServer safe.
const FRONTEND_URL = process.env.E2E_FRONTEND_URL || 'http://localhost:3100'
const BACKEND_URL = process.env.E2E_BACKEND_URL || 'http://localhost:5100'
// Local dev convenience: if servers are already running on the expected ports,
// reuse them instead of failing with a "port is already used" error.
// IMPORTANT: this is now opt-in to avoid accidentally reusing a non-E2E backend
// that points at a user's real database/settings.
// Opt in via E2E_REUSE_SERVER=1.
const REUSE_EXISTING_SERVER = !process.env.CI && process.env.E2E_REUSE_SERVER === '1'

module.exports = defineConfig({
  testDir: './e2e/full',
  globalSetup: './e2e/global-setup.js',
  globalTeardown: './e2e/global-teardown.js',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: FRONTEND_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  webServer: [
    {
      command: 'node backend/server.js',
      url: `${BACKEND_URL}/api/health`,
      reuseExistingServer: REUSE_EXISTING_SERVER,
      timeout: 120_000,
      env: {
        ...process.env,
        PORT: '5100',
        DATABASE_PATH: process.env.E2E_DB_PATH,
        PROJECTS_DIR: process.env.E2E_PROJECTS_DIR,
        E2E_SKIP_SCAFFOLDING: process.env.E2E_SKIP_SCAFFOLDING || '0'
      }
    },
    {
      command: 'npm --prefix frontend run start -- --port 3100 --strictPort',
      url: FRONTEND_URL,
      reuseExistingServer: REUSE_EXISTING_SERVER,
      timeout: 120_000,
      env: {
        ...process.env,
        E2E_BACKEND_URL: BACKEND_URL,
        VITE_API_TARGET: BACKEND_URL
      }
    }
  ],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] }
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] }
    }
  ]
})
