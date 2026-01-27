const { test, expect } = require('@playwright/test')

const BACKEND_URL = process.env.E2E_BACKEND_URL || 'http://localhost:5000'

const ensureBootstrapped = async ({ request }) => {
  // Configure an API-key-less provider so the UI can proceed without manual setup.
  // Backend readiness only checks presence of model + api_url for providers like ollama.
  const response = await request.post(`${BACKEND_URL}/api/llm/configure`, {
    data: {
      provider: 'ollama',
      model: 'llama3',
      apiUrl: 'http://localhost:11434/v1'
    }
  })

  if (!response.ok()) {
    const bodyText = await response.text().catch(() => '')
    throw new Error(`Failed to bootstrap LLM config: ${response.status()} ${bodyText}`)
  }
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

test('can create a project and reach main view', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Project ${Date.now()}`

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.getByRole('button', { name: 'Create New Project' }).click()
  await expect(page.getByRole('heading', { name: 'Create New Project' })).toBeVisible()

  await page.getByLabel('Project Name *').fill(projectName)
  await page.getByLabel('Description').fill('Created by Playwright E2E')
  await page.getByRole('button', { name: 'Create Project' }).click()

  // CreateProject shows a progress UI briefly and then returns to the main view.
  await expect(page.getByTestId('close-project-button')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(projectName)).toBeVisible()
})

test('can import a project and reach main view', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Import ${Date.now()}`

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.getByRole('button', { name: 'Import Project' }).click()
  await expect(page.getByRole('heading', { name: 'Import Existing Project' })).toBeVisible()

  const gitMethod = page.locator('label.import-method', { hasText: 'Git Repository' })
  await gitMethod.click({ force: true })
  await expect(page.getByRole('radio', { name: /Git Repository/i })).toBeChecked()
  await page.getByLabel('Git Repository URL *').fill('https://example.com/repo.git')
  await page.getByLabel('Project Name *').fill(projectName)
  await page.getByLabel('Description').fill('Imported by Playwright E2E')

  await page.getByRole('button', { name: 'Import Project' }).click()

  await expect(page.getByTestId('close-project-button')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(projectName)).toBeVisible()
})

test('closing a project returns to project selector', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Close ${Date.now()}`

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.getByRole('button', { name: 'Create New Project' }).click()
  await expect(page.getByRole('heading', { name: 'Create New Project' })).toBeVisible()

  await page.getByLabel('Project Name *').fill(projectName)
  await page.getByRole('button', { name: 'Create Project' }).click()

  await expect(page.getByTestId('close-project-button')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('close-project-button').click()

  await expect(page.getByText('Select Project')).toBeVisible({ timeout: 30_000 })
})

test('can delete a project from the selector', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Delete ${Date.now()}`

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  // Create a project.
  await page.getByRole('button', { name: 'Create New Project' }).click()
  await expect(page.getByRole('heading', { name: 'Create New Project' })).toBeVisible()

  await page.getByLabel('Project Name *').fill(projectName)
  await page.getByRole('button', { name: 'Create Project' }).click()
  await expect(page.getByTestId('close-project-button')).toBeVisible({ timeout: 30_000 })

  // Return to selector.
  await page.getByTestId('close-project-button').click()
  await expect(page.getByText('Select Project')).toBeVisible({ timeout: 30_000 })

  const projectCard = page.locator('.project-card', { hasText: projectName })
  await expect(projectCard).toBeVisible()

  await projectCard.getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByTestId('modal-content')).toBeVisible()
  await expect(page.getByText('Delete Project')).toBeVisible()
  await page.getByTestId('modal-confirm').click()

  await expect(projectCard).toHaveCount(0)
})
