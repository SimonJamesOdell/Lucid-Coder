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

test('git tab remote creator can link a new repository', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Git Remote ${Date.now()}`

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.route('**/api/settings/git', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          settings: { provider: 'github', defaultBranch: 'main', tokenPresent: false }
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
          inheritsFromGlobal: true,
          effectiveSettings: { workflow: 'local', provider: 'github', remoteUrl: '', defaultBranch: 'main' }
        })
      })
      return
    }

    await route.fallback()
  })

  await page.route('**/api/projects/*/git/remotes', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          repository: { remoteUrl: 'https://github.com/example/lucidcoder-project.git' },
          projectSettings: { workflow: 'cloud', provider: 'github', remoteUrl: 'https://github.com/example/lucidcoder-project.git', defaultBranch: 'main' }
        })
      })
      return
    }

    await route.fallback()
  })

  await createProject(page, projectName, 'Git remote creator flow')

  await page.getByTestId('git-tab').click()
  await expect(page.getByTestId('git-tab-panel')).toBeVisible()

  await page.getByTestId('project-connection-custom').click()
  await page.getByTestId('git-show-remote-creator').click()

  await page.getByTestId('git-remote-create-name').fill('lucidcoder-project')
  await page.getByTestId('git-remote-create-owner').fill('example')
  await page.getByTestId('git-remote-create-visibility').selectOption('public')
  await page.getByTestId('git-remote-create-description').fill('E2E generated repo')
  await page.getByTestId('project-token').fill('ghp_exampletoken')

  await page.getByTestId('git-create-remote-button').click()
  await expect(page.getByText('Repository created and linked.')).toBeVisible()

  await closeAndDeleteProject(page, projectName)
})

test('git tab remote creator surfaces create errors', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Git Remote Error ${Date.now()}`

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.route('**/api/settings/git', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          settings: { provider: 'github', defaultBranch: 'main', tokenPresent: false }
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
          inheritsFromGlobal: true,
          effectiveSettings: { workflow: 'local', provider: 'github', remoteUrl: '', defaultBranch: 'main' }
        })
      })
      return
    }

    await route.fallback()
  })

  await page.route('**/api/projects/*/git/remotes', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Remote create failed.' })
      })
      return
    }

    await route.fallback()
  })

  await createProject(page, projectName, 'Git remote creator error')

  await page.getByTestId('git-tab').click()
  await expect(page.getByTestId('git-tab-panel')).toBeVisible()

  await page.getByTestId('project-connection-custom').click()
  await page.getByTestId('git-show-remote-creator').click()

  await page.getByTestId('git-remote-create-name').fill('lucidcoder-project')
  await page.getByTestId('project-token').fill('ghp_exampletoken')

  await page.getByTestId('git-create-remote-button').click()
  await expect(page.getByText('Remote create failed.')).toBeVisible()

  await closeAndDeleteProject(page, projectName)
})
