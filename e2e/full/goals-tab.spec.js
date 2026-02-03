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

test('goals tab groups current and past goals and clears them', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Goals Tab ${Date.now()}`
  const goals = [
    {
      id: 101,
      title: 'Build UI shell',
      status: 'implementing',
      lifecycleState: 'active',
      createdAt: '2026-02-02T00:00:00.000Z'
    },
    {
      id: 102,
      parentGoalId: 101,
      title: 'Add preview panel',
      status: 'ready',
      lifecycleState: 'active',
      createdAt: '2026-02-02T01:00:00.000Z'
    },
    {
      id: 201,
      title: 'Ship v1',
      status: 'ready',
      lifecycleState: 'merged',
      createdAt: '2026-02-01T00:00:00.000Z'
    },
    {
      id: 202,
      parentGoalId: 201,
      title: 'Write release notes',
      status: 'ready',
      lifecycleState: 'merged',
      createdAt: '2026-02-01T01:00:00.000Z'
    }
  ]
  let goalsCleared = false
  const deletedGoalIds = new Set()

  await page.route('**/api/goals**', async (route) => {
    const { pathname } = new URL(route.request().url())
    const method = route.request().method()

    if (method === 'GET' && pathname === '/api/goals') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ goals: goalsCleared ? [] : goals })
      })
      return
    }

    if (method === 'DELETE' && /^\/api\/goals\//.test(pathname)) {
      const goalId = Number(pathname.split('/').pop())
      if (goalId) {
        deletedGoalIds.add(goalId)
      }
      if (deletedGoalIds.has(101) && deletedGoalIds.has(201)) {
        goalsCleared = true
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true })
      })
      return
    }

    await route.fallback()
  })

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await createProject(page, projectName, 'Goals tab flow')

  await page.getByTestId('goals-tab').click()
  await expect(page.getByTestId('goals-tab')).toBeVisible()
  await expect(page.getByTestId('goals-modal-goal-101')).toBeVisible()

  await page.getByTestId('goals-tab-filter-past').click()
  await expect(page.getByTestId('goals-modal-goal-201')).toBeVisible()
  await expect(page.getByTestId('goals-past-toggle-201')).toBeVisible()

  await page.getByTestId('goals-past-toggle-201').click()
  await expect(page.getByTestId('goals-modal-goal-202')).toBeVisible()

  await expect(page.getByTestId('goals-clear-goals')).toBeEnabled()
  await page.getByTestId('goals-clear-goals').click()
  await expect(page.getByTestId('modal-content')).toBeVisible()
  await page.getByTestId('modal-confirm').click()

  await expect(page.getByTestId('goals-tab-empty')).toBeVisible()

  await closeAndDeleteProject(page, projectName)
})
