import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'crypto';
import { encryptApiKey, decryptApiKey, hashData, verifyHash } from '../encryption.js';

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

  it('falls back to default encryption key when env is unset', async () => {
    const originalKey = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;

    try {
      const { encryptApiKey: encryptWithoutEnv, decryptApiKey: decryptWithoutEnv } = await import('../encryption.js?default-key');
      const secret = 'fallback-secret';
      const encrypted = encryptWithoutEnv(secret);
      expect(decryptWithoutEnv(encrypted)).toBe(secret);
    } finally {
      if (originalKey === undefined) {
        delete process.env.ENCRYPTION_KEY;
      } else {
        process.env.ENCRYPTION_KEY = originalKey;
      }
    }
  });

  it('hashes and verifies arbitrary data', () => {
    const hash = hashData('password');
    expect(typeof hash).toBe('string');
    expect(verifyHash('password', hash)).toBe(true);
    expect(verifyHash('wrong', hash)).toBe(false);
  });
});
