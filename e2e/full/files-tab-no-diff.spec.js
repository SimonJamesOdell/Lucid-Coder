const { test, expect } = require('@playwright/test')
const { ensureBootstrapped } = require('../e2e-utils')

const createProject = async (page, projectName, description) => {
  await page.getByRole('button', { name: 'Create New Project' }).click()
  await expect(page.getByRole('heading', { name: 'Create New Project' })).toBeVisible()

  await page.getByLabel('Project Name *').fill(projectName)
  await page.getByLabel('Description').fill(description)
  await page.getByLabel('Git Workflow *').selectOption('local')
  await page.getByRole('button', { name: 'Create Project', exact: true }).click()

  await expect(page.getByTestId('close-project-button')).toBeVisible({ timeout: 60_000 })
}

const closeAndDeleteProject = async (page, projectName) => {
  await page.getByTestId('close-project-button').click()
  await expect(page.getByText('Select Project')).toBeVisible({ timeout: 30_000 })

  const projectCard = page.locator('.project-card', { hasText: projectName })
  await expect(projectCard).toBeVisible()

  await projectCard.getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByTestId('modal-content')).toBeVisible()
  await page.getByTestId('modal-confirm').click()

  await expect(projectCard).toHaveCount(0)
}

test('files tab shows no diff available when contents match', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Files No Diff ${Date.now()}`
  const fileTree = [{ type: 'file', name: 'README.md', path: 'README.md' }]

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.route('**/api/projects/*/files', async (route) => {
    const { pathname } = new URL(route.request().url())
    if (/\/api\/projects\/[^/]+\/files$/.test(pathname)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, files: fileTree })
      })
      return
    }

    await route.fallback()
  })

  await page.route('**/api/projects/*/files/**', async (route) => {
    const { pathname } = new URL(route.request().url())
    if (!/\/api\/projects\/[^/]+\/files\//.test(pathname)) {
      await route.fallback()
      return
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, content: 'same content' })
    })
  })

  await page.route('**/api/projects/*/files-diff-content/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        original: 'same content',
        modified: 'same content',
        originalLabel: 'head',
        modifiedLabel: 'staged'
      })
    })
  })

  await createProject(page, projectName, 'Files no diff')

  await page.getByTestId('files-tab').click()
  await expect(page.getByTestId('file-item-README.md')).toBeVisible()

  await page.getByTestId('file-item-README.md').click()
  await page.getByTestId('toggle-diff-button').click()

  await expect(page.getByText('No diff available.')).toBeVisible()

  await closeAndDeleteProject(page, projectName)
})
