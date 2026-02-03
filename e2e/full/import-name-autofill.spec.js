const { test, expect } = require('@playwright/test')
const { ensureBootstrapped } = require('../e2e-utils')

test('import wizard auto-fills project name from git url and resets on tab change', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.getByRole('button', { name: 'Import Project' }).click()
  await expect(page.getByRole('heading', { name: 'Import Existing Project' })).toBeVisible()

  await page.getByRole('tab', { name: 'GitHub / GitLab' }).click()
  await page.getByRole('button', { name: 'Next' }).click()

  await page.getByLabel('Git Repository URL *').fill('https://github.com/acme/alpha-project.git')
  await page.getByRole('button', { name: 'Next' }).click()

  await expect(page.getByLabel('Project Name *')).toHaveValue('alpha-project')

  await page.getByRole('button', { name: 'Back' }).click()
  await page.getByRole('button', { name: 'Back' }).click()

  await page.getByRole('tab', { name: 'Local Folder' }).click()
  await page.getByRole('button', { name: 'Next' }).click()
  await page.getByLabel('Project Folder Path *').fill('C:/Projects/beta-app')
  await page.getByRole('button', { name: 'Next' }).click()

  await expect(page.getByLabel('Project Name *')).toHaveValue('beta-app')

  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByText('Select Project')).toBeVisible({ timeout: 30_000 })
})
