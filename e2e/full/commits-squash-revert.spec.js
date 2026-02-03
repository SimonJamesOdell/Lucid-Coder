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

test('commits tab supports squashing and shows revert errors', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Commits Squash ${Date.now()}`
  const commits = [
    {
      sha: 'aaa111111111',
      shortSha: 'aaa1111',
      message: 'Add feature',
      author: { name: 'Demo Dev' },
      authoredAt: '2026-02-03T10:00:00.000Z',
      canRevert: true
    },
    {
      sha: 'bbb222222222',
      shortSha: 'bbb2222',
      message: 'Fix bug',
      author: { name: 'Demo Dev' },
      authoredAt: '2026-02-03T09:00:00.000Z',
      canRevert: true
    }
  ]

  let commitList = [...commits]

  const commitDetails = {
    aaa111111111: {
      sha: 'aaa111111111',
      shortSha: 'aaa1111',
      message: 'Add feature',
      body: 'Add feature body',
      author: { name: 'Demo Dev' },
      authoredAt: '2026-02-03T10:00:00.000Z',
      files: [{ path: 'src/App.jsx', status: 'M' }]
    },
    bbb222222222: {
      sha: 'bbb222222222',
      shortSha: 'bbb2222',
      message: 'Fix bug',
      body: 'Fix bug body',
      author: { name: 'Demo Dev' },
      authoredAt: '2026-02-03T09:00:00.000Z',
      files: [{ path: 'src/App.jsx', status: 'M' }]
    },
    ccc333333333: {
      sha: 'ccc333333333',
      shortSha: 'ccc3333',
      message: 'Squashed commit',
      body: 'Squashed commit body',
      author: { name: 'Demo Dev' },
      authoredAt: '2026-02-03T11:00:00.000Z',
      files: [{ path: 'src/App.jsx', status: 'M' }]
    }
  }

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.route('**/api/projects/*/commits**', async (route) => {
    const { pathname } = new URL(route.request().url())
    const method = route.request().method()

    if (method === 'GET' && /\/api\/projects\/[^/]+\/commits$/.test(pathname)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, commits: commitList })
      })
      return
    }

    if (method === 'GET' && /\/api\/projects\/[^/]+\/commits\/[^/]+$/.test(pathname)) {
      const sha = pathname.split('/').pop()
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, commit: commitDetails[sha] })
      })
      return
    }

    if (method === 'POST' && /\/api\/projects\/[^/]+\/commits\/squash$/.test(pathname)) {
      commitList = [
        {
          sha: 'ccc333333333',
          shortSha: 'ccc3333',
          message: 'Squashed commit',
          author: { name: 'Demo Dev' },
          authoredAt: '2026-02-03T11:00:00.000Z',
          canRevert: true
        }
      ]
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          squashed: { newSha: 'ccc333333333' },
          commits: commitList
        })
      })
      return
    }

    if (method === 'POST' && /\/api\/projects\/[^/]+\/commits\/[^/]+\/revert$/.test(pathname)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Revert blocked' })
      })
      return
    }

    await route.fallback()
  })

  await createProject(page, projectName, 'Commits squash flow')

  await page.getByTestId('commits-tab').click()
  await expect(page.getByTestId('commit-aaa1111')).toBeVisible()

  await page.getByTestId('commit-squash-select-aaa1111').click()
  await page.getByTestId('commit-squash-select-bbb2222').click()
  await page.getByTestId('commit-squash-action').click()
  await expect(page.getByTestId('modal-content')).toBeVisible()
  await page.getByTestId('modal-confirm').click()

  await expect(page.getByText('Squashed commits')).toBeVisible()
  await expect(page.getByTestId('commit-ccc3333')).toBeVisible()

  await page.getByTestId('commit-ccc3333').click()
  await page.getByTestId('commit-revert').click()
  await expect(page.getByTestId('modal-content')).toBeVisible()
  await page.getByTestId('modal-confirm').click()

  await expect(page.getByText('Revert blocked')).toBeVisible()

  await closeAndDeleteProject(page, projectName)
})
