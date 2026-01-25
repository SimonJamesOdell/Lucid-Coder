/** @vitest-environment node */

import { describe, test, expect } from 'vitest';
import { getDevServerOriginFromWindow } from '../components/PreviewTab.jsx';

describe('PreviewTab helpers (no window)', () => {
  test('getDevServerOriginFromWindow returns null when window is undefined', () => {
    expect(getDevServerOriginFromWindow({ port: 5173, hostnameOverride: null })).toBeNull();
  });
});
