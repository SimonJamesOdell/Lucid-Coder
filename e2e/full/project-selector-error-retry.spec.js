const { test, expect } = require('@playwright/test')
const { ensureBootstrapped } = require('../e2e-utils')

test('project selector shows an error state and recovers on retry', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  let calls = 0

  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback()
      return
    }

    calls += 1

    if (calls === 1) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Backend unavailable' })
      })
      return
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, projects: [] })
    })
  })

  await page.goto('/')

  await expect(page.getByText('Error Loading Projects')).toBeVisible()
  await expect(page.getByText('Backend unavailable')).toBeVisible()

  await page.getByRole('button', { name: 'Retry' }).click()

  await expect(page.getByText('No projects yet')).toBeVisible()
})
