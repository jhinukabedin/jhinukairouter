// api.ts response-shape helpers — the API wraps lists and single objects,
// the pages want bare arrays/objects (0.1.3 regression: Providers crashed
// on { data: [...] } because listProviders returned the wrapper as-is).
import { describe, expect, it } from 'vitest';
import { normalizePaged, unwrapData, unwrapKey } from '../api';

describe('api response shapes', () => {
  it('normalizePaged unwraps { data }, { items }, { logs } and bare arrays', () => {
    expect(normalizePaged([{ id: 1 }]).data).toEqual([{ id: 1 }]);
    expect(normalizePaged({ data: [{ id: 1 }] }).data).toEqual([{ id: 1 }]);
    expect(normalizePaged({ items: [{ id: 2 }] }).data).toEqual([{ id: 2 }]);
    expect(normalizePaged({ logs: [{ id: 3 }], total: 1 }).data).toEqual([{ id: 3 }]);
    expect(normalizePaged({ data: [] }).data).toEqual([]);
    expect(normalizePaged(null).data).toEqual([]);
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
});
