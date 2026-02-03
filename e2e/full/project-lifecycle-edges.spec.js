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

test('project lifecycle supports reopen and shutdown status', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Lifecycle ${Date.now()}`

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.route('**/api/projects/*/stop', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400))
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true })
    })
  })

  await createProject(page, projectName, 'Lifecycle edge flow')

  await page.getByTestId('close-project-button').click()
  await expect(page.getByTestId('shutdown-status')).toBeVisible()
  await expect(page.getByText('Select Project')).toBeVisible({ timeout: 30_000 })

  const projectCard = page.locator('.project-card', { hasText: projectName })
  await expect(projectCard).toBeVisible()
  await projectCard.click()

  await expect(page.getByTestId('close-project-button')).toBeVisible({ timeout: 60_000 })

  await page.reload()
  await expect(page.getByTestId('close-project-button')).toBeVisible({ timeout: 60_000 })

  await closeAndDeleteProject(page, projectName)
})
