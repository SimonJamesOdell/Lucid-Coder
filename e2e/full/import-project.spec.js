const { test, expect } = require('@playwright/test')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { ensureBootstrapped } = require('../e2e-utils')

test('import project from local folder', async ({ page, request }) => {
  await ensureBootstrapped({ request })

  const projectName = `E2E Full Import ${Date.now()}`
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lucidcoder-e2e-import-'))

  try {
    fs.writeFileSync(
      path.join(localRoot, 'package.json'),
      JSON.stringify({
        name: 'e2e-import',
        scripts: { dev: 'vite --host 0.0.0.0' },
        dependencies: { vite: '^5.0.0' }
      })
    )

    await page.goto('/')
    await expect(page.getByText('Select Project')).toBeVisible()

    await page.getByRole('button', { name: 'Import Project' }).click()
    await expect(page.getByRole('heading', { name: 'Import Existing Project' })).toBeVisible()

    await page.getByRole('button', { name: 'Next' }).click()
    await page.getByLabel('Project Folder Path *').fill(localRoot)
    await page.getByRole('button', { name: 'Next' }).click()
    await page.getByLabel('Project Name *').fill(projectName)
    await page.getByLabel('Description').fill('Full-suite import test')
    await page.getByRole('button', { name: 'Next' }).click()
    await page.getByRole('button', { name: 'Next' }).click()
    await page.getByText('Allow compatibility updates').click()
    await page.getByText('Move frontend files into a frontend folder').click()
    await page.getByRole('button', { name: 'Next' }).click()
    await page.getByRole('button', { name: 'Import Project', exact: true }).click()

    await expect(page.getByTestId('close-project-button')).toBeVisible({ timeout: 120_000 })
    await expect(page.getByText(projectName)).toBeVisible()
  } finally {
    fs.rmSync(localRoot, { recursive: true, force: true })
  }
})
