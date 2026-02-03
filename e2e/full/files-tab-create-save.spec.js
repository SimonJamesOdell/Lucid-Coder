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

test('files tab supports creating, editing, saving, and staged diff views', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Files Tab ${Date.now()}`
  let fileTree = [
    { type: 'file', name: 'README.md', path: 'README.md' }
  ]

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

  await page.route('**/api/projects/*/files-ops/create-file', async (route) => {
    const payload = route.request().postDataJSON?.() || {}
    const filePath = payload.filePath || 'NewFile.jsx'
    const name = filePath.split('/').pop()
    if (!fileTree.some((item) => item.path === filePath)) {
      fileTree = [...fileTree, { type: 'file', name, path: filePath }]
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true })
    })
  })

  await page.route('**/api/projects/*/files/**', async (route) => {
    const { pathname } = new URL(route.request().url())
    const method = route.request().method()

    if (!/\/api\/projects\/[^/]+\/files\//.test(pathname)) {
      await route.fallback()
      return
    }

    if (method === 'PUT') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true })
      })
      return
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, content: '// file content' })
    })
  })

  await page.route('**/api/projects/*/files-diff-content/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        path: 'NewFile.jsx',
        original: '',
        modified: 'export const value = 1',
        originalLabel: 'head',
        modifiedLabel: 'staged'
      })
    })
  })

  await page.route('**/api/projects/*/branches/stage', async (route) => {
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        overview: {
          current: 'feature/files-tab',
          branches: [
            { name: 'main', status: 'active', isCurrent: false },
            { name: 'feature/files-tab', status: 'active', isCurrent: true }
          ],
          workingBranches: [
            {
              name: 'feature/files-tab',
              status: 'active',
              lastTestStatus: null,
              stagedFiles: [{ path: 'NewFile.jsx', source: 'editor', timestamp: '2026-02-03T00:00:00.000Z' }]
            }
          ]
        }
      })
    })
  })

  await createProject(page, projectName, 'Files tab flow')

  await page.getByTestId('files-tab').click()
  await expect(page.getByTestId('file-tree')).toBeVisible()

  page.once('dialog', (dialog) => dialog.accept('NewFile.jsx'))
  await page.getByTestId('file-tree-content').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Create file' }).click()

  await expect(page.getByTestId('file-item-NewFile.jsx')).toBeVisible()
  await page.getByTestId('file-item-NewFile.jsx').click()

  const editorInput = page.locator('.monaco-editor textarea').first()
  await editorInput.fill('export const value = 1')

  await expect(page.getByTestId('save-file-button')).toBeEnabled()
  await page.getByTestId('save-file-button').click()
  await expect(page.getByTestId('save-file-button')).toBeDisabled()

  await page.getByTestId('toggle-diff-button').click()
  await expect(page.getByTestId('file-diff-panel')).toBeVisible()

  await expect(page.getByTestId('staged-diff-button-NewFile.jsx')).toBeVisible()

  await closeAndDeleteProject(page, projectName)
})
