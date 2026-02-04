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

test('commits tab shows pending composer and commit hint', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Commit Composer ${Date.now()}`

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.route('**/api/projects/*/commits', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        commits: [],
        overview: {
          current: 'feature/commit',
          branches: [
            { name: 'main', status: 'active', isCurrent: false },
            { name: 'feature/commit', status: 'ready-for-merge', isCurrent: true }
          ],
          workingBranches: [
            {
              name: 'feature/commit',
              status: 'ready-for-merge',
              lastTestStatus: 'passed',
              testsRequired: true,
              stagedFiles: [{ path: 'src/App.jsx', source: 'editor', timestamp: '2026-02-03T00:00:00.000Z' }]
            }
          ]
        }
      })
    })
  })

  await createProject(page, projectName, 'Commit composer flow')

  await page.getByTestId('commits-tab').click()
  await expect(page.getByTestId('commit-pending')).toBeVisible()

  await expect(page.getByTestId('branch-commit-subject')).toBeVisible()
  await expect(page.getByTestId('branch-commit-hint')).toBeVisible()
  await expect(page.getByTestId('branch-commit-submit')).toBeDisabled()

  await page.getByTestId('branch-commit-subject').fill('Add summary')
  await expect(page.getByTestId('branch-commit-submit')).toBeEnabled()

  await closeAndDeleteProject(page, projectName)
})
