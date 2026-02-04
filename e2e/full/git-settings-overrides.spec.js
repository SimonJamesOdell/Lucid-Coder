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

test('project git settings override global defaults', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Git Overrides ${Date.now()}`

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.route('**/api/settings/git', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          settings: { provider: 'gitlab', defaultBranch: 'main', tokenPresent: true }
        })
      })
      return
    }

    await route.fallback()
  })

  await page.route('**/api/projects/*/git-settings', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          inheritsFromGlobal: false,
          effectiveSettings: {
            workflow: 'cloud',
            provider: 'github',
            remoteUrl: 'https://github.com/acme/override.git',
            defaultBranch: 'develop'
          },
          projectSettings: {
            workflow: 'cloud',
            provider: 'github',
            remoteUrl: 'https://github.com/acme/override.git',
            defaultBranch: 'develop'
          }
        })
      })
      return
    }

    await route.fallback()
  })

  await page.route('**/api/projects/*/git/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        status: { hasRemote: true, branch: 'develop', ahead: 0, behind: 0 }
      })
    })
  })

  await page.route('**/api/projects/*/branches', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        current: 'develop',
        branches: [{ name: 'develop', status: 'active', isCurrent: true }],
        workingBranches: []
      })
    })
  })

  await createProject(page, projectName, 'Git overrides flow')

  await page.getByTestId('git-tab').click()
  await expect(page.getByTestId('git-tab-panel')).toBeVisible()

  await expect(page.getByTestId('project-connection-custom')).toBeChecked()
  await expect(page.getByTestId('project-connection-global')).not.toBeChecked()
  await expect(page.getByTestId('project-provider-select')).toHaveValue('github')
  await expect(page.getByTestId('project-remote-url')).toHaveValue('https://github.com/acme/override.git')
  await expect(page.getByTestId('project-default-branch')).toHaveValue('develop')

  await closeAndDeleteProject(page, projectName)
})
