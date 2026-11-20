import { describe, expect, it } from 'vitest';
import { signJwt, verifyJwt } from './jwt.js';

const SECRET = 'test-jwt-secret-must-be-long-enough';

describe('jwt (HS256)', () => {
  it('signs and verifies a payload', () => {
    const token = signJwt({ sub: 'user-1', sid: 'sess-1', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
    const payload = verifyJwt(token, SECRET);
    expect(payload?.sub).toBe('user-1');
    expect(payload?.sid).toBe('sess-1');
  });

  it('rejects an expired token', () => {
    const token = signJwt({ sub: 'u', sid: 's', exp: Math.floor(Date.now() / 1000) - 10 }, SECRET);
    expect(verifyJwt(token, SECRET)).toBeNull();
  });

  it('rejects a token verified with the wrong secret', () => {
    const token = signJwt({ sub: 'u', sid: 's', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
    expect(verifyJwt(token, 'different-secret')).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const token = signJwt({ sub: 'u', sid: 's', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
    const parts = token.split('.');
    const tampered = `${parts[0]}.${Buffer.from(JSON.stringify({ sub: 'admin', sid: 's', exp: 9999999999, iat: 1 })).toString('base64url')}.${parts[2]}`;
    expect(verifyJwt(tampered, SECRET)).toBeNull();
  });
});
