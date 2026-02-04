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

test('git tab shows project settings and repo actions', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Git Tab ${Date.now()}`

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await createProject(page, projectName, 'Git tab flow')

  await page.getByTestId('git-tab').click()
  await expect(page.getByTestId('git-tab-panel')).toBeVisible()
  await expect(page.getByTestId('git-settings-form')).toBeVisible()

  await page.getByTestId('project-connection-custom').click()
  await expect(page.getByTestId('git-repo-pane')).toBeVisible()
  await expect(page.getByTestId('git-fetch-remote')).toBeVisible()
  await expect(page.getByTestId('git-pull-remote')).toBeVisible()

  await closeAndDeleteProject(page, projectName)
})
