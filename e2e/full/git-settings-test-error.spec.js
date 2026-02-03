const { test, expect } = require('@playwright/test')
const { ensureBootstrapped } = require('../e2e-utils')

test('git settings modal shows test connection errors', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  await page.route('**/api/settings/git', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          settings: { provider: 'github', defaultBranch: 'main', tokenPresent: false }
        })
      })
      return
    }

    await route.fallback()
  })

  await page.route('**/api/settings/git/test', async (route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'Token invalid' })
    })
  })

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Configure Git' }).click()
  await expect(page.getByTestId('git-settings-modal')).toBeVisible()

  await page.getByTestId('git-workflow-cloud').click()
  await page.getByTestId('git-test-connection').click()

  await expect(page.getByTestId('git-test-connection-status')).toBeVisible()
  await expect(page.getByTestId('git-test-connection-status')).toHaveText('Token invalid')
})
