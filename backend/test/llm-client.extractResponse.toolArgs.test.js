import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../database.js', () => ({
  db_operations: {
    logAPIRequest: vi.fn()
  }
}));

vi.mock('../encryption.js', () => ({
  decryptApiKey: vi.fn(() => 'decrypted')
}));

vi.mock('../services/llmRequestMetrics.js', () => ({
  llmRequestMetrics: {
    recordRequest: vi.fn()
  }
}));

describe('LLMClient.extractResponse tool-call argument fallbacks', () => {
  let LLMClient;

  beforeEach(async () => {
    vi.restoreAllMocks();
    ({ LLMClient } = await import('../llm-client.js'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('wraps non-JSON tool arguments as text when no message fallback exists', () => {
    const client = new LLMClient();

    const responseData = {
      choices: [
        {
          tool_calls: [
            {
              function: {
                name: 'json',
                arguments: 'not-json'
              }
            }
          ]
        }
      ]
    };

    const extracted = client.extractResponse('openai', responseData);
    expect(extracted).toBe('not-json');
  });

  it('uses object tool arguments when no message fallback exists', () => {
    const client = new LLMClient();

    const responseData = {
      choices: [
        {
          tool_calls: [
            {
              function: {
                name: 'json',
                arguments: { text: 'hello from object args' }
              }
            }
          ]
        }
      ]
    };

    const extracted = client.extractResponse('openai', responseData);
    expect(extracted).toBe('hello from object args');
  });

  it('supports legacy OpenAI message.function_call format', () => {
    const client = new LLMClient();

    const responseData = {
      choices: [
        {
          message: {
            function_call: {
              name: 'respond_with_text',
              arguments: JSON.stringify({ text: 'legacy function_call response' })
            }
          }
        }
      ]
    };

    const extracted = client.extractResponse('openai', responseData);
    expect(extracted).toBe('legacy function_call response');
  });

  it('prefers message content when tool arguments are invalid JSON', () => {
    const client = new LLMClient();

    const responseData = {
      choices: [
        {
          message: {
            content: 'message content wins'
          },
          tool_calls: [
            {
              function: {
                name: 'json',
                arguments: 'not-json'
              }
            }
          ]
        }
      ]
    };

    const extracted = client.extractResponse('openai', responseData);
    expect(extracted).toBe('message content wins');
  });

  it('stringifies json payload when no text/content/answer exists', () => {
    const client = new LLMClient();

    const responseData = {
      choices: [
        {
          tool_calls: [
            {
              function: {
                name: 'json',
                arguments: JSON.stringify({ json: { a: 1 } })
              }
            }
          ]
        }
      ]
    };

    const extracted = client.extractResponse('openai', responseData);
    expect(extracted).toBe(JSON.stringify({ a: 1 }));
  });

  it('supports tool calls with top-level name/arguments and respond_with_json alias', () => {
    const client = new LLMClient();

    const responseData = {
      choices: [
        {
          tool_calls: [
            {
              name: 'respond_with_json',
              arguments: JSON.stringify({ value: { ok: true } })
            }
          ]
        }
      ]
    };

    const extracted = client.extractResponse('openai', responseData);
    expect(extracted).toBe(JSON.stringify({ ok: true }));
  });

  it('falls back to parsed.data when json/value are missing', () => {
    const client = new LLMClient();

    const responseData = {
      choices: [
        {
          tool_calls: [
            {
              function: {
                name: 'json',
                arguments: JSON.stringify({ data: { answer: 42 } })
              }
            }
          ]
        }
      ]
    };

    const extracted = client.extractResponse('openai', responseData);
    expect(extracted).toBe(JSON.stringify({ answer: 42 }));
  });

  it('treats whitespace-only tool arguments as empty and falls back to message content', () => {
    const client = new LLMClient();

    const responseData = {
      choices: [
        {
          message: {
            content: 'fallback for empty args'
          },
          tool_calls: [
            {
              function: {
                name: 'json',
                arguments: '   \n\t  '
              }
            }
          ]
        }
      ]
    };

    const extracted = client.extractResponse('openai', responseData);
    expect(extracted).toBe('fallback for empty args');
  });

  it('falls back to message content when tool arguments are neither string nor object', () => {
    const client = new LLMClient();

    const responseData = {
      choices: [
        {
          message: {
            content: 'fallback for non-object args'
          },
          tool_calls: [
            {
              function: {
                name: 'json',
                arguments: 123
              }
            }
          ]
        }
      ]
    };

    const extracted = client.extractResponse('openai', responseData);
    expect(extracted).toBe('fallback for non-object args');
  });
});
