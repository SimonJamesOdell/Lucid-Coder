import { describe, it, expect, vi, beforeEach } from 'vitest';

// These tests mock the sqlite db layer to hit wrapper error branches that
// are hard to trigger with a healthy test database.

describe('runStore db wrapper coverage', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('rejects when db.get returns an error (line 16)', async () => {
    const mockDb = {
      run: vi.fn(),
      get: vi.fn((_sql, _params, cb) => cb(new Error('get boom'))),
      all: vi.fn()
    };

    vi.doMock('../database.js', () => ({
      default: mockDb
    }));

    const runStore = await import('../services/runStore.js');

    await expect(runStore.__testing.get('SELECT 1')).rejects.toThrow('get boom');
  });

  it('rejects when db.all returns an error (line 26)', async () => {
    const mockDb = {
      run: vi.fn(),
      get: vi.fn(),
      all: vi.fn((_sql, _params, cb) => cb(new Error('all boom')))
    };

    vi.doMock('../database.js', () => ({
      default: mockDb
    }));

    const runStore = await import('../services/runStore.js');

    await expect(runStore.__testing.all('SELECT 1')).rejects.toThrow('all boom');
  });
});
