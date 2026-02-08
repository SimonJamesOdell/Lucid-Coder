import { describe, test, expect, beforeEach, beforeAll, vi } from 'vitest';
import axios from 'axios';

const axiosRequestMock = vi.hoisted(() => vi.fn());
const axiosPostMock = vi.hoisted(() => vi.fn());
vi.mock('axios', () => {
  const axiosFn = (...args) => axiosRequestMock(...args);
  axiosFn.post = axiosPostMock;
  return {
    __esModule: true,
    default: axiosFn,
    post: axiosPostMock
  };
});

const dbOperationsMock = vi.hoisted(() => ({
  getActiveLLMConfig: vi.fn(),
  logAPIRequest: vi.fn()
}));
vi.mock('../database.js', () => ({
  db_operations: dbOperationsMock
}));

const decryptApiKeyMock = vi.hoisted(() => vi.fn());
vi.mock('../encryption.js', () => ({
  decryptApiKey: decryptApiKeyMock
}));

let LLMClient;
let testingHelpers;
const mockedAxios = axios;

beforeAll(async () => {
  ({ LLMClient, __testing: testingHelpers } = await import('../llm-client.js'));
});

describe('LLM Client Tests', () => {
  let client;

  beforeEach(() => {
    client = new LLMClient();
    vi.clearAllMocks();
    axiosPostMock.mockReset();
    axiosRequestMock.mockReset();
    dbOperationsMock.getActiveLLMConfig.mockReset();
    dbOperationsMock.logAPIRequest.mockReset();
    decryptApiKeyMock.mockReset();
  });

  describe('Provider Configuration', () => {
    test('should support all major providers', () => {
      const supportedProviders = [
        'groq', 'openai', 'anthropic', 'google', 'cohere',
        'mistral', 'perplexity', 'together', 'ollama',
        'lmstudio', 'textgen', 'custom'
      ];

      supportedProviders.forEach(provider => {
        expect(() => {
          client.formatPayload(provider, 'test-model', 'test prompt', {});
        }).not.toThrow();
      });
    });

    test('should throw error for unsupported provider', () => {
      expect(() => {
        client.formatPayload('unsupported', 'test-model', 'test prompt', {});
      }).toThrow('Unsupported provider: unsupported');
    });

    test('shouldUseActionToolBridgeByDefault returns false for missing providers', () => {
      expect(client.shouldUseActionToolBridgeByDefault(undefined)).toBe(false);
      expect(client.shouldUseActionToolBridgeByDefault(null)).toBe(false);
      expect(client.shouldUseActionToolBridgeByDefault('')).toBe(false);
    });

    test('shouldUseActionToolBridgeByDefault returns true for supported providers (case-insensitive)', () => {
      expect(client.shouldUseActionToolBridgeByDefault('openai')).toBe(true);
      expect(client.shouldUseActionToolBridgeByDefault('OpenAI')).toBe(true);
      expect(client.shouldUseActionToolBridgeByDefault('groq')).toBe(true);
    });
  });
  
  describe('Internal helpers', () => {
    test('stripUnsupportedParams returns original payload when input is not an object', () => {
      const result = testingHelpers.stripUnsupportedParams(null, 'unsupported parameter: temperature');
      expect(result).toBeNull();
    });

    test('stripUnsupportedParams skips when error message lacks unsupported parameter text', () => {
      const payload = { temperature: 0.4 };
      const result = testingHelpers.stripUnsupportedParams(payload, 'rate limited');
      expect(result).toBe(payload);
    });

    test('stripUnsupportedParams removes temperature and top_p when flagged', () => {
      const payload = { temperature: 0.4, top_p: 0.9, max_tokens: 12 };
      const result = testingHelpers.stripUnsupportedParams(
        payload,
        'Unsupported parameter: temperature, top_p'
      );

      expect(result).toEqual({ max_tokens: 12 });
    });

    test('stripUnsupportedParams removes max token fields when flagged', () => {
      const payload = { max_tokens: 12, max_output_tokens: 24, top_p: 0.8 };
      const result = testingHelpers.stripUnsupportedParams(
        payload,
        'Unsupported parameter: max_tokens and max_output_tokens'
      );

      expect(result).toEqual({ top_p: 0.8 });
    });

    test('stripUnsupportedParams returns payload when unsupported keys are absent', () => {
      const payload = { temperature: 0.2 };
      const result = testingHelpers.stripUnsupportedParams(payload, 'Unsupported parameter: top_p');
      expect(result).toBe(payload);
    });

    test('stripUnsupportedParams detects topp alias', () => {
      const payload = { top_p: 0.3 };
      const result = testingHelpers.stripUnsupportedParams(payload, 'Unsupported parameter: topp');
      expect(result).toEqual({});
    });

    test('stripUnsupportedParams returns payload when error message is undefined', () => {
      const payload = { temperature: 0.2 };
      const result = testingHelpers.stripUnsupportedParams(payload, undefined);
      expect(result).toBe(payload);
    });

    test('makeAPIRequestWithEndpoint strips trailing slashes and uses fallback timeout', async () => {
      const previousTimeout = process.env.LUCIDCODER_LLM_FALLBACK_TIMEOUT_MS;
      process.env.LUCIDCODER_LLM_FALLBACK_TIMEOUT_MS = 'not-a-number';

      const fresh = new LLMClient();
      axiosRequestMock.mockResolvedValueOnce({ data: { ok: true } });

      await fresh.makeAPIRequestWithEndpoint(
        { provider: 'openai', api_url: 'http://example.test//', model: 'gpt-test' },
        'api-key',
        '/completions',
        { prompt: 'hi' }
      );

      const requestConfig = axiosRequestMock.mock.calls[0][0];
      expect(requestConfig.url).toBe('http://example.test/completions');
      expect(requestConfig.timeout).toBe(60000);

      process.env.LUCIDCODER_LLM_FALLBACK_TIMEOUT_MS = previousTimeout;
    });

    test('makeAPIRequestWithEndpoint uses default timeout for non-fallback endpoints', async () => {
      const fresh = new LLMClient();
      axiosRequestMock.mockResolvedValueOnce({ data: { ok: true } });

      await fresh.makeAPIRequestWithEndpoint(
        { provider: 'openai', api_url: 'http://example.test', model: 'gpt-test' },
        'api-key',
        '/chat/completions',
        { prompt: 'hi' }
      );

      const requestConfig = axiosRequestMock.mock.calls[0][0];
      expect(requestConfig.timeout).toBe(30000);
    });

    test('makeAPIRequestWithEndpoint honors configured fallback timeout', async () => {
      const previousTimeout = process.env.LUCIDCODER_LLM_FALLBACK_TIMEOUT_MS;
      process.env.LUCIDCODER_LLM_FALLBACK_TIMEOUT_MS = '45000';

      const fresh = new LLMClient();
      axiosRequestMock.mockResolvedValueOnce({ data: { ok: true } });

      await fresh.makeAPIRequestWithEndpoint(
        { provider: 'openai', api_url: 'http://example.test', model: 'gpt-test' },
        'api-key',
        '/responses',
        { input: [] }
      );

      const requestConfig = axiosRequestMock.mock.calls[0][0];
      expect(requestConfig.timeout).toBe(45000);

      process.env.LUCIDCODER_LLM_FALLBACK_TIMEOUT_MS = previousTimeout;
    });

    test('makeAPIRequestWithEndpoint falls back when timeout is zero', async () => {
      const previousTimeout = process.env.LUCIDCODER_LLM_FALLBACK_TIMEOUT_MS;
      process.env.LUCIDCODER_LLM_FALLBACK_TIMEOUT_MS = '0';

      const fresh = new LLMClient();
      axiosRequestMock.mockResolvedValueOnce({ data: { ok: true } });

      await fresh.makeAPIRequestWithEndpoint(
        { provider: 'openai', api_url: 'http://example.test', model: 'gpt-test' },
        'api-key',
        '/responses',
        { input: [] }
      );

      const requestConfig = axiosRequestMock.mock.calls[0][0];
      expect(requestConfig.timeout).toBe(60000);

      process.env.LUCIDCODER_LLM_FALLBACK_TIMEOUT_MS = previousTimeout;
    });

    test('constructor falls back to default dedup settings when env vars are invalid', () => {
      const previous = {
        LUCIDCODER_LLM_DEDUP_WINDOW_MS: process.env.LUCIDCODER_LLM_DEDUP_WINDOW_MS,
        LUCIDCODER_LLM_DEDUP_WINDOW_MS_DETERMINISTIC: process.env.LUCIDCODER_LLM_DEDUP_WINDOW_MS_DETERMINISTIC,
        LUCIDCODER_LLM_DEDUP_MAX_ENTRIES: process.env.LUCIDCODER_LLM_DEDUP_MAX_ENTRIES,
        LUCIDCODER_LLM_DEDUP_CACHE_NONDETERMINISTIC: process.env.LUCIDCODER_LLM_DEDUP_CACHE_NONDETERMINISTIC
      };

      process.env.LUCIDCODER_LLM_DEDUP_WINDOW_MS = 'not-a-number';
      process.env.LUCIDCODER_LLM_DEDUP_WINDOW_MS_DETERMINISTIC = '-5';
      process.env.LUCIDCODER_LLM_DEDUP_MAX_ENTRIES = '0';
      process.env.LUCIDCODER_LLM_DEDUP_CACHE_NONDETERMINISTIC = 'true';

      const fresh = new LLMClient();
      expect(fresh._dedupWindowMs).toBe(2500);
      expect(fresh._dedupWindowMsDeterministic).toBe(30000);
      expect(fresh._dedupMaxEntries).toBe(100);
      expect(fresh._dedupCacheNonDeterministic).toBe(true);

      process.env.LUCIDCODER_LLM_DEDUP_WINDOW_MS = previous.LUCIDCODER_LLM_DEDUP_WINDOW_MS;
      process.env.LUCIDCODER_LLM_DEDUP_WINDOW_MS_DETERMINISTIC = previous.LUCIDCODER_LLM_DEDUP_WINDOW_MS_DETERMINISTIC;
      process.env.LUCIDCODER_LLM_DEDUP_MAX_ENTRIES = previous.LUCIDCODER_LLM_DEDUP_MAX_ENTRIES;
      process.env.LUCIDCODER_LLM_DEDUP_CACHE_NONDETERMINISTIC = previous.LUCIDCODER_LLM_DEDUP_CACHE_NONDETERMINISTIC;
    });

    test('constructor honors valid dedup env vars and supports cache-nondeterministic "1" flag', () => {
      const previous = {
        LUCIDCODER_LLM_DEDUP_WINDOW_MS: process.env.LUCIDCODER_LLM_DEDUP_WINDOW_MS,
        LUCIDCODER_LLM_DEDUP_WINDOW_MS_DETERMINISTIC: process.env.LUCIDCODER_LLM_DEDUP_WINDOW_MS_DETERMINISTIC,
        LUCIDCODER_LLM_DEDUP_MAX_ENTRIES: process.env.LUCIDCODER_LLM_DEDUP_MAX_ENTRIES,
        LUCIDCODER_LLM_DEDUP_CACHE_NONDETERMINISTIC: process.env.LUCIDCODER_LLM_DEDUP_CACHE_NONDETERMINISTIC
      };

      process.env.LUCIDCODER_LLM_DEDUP_WINDOW_MS = '10';
      process.env.LUCIDCODER_LLM_DEDUP_WINDOW_MS_DETERMINISTIC = '20';
      process.env.LUCIDCODER_LLM_DEDUP_MAX_ENTRIES = '5';
      process.env.LUCIDCODER_LLM_DEDUP_CACHE_NONDETERMINISTIC = '1';

      const fresh = new LLMClient();
      expect(fresh._dedupWindowMs).toBe(10);
      expect(fresh._dedupWindowMsDeterministic).toBe(20);
      expect(fresh._dedupMaxEntries).toBe(5);
      expect(fresh._dedupCacheNonDeterministic).toBe(true);

      process.env.LUCIDCODER_LLM_DEDUP_WINDOW_MS = previous.LUCIDCODER_LLM_DEDUP_WINDOW_MS;
      process.env.LUCIDCODER_LLM_DEDUP_WINDOW_MS_DETERMINISTIC = previous.LUCIDCODER_LLM_DEDUP_WINDOW_MS_DETERMINISTIC;
      process.env.LUCIDCODER_LLM_DEDUP_MAX_ENTRIES = previous.LUCIDCODER_LLM_DEDUP_MAX_ENTRIES;
      process.env.LUCIDCODER_LLM_DEDUP_CACHE_NONDETERMINISTIC = previous.LUCIDCODER_LLM_DEDUP_CACHE_NONDETERMINISTIC;
    });

    test('_makeDedupedRequest bypasses dedup when LUCIDCODER_LLM_DEDUP is "false"', async () => {
      const previous = {
        LUCIDCODER_LLM_DEDUP: process.env.LUCIDCODER_LLM_DEDUP
      };
      process.env.LUCIDCODER_LLM_DEDUP = 'false';

      const fresh = new LLMClient();
      fresh.config = { provider: 'openai', model: 'gpt-test' };

      const fn = vi.fn().mockResolvedValue({ data: { ok: true } });
      const payload = { messages: [{ role: 'user', content: 'hi' }] };

      await fresh._makeDedupedRequest(payload, {}, fn);
      await fresh._makeDedupedRequest(payload, {}, fn);

      expect(fn).toHaveBeenCalledTimes(2);

      process.env.LUCIDCODER_LLM_DEDUP = previous.LUCIDCODER_LLM_DEDUP;
    });

    test('_makeDedupedRequest bypasses dedup when LUCIDCODER_LLM_DEDUP is "0"', async () => {
      const previous = {
        LUCIDCODER_LLM_DEDUP: process.env.LUCIDCODER_LLM_DEDUP
      };
      process.env.LUCIDCODER_LLM_DEDUP = '0';

      const fresh = new LLMClient();
      fresh.config = { provider: 'openai', model: 'gpt-test' };

      const fn = vi.fn().mockResolvedValue({ data: { ok: true } });
      const payload = { messages: [{ role: 'user', content: 'hi' }] };

      await fresh._makeDedupedRequest(payload, {}, fn);
      await fresh._makeDedupedRequest(payload, {}, fn);

      expect(fn).toHaveBeenCalledTimes(2);

      process.env.LUCIDCODER_LLM_DEDUP = previous.LUCIDCODER_LLM_DEDUP;
    });

    test('_makeDedupedRequest bypasses dedup when __lucidcoderDisableDedup is true', async () => {
      const fresh = new LLMClient();
      fresh.config = { provider: 'openai', model: 'gpt-test' };

      const fn = vi.fn().mockResolvedValue({ data: { ok: true } });
      const payload = { messages: [{ role: 'user', content: 'hi' }] };

      await fresh._makeDedupedRequest(payload, { __lucidcoderDisableDedup: true }, fn);
      await fresh._makeDedupedRequest(payload, { __lucidcoderDisableDedup: true }, fn);

      expect(fn).toHaveBeenCalledTimes(2);
    });

    test('_makeDedupedRequest returns recent-cache hit for deterministic payloads', async () => {
      const fresh = new LLMClient();
      fresh.config = { provider: 'openai', model: 'gpt-test' };

      const fn = vi.fn().mockResolvedValue({ data: { answer: 'ok' } });
      const payload = { messages: [{ role: 'user', content: 'hi' }], temperature: 0 };

      const nowSpy = vi.spyOn(Date, 'now');
      nowSpy.mockReturnValueOnce(1_000_000); // first call
      const first = await fresh._makeDedupedRequest(payload, {}, fn);
      nowSpy.mockReturnValueOnce(1_000_050); // within default deterministic window
      const second = await fresh._makeDedupedRequest(payload, {}, fn);

      expect(fn).toHaveBeenCalledTimes(1);
      expect(first).toEqual({ data: { answer: 'ok' } });
      expect(second).toEqual({ data: { answer: 'ok' } });

      nowSpy.mockRestore();
    });

    test('_makeDedupedRequest falls back to empty provider/model when config is missing', async () => {
      const fresh = new LLMClient();
      // Intentionally leave fresh.config = null to exercise fallback branches.

      const fn = vi.fn().mockResolvedValue({ data: { ok: true } });
      const payload = { messages: [{ role: 'user', content: 'hi' }], temperature: 0 };

      const result = await fresh._makeDedupedRequest(payload, undefined, fn);
      expect(result).toEqual({ data: { ok: true } });
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test('_makeDedupedRequest trims recent-cache and sorts entries when exceeding max', async () => {
      const fresh = new LLMClient();
      fresh.config = { provider: 'openai', model: 'gpt-test' };
      fresh._dedupMaxEntries = 1;

      // Seed malformed cache entries to exercise sort comparator fallbacks:
      // - null entry exercises optional-chain short-circuit
      // - missing timestamp exercises undefined -> || 0 fallback
      // - timestamp 0 exercises falsy -> || 0 fallback
      fresh._dedupRecent.set('seed-null', null);
      fresh._dedupRecent.set('seed-missing', { data: { ok: false } });
      fresh._dedupRecent.set('seed-zero', { timestamp: 0, data: { ok: false } });
      fresh._dedupRecent.set('seed-late', { timestamp: 999, data: { ok: false } });

      const fn = vi.fn().mockImplementation(async () => ({ data: { ok: true } }));

      const nowSpy = vi.spyOn(Date, 'now');
      nowSpy.mockReturnValueOnce(1_000_000); // request timestamp
      await fresh._makeDedupedRequest({ messages: [{ role: 'user', content: 'a' }], temperature: 0 }, {}, fn);

      expect(fn).toHaveBeenCalledTimes(1);
      expect(fresh._dedupRecent.size).toBeLessThanOrEqual(1);

      nowSpy.mockRestore();
    });

    test('_stableStringify handles primitives, bigint, circular references, and filters __lucidcoder keys', () => {
      expect(client._stableStringify(null)).toBe('null');
      expect(client._stableStringify(undefined)).toBe(undefined);
      expect(client._stableStringify(true)).toBe('true');
      expect(client._stableStringify(123)).toBe('123');
      expect(client._stableStringify(10n)).toBe('"10"');
      expect(client._stableStringify(function noop() {})).toContain('function');

      const obj = { b: 1, a: 2, __lucidcoderSecret: 'drop' };
      expect(client._stableStringify(obj)).toBe('{"a":2,"b":1}');

      const circular = {};
      circular.self = circular;
      expect(client._stableStringify(circular)).toContain('[Circular]');
    });

    test('getErrorMessage stringifies response bodies and tolerates circular data', () => {
      expect(client.getErrorMessage({ response: { data: { detail: 'bad' } } })).toBe('bad');
      expect(client.getErrorMessage({ response: { data: { foo: 'bar' } } })).toBe('{"foo":"bar"}');

      const circular = {};
      circular.self = circular;
      expect(client.getErrorMessage({ response: { data: circular } })).toBe('Unknown error');
    });

    test('_isDeterministicPayload recognizes temperature sources and handles non-objects', () => {
      expect(client._isDeterministicPayload(null)).toBe(false);
      expect(client._isDeterministicPayload('nope')).toBe(false);

      expect(client._isDeterministicPayload({ temperature: 0 })).toBe(true);
      expect(client._isDeterministicPayload({ temperature: 0.7 })).toBe(false);
      expect(client._isDeterministicPayload({ generationConfig: { temperature: 0 } })).toBe(true);
      expect(client._isDeterministicPayload({ options: { temperature: 0 } })).toBe(true);
    });

    test('_isDeterministicPayload treats NaN temperatures as non-deterministic (no fallback)', () => {
      expect(client._isDeterministicPayload({ temperature: Number.NaN, generationConfig: { temperature: 0 } })).toBe(false);
    });

    test('_isDeterministicPayload evaluates options temperature fallback when not numeric', () => {
      expect(client._isDeterministicPayload({ options: { temperature: '0' } })).toBe(false);
    });
  });

  describe('Connection testing', () => {
    const baseConfig = {
      provider: 'groq',
      model: 'mixtral',
      api_url: 'https://example.invalid'
    };

    test('testConnection surfaces provider error messages and logs failures', async () => {
      client.config = baseConfig;
      client.apiKey = 'plain-key';
      const makeSpy = vi.spyOn(client, 'makeAPIRequest').mockRejectedValueOnce({
        response: {
          status: 429,
          statusText: 'Too Many Requests',
          data: { message: 'Rate limited' }
        }
      });

      await expect(client.testConnection()).rejects.toThrow('Rate limited');
      expect(dbOperationsMock.logAPIRequest).toHaveBeenCalledWith(
        expect.objectContaining({ requestType: 'test', success: false, errorMessage: 'Rate limited' })
      );
      makeSpy.mockRestore();
    });

    test('testConnection reports network errors when no response is received', async () => {
      client.config = baseConfig;
      client.apiKey = 'plain-key';
      const makeSpy = vi.spyOn(client, 'makeAPIRequest').mockRejectedValueOnce({ request: {}, message: 'offline' });

      await expect(client.testConnection()).rejects.toThrow('No response from API server - check URL and network connectivity');
      makeSpy.mockRestore();
    });

    test('testConnection reports setup errors when request cannot be created', async () => {
      client.config = baseConfig;
      client.apiKey = 'plain-key';
      const makeSpy = vi.spyOn(client, 'makeAPIRequest').mockRejectedValueOnce({ message: 'boom' });

      await expect(client.testConnection()).rejects.toThrow('boom');
      makeSpy.mockRestore();
    });
  });

  describe('Payload Formatting', () => {
    const testConfig = {
      maxTokens: 100,
      temperature: 0.7,
      topP: 0.9
    };

    test('should format OpenAI-compatible payload correctly', () => {
      const payload = client.formatPayload('groq', 'llama-3.1-70b-versatile', 'Hello world', testConfig);
      
      expect(payload).toEqual({
        model: 'llama-3.1-70b-versatile',
        messages: [
          { role: 'user', content: 'Hello world' }
        ],
        max_tokens: 100,
        temperature: 0.7,
        top_p: 0.9
      });
    });

    test('should format Anthropic payload correctly', () => {
      const payload = client.formatPayload('anthropic', 'claude-3-5-sonnet-20241022', 'Hello world', testConfig);
      
      expect(payload).toEqual({
        model: 'claude-3-5-sonnet-20241022',
        messages: [
          { role: 'user', content: 'Hello world' }
        ],
        max_tokens: 100,
        temperature: 0.7,
        top_p: 0.9
      });
    });

    test('should format Google payload correctly', () => {
      const payload = client.formatPayload('google', 'gemini-1.5-pro', 'Hello world', testConfig);
      
      expect(payload).toEqual({
        contents: [
          {
            parts: [
              { text: 'Hello world' }
            ]
          }
        ],
        generationConfig: {
          maxOutputTokens: 100,
          temperature: 0.7,
          topP: 0.9
        }
      });
    });

    test('should format Cohere payload correctly', () => {
      const payload = client.formatPayload('cohere', 'command-r-plus', 'Hello world', testConfig);
      
      expect(payload).toEqual({
        model: 'command-r-plus',
        message: 'Hello world',
        max_tokens: 100,
        temperature: 0.7,
        p: 0.9
      });
    });
  });

  describe('Payload defaults and validation', () => {
    const basePayload = () => ({
      messages: [{ role: 'user', content: 'Ping' }]
    });

    test('formatPayloadInternal throws when payload is missing', () => {
      expect(() => client.formatPayloadInternal('groq', null, {}))
        .toThrow('Unsupported provider: groq');
    });

    test('anthropic formatting falls back to default limits', () => {
      const payload = basePayload();
      const formatted = client.formatPayloadInternal('anthropic', payload, { model: 'claude-3' });

      expect(formatted).toMatchObject({
        model: 'claude-3',
        max_tokens: 1000,
        temperature: 0.7,
        top_p: 0.9
      });
    });

    test('google formatting fills generation defaults', () => {
      const payload = basePayload();
      const formatted = client.formatPayloadInternal('google', payload, { model: 'gemini' });

      expect(formatted.generationConfig).toEqual({
        maxOutputTokens: 1000,
        temperature: 0.7,
        topP: 0.9
      });
    });

    test('cohere formatting defaults message controls', () => {
      const payload = basePayload();
      const formatted = client.formatPayloadInternal('cohere', payload, { model: 'command' });

      expect(formatted).toMatchObject({
        max_tokens: 1000,
        temperature: 0.7,
        p: 0.9
      });
    });

    test('ollama formatting defaults generation options', () => {
      const payload = basePayload();
      const formatted = client.formatPayloadInternal('ollama', payload, { model: 'llama3' });

      expect(formatted.options).toMatchObject({
        temperature: 0.7,
        num_predict: 1000
      });
    });
  });

  describe('Payload sanitization', () => {
    test('sanitizePayload returns payload unchanged when payload is not an object', () => {
      expect(client.sanitizePayload('openai', null)).toBeNull();
      expect(client.sanitizePayload('openai', 'hello')).toBe('hello');
      expect(client.sanitizePayload('openai', 123)).toBe(123);
    });

    test('sanitizePayload strips tool fields and drops empty response_format objects', () => {
      const payload = {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [{ type: 'function' }],
        tool_choice: 'auto',
        functions: [{ name: 'noop' }],
        function_call: { name: 'noop' },
        parallel_tool_calls: [{ id: '1' }],
        response_format: {}
      };

      const sanitized = client.sanitizePayload('openai', payload);

      expect(sanitized).toMatchObject({
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'Hi' }]
      });
      expect(sanitized.tools).toBeUndefined();
      expect(sanitized.tool_choice).toBeUndefined();
      expect(sanitized.functions).toBeUndefined();
      expect(sanitized.function_call).toBeUndefined();
      expect(sanitized.parallel_tool_calls).toBeUndefined();
      expect(sanitized.response_format).toBeUndefined();

      // Ensure original object wasn't mutated (sanitizePayload clones via spread).
      expect(payload.tools).toBeDefined();
      expect(payload.response_format).toEqual({});
    });

    test('sanitizePayload preserves non-empty response_format objects', () => {
      const payload = {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'Hi' }],
        response_format: { type: 'json_object' }
      };

      const sanitized = client.sanitizePayload('openai', payload);

      expect(sanitized.response_format).toEqual({ type: 'json_object' });
    });

    test('sanitizePayload strips tool metadata from nested messages', () => {
      const payload = {
        model: 'gpt-test',
        messages: [
          {
            role: 'assistant',
            content: 'Hello',
            tool_calls: [{ id: '1', type: 'function', function: { name: 'noop', arguments: '{}' } }]
          },
          {
            role: 'user',
            content: 'Next'
          }
        ]
      };

      const sanitized = client.sanitizePayload('openai', payload);
      expect(sanitized.messages).toEqual([
        { role: 'assistant', content: 'Hello' },
        { role: 'user', content: 'Next' }
      ]);
    });

    test('sanitizePayload strips __lucidcoder flags but preserves tools when tool bridge is allowed', () => {
      const payload = {
        __lucidcoderToolBridge: true,
        __lucidcoderInternal: 'secret',
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [{ type: 'function', function: { name: 'respond_with_text' } }],
        tool_choice: 'auto'
      };

      const sanitized = client.sanitizePayload('openai', payload);

      expect(sanitized.__lucidcoderToolBridge).toBeUndefined();
      expect(sanitized.__lucidcoderInternal).toBeUndefined();
      expect(sanitized.tools).toEqual(payload.tools);
      expect(sanitized.tool_choice).toBe('auto');
    });

    test('sanitizePayload preserves non-empty message names', () => {
      const payload = {
        model: 'gpt-test',
        messages: [
          { role: 'user', content: 'Hi', name: 'Alice' },
          { role: 'assistant', content: 'Yo', name: '   ' }
        ]
      };

      const sanitized = client.sanitizePayload('openai', payload);
      expect(sanitized.messages).toEqual([
        { role: 'user', content: 'Hi', name: 'Alice' },
        { role: 'assistant', content: 'Yo' }
      ]);
    });

    test('sanitizePayload leaves messages untouched when messages is not an array', () => {
      const payload = {
        model: 'gpt-test',
        messages: 'not-an-array',
        __lucidcoderInternal: true
      };

      const sanitized = client.sanitizePayload('openai', payload);
      expect(sanitized.__lucidcoderInternal).toBeUndefined();
      expect(sanitized.messages).toBe('not-an-array');
    });
  });

  describe('Error message extraction', () => {
    test('getErrorMessage returns string errors directly', () => {
      expect(client.getErrorMessage('boom')).toBe('boom');
    });

    test('getErrorMessage returns error.message for non-string errors', () => {
      expect(client.getErrorMessage(new Error('bad'))).toBe('bad');
    });

    test('getErrorMessage returns Unknown error when response data cannot be stringified', () => {
      const circular = {};
      circular.self = circular;
      const error = {
        response: {
          data: circular
        }
      };

      expect(client.getErrorMessage(error)).toBe('Unknown error');
    });

    test('getErrorMessage returns Unknown error when no data and no message exist', () => {
      expect(client.getErrorMessage({})).toBe('Unknown error');
    });
  });

  describe('Tool bridge payload builders', () => {
    test('buildActionToolBridgePayload falls back to empty base for non-object payloads', () => {
      const built = client.buildActionToolBridgePayload(null);
      expect(built).toMatchObject({
        __lucidcoderToolBridge: true,
        tool_choice: 'auto',
        tools: expect.any(Array)
      });
    });

    test('buildToolBridgePayload falls back to empty base for non-object payloads', () => {
      const built = client.buildToolBridgePayload(null);
      expect(built).toMatchObject({
        __lucidcoderToolBridge: true,
        tools: expect.any(Array)
      });
      expect(built.tool_choice).toEqual({ type: 'function', function: { name: 'respond_with_text' } });
    });
  });

  describe('Tool bridge extraction', () => {
    test('extractResponse returns respond_with_text tool argument when present', () => {
      const responseData = {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'respond_with_text',
                    arguments: JSON.stringify({ text: 'OK from tool' })
                  }
                }
              ]
            }
          }
        ]
      };

      expect(client.extractResponse('openai', responseData)).toBe('OK from tool');
    });

    test('extractResponse falls back to message content when tool arguments are not a string', () => {
      const responseData = {
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Fallback content',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'json',
                    arguments: { text: 'not a string' }
                  }
                }
              ]
            }
          }
        ]
      };

      expect(client.extractResponse('openai', responseData)).toBe('Fallback content');
    });

    test('extractResponse ignores empty respond_with_text tool payload and falls back to message content', () => {
      const responseData = {
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Fallback from message',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'respond_with_text',
                    arguments: JSON.stringify({})
                  }
                }
              ]
            }
          }
        ]
      };

      expect(client.extractResponse('openai', responseData)).toBe('Fallback from message');
    });

    test('extractResponse ignores unknown tool names and falls back to message content', () => {
      const responseData = {
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Fallback for unknown tool',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'some_tool',
                    arguments: JSON.stringify({})
                  }
                }
              ]
            }
          }
        ]
      };

      expect(client.extractResponse('openai', responseData)).toBe('Fallback for unknown tool');
    });
    
    test('extractResponse returns JSON text from json tool alias', () => {
      const payload = {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: 'json',
                    arguments: JSON.stringify({ json: { kind: 'feature' } })
                  }
                }
              ]
            }
          }
        ]
      };

      expect(client.extractResponse('openai', payload)).toBe(JSON.stringify({ kind: 'feature' }));
    });

    test('extractResponse supports json tool value/data fallbacks', () => {
      const payloadValue = {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: 'json',
                    arguments: JSON.stringify({ value: { ok: 1 } })
                  }
                }
              ]
            }
          }
        ]
      };
      const payloadData = {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: 'json',
                    arguments: JSON.stringify({ data: [1, 2] })
                  }
                }
              ]
            }
          }
        ]
      };

      expect(client.extractResponse('openai', payloadValue)).toBe(JSON.stringify({ ok: 1 }));
      expect(client.extractResponse('openai', payloadData)).toBe(JSON.stringify([1, 2]));
    });

    test('extractResponse stringifies parsed object when json tool omits json/value/data', () => {
      const payload = {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: 'json',
                    arguments: JSON.stringify({ hello: 'world' })
                  }
                }
              ]
            }
          }
        ]
      };

      expect(client.extractResponse('openai', payload)).toBe(JSON.stringify({ hello: 'world' }));
    });

    test('extractResponse stringifies when tool function name is not a string', () => {
      const payload = {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: null,
                    arguments: JSON.stringify({ text: 'ignored' })
                  }
                }
              ]
            }
          }
        ]
      };

      expect(client.extractResponse('openai', payload)).toBe(JSON.stringify(payload));
    });

    test('extractResponse returns inline text fields from json tool alias when present', () => {
      const payload = {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: 'json',
                    arguments: JSON.stringify({ text: 'Hello from json tool' })
                  }
                }
              ]
            }
          }
        ]
      };

      expect(client.extractResponse('openai', payload)).toBe('Hello from json tool');
    });

    test('extractResponse falls back to String(payload) when JSON.stringify throws for json tool', () => {
      const stringifySpy = vi.spyOn(JSON, 'stringify').mockImplementationOnce(() => {
        throw new Error('stringify boom');
      });

      const payload = {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: 'json',
                    arguments: '{"json":{"kind":"feature"}}'
                  }
                }
              ]
            }
          }
        ]
      };

      expect(client.extractResponse('openai', payload)).toBe('[object Object]');
      stringifySpy.mockRestore();
    });

    test('extractResponse uses String(parsed) when json tool stringify throws and payload is undefined', () => {
      const stringifySpy = vi.spyOn(JSON, 'stringify').mockImplementationOnce(() => {
        throw new Error('stringify boom');
      });

      const payload = {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: 'json',
                    arguments: '{"hello":"world"}'
                  }
                }
              ]
            }
          }
        ]
      };

      expect(client.extractResponse('openai', payload)).toBe('[object Object]');
      stringifySpy.mockRestore();
    });

    test('extractResponse extracts response tool output from answer/content/message fields', () => {
      const payloadAnswer = {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: 'response',
                    arguments: JSON.stringify({ answer: 'A' })
                  }
                }
              ]
            }
          }
        ]
      };
      const payloadContent = {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: 'response',
                    arguments: JSON.stringify({ content: 'C' })
                  }
                }
              ]
            }
          }
        ]
      };
      const payloadMessage = {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: 'response',
                    arguments: JSON.stringify({ message: 'M' })
                  }
                }
              ]
            }
          }
        ]
      };

      expect(client.extractResponse('openai', payloadAnswer)).toBe('A');
      expect(client.extractResponse('openai', payloadContent)).toBe('C');
      expect(client.extractResponse('openai', payloadMessage)).toBe('M');
    });

    test('extractResponse translates read_file tool call into JSON action text', () => {
      const responseData = {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'read_file',
                    arguments: JSON.stringify({ path: 'README.md', reason: 'Need context' })
                  }
                }
              ]
            }
          }
        ]
      };

      const extracted = client.extractResponse('openai', responseData);
      expect(extracted).toContain('"action":"read_file"');
      expect(extracted).toContain('"path":"README.md"');
    });

    test('extractResponse translates write_file tool call into JSON action text', () => {
      const responseData = {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: 'write_file',
                    arguments: JSON.stringify({ path: 'notes.txt', content: 'abc', reason: 'save' })
                  }
                }
              ]
            }
          }
        ]
      };

      const extracted = client.extractResponse('openai', responseData);
      expect(extracted).toContain('"action":"write_file"');
      expect(extracted).toContain('"path":"notes.txt"');
      expect(extracted).toContain('"content":"abc"');
    });

    test('extractResponse supports alternate tool argument field names (filePath/filename/text) and omits missing reason', () => {
      const readFilePayload = {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: 'read_file',
                    arguments: JSON.stringify({ filePath: 'README.md' })
                  }
                }
              ]
            }
          }
        ]
      };

      const readExtracted = client.extractResponse('openai', readFilePayload);
      expect(readExtracted).toContain('"action":"read_file"');
      expect(readExtracted).toContain('"path":"README.md"');

      const writeFilePayload = {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: 'write_file',
                    arguments: JSON.stringify({ filename: 'out.txt', text: 'xyz' })
                  }
                }
              ]
            }
          }
        ]
      };

      const writeExtracted = client.extractResponse('openai', writeFilePayload);
      expect(writeExtracted).toContain('"action":"write_file"');
      expect(writeExtracted).toContain('"path":"out.txt"');
      expect(writeExtracted).toContain('"content":"xyz"');
      expect(writeExtracted).not.toContain('"reason"');
    });

    test('extractResponse translates list_goals tool call into JSON action text', () => {
      const responseData = {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: 'list_goals',
                    arguments: JSON.stringify({ reason: 'need state' })
                  }
                }
              ]
            }
          }
        ]
      };

      expect(client.extractResponse('openai', responseData)).toContain('"action":"list_goals"');
    });

    test('extractResponse translates list_dir tool call into JSON action text', () => {
      const responseData = {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: 'list_dir',
                    arguments: JSON.stringify({ path: 'frontend/src', reason: 'inspect' })
                  }
                }
              ]
            }
          }
        ]
      };

      const extracted = client.extractResponse('openai', responseData);
      expect(extracted).toContain('"action":"list_dir"');
      expect(extracted).toContain('"path":"frontend/src"');
    });

    test('extractResponse translates list_directory tool call into JSON action text', () => {
      const responseData = {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: 'list_directory',
                    arguments: JSON.stringify({ path: 'frontend/src', reason: 'inspect' })
                  }
                }
              ]
            }
          }
        ]
      };

      const extracted = client.extractResponse('openai', responseData);
      expect(extracted).toContain('"action":"list_dir"');
      expect(extracted).toContain('"path":"frontend/src"');
    });

    test('extractResponse omits list_directory reason when missing', () => {
      const responseData = {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: 'list_directory',
                    arguments: JSON.stringify({ path: 'frontend/src' })
                  }
                }
              ]
            }
          }
        ]
      };

      const extracted = client.extractResponse('openai', responseData);
      expect(extracted).toContain('"action":"list_dir"');
      expect(extracted).toContain('"path":"frontend/src"');
      expect(extracted).not.toContain('"reason"');
    });

    test('extractResponse treats list_file tool call as list_dir JSON action text', () => {
      const responseData = {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: 'list_file',
                    arguments: JSON.stringify({ path: 'frontend/src', reason: 'inspect' })
                  }
                }
              ]
            }
          }
        ]
      };

      const extracted = client.extractResponse('openai', responseData);
      expect(extracted).toContain('"action":"list_dir"');
      expect(extracted).toContain('"path":"frontend/src"');
    });

    test('extractResponse omits list_file reason when missing', () => {
      const responseData = {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: 'list_file',
                    arguments: JSON.stringify({ path: 'frontend/src' })
                  }
                }
              ]
            }
          }
        ]
      };

      const extracted = client.extractResponse('openai', responseData);
      expect(extracted).toContain('"action":"list_dir"');
      expect(extracted).toContain('"path":"frontend/src"');
      expect(extracted).not.toContain('"reason"');
    });

    test('extractResponse omits list_goals reason when missing', () => {
      const responseData = {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: 'list_goals',
                    arguments: JSON.stringify({})
                  }
                }
              ]
            }
          }
        ]
      };

      const extracted = client.extractResponse('openai', responseData);
      expect(extracted).toContain('"action":"list_goals"');
      expect(extracted).not.toContain('"reason"');
    });

    test('extractResponse translates answer tool call into JSON action text', () => {
      const responseData = {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: 'answer',
                    arguments: JSON.stringify({ answer: 'final', text: 'ignored' })
                  }
                }
              ]
            }
          }
        ]
      };

      const extracted = client.extractResponse('openai', responseData);
      expect(extracted).toContain('"action":"answer"');
      expect(extracted).toContain('"answer":"final"');
    });

    test('extractResponse uses text field as answer when answer is missing', () => {
      const responseData = {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: 'answer',
                    arguments: JSON.stringify({ text: 'fallback answer' })
                  }
                }
              ]
            }
          }
        ]
      };

      const extracted = client.extractResponse('openai', responseData);
      expect(extracted).toContain('"action":"answer"');
      expect(extracted).toContain('"answer":"fallback answer"');
    });

    test('extractResponse translates unable tool call into JSON action text', () => {
      const responseData = {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: 'unable',
                    arguments: JSON.stringify({ explanation: 'nope' })
                  }
                }
              ]
            }
          }
        ]
      };

      const extracted = client.extractResponse('openai', responseData);
      expect(extracted).toContain('"action":"unable"');
      expect(extracted).toContain('"explanation":"nope"');
    });

    test('extractResponse falls back to reason/message when unable explanation is missing', () => {
      const responseData = {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: 'unable',
                    arguments: JSON.stringify({ message: 'no permission' })
                  }
                }
              ]
            }
          }
        ]
      };

      const extracted = client.extractResponse('openai', responseData);
      expect(extracted).toContain('"action":"unable"');
      expect(extracted).toContain('"explanation":"no permission"');
    });

    test('extractResponse falls back to JSON stringify when tool name is blank', () => {
      const responseData = {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: '   ',
                    arguments: JSON.stringify({ text: 'ignored' })
                  }
                }
              ]
            }
          }
        ]
      };

      expect(client.extractResponse('openai', responseData)).toBe(JSON.stringify(responseData));
    });
  });

  describe('Header construction', () => {
    test.each([
      ['openai', 'openai-key', { 'Content-Type': 'application/json', Authorization: 'Bearer openai-key' }],
      ['groq', 'secret', { 'Content-Type': 'application/json', Authorization: 'Bearer secret' }],
      ['anthropic', 'key', {
        'Content-Type': 'application/json',
        Authorization: 'Bearer key',
        'anthropic-version': '2023-06-01'
      }],
      ['google', 'g-key', { 'Content-Type': 'application/json', Authorization: 'Bearer g-key' }],
      ['cohere', 'c-key', { 'Content-Type': 'application/json', Authorization: 'Bearer c-key' }],
      ['mistral', 'm-key', { 'Content-Type': 'application/json', Authorization: 'Bearer m-key' }],
      ['custom', null, { 'Content-Type': 'application/json' }],
      ['custom', 'token', { 'Content-Type': 'application/json', Authorization: 'Bearer token' }],
      ['openai', 'Bearer abc123', { 'Content-Type': 'application/json', Authorization: 'Bearer abc123' }],
      ['ollama', null, { 'Content-Type': 'application/json' }]
    ])('builds expected headers for %s', (provider, apiKey, expectedHeaders) => {
      expect(client.getHeaders(provider, apiKey)).toEqual(expectedHeaders);
    });
  });

  describe('Endpoint resolution', () => {
    const baseUrl = 'https://example.com/v1';
    test.each([
      ['openai', `${baseUrl}/chat/completions`],
      ['groq', `${baseUrl}/chat/completions`],
      ['together', `${baseUrl}/chat/completions`],
      ['perplexity', `${baseUrl}/chat/completions`],
      ['lmstudio', `${baseUrl}/chat/completions`],
      ['textgen', `${baseUrl}/chat/completions`],
      ['anthropic', `${baseUrl}/messages`],
      ['google', `${baseUrl}/models/test-model:generateContent`],
      ['cohere', `${baseUrl}/chat`],
      ['mistral', `${baseUrl}/chat/completions`],
      ['ollama', `${baseUrl}/api/chat`],
      ['custom', `${baseUrl}/chat/completions`],
      ['unknown', `${baseUrl}/chat/completions`]
    ])('resolves %s endpoint', (provider, expectedUrl) => {
      expect(client.getEndpointURL({ provider, api_url: baseUrl, model: 'test-model' })).toBe(expectedUrl);
    });
  });

  describe('Response Extraction', () => {
    test('should extract OpenAI-compatible response', () => {
      const mockResponse = {
        choices: [
          {
            message: {
              content: 'Hello! How can I help you?'
            }
          }
        ]
      };

      const extracted = client.extractResponse('groq', mockResponse);
      expect(extracted).toBe('Hello! How can I help you?');
    });

    test('should extract Anthropic response', () => {
      const mockResponse = {
        content: [
          {
            text: 'Hello! How can I help you?'
          }
        ]
      };

      const extracted = client.extractResponse('anthropic', mockResponse);
      expect(extracted).toBe('Hello! How can I help you?');
    });

    test('should extract Google response', () => {
      const mockResponse = {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: 'Hello! How can I help you?'
                }
              ]
            }
          }
        ]
      };

      const extracted = client.extractResponse('google', mockResponse);
      expect(extracted).toBe('Hello! How can I help you?');
    });

    test('should extract Cohere response', () => {
      const mockResponse = {
        text: 'Hello! How can I help you?'
      };

      const extracted = client.extractResponse('cohere', mockResponse);
      expect(extracted).toBe('Hello! How can I help you?');
    });

    test('should return fallback for unknown response format', () => {
      const mockResponse = {
        unknown: 'format'
      };

      const extracted = client.extractResponse('groq', mockResponse);
      expect(extracted).toBe(JSON.stringify(mockResponse));
    });

    test('handles string messages without nested content', () => {
      const mockResponse = {
        choices: [{ message: 'plain-text-response' }]
      };

      expect(client.extractResponse('groq', mockResponse)).toBe('plain-text-response');
    });

    test('ignores content entries that lack usable text', () => {
      const mockResponse = {
        choices: [{
          message: {
            content: [
              { foo: 'bar' },
              { text: 'valid-text' }
            ]
          }
        }]
      };

      expect(client.extractResponse('groq', mockResponse)).toBe('valid-text');
    });

    test('prefers reasoning strings when present', () => {
      const mockResponse = {
        choices: [{
          message: {
            reasoning: 'thought process'
          }
        }]
      };

      expect(client.extractResponse('groq', mockResponse)).toBe('thought process');
    });

    test('falls back to reasoning output_text if available', () => {
      const mockResponse = {
        choices: [{
          message: {
            reasoning: {
              output_text: 'final answer'
            }
          }
        }]
      };

      expect(client.extractResponse('groq', mockResponse)).toBe('final answer');
    });

    test('uses choice.text when message is empty', () => {
      const mockResponse = {
        choices: [{
          message: {},
          text: 'text-field-response'
        }]
      };

      expect(client.extractResponse('groq', mockResponse)).toBe('text-field-response');
    });

    test('default provider branch returns fallback when available', () => {
      const mockResponse = {
        choices: [{ text: 'fallback-text' }]
      };

      expect(client.extractResponse('unknown', mockResponse)).toBe('fallback-text');
    });

    test('default provider branch stringifies when fallback missing', () => {
      const mockResponse = { message: { content: [] } };

      expect(client.extractResponse('unknown', mockResponse)).toBe(JSON.stringify(mockResponse));
    });

    test('flattens array-based message content', () => {
      const mockResponse = {
        choices: [
          {
            message: {
              content: [
                { text: 'First' },
                'Second'
              ]
            }
          }
        ]
      };

      const extracted = client.extractResponse('groq', mockResponse);
      expect(extracted).toBe('First\nSecond');
    });

    test('falls back to reasoning steps when message text missing', () => {
      const mockResponse = {
        message: {
          reasoning: {
            steps: [
              { text: 'Consider input' },
              { text: 'Produce answer' }
            ]
          }
        }
      };

      const extracted = client.extractResponse('ollama', mockResponse);
      expect(extracted).toBe('Consider input\nProduce answer');
    });

    test('stringifies nullish responses', () => {
      expect(client.extractResponse('custom', null)).toBe('null');
    });

    test('stringifies payload when flattened content lacks text', () => {
      const mockResponse = {
        choices: [{ message: { content: [{ foo: 'bar' }] } }]
      };

      expect(client.extractResponse('groq', mockResponse)).toBe(JSON.stringify(mockResponse));
    });

    test('skips reasoning steps when structure is not an array', () => {
      const mockResponse = {
        choices: [{
          message: {
            reasoning: {
              output_text: '   ',
              steps: 'not-array'
            }
          }
        }]
      };

      expect(client.extractResponse('groq', mockResponse)).toBe(JSON.stringify(mockResponse));
    });

    test('ignores reasoning steps that lack usable text', () => {
      const mockResponse = {
        choices: [{
          message: {
            reasoning: {
              steps: [{}, { text: '' }]
            }
          }
        }]
      };

      expect(client.extractResponse('groq', mockResponse)).toBe(JSON.stringify(mockResponse));
    });

    test('serializes payload when neither message nor text fields are usable', () => {
      const mockResponse = {
        choices: [{ message: {}, text: '   ' }]
      };

      expect(client.extractResponse('groq', mockResponse)).toBe(JSON.stringify(mockResponse));
    });

    test('supports openai provider branch explicitly', () => {
      const mockResponse = {
        choices: [{ message: { content: 'OpenAI text' } }]
      };

      expect(client.extractResponse('openai', mockResponse)).toBe('OpenAI text');
    });

    test('anthropic responses fallback to empty string when content missing', () => {
      expect(client.extractResponse('anthropic', { content: [] })).toBe('');
    });

    test('google responses fallback to empty string when no candidates found', () => {
      expect(client.extractResponse('google', { candidates: [] })).toBe('');
    });

    test('cohere responses fallback to empty string when text missing', () => {
      expect(client.extractResponse('cohere', { text: '' })).toBe('');
    });

    test('ollama responses fallback to empty string when no content is provided', () => {
      expect(client.extractResponse('ollama', { message: null, choices: [] })).toBe('');
    });
  });

  describe('makeAPIRequest', () => {
    test('constructs anthropic requests with headers, payload, and timeout', async () => {
      const config = {
        provider: 'anthropic',
        api_url: 'https://api.anthropic.com/v1',
        model: 'claude-3'
      };
      const payload = {
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 50,
        temperature: 0.2
      };
      const axiosResponse = { data: { ok: true } };
      axiosRequestMock.mockResolvedValue(axiosResponse);

      const result = await client.makeAPIRequest(config, 'secret', payload);

      expect(axiosRequestMock).toHaveBeenCalledTimes(1);
      expect(axiosRequestMock.mock.calls[0][0]).toMatchObject({
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer secret',
          'anthropic-version': '2023-06-01'
        }
      });
      expect(axiosRequestMock.mock.calls[0][0].data).toMatchObject({
        messages: payload.messages,
        max_tokens: 50,
        temperature: 0.2
      });
      expect(result).toBe(axiosResponse);
    });

    test('omits Authorization header for local providers', async () => {
      const config = {
        provider: 'ollama',
        api_url: 'http://localhost:11434',
        model: 'llama3.2'
      };
      const payload = {
        messages: [{ role: 'user', content: 'ping' }],
        temperature: 0.3
      };
      axiosRequestMock.mockResolvedValue({ data: { message: 'ok' } });

      await client.makeAPIRequest(config, null, payload);

      expect(axiosRequestMock).toHaveBeenCalledWith(expect.objectContaining({
        url: 'http://localhost:11434/api/chat',
        headers: { 'Content-Type': 'application/json' }
      }));
      expect(axiosRequestMock.mock.calls[0][0].data).toMatchObject({ stream: false });
    });

    test('logs the request payload when LUCIDCODER_LLM_DEBUG=1', async () => {
      const previous = process.env.LUCIDCODER_LLM_DEBUG;
      process.env.LUCIDCODER_LLM_DEBUG = '1';

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      axiosRequestMock.mockResolvedValueOnce({ data: { ok: true } });

      await client.makeAPIRequest(
        { provider: 'groq', model: 'mixtral', api_url: 'https://example.invalid' },
        'plain-key',
        { messages: [{ role: 'user', content: 'Hello' }], temperature: 0 }
      );

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Request payload:'), expect.any(String));

      logSpy.mockRestore();
      process.env.LUCIDCODER_LLM_DEBUG = previous;
    });
  });

  describe('API Communication', () => {
    const testConfig = {
      provider: 'groq',
      apiKey: 'test-key',
      model: 'llama-3.1-70b-versatile',
      apiUrl: 'https://api.groq.com/openai/v1'
    };

    test('should make successful API call', async () => {
      const mockResponse = {
        data: {
          choices: [
            {
              message: {
                content: 'Test response'
              }
            }
          ]
        },
        status: 200
      };

      mockedAxios.post.mockResolvedValue(mockResponse);

      const result = await client.generateText('Test prompt', testConfig, {});
      
      expect(result).toBe('Test response');
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'https://api.groq.com/openai/v1/chat/completions',
        expect.objectContaining({
          model: 'llama-3.1-70b-versatile',
          messages: [{ role: 'user', content: 'Test prompt' }]
        }),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-key',
            'Content-Type': 'application/json'
          })
        })
      );
    });

    test('should handle API errors gracefully', async () => {
      const mockError = {
        response: {
          status: 401,
          data: { error: 'Invalid API key' }
        }
      };

      mockedAxios.post.mockRejectedValue(mockError);

      await expect(client.generateText('Test prompt', testConfig, {}))
        .rejects.toThrow('HTTP 401: Invalid API key');
    });

    test('should report string payloads returned in error responses', async () => {
      const mockError = {
        response: {
          status: 503,
          data: 'Service temporarily unavailable'
        }
      };

      mockedAxios.post.mockRejectedValue(mockError);

      await expect(client.generateText('Test prompt', testConfig, {}))
        .rejects.toThrow('HTTP 503: Service temporarily unavailable');
    });

    test('should handle network errors', async () => {
      const mockError = new Error('Network Error');
      mockError.code = 'ECONNREFUSED';

      mockedAxios.post.mockRejectedValue(mockError);

      await expect(client.generateText('Test prompt', testConfig, {}))
        .rejects.toThrow('Network error: Network Error');
    });

    test('should treat request-level failures as network errors', async () => {
      const mockError = new Error('Timeout');
      mockError.request = {};

      mockedAxios.post.mockRejectedValue(mockError);

      await expect(client.generateText('Test prompt', testConfig, {}))
        .rejects.toThrow('Network error: Timeout');
    });

    test('should bubble generic errors without request metadata', async () => {
      const mockError = new Error('Unexpected failure');

      mockedAxios.post.mockRejectedValue(mockError);

      await expect(client.generateText('Test prompt', testConfig, {}))
        .rejects.toThrow('Unexpected failure');
    });

    test('should fall back to status text when error payload missing', async () => {
      const mockError = {
        response: {
          status: 502,
          statusText: 'Bad Gateway'
        }
      };

      mockedAxios.post.mockRejectedValue(mockError);

      await expect(client.generateText('Test prompt', testConfig, {}))
        .rejects.toThrow('HTTP 502: Bad Gateway');
    });

    test('should default to unknown error when server omits details', async () => {
      const mockError = {
        response: {
          status: 500
        }
      };

      mockedAxios.post.mockRejectedValue(mockError);

      await expect(client.generateText('Test prompt', testConfig, {}))
        .rejects.toThrow('HTTP 500: Unknown error');
    });

    test('should test connection successfully', async () => {
      const mockResponse = {
        data: {
          choices: [
            {
              message: {
                content: 'Test successful'
              }
            }
          ]
        },
        status: 200
      };

      mockedAxios.post.mockResolvedValue(mockResponse);

      const startTime = Date.now();
      const result = await client.testConnection(testConfig);
      const endTime = Date.now();
      
      expect(result.success).toBe(true);
      expect(result.response).toBe('Test successful');
      expect(result.responseTime).toBeGreaterThanOrEqual(0);
      expect(result.responseTime).toBeLessThan(endTime - startTime + 100); // Allow some margin
    });

    test('should handle connection test failure', async () => {
      const mockError = {
        response: {
          status: 500,
          data: { error: 'Internal server error' }
        }
      };

      mockedAxios.post.mockRejectedValue(mockError);

      const result = await client.testConnection(testConfig);
      
      expect(result.success).toBe(false);
      expect(result.error).toBe('HTTP 500: Internal server error');
    });
  });

  describe('Initialization', () => {
    test('loads active config and decrypts API key', async () => {
      dbOperationsMock.getActiveLLMConfig.mockResolvedValue({
        provider: 'groq',
        model: 'mixtral',
        api_url: 'https://api.example.com',
        api_key_encrypted: 'encrypted-key'
      });
      decryptApiKeyMock.mockReturnValue('plain-key');

      const initialized = await client.initialize();

      expect(initialized).toBe(true);
      expect(decryptApiKeyMock).toHaveBeenCalledWith('encrypted-key', { quiet: true });
      expect(client.apiKey).toBe('plain-key');
      expect(client.config).toMatchObject({ provider: 'groq', model: 'mixtral' });
    });

    test('returns false when no config is stored', async () => {
      dbOperationsMock.getActiveLLMConfig.mockResolvedValue(null);

      const initialized = await client.initialize();

      expect(initialized).toBe(false);
      expect(client.config).toBeNull();
      expect(decryptApiKeyMock).not.toHaveBeenCalled();
    });

    test('sets apiKey to null when encrypted key is missing', async () => {
      dbOperationsMock.getActiveLLMConfig.mockResolvedValue({
        provider: 'groq',
        model: 'mixtral',
        api_url: 'https://api.example.com'
      });

      const initialized = await client.initialize();

      expect(initialized).toBe(true);
      expect(client.apiKey).toBeNull();
      expect(decryptApiKeyMock).not.toHaveBeenCalled();
    });

    test('warns and returns false when decrypting required API key fails', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      dbOperationsMock.getActiveLLMConfig.mockResolvedValue({
        provider: 'groq',
        model: 'mixtral',
        api_url: 'https://api.example.com',
        requires_api_key: true,
        api_key_encrypted: 'encrypted-key'
      });
      decryptApiKeyMock.mockReturnValue(null);

      const initialized = await client.initialize();

      expect(initialized).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('could not be decrypted'));
      warnSpy.mockRestore();
    });

    test('warns and returns false when required API key is missing', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      dbOperationsMock.getActiveLLMConfig.mockResolvedValue({
        provider: 'groq',
        model: 'mixtral',
        api_url: 'https://api.example.com',
        requires_api_key: true,
        api_key_encrypted: null
      });

      const initialized = await client.initialize();

      expect(initialized).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('API key is missing'));
      warnSpy.mockRestore();
    });

    test('handles database failures gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      dbOperationsMock.getActiveLLMConfig.mockRejectedValue(new Error('db offline'));

      const initialized = await client.initialize();

      expect(initialized).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith('❌ Failed to initialize LLM API:', expect.any(Error));

      consoleSpy.mockRestore();
    });
  });

  describe('Connection Testing with stored config', () => {
    const baseConfig = {
      provider: 'groq',
      model: 'mixtral-large',
      api_url: 'https://api.groq.com/v1'
    };

    test('requires initialized configuration', async () => {
      await expect(client.testConnection()).rejects.toThrow('No LLM configuration available');
    });

    test('logs success metrics when API call succeeds', async () => {
      client.config = { ...baseConfig };
      client.apiKey = 'plain-key';
      const makeSpy = vi.spyOn(client, 'makeAPIRequest').mockResolvedValue({
        data: { ok: true }
      });

      const result = await client.testConnection();

      expect(makeSpy).toHaveBeenCalledWith(
        client.config,
        'plain-key',
        expect.objectContaining({ max_tokens: 10 })
      );
      expect(dbOperationsMock.logAPIRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'groq',
          model: 'mixtral-large',
          requestType: 'test',
          success: true,
          errorMessage: null
        })
      );
      expect(result).toMatchObject({ success: true, response: { ok: true } });

      makeSpy.mockRestore();
    });

    test('logs failures and propagates error message', async () => {
      client.config = { ...baseConfig };
      client.apiKey = 'plain-key';
      const makeSpy = vi.spyOn(client, 'makeAPIRequest').mockRejectedValueOnce({
        response: {
          status: 500,
          statusText: 'Server Error',
          data: { message: 'explode' }
        }
      });

      await expect(client.testConnection()).rejects.toThrow('explode');

      expect(dbOperationsMock.logAPIRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          errorMessage: 'explode'
        })
      );

      makeSpy.mockRestore();
    });

    test('reports lack of response as a network issue', async () => {
      client.config = { ...baseConfig };
      client.apiKey = 'plain-key';
      const makeSpy = vi.spyOn(client, 'makeAPIRequest').mockRejectedValueOnce(Object.assign(new Error('timeout'), {
        request: {}
      }));

      await expect(client.testConnection()).rejects.toThrow('No response from API server - check URL and network connectivity');

      expect(dbOperationsMock.logAPIRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          errorMessage: 'No response from API server - check URL and network connectivity'
        })
      );

      makeSpy.mockRestore();
    });

    test('falls back to HTTP status text when response lacks message', async () => {
      client.config = { ...baseConfig };
      client.apiKey = 'plain-key';
      const makeSpy = vi.spyOn(client, 'makeAPIRequest').mockRejectedValueOnce({
        response: {
          status: 503,
          statusText: 'Unavailable',
          data: {}
        }
      });

      await expect(client.testConnection()).rejects.toThrow('HTTP 503: Unavailable');

      expect(dbOperationsMock.logAPIRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          errorMessage: 'HTTP 503: Unavailable'
        })
      );

      makeSpy.mockRestore();
    });

    test('propagates setup errors when request fails before sending', async () => {
      client.config = { ...baseConfig };
      client.apiKey = 'plain-key';
      const makeSpy = vi.spyOn(client, 'makeAPIRequest').mockRejectedValueOnce(new Error('setup failed'));

      await expect(client.testConnection()).rejects.toThrow('setup failed');

      expect(dbOperationsMock.logAPIRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          errorMessage: 'setup failed'
        })
      );

      makeSpy.mockRestore();
    });
  });

  describe('Connection Testing with inline configs', () => {
    const createInlineConfig = () => {
      let firstRead = true;
      return {
        api_url: 'https://api.groq.com/v1',
        model: 'mixtral-inline',
        apiKey: 'inline-key',
        get provider() {
          if (firstRead) {
            firstRead = false;
            return undefined;
          }
          return 'groq';
        }
      };
    };

    test('skips logging when inline config is used for success path', async () => {
      const inlineConfig = createInlineConfig();
      const makeSpy = vi.spyOn(client, 'makeAPIRequest').mockResolvedValue({ data: { ok: true } });

      const result = await client.testConnection(inlineConfig);

      expect(result.success).toBe(true);
      expect(dbOperationsMock.logAPIRequest).not.toHaveBeenCalled();

      makeSpy.mockRestore();
    });

    test('skips logging when inline config encounters network errors', async () => {
      const inlineConfig = createInlineConfig();
      const makeSpy = vi.spyOn(client, 'makeAPIRequest').mockRejectedValue(Object.assign(new Error('offline'), {
        request: {}
      }));

      await expect(client.testConnection(inlineConfig)).rejects.toThrow('No response from API server - check URL and network connectivity');

      expect(dbOperationsMock.logAPIRequest).not.toHaveBeenCalled();

      makeSpy.mockRestore();
    });
  });

  describe('generateResponse', () => {
    const messages = [{ role: 'user', content: 'Ping?' }];

    beforeEach(() => {
      client.config = { provider: 'groq', model: 'mixtral' };
      client.apiKey = 'plain-key';
    });

    test('deduplicates concurrent identical requests (single outbound call)', async () => {
      const responsePayload = {
        data: {
          choices: [{ message: { content: 'Pong!' } }]
        }
      };

      let resolveCall;
      const pending = new Promise((resolve) => { resolveCall = resolve; });

      const makeSpy = vi
        .spyOn(client, 'makeAPIRequest')
        .mockImplementationOnce(async () => {
          await pending;
          return responsePayload;
        });

      const first = client.generateResponse(messages, { max_tokens: 5, temperature: 0 });
      const second = client.generateResponse(messages, { max_tokens: 5, temperature: 0 });

      resolveCall();

      const [a, b] = await Promise.all([first, second]);
      expect(a).toBe('Pong!');
      expect(b).toBe('Pong!');
      expect(makeSpy).toHaveBeenCalledTimes(1);

      makeSpy.mockRestore();
    });

    test('deduplicates sequential identical requests within the cache window', async () => {
      const responsePayload = {
        data: {
          choices: [{ message: { content: 'Cached Pong!' } }]
        }
      };

      const makeSpy = vi.spyOn(client, 'makeAPIRequest').mockResolvedValue(responsePayload);

      const first = await client.generateResponse(messages, { max_tokens: 5, temperature: 0 });
      const second = await client.generateResponse(messages, { max_tokens: 5, temperature: 0 });

      expect(first).toBe('Cached Pong!');
      expect(second).toBe('Cached Pong!');
      expect(makeSpy).toHaveBeenCalledTimes(1);

      makeSpy.mockRestore();
    });

    test('does not reuse cached responses for non-deterministic requests by default', async () => {
      const makeSpy = vi
        .spyOn(client, 'makeAPIRequest')
        .mockResolvedValueOnce({
          data: {
            choices: [{ message: { content: 'First' } }]
          }
        })
        .mockResolvedValueOnce({
          data: {
            choices: [{ message: { content: 'Second' } }]
          }
        });

      const first = await client.generateResponse(messages, { max_tokens: 5, temperature: 0.7 });
      const second = await client.generateResponse(messages, { max_tokens: 5, temperature: 0.7 });

      expect(first).toBe('First');
      expect(second).toBe('Second');
      expect(makeSpy).toHaveBeenCalledTimes(2);

      makeSpy.mockRestore();
    });

    test('trims the recent-response cache when it grows past max entries', async () => {
      const previousMax = process.env.LUCIDCODER_LLM_DEDUP_MAX_ENTRIES;
      process.env.LUCIDCODER_LLM_DEDUP_MAX_ENTRIES = '1';

      const limited = new LLMClient();
      limited.config = { provider: 'groq', model: 'mixtral' };
      limited.apiKey = 'plain-key';

      const makeSpy = vi
        .spyOn(limited, 'makeAPIRequest')
        .mockResolvedValueOnce({ data: { choices: [{ message: { content: 'First' } }] } })
        .mockResolvedValueOnce({ data: { choices: [{ message: { content: 'Second' } }] } });

      const first = await limited.generateResponse(messages, { max_tokens: 5, temperature: 0 });
      expect(first).toBe('First');

      const second = await limited.generateResponse(
        [{ role: 'user', content: 'Different' }],
        { max_tokens: 5, temperature: 0 }
      );
      expect(second).toBe('Second');

      expect(limited._dedupRecent.size).toBeLessThanOrEqual(1);

      makeSpy.mockRestore();
      process.env.LUCIDCODER_LLM_DEDUP_MAX_ENTRIES = previousMax;
    });

    test('logs successful generation requests', async () => {
      const responsePayload = {
        data: {
          choices: [{ message: { content: 'Pong!' } }]
        }
      };
      const makeSpy = vi.spyOn(client, 'makeAPIRequest').mockResolvedValue(responsePayload);

      const result = await client.generateResponse(messages, { max_tokens: 5 });

      expect(result).toBe('Pong!');
      expect(makeSpy).toHaveBeenCalledWith(client.config, 'plain-key', expect.objectContaining({ max_tokens: 5 }));
      expect(dbOperationsMock.logAPIRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'groq',
          model: 'mixtral',
          requestType: 'generate',
          success: true,
          errorMessage: null
        })
      );

      makeSpy.mockRestore();
    });

    test('skips tool bridge when explicitly disabled', async () => {
      const responsePayload = {
        data: {
          choices: [{ message: { content: 'No tools used' } }]
        }
      };
      const makeSpy = vi.spyOn(client, 'makeAPIRequest').mockResolvedValueOnce(responsePayload);

      const result = await client.generateResponse(messages, { __lucidcoderDisableToolBridge: true });
      expect(result).toBe('No tools used');

      const firstCallPayload = makeSpy.mock.calls?.[0]?.[2];
      expect(firstCallPayload?.tools).toBeUndefined();
      expect(firstCallPayload?.tool_choice).toBeUndefined();

      makeSpy.mockRestore();
    });

    test('logs failures and rethrows helpful errors', async () => {
      const makeSpy = vi.spyOn(client, 'makeAPIRequest').mockRejectedValueOnce({
        response: { data: { error: { message: 'rate limited' } } }
      });

      await expect(client.generateResponse(messages)).rejects.toThrow('LLM API Error: rate limited');

      expect(dbOperationsMock.logAPIRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          errorMessage: 'rate limited'
        })
      );

      makeSpy.mockRestore();
    });

    test('retries with action-tool bridge when tool validation fails', async () => {
      const toolValidationError = {
        response: {
          data: {
            error: {
              message: "Tool call validation failed: attempted to call tool 'read_file' which was not in request.tools"
            }
          }
        }
      };

      const responsePayload = {
        data: {
          choices: [{ message: { content: 'Recovered' } }]
        }
      };

      const makeSpy = vi
        .spyOn(client, 'makeAPIRequest')
        .mockRejectedValueOnce(toolValidationError)
        .mockResolvedValueOnce(responsePayload);

      const result = await client.generateResponse(messages);
      expect(result).toBe('Recovered');

      // Groq requests include the tool bridge by default; retry should also include tools.
      const firstCallPayload = makeSpy.mock.calls?.[0]?.[2];
      const secondCallPayload = makeSpy.mock.calls?.[1]?.[2];
      expect(firstCallPayload).toEqual(expect.objectContaining({ tools: expect.any(Array) }));
      expect(secondCallPayload).toEqual(expect.objectContaining({ tools: expect.any(Array) }));

      makeSpy.mockRestore();
    });

    test('retries with action-tool bridge even when tool bridge is explicitly disabled', async () => {
      const toolValidationError = {
        response: {
          data: {
            error: {
              message: "Tool call validation failed: attempted to call tool 'list_dir' which was not in request.tools"
            }
          }
        }
      };

      const responsePayload = {
        data: {
          choices: [{ message: { content: 'Recovered despite disable flag' } }]
        }
      };

      const makeSpy = vi
        .spyOn(client, 'makeAPIRequest')
        .mockRejectedValueOnce(toolValidationError)
        .mockResolvedValueOnce(responsePayload);

      const result = await client.generateResponse(messages, { __lucidcoderDisableToolBridge: true });
      expect(result).toBe('Recovered despite disable flag');

      const firstCallPayload = makeSpy.mock.calls?.[0]?.[2];
      const secondCallPayload = makeSpy.mock.calls?.[1]?.[2];
      expect(firstCallPayload?.tools).toBeUndefined();
      expect(firstCallPayload?.tool_choice).toBeUndefined();
      expect(secondCallPayload).toEqual(expect.objectContaining({ tools: expect.any(Array) }));

      makeSpy.mockRestore();
    });

    test('retries with action-tool bridge when error says not in request.tools and attempted to call tool', async () => {
      const toolValidationError = {
        response: {
          data: {
            error: {
              message: "attempted to call tool 'read_file' but was not in request.tools"
            }
          }
        }
      };

      const responsePayload = {
        data: {
          choices: [{ message: { content: 'Recovered via second condition' } }]
        }
      };

      const makeSpy = vi
        .spyOn(client, 'makeAPIRequest')
        .mockRejectedValueOnce(toolValidationError)
        .mockResolvedValueOnce(responsePayload);

      const result = await client.generateResponse(messages);
      expect(result).toBe('Recovered via second condition');

      const secondCallPayload = makeSpy.mock.calls?.[1]?.[2];
      expect(secondCallPayload).toEqual(expect.objectContaining({ tools: expect.any(Array) }));

      makeSpy.mockRestore();
    });

    test('retries with action-tool bridge when validation error mentions request.tools and not in (third condition)', async () => {
      const toolValidationError = {
        response: {
          data: {
            error: {
              message: "Tool call validation failed: tool 'read_file' is not in the request.tools array"
            }
          }
        }
      };

      const responsePayload = {
        data: {
          choices: [{ message: { content: 'Recovered via third condition' } }]
        }
      };

      const makeSpy = vi
        .spyOn(client, 'makeAPIRequest')
        .mockRejectedValueOnce(toolValidationError)
        .mockResolvedValueOnce(responsePayload);

      const result = await client.generateResponse(messages);
      expect(result).toBe('Recovered via third condition');

      const secondCallPayload = makeSpy.mock.calls?.[1]?.[2];
      expect(secondCallPayload).toEqual(expect.objectContaining({ tools: expect.any(Array) }));

      makeSpy.mockRestore();
    });

    test('falls back to a plain request when provider rejects tool schemas', async () => {
      const responsePayload = {
        data: {
          choices: [{ message: { content: 'Recovered without tools' } }]
        }
      };

      const makeSpy = vi
        .spyOn(client, 'makeAPIRequest')
        .mockRejectedValueOnce({
          response: {
            data: {
              error: {
                message: 'tools not supported'
              }
            }
          }
        })
        .mockResolvedValueOnce(responsePayload);

      const result = await client.generateResponse(messages);
      expect(result).toBe('Recovered without tools');

      const firstCallPayload = makeSpy.mock.calls?.[0]?.[2];
      const secondCallPayload = makeSpy.mock.calls?.[1]?.[2];

      expect(firstCallPayload).toEqual(expect.objectContaining({ tools: expect.any(Array), tool_choice: 'auto' }));
      expect(secondCallPayload?.tools).toBeUndefined();
      expect(secondCallPayload?.tool_choice).toBeUndefined();

      makeSpy.mockRestore();
    });

    test('does not fall back to plain requests when tools error lacks unsupported keywords', async () => {
      const makeSpy = vi.spyOn(client, 'makeAPIRequest').mockRejectedValueOnce({
        response: {
          data: {
            error: {
              message: 'tools are weird'
            }
          }
        }
      });

      await expect(client.generateResponse(messages)).rejects.toThrow('LLM API Error: tools are weird');
      expect(makeSpy).toHaveBeenCalledTimes(1);

      makeSpy.mockRestore();
    });

    test('does not fall back to plain requests when error contains unsupported but not tools', async () => {
      const makeSpy = vi.spyOn(client, 'makeAPIRequest').mockRejectedValueOnce({
        response: {
          data: {
            error: {
              message: 'unsupported parameter'
            }
          }
        }
      });

      await expect(client.generateResponse(messages)).rejects.toThrow('LLM API Error: unsupported parameter');
      expect(makeSpy).toHaveBeenCalledTimes(1);

      makeSpy.mockRestore();
    });

    test('retries with minimal tool bridge when provider reports tool_choice none error', async () => {
      const responsePayload = {
        data: {
          choices: [{ message: { content: 'Recovered with minimal tool bridge' } }]
        }
      };

      const makeSpy = vi
        .spyOn(client, 'makeAPIRequest')
        .mockRejectedValueOnce({
          response: {
            data: {
              error: {
                message: 'tool choice is none, but model called a tool'
              }
            }
          }
        })
        .mockResolvedValueOnce(responsePayload);

      const result = await client.generateResponse(messages);
      expect(result).toBe('Recovered with minimal tool bridge');

      const secondCallPayload = makeSpy.mock.calls?.[1]?.[2];
      expect(secondCallPayload).toEqual(expect.objectContaining({ __lucidcoderToolBridge: true }));
      expect(secondCallPayload?.tools).toEqual(expect.any(Array));
      expect(secondCallPayload?.tool_choice).toEqual({
        type: 'function',
        function: { name: 'respond_with_text' }
      });

      makeSpy.mockRestore();
    });

    test('falls back to full tool bridge when tool_choice none repeats after minimal retry', async () => {
      const responsePayload = {
        data: {
          choices: [{ message: { content: 'Recovered with full tool bridge' } }]
        }
      };

      const makeSpy = vi
        .spyOn(client, 'makeAPIRequest')
        .mockRejectedValueOnce({
          response: {
            data: {
              error: {
                message: 'tool choice is none, but model called a tool'
              }
            }
          }
        })
        .mockRejectedValueOnce({
          response: {
            data: {
              error: {
                message: 'tool choice is none, but model called a tool'
              }
            }
          }
        })
        .mockResolvedValueOnce(responsePayload);

      const result = await client.generateResponse(messages);
      expect(result).toBe('Recovered with full tool bridge');

      expect(makeSpy).toHaveBeenCalledTimes(3);

      const secondCallPayload = makeSpy.mock.calls?.[1]?.[2];
      expect(secondCallPayload).toEqual(expect.objectContaining({ __lucidcoderToolBridge: true }));
      expect(secondCallPayload?.tool_choice).toEqual({
        type: 'function',
        function: { name: 'respond_with_text' }
      });

      const thirdCallPayload = makeSpy.mock.calls?.[2]?.[2];
      expect(thirdCallPayload).toEqual(expect.objectContaining({ __lucidcoderToolBridge: true }));
      expect(thirdCallPayload?.tools).toEqual(expect.any(Array));
      expect(thirdCallPayload?.tool_choice).toBe('auto');

      makeSpy.mockRestore();
    });

    test('rethrows tool_choice none after minimal retry when fallback is disabled', async () => {
      const makeSpy = vi
        .spyOn(client, 'makeAPIRequest')
        .mockRejectedValueOnce({
          response: {
            data: {
              error: {
                message: 'tool choice is none, but model called a tool'
              }
            }
          }
        })
        .mockRejectedValueOnce({
          response: {
            data: {
              error: {
                message: 'tool choice is none, but model called a tool'
              }
            }
          }
        });

      await expect(
        client.generateResponse(messages, {
          __lucidcoderDisableToolBridgeFallback: true,
          __lucidcoderDisableDedup: true
        })
      ).rejects.toThrow('LLM API Error: tool choice is none, but model called a tool');

      expect(makeSpy).toHaveBeenCalledTimes(2);

      makeSpy.mockRestore();
    });

    test('rethrows the minimal-tool-bridge retry error when it is not a tool_choice none error', async () => {
      const makeSpy = vi
        .spyOn(client, 'makeAPIRequest')
        .mockRejectedValueOnce({
          response: {
            data: {
              error: {
                message: 'tool choice is none, but model called a tool'
              }
            }
          }
        })
        .mockRejectedValueOnce({
          response: {
            data: {
              error: {
                message: 'some other upstream error'
              }
            }
          }
        });

      await expect(client.generateResponse(messages, { __lucidcoderDisableDedup: true }))
        .rejects
        .toThrow('LLM API Error: some other upstream error');

      expect(makeSpy).toHaveBeenCalledTimes(2);
      makeSpy.mockRestore();
    });
    
    test('falls back to a plain request when provider reports tool-call JSON parsing error', async () => {
      const responsePayload = {
        data: {
          choices: [{ message: { content: 'Recovered without tools' } }]
        }
      };

      const makeSpy = vi
        .spyOn(client, 'makeAPIRequest')
        .mockRejectedValueOnce({
          response: {
            data: {
              error: {
                message: 'failed to parse tool call arguments as json'
              }
            }
          }
        })
        .mockResolvedValueOnce(responsePayload);

      const result = await client.generateResponse(messages, { __lucidcoderDisableDedup: true });
      expect(result).toBe('Recovered without tools');

      const firstCallPayload = makeSpy.mock.calls?.[0]?.[2];
      const secondCallPayload = makeSpy.mock.calls?.[1]?.[2];

      expect(firstCallPayload).toEqual(expect.objectContaining({ tools: expect.any(Array), tool_choice: 'auto' }));
      expect(secondCallPayload?.tools).toBeUndefined();
      expect(secondCallPayload?.tool_choice).toBeUndefined();

      makeSpy.mockRestore();
    });

    test('rethrows tool-call JSON parsing errors when fallback is disabled', async () => {
      const makeSpy = vi.spyOn(client, 'makeAPIRequest').mockRejectedValueOnce({
        response: {
          data: {
            error: {
              message: 'failed to parse tool call arguments as json'
            }
          }
        }
      });

      await expect(
        client.generateResponse(messages, {
          __lucidcoderDisableToolBridgeFallback: true,
          __lucidcoderDisableDedup: true
        })
      ).rejects.toThrow('LLM API Error: failed to parse tool call arguments as json');

      expect(makeSpy).toHaveBeenCalledTimes(1);

      makeSpy.mockRestore();
    });

    test('rethrows tool validation errors when fallback is disabled', async () => {
      const makeSpy = vi.spyOn(client, 'makeAPIRequest').mockRejectedValueOnce({
        response: {
          data: {
            error: {
              message: "Tool call validation failed: attempted to call tool 'list_dir' which was not in request.tools"
            }
          }
        }
      });

      await expect(
        client.generateResponse(messages, {
          __lucidcoderDisableToolBridgeFallback: true,
          __lucidcoderDisableDedup: true
        })
      ).rejects.toThrow('LLM API Error: Tool call validation failed: attempted to call tool \'list_dir\' which was not in request.tools');

      expect(makeSpy).toHaveBeenCalledTimes(1);

      makeSpy.mockRestore();
    });

    test('reinitializes when configuration is missing', async () => {
      client.config = null;
      client.apiKey = null;
      const initSpy = vi.spyOn(client, 'initialize').mockImplementation(async () => {
        client.config = { provider: 'groq', model: 'mixtral' };
        client.apiKey = 'new-key';
        return true;
      });
      const makeSpy = vi.spyOn(client, 'makeAPIRequest').mockResolvedValue({
        data: { choices: [{ message: { content: 'Reinitialized' } }] }
      });

      const result = await client.generateResponse(messages);

      expect(initSpy).toHaveBeenCalled();
      expect(result).toBe('Reinitialized');

      initSpy.mockRestore();
      makeSpy.mockRestore();
    });

    test('throws descriptive error when config still missing after init attempt', async () => {
      client.config = null;
      client.apiKey = null;
      const initSpy = vi.spyOn(client, 'initialize').mockResolvedValue(false);

      await expect(client.generateResponse(messages)).rejects.toThrow('No LLM configuration available. Please configure an LLM provider first.');

      initSpy.mockRestore();
    });

    test('falls back to raw error message when response payload absent', async () => {
      const makeSpy = vi.spyOn(client, 'makeAPIRequest').mockRejectedValueOnce(new Error('boom'));

      await expect(client.generateResponse(messages)).rejects.toThrow('LLM API Error: boom');

      expect(dbOperationsMock.logAPIRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          errorMessage: 'boom'
        })
      );

      makeSpy.mockRestore();
    });
  });

  describe('Configuration Validation', () => {
    test('should validate required configuration fields', async () => {
      const invalidConfigs = [
        null,
        undefined,
        {},
        { provider: 'groq' }, // missing other fields
        { provider: 'groq', apiKey: 'key' }, // missing model and apiUrl
        { provider: 'groq', apiKey: 'key', model: 'model' } // missing apiUrl
      ];

      for (const config of invalidConfigs) {
        await expect(client.generateText('Test prompt', config, {}))
          .rejects.toThrow();
      }
    });

    test('should accept valid configuration', async () => {
      const validConfig = {
        provider: 'groq',
        apiKey: 'test-key',
        model: 'llama-3.1-70b-versatile',
        apiUrl: 'https://api.groq.com/openai/v1'
      };

      const mockResponse = {
        data: {
          choices: [{ message: { content: 'Success' } }]
        }
      };

      mockedAxios.post.mockResolvedValue(mockResponse);

      await expect(client.generateText('Test prompt', validConfig, {}))
        .resolves.toBe('Success');
    });
  });

  describe('Special Provider Handling', () => {
    test('should handle local providers without API key', async () => {
      const localConfig = {
        provider: 'ollama',
        model: 'llama3.2',
        apiUrl: 'http://localhost:11434'
      };

      const mockResponse = {
        data: {
          choices: [{ message: { content: 'Local response' } }]
        }
      };

      mockedAxios.post.mockResolvedValue(mockResponse);

      const result = await client.generateText('Test prompt', localConfig, {});
      expect(result).toBe('Local response');
      
      // Should not include Authorization header for local providers
      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({
          headers: expect.not.objectContaining({
            'Authorization': expect.any(String)
          })
        })
      );
    });

    test('should construct proper endpoints for different providers', () => {
      const testCases = [
        { provider: 'groq', apiUrl: 'https://api.groq.com/openai/v1', expected: 'https://api.groq.com/openai/v1/chat/completions' },
        { provider: 'anthropic', apiUrl: 'https://api.anthropic.com/v1', expected: 'https://api.anthropic.com/v1/messages' },
        { provider: 'google', apiUrl: 'https://generativelanguage.googleapis.com/v1', expected: 'https://generativelanguage.googleapis.com/v1/models/test-model:generateContent' },
        { provider: 'cohere', apiUrl: 'https://api.cohere.ai/v1', expected: 'https://api.cohere.ai/v1/chat' }
      ];

      testCases.forEach(({ provider, apiUrl, expected }) => {
        const endpoint = client.getEndpoint(provider, apiUrl, 'test-model');
        expect(endpoint).toBe(expected);
      });
    });
  });
});