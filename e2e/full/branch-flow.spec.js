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

test('branch flow supports creating, testing, and merging', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Branch Flow ${Date.now()}`
  let branchStage = 'initial'

  const buildOverview = () => {
    if (branchStage === 'created') {
      return {
        success: true,
        current: 'feature/e2e',
        branches: [
          { name: 'main', status: 'active', isCurrent: false },
          { name: 'feature/e2e', status: 'active', isCurrent: true, stagedFileCount: 1 }
        ],
        workingBranches: [
          {
            name: 'feature/e2e',
            status: 'active',
            lastTestStatus: null,
            testsRequired: true,
            stagedFiles: [{ path: 'src/App.jsx', source: 'editor', timestamp: '2026-02-03T00:00:00.000Z' }]
          }
        ]
      }
    }

    if (branchStage === 'tested') {
      return {
        success: true,
        current: 'feature/e2e',
        branches: [
          { name: 'main', status: 'active', isCurrent: false },
          { name: 'feature/e2e', status: 'ready-for-merge', isCurrent: true, stagedFileCount: 0 }
        ],
        workingBranches: [
          {
            name: 'feature/e2e',
            status: 'ready-for-merge',
            lastTestStatus: 'passed',
            testsRequired: true,
            stagedFiles: []
          }
        ]
      }
    }

    if (branchStage === 'merged') {
      return {
        success: true,
        current: 'main',
        branches: [
          { name: 'main', status: 'active', isCurrent: true },
          { name: 'feature/e2e', status: 'merged', isCurrent: false }
        ],
        workingBranches: []
      }
    }

    return {
      success: true,
      current: 'main',
      branches: [{ name: 'main', status: 'active', isCurrent: true }],
      workingBranches: []
    }
  }

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.route('**/api/projects/*/branches', async (route) => {
    const { pathname } = new URL(route.request().url())
    const method = route.request().method()

    if (method === 'GET' && /\/api\/projects\/[^/]+\/branches$/.test(pathname)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildOverview())
      })
      return
    }

    if (method === 'POST' && /\/api\/projects\/[^/]+\/branches$/.test(pathname)) {
      branchStage = 'created'
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          branch: { name: 'feature/e2e' },
          overview: buildOverview()
        })
      })
      return
    }

    await route.fallback()
  })

  await page.route('**/api/projects/*/branches/*/tests', async (route) => {
    branchStage = 'tested'
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, testRun: { status: 'passed' } })
    })
  })

  await page.route('**/api/projects/*/branches/*/merge', async (route) => {
    branchStage = 'merged'
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, overview: buildOverview() })
    })
  })

  await createProject(page, projectName, 'Branch flow')

  await page.getByTestId('branch-tab').click()
  await expect(page.getByTestId('branch-list')).toBeVisible()

  await page.getByTestId('branch-create').click()
  await expect(page.getByTestId('branch-create-modal')).toBeVisible()
  await page.getByTestId('branch-modal-name').fill('feature/e2e')
  await page.getByTestId('branch-modal-description').fill('E2E branch flow')
  await page.getByTestId('branch-modal-submit').click()

  const branchItem = page.getByTestId('branch-list-item-feature-e2e')
  await expect(branchItem).toBeVisible()
  await expect(branchItem).toContainText('1 staged file')

  await expect(page.getByTestId('branch-file-list')).toBeVisible()
  await page.getByTestId('branch-begin-testing').click()

  await expect(page.getByTestId('branch-merge')).toBeVisible()
  await page.getByTestId('branch-merge').click()

  await expect(page.getByTestId('branch-list-item-feature-e2e')).toContainText('Merged')

  await closeAndDeleteProject(page, projectName)
})
