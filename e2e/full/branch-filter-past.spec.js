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

test('branch sidebar shows empty past list and returns to open', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Branch Filter ${Date.now()}`

  const overview = {
    success: true,
    current: 'main',
    branches: [
      { name: 'main', status: 'active', isCurrent: true },
      { name: 'feature/open', status: 'active', isCurrent: false }
    ],
    workingBranches: []
  }

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.route('**/api/projects/*/branches', async (route) => {
    const { pathname } = new URL(route.request().url())
    if (/\/api\/projects\/[^/]+\/branches$/.test(pathname)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(overview)
      })
      return
    }

    await route.fallback()
  })

  await createProject(page, projectName, 'Branch filter flow')

  await page.getByTestId('branch-tab').click()
  await expect(page.getByTestId('branch-list-item-feature-open')).toBeVisible()

  await page.getByTestId('branch-filter-past').click()
  await expect(page.getByTestId('branch-empty')).toHaveText('No past branches yet.')

  await page.getByTestId('branch-filter-open').click()
  await expect(page.getByTestId('branch-list-item-feature-open')).toBeVisible()

  await closeAndDeleteProject(page, projectName)
})
