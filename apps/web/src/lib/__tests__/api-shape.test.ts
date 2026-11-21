// api.ts response-shape helpers — the API wraps lists and single objects,
// the pages want bare arrays/objects (0.1.3 regression: Providers crashed
// on { data: [...] } because listProviders returned the wrapper as-is).
import { describe, expect, it } from 'vitest';
import { normalizePaged, normalizeUsageSummary, toModelIds, unwrapData, unwrapKey, withOffset } from '../api';

describe('api response shapes', () => {
  it('normalizePaged unwraps { data }, { items }, { logs } and bare arrays', () => {
    expect(normalizePaged([{ id: 1 }]).data).toEqual([{ id: 1 }]);
    expect(normalizePaged({ data: [{ id: 1 }] }).data).toEqual([{ id: 1 }]);
    expect(normalizePaged({ items: [{ id: 2 }] }).data).toEqual([{ id: 2 }]);
    expect(normalizePaged({ logs: [{ id: 3 }], total: 1 }).data).toEqual([{ id: 3 }]);
    expect(normalizePaged({ data: [] }).data).toEqual([]);
    expect(normalizePaged(null).data).toEqual([]);
  });

  it('normalizePaged unwraps { rows } (usage list + credit transactions, 0.1.4)', () => {
    // GET /api/v1/usage and /api/v1/credits/transactions answer
    // { rows, total, ... }; without this the Usage, Request Logs,
    // Overview-recent and Credits pages always showed empty.
    const usage = normalizePaged({ rows: [{ id: 'u1' }], total: 1, limit: 50, offset: 0 });
    expect(usage.data).toEqual([{ id: 'u1' }]);
    expect(usage.total).toBe(1);
    expect(normalizePaged({ rows: [] }).data).toEqual([]);
  });

  it('unwrapData returns the wrapped value and passes bare values through', () => {
    expect(unwrapData({ data: { id: 'p1' } })).toEqual({ id: 'p1' });
    expect(unwrapData({ id: 'p2' })).toEqual({ id: 'p2' });
    expect(unwrapData({ data: { ok: true, latencyMs: 42 } })).toEqual({ ok: true, latencyMs: 42 });
  });

  it('unwrapKey reads the named array and passes bare arrays through', () => {
    expect(unwrapKey([{ id: 1 }], 'apiKeys')).toEqual([{ id: 1 }]);
    expect(unwrapKey({ apiKeys: [{ id: 1 }] }, 'apiKeys')).toEqual([{ id: 1 }]);
    expect(unwrapKey({ sessions: [{ id: 's1' }] }, 'sessions')).toEqual([{ id: 's1' }]);
    expect(unwrapKey({ users: [{ id: 'u1' }] }, 'users')).toEqual([{ id: 'u1' }]);
    expect(unwrapKey({}, 'apiKeys')).toEqual([]);
    expect(unwrapKey(null, 'apiKeys')).toEqual([]);
  });

  it('normalizePaged derives the page from offset/limit when page is absent (0.1.5)', () => {
    expect(normalizePaged({ rows: [], total: 0, limit: 25, offset: 0 }).page).toBe(1);
    expect(normalizePaged({ rows: [], total: 0, limit: 25, offset: 25 }).page).toBe(2);
    expect(normalizePaged({ rows: [], total: 0, limit: 25, offset: 50 }).page).toBe(3);
    expect(normalizePaged({ rows: [], total: 0, limit: 25, offset: 25, page: 9 }).page).toBe(9);
  });

  it('withOffset translates page to offset; the APIs take limit/offset only (0.1.5)', () => {
    expect(withOffset({ page: '1', limit: '25' })).toEqual({ limit: '25', offset: '0' });
    expect(withOffset({ page: '2', limit: '25' })).toEqual({ limit: '25', offset: '25' });
    expect(withOffset({ page: '3', limit: '50', from: '2026-11-01' })).toEqual({ limit: '50', from: '2026-11-01', offset: '100' });
    expect(withOffset({ limit: '25' })).toEqual({ limit: '25' });
  });

  it('toModelIds turns sync model objects into id strings (0.1.5)', () => {
    expect(toModelIds([{ modelId: 'gpt-6-luna', displayName: 'Luna' }, { id: 'deepseek-flash' }])).toEqual(['gpt-6-luna', 'deepseek-flash']);
    expect(toModelIds(['a', 'b'])).toEqual(['a', 'b']);
    expect(toModelIds([{ displayName: 'no id' }, null])).toEqual([]);
    expect(toModelIds(undefined)).toEqual([]);
  });
});

describe('usage summary shape (0.1.5 — the blank page after login)', () => {
  // The wire shape, copied from the API service: breakdowns are RECORDS,
  // top-level costs are estimatedProviderCost / platformCreditUsed, buckets
  // and daily rows carry estimatedCost. The pages read arrays with `cost`
  // and estimatedCost / platformCharge — Overview called .map on the record
  // and the whole dashboard went blank the first time the summary loaded.
  const wire = {
    totalRequests: 2, routedRequests: 1, inputTokens: 100, outputTokens: 50,
    cachedTokens: 0, tokensSaved: 10, totalTokens: 150,
    estimatedProviderCost: 0.02, platformCreditUsed: 0.01,
    avgLatencyMs: 120, p95LatencyMs: 200, errorRate: 0,
    byModel: { 'tokens/gpt-6-luna': { requests: 2, inputTokens: 100, outputTokens: 50, estimatedCost: 0.02 } },
    byProvider: { tokens: { requests: 2, inputTokens: 100, outputTokens: 50, estimatedCost: 0.02 } },
    byApiKey: { key1: { requests: 2, inputTokens: 100, outputTokens: 50, estimatedCost: 0.02 } },
    byUser: { user1: { requests: 2, inputTokens: 100, outputTokens: 50, estimatedCost: 0.02 } },
    daily: [{ date: '2026-11-21', requests: 2, inputTokens: 100, outputTokens: 50, estimatedCost: 0.02 }],
    monthly: [{ month: '2026-11', requests: 2, inputTokens: 100, outputTokens: 50, estimatedCost: 0.02 }],
  };

  it('turns record breakdowns into arrays and maps the cost fields', () => {
    const s = normalizeUsageSummary(wire);
    expect(s.estimatedCost).toBe(0.02);
    expect(s.platformCharge).toBe(0.01);
    expect(s.byModel).toEqual([{ model: 'tokens/gpt-6-luna', requests: 2, inputTokens: 100, outputTokens: 50, cost: 0.02 }]);
    expect(s.byProvider).toEqual([{ provider: 'tokens', requests: 2, inputTokens: 100, outputTokens: 50, cost: 0.02 }]);
    expect(s.byApiKey).toEqual([{ apiKeyId: 'key1', requests: 2, inputTokens: 100, outputTokens: 50, cost: 0.02 }]);
    expect(s.byUser).toEqual([{ userId: 'user1', requests: 2, inputTokens: 100, outputTokens: 50, cost: 0.02 }]);
    expect(s.daily).toEqual([{ date: '2026-11-21', requests: 2, inputTokens: 100, outputTokens: 50, estimatedCost: 0.02, cost: 0.02 }]);
    // The Overview crash: .map must work on the normalised breakdowns.
    expect(() => s.byModel!.map((m) => m.model)).not.toThrow();
  });

  it('handles an empty summary and already-normalised arrays', () => {
    const empty = normalizeUsageSummary({ totalRequests: 0, byModel: {}, byProvider: {}, byApiKey: {}, byUser: {}, daily: [] });
    expect(empty.byModel).toEqual([]);
    expect(empty.estimatedCost).toBe(0);
    expect(empty.daily).toEqual([]);
    const already = normalizeUsageSummary({
      ...wire,
      byModel: [{ model: 'x', requests: 1, inputTokens: 1, outputTokens: 1, cost: 0.5 }],
    });
    expect(already.byModel).toEqual([{ model: 'x', requests: 1, inputTokens: 1, outputTokens: 1, cost: 0.5 }]);
    expect(normalizeUsageSummary(null).byModel).toEqual([]);
  });
});
