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
