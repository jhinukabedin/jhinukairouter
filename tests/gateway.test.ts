// Gateway tests (Builder 2). Covers auth, per-agent multi-model fallback
// (test (b): mock 429 on primary -> fallback serves), streaming rules,
// /v1/models, /v1/embeddings, /v1/responses, /v1/messages, idempotency
// and the no-double-bill usage rule. No live keys, no live DB/Redis.

import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IdempotencyStore, createOpenAICompatibleAdapter } from '../packages/provider-sdk/src/index.js';
import type { ModelChainEntry } from '../packages/shared/src/index.js';
import { createSha256KeyLookup, registerGatewayRoutes } from '../apps/api/src/modules/gateway/routes.js';
import type { GatewayDeps, UsageRecordInput } from '../apps/api/src/modules/gateway/types.js';
import { FetchMock, openAIChatSuccess, openAISseStream } from './helpers/mockFetch.js';

const PRIMARY = 'https://primary.example.test/v1';
const FALLBACK = 'https://fallback.example.test/v1';
const ROUTER_KEY = 'router-key-123';

function buildApp(chain: ModelChainEntry[], usage: UsageRecordInput[]) {
  const keyHash = createHash('sha256').update(ROUTER_KEY).digest('hex');
  const deps: GatewayDeps = {
    keyLookup: createSha256KeyLookup([{ keyHash, userId: 'user-1', apiKeyId: 'key-1' }]),
    providerSource: async (entry) => {
      const baseUrl = entry.provider === 'primary' ? PRIMARY : entry.provider === 'fallback' ? FALLBACK : null;
      if (!baseUrl) return null;
      return {
        adapter: createOpenAICompatibleAdapter({ id: entry.provider, baseUrl }),
        credential: `sk-${entry.provider}`,
        baseUrl,
        timeoutMs: 10_000,
      };
    },
    chainResolver: async () => chain,
    recordUsage: (rec) => {
      usage.push(rec);
    },
    idempotency: new IdempotencyStore(),
    modelsList: async () => [
      { id: 'primary-model', object: 'model', owned_by: 'primary' },
      { id: 'fallback-model', object: 'model', owned_by: 'fallback' },
    ],
    keepAliveMs: 60_000,
    maxRetryAfterMs: 10,
  };
  const app = Fastify();
  return { app, deps };
}

const authHeaders = { authorization: `Bearer ${ROUTER_KEY}`, 'content-type': 'application/json' };

describe('gateway auth', () => {
  const fetchMock = new FetchMock();
  const usage: UsageRecordInput[] = [];
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    fetchMock.reset();
    usage.length = 0;
    fetchMock.install();
    const built = buildApp([{ provider: 'primary', model: 'primary-model' }], usage);
    app = built.app;
    await app.register(async (i: FastifyInstance) => registerGatewayRoutes(i, built.deps), { prefix: '/v1' });
    await app.ready();
  });

  afterEach(async () => {
    fetchMock.restore();
    await app.close();
  });

  it('rejects missing and wrong bearer keys', async () => {
    const noAuth = await app.inject({ method: 'GET', url: '/v1/models' });
    expect(noAuth.statusCode).toBe(401);
    const wrong = await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: 'Bearer nope' } });
    expect(wrong.statusCode).toBe(401);
    expect(usage).toHaveLength(0);
  });

  it('lists models in OpenAI format', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${ROUTER_KEY}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { object: string; data: Array<{ id: string }> };
    expect(body.object).toBe('list');
    expect(body.data.map((m) => m.id)).toEqual(['primary-model', 'fallback-model']);
  });
});

describe('gateway fallback (test (b))', () => {
  const fetchMock = new FetchMock();
  const usage: UsageRecordInput[] = [];
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    fetchMock.reset();
    usage.length = 0;
    fetchMock.install();
    const built = buildApp(
      [
        { provider: 'primary', model: 'primary-model' },
        { provider: 'fallback', model: 'fallback-model' },
      ],
      usage,
    );
    app = built.app;
    await app.register(async (i: FastifyInstance) => registerGatewayRoutes(i, built.deps), { prefix: '/v1' });
    await app.ready();
  });

  afterEach(async () => {
    fetchMock.restore();
    await app.close();
  });

  it('mock 429 on primary -> fallback model serves, usage recorded once', async () => {
    fetchMock.onJson('POST', `${PRIMARY}/chat/completions`, 429, {
      error: { message: 'rate limited', type: 'rate_limit_error' },
    });
    fetchMock.onJson('POST', `${FALLBACK}/chat/completions`, 200, openAIChatSuccess('fallback-model', 'fallback answer'));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders,
      payload: { model: 'primary-model', messages: [{ role: 'user', content: 'hello' }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { model: string; choices: Array<{ message: { content: string } }>; usage: { total_tokens: number } };
    expect(body.model).toBe('fallback-model');
    expect(body.choices[0].message.content).toBe('fallback answer');
    expect(body.usage.total_tokens).toBe(15);
    expect(fetchMock.callsTo(`${PRIMARY}/chat/completions`)).toHaveLength(1);
    expect(fetchMock.callsTo(`${FALLBACK}/chat/completions`)).toHaveLength(1);
    // NEVER double-bill: exactly one usage record, for the model that served.
    expect(usage).toHaveLength(1);
    expect(usage[0].status).toBe('SUCCESS');
    expect(usage[0].provider).toBe('fallback');
    expect(usage[0].model).toBe('fallback-model');
    expect(usage[0].attemptedChain).toEqual([
      { provider: 'primary', model: 'primary-model' },
      { provider: 'fallback', model: 'fallback-model' },
    ]);
  });

  it('honours Retry-After and retries the next model', async () => {
    fetchMock.on({
      method: 'POST',
      url: `${PRIMARY}/chat/completions`,
      status: 429,
      body: { error: { message: 'slow down' } },
      headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
    });
    fetchMock.onJson('POST', `${FALLBACK}/chat/completions`, 200, openAIChatSuccess('fallback-model', 'ok'));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders,
      payload: { model: 'primary-model', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(usage).toHaveLength(1);
    expect(usage[0].model).toBe('fallback-model');
  });

  it('NEVER retries 401 or 400 — fails fast, no fallback call', async () => {
    fetchMock.onJson('POST', `${PRIMARY}/chat/completions`, 401, { error: { message: 'bad key' } });
    fetchMock.onJson('POST', `${FALLBACK}/chat/completions`, 200, openAIChatSuccess('fallback-model', 'should not be called'));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders,
      payload: { model: 'primary-model', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(401);
    expect(fetchMock.callsTo(`${FALLBACK}/chat/completions`)).toHaveLength(0);
    expect(usage).toHaveLength(1);
    expect(usage[0].status).toBe('FAILED');

    fetchMock.reset();
    fetchMock.onJson('POST', `${PRIMARY}/chat/completions`, 400, { error: { message: 'bad request' } });
    const res400 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders,
      payload: { model: 'primary-model', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res400.statusCode).toBe(400);
    expect(fetchMock.callsTo(`${FALLBACK}/chat/completions`)).toHaveLength(0);
  });

  it('fails with 502 when every model in the chain is down', async () => {
    fetchMock.onJson('POST', `${PRIMARY}/chat/completions`, 500, { error: { message: 'boom' } });
    fetchMock.onJson('POST', `${FALLBACK}/chat/completions`, 503, { error: { message: 'down' } });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders,
      payload: { model: 'primary-model', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(502);
    expect(usage).toHaveLength(1);
    expect(usage[0].status).toBe('FAILED');
  });

  it('validates the request body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders,
      payload: { model: 'primary-model', messages: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(usage).toHaveLength(0);
  });
});

describe('gateway streaming', () => {
  const fetchMock = new FetchMock();
  const usage: UsageRecordInput[] = [];
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    fetchMock.reset();
    usage.length = 0;
    fetchMock.install();
    const built = buildApp(
      [
        { provider: 'primary', model: 'primary-model' },
        { provider: 'fallback', model: 'fallback-model' },
      ],
      usage,
    );
    app = built.app;
    await app.register(async (i: FastifyInstance) => registerGatewayRoutes(i, built.deps), { prefix: '/v1' });
    await app.ready();
  });

  afterEach(async () => {
    fetchMock.restore();
    await app.close();
  });

  it('streams SSE chunks with usage + tokens_saved and records usage once', async () => {
    fetchMock.on({
      method: 'POST',
      url: `${PRIMARY}/chat/completions`,
      status: 200,
      body: openAISseStream('primary-model', ['Hello', ' world']),
      headers: { 'Content-Type': 'text/event-stream' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders,
      payload: { model: 'primary-model', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.payload).toContain('Hello');
    expect(res.payload).toContain('world');
    expect(res.payload).toContain('[DONE]');
    expect(res.payload).toContain('tokens_saved');
    expect(fetchMock.callsTo(`${FALLBACK}/chat/completions`)).toHaveLength(0);
    expect(usage).toHaveLength(1);
    expect(usage[0].status).toBe('SUCCESS');
    expect(usage[0].model).toBe('primary-model');
  });

  it('falls back before the first streamed chunk when primary returns 429', async () => {
    fetchMock.onJson('POST', `${PRIMARY}/chat/completions`, 429, { error: { message: 'rate limited' } });
    fetchMock.on({
      method: 'POST',
      url: `${FALLBACK}/chat/completions`,
      status: 200,
      body: openAISseStream('fallback-model', ['fallback', ' stream']),
      headers: { 'Content-Type': 'text/event-stream' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders,
      payload: { model: 'primary-model', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('fallback');
    expect(res.payload).toContain('stream');
    expect(usage).toHaveLength(1);
    expect(usage[0].model).toBe('fallback-model');
  });
});

describe('gateway other endpoints', () => {
  const fetchMock = new FetchMock();
  const usage: UsageRecordInput[] = [];
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    fetchMock.reset();
    usage.length = 0;
    fetchMock.install();
    const built = buildApp([{ provider: 'primary', model: 'primary-model' }], usage);
    app = built.app;
    await app.register(async (i: FastifyInstance) => registerGatewayRoutes(i, built.deps), { prefix: '/v1' });
    await app.ready();
  });

  afterEach(async () => {
    fetchMock.restore();
    await app.close();
  });

  it('POST /v1/messages returns Anthropic format', async () => {
    fetchMock.onJson('POST', `${PRIMARY}/chat/completions`, 200, openAIChatSuccess('primary-model', 'anthropic reply'));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: authHeaders,
      payload: { model: 'primary-model', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { type: string; role: string; content: Array<{ type: string; text: string }>; stop_reason: string };
    expect(body.type).toBe('message');
    expect(body.role).toBe('assistant');
    expect(body.content[0].text).toBe('anthropic reply');
    expect(body.stop_reason).toBe('end_turn');
    expect(usage).toHaveLength(1);
  });

  it('POST /v1/responses returns a Responses object', async () => {
    fetchMock.onJson('POST', `${PRIMARY}/chat/completions`, 200, openAIChatSuccess('primary-model', 'response text'));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: authHeaders,
      payload: { model: 'primary-model', input: 'hello?' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { object: string; output: Array<{ content: Array<{ text: string }> }> };
    expect(body.object).toBe('response');
    expect(body.output[0].content[0].text).toBe('response text');
    expect(usage).toHaveLength(1);
  });

  it('POST /v1/embeddings passes through to the provider', async () => {
    fetchMock.onJson('POST', `${PRIMARY}/embeddings`, 200, {
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
      model: 'primary-model',
      usage: { prompt_tokens: 2, total_tokens: 2 },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: authHeaders,
      payload: { model: 'primary-model', input: 'hello' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ embedding: number[] }> };
    expect(body.data[0].embedding).toEqual([0.1, 0.2]);
  });

  it('duplicate idempotency key replays the stored response without a second provider call', async () => {
    fetchMock.onJson('POST', `${PRIMARY}/chat/completions`, 200, openAIChatSuccess('primary-model', 'once only'));
    const payload = { model: 'primary-model', messages: [{ role: 'user', content: 'hi' }], idempotencyKey: 'idem-1' };
    const first = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders, payload });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders, payload });
    expect(second.statusCode).toBe(200);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());
    expect(fetchMock.callsTo(`${PRIMARY}/chat/completions`)).toHaveLength(1);
    expect(usage).toHaveLength(1);
  });

  it('unknown model returns 404 and records a failed usage entry', async () => {
    const built = buildApp([], usage);
    const app2 = Fastify();
    await app2.register(async (i: FastifyInstance) => registerGatewayRoutes(i, built.deps), { prefix: '/v1' });
    await app2.ready();
    const res = await app2.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders,
      payload: { model: 'no-such-model', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(404);
    expect(usage).toHaveLength(1);
    expect(usage[0].status).toBe('FAILED');
    await app2.close();
  });
});
