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

test('process actions update status across refresh, restart, and stop', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Processes Actions ${Date.now()}`
  const processState = {
    frontend: {
      status: 'running',
      pid: 1111,
      port: 5173,
      lastHeartbeat: '2026-01-20T10:00:00.000Z',
      logs: []
    },
    backend: {
      status: 'running',
      pid: 2222,
      port: 6500,
      lastHeartbeat: '2026-01-20T10:00:05.000Z',
      logs: []
    }
  }

  const buildProcessResponse = () => ({
    success: true,
    processes: processState,
    ports: {
      active: { frontend: 5173, backend: 6500 },
      stored: { frontend: 5173, backend: 6500 },
      preferred: { frontend: 5173, backend: 6500 }
    },
    capabilities: { backend: { exists: true } }
  })

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.route('**/api/projects/*/start', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildProcessResponse())
      })
      return
    }

    await route.fallback()
  })

  await page.route('**/api/projects/*/processes', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(buildProcessResponse())
    })
  })

  await page.route('**/api/projects/*/restart?target=*', async (route) => {
    const { searchParams } = new URL(route.request().url())
    const target = searchParams.get('target')
    if (target && processState[target]) {
      processState[target] = {
        ...processState[target],
        status: 'running',
        lastHeartbeat: '2026-01-20T10:01:00.000Z'
      }
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, processes: processState })
    })
  })

  await page.route('**/api/projects/*/stop?target=*', async (route) => {
    const { searchParams } = new URL(route.request().url())
    const target = searchParams.get('target')
    if (target && processState[target]) {
      processState[target] = {
        status: 'idle',
        pid: null,
        port: null,
        lastHeartbeat: null,
        logs: []
      }
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true })
    })
  })

  await createProject(page, projectName, 'Process actions flow')

  await page.getByRole('button', { name: 'Processes' }).click()
  await expect(page.getByTestId('process-column-frontend')).toBeVisible()

  await page.getByTestId('process-restart-frontend').click()
  await expect(page.getByTestId('process-restart-frontend')).toBeEnabled()

  await page.getByTestId('process-stop-backend').click()
  await expect(page.getByTestId('process-column-backend').getByText('idle')).toBeVisible()
  await expect(page.getByTestId('process-stop-backend')).toBeDisabled()

  await closeAndDeleteProject(page, projectName)
})
