import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const axiosRequestMock = vi.hoisted(() => vi.fn());
vi.mock('axios', () => ({
  __esModule: true,
  default: (...args) => axiosRequestMock(...args)
}));

let LLMClient;

beforeAll(async () => {
  ({ LLMClient } = await import('../llm-client.js'));
});

beforeEach(() => {
  axiosRequestMock.mockReset();
});

describe('LLM client fallback timeout zero branch', () => {
  it('uses default timeout when fallback timeout is zero', async () => {
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
});
