const crypto = require('crypto');
const config = require('../config/env');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

// TOKEN_ENCRYPTION_KEY isn't required to be exactly 32 bytes (the .env.example
// suggestion is `openssl rand -hex 32`, but any string works) — hashed down to
// a fixed-length AES-256 key. Falls back to the session secret only outside
// production, so a fresh dev checkout or CI run doesn't need a second secret
// configured; env.js's own required() already refuses to boot in production
// without a real TOKEN_ENCRYPTION_KEY set.
function deriveKey() {
  const material = config.tokenEncryptionKey || config.sessionSecret;
  return crypto.createHash('sha256').update(material).digest();
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, deriveKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

function decrypt(encoded) {
  const raw = Buffer.from(encoded, 'base64');
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, deriveKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
