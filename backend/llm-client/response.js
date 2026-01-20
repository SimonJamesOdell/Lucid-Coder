export function getErrorMessage(error) {
  const data = error?.response?.data;
  const candidates = [
    data?.error?.message,
    data?.error,
    data?.message,
    data?.detail,
    error?.message,
    typeof error === 'string' ? error : null
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  try {
    if (data != null) {
      return JSON.stringify(data);
    }
  } catch {
    // ignore
  }

  return 'Unknown error';
}

function coerceMessageText(message) {
  if (!message) {
    return '';
  }
  if (typeof message === 'string') {
    return message;
  }
  if (typeof message.content === 'string' && message.content.trim()) {
    return message.content.trim();
  }
  if (Array.isArray(message.content)) {
    const flattened = message.content
      .map((entry) => {
        if (typeof entry === 'string') {
          return entry;
        }
        if (entry && typeof entry.text === 'string') {
          return entry.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
    if (flattened) {
      return flattened;
    }
  }
  if (typeof message.reasoning === 'string' && message.reasoning.trim()) {
    return message.reasoning.trim();
  }
  if (message.reasoning && typeof message.reasoning === 'object') {
    if (typeof message.reasoning.output_text === 'string' && message.reasoning.output_text.trim()) {
      return message.reasoning.output_text.trim();
    }
    if (Array.isArray(message.reasoning.steps)) {
      const joined = message.reasoning.steps
        .map((step) => (typeof step?.text === 'string' ? step.text : ''))
        .filter(Boolean)
        .join('\n')
        .trim();
      if (joined) {
        return joined;
      }
    }
  }
  return '';
}

export function extractResponse(provider, responseData) {
  if (!responseData) {
    return JSON.stringify(responseData);
  }

  const extractFromChoices = () => {
    const firstChoice = responseData.choices?.[0];
    if (!firstChoice) {
      return '';
    }

    const messageFallbackText = coerceMessageText(firstChoice.message);

    // Tool-bridge response: translate tool/function calls into plain JSON actions.
    const normalizeFirstToolCall = () => {
      const message = firstChoice.message;
      const messageToolCalls = message?.tool_calls;
      if (Array.isArray(messageToolCalls) && messageToolCalls.length > 0) {
        return messageToolCalls[0];
      }

      // OpenAI legacy function_call format.
      const functionCall = message?.function_call;
      if (functionCall && typeof functionCall === 'object') {
        return { function: functionCall };
      }

      // Some providers may place tool_calls on the choice.
      const choiceToolCalls = firstChoice.tool_calls;
      if (Array.isArray(choiceToolCalls) && choiceToolCalls.length > 0) {
        return choiceToolCalls[0];
      }

      return null;
    };

    const firstCall = normalizeFirstToolCall();
    if (firstCall) {
      const rawName = firstCall?.function?.name ?? firstCall?.name;
      const argsRaw = firstCall?.function?.arguments ?? firstCall?.arguments;

      const toolName = typeof rawName === 'string' ? rawName.trim() : '';
      const coerceString = (value) => (typeof value === 'string' ? value : '');

      let parsed = null;
      if (typeof argsRaw === 'string') {
        const trimmedArgs = argsRaw.trim();
        if (trimmedArgs) {
          try {
            parsed = JSON.parse(trimmedArgs);
          } catch {
            // Some providers may return plain text in the arguments field.
            // If we already have message content, prefer it over potentially-garbled tool args.
            if (!messageFallbackText) {
              parsed = { text: argsRaw };
            }
          }
        }
      } else if (argsRaw && typeof argsRaw === 'object') {
        // If we already have message content, prefer it over non-string tool args.
        if (!messageFallbackText) {
          parsed = argsRaw;
        }
      }

      if (parsed) {
        const normalizedToolName = toolName === 'respond_with_json' ? 'json' : toolName;

        if (normalizedToolName === 'json') {
          const text = coerceString(parsed?.text) || coerceString(parsed?.content) || coerceString(parsed?.answer);
          if (text) {
            return text;
          }

          const payload = parsed?.json ?? parsed?.value ?? parsed?.data;
          try {
            return JSON.stringify(payload ?? parsed);
          } catch {
            return String(payload ?? parsed);
          }
        }

        if ((normalizedToolName === 'respond_with_text' || normalizedToolName === 'response') && parsed) {
          const text = coerceString(parsed.text) || coerceString(parsed.answer) || coerceString(parsed.content) || coerceString(parsed.message);
          if (text) {
            return text;
          }
        }

        // Translate API-level tool calls into the plain JSON-action format our agents expect.
        // This keeps strict providers happy without requiring real tool-call execution.
        const actionName = normalizedToolName;
        if (!actionName) {
          return '';
        }
        const path = coerceString(parsed?.path || parsed?.filePath || parsed?.filename);
        const reason = coerceString(parsed?.reason);
        const content = coerceString(parsed?.content || parsed?.text);

        if (actionName === 'read_file') {
          return JSON.stringify({ action: 'read_file', path, reason: reason || undefined });
        }
        if (actionName === 'list_dir' || actionName === 'list_directory') {
          return JSON.stringify({ action: 'list_dir', path, reason: reason || undefined });
        }
        if (actionName === 'list_file') {
          return JSON.stringify({ action: 'list_dir', path, reason: reason || undefined });
        }
        if (actionName === 'write_file') {
          return JSON.stringify({ action: 'write_file', path, content, reason: reason || undefined });
        }
        if (actionName === 'list_goals') {
          return JSON.stringify({ action: 'list_goals', reason: reason || undefined });
        }
        if (actionName === 'answer') {
          const answer = coerceString(parsed?.answer || parsed?.text);
          return JSON.stringify({ action: 'answer', answer });
        }
        if (actionName === 'unable') {
          const explanation = coerceString(parsed?.explanation || parsed?.reason || parsed?.message);
          return JSON.stringify({ action: 'unable', explanation });
        }
      }
    }

    if (messageFallbackText) {
      return messageFallbackText;
    }
    if (typeof firstChoice.text === 'string' && firstChoice.text.trim()) {
      return firstChoice.text.trim();
    }
    return '';
  };

  switch (provider) {
    case 'openai':
    case 'groq':
    case 'together':
    case 'perplexity':
    case 'mistral':
    case 'lmstudio':
    case 'textgen':
    case 'custom':
      return extractFromChoices() || JSON.stringify(responseData);

    case 'anthropic':
      return responseData.content?.[0]?.text || '';

    case 'google':
      return responseData.candidates?.[0]?.content?.parts?.[0]?.text || '';

    case 'cohere':
      return responseData.text || '';

    case 'ollama':
      return coerceMessageText(responseData.message) || extractFromChoices() || '';

    default: {
      const fallback = extractFromChoices();
      if (fallback) {
        return fallback;
      }
      return JSON.stringify(responseData);
    }
  }
}
