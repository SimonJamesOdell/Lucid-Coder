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

const buildManifestResponse = (manifest) => JSON.stringify({
  success: true,
  content: JSON.stringify(manifest)
})

test('packages tab manages dependencies and add/remove jobs', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Packages Tab ${Date.now()}`
  let frontendManifest = {
    name: 'web-app',
    version: '1.0.0',
    dependencies: {
      react: '^18.2.0'
    },
    devDependencies: {
      vitest: '^1.0.4'
    }
  }
  let backendManifest = {
    name: 'api',
    version: '1.0.0',
    dependencies: {
      express: '^4.0.0'
    }
  }

  await page.route('**/api/projects/*/jobs', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, jobs: [] })
      })
      return
    }

    const payload = route.request().postDataJSON() || {}
    if (payload.type === 'frontend:add-package') {
      const nextName = payload.payload?.packageName || 'unknown'
      const nextVersion = payload.payload?.version || 'latest'
      const isDev = Boolean(payload.payload?.dev)
      const nextManifest = { ...frontendManifest }
      if (isDev) {
        nextManifest.devDependencies = {
          ...(nextManifest.devDependencies || {}),
          [nextName]: nextVersion
        }
      } else {
        nextManifest.dependencies = {
          ...(nextManifest.dependencies || {}),
          [nextName]: nextVersion
        }
      }
      frontendManifest = nextManifest
    }

    if (payload.type === 'frontend:remove-package') {
      const target = payload.payload?.packageName
      const nextManifest = { ...frontendManifest }
      if (nextManifest.dependencies && target in nextManifest.dependencies) {
        const { [target]: _removed, ...rest } = nextManifest.dependencies
        nextManifest.dependencies = rest
      }
      if (nextManifest.devDependencies && target in nextManifest.devDependencies) {
        const { [target]: _removed, ...rest } = nextManifest.devDependencies
        nextManifest.devDependencies = rest
      }
      frontendManifest = nextManifest
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        job: {
          id: `job-${Date.now()}`,
          type: payload.type,
          status: 'succeeded'
        }
      })
    })
  })

  await page.route('**/api/projects/*/files/**', async (route) => {
    const { pathname } = new URL(route.request().url())

    if (pathname.endsWith('/frontend/package.json')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: buildManifestResponse(frontendManifest)
      })
      return
    }

    if (pathname.endsWith('/backend/package.json')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: buildManifestResponse(backendManifest)
      })
      return
    }

    await route.fallback()
  })

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await createProject(page, projectName, 'Packages tab flow')

  await page.getByTestId('packages-tab').click()
  await expect(page.getByTestId('package-tab')).toBeVisible()

  await expect(page.getByTestId('package-entry-frontend-dependencies-react')).toBeVisible()

  await page.getByTestId('package-add-open-frontend').click()
  await expect(page.getByTestId('package-add-modal-frontend')).toBeVisible()
  await page.getByLabel('Package name').fill('lodash')
  await page.getByLabel('Version (optional)').fill('4.17.21')
  await page.getByRole('checkbox', { name: 'Dev dependency' }).uncheck()
  await page.getByRole('button', { name: 'Add package' }).click()

  await expect(page.getByTestId('package-add-modal-frontend')).toHaveCount(0)
  await expect(page.getByTestId('package-entry-frontend-dependencies-lodash')).toBeVisible()

  await page
    .getByTestId('package-entry-frontend-dependencies-react')
    .getByRole('button', { name: 'Remove' })
    .click()

  await expect(page.getByTestId('package-entry-frontend-dependencies-react')).toHaveCount(0)

  await page.getByTestId('package-workspace-tab-backend').click()
  await expect(page.getByTestId('package-entry-backend-dependencies-express')).toBeVisible()

  await closeAndDeleteProject(page, projectName)
})

test('packages tab shows manifest errors per workspace', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Packages Errors ${Date.now()}`

  await page.route('**/api/projects/*/jobs', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, jobs: [] })
    })
  })

  await page.route('**/api/projects/*/files/**', async (route) => {
    const { pathname } = new URL(route.request().url())

    if (pathname.endsWith('/frontend/package.json')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          content: JSON.stringify({ name: 'web-app', dependencies: {} })
        })
      })
      return
    }

    if (pathname.endsWith('/backend/package.json')) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Manifest missing' })
      })
      return
    }

    await route.fallback()
  })

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await createProject(page, projectName, 'Packages tab error flow')

  await page.getByTestId('packages-tab').click()
  await expect(page.getByTestId('package-tab')).toBeVisible()

  await page.getByTestId('package-workspace-tab-backend').click()
  await expect(page.getByTestId('package-error-backend')).toBeVisible()
  await expect(page.getByTestId('package-error-backend')).toHaveText('Manifest missing')

  await closeAndDeleteProject(page, projectName)
})
