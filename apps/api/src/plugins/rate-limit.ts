// plugins/rate-limit.ts — in-memory fixed-window rate limiter.
// Redis is OPTIONAL (CONTRACT refinement 4): when REDIS_URL is set, a
// future Agent 3 worker may move this to Redis; the API itself must start
// and rate-limit correctly with no Redis at all, so the default store is
// in-process memory. Limits are per IP, and per API key on /v1 (Agent 2).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { tooManyRequests } from '../lib/errors.js';

export interface RateLimitOptions {
  /** Max requests per window per key (default 300). */
  max?: number;
  /** Window in ms (default 60_000). */
  windowMs?: number;
  /** Skip rate limiting for these path prefixes (e.g. /health). */
  skipPrefixes?: string[];
}

interface Bucket {
  count: number;
  resetAt: number;
}

export async function rateLimitPlugin(fastify: FastifyInstance, opts: RateLimitOptions = {}): Promise<void> {
  const max = opts.max ?? 300;
  const windowMs = opts.windowMs ?? 60_000;
  const skipPrefixes = opts.skipPrefixes ?? ['/health'];
  const buckets = new Map<string, Bucket>();

  fastify.addHook('onRequest', async (request: FastifyRequest) => {
    const url = request.url;
    if (skipPrefixes.some((p) => url === p || url.startsWith(p))) return;
    const key = `${request.ip}:${request.method}:${new URL(url, 'http://x').pathname}`;
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return;
    }
    bucket.count += 1;
    if (bucket.count > max) {
      throw tooManyRequests(`Rate limit exceeded (${max} requests per ${windowMs / 1000}s)`);
    }
    // Opportunistic cleanup so the map does not grow unboundedly.
    if (buckets.size > 10_000) {
      for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
    }
  });
}

export default fp(rateLimitPlugin, { name: 'rate-limit-plugin' });
