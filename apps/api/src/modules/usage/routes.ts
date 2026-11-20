// Usage HTTP routes: list (paginated, date filters), summary, CSV export.
// User isolation: non-admin callers are forced to their own userId;
// admins may pass ?userId= to see all / one user.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { UsageService, type UsageFilters } from './service.js';
import type { UsageStore } from './service.js';

export interface UsageRoutesOptions {
  store: UsageStore;
  isAdmin?: (req: FastifyRequest) => boolean;
  getUserId?: (req: FastifyRequest) => string | null;
}

const querySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  apiKeyId: z.string().optional(),
  status: z.enum(['SUCCESS', 'FAILED']).optional(),
  userId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function usageRoutes(app: FastifyInstance, opts: UsageRoutesOptions): Promise<void> {
  const service = new UsageService(opts.store);
  const getUserId = opts.getUserId ?? ((req) => (req.headers['x-user-id'] as string | undefined) ?? null);
  const isAdmin = opts.isAdmin ?? (() => false);

  const filtersFor = (req: FastifyRequest, reply: FastifyReply): UsageFilters | null => {
    const userId = getUserId(req);
    if (!userId) { void reply.code(401).send({ error: 'unauthenticated' }); return null; }
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) { void reply.code(400).send({ error: 'validation failed', details: parsed.error.flatten() }); return null; }
    const q = parsed.data;
    // Admin sees all; a normal user sees only their own rows, even if they
    // pass ?userId=someone-else.
    const effectiveUserId = isAdmin(req) ? q.userId : userId;
    return {
      userId: effectiveUserId,
      from: q.from, to: q.to, provider: q.provider, model: q.model,
      apiKeyId: q.apiKeyId, status: q.status, limit: q.limit, offset: q.offset,
    };
  };

  app.get('/api/v1/usage', async (req, reply) => {
    const filters = filtersFor(req, reply);
    if (!filters) return;
    const { rows, total } = await service.list(filters);
    return reply.send({ rows, total, limit: filters.limit, offset: filters.offset });
  });

  app.get('/api/v1/usage/summary', async (req, reply) => {
    const filters = filtersFor(req, reply);
    if (!filters) return;
    return reply.send(await service.summary(filters));
  });

  app.get('/api/v1/usage/export', async (req, reply) => {
    const filters = filtersFor(req, reply);
    if (!filters) return;
    const csv = await service.exportCsv(filters);
    return reply.header('Content-Type', 'text/csv').header('Content-Disposition', 'attachment; filename="usage.csv"').send(csv);
  });
}
