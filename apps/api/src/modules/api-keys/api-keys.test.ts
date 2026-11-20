import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../lib/crypto.js';
import { authHeader, makeTestApp, registerUser } from '../../test/helpers.js';

describe('api-keys module', () => {
  it('creates a key, shows it once, and never stores the raw key', async () => {
    const { app, db } = await makeTestApp();
    const { token } = await registerUser(app, 'keys@example.com');
    const res = await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers: authHeader(token), payload: { name: 'OpenCode' } });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { key: string; keyPrefix: string; id: string };
    expect(body.key.startsWith('rk_live_')).toBe(true);
    expect(body.keyPrefix).toBe(body.key.slice(0, 12));
    // Only the hash is stored.
    const stored = db.apiKeys[0];
    expect(stored?.keyHash).toBe(sha256Hex(body.key));
    expect(stored?.keyHash).not.toBe(body.key);
    // Listing never returns the full key.
    const list = await app.inject({ method: 'GET', url: '/api/v1/api-keys', headers: authHeader(token) });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(body.key);
    expect((list.json() as { apiKeys: unknown[] }).apiKeys).toHaveLength(1);
    await app.close();
  });

  it('revokes a key and regenerates a new one', async () => {
    const { app, db } = await makeTestApp();
    const { token } = await registerUser(app, 'regen@example.com');
    const created = await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers: authHeader(token), payload: { name: 'CLI' } });
    const first = created.json() as { id: string; key: string };
    const regen = await app.inject({ method: 'POST', url: `/api/v1/api-keys/${first.id}/regenerate`, headers: authHeader(token) });
    expect(regen.statusCode).toBe(201);
    const second = regen.json() as { id: string; key: string };
    expect(second.key).not.toBe(first.key);
    expect(db.apiKeys.find((k) => k.id === first.id)?.revokedAt).not.toBeNull();
    const del = await app.inject({ method: 'DELETE', url: `/api/v1/api-keys/${second.id}`, headers: authHeader(token) });
    expect(del.statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/api/v1/api-keys', headers: authHeader(token) });
    expect((list.json() as { apiKeys: unknown[] }).apiKeys).toHaveLength(0);
    await app.close();
  });

  it('enforces user isolation: cannot revoke another user’s key', async () => {
    const { app } = await makeTestApp();
    const alice = await registerUser(app, 'alice@example.com');
    const bob = await registerUser(app, 'bob@example.com');
    const created = await app.inject({ method: 'POST', url: '/api/v1/api-keys', headers: authHeader(alice.token), payload: { name: 'Alice key' } });
    const keyId = (created.json() as { id: string }).id;
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/api-keys/${keyId}`, headers: authHeader(bob.token) });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
