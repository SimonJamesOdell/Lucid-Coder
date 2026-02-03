const { test, expect } = require('@playwright/test')
const { ensureBootstrapped } = require('../e2e-utils')

test('preview reload and context menu close', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Preview ${Date.now()}`

  await page.goto('/')
  await expect(page.getByText('Select Project')).toBeVisible()

  await page.getByRole('button', { name: 'Create New Project' }).click()
  await expect(page.getByRole('heading', { name: 'Create New Project' })).toBeVisible()

  await page.getByLabel('Project Name *').fill(projectName)
  await page.getByLabel('Description').fill('Preview flow test')
  await page.getByRole('button', { name: 'Create Project', exact: true }).click()

  await expect(page.getByTestId('close-project-button')).toBeVisible({ timeout: 60_000 })

  await page.getByTestId('preview-tab').click()
  await expect(page.getByTestId('preview-url-bar')).toBeVisible()

  await page.getByTestId('reload-preview').click()

  await page.waitForFunction(() => {
    const iframe = document.querySelector('[data-testid="preview-iframe"]')
    const src = iframe?.getAttribute('src')
    return Boolean(src && src.includes('/preview/'))
  })

  let previewFrame = page.frame({ url: /\/preview\// })
  if (!previewFrame) {
    previewFrame = await page.waitForEvent('framenavigated', {
      predicate: (frame) => frame.url().includes('/preview/')
    })
  }

  await previewFrame.evaluate(() => {
    window.parent.postMessage(
      {
        type: 'LUCIDCODER_PREVIEW_HELPER_CONTEXT_MENU',
        clientX: 120,
        clientY: 160,
        tagName: 'DIV',
        id: 'root',
        className: 'app',
        href: 'http://example.com'
      },
      '*'
    )
  })

  await expect(page.getByTestId('preview-context-menu')).toBeVisible()

  await previewFrame.evaluate(() => {
    window.parent.postMessage(
      { type: 'LUCIDCODER_PREVIEW_BRIDGE_POINTER', kind: 'pointerdown' },
      '*'
    )
  })

  await expect(page.locator('[data-testid="preview-context-menu"]')).toHaveCount(0)

  await page.getByTestId('close-project-button').click()
  await expect(page.getByText('Select Project')).toBeVisible({ timeout: 30_000 })

  const projectCard = page.locator('.project-card', { hasText: projectName })
  await expect(projectCard).toBeVisible()

  await projectCard.getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByTestId('modal-content')).toBeVisible()
  await page.getByTestId('modal-confirm').click()
  await expect(projectCard).toHaveCount(0)
})
