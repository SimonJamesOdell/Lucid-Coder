const { test, expect } = require('@playwright/test')
const { ensureBootstrapped } = require('../e2e-utils')

test('llm configuration edits persist', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  await page.route('**/api/llm/test', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        model: 'llama3.1',
        responseTime: 42,
        message: 'Configuration test successful'
      })
    })
  })

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Configure LLM' }).click()
  await expect(page.getByTestId('llm-config-modal')).toBeVisible()

  const changeConfig = page.getByRole('button', { name: 'Change configuration' })
  if (await changeConfig.count()) {
    await changeConfig.click()
  }

  await page.getByLabel('Provider').selectOption('ollama')
  await page.locator('#model-select').selectOption('llama3.1')

  await page.getByRole('button', { name: 'Test & Save' }).click()
  await expect(page.locator('[data-testid="llm-config-modal"]')).toHaveCount(0)

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Configure LLM' }).click()
  await expect(page.getByTestId('llm-config-modal')).toBeVisible()

  const changeConfigAfter = page.getByRole('button', { name: 'Change configuration' })
  if (await changeConfigAfter.count()) {
    await changeConfigAfter.click()
  }

  await expect(page.locator('#provider-select')).toHaveValue('ollama')
  await expect(page.locator('#model-select')).toHaveValue('llama3.1')
})
