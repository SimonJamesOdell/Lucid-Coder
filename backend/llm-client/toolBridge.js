export const TOOL_BRIDGE_FLAG = '__lucidcoderToolBridge';

export function shouldUseActionToolBridgeByDefault(provider) {
  // Only OpenAI-compatible chat/completions providers should receive tool schemas.
  // Other providers (Anthropic/Google/Cohere/Ollama) use different payloads and may reject tool fields.
  const supported = new Set(['openai', 'groq', 'together', 'perplexity', 'mistral', 'custom']);
  return supported.has(String(provider || '').toLowerCase());
}

export function buildActionToolBridgePayload(payload) {
  const base = payload && typeof payload === 'object' ? payload : {};

  const respondSchema = {
    type: 'object',
    properties: {
      text: { type: 'string' },
      answer: { type: 'string' },
      content: { type: 'string' },
      message: { type: 'string' }
    },
    additionalProperties: true
  };

  const tools = [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Request reading a project file by relative path.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            reason: { type: 'string' }
          },
          required: ['path'],
          additionalProperties: true
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_dir',
        description: 'Request listing a project directory by relative path.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            reason: { type: 'string' }
          },
          required: ['path'],
          additionalProperties: true
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_file',
        description: 'Alias for list_dir. Some models emit list_file when they mean list a folder.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            reason: { type: 'string' }
          },
          required: ['path'],
          additionalProperties: true
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Request writing a project file by relative path.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
            reason: { type: 'string' }
          },
          required: ['path', 'content'],
          additionalProperties: true
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_goals',
        description: 'Request listing persisted goals for the current project.',
        parameters: {
          type: 'object',
          properties: {
            reason: { type: 'string' }
          },
          additionalProperties: true
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'answer',
        description: 'Return the final answer as plain text.',
        parameters: {
          type: 'object',
          properties: {
            answer: { type: 'string' }
          },
          required: ['answer'],
          additionalProperties: true
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'json',
        description: 'Alias tool for returning a JSON response payload (as text or object).',
        parameters: {
          type: 'object',
          properties: {
            json: {},
            value: {},
            data: {},
            text: { type: 'string' },
            content: { type: 'string' },
            answer: { type: 'string' }
          },
          additionalProperties: true
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'response',
        description: 'Alias for respond_with_text/answer. Return the final response text.',
        parameters: respondSchema
      }
    },
    {
      type: 'function',
      function: {
        name: 'unable',
        description: 'Return an explanation of why the request cannot be completed.',
        parameters: {
          type: 'object',
          properties: {
            explanation: { type: 'string' }
          },
          required: ['explanation'],
          additionalProperties: true
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'respond_with_text',
        description: 'Return the final answer as plain text in the `text` argument.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string' }
          },
          required: ['text'],
          additionalProperties: false
        }
      }
    }
  ];

  return {
    ...base,
    [TOOL_BRIDGE_FLAG]: true,
    tools,
    tool_choice: 'auto'
  };
}

export function buildToolBridgePayload(payload) {
  const base = payload && typeof payload === 'object' ? payload : {};

  // A minimal tool bridge that allows strict providers to accept tool-capable models.
  // If the model insists on tool-calling, it can call this function with the intended text output.
  const tools = [
    {
      type: 'function',
      function: {
        name: 'respond_with_text',
        description: 'Return the final answer as plain text in the `text` argument.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string' }
          },
          required: ['text'],
          additionalProperties: true
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'json',
        description: 'Alias tool for returning a JSON response payload (as text or object).',
        parameters: {
          type: 'object',
          properties: {
            json: {},
            value: {},
            data: {},
            text: { type: 'string' },
            content: { type: 'string' },
            answer: { type: 'string' }
          },
          additionalProperties: true
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'response',
        description: 'Alias for respond_with_text. Return response text in `text`/`answer`.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            answer: { type: 'string' },
            content: { type: 'string' },
            message: { type: 'string' }
          },
          additionalProperties: true
        }
      }
    }
  ];

  return {
    ...base,
    [TOOL_BRIDGE_FLAG]: true,
    tools,
    tool_choice: {
      type: 'function',
      function: { name: 'respond_with_text' }
    }
  };
}
