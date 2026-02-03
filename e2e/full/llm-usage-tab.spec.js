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

test('llm usage tab shows metrics, filters phases, and resets metrics', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E LLM Usage ${Date.now()}`
  let metricsPayload = {
    success: true,
    metrics: {
      startedAt: '2026-02-03T00:00:00.000Z',
      now: '2026-02-03T00:00:10.000Z',
      counters: {
        'kind:requested': 12,
        'kind:outbound': 4,
        'kind:dedup_inflight': 3,
        'kind:dedup_recent': 1,
        'phase_type:planning::analysis': 5,
        'phase_type:testing::unit': 2
      }
    }
  }

  await page.addInitScript(() => {
    window.__copiedText = ''
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text) => {
          window.__copiedText = text
        }
      }
    })
  })

  await page.route('**/api/llm/request-metrics', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(metricsPayload)
    })
  })

  await page.route('**/api/llm/request-metrics/reset', async (route) => {
    metricsPayload = {
      success: true,
      metrics: {
        startedAt: '2026-02-03T00:01:00.000Z',
        now: '2026-02-03T00:01:00.000Z',
        counters: {
          'kind:requested': 0,
          'kind:outbound': 0,
          'kind:dedup_inflight': 0,
          'kind:dedup_recent': 0
        }
      }
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(metricsPayload)
    })
  })

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await createProject(page, projectName, 'LLM usage tab flow')

  await page.getByTestId('nav-llm-usage').click()
  await expect(page.getByTestId('llm-usage-tab-content')).toBeVisible()

  await expect(page.getByTestId('llm-usage-requested')).toHaveText('12')
  await expect(page.getByTestId('llm-usage-outbound')).toHaveText('4')

  await page.getByRole('checkbox', { name: 'Auto-refresh' }).uncheck()

  await page.getByTestId('llm-usage-filter').fill('planning')
  await expect(page.getByText('planning')).toBeVisible()

  await page.getByTestId('llm-usage-copy').click()
  await expect(page.getByTestId('llm-usage-copied')).toBeVisible()
  await expect(page.evaluate(() => window.__copiedText)).resolves.toContain('kind:requested')

  await page.getByTestId('llm-usage-reset').click()
  await expect(page.getByTestId('llm-usage-requested')).toHaveText('0')
  await expect(page.getByTestId('llm-usage-outbound')).toHaveText('0')

  await closeAndDeleteProject(page, projectName)
})
