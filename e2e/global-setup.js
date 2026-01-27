const fs = require('node:fs')
const path = require('node:path')

module.exports = async function globalSetup() {
  const repoRoot = process.cwd()
  const dbPath = path.join(repoRoot, 'backend', 'e2e-lucidcoder.db')

  try {
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath)
    }
  } catch {
    // Best-effort cleanup only.
  }
}
