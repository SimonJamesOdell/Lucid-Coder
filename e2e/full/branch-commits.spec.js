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

test('branch and commits tabs show empty states', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Branch Commits ${Date.now()}`

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await createProject(page, projectName, 'Branch and commits tab flow')

  await page.getByTestId('branch-tab').click()
  await expect(page.getByTestId('branch-list')).toBeVisible()
  await expect(page.getByTestId('branch-details-panel')).toBeVisible()
  await expect(page.getByTestId('branch-list-item-main')).toBeVisible()
  await expect(page.getByTestId('branch-main-message')).toBeVisible()

  await page.getByTestId('commits-tab').click()
  await expect(page.getByTestId('commits-tab-panel')).toBeVisible()
  await expect(page.getByTestId('commits-list')).toBeVisible()
  await expect(page.getByTestId('commit-details-panel')).toBeVisible()

  await closeAndDeleteProject(page, projectName)
})
