// Gateway types + pluggable dependencies (Builder 2 owns).
// The gateway never touches a database directly: the API key lookup, the
// provider/credential resolution and the usage recording are all injected,
// so the gateway works in tests with in-memory fakes and in production
// with Builder 1's Prisma stores + Builder 3's routing/billing.

import { createHash } from 'node:crypto';
import type { ModelChainEntry, NormalizedChatRequest } from '@jhinuk-ai-router/shared';
import type { ProviderAdapter } from '@jhinuk-ai-router/provider-sdk';
import type { IdempotencyStore } from '@jhinuk-ai-router/provider-sdk';

export interface ApiKeyIdentity {
  userId: string;
  apiKeyId: string;
}

/** Look up a plain-text router API key. Returns null when unknown/revoked. */
export type KeyLookup = (plainKey: string) => Promise<ApiKeyIdentity | null>;

/**
 * SHA-256 key lookup (ApiKey.keyHash in CONTRACT.md). Give it the stored
 * hashes; it hashes the presented key and compares. No live DB needed.
 */
export function createSha256KeyLookup(
  entries: Map<string, ApiKeyIdentity> | Iterable<{ keyHash: string; userId: string; apiKeyId: string }>,
): KeyLookup {
  const map = new Map<string, ApiKeyIdentity>();
  if (entries instanceof Map) {
    for (const [k, v] of entries) map.set(k, v);
  } else {
    for (const e of entries) map.set(e.keyHash, { userId: e.userId, apiKeyId: e.apiKeyId });
  }
  return async (plainKey: string) => {
    const hash = createHash('sha256').update(plainKey).digest('hex');
    return map.get(hash) ?? null;
  };
}

/** One resolved provider ready to serve a chain entry. */
export interface ResolvedProvider {
  adapter: ProviderAdapter;
  credential: string;
  baseUrl: string;
  timeoutMs: number;
  /** Model context window (0 = unknown); used for RTK budget checks. */
  contextWindow?: number;
}

/** Resolve a (provider, model) chain entry to an adapter + credential. */
export type ProviderSource = (
  entry: ModelChainEntry,
  auth: ApiKeyIdentity,
) => Promise<ResolvedProvider | null>;

/** Resolve a request to an ordered fallback chain (Builder 3 plugs task routing here). */
export type ChainResolver = (
  req: NormalizedChatRequest,
  auth: ApiKeyIdentity,
) => Promise<ModelChainEntry[] | null>;

export interface UsageRecordInput {
  userId: string;
  apiKeyId?: string;
  requestId: string;
  provider: string;
  model: string;
  attemptedChain: ModelChainEntry[];
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  tokensSaved?: number;
  latencyMs: number;
  status: 'SUCCESS' | 'FAILED';
  taskCategory?: string;
  error?: string;
}

export type RecordUsage = (rec: UsageRecordInput) => Promise<void> | void;

export interface GatewayModelListItem {
  id: string;
  object: 'model';
  owned_by: string;
  created?: number;
}

export interface GatewayDeps {
  keyLookup: KeyLookup;
  providerSource: ProviderSource;
  /** Defaults to a model-id resolver (see storeResolver). Builder 3 overrides for task routing. */
  chainResolver?: ChainResolver;
  recordUsage?: RecordUsage;
  idempotency?: IdempotencyStore;
  modelsList?: () => Promise<GatewayModelListItem[]>;
  /** SSE keep-alive comment interval (ms). Default 15_000. */
  keepAliveMs?: number;
  /** Cap on honoured Retry-After delays (ms). Default 5_000. */
  maxRetryAfterMs?: number;
  /** Per-key rate limit; false disables. Default 120 req / 60s per key. */
  rateLimit?: false | { requests: number; windowMs: number };
}
