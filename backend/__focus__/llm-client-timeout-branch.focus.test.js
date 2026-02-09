import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

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

describe('LLM client timeout branch coverage', () => {
  it('stripUnsupportedParams returns payload when error message is undefined', () => {
    const payload = { temperature: 0.2 };
    const result = testingHelpers.stripUnsupportedParams(payload, undefined);
    expect(result).toBe(payload);
  });

  it('makeAPIRequestWithEndpoint uses default timeout for non-fallback endpoints', async () => {
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
});
