import { describe, expect, it } from 'vitest';
import { resolveCoverageProvider } from '../vitest.coverageProvider.js';

describe('resolveCoverageProvider', () => {
  it('uses istanbul on Node 18 and below', () => {
    expect(resolveCoverageProvider('18.19.1')).toBe('istanbul');
  });

  it('uses v8 on Node 19 and above', () => {
    expect(resolveCoverageProvider('19.0.0')).toBe('v8');
    expect(resolveCoverageProvider('20.11.1')).toBe('v8');
  });
});
