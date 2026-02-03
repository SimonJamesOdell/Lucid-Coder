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

test('runs tab renders timeline events for a selected run', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Runs Timeline ${Date.now()}`

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.route('**/api/projects/*/runs', async (route) => {
    const { pathname } = new URL(route.request().url())
    if (/\/api\/projects\/[^/]+\/runs$/.test(pathname)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          runs: [
            {
              id: 17,
              kind: 'job',
              status: 'completed',
              statusMessage: 'Nightly build',
              createdAt: '2026-01-15T00:00:00.000Z',
              startedAt: '2026-01-15T00:00:01.000Z',
              finishedAt: '2026-01-15T00:01:05.000Z'
            }
          ]
        })
      })
      return
    }

    await route.fallback()
  })

  await page.route('**/api/projects/*/runs/*', async (route) => {
    const { pathname } = new URL(route.request().url())
    if (/\/api\/projects\/[^/]+\/runs\/[^/]+$/.test(pathname)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          run: {
            id: 17,
            kind: 'job',
            status: 'completed',
            statusMessage: 'Nightly build',
            startedAt: '2026-01-15T00:00:01.000Z',
            finishedAt: '2026-01-15T00:01:05.000Z'
          },
          events: [
            {
              id: 1,
              timestamp: '2026-01-15T00:00:02.000Z',
              type: 'job:start',
              message: 'Run started'
            },
            {
              id: 2,
              timestamp: '2026-01-15T00:01:04.000Z',
              type: 'job:end',
              message: 'Run finished'
            }
          ]
        })
      })
      return
    }

    await route.fallback()
  })

  await createProject(page, projectName, 'Runs timeline flow')

  await page.getByTestId('runs-tab').click()
  await expect(page.getByTestId('runs-tab-panel')).toBeVisible()

  await page.getByTestId('run-row-17').click()
  await expect(page.getByTestId('runs-detail-title')).toHaveText('Nightly build')
  await expect(page.getByTestId('runs-events-list')).toBeVisible()
  await expect(page.getByText('Run started')).toBeVisible()
  await expect(page.getByText('Run finished')).toBeVisible()

  await closeAndDeleteProject(page, projectName)
})
