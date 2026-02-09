import { describe, it, expect, beforeEach, vi } from 'vitest';
import axios from 'axios';
import { LLMClient } from '../llm-client.js';

vi.mock('axios', () => ({
  default: vi.fn()
}));

vi.mock('../database.js', () => ({
  db_operations: {
    logAPIRequest: vi.fn(),
    getActiveLLMConfig: vi.fn()
  }
}));

describe('LLMClient fallback routing', () => {
  beforeEach(() => {
    axios.mockReset();
  });

  it('falls back to /completions when chat endpoint rejects non-chat model', async () => {
    axios.mockImplementation((options) => {
      if (options.url.endsWith('/chat/completions')) {
        return Promise.reject({
          response: { data: { error: { message: 'This is not a chat model and thus not supported in the v1/chat/completions endpoint.' } } }
        });
      }
      if (options.url.endsWith('/completions')) {
        return Promise.resolve({ data: { choices: [{ text: 'OK' }] } });
      }
      // /responses is tried first for "not a chat model" — let it fail
      if (options.url.endsWith('/responses')) {
        return Promise.reject({ response: { data: { error: { message: 'Not available' } } } });
      }
      return Promise.reject(new Error('Unexpected endpoint'));
    });

    const client = new LLMClient();
    client.config = { provider: 'openai', model: 'legacy-model', api_url: 'https://api.openai.com/v1' };
    client.apiKey = 'sk-test';

    const result = await client.generateResponse([
      { role: 'user', content: 'Hello' }
    ], { max_tokens: 10, temperature: 0 });

    expect(result).toBe('OK');
  });

  it('tries /responses first for "not a chat model" and succeeds immediately', async () => {
    const endpointsCalled = [];
    axios.mockImplementation((options) => {
      if (options.url.endsWith('/chat/completions')) {
        return Promise.reject({
          response: { data: { error: { message: 'This is not a chat model and thus not supported in the v1/chat/completions endpoint.' } } }
        });
      }
      endpointsCalled.push(options.url);
      if (options.url.endsWith('/responses')) {
        return Promise.resolve({ data: { output_text: 'OK responses' } });
      }
      if (options.url.endsWith('/completions')) {
        return Promise.resolve({ data: { choices: [{ text: 'OK completions' }] } });
      }
      return Promise.reject(new Error('Unexpected endpoint'));
    });

    const client = new LLMClient();
    client.config = { provider: 'openai', model: 'o3', api_url: 'https://api.openai.com/v1' };
    client.apiKey = 'sk-test';

    const result = await client.generateResponse([
      { role: 'user', content: 'Hello' }
    ], { max_tokens: 10, temperature: 0 });

    expect(result).toBe('OK responses');
    // /responses should have been the first (and only) fallback endpoint tried
    expect(endpointsCalled).toEqual(['https://api.openai.com/v1/responses']);
  });

  it('falls back to /responses when completions also fails', async () => {
    axios.mockImplementation((options) => {
      if (options.url.endsWith('/chat/completions')) {
        return Promise.reject({
          response: { data: { error: { message: 'Not a chat model. See v1/chat/completions.' } } }
        });
      }
      if (options.url.endsWith('/completions')) {
        return Promise.reject({
          response: { data: { error: { message: 'Completions not supported' } } }
        });
      }
      if (options.url.endsWith('/responses')) {
        return Promise.resolve({ data: { output_text: 'OK responses' } });
      }
      return Promise.reject(new Error('Unexpected endpoint'));
    });

    const client = new LLMClient();
    client.config = { provider: 'openai', model: 'responses-model', api_url: 'https://api.openai.com/v1' };
    client.apiKey = 'sk-test';

    const result = await client.generateResponse([
      { role: 'user', content: 'Hello' }
    ], { max_tokens: 10, temperature: 0 });

    expect(result).toBe('OK responses');
  });

  it('falls back to /responses when error mentions v1/responses but not chat/completions', async () => {
    const endpointsCalled = [];
    axios.mockImplementation((options) => {
      if (options.url.endsWith('/chat/completions')) {
        return Promise.reject({
          response: { data: { error: { message: 'Please use the v1/responses endpoint for this model.' } } }
        });
      }
      endpointsCalled.push(options.url);
      if (options.url.endsWith('/responses')) {
        return Promise.resolve({ data: { output_text: 'OK via responses hint' } });
      }
      return Promise.reject(new Error('Unexpected endpoint'));
    });

    const client = new LLMClient();
    client.config = { provider: 'openai', model: 'o3', api_url: 'https://api.openai.com/v1' };
    client.apiKey = 'sk-test';

    const result = await client.generateResponse([
      { role: 'user', content: 'Hello' }
    ], { max_tokens: 10, temperature: 0 });

    expect(result).toBe('OK via responses hint');
    // shouldTryResponses is true, shouldTryCompletions is false, preferResponsesFirst is false
    // → only /responses is in the fallback chain
    expect(endpointsCalled).toEqual(['https://api.openai.com/v1/responses']);
  });

  it('retries /completions without temperature when unsupported', async () => {
    axios.mockImplementation((options) => {
      if (options.url.endsWith('/chat/completions')) {
        return Promise.reject({
          response: { data: { error: { message: 'Not a chat model. See v1/chat/completions.' } } }
        });
      }
      if (options.url.endsWith('/completions')) {
        if ('temperature' in options.data) {
          return Promise.reject({
            response: { data: { error: { message: "Unsupported parameter: 'temperature' is not supported with this model." } } }
          });
        }
        return Promise.resolve({ data: { choices: [{ text: 'OK' }] } });
      }
      return Promise.reject(new Error('Unexpected endpoint'));
    });

    const client = new LLMClient();
    client.config = { provider: 'openai', model: 'legacy-model', api_url: 'https://api.openai.com/v1' };
    client.apiKey = 'sk-test';

    const result = await client.generateResponse([
      { role: 'user', content: 'Hello' }
    ], { max_tokens: 10, temperature: 0.7 });

    expect(result).toBe('OK');
  });

  it('retries /completions without top_p when unsupported', async () => {
    axios.mockImplementation((options) => {
      if (options.url.endsWith('/chat/completions')) {
        return Promise.reject({
          response: { data: { error: { message: 'Not a chat model. See v1/chat/completions.' } } }
        });
      }
      if (options.url.endsWith('/completions')) {
        if ('top_p' in options.data) {
          return Promise.reject({
            response: { data: { error: { message: "Unsupported parameter: 'top_p' is not supported with this model." } } }
          });
        }
        return Promise.resolve({ data: { choices: [{ text: 'OK' }] } });
      }
      return Promise.reject(new Error('Unexpected endpoint'));
    });

    const client = new LLMClient();
    client.config = { provider: 'openai', model: 'legacy-model', api_url: 'https://api.openai.com/v1' };
    client.apiKey = 'sk-test';

    const result = await client.generateResponse([
      { role: 'user', content: 'Hello' }
    ], { max_tokens: 10, top_p: 0.9 });

    expect(result).toBe('OK');
  });

  it('falls back to /completions first when error mentions chat/completions but not "not a chat model"', async () => {
    const endpointsCalled = [];
    axios.mockImplementation((options) => {
      if (options.url.endsWith('/chat/completions')) {
        return Promise.reject({
          response: { data: { error: { message: 'Unsupported endpoint: v1/chat/completions is deprecated for this model.' } } }
        });
      }
      endpointsCalled.push(options.url);
      if (options.url.endsWith('/completions')) {
        return Promise.resolve({ data: { choices: [{ text: 'OK completions-first' }] } });
      }
      if (options.url.endsWith('/responses')) {
        return Promise.resolve({ data: { output_text: 'OK responses' } });
      }
      return Promise.reject(new Error('Unexpected endpoint'));
    });

    const client = new LLMClient();
    client.config = { provider: 'openai', model: 'some-model', api_url: 'https://api.openai.com/v1' };
    client.apiKey = 'sk-test';

    const result = await client.generateResponse([
      { role: 'user', content: 'Hello' }
    ], { max_tokens: 10, temperature: 0 });

    expect(result).toBe('OK completions-first');
    // /completions should be tried before /responses when preferResponsesFirst is false
    expect(endpointsCalled[0]).toBe('https://api.openai.com/v1/completions');
  });

  it('retries /responses and strips multiple unsupported parameters', async () => {
    let responsesCalls = 0;
    axios.mockImplementation((options) => {
      if (options.url.endsWith('/chat/completions')) {
        return Promise.reject({
          response: { data: { error: { message: 'Not a chat model. See v1/chat/completions.' } } }
        });
      }
      if (options.url.endsWith('/completions')) {
        return Promise.reject({
          response: { data: { error: { message: 'Completions not supported' } } }
        });
      }
      if (options.url.endsWith('/responses')) {
        responsesCalls += 1;
        if (responsesCalls === 1) {
          return Promise.reject({
            response: { data: { error: { message: "Unsupported parameter: 'top_p' is not supported with this model." } } }
          });
        }
        if (responsesCalls === 2) {
          return Promise.reject({
            response: { data: { error: { message: "Unsupported parameter: 'temperature' is not supported with this model." } } }
          });
        }
        return Promise.resolve({ data: { output_text: 'OK responses' } });
      }
      return Promise.reject(new Error('Unexpected endpoint'));
    });

    const client = new LLMClient();
    client.config = { provider: 'openai', model: 'responses-model', api_url: 'https://api.openai.com/v1' };
    client.apiKey = 'sk-test';

    const result = await client.generateResponse([
      { role: 'user', content: 'Hello' }
    ], { max_tokens: 10, temperature: 0.7, top_p: 0.9 });

    expect(result).toBe('OK responses');
  });
});

describe('LLMClient stored endpoint shortcut', () => {
  beforeEach(() => {
    axios.mockReset();
  });

  it('uses stored /responses endpoint directly without hitting /chat/completions', async () => {
    const endpointsCalled = [];
    axios.mockImplementation((options) => {
      endpointsCalled.push(options.url);
      if (options.url.endsWith('/responses')) {
        return Promise.resolve({ data: { output_text: 'Direct responses' } });
      }
      return Promise.reject(new Error('Unexpected endpoint'));
    });

    const client = new LLMClient();
    client.config = {
      provider: 'openai',
      model: 'o3',
      api_url: 'https://api.openai.com/v1',
      endpoint_path: '/responses'
    };
    client.apiKey = 'sk-test';

    const result = await client.generateResponse([
      { role: 'user', content: 'Hello' }
    ], { max_tokens: 10, temperature: 0 });

    expect(result).toBe('Direct responses');
    expect(endpointsCalled).toEqual(['https://api.openai.com/v1/responses']);
  });

  it('uses stored /completions endpoint directly without hitting /chat/completions', async () => {
    const endpointsCalled = [];
    axios.mockImplementation((options) => {
      endpointsCalled.push(options.url);
      if (options.url.endsWith('/completions')) {
        return Promise.resolve({ data: { choices: [{ text: 'Direct completions' }] } });
      }
      return Promise.reject(new Error('Unexpected endpoint'));
    });

    const client = new LLMClient();
    client.config = {
      provider: 'openai',
      model: 'legacy-model',
      api_url: 'https://api.openai.com/v1',
      endpoint_path: '/completions'
    };
    client.apiKey = 'sk-test';

    const result = await client.generateResponse([
      { role: 'user', content: 'Hello' }
    ], { max_tokens: 10, temperature: 0 });

    expect(result).toBe('Direct completions');
    expect(endpointsCalled).toEqual(['https://api.openai.com/v1/completions']);
  });

  it('strips unsupported params on stored endpoint before succeeding', async () => {
    let calls = 0;
    axios.mockImplementation((options) => {
      if (options.url.endsWith('/responses')) {
        calls += 1;
        if (calls === 1) {
          return Promise.reject({
            response: { data: { error: { message: "Unsupported parameter: 'temperature' is not supported with this model." } } }
          });
        }
        return Promise.resolve({ data: { output_text: 'Stripped ok' } });
      }
      return Promise.reject(new Error('Unexpected endpoint'));
    });

    const client = new LLMClient();
    client.config = {
      provider: 'openai',
      model: 'o4-mini',
      api_url: 'https://api.openai.com/v1',
      endpoint_path: '/responses'
    };
    client.apiKey = 'sk-test';

    const result = await client.generateResponse([
      { role: 'user', content: 'Hello' }
    ], { max_tokens: 10, temperature: 0.7 });

    expect(result).toBe('Stripped ok');
    expect(calls).toBe(2);
  });

  it('falls through to default path when stored endpoint fails', async () => {
    // Enable debug logging so the fallthrough console.log branch is exercised
    process.env.LUCIDCODER_LLM_DEBUG = '1';
    const endpointsCalled = [];
    axios.mockImplementation((options) => {
      endpointsCalled.push(options.url);
      if (options.url.endsWith('/responses')) {
        return Promise.reject({
          response: { data: { error: { message: 'Service unavailable' } } }
        });
      }
      if (options.url.endsWith('/chat/completions')) {
        return Promise.resolve({
          data: { choices: [{ message: { content: 'Fallback ok' } }] }
        });
      }
      return Promise.reject(new Error('Unexpected endpoint'));
    });

    const client = new LLMClient();
    client.config = {
      provider: 'openai',
      model: 'o3',
      api_url: 'https://api.openai.com/v1',
      endpoint_path: '/responses'
    };
    client.apiKey = 'sk-test';

    const result = await client.generateResponse([
      { role: 'user', content: 'Hello' }
    ], { max_tokens: 10, temperature: 0 });

    expect(result).toBe('Fallback ok');
    // Should have tried /responses first (stored), then fallen through to /chat/completions
    expect(endpointsCalled[0]).toBe('https://api.openai.com/v1/responses');
    expect(endpointsCalled).toContain('https://api.openai.com/v1/chat/completions');
    delete process.env.LUCIDCODER_LLM_DEBUG;
  });

  it('falls through to default path without debug logging', async () => {
    delete process.env.LUCIDCODER_LLM_DEBUG;
    axios.mockImplementation((options) => {
      if (options.url.endsWith('/responses')) {
        return Promise.reject({
          response: { data: { error: { message: 'Service unavailable' } } }
        });
      }
      if (options.url.endsWith('/chat/completions')) {
        return Promise.resolve({
          data: { choices: [{ message: { content: 'Silent fallback' } }] }
        });
      }
      return Promise.reject(new Error('Unexpected endpoint'));
    });

    const client = new LLMClient();
    client.config = {
      provider: 'openai',
      model: 'o3',
      api_url: 'https://api.openai.com/v1',
      endpoint_path: '/responses'
    };
    client.apiKey = 'sk-test';

    const result = await client.generateResponse([
      { role: 'user', content: 'Hello' }
    ], { max_tokens: 10, temperature: 0 });

    expect(result).toBe('Silent fallback');
  });

  it('sets resolvedEndpointPath when fallback discovers working endpoint', async () => {
    axios.mockImplementation((options) => {
      if (options.url.endsWith('/chat/completions')) {
        return Promise.reject({
          response: { data: { error: { message: 'This is not a chat model and thus not supported in the v1/chat/completions endpoint.' } } }
        });
      }
      if (options.url.endsWith('/responses')) {
        return Promise.resolve({ data: { output_text: 'Probe result' } });
      }
      return Promise.reject(new Error('Unexpected endpoint'));
    });

    const client = new LLMClient();
    client.config = { provider: 'openai', model: 'o3', api_url: 'https://api.openai.com/v1' };
    client.apiKey = 'sk-test';

    expect(client.resolvedEndpointPath).toBeNull();

    await client.generateResponse([
      { role: 'user', content: 'Hello' }
    ], { max_tokens: 10, temperature: 0 });

    expect(client.resolvedEndpointPath).toBe('/responses');
  });

  it('does not use shortcut when endpoint_path is null', async () => {
    const endpointsCalled = [];
    axios.mockImplementation((options) => {
      endpointsCalled.push(options.url);
      if (options.url.endsWith('/chat/completions')) {
        return Promise.resolve({
          data: { choices: [{ message: { content: 'Normal path' } }] }
        });
      }
      return Promise.reject(new Error('Unexpected endpoint'));
    });

    const client = new LLMClient();
    client.config = {
      provider: 'openai',
      model: 'gpt-4',
      api_url: 'https://api.openai.com/v1',
      endpoint_path: null
    };
    client.apiKey = 'sk-test';

    const result = await client.generateResponse([
      { role: 'user', content: 'Hello' }
    ], { max_tokens: 10, temperature: 0 });

    expect(result).toBe('Normal path');
    expect(endpointsCalled).toEqual(['https://api.openai.com/v1/chat/completions']);
  });
});
