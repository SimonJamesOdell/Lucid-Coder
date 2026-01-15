import bcrypt from 'bcryptjs';
import crypto from 'crypto';

// Encryption key - in production, this should be from environment variables
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'default-key-change-in-production-32bytes';
const ALGORITHM = 'aes-256-cbc';

export const encryptApiKey = (apiKey) => {
  try {
    if (!apiKey) return null;
    
    // Create a proper 32-byte key
    const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
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

export const decryptApiKey = (encryptedApiKey) => {
  try {
    if (!encryptedApiKey) return null;
    
    const parts = encryptedApiKey.split(':');
    if (parts.length !== 2) return null;
    
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    
    // Create a proper 32-byte key
    const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    console.error('Decryption error:', error);
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