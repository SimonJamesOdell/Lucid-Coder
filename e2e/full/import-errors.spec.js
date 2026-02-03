const { test, expect } = require('@playwright/test')
const { ensureBootstrapped } = require('../e2e-utils')

test('import wizard surfaces local validation and scan errors', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.route('**/api/fs/detect-tech**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'Detect tech failed' })
    })
  })

  await page.route('**/api/fs/compatibility**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'Compatibility scan failed' })
    })
  })

  await page.getByRole('button', { name: 'Import Project' }).click()
  await expect(page.getByRole('heading', { name: 'Import Existing Project' })).toBeVisible()

  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(page.getByText('Project path is required')).toBeVisible()

  await page.getByLabel('Project Folder Path *').fill('C:/Projects/demo')
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByLabel('Project Name *').fill('Import Errors Demo')
  await page.getByRole('button', { name: 'Next' }).click()

  await expect(page.getByText('Detect tech failed')).toBeVisible()

  await page.getByRole('button', { name: 'Next' }).click()
  await expect(page.getByText('Compatibility scan failed')).toBeVisible()

  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByText('Select Project')).toBeVisible({ timeout: 30_000 })
})
