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

test('autopilot controls render when a stored session is active', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  await page.addInitScript(() => {
    window.sessionStorage.setItem(
      'lucidcoder.autopilotSession',
      JSON.stringify({ sessionId: 'e2e-autopilot-1' })
    )
  })

  await page.route('**/api/agent/autopilot/sessions/**', async (route) => {
    const body = JSON.stringify({
      session: {
        id: 'e2e-autopilot-1',
        status: 'running',
        statusMessage: 'Running',
        events: []
      }
    })

    await route.fulfill({ status: 200, contentType: 'application/json', body })
  })

  const projectName = `E2E Autopilot ${Date.now()}`

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await createProject(page, projectName, 'Autopilot control flow')

  await expect(page.getByTestId('autopilot-control-stop')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('autopilot-control-pause')).toBeVisible()
  await expect(page.getByTestId('autopilot-control-change-direction')).toBeVisible()
  await expect(page.getByTestId('autopilot-control-undo-last-change')).toBeVisible()

  await closeAndDeleteProject(page, projectName)
})
