const { test, expect } = require('@playwright/test')
const { ensureBootstrapped } = require('../e2e-utils')

test('settings modals open and close', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Configure LLM' }).click()
  await expect(page.getByTestId('llm-config-modal')).toBeVisible()
  await page.getByTestId('llm-config-close').click()
  await expect(page.locator('[data-testid="llm-config-modal"]')).toHaveCount(0)

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Configure Git' }).click()
  await expect(page.getByTestId('git-settings-modal')).toBeVisible()
  await page.getByTestId('git-close-button').click()
  await expect(page.locator('[data-testid="git-settings-modal"]')).toHaveCount(0)

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Ports' }).click()
  await expect(page.getByTestId('port-settings-modal')).toBeVisible()
  await page.getByTestId('port-settings-close').click()
  await expect(page.locator('[data-testid="port-settings-modal"]')).toHaveCount(0)
})
