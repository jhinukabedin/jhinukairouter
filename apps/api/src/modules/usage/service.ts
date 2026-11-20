// Usage records — NEVER store raw prompts or provider keys.
// Cost is computed from provider-reported token counts (or labelled
// estimates when the provider reports none); client-supplied token counts
// are never trusted for billing.
export interface UsageRecordInput {
  userId: string;
  apiKeyId?: string | null;
  requestId: string;
  provider: string;
  model: string;
  routingMode: string;
  taskCategory?: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  /** Tokens saved by RTK-style optimisation (prompt/context compression). */
  tokensSaved?: number;
  /** Estimated provider cost (currency units); provider-reported or estimate. */
  estimatedCost: number;
  /** Platform credit actually charged (0 for BYOK). */
  platformCharge?: number;
  /** True when estimatedCost came from an estimate, not provider counts. */
  costIsEstimate?: boolean;
  latencyMs: number;
  status: 'SUCCESS' | 'FAILED';
  /** Models attempted in order, e.g. ["tokens/gpt-6-luna","deepseek/deepseek-flash"]. */
  attemptedChain?: string[];
}

export interface UsageRecord extends Required<Omit<UsageRecordInput, 'apiKeyId' | 'taskCategory' | 'attemptedChain'>> {
  apiKeyId: string | null;
  taskCategory: string | null;
  attemptedChain: string[];
  createdAt: string;
}

export interface UsageFilters {
  userId?: string;
  from?: string; // ISO date
  to?: string;   // ISO date
  provider?: string;
  model?: string;
  apiKeyId?: string;
  status?: 'SUCCESS' | 'FAILED';
  limit?: number;
  offset?: number;
}

export interface UsageSummary {
  totalRequests: number;
  routedRequests: number;
  successRequests: number;
  failedRequests: number;
  errorRate: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  tokensSaved: number;
  totalTokens: number;
  estimatedProviderCost: number;
  platformCreditUsed: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  byModel: Record<string, { requests: number; inputTokens: number; outputTokens: number; estimatedCost: number }>;
  byProvider: Record<string, { requests: number; inputTokens: number; outputTokens: number; estimatedCost: number }>;
  byApiKey: Record<string, { requests: number; inputTokens: number; outputTokens: number; estimatedCost: number }>;
  byUser: Record<string, { requests: number; inputTokens: number; outputTokens: number; estimatedCost: number }>;
  daily: { date: string; requests: number; inputTokens: number; outputTokens: number; estimatedCost: number }[];
  monthly: { month: string; requests: number; inputTokens: number; outputTokens: number; estimatedCost: number }[];
}

export interface UsageStore {
  create(record: UsageRecord): Promise<UsageRecord>;
  list(filters: UsageFilters): Promise<{ rows: UsageRecord[]; total: number }>;
  listAll(filters: UsageFilters): Promise<UsageRecord[]>;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

export class UsageService {
  constructor(private store: UsageStore) {}

  async record(input: UsageRecordInput): Promise<UsageRecord> {
    const record: UsageRecord = {
      ...input,
      apiKeyId: input.apiKeyId ?? null,
      taskCategory: input.taskCategory ?? null,
      cachedTokens: input.cachedTokens ?? 0,
      tokensSaved: input.tokensSaved ?? 0,
      platformCharge: input.platformCharge ?? 0,
      costIsEstimate: input.costIsEstimate ?? false,
      attemptedChain: input.attemptedChain ?? [],
      createdAt: new Date().toISOString(),
    };
    return this.store.create(record);
  }

  /** List with user isolation: non-admin callers MUST pass their own userId;
   *  the service never returns rows for another user. */
  list(filters: UsageFilters) { return this.store.list(filters); }

  async summary(filters: UsageFilters): Promise<UsageSummary> {
    const rows = await this.store.listAll({ ...filters, limit: undefined, offset: undefined });
    const latencies = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
    const summary: UsageSummary = {
      totalRequests: rows.length,
      routedRequests: rows.filter((r) => r.attemptedChain.length > 1 || r.routingMode !== 'MANUAL').length,
      successRequests: rows.filter((r) => r.status === 'SUCCESS').length,
      failedRequests: rows.filter((r) => r.status === 'FAILED').length,
      errorRate: rows.length ? rows.filter((r) => r.status === 'FAILED').length / rows.length : 0,
      inputTokens: 0, outputTokens: 0, cachedTokens: 0, tokensSaved: 0, totalTokens: 0,
      estimatedProviderCost: 0, platformCreditUsed: 0,
      avgLatencyMs: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
      p95LatencyMs: percentile(latencies, 95),
      byModel: {}, byProvider: {}, byApiKey: {}, byUser: {}, daily: [], monthly: [],
    };
    const dailyMap = new Map<string, UsageSummary['daily'][number]>();
    const monthlyMap = new Map<string, UsageSummary['monthly'][number]>();
    const bump = (bucket: Record<string, { requests: number; inputTokens: number; outputTokens: number; estimatedCost: number }>, key: string, r: UsageRecord) => {
      bucket[key] ??= { requests: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0 };
      bucket[key].requests += 1;
      bucket[key].inputTokens += r.inputTokens;
      bucket[key].outputTokens += r.outputTokens;
      bucket[key].estimatedCost += r.estimatedCost;
    };
    for (const r of rows) {
      summary.inputTokens += r.inputTokens;
      summary.outputTokens += r.outputTokens;
      summary.cachedTokens += r.cachedTokens;
      summary.tokensSaved += r.tokensSaved;
      summary.estimatedProviderCost += r.estimatedCost;
      summary.platformCreditUsed += r.platformCharge;
      bump(summary.byModel, `${r.provider}/${r.model}`, r);
      bump(summary.byProvider, r.provider, r);
      bump(summary.byApiKey, r.apiKeyId ?? 'none', r);
      bump(summary.byUser, r.userId, r);
      const day = r.createdAt.slice(0, 10);
      dailyMap.set(day, dailyMap.get(day) ?? { date: day, requests: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0 });
      const d = dailyMap.get(day)!;
      d.requests += 1; d.inputTokens += r.inputTokens; d.outputTokens += r.outputTokens; d.estimatedCost += r.estimatedCost;
      const month = r.createdAt.slice(0, 7);
      monthlyMap.set(month, monthlyMap.get(month) ?? { month, requests: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0 });
      const m = monthlyMap.get(month)!;
      m.requests += 1; m.inputTokens += r.inputTokens; m.outputTokens += r.outputTokens; m.estimatedCost += r.estimatedCost;
    }
    summary.totalTokens = summary.inputTokens + summary.outputTokens;
    summary.daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));
    summary.monthly = [...monthlyMap.values()].sort((a, b) => a.month.localeCompare(b.month));
    return summary;
  }

  /** CSV export of the filtered rows (no prompts, no keys — columns are safe). */
  async exportCsv(filters: UsageFilters): Promise<string> {
    const rows = await this.store.listAll(filters);
    const header = 'createdAt,requestId,userId,apiKeyId,provider,model,routingMode,taskCategory,inputTokens,outputTokens,cachedTokens,tokensSaved,estimatedCost,platformCharge,latencyMs,status,attemptedChain';
    const lines = rows.map((r) => [
      r.createdAt, r.requestId, r.userId, r.apiKeyId ?? '', r.provider, r.model,
      r.routingMode, r.taskCategory ?? '', r.inputTokens, r.outputTokens, r.cachedTokens,
      r.tokensSaved, r.estimatedCost, r.platformCharge, r.latencyMs, r.status,
      r.attemptedChain.join('|'),
    ].join(','));
    return [header, ...lines].join('\n');
  }
}

/** Round a number to 2dp for money display. */
export const round2 = (n: number) => Math.round(n * 100) / 100;
