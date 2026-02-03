const { test, expect } = require('@playwright/test')
const { ensureBootstrapped } = require('../e2e-utils')

test('port settings modal shows validation errors', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Ports' }).click()

  await expect(page.getByTestId('port-settings-modal')).toBeVisible()

  await page.getByTestId('port-frontend-input').fill('6000')
  await page.getByTestId('port-backend-input').fill('6000')
  await page.getByTestId('port-settings-save').click()

  await expect(page.getByTestId('port-settings-error')).toBeVisible()
  await expect(page.getByTestId('port-settings-error')).toHaveText(
    'Frontend and backend port bases should differ to avoid collisions.'
  )
})
