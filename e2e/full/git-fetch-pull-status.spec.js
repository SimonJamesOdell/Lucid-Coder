const { test, expect } = require('@playwright/test')
const { ensureBootstrapped } = require('../e2e-utils')

const createProject = async (page, projectName, description) => {
  await page.getByRole('button', { name: 'Create New Project' }).click()
  await expect(page.getByRole('heading', { name: 'Create New Project' })).toBeVisible()

  await page.getByLabel('Project Name *').fill(projectName)
  await page.getByLabel('Description').fill(description)
  await page.getByRole('button', { name: 'Create Project', exact: true }).click()

  await expect(page.getByTestId('close-project-button')).toBeVisible({ timeout: 60_000 })
}

const closeAndDeleteProject = async (page, projectName) => {
  await page.getByTestId('close-project-button').click()
  await expect(page.getByText('Select Project')).toBeVisible({ timeout: 30_000 })

  const projectCard = page.locator('.project-card', { hasText: projectName })
  await expect(projectCard).toBeVisible()

  await projectCard.getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByTestId('modal-content')).toBeVisible()
  await page.getByTestId('modal-confirm').click()

  await expect(projectCard).toHaveCount(0)
}

test('git tab fetch and pull update status messaging', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Git Status ${Date.now()}`

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.route('**/api/settings/git', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          settings: { provider: 'github', defaultBranch: 'main', tokenPresent: false }
        })
      })
      return
    }

    await route.fallback()
  })

  await page.route('**/api/projects/*/git-settings', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          inheritsFromGlobal: true,
          effectiveSettings: {
            workflow: 'cloud',
            provider: 'github',
            remoteUrl: 'https://github.com/example/repo.git',
            defaultBranch: 'main'
          }
        })
      })
      return
    }

    await route.fallback()
  })

  await page.route('**/api/projects/*/git/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        status: { hasRemote: true, branch: 'main', ahead: 0, behind: 0 }
      })
    })
  })

  await page.route('**/api/projects/*/branches', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        current: 'main',
        branches: [{ name: 'main', status: 'active', isCurrent: true }],
        workingBranches: []
      })
    })
  })

  await page.route('**/api/projects/*/git/fetch', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, status: { hasRemote: true } })
    })
  })

  await page.route('**/api/projects/*/git/pull', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, status: { hasRemote: true }, strategy: 'rebase' })
    })
  })

  await createProject(page, projectName, 'Git status flow')

  await page.getByTestId('git-tab').click()
  await expect(page.getByTestId('git-tab-panel')).toBeVisible()

  await page.getByTestId('git-fetch-remote').click()
  await expect(page.getByText('Fetched latest from remote.')).toBeVisible()

  await page.getByTestId('git-pull-remote').click()
  await expect(page.getByText('Pulled with rebase.')).toBeVisible()

  await closeAndDeleteProject(page, projectName)
})
