// RTK tests (Builder 2). Covers the in-gateway RTK optimisation unit
// behaviour plus the required integration test (a): one noisy-output
// request through the router records tokens in vs out and tokensSaved > 0.

import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  IdempotencyStore,
  createOpenAICompatibleAdapter,
  optimizeRequest,
  validateContextBudget,
} from '../packages/provider-sdk/src/index.js';
import type { NormalizedChatRequest } from '../packages/shared/src/index.js';
import { createSha256KeyLookup, registerGatewayRoutes } from '../apps/api/src/modules/gateway/routes.js';
import type { GatewayDeps, UsageRecordInput } from '../apps/api/src/modules/gateway/types.js';
import { FetchMock, openAIChatSuccess } from './helpers/mockFetch.js';

const noisyRequest = (): NormalizedChatRequest => ({
  userId: 'user-1',
  model: 'mock-model',
  messages: [
    { role: 'system', content: 'You   are   a    helpful   assistant.\n\n\nBe concise.' },
    { role: 'user', content: '   ' },
    { role: 'user', content: 'What is 2 + 2?' },
    {
      role: 'tool',
      content: `${'line of noisy tool output\n'.repeat(500)}${'x'.repeat(20_000)}`,
    },
    { role: 'user', content: 'Summarise the tool output above.' },
  ],
});

describe('optimizeRequest (unit)', () => {
  it('trims duplicate whitespace, drops empty messages, trims noisy tool output', () => {
    const result = optimizeRequest(noisyRequest());
    expect(result.tokensSaved).toBeGreaterThan(0);
    expect(result.optimizedTokens).toBeLessThan(result.originalTokens);
    expect(result.details.length).toBeGreaterThan(0);
    // Empty whitespace-only message dropped.
    expect(result.request.messages.some((m) => m.content.trim() === '')).toBe(false);
    // System message kept, last user message kept.
    expect(result.request.messages[0].role).toBe('system');
    expect(result.request.messages.at(-1)?.content).toContain('Summarise');
    // Tool output capped.
    const tool = result.request.messages.find((m) => m.role === 'tool');
    expect(tool).toBeDefined();
    expect(tool!.content.length).toBeLessThan(10_000);
  });

  it('collapses repeated lines inside tool output', () => {
    const req: NormalizedChatRequest = {
      userId: 'u',
      messages: [
        { role: 'user', content: 'run it' },
        { role: 'tool', content: `${'same line\n'.repeat(100)}done` },
      ],
    };
    const result = optimizeRequest(req);
    expect(result.tokensSaved).toBeGreaterThan(0);
    expect(result.request.messages[1].content).toContain('repeated line');
  });

  it('drops oldest non-system history over the context budget', () => {
    const messages = [{ role: 'system', content: 'sys' } as const];
    const req: NormalizedChatRequest = {
      userId: 'u',
      messages: [
        ...messages,
        ...Array.from({ length: 10 }, (_, i) => ({
          role: 'user' as const,
          content: `history message ${i} `.repeat(50),
        })),
        { role: 'user', content: 'latest question' },
      ],
    };
    const result = optimizeRequest(req, { maxContextTokens: 100 });
    expect(result.request.messages[0].role).toBe('system');
    expect(result.request.messages.at(-1)?.content).toBe('latest question');
    expect(result.request.messages.length).toBeLessThan(req.messages.length);
    expect(result.details.some((d) => d.includes('budget'))).toBe(true);
  });

  it('returns tokensSaved 0 when disabled', () => {
    const result = optimizeRequest(noisyRequest(), { enabled: false });
    expect(result.tokensSaved).toBe(0);
    expect(result.request.messages).toHaveLength(noisyRequest().messages.length);
  });
});

describe('validateContextBudget', () => {
  it('flags overflow and passes within budget', () => {
    const req: NormalizedChatRequest = {
      userId: 'u',
      messages: [{ role: 'user', content: 'x'.repeat(1000) }],
      maxTokens: 100,
    };
    const over = validateContextBudget(req, 100);
    expect(over.ok).toBe(false);
    expect(over.overflowTokens).toBeGreaterThan(0);
    const ok = validateContextBudget(req, 100_000);
    expect(ok.ok).toBe(true);
    expect(ok.overflowTokens).toBe(0);
  });
});

describe('IdempotencyStore', () => {
  it('replays a stored response and releases pending claims', () => {
    const store = new IdempotencyStore();
    expect(store.claim('k1').status).toBe('new');
    expect(store.claim('k1').status).toBe('pending');
    store.store('k1', { hello: 'world' });
    const replay = store.claim('k1');
    expect(replay.status).toBe('done');
    expect(replay.response).toEqual({ hello: 'world' });

    expect(store.claim('k2').status).toBe('new');
    store.release('k2');
    expect(store.claim('k2').status).toBe('new');
  });
});

describe('RTK through the gateway (integration, test (a))', () => {
  const fetchMock = new FetchMock();
  const usage: UsageRecordInput[] = [];
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    fetchMock.reset();
    usage.length = 0;
    fetchMock.onJson('POST', 'https://mock.example.test/v1/chat/completions', 200, openAIChatSuccess('mock-model', '4'));
    fetchMock.install();

    const keyHash = createHash('sha256').update('router-key-123').digest('hex');
    const deps: GatewayDeps = {
      keyLookup: createSha256KeyLookup([{ keyHash, userId: 'user-1', apiKeyId: 'key-1' }]),
      providerSource: async () => ({
        adapter: createOpenAICompatibleAdapter({ id: 'mock', baseUrl: 'https://mock.example.test/v1' }),
        credential: 'sk-mock',
        baseUrl: 'https://mock.example.test/v1',
        timeoutMs: 10_000,
        contextWindow: 8000,
      }),
      chainResolver: async () => [{ provider: 'mock', model: 'mock-model' }],
      recordUsage: (rec) => {
        usage.push(rec);
      },
      idempotency: new IdempotencyStore(),
      modelsList: async () => [{ id: 'mock-model', object: 'model', owned_by: 'mock' }],
    };
    app = Fastify();
    await app.register(
      async (instance: FastifyInstance) => {
        registerGatewayRoutes(instance, deps);
      },
      { prefix: '/v1' },
    );
    await app.ready();
  });

  afterEach(async () => {
    fetchMock.restore();
    await app.close();
  });

  it('noisy-output request records tokens in vs out and tokensSaved > 0', async () => {
    const req = noisyRequest();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer router-key-123', 'content-type': 'application/json' },
      payload: { model: 'mock-model', messages: req.messages },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { usage: { prompt_tokens: number; completion_tokens: number; tokens_saved?: number } };
    expect(body.usage.prompt_tokens).toBeGreaterThan(0);
    expect(body.usage.completion_tokens).toBeGreaterThan(0);
    // The provider saw the OPTIMISED prompt: the raw noisy prompt would have
    // been ~5k+ tokens; the optimised prompt is far smaller.
    expect(body.usage.tokens_saved).toBeGreaterThan(0);
    // The request actually sent upstream carried the trimmed tool output.
    const sent = JSON.parse(fetchMock.callsTo('https://mock.example.test/v1/chat/completions')[0].body ?? '{}') as {
      messages: Array<{ content: string }>;
    };
    const sentChars = sent.messages.reduce((n, m) => n + m.content.length, 0);
    const rawChars = req.messages.reduce((n, m) => n + m.content.length, 0);
    expect(sentChars).toBeLessThan(rawChars / 2);
    // Usage recorded exactly once, with tokensSaved.
    expect(usage).toHaveLength(1);
    expect(usage[0].status).toBe('SUCCESS');
    expect(usage[0].tokensSaved).toBeGreaterThan(0);
    expect(usage[0].inputTokens).toBe(body.usage.prompt_tokens);
    expect(usage[0].outputTokens).toBe(body.usage.completion_tokens);
  });

  it('rtk:false passes the request through unoptimised (tokensSaved 0)', async () => {
    const req = noisyRequest();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer router-key-123', 'content-type': 'application/json' },
      payload: { model: 'mock-model', messages: req.messages, rtk: false },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { usage: { tokens_saved?: number } };
    expect(body.usage.tokens_saved ?? 0).toBe(0);
    expect(usage).toHaveLength(1);
    expect(usage[0].tokensSaved ?? 0).toBe(0);
  });
});
