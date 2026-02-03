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

test('runs detail reloads after a failed request', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Runs Detail Retry ${Date.now()}`
  const detailCalls = new Map()

  const runsPayload = {
    runs: [
      { id: 101, kind: 'build', status: 'failed', statusMessage: 'Build Project', startedAt: '2026-02-03T00:00:00.000Z' },
      { id: 102, kind: 'deploy', status: 'completed', statusMessage: 'Deploy Project', startedAt: '2026-02-03T01:00:00.000Z' }
    ]
  }

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.route('**/api/projects/*/runs', async (route) => {
    const { pathname } = new URL(route.request().url())
    if (/\/api\/projects\/[^/]+\/runs$/.test(pathname)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(runsPayload)
      })
      return
    }

    const match = pathname.match(/\/api\/projects\/[^/]+\/runs\/(\d+)/)
    if (match) {
      const runId = Number.parseInt(match[1], 10)
      const count = detailCalls.get(runId) || 0
      detailCalls.set(runId, count + 1)

      if (runId === 101 && count === 0) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Detail exploded' })
        })
        return
      }

      const run = runsPayload.runs.find((entry) => entry.id === runId)
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ run, events: [] })
      })
      return
    }

    await route.fallback()
  })

  await createProject(page, projectName, 'Runs detail retry')

  await page.getByTestId('runs-tab').click()
  await page.getByTestId('run-row-101').click()

  await expect(page.getByTestId('runs-error')).toBeVisible()
  await expect(page.getByTestId('runs-detail-missing')).toBeVisible()

  await page.getByTestId('run-row-102').click()
  await expect(page.getByTestId('runs-detail-title')).toHaveText('Deploy Project')

  await page.getByTestId('run-row-101').click()
  await expect(page.getByTestId('runs-detail-title')).toHaveText('Build Project')

  await closeAndDeleteProject(page, projectName)
})
