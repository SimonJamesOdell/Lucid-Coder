import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const encryptApiKeyMock = vi.fn(() => null);
const decryptApiKeyMock = vi.fn(() => null);
vi.mock('../encryption.js', () => ({
  encryptApiKey: encryptApiKeyMock,
  decryptApiKey: decryptApiKeyMock,
  hashData: vi.fn(),
  verifyHash: vi.fn()
}));

describe('Git token encryption failures', () => {
  beforeEach(() => {
    vi.resetModules();
    encryptApiKeyMock.mockReset();
    process.env.DATABASE_PATH = path.join(
      os.tmpdir(),
      `lucidcoder-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`
    );
  });

  afterEach(() => {
    const target = process.env.DATABASE_PATH;
    delete process.env.DATABASE_PATH;
    if (target) {
      try {
        fs.unlinkSync(target);
      } catch {
        // ignore
      }
    }
  });

  it('throws when encrypting global git token fails', async () => {
    const module = await import('../database.js?git-token-fail');
    await module.initializeDatabase();

    await expect(module.saveGitSettings({ token: 'abc' }))
      .rejects
      .toThrow('Failed to encrypt Git token');

    expect(encryptApiKeyMock).toHaveBeenCalledWith('abc');
    await new Promise((resolve, reject) => {
      module.default.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('throws when encrypting project git token fails', async () => {
    const module = await import('../database.js?project-token-fail');
    await module.initializeDatabase();

    await expect(module.saveProjectGitSettings(1, { token: 'abc' }))
      .rejects
      .toThrow('Failed to encrypt Git token');

    expect(encryptApiKeyMock).toHaveBeenCalledWith('abc');
    await new Promise((resolve, reject) => {
      module.default.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('returns decrypted git token when encrypted value is present', async () => {
    decryptApiKeyMock.mockReturnValueOnce('decrypted-token');
    const module = await import('../database.js?git-token-decrypt');
    await module.initializeDatabase();

    await new Promise((resolve, reject) => {
      module.default.run(
        'INSERT INTO git_settings (id, token_encrypted) VALUES (1, ?)',
        ['encrypted-token'],
        (err) => (err ? reject(err) : resolve())
      );
    });

    const token = await module.getGitSettingsToken();
    expect(token).toBe('decrypted-token');
    expect(decryptApiKeyMock).toHaveBeenCalledWith('encrypted-token', { quiet: true });

    await new Promise((resolve, reject) => {
      module.default.close((err) => (err ? reject(err) : resolve()));
    });
  });
});
