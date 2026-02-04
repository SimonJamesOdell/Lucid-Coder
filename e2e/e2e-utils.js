const BACKEND_URL = process.env.E2E_BACKEND_URL || 'http://localhost:5100'

const normalizePath = (value) => String(value || '').replace(/\\/g, '/').toLowerCase()

const assertBackendIsE2EIsolated = async ({ request }) => {
  const expectedDbPath = process.env.E2E_DB_PATH
  if (!expectedDbPath) {
    return
  }

  const response = await request.get(`${BACKEND_URL}/api/diagnostics/bundle`)
  if (!response.ok()) {
    const bodyText = await response.text().catch(() => '')
    throw new Error(`Failed to verify backend diagnostics: ${response.status()} ${bodyText}`)
  }

  const payload = await response.json().catch(() => null)
  const envDbPath = payload?.bundle?.env?.values?.DATABASE_PATH || payload?.bundle?.database?.databasePath
  if (!envDbPath) {
    throw new Error('Refusing to bootstrap LLM config: backend did not report DATABASE_PATH in diagnostics bundle')
  }

  if (normalizePath(envDbPath) !== normalizePath(expectedDbPath)) {
    throw new Error(
      `Refusing to bootstrap LLM config against non-E2E backend. Expected DATABASE_PATH=${expectedDbPath} but got ${envDbPath}. ` +
      'Stop the running backend on the E2E port or run Playwright without server reuse.'
    )
  }
}

const ensureBootstrapped = async ({ request }) => {
  await assertBackendIsE2EIsolated({ request })

  // Configure an API-key-less provider so the UI can proceed without manual setup.
  // Backend readiness only checks presence of model + api_url for providers like ollama.
  const response = await request.post(`${BACKEND_URL}/api/llm/configure`, {
    data: {
      provider: 'ollama',
      model: 'llama3',
      apiUrl: 'http://localhost:11434/v1'
    }
  })

  if (!response.ok()) {
    const bodyText = await response.text().catch(() => '')
    throw new Error(`Failed to bootstrap LLM config: ${response.status()} ${bodyText}`)
  }
}

module.exports = {
  ensureBootstrapped
}
