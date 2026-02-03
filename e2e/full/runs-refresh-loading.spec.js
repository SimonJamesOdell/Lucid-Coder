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

test('runs tab refresh disables button while loading', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Runs Refresh ${Date.now()}`
  let resolveRuns
  const runsPromise = new Promise((resolve) => {
    resolveRuns = resolve
  })

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.route('**/api/projects/*/runs', async (route) => {
    const { pathname } = new URL(route.request().url())
    if (/\/api\/projects\/[^/]+\/runs$/.test(pathname)) {
      await runsPromise
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ runs: [] })
      })
      return
    }

    await route.fallback()
  })

  await createProject(page, projectName, 'Runs refresh flow')

  await page.getByTestId('runs-tab').click()
  await expect(page.getByTestId('runs-refresh')).toBeDisabled()
  await expect(page.getByTestId('runs-refresh')).toHaveText(/Refreshing/)

  resolveRuns()

  await expect(page.getByTestId('runs-none')).toBeVisible()
  await expect(page.getByTestId('runs-refresh')).toBeEnabled()

  await closeAndDeleteProject(page, projectName)
})
