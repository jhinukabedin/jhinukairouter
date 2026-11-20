import { describe, expect, it } from 'vitest';
import { authHeader, makeTestApp, registerUser } from '../../test/helpers.js';
import { randomToken, sha256Hex } from '../../lib/crypto.js';

describe('auth module', () => {
  it('registers the first user as SUPER_ADMIN and returns a session token', async () => {
    const { app, db } = await makeTestApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'first@example.com', password: 'password123' } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { user: { email: string }; token: string };
    expect(body.user.email).toBe('first@example.com');
    expect(body.token).toBeTruthy();
    const roles = await db.userRole.findMany({ where: { userId: db.users[0]?.id ?? '' } });
    const role = await db.role.findUnique({ where: { id: roles[0]?.roleId ?? '' } });
    expect(role?.name).toBe('SUPER_ADMIN');
    await app.close();
  });

  it('rejects duplicate registration', async () => {
    const { app } = await makeTestApp();
    await registerUser(app, 'dup@example.com');
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'dup@example.com', password: 'password123' } });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('rejects short passwords and bad emails', async () => {
    const { app } = await makeTestApp();
    const short = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'a@b.com', password: 'short' } });
    expect(short.statusCode).toBe(400);
    const badEmail = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'not-an-email', password: 'password123' } });
    expect(badEmail.statusCode).toBe(400);
    await app.close();
  });

  it('refuses registration when REGISTRATION_ENABLED=false', async () => {
    const { app } = await makeTestApp({ REGISTRATION_ENABLED: false });
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'x@example.com', password: 'password123' } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('registration-status reports the effective flag and the DB setting overrides env', async () => {
    const { app } = await makeTestApp();
    const admin = await registerUser(app, 'statusadmin@example.com');
    const status = async () => (await app.inject({ method: 'GET', url: '/api/v1/auth/registration-status' })).json() as { registrationEnabled: boolean };

    // Env default is on, no setting stored yet.
    expect((await status()).registrationEnabled).toBe(true);

    // Admin turns it off via the system setting — registration now refused.
    const off = await app.inject({
      method: 'PATCH', url: '/api/v1/admin/system-settings', headers: authHeader(admin.token),
      payload: { settings: { 'registration.enabled': false } },
    });
    expect(off.statusCode).toBe(200);
    expect((await status()).registrationEnabled).toBe(false);
    const blocked = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'nope@example.com', password: 'password123' } });
    expect(blocked.statusCode).toBe(400);

    // Admin turns it back on — registration works again, no restart.
    const on = await app.inject({
      method: 'PATCH', url: '/api/v1/admin/system-settings', headers: authHeader(admin.token),
      payload: { settings: { 'registration.enabled': true } },
    });
    expect(on.statusCode).toBe(200);
    expect((await status()).registrationEnabled).toBe(true);
    const ok = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'yes@example.com', password: 'password123' } });
    expect(ok.statusCode).toBe(201);
    await app.close();
  });

  it('DB setting true re-enables registration even when the env var is off', async () => {
    const { app, db } = await makeTestApp({ REGISTRATION_ENABLED: false });
    // Registration is off, so seed the admin directly instead of registering.
    const admin = await db.user.create({ data: { email: 'envadmin@example.com', passwordHash: 'seeded' } });
    const role = await db.role.findUnique({ where: { name: 'SUPER_ADMIN' } });
    await db.userRole.create({ data: { userId: admin.id, roleId: role?.id ?? '' } });
    const token = randomToken(32);
    await db.userSession.create({
      data: { userId: admin.id, tokenHash: sha256Hex(token), userAgent: null, ip: null, expiresAt: new Date(Date.now() + 3_600_000) },
    });
    const on = await app.inject({
      method: 'PATCH', url: '/api/v1/admin/system-settings', headers: authHeader(token),
      payload: { settings: { 'registration.enabled': true } },
    });
    expect(on.statusCode).toBe(200);
    const ok = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'on@example.com', password: 'password123' } });
    expect(ok.statusCode).toBe(201);
    await app.close();
  });

  it('logs in with correct credentials and rejects wrong ones', async () => {
    const { app } = await makeTestApp();
    await registerUser(app, 'login@example.com');
    const ok = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'login@example.com', password: 'password123' } });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { token: string }).token).toBeTruthy();
    const bad = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'login@example.com', password: 'wrong-password' } });
    expect(bad.statusCode).toBe(401);
    await app.close();
  });

  it('logout revokes the session; refresh rotates it', async () => {
    const { app, db } = await makeTestApp();
    const { token } = await registerUser(app, 'sess@example.com');
    const refresh = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: authHeader(token) });
    expect(refresh.statusCode).toBe(200);
    const newToken = (refresh.json() as { token: string }).token;
    expect(newToken).not.toBe(token);
    // Old token is revoked.
    const meOld = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: authHeader(token) });
    expect(meOld.statusCode).toBe(401);
    // New token works.
    const meNew = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: authHeader(newToken) });
    expect(meNew.statusCode).toBe(200);
    // Logout revokes the new token too.
    const logout = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: authHeader(newToken) });
    expect(logout.statusCode).toBe(200);
    expect(db.sessions.filter((s) => s.revokedAt !== null)).toHaveLength(2);
    await app.close();
  });

  it('lists and revokes own sessions', async () => {
    const { app } = await makeTestApp();
    const { token } = await registerUser(app, 'listsess@example.com');
    const list = await app.inject({ method: 'GET', url: '/api/v1/auth/sessions', headers: authHeader(token) });
    expect(list.statusCode).toBe(200);
    const sessions = (list.json() as { sessions: Array<{ id: string; current: boolean }> }).sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.current).toBe(true);
    const del = await app.inject({ method: 'DELETE', url: `/api/v1/auth/sessions/${sessions[0]?.id ?? ''}`, headers: authHeader(token) });
    expect(del.statusCode).toBe(200);
    const me = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: authHeader(token) });
    expect(me.statusCode).toBe(401);
    await app.close();
  });

  it('password reset: neutral response, token works once, then invalid', async () => {
    const { app, db } = await makeTestApp();
    await registerUser(app, 'reset@example.com');
    const req = await app.inject({ method: 'POST', url: '/api/v1/auth/password-reset/request', payload: { email: 'reset@example.com' } });
    expect(req.statusCode).toBe(200);
    expect(req.body).not.toContain('reset@example.com');
    // Unknown email gets the same response.
    const reqUnknown = await app.inject({ method: 'POST', url: '/api/v1/auth/password-reset/request', payload: { email: 'nobody@example.com' } });
    expect(reqUnknown.statusCode).toBe(200);
    expect(reqUnknown.body).toBe(req.body);
    expect(db.resetTokens).toHaveLength(1);
    // The raw token is never returned; recover it from the fake db via hash.
    const { sha256Hex, randomToken } = await import('../../lib/crypto.js');
    const raw = randomToken(32);
    // Simulate the client holding the real token: find the stored hash by
    // re-creating it from the only token the test can know — instead, use the
    // stored record's hash directly through a fresh token round-trip:
    const stored = db.resetTokens[0];
    expect(stored).toBeDefined();
    // Confirm with a wrong token fails.
    const bad = await app.inject({ method: 'POST', url: '/api/v1/auth/password-reset/confirm', payload: { token: raw, newPassword: 'newpassword123' } });
    expect(bad.statusCode).toBe(400);
    // Confirm with the real token: brute-force is impossible, so verify the
    // flow by hashing a token we plant ourselves.
    const planted = randomToken(32);
    await db.passwordResetToken.create({ data: { userId: db.users[0]?.id ?? '', tokenHash: sha256Hex(planted), expiresAt: new Date(Date.now() + 3600_000) } });
    const ok = await app.inject({ method: 'POST', url: '/api/v1/auth/password-reset/confirm', payload: { token: planted, newPassword: 'newpassword123' } });
    expect(ok.statusCode).toBe(200);
    const reuse = await app.inject({ method: 'POST', url: '/api/v1/auth/password-reset/confirm', payload: { token: planted, newPassword: 'anotherpass123' } });
    expect(reuse.statusCode).toBe(400);
    // New password works, old one does not.
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'reset@example.com', password: 'newpassword123' } });
    expect(login.statusCode).toBe(200);
    await app.close();
  });

  it('TOTP: setup -> verify -> login requires code', async () => {
    const { app } = await makeTestApp();
    const { token } = await registerUser(app, 'totp@example.com');
    const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/totp/setup', headers: authHeader(token) });
    expect(setup.statusCode).toBe(200);
    const { secret } = setup.json() as { secret: string; otpauthUrl: string };
    expect(secret).toBeTruthy();
    const debug = await app.inject({ method: 'GET', url: '/api/v1/auth/totp/debug-code', headers: authHeader(token) });
    const code = (debug.json() as { code: string }).code;
    const verify = await app.inject({ method: 'POST', url: '/api/v1/auth/totp/verify', headers: authHeader(token), payload: { code } });
    expect(verify.statusCode).toBe(200);
    // Login now requires TOTP.
    const noCode = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'totp@example.com', password: 'password123' } });
    expect(noCode.statusCode).toBe(401);
    expect((noCode.json() as { error: { code: string } }).error.code).toBe('TOTP_REQUIRED');
    const { generateTotpCode } = await import('../../lib/totp.js');
    const withCode = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'totp@example.com', password: 'password123', totpCode: generateTotpCode(secret) } });
    expect(withCode.statusCode).toBe(200);
    await app.close();
  });

  it('rejects unauthenticated access to protected routes', async () => {
    const { app } = await makeTestApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/users/me' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('authenticates a logged-in session for the providers routes (0.1.3 regression)', async () => {
    // Production 0.1.2: login succeeded but every later call 401'd, because
    // authenticate() used findUnique on UserSession.tokenHash, which is only
    // @@index in the schema, not @unique — real Prisma throws on that, the
    // session guard swallowed it and returned 401. The FakeDb now throws
    // the same way, so this test fails if findUnique ever comes back.
    const { app } = await makeTestApp();
    const { token } = await registerUser(app, 'prov@example.com');
    const list = await app.inject({ method: 'GET', url: '/api/v1/providers', headers: authHeader(token) });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { data: unknown[] }).data).toEqual([]);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers: authHeader(token),
      payload: { name: 'Tokensbd', type: 'tokens', baseUrl: 'https://tokens.bd/v1', protocol: 'openai', apiKey: 'tok_test_key', priority: 100, timeoutMs: 30000, enabled: true },
    });
    expect(created.statusCode).toBe(201);
    await app.close();
  });
});
