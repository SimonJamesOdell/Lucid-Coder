import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { extractResponse, getErrorMessage } from '../llm-client/response.js';
import { LLMClient, __testing } from '../llm-client.js';

vi.mock('axios', () => ({
  default: vi.fn()
}));

vi.mock('../database.js', () => ({
  db_operations: {
    logAPIRequest: vi.fn(),
    getActiveLLMConfig: vi.fn()
  }
}));

vi.mock('../encryption.js', () => ({
  decryptApiKey: vi.fn(() => 'decrypted')
}));

vi.mock('../services/llmRequestMetrics.js', () => ({
  llmRequestMetrics: {
    record: vi.fn()
  }
}));

describe('LLMClient response extraction coverage', () => {
  it('handles OpenAI Responses API output_text', () => {
    const responseData = { output_text: 'Hello from responses' };
    const extracted = extractResponse('openai', responseData);
    expect(extracted).toBe('Hello from responses');
  });

  it('handles OpenAI Responses API output array content', () => {
    const responseData = {
      output: [
        {
          content: [{ text: 'Chunked response' }]
        }
      ]
    };
    const extracted = extractResponse('openai', responseData);
    expect(extracted).toBe('Chunked response');
  });

  it('handles OpenAI Responses API output array output_text', () => {
    const responseData = {
      output: [
        {
          content: [{ text: '', output_text: 'Output text response' }]
        }
      ]
    };
    const extracted = extractResponse('openai', responseData);
    expect(extracted).toBe('Output text response');
  });

  it('ignores non-array content entries in responses output', () => {
    const responseData = {
      output: [
        {
          content: 'not-array'
        }
      ]
    };
    const extracted = extractResponse('openai', responseData);
    expect(extracted).toBe(JSON.stringify(responseData));
  });

  it('handles output chunks with no text or output_text', () => {
    const responseData = {
      output: [
        {
          content: [{ text: '' }]
        }
      ]
    };
    const extracted = extractResponse('openai', responseData);
    expect(extracted).toBe(JSON.stringify(responseData));
  });

  it('uses reasoning steps when message content is empty', () => {
    const responseData = {
      message: {
        content: [],
        reasoning: {
          steps: [{ text: 'Step A' }, { text: 'Step B' }]
        }
      }
    };
    const extracted = extractResponse('ollama', responseData);
    expect(extracted).toBe('Step A\nStep B');
  });

  it('maps tool calls into JSON actions', () => {
    const cases = [
      {
        name: 'read_file',
        args: { path: 'README.md', reason: 'check' },
        expected: { action: 'read_file', path: 'README.md', reason: 'check' }
      },
      {
        name: 'list_dir',
        args: { path: 'src', reason: 'scan' },
        expected: { action: 'list_dir', path: 'src', reason: 'scan' }
      },
      {
        name: 'list_file',
        args: { path: 'src', reason: 'scan' },
        expected: { action: 'list_dir', path: 'src', reason: 'scan' }
      },
      {
        name: 'write_file',
        args: { path: 'src/app.js', content: 'hi', reason: 'update' },
        expected: { action: 'write_file', path: 'src/app.js', content: 'hi', reason: 'update' }
      },
      {
        name: 'list_goals',
        args: { reason: 'status' },
        expected: { action: 'list_goals', reason: 'status' }
      },
      {
        name: 'answer',
        args: { answer: 'ok' },
        expected: { action: 'answer', answer: 'ok' }
      },
      {
        name: 'unable',
        args: { explanation: 'nope' },
        expected: { action: 'unable', explanation: 'nope' }
      }
    ];

    cases.forEach(({ name, args, expected }) => {
      const responseData = {
        choices: [
          {
            tool_calls: [
              {
                function: {
                  name,
                  arguments: JSON.stringify(args)
                }
              }
            ]
          }
        ]
      };

      const extracted = extractResponse('openai', responseData);
      expect(extracted).toBe(JSON.stringify(expected));
    });
  });

  it('falls back to JSON for unknown providers', () => {
    const responseData = { unexpected: true };
    const extracted = extractResponse('unknown', responseData);
    expect(extracted).toBe(JSON.stringify(responseData));
  });

  it('builds error messages from response data', () => {
    const error = { response: { data: { error: { message: 'Boom' } } } };
    expect(getErrorMessage(error)).toBe('Boom');
  });

  it('stringifies response data when no error message exists', () => {
    const error = { response: { data: { error: { code: 'X' } } } };
    expect(getErrorMessage(error)).toBe(JSON.stringify({ error: { code: 'X' } }));
  });
});

describe('LLMClient generateResponse fallbacks', () => {
  let client;

  beforeEach(() => {
    client = new LLMClient();
    client.config = { provider: 'openai', model: 'gpt-test', api_url: 'https://api.openai.com/v1' };
    client.apiKey = 'sk-test';
    axios.mockReset();
  });

  it('falls back directly to /responses when prompted', async () => {
    client.makeAPIRequest = vi.fn().mockRejectedValue({
      response: { data: { error: { message: 'Use v1/responses endpoint' } } }
    });
    client.makeAPIRequestWithEndpoint = vi.fn().mockResolvedValue({
      data: { output_text: 'OK responses' }
    });

    const result = await client.generateResponse(
      [{ role: 'user', content: 'Hi' }],
      { __lucidcoderDisableToolBridge: true }
    );

    expect(result).toBe('OK responses');
  });

  it('builds completions prompt from non-array messages as empty', async () => {
    client.makeAPIRequest = vi.fn().mockRejectedValue({
      response: { data: { error: { message: 'This is not a chat model and thus not supported in the v1/chat/completions endpoint.' } } }
    });

    client.makeAPIRequestWithEndpoint = vi.fn().mockImplementation((config, apiKey, endpointPath, payload) => {
      // "not a chat model" now tries /responses first; let it fail so we reach /completions
      if (endpointPath === '/responses') {
        return Promise.reject(new Error('Responses not supported'));
      }
      if (endpointPath !== '/completions') {
        return Promise.reject(new Error('Unexpected endpoint'));
      }
      expect(payload.prompt).toBe('');
      return Promise.resolve({ data: { choices: [{ text: 'OK' }] } });
    });

    const result = await client.generateResponse(null, { __lucidcoderDisableToolBridge: true });
    expect(result).toBe('OK');
  });

  it('drops empty message content when building completions prompt', async () => {
    client.makeAPIRequest = vi.fn().mockRejectedValue({
      response: { data: { error: { message: 'This is not a chat model and thus not supported in the v1/chat/completions endpoint.' } } }
    });

    client.makeAPIRequestWithEndpoint = vi.fn().mockImplementation((config, apiKey, endpointPath, payload) => {
      // "not a chat model" now tries /responses first; let it fail so we reach /completions
      if (endpointPath === '/responses') {
        return Promise.reject(new Error('Responses not supported'));
      }
      if (endpointPath !== '/completions') {
        return Promise.reject(new Error('Unexpected endpoint'));
      }
      expect(payload.prompt).toBe('');
      return Promise.resolve({ data: { choices: [{ text: 'OK' }] } });
    });

    const result = await client.generateResponse(
      [{ role: 'user', content: '   ' }],
      { __lucidcoderDisableToolBridge: true }
    );
    expect(result).toBe('OK');
  });

  it('includes fallback error details when all fallbacks fail', async () => {
    client.makeAPIRequest = vi.fn().mockRejectedValue({
      response: {
        data: {
          error: {
            message: 'This is not a chat model and thus not supported in the v1/chat/completions endpoint.'
          }
        }
      }
    });

    // With "not a chat model", /responses is tried first, then /completions
    client.makeAPIRequestWithEndpoint = vi
      .fn()
      .mockRejectedValueOnce({ response: { data: { error: { message: 'Responses not supported' } } } })
      .mockRejectedValueOnce({ response: { data: { error: { message: 'Completions not supported' } } } });

    await expect(
      client.generateResponse([{ role: 'user', content: 'Hi' }], { __lucidcoderDisableToolBridge: true })
    ).rejects.toThrow('Fallback failed: Completions not supported');
  });

  it('skips fallback when provider is not in the OpenAI-compatible set', async () => {
    client.config = { model: 'other-model', api_url: 'https://example.com' };
    client.makeAPIRequest = vi.fn().mockRejectedValue(new Error('boom'));
    client.getErrorMessage = vi.fn(() => 'boom');

    await expect(
      client.generateResponse([{ role: 'user', content: 'Hi' }], { __lucidcoderDisableToolBridge: true })
    ).rejects.toThrow('LLM API Error: boom');
  });

  it('handles empty provider and empty error message when building fallback state', async () => {
    client.config = { model: 'other-model', api_url: 'https://example.com' };
    client.makeAPIRequest = vi.fn().mockRejectedValue(new Error('boom'));
    client.getErrorMessage = vi.fn(() => '');

    await expect(
      client.generateResponse([{ role: 'user', content: 'Hi' }], { __lucidcoderDisableToolBridge: true })
    ).rejects.toThrow('LLM API Error: ');
  });

  it('handles empty error messages for OpenAI-compatible providers', async () => {
    client.config = { provider: 'openai', model: 'gpt-test', api_url: 'https://api.openai.com/v1' };
    client.makeAPIRequest = vi.fn().mockRejectedValue(new Error('boom'));
    client.getErrorMessage = vi.fn(() => '');

    await expect(
      client.generateResponse([{ role: 'user', content: 'Hi' }], { __lucidcoderDisableToolBridge: true })
    ).rejects.toThrow('LLM API Error: ');
  });

  it('handles undefined error messages for OpenAI-compatible providers', async () => {
    client.config = { provider: 'openai', model: 'gpt-test', api_url: 'https://api.openai.com/v1' };
    client.makeAPIRequest = vi.fn().mockRejectedValue(new Error('boom'));
    client.getErrorMessage = vi.fn(() => undefined);

    await expect(
      client.generateResponse([{ role: 'user', content: 'Hi' }], { __lucidcoderDisableToolBridge: true })
    ).rejects.toThrow('LLM API Error: ');
  });
});

describe('LLMClient payload helpers', () => {
  it('builds prompt text while coercing roles and content', () => {
    const prompt = __testing.buildPromptFromMessages([
      { role: 'user', content: 'Hello' },
      { role: 123, content: 456 }
    ]);

    expect(prompt).toBe('USER: Hello');
  });

  it('falls back to empty prompt when messages are invalid', () => {
    const prompt = __testing.buildPromptFromMessages(null);
    expect(prompt).toBe('');
  });

  it('builds completions payload defaults when values are falsy', () => {
    const payload = __testing.buildCompletionsPayload(
      { messages: null, max_tokens: 0, temperature: undefined, top_p: undefined },
      'legacy-model'
    );

    expect(payload).toEqual({
      model: 'legacy-model',
      prompt: '',
      max_tokens: 1000,
      temperature: 0.7,
      top_p: 0.9
    });
  });

  it('builds completions payload using provided values', () => {
    const payload = __testing.buildCompletionsPayload(
      { messages: [{ role: 'user', content: 'Hi' }], max_tokens: 50, temperature: 0, top_p: 0.5 },
      'legacy-model'
    );

    expect(payload).toEqual({
      model: 'legacy-model',
      prompt: 'USER: Hi',
      max_tokens: 50,
      temperature: 0,
      top_p: 0.5
    });
  });

  it('builds responses payload defaults when values are missing', () => {
    const payload = __testing.buildResponsesPayload(
      { messages: 'not-array', max_tokens: 0, temperature: undefined, top_p: undefined },
      'responses-model'
    );

    expect(payload).toEqual({
      model: 'responses-model',
      input: [],
      max_output_tokens: 1000,
      temperature: 0.7,
      top_p: 0.9
    });
  });

  it('builds responses payload using provided values', () => {
    const payload = __testing.buildResponsesPayload(
      { messages: [{ role: 'user', content: 'Hi' }], max_tokens: 25, temperature: 0.2, top_p: 0.6 },
      'responses-model'
    );

    expect(payload).toEqual({
      model: 'responses-model',
      input: [{ role: 'user', content: 'Hi' }],
      max_output_tokens: 25,
      temperature: 0.2,
      top_p: 0.6
    });
  });
});

describe('LLMClient request helper branches', () => {
  it('defaults api_url to an empty base url for custom endpoints', async () => {
    axios.mockResolvedValue({ data: { ok: true } });
    const client = new LLMClient();
    await client.makeAPIRequestWithEndpoint({ provider: 'openai' }, 'sk-test', '/completions', { ok: true });

    expect(axios).toHaveBeenCalledWith(expect.objectContaining({
      url: '/completions'
    }));
  });
});
