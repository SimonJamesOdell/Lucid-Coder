import { TOOL_BRIDGE_FLAG } from './toolBridge.js';

export function sanitizePayload(provider, payload) {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  const allowToolBridge = Boolean(payload[TOOL_BRIDGE_FLAG]);

  // We do not use API-level tool/function calling anywhere in this codebase.
  // Some providers/models may attempt to emit tool calls; sending tool fields can
  // cause strict providers to error. Strip these fields defensively.
  const sanitized = { ...payload };

  // Strip internal control flags from outgoing requests.
  // These are used by our app logic only and must never reach the provider.
  for (const key of Object.keys(sanitized)) {
    if (key.startsWith('__lucidcoder')) {
      delete sanitized[key];
    }
  }

  if (!allowToolBridge) {
    delete sanitized.tools;
    delete sanitized.tool_choice;
    delete sanitized.functions;
    delete sanitized.function_call;
    delete sanitized.parallel_tool_calls;
  }

  // Strip tool-calling fields from message history objects.
  // Some OpenAI-compatible providers will reject requests if messages contain tool metadata.
  if (Array.isArray(sanitized.messages)) {
    sanitized.messages = sanitized.messages
      .filter((msg) => msg && typeof msg === 'object')
      .map((msg) => {
        const role = msg.role;
        const content = msg.content;
        const name = msg.name;
        const next = { role, content };
        if (typeof name === 'string' && name.trim()) {
          next.name = name;
        }
        return next;
      });
  }

  // Avoid passing empty response_format objects if callers accidentally forward them.
  if (sanitized.response_format && typeof sanitized.response_format === 'object') {
    const keys = Object.keys(sanitized.response_format);
    if (keys.length === 0) {
      delete sanitized.response_format;
    }
  }

  return sanitized;
}

export function formatPayload(provider, model, prompt, options = {}, currentConfig) {
  if (typeof model === 'object') {
    // Handle case where second param is payload object (current implementation)
    return formatPayloadInternal(provider, model, options, currentConfig);
  }

  // Handle test case where params are (provider, model, prompt, options)
  const messages = [{ role: 'user', content: prompt }];
  const payload = {
    model: model,
    messages: messages,
    max_tokens: options.maxTokens || 100,
    temperature: options.temperature || 0.7,
    top_p: options.topP || 0.9
  };

  return formatPayloadInternal(provider, payload, { model }, currentConfig);
}

export function formatPayloadInternal(provider, payload, config, currentConfig) {
  const modelToUse = config?.model || payload?.model || currentConfig?.model;

  if (!payload) {
    throw new Error(`Unsupported provider: ${provider}`);
  }

  const basePayload = {
    model: modelToUse,
    ...payload
  };

  switch (provider) {
    case 'anthropic':
      return {
        model: modelToUse,
        max_tokens: payload.max_tokens || 1000,
        messages: payload.messages,
        temperature: payload.temperature || 0.7,
        top_p: payload.top_p || 0.9
      };

    case 'google':
      return {
        contents: payload.messages.map(msg => ({
          parts: [{ text: msg.content }]
        })),
        generationConfig: {
          maxOutputTokens: payload.max_tokens || 1000,
          temperature: payload.temperature || 0.7,
          topP: payload.top_p || 0.9
        }
      };

    case 'cohere': {
      const lastMessage = payload.messages[payload.messages.length - 1];
      return {
        model: modelToUse,
        message: lastMessage.content,
        max_tokens: payload.max_tokens || 1000,
        temperature: payload.temperature || 0.7,
        p: payload.top_p || 0.9
      };
    }

    case 'ollama':
      return {
        model: modelToUse,
        messages: payload.messages,
        stream: false,
        options: {
          temperature: payload.temperature || 0.7,
          num_predict: payload.max_tokens || 1000
        }
      };

    default: {
      // Check if provider is supported
      const supportedProviders = ['groq', 'openai', 'anthropic', 'google', 'cohere', 'mistral', 'perplexity', 'together', 'ollama', 'lmstudio', 'textgen', 'custom'];
      if (!supportedProviders.includes(provider)) {
        throw new Error(`Unsupported provider: ${provider}`);
      }
      // OpenAI-compatible format (most providers)
      return basePayload;
    }
  }
}
