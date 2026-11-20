import { describe, expect, it } from 'vitest';
import { generateTotpCode, generateTotpSecret, verifyTotpCode } from './totp.js';

describe('totp', () => {
  it('generates a verifiable 6-digit code', () => {
    const secret = generateTotpSecret();
    const code = generateTotpCode(secret);
    expect(code).toMatch(/^\d{6}$/);
    expect(verifyTotpCode(secret, code)).toBe(true);
  });

  it('rejects a wrong code', () => {
    const secret = generateTotpSecret();
    const code = generateTotpCode(secret);
    const wrong = code === '000000' ? '000001' : '000000';
    expect(verifyTotpCode(secret, wrong)).toBe(false);
  });

  it('accepts a code from the previous step (clock skew)', () => {
    const secret = generateTotpSecret();
    const past = generateTotpCode(secret, Date.now() - 30_000);
    expect(verifyTotpCode(secret, past)).toBe(true);
  });

  it('rejects a code from far in the past', () => {
    const secret = generateTotpSecret();
    const old = generateTotpCode(secret, Date.now() - 5 * 60_000);
    expect(verifyTotpCode(secret, old)).toBe(false);
  });
});
