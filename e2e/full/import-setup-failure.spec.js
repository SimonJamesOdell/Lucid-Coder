const { test, expect } = require('@playwright/test')
const { ensureBootstrapped } = require('../e2e-utils')

test('import wizard shows setup job failure message', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Import Job Failure ${Date.now()}`

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.route('**/api/projects', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, projects: [] })
      })
      return
    }

    await route.fallback()
  })

  await page.route('**/api/fs/detect-tech**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        frontend: { language: 'javascript', framework: 'react' },
        backend: { language: 'javascript', framework: 'express' }
      })
    })
  })

  await page.route('**/api/fs/compatibility**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        plan: { needsChanges: false, changes: [] }
      })
    })
  })

  await page.route('**/api/projects/import', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        project: { id: 88, name: projectName },
        jobs: [{ id: 'setup-1', status: 'pending', displayName: 'Setup project' }]
      })
    })
  })

  await page.route('**/api/projects/88/git-settings', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        inheritsFromGlobal: true,
        effectiveSettings: { workflow: 'local', provider: 'github', remoteUrl: '', defaultBranch: 'main' }
      })
    })
  })

  await page.route('**/api/projects/88/start', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        processes: {
          frontend: { status: 'stopped' },
          backend: { status: 'stopped' }
        }
      })
    })
  })

  await page.route('**/api/projects/88/processes', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        processes: { frontend: null, backend: null }
      })
    })
  })

  await page.route('**/api/projects/88/jobs', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        jobs: [{ id: 'setup-1', status: 'failed', displayName: 'Setup project' }]
      })
    })
  })

  await page.getByRole('button', { name: 'Import Project' }).click()
  await expect(page.getByRole('heading', { name: 'Import Existing Project' })).toBeVisible()

  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByLabel('Project Folder Path *').fill('C:/Projects/setup-failure')
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByLabel('Project Name *').fill(projectName)
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('button', { name: 'Import Project', exact: true }).click()

  await expect(page.getByRole('heading', { name: 'Preparing your project' })).toBeVisible()
  await expect(page.getByText('Setup project')).toBeVisible()
  await expect(page.getByText('failed')).toBeVisible()
})
