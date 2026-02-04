const { test, expect } = require('@playwright/test')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { ensureBootstrapped } = require('./e2e-utils')

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
  await page.getByLabel('Git Workflow *').selectOption('local')
  await page.getByRole('button', { name: 'Create Project', exact: true }).click()

  // CreateProject shows a progress UI briefly and then returns to the main view.
  await expect(page.getByTestId('close-project-button')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(projectName)).toBeVisible()
})

test('can import a project and reach main view', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Import ${Date.now()}`
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lucidcoder-e2e-import-'))
  try {
    fs.writeFileSync(
      path.join(localRoot, 'package.json'),
      JSON.stringify({ name: 'e2e-import', scripts: { dev: 'vite --host 0.0.0.0' }, dependencies: { vite: '^5.0.0' } })
    )

    await page.goto('/')
    await expect(page.getByText('Select Project')).toBeVisible()

    await page.getByRole('button', { name: 'Import Project' }).click()
    await expect(page.getByRole('heading', { name: 'Import Existing Project' })).toBeVisible()

    await page.getByRole('button', { name: 'Next' }).click()
    await page.getByLabel('Project Folder Path *').fill(localRoot)
    await page.getByRole('button', { name: 'Next' }).click()
    await page.getByLabel('Project Name *').fill(projectName)
    await page.getByLabel('Description').fill('Imported by Playwright E2E')
    await page.getByRole('button', { name: 'Next' }).click()
    await page.getByRole('button', { name: 'Next' }).click()
    await page.getByText('Allow compatibility updates').click()
    await page.getByText('Move frontend files into a frontend folder').click()

    await page.getByRole('button', { name: 'Next' }).click()
    await page.getByRole('button', { name: 'Import Project', exact: true }).click()

    await expect(page.getByTestId('close-project-button')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(projectName)).toBeVisible()
  } finally {
    fs.rmSync(localRoot, { recursive: true, force: true })
  }
})

test('closing a project returns to project selector', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Close ${Date.now()}`

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.getByRole('button', { name: 'Create New Project' }).click()
  await expect(page.getByRole('heading', { name: 'Create New Project' })).toBeVisible()

  await page.getByLabel('Project Name *').fill(projectName)
  await page.getByLabel('Git Workflow *').selectOption('local')
  await page.getByRole('button', { name: 'Create Project', exact: true }).click()

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
  await page.getByLabel('Git Workflow *').selectOption('local')
  await page.getByRole('button', { name: 'Create Project', exact: true }).click()
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
