import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const ALGORITHM = 'aes-256-cbc';
const MIN_ENCRYPTION_KEY_LENGTH = 32;
let encryptionKey = typeof process.env.ENCRYPTION_KEY === 'string'
  ? process.env.ENCRYPTION_KEY.trim()
  : '';
let encryptionKeySource = encryptionKey ? 'env' : 'unset';
let missingKeyLogged = false;
let decryptErrorLogged = false;
let weakKeyLogged = false;

const getActiveEncryptionKey = () => {
  if (!encryptionKey) {
    if (!missingKeyLogged) {
      console.error('Encryption key is not configured. Set ENCRYPTION_KEY or enable OS keychain access.');
      missingKeyLogged = true;
    }
    return null;
  }
  return encryptionKey;
};

export const setEncryptionKey = (key, source = 'runtime') => {
  const normalized = typeof key === 'string' ? key.trim() : '';
  if (normalized && normalized.length < MIN_ENCRYPTION_KEY_LENGTH) {
    if (!weakKeyLogged) {
      console.warn(`⚠️ ENCRYPTION_KEY is too short (${normalized.length}). Minimum length is ${MIN_ENCRYPTION_KEY_LENGTH}.`);
      weakKeyLogged = true;
    }
    encryptionKey = '';
    encryptionKeySource = 'invalid';
  } else {
    encryptionKey = normalized;
    encryptionKeySource = normalized ? source : 'unset';
    weakKeyLogged = false;
  }
  missingKeyLogged = false;
  decryptErrorLogged = false;
};

export const getEncryptionKeyStatus = () => ({
  configured: Boolean(encryptionKey),
  source: encryptionKeySource
});

export const encryptApiKey = (apiKey) => {
  try {
    if (!apiKey) return null;

    const activeKey = getActiveEncryptionKey();
    if (!activeKey) return null;

    // Create a proper 32-byte key
    const key = crypto.scryptSync(activeKey, 'salt', 32);
    const iv = crypto.randomBytes(16);
    
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(apiKey, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    // Return IV + encrypted data
    return iv.toString('hex') + ':' + encrypted;
  } catch (error) {
    console.error('Encryption error:', error);
    return null;
  }
};

export const decryptApiKey = (encryptedApiKey, options = {}) => {
  try {
    if (!encryptedApiKey) return null;
    
    const parts = encryptedApiKey.split(':');
    if (parts.length !== 2) return null;
    
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];

    const activeKey = getActiveEncryptionKey();
    if (!activeKey) return null;

    // Create a proper 32-byte key
    const key = crypto.scryptSync(activeKey, 'salt', 32);
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    const quiet = Boolean(options?.quiet);
    if (!quiet && !decryptErrorLogged) {
      console.error('Decryption error:', error);
      decryptErrorLogged = true;
    }
    return null;
  }
};

// Simple hash for non-sensitive data
export const hashData = (data) => {
  return bcrypt.hashSync(data, 10);
};

export const verifyHash = (data, hash) => {
  return bcrypt.compareSync(data, hash);
};