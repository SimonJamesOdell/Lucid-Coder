const { test, expect } = require('@playwright/test')

const BACKEND_URL = process.env.E2E_BACKEND_URL || 'http://localhost:5000'

const ensureBootstrapped = async ({ request }) => {
  // Configure an API-key-less provider so the UI can proceed without manual setup.
  // Backend readiness only checks presence of model + api_url for providers like ollama.
  await request.post(`${BACKEND_URL}/api/llm/configure`, {
    data: {
      provider: 'ollama',
      model: 'llama3',
      api_url: 'http://localhost:11434/v1'
    }
  })
}

test('app loads and reaches project selection', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  await page.goto('/')

  // Give the app time to do initial health + status checks.
  await expect(page.getByText('Select Project')).toBeVisible()
})

test('can open create project modal', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.getByRole('button', { name: 'Create New Project' }).click()
  await expect(page.getByRole('heading', { name: 'Create New Project' })).toBeVisible()
})
