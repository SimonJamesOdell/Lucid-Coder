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

test('branch coverage gate clears after tests pass', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Coverage Gate ${Date.now()}`
  let hasPassed = false

  const buildOverview = () => ({
    success: true,
    current: 'feature/coverage-gate',
    branches: [
      { name: 'main', status: 'active', isCurrent: false },
      { name: 'feature/coverage-gate', status: hasPassed ? 'ready-for-merge' : 'needs-fix', isCurrent: true }
    ],
    workingBranches: [
      {
        name: 'feature/coverage-gate',
        status: hasPassed ? 'ready-for-merge' : 'needs-fix',
        lastTestStatus: hasPassed ? 'passed' : 'failed',
        testsRequired: true,
        mergeBlockedReason: hasPassed ? null : 'Coverage below threshold',
        stagedFiles: hasPassed
          ? []
          : [{ path: 'src/App.jsx', source: 'editor', timestamp: '2026-02-03T00:00:00.000Z' }]
      }
    ]
  })

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.route('**/api/projects/*/branches', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(buildOverview())
    })
  })

  await page.route('**/api/projects/*/branches/*/tests', async (route) => {
    hasPassed = true
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, testRun: { status: 'passed' } })
    })
  })

  await page.route('**/api/projects/*/branches/*/css-only', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ isCssOnly: false })
    })
  })

  await page.route('**/api/projects/*/branches/*/changed-files', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ files: [] })
    })
  })

  await createProject(page, projectName, 'Coverage gate flow')

  await page.getByTestId('branch-tab').click()
  await expect(page.getByTestId('branch-warning')).toContainText('Coverage below threshold')

  await page.getByTestId('branch-begin-testing').click()
  await page.getByTestId('branch-tab').click()

  await expect(page.getByTestId('branch-warning')).toHaveCount(0)
  await expect(page.getByTestId('branch-merge')).toBeVisible()

  await closeAndDeleteProject(page, projectName)
})
