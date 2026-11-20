// Regression tests for the live Test/Sync 500 (0.1.4).
// The dashboard POSTs /test and /sync-models with NO body, but the web
// client used to always send Content-Type: application/json. Fastify's JSON
// parser rejects an empty body, and app.ts's error handler turned that 400
// into a 500 — so Test and Sync always alerted "Internal server error"
// while Create (which sends a body) worked fine.
//
// Two fixes, both covered here:
//  (a) app.ts honours Fastify's own 4xx statusCode instead of masking it
//      as a 500 (empty body + JSON content-type now answers 400, not 500);
//  (b) the web client only sends Content-Type when a body is present, so
//      a body-less POST never hits the parser at all (no content-type
//      header here = the fixed client behaviour).
import { describe, expect, it } from 'vitest';
import { authHeader, makeTestApp, registerUser } from '../../test/helpers.js';

async function makeProvider(app: Awaited<ReturnType<typeof makeTestApp>>['app'], token: string): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/providers',
    headers: authHeader(token),
    payload: { name: 'Tokensbd', type: 'tokens', baseUrl: 'https://tokens.bd/v1', protocol: 'openai', apiKey: 'tok_test_dummy', priority: 100, timeoutMs: 30000, enabled: true },
  });
  expect(created.statusCode).toBe(201);
  return (created.json() as { data: { id: string } }).data.id;
}

describe('provider Test/Sync with an empty body', () => {
  it('empty body + JSON content-type answers 400, not 500 (server fix)', async () => {
    const { app } = await makeTestApp();
    const { token } = await registerUser(app, 'emptybody@example.com');
    const id = await makeProvider(app, token);
    const test = await app.inject({
      method: 'POST',
      url: `/api/v1/providers/${id}/test`,
      headers: { ...authHeader(token), 'content-type': 'application/json' },
    });
    expect(test.statusCode).toBe(400);
    expect((test.json() as { error: { code: string } }).error.code).toBe('FST_ERR_CTP_EMPTY_JSON_BODY');
    const sync = await app.inject({
      method: 'POST',
      url: `/api/v1/providers/${id}/sync-models`,
      headers: { ...authHeader(token), 'content-type': 'application/json' },
    });
    expect(sync.statusCode).toBe(400);
    await app.close();
  });

  it('body-less POST without a content-type reaches the handler (client fix)', async () => {
    const { app } = await makeTestApp();
    const { token } = await registerUser(app, 'emptybody2@example.com');
    const id = await makeProvider(app, token);
    // Dummy key: the provider call fails auth, so Test reports ok:false…
    const test = await app.inject({
      method: 'POST',
      url: `/api/v1/providers/${id}/test`,
      headers: authHeader(token),
    });
    expect(test.statusCode).toBe(200);
    expect((test.json() as { data: { ok: boolean } }).data.ok).toBe(false);
    // …and Sync reports 502 with the provider error, not a 500.
    const sync = await app.inject({
      method: 'POST',
      url: `/api/v1/providers/${id}/sync-models`,
      headers: authHeader(token),
    });
    expect(sync.statusCode).toBe(502);
    expect((sync.json() as { error: { message: string } }).error.message).toMatch(/sync failed/);
    await app.close();
  });
});
