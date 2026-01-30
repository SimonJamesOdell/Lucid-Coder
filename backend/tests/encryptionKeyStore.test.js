import { describe, it, expect, beforeEach, vi } from 'vitest';

const keytarMock = {
  getPassword: vi.fn(),
  setPassword: vi.fn()
};

vi.mock('keytar', () => ({
  default: keytarMock
}));

const setEncryptionKeyMock = vi.fn();
vi.mock('../encryption.js', () => ({
  setEncryptionKey: setEncryptionKeyMock
}));

const resetEnv = () => {
  delete process.env.ENCRYPTION_KEY;
};

describe('encryptionKeyStore', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unmock('crypto');
    keytarMock.getPassword.mockReset();
    keytarMock.setPassword.mockReset();
    setEncryptionKeyMock.mockReset();
    resetEnv();
  });

  it('uses a valid env key without keychain access', async () => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(32);
    const { initializeEncryptionKey } = await import('../services/encryptionKeyStore.js?env-key');

    const result = await initializeEncryptionKey();

    expect(result).toEqual({ source: 'env', configured: true, persisted: true });
    expect(setEncryptionKeyMock).toHaveBeenCalledWith('a'.repeat(32), 'env');
    expect(keytarMock.getPassword).not.toHaveBeenCalled();
  });

  it('falls back to keychain when env key is a placeholder', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.ENCRYPTION_KEY = 'your-32-character-encryption-key-here-change-this-in-production';
    keytarMock.getPassword.mockResolvedValue('keychain-secret');

    const { initializeEncryptionKey } = await import('../services/encryptionKeyStore.js?placeholder');
    const result = await initializeEncryptionKey();

    expect(result).toEqual({ source: 'keychain', configured: true, persisted: true });
    const setCall = setEncryptionKeyMock.mock.calls[0];
    expect(setCall[1]).toBe('keychain');
    expect(typeof setCall[0]).toBe('string');
    expect(setCall[0].length).toBeGreaterThanOrEqual(32);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('throws when placeholder env key is used with requireKey', async () => {
    process.env.ENCRYPTION_KEY = 'your-32-character-encryption-key-here-change-this-in-production';

    const { initializeEncryptionKey } = await import('../services/encryptionKeyStore.js?placeholder-required');

    await expect(initializeEncryptionKey({ requireKey: true }))
      .rejects
      .toThrow('ENCRYPTION_KEY is set to a placeholder value');
  });

  it('throws when weak env key is used with requireKey', async () => {
    process.env.ENCRYPTION_KEY = 'short';

    const { initializeEncryptionKey } = await import('../services/encryptionKeyStore.js?weak-required');

    await expect(initializeEncryptionKey({ requireKey: true }))
      .rejects
      .toThrow('ENCRYPTION_KEY is too short');
  });

  it('regenerates when env key is weak and persists to keychain', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.ENCRYPTION_KEY = 'short';
    keytarMock.getPassword.mockResolvedValue(null);
    keytarMock.setPassword.mockResolvedValue(true);

    const { initializeEncryptionKey } = await import('../services/encryptionKeyStore.js?weak-env');
    const result = await initializeEncryptionKey();

    expect(result.source).toBe('keychain');
    expect(result.configured).toBe(true);
    expect(keytarMock.setPassword).toHaveBeenCalled();
    const storedKey = keytarMock.setPassword.mock.calls[0][2];
    expect(typeof storedKey).toBe('string');
    expect(storedKey).toHaveLength(64);
    expect(setEncryptionKeyMock).toHaveBeenCalledWith(storedKey, 'keychain');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('warns when keychain access is unavailable', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    keytarMock.getPassword.mockRejectedValue(new Error('no keychain'));
    keytarMock.setPassword.mockRejectedValue(new Error('no keychain'));

    const { initializeEncryptionKey } = await import('../services/encryptionKeyStore.js?keychain-fail');
    const result = await initializeEncryptionKey();

    expect(result.source).toBe('memory');
    expect(result.persisted).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('OS keychain access is unavailable'));
    warnSpy.mockRestore();
  });

  it('throws when keychain persistence fails in requireKey mode', async () => {
    keytarMock.getPassword.mockResolvedValue(null);
    keytarMock.setPassword.mockRejectedValue(new Error('no keychain'));

    const { initializeEncryptionKey } = await import('../services/encryptionKeyStore.js?persist-fail');

    await expect(initializeEncryptionKey({ requireKey: true }))
      .rejects
      .toThrow('Unable to persist encryption key to the OS keychain.');
  });

  it('throws when no key is available and keychain is unavailable', async () => {
    keytarMock.getPassword.mockRejectedValue(new Error('no keychain'));
    keytarMock.setPassword.mockResolvedValue(true);

    vi.doMock('crypto', async () => {
      const actual = await vi.importActual('crypto');
      return {
        default: {
          ...actual,
          randomBytes: vi.fn(() => Buffer.alloc(0))
        }
      };
    });

    const { initializeEncryptionKey } = await import('../services/encryptionKeyStore.js?no-keychain-no-key');

    await expect(initializeEncryptionKey({ requireKey: true }))
      .rejects
      .toThrow('No encryption key is available');
  });

  it('falls back to memory key when persistence fails and requireKey is false', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    keytarMock.getPassword.mockResolvedValue(null);
    keytarMock.setPassword.mockResolvedValue(false);

    vi.doMock('crypto', async () => {
      const actual = await vi.importActual('crypto');
      return {
        default: {
          ...actual,
          randomBytes: vi.fn(() => Buffer.alloc(32, 1))
        }
      };
    });

    const { initializeEncryptionKey } = await import('../services/encryptionKeyStore.js?persist-fail-no-require');
    const result = await initializeEncryptionKey();

    expect(result.source).toBe('memory');
    expect(result.persisted).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Unable to persist encryption key'));
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('OS keychain access is unavailable'));
    warnSpy.mockRestore();
  });

  it('warns about keychain unavailability when persistence fails after generation', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    keytarMock.getPassword.mockResolvedValue(null);
    keytarMock.setPassword.mockRejectedValue(new Error('no keychain'));

    vi.doMock('crypto', async () => {
      const actual = await vi.importActual('crypto');
      return {
        default: {
          ...actual,
          randomBytes: vi.fn(() => Buffer.alloc(32, 2))
        }
      };
    });

    const { initializeEncryptionKey } = await import('../services/encryptionKeyStore.js?persist-fail-warning');
    const result = await initializeEncryptionKey();

    expect(result.source).toBe('memory');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Unable to persist encryption key'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('OS keychain access is unavailable'));
    warnSpy.mockRestore();
  });

  it('returns none when generated key is empty', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    keytarMock.getPassword.mockResolvedValue(null);
    keytarMock.setPassword.mockResolvedValue(true);

    vi.doMock('crypto', async () => {
      const actual = await vi.importActual('crypto');
      return {
        default: {
          ...actual,
          randomBytes: vi.fn(() => Buffer.alloc(0))
        }
      };
    });

    const { initializeEncryptionKey } = await import('../services/encryptionKeyStore.js?empty-key');
    const result = await initializeEncryptionKey();

    expect(result).toEqual({ source: 'none', configured: false, persisted: false });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No encryption key is available'));
    expect(keytarMock.setPassword).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('uses existing keychain key when available', async () => {
    vi.resetModules();
    vi.doMock('crypto', async () => {
      const actual = await vi.importActual('crypto');
      return {
        default: {
          ...actual,
          randomBytes: vi.fn(() => Buffer.alloc(32, 3))
        }
      };
    });
    keytarMock.getPassword.mockResolvedValue('x'.repeat(32));
    keytarMock.setPassword.mockResolvedValue(true);

    const { initializeEncryptionKey } = await import('../services/encryptionKeyStore.js?existing-keychain');
    const result = await initializeEncryptionKey();

    expect(result).toEqual({ source: 'keychain', configured: true, persisted: true });
    expect(keytarMock.setPassword).not.toHaveBeenCalled();
  });

  it('warns when keychain is unavailable and no key is available', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    keytarMock.getPassword.mockRejectedValue(new Error('no keychain'));
    keytarMock.setPassword.mockResolvedValue(true);

    vi.doMock('crypto', async () => {
      const actual = await vi.importActual('crypto');
      return {
        default: {
          ...actual,
          randomBytes: vi.fn(() => Buffer.alloc(0))
        }
      };
    });

    const { initializeEncryptionKey } = await import('../services/encryptionKeyStore.js?no-keychain-warning');
    const result = await initializeEncryptionKey();

    expect(result).toEqual({ source: 'none', configured: false, persisted: false });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('OS keychain access is unavailable'));
    warnSpy.mockRestore();
  });

  it('does not warn about keychain availability when keychain is available', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    keytarMock.getPassword.mockResolvedValue(null);
    keytarMock.setPassword.mockResolvedValue(true);

    vi.doMock('crypto', async () => {
      const actual = await vi.importActual('crypto');
      return {
        default: {
          ...actual,
          randomBytes: vi.fn(() => Buffer.alloc(0))
        }
      };
    });

    const { initializeEncryptionKey } = await import('../services/encryptionKeyStore.js?no-keychain-ok');
    const result = await initializeEncryptionKey();

    expect(result).toEqual({ source: 'none', configured: false, persisted: false });
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('OS keychain access is unavailable'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No encryption key is available'));
    warnSpy.mockRestore();
  });

  it('skips keychain-availability warning when keychain is healthy', async () => {
    vi.resetModules();
    keytarMock.getPassword.mockResolvedValue(null);
    keytarMock.setPassword.mockResolvedValue(true);

    vi.doMock('crypto', async () => {
      const actual = await vi.importActual('crypto');
      return {
        default: {
          ...actual,
          randomBytes: vi.fn(() => Buffer.alloc(0))
        }
      };
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { initializeEncryptionKey } = await import('../services/encryptionKeyStore.js?no-keychain-skip');
    const result = await initializeEncryptionKey();

    expect(result).toEqual({ source: 'none', configured: false, persisted: false });
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('OS keychain access is unavailable'));
    warnSpy.mockRestore();
  });

  it('reaches no-key warning without keychain warning when keychain stays available', async () => {
    vi.resetModules();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    keytarMock.getPassword.mockResolvedValue(null);
    keytarMock.setPassword.mockResolvedValue(true);

    vi.doMock('crypto', async () => {
      const actual = await vi.importActual('crypto');
      return {
        default: {
          ...actual,
          randomBytes: vi.fn(() => Buffer.alloc(0))
        }
      };
    });

    const { initializeEncryptionKey } = await import('../services/encryptionKeyStore.js?no-key-no-warning');
    const result = await initializeEncryptionKey();

    expect(result).toEqual({ source: 'none', configured: false, persisted: false });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No encryption key is available'));
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('OS keychain access is unavailable'));
    warnSpy.mockRestore();
  });

  it('throws when no key is available in requireKey mode', async () => {
    keytarMock.getPassword.mockResolvedValue(null);
    keytarMock.setPassword.mockRejectedValue(new Error('no keychain'));

    const { initializeEncryptionKey } = await import('../services/encryptionKeyStore.js?no-key');

    await expect(initializeEncryptionKey({ requireKey: true }))
      .rejects
      .toThrow('No encryption key is available');
  });

  it('regenerates when stored keychain key is too short', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    keytarMock.getPassword.mockResolvedValue('short');
    keytarMock.setPassword.mockResolvedValue(true);

    vi.doMock('crypto', async () => {
      const actual = await vi.importActual('crypto');
      return {
        default: {
          ...actual,
          randomBytes: vi.fn(() => Buffer.alloc(32, 1))
        }
      };
    });

    const { initializeEncryptionKey } = await import('../services/encryptionKeyStore.js?short-keychain');
    const result = await initializeEncryptionKey();

    expect(result.source).toBe('keychain');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Stored encryption key is too short'));
    expect(keytarMock.setPassword).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
