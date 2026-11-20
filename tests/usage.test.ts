// Usage / hiseb tests — Vitest + Fastify inject + mocked store.
// NO live DB/Redis. Verifies summary aggregation and user isolation.
import { describe, it, expect, beforeEach } from 'vitest';
import { UsageService, type UsageRecordInput } from '../apps/api/src/modules/usage/service.js';
import { InMemoryUsageStore } from '../apps/api/src/modules/usage/store.js';
import { buildApp, asUser, asAdmin, userA, userB } from './helpers.js';

function rec(over: Partial<UsageRecordInput> & { createdAt?: string }): UsageRecordInput & { createdAt?: string } {
  return {
    userId: userA, requestId: `req-${Math.random().toString(36).slice(2, 9)}`,
    provider: 'tokens', model: 'gpt-6-luna', routingMode: 'AUTOMATIC',
    inputTokens: 100, outputTokens: 50, estimatedCost: 0.01, latencyMs: 200,
    status: 'SUCCESS', ...over,
  } as UsageRecordInput & { createdAt?: string };
}

describe('UsageService — record & summary', () => {
  let store: InMemoryUsageStore;
  let svc: UsageService;
  beforeEach(() => { store = new InMemoryUsageStore(); svc = new UsageService(store); });

  it('(e) summary aggregates correctly per model / provider / key', async () => {
    await svc.record(rec({ apiKeyId: 'key-1', inputTokens: 100, outputTokens: 50, cachedTokens: 20, tokensSaved: 30, estimatedCost: 0.01, platformCharge: 0.02, latencyMs: 100 }));
    await svc.record(rec({ apiKeyId: 'key-1', inputTokens: 200, outputTokens: 100, estimatedCost: 0.02, platformCharge: 0.03, latencyMs: 200 }));
    await svc.record(rec({ provider: 'deepseek', model: 'deepseek-flash', apiKeyId: 'key-2', inputTokens: 1000, outputTokens: 500, estimatedCost: 0.05, platformCharge: 0, latencyMs: 300 }));
    await svc.record(rec({ provider: 'deepseek', model: 'deepseek-flash', apiKeyId: 'key-2', inputTokens: 10, outputTokens: 5, estimatedCost: 0.001, status: 'FAILED', latencyMs: 900 }));

    const s = await svc.summary({ userId: userA });
    expect(s.totalRequests).toBe(4);
    expect(s.routedRequests).toBe(4);
    expect(s.inputTokens).toBe(1310);
    expect(s.outputTokens).toBe(655);
    expect(s.totalTokens).toBe(1965);
    expect(s.cachedTokens).toBe(20);
    expect(s.tokensSaved).toBe(30); // RTK savings recorded
    expect(s.estimatedProviderCost).toBeCloseTo(0.081);
    expect(s.platformCreditUsed).toBeCloseTo(0.05);
    expect(s.failedRequests).toBe(1);
    expect(s.errorRate).toBe(0.25);
    expect(s.avgLatencyMs).toBe(375);
    expect(s.p95LatencyMs).toBe(900);
    expect(s.byModel['tokens/gpt-6-luna'].requests).toBe(2);
    expect(s.byModel['tokens/gpt-6-luna'].inputTokens).toBe(300);
    expect(s.byModel['deepseek/deepseek-flash'].requests).toBe(2);
    expect(s.byProvider.tokens.requests).toBe(2);
    expect(s.byProvider.deepseek.estimatedCost).toBeCloseTo(0.051);
    expect(s.byApiKey['key-1'].requests).toBe(2);
    expect(s.byApiKey['key-2'].requests).toBe(2);
    expect(s.byUser[userA].requests).toBe(4);
    expect(s.daily).toHaveLength(1);
    expect(s.daily[0].requests).toBe(4);
    expect(s.monthly).toHaveLength(1);
  });

  it('empty store summarises to zeros', async () => {
    const s = await svc.summary({ userId: userA });
    expect(s.totalRequests).toBe(0);
    expect(s.errorRate).toBe(0);
    expect(s.avgLatencyMs).toBe(0);
    expect(s.p95LatencyMs).toBe(0);
  });

  it('date filters bound the summary', async () => {
    await svc.record(rec({}));
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const s = await svc.summary({ userId: userA, from: future });
    expect(s.totalRequests).toBe(0);
  });

  it('CSV export has one line per record and no prompt/key columns', async () => {
    await svc.record(rec({ apiKeyId: 'key-1' }));
    await svc.record(rec({ provider: 'deepseek', model: 'deepseek-flash' }));
    const csv = await svc.exportCsv({ userId: userA });
    const lines = csv.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('requestId');
    expect(lines[0]).not.toMatch(/prompt|secret|providerKey/i); // no raw prompts or keys
    expect(lines[1]).toContain('tokens,gpt-6-luna'); // provider,model are separate columns
  });

  it('pagination slices the list', async () => {
    for (let i = 0; i < 5; i++) await svc.record(rec({}));
    const page1 = await svc.list({ userId: userA, limit: 2, offset: 0 });
    const page2 = await svc.list({ userId: userA, limit: 2, offset: 2 });
    expect(page1.rows).toHaveLength(2);
    expect(page1.total).toBe(5);
    expect(page2.rows).toHaveLength(2);
    expect(page2.rows[0].requestId).not.toBe(page1.rows[0].requestId);
  });
});

describe('usage HTTP routes — user isolation', () => {
  it('(e) user A cannot see user B records (list, summary, export)', async () => {
    const { app, usageStore } = buildApp();
    const svc = new UsageService(usageStore);
    await svc.record(rec({ userId: userA, apiKeyId: 'key-a', inputTokens: 100, outputTokens: 50, estimatedCost: 0.01, latencyMs: 100 }));
    await svc.record(rec({ userId: userA, apiKeyId: 'key-a', inputTokens: 100, outputTokens: 50, estimatedCost: 0.01, latencyMs: 100 }));
    await svc.record(rec({ userId: userB, apiKeyId: 'key-b', provider: 'deepseek', model: 'deepseek-flash', inputTokens: 999, outputTokens: 999, estimatedCost: 9.99, latencyMs: 100 }));

    const listA = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/usage', headers: asUser(userA) })).body);
    expect(listA.total).toBe(2);
    expect(listA.rows.every((r: { userId: string }) => r.userId === userA)).toBe(true);

    const listB = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/usage', headers: asUser(userB) })).body);
    expect(listB.total).toBe(1);

    // Even asking for the other user explicitly is ignored for non-admins.
    const spoof = JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/usage?userId=${userB}`, headers: asUser(userA) })).body);
    expect(spoof.total).toBe(2);

    const summaryA = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/usage/summary', headers: asUser(userA) })).body);
    expect(summaryA.totalRequests).toBe(2);
    expect(summaryA.inputTokens).toBe(200);
    expect(summaryA.byUser[userB]).toBeUndefined();

    const csvA = (await app.inject({ method: 'GET', url: '/api/v1/usage/export', headers: asUser(userA) })).body as string;
    expect(csvA.split('\n')).toHaveLength(3); // header + 2 rows
    expect(csvA).not.toContain('key-b');

    // Admin sees everything.
    const summaryAdmin = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/usage/summary', headers: asAdmin(userA) })).body);
    expect(summaryAdmin.totalRequests).toBe(3);
    const listAdminB = JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/usage?userId=${userB}`, headers: asAdmin(userA) })).body);
    expect(listAdminB.total).toBe(1);

    // Unauthenticated → 401.
    expect((await app.inject({ method: 'GET', url: '/api/v1/usage' })).statusCode).toBe(401);
  });
});
