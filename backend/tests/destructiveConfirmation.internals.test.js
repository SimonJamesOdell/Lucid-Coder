import { describe, expect, test, vi } from 'vitest';

describe('destructive confirmation helpers', () => {
  test('isDestructiveOperationConfirmed returns false for a missing request', async () => {
    const internals = await import('../routes/projects/internals.js');
    expect(internals.isDestructiveOperationConfirmed(null)).toBe(false);
  });

  test('accepts confirmation via body boolean', async () => {
    const internals = await import('../routes/projects/internals.js');
    expect(internals.isDestructiveOperationConfirmed({ body: { confirm: true } })).toBe(true);
  });

  test('rejects non-string confirmation values', async () => {
    const internals = await import('../routes/projects/internals.js');
    expect(internals.isDestructiveOperationConfirmed({ body: { confirm: 1 } })).toBe(false);
  });

  test('accepts confirmation via query string (trimmed, case-insensitive)', async () => {
    const internals = await import('../routes/projects/internals.js');
    expect(internals.isDestructiveOperationConfirmed({ query: { confirm: ' TrUe ' } })).toBe(true);
    expect(internals.isDestructiveOperationConfirmed({ query: { confirm: 'false' } })).toBe(false);
  });

  test('accepts confirmation via req.get header and blocks when missing', async () => {
    const internals = await import('../routes/projects/internals.js');

    const confirmedReq = {
      get: (name) => (name === 'x-confirm-destructive' ? 'true' : undefined)
    };
    expect(internals.isDestructiveOperationConfirmed(confirmedReq)).toBe(true);

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    };

    const blocked = internals.requireDestructiveConfirmation({}, res, { errorMessage: 'Nope' });
    expect(blocked).toBe(true);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Nope' });
  });
});
