const { test, expect } = require('@playwright/test')
const { ensureBootstrapped } = require('../e2e-utils')

const createProject = async (page, projectName, description) => {
  await page.getByRole('button', { name: 'Create New Project' }).click()
  await expect(page.getByRole('heading', { name: 'Create New Project' })).toBeVisible()

  await page.getByLabel('Project Name *').fill(projectName)
  await page.getByLabel('Description').fill(description)
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

const routeFileTree = async (page, fileTree) => {
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
}

test('files tab cancels rename and duplicate prompts', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Files Cancel ${Date.now()}`
  const fileTree = [{ type: 'file', name: 'README.md', path: 'README.md' }]

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await routeFileTree(page, fileTree)

  await createProject(page, projectName, 'Files cancel flow')

  await page.getByTestId('files-tab').click()
  await expect(page.getByTestId('file-item-README.md')).toBeVisible()

  page.once('dialog', (dialog) => dialog.dismiss())
  await page.getByTestId('file-item-README.md').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  await expect(page.getByTestId('file-context-menu')).toHaveCount(0)

  page.once('dialog', (dialog) => dialog.dismiss())
  await page.getByTestId('file-item-README.md').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Duplicate' }).click()
  await expect(page.getByTestId('file-context-menu')).toHaveCount(0)

  await closeAndDeleteProject(page, projectName)
})

test('files tab surfaces rename and duplicate conflicts', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Files Conflict ${Date.now()}`
  const fileTree = [{ type: 'file', name: 'README.md', path: 'README.md' }]

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await routeFileTree(page, fileTree)

  await page.route('**/api/projects/*/files-ops/rename', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'File already exists' })
    })
  })

  await page.route('**/api/projects/*/files-ops/duplicate', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'Duplicate already exists' })
    })
  })

  await createProject(page, projectName, 'Files conflict flow')

  await page.getByTestId('files-tab').click()
  await expect(page.getByTestId('file-item-README.md')).toBeVisible()

  page.once('dialog', (dialog) => dialog.accept('README-copy.md'))
  await page.getByTestId('file-item-README.md').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  const renameAlert = await page.waitForEvent('dialog')
  expect(renameAlert.message()).toContain('File already exists')
  await renameAlert.accept()

  page.once('dialog', (dialog) => dialog.accept('README-duplicate.md'))
  await page.getByTestId('file-item-README.md').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Duplicate' }).click()
  const duplicateAlert = await page.waitForEvent('dialog')
  expect(duplicateAlert.message()).toContain('Duplicate already exists')
  await duplicateAlert.accept()

  await closeAndDeleteProject(page, projectName)
})

test('files tab canceling delete keeps file intact', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Files Delete Cancel ${Date.now()}`
  const fileTree = [{ type: 'file', name: 'README.md', path: 'README.md' }]
  let deleteCalled = false

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await routeFileTree(page, fileTree)

  await page.route('**/api/projects/*/files-ops/delete', async (route) => {
    deleteCalled = true
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true })
    })
  })

  await createProject(page, projectName, 'Files delete cancel flow')

  await page.getByTestId('files-tab').click()
  await expect(page.getByTestId('file-item-README.md')).toBeVisible()

  page.once('dialog', (dialog) => dialog.dismiss())
  await page.getByTestId('file-item-README.md').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete' }).click()

  await expect(page.getByTestId('file-item-README.md')).toBeVisible()
  expect(deleteCalled).toBe(false)

  await closeAndDeleteProject(page, projectName)
})

test('files tab delete errors surface alert messages', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Files Delete Error ${Date.now()}`
  const fileTree = [{ type: 'file', name: 'README.md', path: 'README.md' }]

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await routeFileTree(page, fileTree)

  await page.route('**/api/projects/*/files-ops/delete', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'Delete failed' })
    })
  })

  await createProject(page, projectName, 'Files delete error flow')

  await page.getByTestId('files-tab').click()
  await expect(page.getByTestId('file-item-README.md')).toBeVisible()

  page.once('dialog', (dialog) => dialog.accept())
  await page.getByTestId('file-item-README.md').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete' }).click()

  const alertDialog = await page.waitForEvent('dialog')
  expect(alertDialog.message()).toContain('Delete failed')
  await alertDialog.accept()

  await closeAndDeleteProject(page, projectName)
})
