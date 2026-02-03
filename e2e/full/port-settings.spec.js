const { test, expect } = require('@playwright/test')
const { ensureBootstrapped } = require('../e2e-utils')

test('update default port settings', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Ports' }).click()
  await expect(page.getByTestId('port-settings-modal')).toBeVisible()

  await page.getByTestId('port-frontend-input').fill('6200')
  await page.getByTestId('port-backend-input').fill('6600')
  await page.getByTestId('port-settings-save').click()

  await expect(page.locator('[data-testid="port-settings-modal"]')).toHaveCount(0)

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Ports' }).click()
  await expect(page.getByTestId('port-settings-modal')).toBeVisible()

  await expect(page.getByTestId('port-frontend-input')).toHaveValue('6200')
  await expect(page.getByTestId('port-backend-input')).toHaveValue('6600')
})
