import { describe, it, expect, beforeAll } from 'vitest';

let testingHelpers;

beforeAll(async () => {
  ({ __testing: testingHelpers } = await import('../llm-client.js'));
});

describe('LLM client stripUnsupportedParams', () => {
  it('returns original payload for non-object input', () => {
    const result = testingHelpers.stripUnsupportedParams(null, 'unsupported parameter: temperature');
    expect(result).toBeNull();
  });

  it('returns original payload when message lacks unsupported parameter', () => {
    const payload = { temperature: 0.4 };
    const result = testingHelpers.stripUnsupportedParams(payload, 'rate limited');
    expect(result).toBe(payload);
  });

  it('removes temperature and top_p when unsupported', () => {
    const payload = { temperature: 0.4, top_p: 0.9, max_tokens: 12 };
    const result = testingHelpers.stripUnsupportedParams(payload, 'Unsupported parameter: temperature, top_p');
    expect(result).toEqual({ max_tokens: 12 });
  });
});
