import crypto from 'crypto';
import keytar from 'keytar';
import { setEncryptionKey } from '../encryption.js';

const SERVICE_NAME = 'LucidCoder';
const ACCOUNT_NAME = 'encryption-key';
const MIN_ENCRYPTION_KEY_LENGTH = 32;

const PLACEHOLDER_KEYS = new Set([
  'default-key-change-in-production-32bytes',
  'your-32-character-encryption-key-here-change-this-in-production'
]);

const normalizeKey = (value) => (typeof value === 'string' ? value.trim() : '');
const isWeakKey = (value) => normalizeKey(value).length > 0 && normalizeKey(value).length < MIN_ENCRYPTION_KEY_LENGTH;

const isPlaceholderKey = (value) => PLACEHOLDER_KEYS.has(normalizeKey(value));

const getEnvKey = () => {
  const value = normalizeKey(process.env.ENCRYPTION_KEY);
  return value.length > 0 ? value : null;
};

const generateKey = () => crypto.randomBytes(32).toString('hex');

let keychainAvailable = true;

const loadKeychainKey = async () => {
  try {
    return await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME);
  } catch (error) {
    keychainAvailable = false;
    console.error('Failed to read encryption key from OS keychain:', error);
    return null;
  }
};

const saveKeychainKey = async (key) => {
  if (!key || typeof key !== 'string' || !key.trim()) {
    return false;
  }
  try {
    const result = await keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, key);
    return result !== false;
  } catch (error) {
    keychainAvailable = false;
    console.error('Failed to store encryption key in OS keychain:', error);
    return false;
  }
};

export const initializeEncryptionKey = async ({ requireKey = false } = {}) => {
  let envKey = getEnvKey();
  if (envKey) {
    if (isPlaceholderKey(envKey)) {
      const message = 'ENCRYPTION_KEY is set to a placeholder value. Set a strong key for production.';
      if (requireKey) {
        throw new Error(message);
      }
      console.warn(`⚠️ ${message}`);
      envKey = null;
    }

    if (envKey && isWeakKey(envKey)) {
      const message = `ENCRYPTION_KEY is too short. Minimum length is ${MIN_ENCRYPTION_KEY_LENGTH}.`;
      if (requireKey) {
        throw new Error(message);
      }
      console.warn(`⚠️ ${message} Falling back to OS keychain storage.`);
      envKey = null;
    }

    if (envKey) {
      setEncryptionKey(envKey, 'env');
      return { source: 'env', configured: true, persisted: true };
    }
  }

  let keychainKey = await loadKeychainKey();
  let persisted = true;

  if (keychainKey && isWeakKey(keychainKey)) {
    console.warn(`⚠️ Stored encryption key is too short. Regenerating a stronger key (minimum ${MIN_ENCRYPTION_KEY_LENGTH}).`);
    keychainKey = null;
  }

  if (!keychainKey) {
    const generated = generateKey();
    const generatedEmpty = !generated || !generated.trim();
    persisted = await saveKeychainKey(generated);
    keychainKey = generated;

    console.warn('⚠️ Generated a new encryption key. Previously stored secrets may need to be reconfigured.');

    if (!persisted) {
      if (generatedEmpty) {
        keychainKey = null;
      } else {
        const message = 'Unable to persist encryption key to the OS keychain.';
        if (requireKey) {
          throw new Error(message);
        }
        console.warn(`⚠️ ${message} The key will be kept in memory for this session only.`);
        if (!keychainAvailable) {
          console.warn('⚠️ OS keychain access is unavailable. Secrets cannot be persisted securely.');
        }
      }
    }
  }

  if (keychainKey) {
    setEncryptionKey(keychainKey, persisted ? 'keychain' : 'memory');
    return { source: persisted ? 'keychain' : 'memory', configured: true, persisted };
  }

  const message = 'No encryption key is available. Set ENCRYPTION_KEY or enable OS keychain access.';
  if (requireKey) {
    throw new Error(message);
  }

  if (!keychainAvailable) {
    console.warn('⚠️ OS keychain access is unavailable. Secrets cannot be persisted securely.');
  }
  console.warn(`⚠️ ${message}`);
  return { source: 'none', configured: false, persisted: false };
};

export const isPlaceholderEncryptionKey = isPlaceholderKey;
