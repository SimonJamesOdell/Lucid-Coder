const { test, expect } = require('@playwright/test')
const { ensureBootstrapped } = require('../e2e-utils')

test('llm config modal shows API key validation errors', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Configure LLM' }).click()
  await expect(page.getByTestId('llm-config-modal')).toBeVisible()

  const changeConfig = page.getByRole('button', { name: 'Change configuration' })
  if (await changeConfig.count()) {
    await changeConfig.click()
  }

  await page.getByLabel('Provider').selectOption('openai')
  await page.getByRole('button', { name: 'Test & Save' }).click()

  await expect(page.getByText('Please enter an API key')).toBeVisible()
})
