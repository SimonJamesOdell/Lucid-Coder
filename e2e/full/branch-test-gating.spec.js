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

test('branch tab shows testing gate warning and action for failing branch', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Branch Gate ${Date.now()}`

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.route('**/api/projects/*/branches', async (route) => {
    const overview = {
      success: true,
      current: 'feature/test-gate',
      branches: [
        { name: 'main', status: 'active', isCurrent: false },
        { name: 'feature/test-gate', status: 'needs-fix', isCurrent: true }
      ],
      workingBranches: [
        {
          name: 'feature/test-gate',
          status: 'needs-fix',
          lastTestStatus: 'failed',
          testsRequired: true,
          mergeBlockedReason: 'Tests failed',
          stagedFiles: [{ path: 'src/App.jsx', status: 'M' }]
        }
      ]
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(overview)
    })
  })

  await createProject(page, projectName, 'Branch testing gate flow')

  await page.getByTestId('branch-tab').click()
  await expect(page.getByTestId('branch-details-panel')).toBeVisible()
  await expect(page.getByTestId('branch-warning')).toContainText('Tests failed')
  await expect(page.getByTestId('branch-begin-testing')).toBeEnabled()

  await closeAndDeleteProject(page, projectName)
})
