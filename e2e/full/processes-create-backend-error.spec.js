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

test('processes tab shows create backend errors', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Backend Error ${Date.now()}`
  const processSnapshot = {
    success: true,
    processes: {
      frontend: { status: 'running', pid: 1234, port: 5173, lastHeartbeat: '2026-02-03T00:00:00.000Z', logs: [] },
      backend: null
    },
    ports: {
      active: { frontend: 5173, backend: null },
      stored: { frontend: 5173, backend: null },
      preferred: { frontend: 5173, backend: null }
    },
    capabilities: { backend: { exists: false } }
  }

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.route('**/api/projects/*/start', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ processes: processSnapshot })
    })
  })

  await page.route('**/api/projects/*/processes', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(processSnapshot)
    })
  })

  await page.route('**/api/projects/*/backend/create', async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'Backend create failed.' })
    })
  })

  await createProject(page, projectName, 'Processes backend error')

  await page.getByRole('button', { name: 'Processes' }).click()
  await expect(page.getByTestId('process-create-backend')).toBeVisible()

  await page.getByTestId('process-create-backend').click()
  await expect(page.getByText('Backend create failed.')).toBeVisible()

  await closeAndDeleteProject(page, projectName)
})
