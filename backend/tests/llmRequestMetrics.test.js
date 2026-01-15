import { describe, beforeEach, it, expect } from 'vitest';
import { llmRequestMetrics } from '../services/llmRequestMetrics.js';

describe('llmRequestMetrics', () => {
  beforeEach(() => {
    llmRequestMetrics.reset();
  });

  it('normalizes missing and empty fields to "unknown"', () => {
    llmRequestMetrics.record(null, {
      phase: '   ',
      requestType: undefined,
      provider: null,
      model: ''
    });

    const snapshot = llmRequestMetrics.snapshot();
    expect(snapshot.counters).toMatchObject({
      'kind:unknown': 1,
      'phase:unknown': 1,
      'type:unknown': 1,
      'provider:unknown': 1,
      'model:unknown': 1
    });
  });

  it('trims counter keys once the maximum is exceeded', () => {
    // Each record call adds at most one new key when only `model` changes.
    // After enough unique models, the internal map must be trimmed.
    for (let idx = 0; idx < 700; idx += 1) {
      llmRequestMetrics.record('request', {
        phase: 'plan',
        requestType: 'chat',
        provider: 'local',
        model: `m-${idx}`
      });
    }

    const snapshot = llmRequestMetrics.snapshot();
    expect(snapshot.totalKeys).toBeLessThanOrEqual(500);
  });
});
