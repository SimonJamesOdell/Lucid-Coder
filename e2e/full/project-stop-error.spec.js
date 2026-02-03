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

test('closing a project shows shutdown error when stop fails', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Stop Error ${Date.now()}`

  await page.route('**/api/projects/*/stop', async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'Backend stop failed' })
    })
  })

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await createProject(page, projectName, 'Stop error flow')

  await page.getByTestId('close-project-button').click()

  await expect(page.getByTestId('shutdown-status')).toBeVisible()
  await expect(page.getByText('Stop failed: Backend stop failed')).toBeVisible()
  await expect(page.getByText('Select Project')).toBeVisible({ timeout: 30_000 })
})
