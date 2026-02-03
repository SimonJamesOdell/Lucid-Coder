const { test, expect } = require('@playwright/test')
const { ensureBootstrapped } = require('../e2e-utils')

test('import wizard shows link mode guidance', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.getByRole('button', { name: 'Import Project' }).click()
  await expect(page.getByRole('heading', { name: 'Import Existing Project' })).toBeVisible()

  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByRole('radio', { name: /Link to existing folder/i }).click()

  await expect(page.getByText('Keep the project in place (must be inside the managed folder).')).toBeVisible()

  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByText('Select Project')).toBeVisible({ timeout: 30_000 })
})
