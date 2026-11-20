// modules/api-keys — router API keys for the /v1 gateway.
// Key format: rk_live_<43 base64url chars>. Only the SHA-256 hash is stored;
// the full key is returned ONCE at creation/regeneration and never again.
// keyPrefix = first 12 chars of the full key (safe to display).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../lib/audit.js';
import { randomToken, sha256Hex } from '../../lib/crypto.js';
import type { ApiKeyRow, Db } from '../../lib/db.js';
import { notFound, unauthorized } from '../../lib/errors.js';
import { parseBody } from '../../lib/validate.js';

const createKeySchema = z.object({
  name: z.string().min(1).max(120),
  expiresAt: z.string().datetime().optional(),
  restrictions: z.record(z.unknown()).optional(),
});

function publicKey(key: ApiKeyRow): Record<string, unknown> {
  return {
    id: key.id,
    name: key.name,
    keyPrefix: key.keyPrefix,
    // NOTE: the last-4 hint of the raw key is only known at creation time
    // (only the SHA-256 hash is stored); keyPrefix identifies the key.
    expiresAt: key.expiresAt?.toISOString() ?? null,
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null,
    restrictions: key.restrictions ?? null,
    createdAt: key.createdAt.toISOString(),
  };
}

export function generateRouterApiKey(): string {
  return `rk_live_${randomToken(32)}`;
}

export async function apiKeysRoutes(fastify: FastifyInstance, opts: { db: Db }): Promise<void> {
  const { db } = opts;
  const prefix = '/api/v1/api-keys';

  fastify.get(prefix, { preHandler: fastify.authenticate }, async (request) => {
    if (!request.user) throw unauthorized();
    const keys = await db.apiKey.findMany({ where: { userId: request.user.id } });
    return { apiKeys: keys.filter((k) => k.revokedAt === null).map(publicKey) };
  });

  fastify.post(prefix, { preHandler: fastify.authenticate }, async (request, reply) => {
    if (!request.user) throw unauthorized();
    const body = parseBody(createKeySchema, request);
    const fullKey = generateRouterApiKey();
    const key = await db.apiKey.create({
      data: {
        userId: request.user.id,
        name: body.name,
        keyHash: sha256Hex(fullKey),
        keyPrefix: fullKey.slice(0, 12),
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        restrictions: body.restrictions ?? null,
      },
    });
    await audit(db, { userId: request.user.id, action: 'api-keys.create', resource: 'api-key', resourceId: key.id, ip: request.ip });
    // The full key is shown exactly once — the frontend must store it now.
    return reply.code(201).send({ ...publicKey(key), key: fullKey });
  });

  fastify.delete(`${prefix}/:id`, { preHandler: fastify.authenticate }, async (request) => {
    if (!request.user) throw unauthorized();
    const { id } = request.params as { id: string };
    const key = await db.apiKey.findUnique({ where: { id } });
    if (!key || key.userId !== request.user.id) throw notFound('API key not found');
    await db.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    await audit(db, { userId: request.user.id, action: 'api-keys.revoke', resource: 'api-key', resourceId: id, ip: request.ip });
    return { ok: true };
  });

  fastify.post(`${prefix}/:id/regenerate`, { preHandler: fastify.authenticate }, async (request, reply) => {
    if (!request.user) throw unauthorized();
    const { id } = request.params as { id: string };
    const old = await db.apiKey.findUnique({ where: { id } });
    if (!old || old.userId !== request.user.id) throw notFound('API key not found');
    await db.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    const fullKey = generateRouterApiKey();
    const key = await db.apiKey.create({
      data: {
        userId: request.user.id,
        name: old.name,
        keyHash: sha256Hex(fullKey),
        keyPrefix: fullKey.slice(0, 12),
        expiresAt: old.expiresAt,
        restrictions: old.restrictions ?? null,
      },
    });
    await audit(db, { userId: request.user.id, action: 'api-keys.regenerate', resource: 'api-key', resourceId: key.id, meta: { previousKeyId: id }, ip: request.ip });
    return reply.code(201).send({ ...publicKey(key), key: fullKey });
  });
}
