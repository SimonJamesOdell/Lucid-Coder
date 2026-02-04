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

test('branch tab offers css-only skip testing and navigates to commits', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E CSS Skip ${Date.now()}`

  const overview = {
    success: true,
    current: 'feature/css-only',
    branches: [
      { name: 'main', status: 'active', isCurrent: false },
      { name: 'feature/css-only', status: 'active', isCurrent: true, stagedFileCount: 1 }
    ],
    workingBranches: [
      {
        name: 'feature/css-only',
        status: 'active',
        lastTestStatus: null,
        testsRequired: true,
        stagedFiles: [{ path: 'src/styles.css', source: 'editor', timestamp: '2026-02-03T00:00:00.000Z' }]
      }
    ]
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

  await page.route('**/api/projects/*/commits', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        commits: [],
        overview
      })
    })
  })

  await createProject(page, projectName, 'Branch css-only skip')

  await page.getByTestId('branch-tab').click()
  await expect(page.getByTestId('branch-skip-testing')).toBeVisible()

  await page.getByTestId('branch-skip-testing').click()
  await expect(page.getByTestId('commits-tab-panel')).toBeVisible()

  await closeAndDeleteProject(page, projectName)
})
