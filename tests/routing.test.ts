// Routing tests — Vitest + Fastify inject + mocks, NO live DB/Redis.
import { describe, it, expect, beforeEach } from 'vitest';
import { classifyRequest } from '../apps/api/src/modules/routing/classifier.js';
import { executeWithFallback, moveChainEntry, reorderChain, sortChain, toAttemptError } from '../apps/api/src/modules/routing/chain.js';
import { ProviderHealthTracker } from '../apps/api/src/modules/routing/health.js';
import { RoutingService } from '../apps/api/src/modules/routing/service.js';
import { InMemoryRoutingStore } from '../apps/api/src/modules/routing/store.js';
import type { ChainEntry } from '../apps/api/src/modules/routing/types.js';
import { buildApp, asUser, userA, userB } from './helpers.js';

const luna: ChainEntry = { provider: 'tokens', model: 'gpt-6-luna', order: 0 };
const flash: ChainEntry = { provider: 'deepseek', model: 'deepseek-flash', order: 1 };
const kimi: ChainEntry = { provider: 'moonshot', model: 'kimi-k2.7-code', order: 2 };

function err429(retryAfter?: number) {
  const e = new Error('rate limited') as Error & { status: number; response: { status: number; headers: Record<string, string> } };
  e.status = 429;
  e.response = { status: 429, headers: retryAfter !== undefined ? { 'retry-after': String(retryAfter) } : {} };
  return e;
}
function err500() { const e = new Error('boom') as Error & { status: number }; e.status = 500; return e; }
function err401() { const e = new Error('bad key') as Error & { status: number }; e.status = 401; return e; }

describe('classifier (rules-based, no LLM call)', () => {
  it('classifies debugging keywords', async () => {
    const c = await classifyRequest({ userId: userA, messages: [{ role: 'user', content: 'Help me debug this stack trace error' }] });
    expect(c.category).toBe('COMPLEX_DEBUGGING');
  });
  it('classifies tools presence as TOOL_CALLING', async () => {
    const c = await classifyRequest({ userId: userA, messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function' }] });
    expect(c.category).toBe('TOOL_CALLING');
  });
  it('classifies long input as LONG_CONTEXT', async () => {
    const c = await classifyRequest({ userId: userA, messages: [{ role: 'user', content: 'x'.repeat(9000) }] });
    expect(c.category).toBe('LONG_CONTEXT');
  });
  it('classifies a short question as SIMPLE_QUESTION', async () => {
    const c = await classifyRequest({ userId: userA, messages: [{ role: 'user', content: 'What is the capital of France?' }] });
    expect(c.category).toBe('SIMPLE_QUESTION');
  });
  it('defaults to GENERAL', async () => {
    const c = await classifyRequest({ userId: userA, messages: [{ role: 'user', content: 'Tell me something interesting about the sea' }] });
    expect(c.category).toBe('GENERAL');
  });
  it('explicit taskCategory wins', async () => {
    const c = await classifyRequest({ userId: userA, taskCategory: 'ARCHITECTURE', messages: [{ role: 'user', content: 'hi' }] });
    expect(c.category).toBe('ARCHITECTURE');
    expect(c.matchedRule).toBe('explicit-taskCategory');
  });
});

describe('fallback engine', () => {
  it('(a) mock 429 on primary → fallback served, chain order respected', async () => {
    const chain = [luna, flash, kimi];
    const attempted: string[] = [];
    const out = await executeWithFallback(chain, async (entry) => {
      attempted.push(entry.model);
      if (entry.model === 'gpt-6-luna') throw err429();
      return `served-by-${entry.model}`;
    });
    expect(out.served.model).toBe('deepseek-flash');
    expect(out.attempted.map((e) => e.model)).toEqual(['gpt-6-luna', 'deepseek-flash']);
    expect(attempted).toEqual(['gpt-6-luna', 'deepseek-flash']);
    expect(out.attempts).toBe(2);
  });

  it('(a) 429 then 500 then success reaches third entry', async () => {
    const out = await executeWithFallback([luna, flash, kimi], async (entry) => {
      if (entry.model === 'gpt-6-luna') throw err429();
      if (entry.model === 'deepseek-flash') throw err500();
      return 'kimi-ok';
    });
    expect(out.served.model).toBe('kimi-k2.7-code');
    expect(out.attempts).toBe(3);
  });

  it('respects Retry-After (sleep called with header value, capped)', async () => {
    const sleeps: number[] = [];
    await executeWithFallback([luna, flash], async (entry) => {
      if (entry.model === 'gpt-6-luna') throw err429(2);
      return 'ok';
    }, { sleep: async (ms) => { sleeps.push(ms); } });
    expect(sleeps).toEqual([2000]);
  });

  it('never retries 401 (auth) errors', async () => {
    const attempted: string[] = [];
    await expect(executeWithFallback([luna, flash], async (entry) => {
      attempted.push(entry.model);
      throw err401();
    })).rejects.toMatchObject({ kind: '401' });
    expect(attempted).toEqual(['gpt-6-luna']);
  });

  it('never switches after streaming started', async () => {
    let streamed = false;
    await expect(executeWithFallback([luna, flash], async (entry) => {
      if (entry.model === 'gpt-6-luna') { streamed = true; throw err500(); }
      return 'should-not-reach';
    }, { streamingStarted: () => streamed })).rejects.toMatchObject({ kind: '5XX' });
  });

  it('toAttemptError maps timeout text', () => {
    expect(toAttemptError(new Error('request timed out')).kind).toBe('TIMEOUT');
    expect(toAttemptError(err429()).kind).toBe('429');
  });
});

describe('chain helpers', () => {
  it('sortChain drops disabled entries and sorts by order', () => {
    expect(sortChain([kimi, { ...luna, enabled: false }, flash]).map((e) => e.model))
      .toEqual(['deepseek-flash', 'kimi-k2.7-code']);
  });
  it('moveChainEntry moves down by one and re-indexes', () => {
    const moved = moveChainEntry([luna, flash, kimi], 0, 'down');
    expect(moved.map((e) => e.model)).toEqual(['deepseek-flash', 'gpt-6-luna', 'kimi-k2.7-code']);
    expect(moved.map((e) => e.order)).toEqual([0, 1, 2]);
  });
  it('reorderChain applies an explicit order', () => {
    const re = reorderChain([luna, flash, kimi], ['moonshot/kimi-k2.7-code', 'tokens/gpt-6-luna']);
    expect(re.map((e) => e.model)).toEqual(['kimi-k2.7-code', 'gpt-6-luna', 'deepseek-flash']);
  });
});

describe('provider health / circuit breaker', () => {
  it('trips DOWN after threshold failures and recovers after cooldown', () => {
    let now = 0;
    const tracker = new ProviderHealthTracker({ failureThreshold: 3, cooldownMs: 1000, now: () => now });
    expect(tracker.isAvailable('tokens')).toBe(true);
    tracker.recordFailure('tokens');
    tracker.recordFailure('tokens');
    expect(tracker.status('tokens')).toBe('DEGRADED'); // 2/2 failed, not yet tripped
    tracker.recordFailure('tokens');
    expect(tracker.status('tokens')).toBe('DOWN');
    expect(tracker.isAvailable('tokens')).toBe(false);
    now = 1001;
    expect(tracker.isAvailable('tokens')).toBe(true); // cooldown expired → half-open
    tracker.recordSuccess('tokens', 120);
    tracker.recordSuccess('tokens', 110);
    tracker.recordSuccess('tokens', 100);
    tracker.recordSuccess('tokens', 90); // 3 failures / 7 outcomes ≈ 0.43 < 0.5
    expect(tracker.status('tokens')).toBe('UP');
  });
  it('DEGRADED at high error rate without tripping', () => {
    const tracker = new ProviderHealthTracker({ failureThreshold: 10, degradedErrorRate: 0.5, windowSize: 4 });
    tracker.recordFailure('gemini');
    tracker.recordFailure('gemini');
    tracker.recordSuccess('gemini', 50);
    tracker.recordSuccess('gemini', 50);
    expect(tracker.errorRate('gemini')).toBe(0.5);
    expect(tracker.status('gemini')).toBe('DEGRADED');
  });
});

describe('RoutingService decisions', () => {
  let store: InMemoryRoutingStore;
  let service: RoutingService;
  beforeEach(() => {
    store = new InMemoryRoutingStore();
    service = new RoutingService({ store });
  });

  it('(b) per-agent chain reorder changes serving order', async () => {
    const profile = await service.createProfile(userA, {
      name: 'default', mode: 'HYBRID', taskMapping: {}, isDefault: true,
      agentMapping: { coordinator: [luna, flash, kimi] },
    });
    // Resolve with coordinator role → Luna first.
    let d = await service.resolve({ userId: userA, agentRole: 'coordinator', messages: [{ role: 'user', content: 'hello' }] });
    expect(d.chain.map((e) => e.model)).toEqual(['gpt-6-luna', 'deepseek-flash', 'kimi-k2.7-code']);
    // Reorder: set the coordinator chain with Flash first.
    await service.setAgentChain(profile.id, userA, 'coordinator', [flash, luna, kimi]);
    d = await service.resolve({ userId: userA, agentRole: 'coordinator', messages: [{ role: 'user', content: 'hello' }] });
    expect(d.chain[0].model).toBe('deepseek-flash');
    expect(d.chain.map((e) => e.model)).toEqual(['deepseek-flash', 'gpt-6-luna', 'kimi-k2.7-code']);
  });

  it('AUTOMATIC classifies and uses the task chain; unknown model falls back to default mapping', async () => {
    await service.createProfile(userA, {
      name: 'auto', mode: 'AUTOMATIC', isDefault: true,
      taskMapping: { CODE_GENERATION: [kimi, flash] },
    });
    const d = await service.resolve({ userId: userA, messages: [{ role: 'user', content: 'Write a function to sort a list in Python' }] });
    expect(d.taskCategory).toBe('CODE_GENERATION');
    expect(d.chain[0].model).toBe('kimi-k2.7-code');
    const d2 = await service.resolve({ userId: userA, messages: [{ role: 'user', content: 'Tell me about the sea' }] });
    expect(d2.taskCategory).toBe('GENERAL');
    expect(d2.chain[0].model).toBe('gpt-6-luna');
  });

  it('MANUAL bypasses classification but still runs the access/budget gate', async () => {
    let gateCalled = false;
    const gated = new RoutingService({ store, checkAccess: () => { gateCalled = true; } });
    await gated.createProfile(userA, { name: 'manual', mode: 'MANUAL', defaultProviderId: 'deepseek', defaultModelId: 'deepseek-flash', taskMapping: {}, isDefault: true });
    const d = await gated.resolve({ userId: userA, messages: [{ role: 'user', content: 'debug this stack trace please' }] });
    expect(d.mode).toBe('MANUAL');
    expect(d.chain).toEqual([{ provider: 'deepseek', model: 'deepseek-flash', order: 0 }]);
    expect(gateCalled).toBe(true);
  });

  it('HYBRID applies preferred provider first and exclusions', async () => {
    await service.createProfile(userA, {
      name: 'hybrid', mode: 'HYBRID', isDefault: true, preferredProviderId: 'moonshot',
      excludedModelIds: ['deepseek-flash'],
      taskMapping: { GENERAL: [luna, flash, kimi] },
    });
    const d = await service.resolve({ userId: userA, messages: [{ role: 'user', content: 'hello there' }] });
    expect(d.chain[0].provider).toBe('moonshot');
    expect(d.chain.map((e) => e.model)).not.toContain('deepseek-flash');
  });

  it('unhealthy provider is skipped in the chain', async () => {
    const tracker = new ProviderHealthTracker({ failureThreshold: 1, cooldownMs: 60_000 });
    tracker.recordFailure('tokens');
    const s2 = new RoutingService({ store, health: tracker });
    await s2.createProfile(userA, { name: 'h', mode: 'AUTOMATIC', isDefault: true, taskMapping: { GENERAL: [luna, flash] } });
    const d = await s2.resolve({ userId: userA, messages: [{ role: 'user', content: 'hello' }] });
    expect(d.chain[0].model).toBe('deepseek-flash');
  });
});

describe('routing HTTP routes', () => {
  it('profile CRUD + chain add/move/remove + resolve, scoped per user', async () => {
    const { app } = buildApp();
    const created = await app.inject({ method: 'POST', url: '/api/v1/routing-profiles', headers: asUser(userA), payload: { name: 'main', mode: 'HYBRID', isDefault: true } });
    expect(created.statusCode).toBe(201);
    const profile = JSON.parse(created.body);
    // User B cannot see user A's profile.
    expect((await app.inject({ method: 'GET', url: `/api/v1/routing-profiles/${profile.id}`, headers: asUser(userB) })).statusCode).toBe(404);
    // Add chain entries to GENERAL.
    for (const e of [luna, flash, kimi]) {
      const r = await app.inject({ method: 'POST', url: `/api/v1/routing-profiles/${profile.id}/chains/GENERAL/entries`, headers: asUser(userA), payload: { provider: e.provider, model: e.model, order: e.order } });
      expect(r.statusCode).toBe(201);
    }
    // Move first entry down → flash becomes first.
    const moved = await app.inject({ method: 'POST', url: `/api/v1/routing-profiles/${profile.id}/chains/GENERAL/move`, headers: asUser(userA), payload: { index: 0, direction: 'down' } });
    expect(JSON.parse(moved.body).taskMapping.GENERAL[0].model).toBe('deepseek-flash');
    // Resolve uses the reordered chain.
    const resolved = await app.inject({ method: 'POST', url: '/api/v1/routing-profiles/resolve', headers: asUser(userA), payload: { messages: [{ role: 'user', content: 'hello' }] } });
    expect(JSON.parse(resolved.body).chain[0].model).toBe('deepseek-flash');
    // Remove one entry.
    const removed = await app.inject({ method: 'DELETE', url: `/api/v1/routing-profiles/${profile.id}/chains/GENERAL/entries/2`, headers: asUser(userA) });
    expect(JSON.parse(removed.body).taskMapping.GENERAL).toHaveLength(2);
    // Fallback rule CRUD.
    const fb = await app.inject({ method: 'POST', url: '/api/v1/fallback-rules', headers: asUser(userA), payload: { fromModelId: 'gpt-6-luna', toModelId: 'deepseek-flash', trigger: '429', order: 0 } });
    expect(fb.statusCode).toBe(201);
    const list = await app.inject({ method: 'GET', url: '/api/v1/fallback-rules', headers: asUser(userA) });
    expect(JSON.parse(list.body)).toHaveLength(1);
    // Unauthenticated → 401.
    expect((await app.inject({ method: 'GET', url: '/api/v1/routing-profiles' })).statusCode).toBe(401);
    // Agent chain set.
    const agent = await app.inject({ method: 'PUT', url: `/api/v1/routing-profiles/${profile.id}/agents/coordinator/chain`, headers: asUser(userA), payload: { chain: [kimi, luna] } });
    expect(agent.statusCode).toBe(200);
    expect(JSON.parse(agent.body).agentMapping.coordinator[0].model).toBe('kimi-k2.7-code');
  });
});
