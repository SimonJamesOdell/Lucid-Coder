// @ts-check
const { defineConfig, devices } = require('@playwright/test')

const FRONTEND_URL = process.env.E2E_FRONTEND_URL || 'http://localhost:3000'
const BACKEND_URL = process.env.E2E_BACKEND_URL || 'http://localhost:5000'

module.exports = defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.js',
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
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        ...process.env,
        PORT: '5000',
        DATABASE_PATH: 'backend/e2e-lucidcoder.db'
      }
    },
    {
      command: 'npm --prefix frontend run start -- --port 3000 --strictPort',
      url: FRONTEND_URL,
      reuseExistingServer: !process.env.CI,
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
