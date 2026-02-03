const { test, expect } = require('@playwright/test')
const { ensureBootstrapped } = require('../e2e-utils')

test('import project validates git repository url', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.getByRole('button', { name: 'Import Project' }).click()
  await expect(page.getByRole('heading', { name: 'Import Existing Project' })).toBeVisible()

  await page.getByRole('tab', { name: 'GitHub / GitLab' }).click()
  await page.getByRole('button', { name: 'Next' }).click()

  await page.getByRole('button', { name: 'Next' }).click()
  await expect(page.getByText('Git repository URL is required')).toBeVisible()

  await page.getByLabel('Git Repository URL *').fill('https://github.com/example/repo.git')
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(page.getByLabel('Project Name *')).toBeVisible()

  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByText('Select Project')).toBeVisible({ timeout: 30_000 })
})
