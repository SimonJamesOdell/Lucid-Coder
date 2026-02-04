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

test('processes tab renders frontend and backend status cards', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Processes ${Date.now()}`

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await createProject(page, projectName, 'Processes tab flow')

  await page.getByRole('button', { name: 'Processes' }).click()
  await expect(page.locator('div.processes-tab[data-testid="processes-tab"]')).toBeVisible()
  await expect(page.getByTestId('process-column-frontend')).toBeVisible()
  await expect(page.getByTestId('process-logs-frontend')).toBeVisible()

  await expect(page.getByTestId('process-column-backend')).toBeVisible()

  const backendRefresh = page.getByTestId('process-refresh-backend')
  const backendCreate = page.getByTestId('process-create-backend')
  if (await backendRefresh.count()) {
    await expect(backendRefresh).toBeVisible()
  } else {
    await expect(backendCreate).toBeVisible()
  }

  await closeAndDeleteProject(page, projectName)
})
