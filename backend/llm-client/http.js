const sanitizeApiKey = (value) => {
  if (typeof value !== 'string') {
    return '';
  }
  const stripped = value.replace(/[\u0000-\u001F\u007F]+/g, '').trim();
  return stripped.replace(/^Bearer\s+/i, '').trim();
};

export function getHeaders(provider, apiKey) {
  const sanitizedApiKey = sanitizeApiKey(apiKey);
  const headers = {
    'Content-Type': 'application/json'
  };

  switch (provider) {
    case 'openai':
    case 'groq':
    case 'together':
    case 'perplexity':
      headers['Authorization'] = `Bearer ${sanitizedApiKey}`;
      break;

    case 'anthropic':
      headers['Authorization'] = `Bearer ${sanitizedApiKey}`;
      headers['anthropic-version'] = '2023-06-01';
      break;

    case 'google':
      headers['Authorization'] = `Bearer ${sanitizedApiKey}`;
      break;

    case 'cohere':
      headers['Authorization'] = `Bearer ${sanitizedApiKey}`;
      break;

    case 'mistral':
      headers['Authorization'] = `Bearer ${sanitizedApiKey}`;
      break;

    case 'ollama':
    case 'lmstudio':
    case 'textgen':
      // Local providers typically don't need auth headers
      break;

    case 'custom':
      if (sanitizedApiKey) {
        headers['Authorization'] = `Bearer ${sanitizedApiKey}`;
      }
      break;
  }

  return headers;
}

export function getEndpointURL(config) {
  const baseUrl = config.api_url;

  switch (config.provider) {
    case 'openai':
    case 'groq':
    case 'together':
    case 'perplexity':
    case 'lmstudio':
    case 'textgen':
      return `${baseUrl}/chat/completions`;

    case 'anthropic':
      return `${baseUrl}/messages`;

    case 'google':
      return `${baseUrl}/models/${config.model}:generateContent`;

    case 'cohere':
      return `${baseUrl}/chat`;

    case 'mistral':
      return `${baseUrl}/chat/completions`;

    case 'ollama':
      return `${baseUrl}/api/chat`;

    case 'custom':
      return `${baseUrl}/chat/completions`; // Default to OpenAI-compatible

    default:
      return `${baseUrl}/chat/completions`;
  }
}
