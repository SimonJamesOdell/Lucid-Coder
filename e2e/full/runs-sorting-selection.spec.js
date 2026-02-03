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

test('runs list sorts by id and keeps selection after refresh', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Runs Sorting ${Date.now()}`
  let runsCalls = 0

  const buildRunsPayload = () => {
    runsCalls += 1
    if (runsCalls === 1) {
      return {
        runs: [
          { id: 201, kind: 'build', status: 'completed', statusMessage: 'Build Project', startedAt: '2026-02-03T00:00:00.000Z' },
          { id: 202, kind: 'deploy', status: 'failed', statusMessage: 'Deploy Project', startedAt: '2026-02-03T01:00:00.000Z' }
        ]
      }
    }

    return {
      runs: [
        { id: 202, kind: 'deploy', status: 'failed', statusMessage: 'Deploy Project', startedAt: '2026-02-03T01:00:00.000Z' },
        { id: 201, kind: 'build', status: 'completed', statusMessage: 'Build Project', startedAt: '2026-02-03T00:00:00.000Z' }
      ]
    }
  }

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.route('**/api/projects/*/runs', async (route) => {
    const { pathname } = new URL(route.request().url())
    if (/\/api\/projects\/[^/]+\/runs$/.test(pathname)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildRunsPayload())
      })
      return
    }

    const match = pathname.match(/\/api\/projects\/[^/]+\/runs\/(\d+)/)
    if (match) {
      const runId = Number.parseInt(match[1], 10)
      const run = buildRunsPayload().runs.find((entry) => entry.id === runId)
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ run, events: [] })
      })
      return
    }

    await route.fallback()
  })

  await createProject(page, projectName, 'Runs sorting flow')

  await page.getByTestId('runs-tab').click()
  await expect(page.getByTestId('runs-list')).toBeVisible()

  const firstRunTestId = await page.getByTestId('runs-list').locator('button').first().getAttribute('data-testid')
  expect(firstRunTestId).toBe('run-row-202')

  await page.getByTestId('run-row-201').click()
  await expect(page.getByTestId('runs-detail-title')).toHaveText('Build Project')

  await page.getByTestId('runs-refresh').click()
  await expect(page.getByTestId('runs-detail-title')).toHaveText('Build Project')

  await closeAndDeleteProject(page, projectName)
})
