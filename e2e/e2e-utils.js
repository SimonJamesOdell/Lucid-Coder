const BACKEND_URL = process.env.E2E_BACKEND_URL || 'http://localhost:5000'

const ensureBootstrapped = async ({ request }) => {
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
