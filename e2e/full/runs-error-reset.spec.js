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

test('runs error banner clears when switching to a healthy run', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Runs Error Reset ${Date.now()}`
  const runsPayload = {
    runs: [
      { id: 301, kind: 'build', status: 'failed', statusMessage: 'Build Project', startedAt: '2026-02-03T00:00:00.000Z' },
      { id: 302, kind: 'deploy', status: 'completed', statusMessage: 'Deploy Project', startedAt: '2026-02-03T01:00:00.000Z' }
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
      if (runId === 301) {
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

  await createProject(page, projectName, 'Runs error reset')

  await page.getByTestId('runs-tab').click()
  await page.getByTestId('run-row-301').click()

  await expect(page.getByTestId('runs-error')).toBeVisible()

  await page.getByTestId('run-row-302').click()
  await expect(page.getByTestId('runs-detail-title')).toHaveText('Deploy Project')
  await expect(page.getByTestId('runs-error')).toHaveCount(0)

  await closeAndDeleteProject(page, projectName)
})
