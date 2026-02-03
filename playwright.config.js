// @ts-check
const os = require('node:os')
const path = require('node:path')
const { defineConfig, devices } = require('@playwright/test')

const repoRoot = __dirname
const defaultDbPath = path.join(repoRoot, 'backend', 'e2e-lucidcoder.db')
const defaultProjectsDir = path.join(os.tmpdir(), `lucidcoder-e2e-projects-${Date.now()}`)

if (!process.env.E2E_DB_PATH) {
  process.env.E2E_DB_PATH = defaultDbPath
}

if (!process.env.E2E_PROJECTS_DIR) {
  process.env.E2E_PROJECTS_DIR = defaultProjectsDir
}

const FRONTEND_URL = process.env.E2E_FRONTEND_URL || 'http://localhost:3000'
const BACKEND_URL = process.env.E2E_BACKEND_URL || 'http://localhost:5000'
const REUSE_EXISTING_SERVER = Boolean(process.env.E2E_REUSE_SERVER) && !process.env.CI

module.exports = defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.js',
  globalTeardown: './e2e/global-teardown.js',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
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
      timeout: 60_000,
      env: {
        ...process.env,
        PORT: '5000',
        DATABASE_PATH: process.env.E2E_DB_PATH,
        PROJECTS_DIR: process.env.E2E_PROJECTS_DIR,
        E2E_SKIP_SCAFFOLDING: process.env.E2E_SKIP_SCAFFOLDING || '1'
      }
    },
    {
      command: 'npm --prefix frontend run start -- --port 3000 --strictPort',
      url: FRONTEND_URL,
      reuseExistingServer: REUSE_EXISTING_SERVER,
      timeout: 60_000,
      env: {
        ...process.env
      }
    }
  ],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ]
})
