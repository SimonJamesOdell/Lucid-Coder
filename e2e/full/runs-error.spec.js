const { test, expect } = require('@playwright/test')
const { ensureBootstrapped } = require('../e2e-utils')

const createProject = async (page, projectName, description) => {
  await page.getByRole('button', { name: 'Create New Project' }).click()
  await expect(page.getByRole('heading', { name: 'Create New Project' })).toBeVisible()

  await page.getByLabel('Project Name *').fill(projectName)
  await page.getByLabel('Description').fill(description)
  await page.getByLabel('Git Workflow *').selectOption('local')
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

test('runs tab shows missing detail state and surfaces errors', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Runs Errors ${Date.now()}`

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.route('**/api/projects/*/runs', async (route) => {
    const { pathname } = new URL(route.request().url())
    if (/\/api\/projects\/[^/]+\/runs$/.test(pathname)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          runs: [
            { id: 1, kind: 'job', status: 'completed', statusMessage: 'First run' },
            { id: 2, kind: 'job', status: 'failed', statusMessage: 'Second run' }
          ]
        })
      })
      return
    }

    await route.fallback()
  })

  await page.route('**/api/projects/*/runs/*', async (route) => {
    const { pathname } = new URL(route.request().url())
    if (/\/api\/projects\/[^/]+\/runs\/1$/.test(pathname)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ run: null, events: [] })
      })
      return
    }

    if (/\/api\/projects\/[^/]+\/runs\/2$/.test(pathname)) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Run detail error' })
      })
      return
    }

    await route.fallback()
  })

  await createProject(page, projectName, 'Runs error flow')

  await page.getByTestId('runs-tab').click()
  await expect(page.getByTestId('runs-tab-panel')).toBeVisible()

  await page.getByTestId('run-row-1').click()
  await expect(page.getByTestId('runs-detail-missing')).toBeVisible()

  await page.getByTestId('run-row-2').click()
  await expect(page.getByTestId('runs-error')).toBeVisible()

  await closeAndDeleteProject(page, projectName)
})
