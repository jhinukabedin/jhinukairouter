// Fallback engine + chain helpers.
// Rules (CONTRACT.md): try chain in order on 429/5xx/timeout/unavailable,
// respect Retry-After, NEVER retry 401/malformed (400), NEVER switch after
// streaming started, NEVER double-bill (usage recorded once, by caller).
import type { ChainEntry } from './types.js';

export type RetryableKind = '429' | '5XX' | 'TIMEOUT' | 'UNAVAILABLE';
export type NonRetryableKind = '401' | '400' | 'OTHER';

export interface AttemptError extends Error {
  kind: RetryableKind | NonRetryableKind;
  /** Seconds from a Retry-After header, if present. */
  retryAfterSeconds?: number;
  status?: number;
}

export function toAttemptError(err: unknown): AttemptError {
  const e = err instanceof Error ? err : new Error(String(err));
  const anyE = e as AttemptError & { status?: number; code?: string; response?: { status?: number; headers?: Record<string, string> } };
  const status = anyE.status ?? anyE.response?.status;
  const headers = anyE.response?.headers ?? {};
  const retryAfter = headers['retry-after'] ?? headers['Retry-After'];
  const out = e as AttemptError;
  out.status = status;
  if (retryAfter !== undefined) {
    const n = Number(retryAfter);
    if (Number.isFinite(n)) out.retryAfterSeconds = n;
  }
  if (status === 429) out.kind = '429';
  else if (status === 401 || status === 403) out.kind = '401';
  else if (status !== undefined && status >= 500) out.kind = '5XX';
  else if (status !== undefined && status >= 400) out.kind = '400';
  else if (/timeout|timed out|ETIMEDOUT|ECONNRESET|unavailable|ECONNREFUSED/i.test(e.message)) out.kind = 'TIMEOUT';
  else out.kind = 'OTHER';
  return out;
}

export function isRetryable(kind: AttemptError['kind']): boolean {
  return kind === '429' || kind === '5XX' || kind === 'TIMEOUT' || kind === 'UNAVAILABLE';
}

export interface AttemptOutcome<T> {
  result: T;
  /** Chain entry that actually served the request. */
  served: ChainEntry;
  /** Every entry attempted, in order (for UsageRecord.attemptedChain). */
  attempted: ChainEntry[];
  attempts: number;
}

export interface FallbackOptions {
  /** Called before sleeping for Retry-After; tests inject a recorder. Default: real setTimeout, capped at 60s. */
  sleep?: (ms: number) => Promise<void>;
  /** Hard cap on total wait from Retry-After headers (ms). Default 60_000. */
  maxRetryAfterMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Try each chain entry in order. `attempt(entry, index)` performs one
 * provider call; it must throw AttemptError (or a convertible error) on
 * failure, and MUST NOT be retried once `streamingStarted()` is true.
 */
export async function executeWithFallback<T>(
  chain: ChainEntry[],
  attempt: (entry: ChainEntry, index: number) => Promise<T>,
  opts: FallbackOptions & { streamingStarted?: () => boolean } = {},
): Promise<AttemptOutcome<T>> {
  const sleep = opts.sleep ?? defaultSleep;
  const maxWait = opts.maxRetryAfterMs ?? 60_000;
  if (chain.length === 0) throw new Error('fallback chain is empty');
  const attempted: ChainEntry[] = [];
  let lastError: AttemptError | undefined;
  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];
    if (!entry) continue;
    attempted.push(entry);
    try {
      const result = await attempt(entry, i);
      return { result, served: entry, attempted: [...attempted], attempts: i + 1 };
    } catch (raw) {
      const err = toAttemptError(raw);
      lastError = err;
      // Never switch after streaming started — surface the original error.
      if (opts.streamingStarted?.()) throw err;
      if (!isRetryable(err.kind)) throw err;
      if (i === chain.length - 1) throw err;
      if (err.retryAfterSeconds !== undefined && err.retryAfterSeconds > 0) {
        await sleep(Math.min(err.retryAfterSeconds * 1000, maxWait));
      }
      // otherwise fall through to the next entry immediately
    }
  }
  throw lastError ?? new Error('fallback chain exhausted');
}

/** Sort a chain by `order` (stable), dropping disabled entries. */
export function sortChain(chain: ChainEntry[]): ChainEntry[] {
  return chain
    .filter((e) => e.enabled !== false)
    .map((e, i) => ({ ...e, _i: i }))
    .sort((a, b) => a.order - b.order || a._i - b._i)
    .map(({ _i, ...e }) => e);
}

/** Move an entry up/down by one step; returns a new chain with re-indexed order. */
export function moveChainEntry(chain: ChainEntry[], index: number, direction: 'up' | 'down'): ChainEntry[] {
  const sorted = sortChain(chain);
  const target = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || index >= sorted.length || target < 0 || target >= sorted.length) return sorted;
  const next = [...sorted];
  const a = next[index];
  const b = next[target];
  if (a === undefined || b === undefined) return sorted;
  next[index] = b;
  next[target] = a;
  return next.map((e, i) => ({ ...e, order: i }));
}

/** Replace the whole order from an explicit list of "provider/model" keys. */
export function reorderChain(chain: ChainEntry[], orderedKeys: string[]): ChainEntry[] {
  const key = (e: ChainEntry) => `${e.provider}/${e.model}`;
  const byKey = new Map(chain.map((e) => [key(e), e]));
  const next: ChainEntry[] = [];
  for (const k of orderedKeys) {
    const e = byKey.get(k);
    if (e) next.push(e);
  }
  for (const e of chain) if (!orderedKeys.includes(key(e))) next.push(e);
  return next.map((e, i) => ({ ...e, order: i }));
}
