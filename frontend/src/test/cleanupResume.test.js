import { describe, it, expect, beforeEach } from 'vitest';

import {
  setCleanupResumeRequest,
  peekCleanupResumeRequest,
  consumeCleanupResumeRequest
} from '../utils/cleanupResume';

describe('cleanupResume', () => {
  beforeEach(() => {
    setCleanupResumeRequest(null);
  });

  it('stores only valid requests and defaults flags + requestedAt', () => {
    setCleanupResumeRequest('nope');
    expect(peekCleanupResumeRequest()).toBeNull();

    setCleanupResumeRequest({ token: 123 });
    expect(peekCleanupResumeRequest()).toBeNull();

    setCleanupResumeRequest({ token: '   ' });
    expect(peekCleanupResumeRequest()).toBeNull();

    setCleanupResumeRequest({ token: '  tok-1  ' });
    const pending = peekCleanupResumeRequest();

    expect(pending.token).toBe('tok-1');
    expect(pending.includeFrontend).toBe(true);
    expect(pending.includeBackend).toBe(true);
    expect(pending.pruneRedundantTests).toBe(true);
    expect(typeof pending.requestedAt).toBe('string');

    const consumed = consumeCleanupResumeRequest();
    expect(consumed.token).toBe('tok-1');
    expect(peekCleanupResumeRequest()).toBeNull();
  });

  it('respects explicit false flags', () => {
    setCleanupResumeRequest({
      token: 'tok-2',
      includeFrontend: false,
      includeBackend: false,
      pruneRedundantTests: false,
      requestedAt: '2020-01-01T00:00:00.000Z'
    });

    expect(peekCleanupResumeRequest()).toEqual({
      token: 'tok-2',
      includeFrontend: false,
      includeBackend: false,
      pruneRedundantTests: false,
      requestedAt: '2020-01-01T00:00:00.000Z'
    });
  });
});
