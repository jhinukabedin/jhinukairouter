// Provider health tracking + circuit breaker (lightweight).
// In-memory counters + optional persistence via a store shaped like the
// Prisma ProviderHealth table. NO expensive check per request: health is
// updated from real request outcomes and (worker) periodic checks only.
export type HealthStatus = 'UP' | 'DEGRADED' | 'DOWN';

export interface ProviderHealthRow {
  providerId: string;
  status: HealthStatus;
  lastLatencyMs?: number | null;
  lastErrorRate?: number | null;
  lastCheckedAt: string;
  consecutiveFailures: number;
  cooldownUntil?: string | null;
}

export interface ProviderHealthStore {
  get(providerId: string): Promise<ProviderHealthRow | null>;
  upsert(row: ProviderHealthRow): Promise<void>;
}

export interface HealthTrackerOptions {
  /** Consecutive failures before tripping the breaker. Default 5. */
  failureThreshold?: number;
  /** Cooldown after tripping (ms). Default 60_000. */
  cooldownMs?: number;
  /** Error rate above which a provider is DEGRADED. Default 0.5. */
  degradedErrorRate?: number;
  /** Rolling window size for error-rate calc. Default 20 outcomes. */
  windowSize?: number;
  store?: ProviderHealthStore;
  now?: () => number;
}

interface Stats { outcomes: boolean[]; latencies: number[]; consecutiveFailures: number; cooldownUntil: number; }

export class ProviderHealthTracker {
  private stats = new Map<string, Stats>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly degradedErrorRate: number;
  private readonly windowSize: number;
  private readonly store?: ProviderHealthStore;
  private readonly now: () => number;

  constructor(opts: HealthTrackerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 60_000;
    this.degradedErrorRate = opts.degradedErrorRate ?? 0.5;
    this.windowSize = opts.windowSize ?? 20;
    this.store = opts.store;
    this.now = opts.now ?? Date.now;
  }

  private getStats(providerId: string): Stats {
    let s = this.stats.get(providerId);
    if (!s) { s = { outcomes: [], latencies: [], consecutiveFailures: 0, cooldownUntil: 0 }; this.stats.set(providerId, s); }
    return s;
  }

  recordSuccess(providerId: string, latencyMs: number): void {
    const s = this.getStats(providerId);
    s.outcomes.push(true); s.latencies.push(latencyMs);
    s.consecutiveFailures = 0;
    if (s.outcomes.length > this.windowSize) s.outcomes.shift();
    if (s.latencies.length > this.windowSize) s.latencies.shift();
    void this.persist(providerId);
  }

  recordFailure(providerId: string, latencyMs?: number): void {
    const s = this.getStats(providerId);
    s.outcomes.push(false);
    if (latencyMs !== undefined) s.latencies.push(latencyMs);
    s.consecutiveFailures += 1;
    if (s.consecutiveFailures >= this.failureThreshold) s.cooldownUntil = this.now() + this.cooldownMs;
    if (s.outcomes.length > this.windowSize) s.outcomes.shift();
    if (s.latencies.length > this.windowSize) s.latencies.shift();
    void this.persist(providerId);
  }

  errorRate(providerId: string): number {
    const s = this.stats.get(providerId);
    if (!s || s.outcomes.length === 0) return 0;
    return s.outcomes.filter((o) => !o).length / s.outcomes.length;
  }

  avgLatency(providerId: string): number | null {
    const s = this.stats.get(providerId);
    if (!s || s.latencies.length === 0) return null;
    return s.latencies.reduce((a, b) => a + b, 0) / s.latencies.length;
  }

  status(providerId: string): HealthStatus {
    const s = this.stats.get(providerId);
    if (!s) return 'UP';
    // Cooldown expired → half-open: reset the breaker so traffic can resume.
    if (s.cooldownUntil > 0 && this.now() >= s.cooldownUntil) {
      s.consecutiveFailures = 0;
      s.cooldownUntil = 0;
    }
    if (this.now() < s.cooldownUntil) return 'DOWN';
    if (s.consecutiveFailures >= this.failureThreshold) return 'DOWN';
    return this.errorRate(providerId) >= this.degradedErrorRate ? 'DEGRADED' : 'UP';
  }

  /** Circuit-breaker gate: false while in cooldown. */
  isAvailable(providerId: string): boolean {
    return this.status(providerId) !== 'DOWN';
  }

  snapshot(providerId: string): ProviderHealthRow {
    const s = this.getStats(providerId);
    return {
      providerId,
      status: this.status(providerId),
      lastLatencyMs: s.latencies.length ? s.latencies[s.latencies.length - 1] : null,
      lastErrorRate: this.errorRate(providerId),
      lastCheckedAt: new Date(this.now()).toISOString(),
      consecutiveFailures: s.consecutiveFailures,
      cooldownUntil: s.cooldownUntil ? new Date(s.cooldownUntil).toISOString() : null,
    };
  }

  private async persist(providerId: string): Promise<void> {
    if (!this.store) return;
    try { await this.store.upsert(this.snapshot(providerId)); } catch { /* health persistence must never break requests */ }
  }
}
