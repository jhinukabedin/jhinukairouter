import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, masterKeyFromHex, sha256Hex } from './crypto.js';

const KEY = masterKeyFromHex('ab'.repeat(32));

describe('crypto (AES-256-GCM)', () => {
  it('encrypts and decrypts a provider key', () => {
    const cipher = encryptSecret('sk-test-secret-key', KEY);
    expect(cipher).not.toContain('sk-test-secret-key');
    expect(decryptSecret(cipher, KEY)).toBe('sk-test-secret-key');
  });

  it('produces different ciphertexts for the same plaintext (random IV)', () => {
    expect(encryptSecret('same', KEY)).not.toBe(encryptSecret('same', KEY));
  });

  it('fails decryption with the wrong key', () => {
    const cipher = encryptSecret('secret', KEY);
    const wrong = masterKeyFromHex('cd'.repeat(32));
    expect(() => decryptSecret(cipher, wrong)).toThrow();
  });

  it('fails decryption on tampered payload', () => {
    const cipher = encryptSecret('secret', KEY);
    const tampered = cipher.slice(0, -4) + 'AAAA';
    expect(() => decryptSecret(tampered, KEY)).toThrow();
  });

  it('rejects a master key that is not 32 bytes', () => {
    expect(() => masterKeyFromHex('abcd')).toThrow();
  });

  it('sha256Hex is deterministic', () => {
    expect(sha256Hex('abc')).toBe(sha256Hex('abc'));
    expect(sha256Hex('abc')).not.toBe(sha256Hex('abd'));
    expect(sha256Hex('abc')).toHaveLength(64);
  });
});
