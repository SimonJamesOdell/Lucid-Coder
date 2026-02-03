const { test, expect } = require('@playwright/test')
const { ensureBootstrapped } = require('../e2e-utils')

test('import wizard enforces git URL and consent gating', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.getByRole('button', { name: 'Import Project' }).click()
  await expect(page.getByRole('heading', { name: 'Import Existing Project' })).toBeVisible()

  await page.getByRole('tab', { name: 'GitHub / GitLab' }).click()
  await page.getByRole('button', { name: 'Next' }).click()

  await page.getByRole('button', { name: 'Next' }).click()
  await expect(page.getByText('Git repository URL is required')).toBeVisible()

  await page.getByLabel('Git Repository URL *').fill('https://github.com/acme/sample.git')
  await page.getByRole('button', { name: 'Next' }).click()

  const nameInput = page.getByLabel('Project Name *')
  if (!(await nameInput.inputValue())) {
    await nameInput.fill('Sample Import')
  }

  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('button', { name: 'Next' }).click()

  await page.getByRole('button', { name: 'Next' }).click()
  const importButton = page.getByRole('button', { name: 'Import Project' })
  await expect(importButton).toBeDisabled()

  await page.getByRole('button', { name: 'Back' }).click()
  await page.getByLabel('Allow compatibility updates').check()
  await page.getByLabel('Move frontend files into a frontend folder').check()

  await page.getByRole('button', { name: 'Next' }).click()
  await expect(importButton).toBeEnabled()

  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByText('Select Project')).toBeVisible({ timeout: 30_000 })
})
