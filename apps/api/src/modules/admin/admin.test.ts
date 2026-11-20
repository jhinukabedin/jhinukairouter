import { describe, expect, it } from 'vitest';
import { authHeader, makeTestApp, registerUser } from '../../test/helpers.js';

describe('admin module', () => {
  it('first user (SUPER_ADMIN) can list users; plain USER cannot', async () => {
    const { app } = await makeTestApp();
    const admin = await registerUser(app, 'admin@example.com');
    const user = await registerUser(app, 'plain@example.com');
    const ok = await app.inject({ method: 'GET', url: '/api/v1/admin/users', headers: authHeader(admin.token) });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { total: number }).total).toBe(2);
    const denied = await app.inject({ method: 'GET', url: '/api/v1/admin/users', headers: authHeader(user.token) });
    expect(denied.statusCode).toBe(403);
    await app.close();
  });

  it('suspend blocks login and revokes sessions; activate restores login', async () => {
    const { app } = await makeTestApp();
    const admin = await registerUser(app, 'admin2@example.com');
    const victim = await registerUser(app, 'victim@example.com');
    const susp = await app.inject({ method: 'POST', url: `/api/v1/admin/users/${victim.id}/suspend`, headers: authHeader(admin.token) });
    expect(susp.statusCode).toBe(200);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'victim@example.com', password: 'password123' } });
    expect(login.statusCode).toBe(401);
    const me = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: authHeader(victim.token) });
    expect(me.statusCode).toBe(401);
    const act = await app.inject({ method: 'POST', url: `/api/v1/admin/users/${victim.id}/activate`, headers: authHeader(admin.token) });
    expect(act.statusCode).toBe(200);
    const login2 = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'victim@example.com', password: 'password123' } });
    expect(login2.statusCode).toBe(200);
    await app.close();
  });

  it('admin cannot suspend their own account', async () => {
    const { app } = await makeTestApp();
    const admin = await registerUser(app, 'selfadmin@example.com');
    const res = await app.inject({ method: 'POST', url: `/api/v1/admin/users/${admin.id}/suspend`, headers: authHeader(admin.token) });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('audit logs record admin actions and are readable by admins', async () => {
    const { app } = await makeTestApp();
    const admin = await registerUser(app, 'auditadmin@example.com');
    await registerUser(app, 'audited@example.com');
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/audit-logs', headers: authHeader(admin.token) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { logs: Array<{ action: string }> };
    expect(body.logs.some((l) => l.action === 'auth.register')).toBe(true);
    await app.close();
  });

  it('system settings can be read and patched by admins only', async () => {
    const { app } = await makeTestApp();
    const admin = await registerUser(app, 'setadmin@example.com');
    const user = await registerUser(app, 'setuser@example.com');
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/system-settings',
      headers: authHeader(admin.token),
      payload: { settings: { allowLocalProviders: true } },
    });
    expect(patch.statusCode).toBe(200);
    const get = await app.inject({ method: 'GET', url: '/api/v1/admin/system-settings', headers: authHeader(admin.token) });
    expect((get.json() as { settings: Record<string, unknown> }).settings.allowLocalProviders).toBe(true);
    const denied = await app.inject({ method: 'GET', url: '/api/v1/admin/system-settings', headers: authHeader(user.token) });
    expect(denied.statusCode).toBe(403);
    await app.close();
  });

  it('admin can create a user with a role', async () => {
    const { app } = await makeTestApp();
    const admin = await registerUser(app, 'createadmin@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: authHeader(admin.token),
      payload: { email: 'newbie@example.com', password: 'password123', role: 'MANAGER' },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { email: string }).email).toBe('newbie@example.com');
    const badRole = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: authHeader(admin.token),
      payload: { email: 'bad@example.com', password: 'password123', role: 'NOPE' },
    });
    expect(badRole.statusCode).toBe(400);
    await app.close();
  });
});
