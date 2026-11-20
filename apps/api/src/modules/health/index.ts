// modules/health — GET /health (NO DB, NO Redis — must always answer) and
// GET /health/ready (pings the database; reports degraded when DB is down).
import type { FastifyInstance } from 'fastify';
import type { Db } from '../../lib/db.js';

export async function healthRoutes(fastify: FastifyInstance, opts: { db: Db }): Promise<void> {
  fastify.get('/health', async () => ({
    status: 'ok',
    service: 'jhinuk-ai-router',
    version: '0.1.2',
    uptimeSeconds: Math.floor(process.uptime()),
  }));

  fastify.get('/health/ready', async (request, reply) => {
    const dbOk = await opts.db.ping().catch(() => false);
    const body = {
      status: dbOk ? 'ready' : 'degraded',
      checks: { database: dbOk ? 'up' : 'down', redis: 'optional' },
    };
    if (!dbOk) {
      request.log.warn('readiness check failed: database unreachable');
      return reply.code(503).send(body);
    }
    return body;
  });
}
