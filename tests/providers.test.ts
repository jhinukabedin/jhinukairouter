// Providers + models API tests (Builder 2). Covers CRUD, SSRF guard,
// test-connection, sync-models, model PATCH, and the required test (c):
// add a custom provider via API, list it, route one request to it via a
// mock fixture. No live keys, no live DB/Redis.

import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IdempotencyStore } from '../packages/provider-sdk/src/index.js';
import type { UsageRecordInput } from '../apps/api/src/modules/gateway/types.js';
import { createSha256KeyLookup, registerGatewayRoutes } from '../apps/api/src/modules/gateway/routes.js';
import { createStoreChainResolver, createStoreProviderSource } from '../apps/api/src/modules/gateway/storeResolver.js';
import { registerModelRoutes } from '../apps/api/src/modules/models/routes.js';
import { InMemoryModelStore, InMemoryProviderStore } from '../apps/api/src/modules/providers/store.js';
import { registerProviderRoutes } from '../apps/api/src/modules/providers/routes.js';
import { FetchMock, openAIChatSuccess } from './helpers/mockFetch.js';

const CUSTOM_BASE = 'https://api.custom.test/v1';

async function buildApiApp(allowLocal: boolean) {
  const providers = new InMemoryProviderStore();
  const models = new InMemoryModelStore();
  const app = Fastify();
  await app.register(
    async (i: FastifyInstance) => {
      registerProviderRoutes(i, { providers, models, allowLocalProviders: allowLocal });
      registerModelRoutes(i, { models });
    },
    { prefix: '/api/v1' },
  );
  await app.ready();
  return { app, providers, models };
}

describe('providers CRUD + SSRF', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    ({ app } = await buildApiApp(false));
  });

  afterEach(async () => {
    await app.close();
  });

  it('creates a provider without ever returning the credential', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers: { 'content-type': 'application/json' },
      payload: {
        name: 'My Custom',
        type: 'custom',
        baseUrl: CUSTOM_BASE,
        protocol: 'openai',
        credential: 'sk-secret-1234',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { data: { id: string; keyHint: string | null; baseUrl: string } };
    expect(body.data.keyHint).toBe('1234');
    expect(body.data.baseUrl).toBe(CUSTOM_BASE);
    expect(JSON.stringify(body)).not.toContain('sk-secret-1234');

    const get = await app.inject({ method: 'GET', url: `/api/v1/providers/${body.data.id}` });
    expect(get.statusCode).toBe(200);
    expect(JSON.stringify(get.json())).not.toContain('sk-secret-1234');
  });

  it('rejects localhost/private base URLs unless allowLocalProviders', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'Local', type: 'custom', baseUrl: 'http://127.0.0.1:8080/v1', credential: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('invalid_base_url');
  });

  it('rejects ollama without the explicit allow-local setting', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'Local Ollama', type: 'ollama', credential: 'ollama' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('local_provider_not_allowed');
  });

  it('requires baseUrl for custom providers and validates input', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'No URL', type: 'custom', credential: 'x' },
    });
    expect(res.statusCode).toBe(400);

    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers: { 'content-type': 'application/json' },
      payload: { name: '', type: 'custom', baseUrl: CUSTOM_BASE },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('PATCH updates and DELETE removes the provider and its models', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'Temp', type: 'tokens', credential: 'tok-1' },
    });
    const id = (created.json() as { data: { id: string } }).data.id;
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/providers/${id}`,
      headers: { 'content-type': 'application/json' },
      payload: { name: 'Temp Renamed', enabled: false },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { data: { name: string; enabled: boolean } }).data).toMatchObject({
      name: 'Temp Renamed',
      enabled: false,
    });
    const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/providers/${id}` });
    expect(deleted.statusCode).toBe(204);
    const gone = await app.inject({ method: 'GET', url: `/api/v1/providers/${id}` });
    expect(gone.statusCode).toBe(404);
  });
});

describe('providers test + sync-models (mock fixtures)', () => {
  const fetchMock = new FetchMock();
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    fetchMock.reset();
    fetchMock.install();
    ({ app } = await buildApiApp(false));
  });

  afterEach(async () => {
    fetchMock.restore();
    await app.close();
  });

  it('test-connection succeeds with a mocked /models 200', async () => {
    fetchMock.onJson('GET', `${CUSTOM_BASE}/models`, 200, { data: [{ id: 'custom-model-1' }] });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'Custom', type: 'custom', baseUrl: CUSTOM_BASE, credential: 'sk-test' },
    });
    const id = (created.json() as { data: { id: string } }).data.id;
    const res = await app.inject({ method: 'POST', url: `/api/v1/providers/${id}/test` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { ok: boolean } }).data.ok).toBe(true);
  });

  it('test-connection reports failure on a mocked 401', async () => {
    fetchMock.onJson('GET', `${CUSTOM_BASE}/models`, 401, { error: { message: 'bad key' } });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'Custom', type: 'custom', baseUrl: CUSTOM_BASE, credential: 'sk-bad' },
    });
    const id = (created.json() as { data: { id: string } }).data.id;
    const res = await app.inject({ method: 'POST', url: `/api/v1/providers/${id}/test` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { ok: boolean } }).data.ok).toBe(false);
  });

  it('test-connection without a stored credential is a 400', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'No Key', type: 'tokens' },
    });
    const id = (created.json() as { data: { id: string } }).data.id;
    const res = await app.inject({ method: 'POST', url: `/api/v1/providers/${id}/test` });
    expect(res.statusCode).toBe(400);
  });

  it('sync-models upserts models and PATCH /models can disable one', async () => {
    fetchMock.onJson('GET', `${CUSTOM_BASE}/models`, 200, {
      data: [{ id: 'custom-model-1' }, { id: 'custom-model-2' }],
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'Custom', type: 'custom', baseUrl: CUSTOM_BASE, credential: 'sk-test' },
    });
    const id = (created.json() as { data: { id: string } }).data.id;
    const sync = await app.inject({ method: 'POST', url: `/api/v1/providers/${id}/sync-models` });
    expect(sync.statusCode).toBe(200);
    expect((sync.json() as { data: { synced: number } }).data.synced).toBe(2);

    // Second sync is idempotent — no duplicates.
    const sync2 = await app.inject({ method: 'POST', url: `/api/v1/providers/${id}/sync-models` });
    expect((sync2.json() as { data: { synced: number } }).data.synced).toBe(2);
    const list = await app.inject({ method: 'GET', url: `/api/v1/models?providerId=${id}` });
    const models = (list.json() as { data: Array<{ id: string; modelId: string; enabled: boolean }> }).data;
    expect(models).toHaveLength(2);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/models/${models[0].id}`,
      headers: { 'content-type': 'application/json' },
      payload: { enabled: false, displayName: 'Custom Model 1' },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { data: { enabled: boolean; displayName: string } }).data).toMatchObject({
      enabled: false,
      displayName: 'Custom Model 1',
    });
  });
});

describe('add custom provider via API, list it, route one request to it (test (c))', () => {
  const fetchMock = new FetchMock();
  const usage: UsageRecordInput[] = [];
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    fetchMock.reset();
    usage.length = 0;
    fetchMock.install();
    const providers = new InMemoryProviderStore();
    const models = new InMemoryModelStore();
    app = Fastify();
    await app.register(
      async (i: FastifyInstance) => {
        registerProviderRoutes(i, { providers, models, allowLocalProviders: false });
        registerModelRoutes(i, { models });
      },
      { prefix: '/api/v1' },
    );
    const keyHash = createHash('sha256').update('router-key-123').digest('hex');
    await app.register(
      async (i: FastifyInstance) => {
        registerGatewayRoutes(i, {
          keyLookup: createSha256KeyLookup([{ keyHash, userId: 'user-1', apiKeyId: 'key-1' }]),
          providerSource: createStoreProviderSource({ providers, models }),
          chainResolver: createStoreChainResolver({ providers, models }),
          recordUsage: (rec) => {
            usage.push(rec);
          },
          idempotency: new IdempotencyStore(),
          modelsList: async () => {
            const all = await models.list({ enabled: true });
            return all.map((m) => ({ id: m.modelId, object: 'model' as const, owned_by: 'custom' }));
          },
        });
      },
      { prefix: '/v1' },
    );
    await app.ready();
  });

  afterEach(async () => {
    fetchMock.restore();
    await app.close();
  });

  it('custom provider added via API serves a gateway request via mock fixture', async () => {
    fetchMock.onJson('GET', `${CUSTOM_BASE}/models`, 200, { data: [{ id: 'custom-model-1' }] });
    fetchMock.onJson('POST', `${CUSTOM_BASE}/chat/completions`, 200, openAIChatSuccess('custom-model-1', 'hello from custom'));

    // 1. Add the custom provider via the API.
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/providers',
      headers: { 'content-type': 'application/json' },
      payload: { name: 'My Custom', type: 'custom', baseUrl: CUSTOM_BASE, credential: 'sk-custom-1' },
    });
    expect(created.statusCode).toBe(201);
    const providerId = (created.json() as { data: { id: string } }).data.id;

    // 2. List it.
    const list = await app.inject({ method: 'GET', url: '/api/v1/providers' });
    const providers = (list.json() as { data: Array<{ id: string; type: string }> }).data;
    expect(providers.some((p) => p.id === providerId && p.type === 'custom')).toBe(true);

    // 3. Sync models so the new model appears in /v1/models immediately.
    const sync = await app.inject({ method: 'POST', url: `/api/v1/providers/${providerId}/sync-models` });
    expect(sync.statusCode).toBe(200);
    const modelsRes = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer router-key-123' },
    });
    expect(modelsRes.statusCode).toBe(200);
    expect((modelsRes.json() as { data: Array<{ id: string }> }).data.map((m) => m.id)).toContain('custom-model-1');

    // 4. Route one request to it via the mock fixture.
    const chat = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer router-key-123', 'content-type': 'application/json' },
      payload: { model: 'custom-model-1', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(chat.statusCode).toBe(200);
    const body = chat.json() as { model: string; choices: Array<{ message: { content: string } }> };
    expect(body.model).toBe('custom-model-1');
    expect(body.choices[0].message.content).toBe('hello from custom');
    expect(fetchMock.callsTo(`${CUSTOM_BASE}/chat/completions`)).toHaveLength(1);
    expect(usage).toHaveLength(1);
    expect(usage[0].provider).toBe('custom');
    expect(usage[0].model).toBe('custom-model-1');
  });
});
