import { describe, it, expect, beforeAll } from 'vitest';

let testingHelpers;

beforeAll(async () => {
  ({ __testing: testingHelpers } = await import('../llm-client.js'));
});

describe('LLM client stripUnsupportedParams max token coverage', () => {
  it('removes max token fields when flagged', () => {
    const payload = { max_tokens: 12, max_output_tokens: 24, top_p: 0.8 };
    const result = testingHelpers.stripUnsupportedParams(
      payload,
      'Unsupported parameter: max_tokens and max_output_tokens'
    );

    expect(result).toEqual({ top_p: 0.8 });
  });
});
