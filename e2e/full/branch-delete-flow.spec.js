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

const buildOverview = (includeFeature = true) => ({
  success: true,
  current: includeFeature ? 'feature/delete' : 'main',
  branches: includeFeature
    ? [
        { name: 'main', status: 'active', isCurrent: false },
        { name: 'feature/delete', status: 'active', isCurrent: true }
      ]
    : [{ name: 'main', status: 'active', isCurrent: true }],
  workingBranches: includeFeature
    ? [
        {
          name: 'feature/delete',
          status: 'active',
          lastTestStatus: null,
          testsRequired: true,
          stagedFiles: []
        }
      ]
    : []
})

test('branch delete cancel leaves branch intact', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Branch Delete Cancel ${Date.now()}`
  let deleteCalled = false

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.route('**/api/projects/*/branches', async (route) => {
    const { pathname } = new URL(route.request().url())
    const method = route.request().method()

    if (method === 'GET' && /\/api\/projects\/[^/]+\/branches$/.test(pathname)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildOverview(true))
      })
      return
    }

    await route.fallback()
  })

  await page.route('**/api/projects/*/branches/*', async (route) => {
    if (route.request().method() === 'DELETE') {
      deleteCalled = true
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, overview: buildOverview(false) })
      })
      return
     }

     await route.fallback()
   })

  await createProject(page, projectName, 'Branch delete cancel flow')

  await page.getByTestId('branch-tab').click()
  await expect(page.getByTestId('branch-delete')).toBeVisible()

  page.once('dialog', (dialog) => dialog.dismiss())
  await page.getByTestId('branch-delete').click()

  await expect(page.getByTestId('branch-list-item-feature-delete')).toBeVisible()
  expect(deleteCalled).toBe(false)

  await closeAndDeleteProject(page, projectName)
})

test('branch delete removes branch after confirmation', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Branch Delete ${Date.now()}`
  let overview = buildOverview(true)

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.route('**/api/projects/*/branches', async (route) => {
    const { pathname } = new URL(route.request().url())
    const method = route.request().method()

    if (method === 'GET' && /\/api\/projects\/[^/]+\/branches$/.test(pathname)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(overview)
      })
      return
    }

    await route.fallback()
  })

  await page.route('**/api/projects/*/branches/*/checkout', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, overview: buildOverview(false) })
    })
  })

  await page.route('**/api/projects/*/branches/*', async (route) => {
    if (route.request().method() === 'DELETE') {
      overview = buildOverview(false)
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, overview })
      })
      return
    }

    await route.fallback()
  })

  await createProject(page, projectName, 'Branch delete flow')

  await page.getByTestId('branch-tab').click()
  await expect(page.getByTestId('branch-delete')).toBeVisible()

  page.once('dialog', (dialog) => dialog.accept())
  await page.getByTestId('branch-delete').click()

  await expect(page.getByTestId('branch-list-item-feature-delete')).toHaveCount(0)
  await expect(page.getByTestId('branch-list-item-main')).toBeVisible()

  await closeAndDeleteProject(page, projectName)
})
