// lib/crypto.ts — AES-256-GCM for provider credentials + SHA-256 hashing.
// Key comes from ENCRYPTION_MASTER_KEY (64 hex chars = 32 bytes).
// Stored format: base64(iv 12B || ciphertext || authTag 16B).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export function masterKeyFromHex(hex: string): Buffer {
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) throw new Error('ENCRYPTION_MASTER_KEY must be 64 hex chars (32 bytes)');
  return key;
}

export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, tag]).toString('base64');
}

export function decryptSecret(payload: string, key: Buffer): string {
  const buf = Buffer.from(payload, 'base64');
  if (buf.length < 12 + 16) throw new Error('Invalid encrypted payload');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ciphertext = buf.subarray(12, buf.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** SHA-256 hex hash — used for router API keys, session tokens, reset tokens. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Last 4 chars of a key, stored as keyHint (safe to show in the dashboard). */
export function keyHint(value: string): string {
  return value.slice(-4);
}

/** Cryptographically random token, base64url. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
