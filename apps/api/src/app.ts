// app.ts — build the Fastify app. One small process; Redis optional.
// buildApp() accepts an injected Db so tests can pass an in-memory fake.
import Fastify, { type FastifyInstance } from 'fastify';
import type { Env } from '@jhinuk-ai-router/config';
import { AppError } from './lib/errors.js';
import { createDb, type Db } from './lib/db.js';
import { authPlugin } from './plugins/auth.js';
import { rateLimitPlugin } from './plugins/rate-limit.js';
import { authRoutes } from './modules/auth/index.js';
import { usersRoutes } from './modules/users/index.js';
import { rolesRoutes } from './modules/roles/index.js';
import { apiKeysRoutes } from './modules/api-keys/index.js';
import { adminRoutes } from './modules/admin/index.js';
import { healthRoutes } from './modules/health/index.js';
import { staticRoutes } from './modules/static/index.js';
import { registerAllModules } from './modules/wiring.js';

export interface BuildAppOptions {
  env: Env;
  db?: Db;
  /** Disable rate limiting (tests). */
  disableRateLimit?: boolean;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const { env } = opts;
  const db = opts.db ?? (await createDb());

  const fastify = Fastify({
    logger: { level: env.LOG_LEVEL },
    trustProxy: true,
  });

  // Minimal CORS (single allowed origin from env; no extra dependency).
  fastify.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && (origin === env.CORS_ORIGIN || env.CORS_ORIGIN === '*')) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      reply.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    }
    if (request.method === 'OPTIONS') {
      return reply.code(204).send();
    }
  });

  fastify.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    if (typeof error === 'object' && error !== null && 'validation' in error) {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'Invalid request' } });
    }
    fastify.log.error(error);
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });

  if (!opts.disableRateLimit) {
    await fastify.register(rateLimitPlugin, { max: 300, windowMs: 60_000, skipPrefixes: ['/health'] });
  }
  await fastify.register(authPlugin, { db });

  await fastify.register(healthRoutes, { db });
  await fastify.register(authRoutes, { db, env });
  await fastify.register(usersRoutes, { db });
  await fastify.register(rolesRoutes, { db });
  await fastify.register(apiKeysRoutes, { db });
  await fastify.register(adminRoutes, { db });

  // Dashboard (providers/models/routing/usage/billing) + /v1 gateway.
  // Must come before the static fallback so API routes win over it.
  await registerAllModules(fastify, { db });

  // Dashboard SPA (served from ./public when present — see
  // modules/static). Registered after the API routes so /v1, /api and
  // /health always win over the SPA fallback.
  await fastify.register(staticRoutes, { publicDir: env.PUBLIC_DIR ?? 'public' });

  // 404 for unknown routes (JSON, not HTML).
  fastify.setNotFoundHandler((_request, reply) => {
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  return fastify;
}
