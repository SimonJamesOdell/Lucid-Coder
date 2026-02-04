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

test('commits tab supports revert and opening files in the editor', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Commit Revert ${Date.now()}`
  const commits = [
    {
      sha: 'def987654321',
      shortSha: 'def9876',
      message: 'Add feature',
      author: { name: 'Demo Dev' },
      authoredAt: '2026-01-01T10:00:00.000Z',
      canRevert: true
    },
    {
      sha: 'abc123456789',
      shortSha: 'abc1234',
      message: 'Initial commit',
      author: { name: 'Demo Dev' },
      authoredAt: '2026-01-01T09:00:00.000Z',
      canRevert: false
    }
  ]

  const commitDetails = {
    sha: 'def987654321',
    shortSha: 'def9876',
    message: 'Add feature',
    body: 'Add feature body',
    author: { name: 'Demo Dev' },
    authoredAt: '2026-01-01T10:00:00.000Z',
    canRevert: true,
    files: [
      { path: 'src/App.jsx', status: 'M' },
      { path: 'README.md', status: 'A' }
    ]
  }

  const fileTree = [
    {
      type: 'folder',
      name: 'src',
      path: 'src',
      children: [
        { type: 'file', name: 'App.jsx', path: 'src/App.jsx' }
      ]
    },
    { type: 'file', name: 'README.md', path: 'README.md' }
  ]

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.route('**/api/projects/*/commits**', async (route) => {
    const { pathname } = new URL(route.request().url())
    const method = route.request().method()

    if (method === 'GET' && /\/api\/projects\/[^/]+\/commits$/.test(pathname)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, commits })
      })
      return
    }

    if (method === 'GET' && /\/api\/projects\/[^/]+\/commits\/[^/]+$/.test(pathname)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, commit: commitDetails })
      })
      return
    }

    if (method === 'POST' && /\/api\/projects\/[^/]+\/commits\/[^/]+\/revert$/.test(pathname)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          commits: commits.slice(1)
        })
      })
      return
    }

    if (method === 'GET' && /\/api\/projects\/[^/]+\/commits\/[^/]+\/files-diff-content\//.test(pathname)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          path: 'src/App.jsx',
          original: 'export const value = 1',
          modified: 'export const value = 2',
          originalLabel: 'def9876',
          modifiedLabel: 'def9876'
        })
      })
      return
    }

    await route.fallback()
  })

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
    if (/\/api\/projects\/[^/]+\/files\//.test(pathname)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, content: '// file content' })
      })
      return
    }

    await route.fallback()
  })

  await createProject(page, projectName, 'Commit revert and open file flow')

  await page.getByTestId('commits-tab').click()
  await expect(page.getByTestId('commits-tab-panel')).toBeVisible()
  await expect(page.getByTestId('commit-def9876')).toBeVisible()

  await page.getByTestId('commit-def9876').click()
  await expect(page.getByTestId('commit-files-list')).toBeVisible()

  await page.getByTestId('commit-file-open-0').click()

  await page.getByTestId('files-tab').click()
  await expect(page.getByTestId('file-tab-src/App.jsx')).toBeVisible()
  await expect(page.getByTestId('file-diff-panel')).toBeVisible()

  await page.getByTestId('commits-tab').click()
  await page.getByTestId('commit-revert').click()
  await expect(page.getByTestId('modal-content')).toBeVisible()
  await page.getByTestId('modal-confirm').click()

  await expect(page.getByText('Reverted def9876')).toBeVisible()

  await closeAndDeleteProject(page, projectName)
})
