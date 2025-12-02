const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey() {
  const secret = process.env.SESSION_SECRET || process.env.ENCRYPTION_KEY;
  
  if (!secret) {
    console.error('[Encryption] CRITICAL: No encryption key found. Set SESSION_SECRET or ENCRYPTION_KEY environment variable.');
    throw new Error('Encryption key not configured. Please set SESSION_SECRET in secrets.');
  }
  
  if (secret.length < 16) {
    console.error('[Encryption] CRITICAL: Encryption key is too short (minimum 16 characters required).');
    throw new Error('Encryption key too short. Please use a stronger SESSION_SECRET.');
  }
  
  return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(text) {
  if (!text) return null;
  
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = getEncryptionKey();
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

function decrypt(encryptedData) {
  if (!encryptedData) return null;
  
  try {
    const parts = encryptedData.split(':');
    if (parts.length !== 3) {
      return encryptedData;
    }
    
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];
    
    const key = getEncryptionKey();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    console.error('[Encryption] Decryption failed:', error.message);
    return encryptedData;
  }
}

module.exports = {
  encrypt,
  decrypt
};
