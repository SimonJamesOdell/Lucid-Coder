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

test('branch tab clears staged files individually and in bulk', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Clear Staged ${Date.now()}`
  let stagedFiles = [
    { path: 'src/App.jsx', source: 'editor', timestamp: '2026-02-03T00:00:00.000Z' },
    { path: 'src/Utils.js', source: 'editor', timestamp: '2026-02-03T00:00:01.000Z' }
  ]

  const buildOverview = () => ({
    success: true,
    current: 'feature/clear',
    branches: [
      { name: 'main', status: 'active', isCurrent: false },
      { name: 'feature/clear', status: 'active', isCurrent: true }
    ],
    workingBranches: [
      {
        name: 'feature/clear',
        status: 'active',
        lastTestStatus: null,
        stagedFiles
      }
    ]
  })

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.route('**/api/projects/*/branches', async (route) => {
    const { pathname } = new URL(route.request().url())
    if (/\/api\/projects\/[^/]+\/branches$/.test(pathname)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildOverview())
      })
      return
    }

    await route.fallback()
  })

  await page.route('**/api/projects/*/branches/stage', async (route) => {
    if (route.request().method() !== 'DELETE') {
      await route.fallback()
      return
    }

    const payload = route.request().postDataJSON?.() || {}
    if (payload.filePath) {
      stagedFiles = stagedFiles.filter((file) => file.path !== payload.filePath)
    } else {
      stagedFiles = []
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, overview: buildOverview() })
    })
  })

  await createProject(page, projectName, 'Branch clear staged flow')

  await page.getByTestId('branch-tab').click()
  await expect(page.getByTestId('branch-file-list')).toBeVisible()

  await page.getByTestId('branch-file-clear-src-app-jsx').click()
  await expect(page.getByTestId('branch-file-list')).toBeVisible()

  await page.getByTestId('clear-staged-inline').click()
  await expect(page.getByTestId('branch-no-files')).toBeVisible()

  await closeAndDeleteProject(page, projectName)
})
