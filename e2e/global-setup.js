const fs = require('node:fs')
const path = require('node:path')

module.exports = async function globalSetup() {
  const repoRoot = process.cwd()
  const dbPath = process.env.E2E_DB_PATH || path.join(repoRoot, 'backend', 'e2e-lucidcoder.db')
  const projectsDir = process.env.E2E_PROJECTS_DIR

  try {
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath)
    }
  } catch {
    // Best-effort cleanup only.
  }

  if (!projectsDir) {
    return
  }

  try {
    if (fs.existsSync(projectsDir)) {
      fs.rmSync(projectsDir, { recursive: true, force: true })
    }
    fs.mkdirSync(projectsDir, { recursive: true })
  } catch {
    // Best-effort cleanup only.
  }
}
