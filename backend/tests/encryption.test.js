import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'crypto';
import { encryptApiKey, decryptApiKey, hashData, verifyHash, setEncryptionKey, getEncryptionKeyStatus } from '../encryption.js';

describe('encryption helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('round-trips api keys through encrypt/decrypt', () => {
    const secret = 'sk-test-123';
    const encrypted = encryptApiKey(secret);
    expect(typeof encrypted).toBe('string');
    expect(encrypted.split(':')[0]).toHaveLength(32); // 16-byte IV hex encoded

    const decrypted = decryptApiKey(encrypted);
    expect(decrypted).toBe(secret);
  });

  it('returns null when encryption input is falsy or errors occur', () => {
    expect(encryptApiKey('')).toBeNull();

    vi.spyOn(crypto, 'createCipheriv').mockImplementationOnce(() => {
      throw new Error('cipher failure');
    });

    expect(encryptApiKey('hello')).toBeNull();
  });

  it('returns null when decrypted payload is missing', () => {
    expect(decryptApiKey()).toBeNull();
    expect(decryptApiKey('')).toBeNull();
  });

  it('returns null when decrypted payload is invalid', () => {
    expect(decryptApiKey('not-a-valid-payload')).toBeNull();

    const encrypted = encryptApiKey('another-secret');
    const tampered = encrypted.replace(':', '');
    expect(decryptApiKey(tampered)).toBeNull();
  });

  it('logs and returns null when decryption throws', () => {
    const encrypted = encryptApiKey('explode');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.spyOn(crypto, 'createDecipheriv').mockImplementationOnce(() => {
      throw new Error('forced decipher failure');
    });

    expect(decryptApiKey(encrypted)).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith('Decryption error:', expect.any(Error));
  });

  it('does not log decryption errors when quiet', () => {
    setEncryptionKey('x'.repeat(32), 'unit');
    const encrypted = encryptApiKey('explode');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.spyOn(crypto, 'createDecipheriv').mockImplementationOnce(() => {
      throw new Error('forced decipher failure');
    });

    expect(decryptApiKey(encrypted, { quiet: true })).toBeNull();
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('returns null when encryption key is missing', async () => {
    const originalKey = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const { encryptApiKey: encryptWithoutEnv, decryptApiKey: decryptWithoutEnv } = await import('../encryption.js?missing-key');
      const secret = 'fallback-secret';
      const encrypted = encryptWithoutEnv(secret);
      expect(encrypted).toBeNull();
      expect(decryptWithoutEnv('bad')).toBeNull();
      expect(consoleSpy).toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
      if (originalKey === undefined) {
        delete process.env.ENCRYPTION_KEY;
      } else {
        process.env.ENCRYPTION_KEY = originalKey;
      }
    }
  });

  it('logs missing key once when decrypting without a configured key', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    setEncryptionKey('');
    expect(decryptApiKey('00:00')).toBeNull();
    expect(decryptApiKey('00:00')).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);

    errorSpy.mockRestore();
  });

  it('marks weak encryption keys as invalid', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    setEncryptionKey('short');
    expect(getEncryptionKeyStatus()).toEqual({ configured: false, source: 'invalid' });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ENCRYPTION_KEY is too short'));

    setEncryptionKey('short');
    expect(warnSpy).toHaveBeenCalledTimes(1);

    setEncryptionKey(null);
    expect(getEncryptionKeyStatus()).toEqual({ configured: false, source: 'unset' });

    setEncryptionKey('x'.repeat(32), 'unit');
    expect(getEncryptionKeyStatus()).toEqual({ configured: true, source: 'unit' });

    warnSpy.mockRestore();
  });

  it('hashes and verifies arbitrary data', () => {
    const hash = hashData('password');
    expect(typeof hash).toBe('string');
    expect(verifyHash('password', hash)).toBe(true);
    expect(verifyHash('wrong', hash)).toBe(false);
  });
});
