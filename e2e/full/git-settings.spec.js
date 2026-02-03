const { test, expect } = require('@playwright/test')
const { ensureBootstrapped } = require('../e2e-utils')

test('git settings save and reopen', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Configure Git' }).click()
  await expect(page.getByTestId('git-settings-modal')).toBeVisible()

  await page.getByTestId('git-workflow-cloud').click()
  await page.getByTestId('git-provider-select').selectOption('github')
  await page.getByTestId('git-token').fill('e2e-token-123')
  await page.getByTestId('git-token-expiry').fill('2099-12-31')
  await page.getByTestId('git-default-branch').fill('release')

  await page.getByTestId('git-save-button').click()
  await expect(page.locator('[data-testid="git-settings-modal"]')).toHaveCount(0)

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Configure Git' }).click()
  await expect(page.getByTestId('git-settings-modal')).toBeVisible()

  await expect(page.getByTestId('git-workflow-cloud')).toBeChecked()
  await expect(page.getByTestId('git-provider-select')).toHaveValue('github')
  await expect(page.getByTestId('git-default-branch')).toHaveValue('release')
})
