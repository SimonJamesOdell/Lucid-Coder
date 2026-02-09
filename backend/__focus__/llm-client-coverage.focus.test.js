import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import axios from 'axios';

const axiosRequestMock = vi.hoisted(() => vi.fn());
vi.mock('axios', () => ({
  __esModule: true,
  default: (...args) => axiosRequestMock(...args)
}));

let LLMClient;
let testingHelpers;

beforeAll(async () => {
  ({ LLMClient, __testing: testingHelpers } = await import('../llm-client.js'));
});

beforeEach(() => {
  axiosRequestMock.mockReset();
});

describe('LLM client coverage focus', () => {
  it('stripUnsupportedParams returns payload when unsupported keys are absent', () => {
    const payload = { temperature: 0.2 };
    const result = testingHelpers.stripUnsupportedParams(payload, 'Unsupported parameter: top_p');
    expect(result).toBe(payload);
  });

  it('stripUnsupportedParams detects topp alias', () => {
    const payload = { top_p: 0.3 };
    const result = testingHelpers.stripUnsupportedParams(payload, 'Unsupported parameter: topp');
    expect(result).toEqual({});
  });

  it('makeAPIRequestWithEndpoint strips trailing slashes and uses fallback timeout', async () => {
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
});
