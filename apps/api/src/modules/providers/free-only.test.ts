// Regression tests for OpenRouter free-only sync (0.1.6).
// Syncing OpenRouter pulled the whole catalog (hundreds of paid models).
// With freeOnly on an OpenRouter provider, sync keeps only ids ending in
// `:free` and prunes paid models synced earlier. The flag is ignored for
// other providers (their ids never carry the suffix — filtering them would
// sync zero models).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authHeader, makeTestApp, registerUser } from '../../test/helpers.js';

const OPENROUTER_MODELS = [
  { id: 'openai/gpt-4o' },
  { id: 'meta-llama/llama-3.3-70b-instruct:free' },
  { id: 'deepseek/deepseek-r1:free' },
  { id: 'anthropic/claude-3.5-sonnet' },
];

function stubOpenRouterModels() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ data: OPENROUTER_MODELS }),
    })) as unknown as typeof fetch,
  );
}

async function makeProvider(app: Awaited<ReturnType<typeof makeTestApp>>['app'], token: string, extra: Record<string, unknown> = {}) {
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/providers',
    headers: authHeader(token),
    payload: { name: 'OpenRouter', type: 'openrouter', apiKey: 'sk-or-test', priority: 100, timeoutMs: 30000, enabled: true, ...extra },
  });
  expect(created.statusCode).toBe(201);
  return (created.json() as { data: { id: string } }).data.id;
}

async function sync(app: Awaited<ReturnType<typeof makeTestApp>>['app'], token: string, id: string) {
  const res = await app.inject({ method: 'POST', url: `/api/v1/providers/${id}/sync-models`, headers: authHeader(token) });
  expect(res.statusCode).toBe(200);
  return res.json() as { data: { synced: number; models: { modelId: string }[]; pruned: number } };
}

async function listModelIds(app: Awaited<ReturnType<typeof makeTestApp>>['app'], token: string): Promise<string[]> {
  const res = await app.inject({ method: 'GET', url: '/api/v1/models', headers: authHeader(token) });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { data?: { modelId: string }[] } | { modelId: string }[];
  const rows = Array.isArray(body) ? body : (body.data ?? []);
  return rows.map((m) => m.modelId).sort();
}

describe('OpenRouter free-only sync', () => {
  beforeEach(() => stubOpenRouterModels());
  afterEach(() => vi.unstubAllGlobals());

  it('syncs everything without the flag, then prunes paid models once it is on', async () => {
    const { app } = await makeTestApp();
    const { token } = await registerUser(app, 'freeonly@example.com');
    const id = await makeProvider(app, token);

    const first = await sync(app, token, id);
    expect(first.data.synced).toBe(4);
    expect(first.data.pruned).toBe(0);
    expect(await listModelIds(app, token)).toEqual([
      'anthropic/claude-3.5-sonnet',
      'deepseek/deepseek-r1:free',
      'meta-llama/llama-3.3-70b-instruct:free',
      'openai/gpt-4o',
    ]);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/providers/${id}`,
      headers: authHeader(token),
      payload: { freeOnly: true },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { data: { freeOnly: boolean } }).data.freeOnly).toBe(true);

    const second = await sync(app, token, id);
    expect(second.data.synced).toBe(2);
    expect(second.data.pruned).toBe(2);
    expect(second.data.models.map((m) => m.modelId).sort()).toEqual([
      'deepseek/deepseek-r1:free',
      'meta-llama/llama-3.3-70b-instruct:free',
    ]);
    expect(await listModelIds(app, token)).toEqual([
      'deepseek/deepseek-r1:free',
      'meta-llama/llama-3.3-70b-instruct:free',
    ]);
    await app.close();
  });

  it('syncs only :free models when freeOnly is set at creation', async () => {
    const { app } = await makeTestApp();
    const { token } = await registerUser(app, 'freeonly2@example.com');
    const id = await makeProvider(app, token, { freeOnly: true });
    const r = await sync(app, token, id);
    expect(r.data.synced).toBe(2);
    expect(r.data.pruned).toBe(0);
    expect(await listModelIds(app, token)).toEqual([
      'deepseek/deepseek-r1:free',
      'meta-llama/llama-3.3-70b-instruct:free',
    ]);
    await app.close();
  });

  it('ignores the flag for non-OpenRouter providers', async () => {
    const { app } = await makeTestApp();
    const { token } = await registerUser(app, 'freeonly3@example.com');
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers: authHeader(token),
      payload: { name: 'Tokens', type: 'tokens', baseUrl: 'https://tokens.bd/v1', apiKey: 'tok_test', freeOnly: true },
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { data: { id: string } }).data.id;
    const r = await sync(app, token, id);
    expect(r.data.synced).toBe(4);
    expect(r.data.pruned).toBe(0);
    await app.close();
  });
});
