const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const safeRemoveFile = (filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  } catch {
    // Best-effort cleanup only.
  }
}

const safeRemoveDir = (dirPath) => {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true })
    }
  } catch {
    // Best-effort cleanup only.
  }
}

const cleanupTempImports = () => {
  try {
    const tmpRoot = os.tmpdir()
    const entries = fs.readdirSync(tmpRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!entry.name.startsWith('lucidcoder-e2e-import-')) continue
      safeRemoveDir(path.join(tmpRoot, entry.name))
    }
  } catch {
    // Best-effort cleanup only.
  }
}

module.exports = async function globalTeardown() {
  const repoRoot = process.cwd()
  const dbPath = path.join(repoRoot, 'backend', 'e2e-lucidcoder.db')

  safeRemoveFile(dbPath)
  cleanupTempImports()
}
