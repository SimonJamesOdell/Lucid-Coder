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

test('git fetch and pull retry after error', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Git Retry ${Date.now()}`

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.route('**/api/settings/git', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          settings: { provider: 'github', defaultBranch: 'main', tokenPresent: false }
        })
      })
      return
    }

    await route.fallback()
  })

  await page.route('**/api/projects/*/git-settings', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          inheritsFromGlobal: true,
          effectiveSettings: {
            workflow: 'cloud',
            provider: 'github',
            remoteUrl: 'https://github.com/example/repo.git',
            defaultBranch: 'main'
          }
        })
      })
      return
    }

    await route.fallback()
  })

  await page.route('**/api/projects/*/git/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        status: { hasRemote: true, branch: 'main', ahead: 0, behind: 0 }
      })
    })
  })

  await page.route('**/api/projects/*/branches', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        current: 'main',
        branches: [{ name: 'main', status: 'active', isCurrent: true }],
        workingBranches: []
      })
    })
  })

  let fetchCount = 0
  await page.route('**/api/projects/*/git/fetch', async (route) => {
    fetchCount += 1
    if (fetchCount === 1) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Fetch failed.' })
      })
      return
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, status: { hasRemote: true } })
    })
  })

  let pullCount = 0
  await page.route('**/api/projects/*/git/pull', async (route) => {
    pullCount += 1
    if (pullCount === 1) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Pull failed.' })
      })
      return
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, status: { hasRemote: true }, strategy: 'ff-only' })
    })
  })

  await createProject(page, projectName, 'Git retry flow')

  await page.getByTestId('git-tab').click()
  await expect(page.getByTestId('git-tab-panel')).toBeVisible()

  await page.getByTestId('git-fetch-remote').click()
  await expect(page.getByText('Fetch failed.')).toBeVisible()

  await page.getByTestId('git-fetch-remote').click()
  await expect(page.getByText('Fetched latest from remote.')).toBeVisible()

  await page.getByTestId('git-pull-remote').click()
  await expect(page.getByText('Pull failed.')).toBeVisible()

  await page.getByTestId('git-pull-remote').click()
  await expect(page.getByText('Pulled with fast-forward.')).toBeVisible()

  await closeAndDeleteProject(page, projectName)
})

test('runs refresh recovers after failure', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Runs Retry ${Date.now()}`
  let runsCount = 0

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.route('**/api/projects/*/runs', async (route) => {
    const { pathname } = new URL(route.request().url())
    if (/\/api\/projects\/[^/]+\/runs$/.test(pathname)) {
      runsCount += 1
      if (runsCount === 1) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: 'Runs failed.' })
        })
        return
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ runs: [] })
      })
      return
    }

    await route.fallback()
  })

  await createProject(page, projectName, 'Runs retry flow')

  await page.getByTestId('runs-tab').click()
  await expect(page.getByTestId('runs-error')).toBeVisible()

  await page.getByTestId('runs-refresh').click()
  await expect(page.getByTestId('runs-none')).toBeVisible()

  await closeAndDeleteProject(page, projectName)
})

test('branch tests retry after failure', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Branch Retry ${Date.now()}`
  let hasPassed = false
  let testAttempts = 0

  const buildOverview = () => ({
    success: true,
    current: 'feature/coverage-retry',
    branches: [
      { name: 'main', status: 'active', isCurrent: false },
      { name: 'feature/coverage-retry', status: hasPassed ? 'ready-for-merge' : 'needs-fix', isCurrent: true }
    ],
    workingBranches: [
      {
        name: 'feature/coverage-retry',
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
    testAttempts += 1
    if (testAttempts === 1) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Tests failed.' })
      })
      return
    }

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

  await createProject(page, projectName, 'Branch retry flow')

  await page.getByTestId('branch-tab').click()
  await expect(page.getByTestId('branch-warning')).toContainText('Coverage below threshold')

  await page.getByTestId('branch-begin-testing').click()
  await expect(page.getByText('Tests failed.')).toBeVisible()

  await page.getByTestId('branch-begin-testing').click()
  await page.getByTestId('branch-tab').click()
  await expect(page.getByTestId('branch-merge')).toBeVisible()

  await closeAndDeleteProject(page, projectName)
})
