// modules/wiring.test.ts — the dashboard + gateway modules are actually
// reachable from the live app (buildApp), not just in isolation.
// Covers: /v1 gateway auth, provider creation, a failed gateway call being
// recorded in usage, and session guards on the dashboard routes.
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../lib/crypto.js';
import { authHeader, makeTestApp, registerUser } from '../test/helpers.js';

const ROUTER_KEY = 'rk_live_test-wiring-key-123';

describe('wiring (live app)', () => {
  it('serves /v1/models with a router key and 401s without one', async () => {
    const { app, db } = await makeTestApp();
    const { id: userId } = await registerUser(app, 'wire@example.com');
    db.apiKeys.push({
      id: 'key-1',
      userId,
      name: 'test',
      keyHash: sha256Hex(ROUTER_KEY),
      keyPrefix: 'rk_live_test',
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
      restrictions: null,
      createdAt: new Date(),
    });

    const authed = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${ROUTER_KEY}` },
    });
    expect(authed.statusCode).toBe(200);
    expect(authed.json()).toMatchObject({ object: 'list', data: [] });

    const anon = await app.inject({ method: 'GET', url: '/v1/models' });
    expect(anon.statusCode).toBe(401);
  });

  it('guards dashboard routes with the session and records a failed gateway call in usage', async () => {
    const { app, db } = await makeTestApp();
    const { id: userId, token } = await registerUser(app, 'wire2@example.com');
    db.apiKeys.push({
      id: 'key-2',
      userId,
      name: 'test',
      keyHash: sha256Hex(ROUTER_KEY),
      keyPrefix: 'rk_live_test',
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
      restrictions: null,
      createdAt: new Date(),
    });

    // Dashboard providers route: 401 without a session, 200 with one.
    const noSession = await app.inject({ method: 'GET', url: '/api/v1/providers' });
    expect(noSession.statusCode).toBe(401);
    const withSession = await app.inject({
      method: 'GET',
      url: '/api/v1/providers',
      headers: authHeader(token),
    });
    expect(withSession.statusCode).toBe(200);

    // Add an unreachable custom provider (local base URL allowed).
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers: authHeader(token),
      payload: {
        name: 'Unreachable',
        type: 'custom',
        baseUrl: 'http://127.0.0.1:9/v1',
        credential: 'sk-test',
      },
    });
    expect(created.statusCode).toBe(201);

    // Gateway call through the router key: provider unreachable, so the
    // gateway must fail cleanly (JSON, not HTML) and record the attempt.
    const call = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${ROUTER_KEY}` },
      payload: {
        model: 'custom/test-model',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(call.statusCode).toBeGreaterThanOrEqual(400);
    expect(call.headers['content-type']).toContain('application/json');

    const usage = await app.inject({
      method: 'GET',
      url: '/api/v1/usage',
      headers: authHeader(token),
    });
    expect(usage.statusCode).toBe(200);
    const body = usage.json() as { total: number; rows: Array<{ status: string }> };
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.rows.some((r) => r.status === 'FAILED')).toBe(true);
  });
});
