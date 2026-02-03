const { test, expect } = require('@playwright/test')
const { ensureBootstrapped } = require('../e2e-utils')

test('project selector opens a project from the list', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const project = {
    id: 501,
    name: 'Alpha Project',
    description: 'Seed project',
    language: 'JavaScript',
    framework: 'React',
    updatedAt: '2026-02-03T00:00:00.000Z'
  }

  await page.route('**/api/settings/git', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        settings: { provider: 'github', defaultBranch: 'main', tokenPresent: false }
      })
    })
  })

  await page.route('**/api/settings/ports', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        settings: { frontendPortBase: 5000, backendPortBase: 7000 }
      })
    })
  })

  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback()
      return
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, projects: [project] })
    })
  })

  await page.route('**/api/projects/501/git-settings', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        inheritsFromGlobal: true,
        effectiveSettings: {
          workflow: 'local',
          provider: 'github',
          remoteUrl: '',
          defaultBranch: 'main'
        }
      })
    })
  })

  await page.route('**/api/projects/501/start', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        processes: {
          frontend: { status: 'running', url: 'http://localhost:9000' },
          backend: { status: 'running', url: 'http://localhost:9001' }
        }
      })
    })
  })

  await page.route('**/api/projects/501/processes', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        processes: {
          frontend: { status: 'running' },
          backend: { status: 'running' }
        }
      })
    })
  })

  await page.route('**/api/projects/501/jobs', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, jobs: [] })
    })
  })

  await page.route('**/api/projects/501/stop', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, message: 'stopped' })
    })
  })

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.getByRole('button', { name: 'Open Alpha Project' }).click()

  await expect(page.getByTestId('close-project-button')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.project-title')).toHaveText('Alpha Project')

  await page.getByTestId('close-project-button').click()
  await expect(page.getByText('Select Project')).toBeVisible({ timeout: 30_000 })
})
