// Billing HTTP routes: wallet, transactions, admin adjust, budgets.
// Admin adjust is gated by `isAdmin`; all other routes are user-scoped.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BillingService, BudgetExceededError, InsufficientBalanceError, type BillingStore } from './service.js';

export interface BillingRoutesOptions {
  store: BillingStore;
  isAdmin?: (req: FastifyRequest) => boolean;
  getUserId?: (req: FastifyRequest) => string | null;
}

export async function billingRoutes(app: FastifyInstance, opts: BillingRoutesOptions): Promise<void> {
  const service = new BillingService(opts.store);
  const getUserId = opts.getUserId ?? ((req) => (req.headers['x-user-id'] as string | undefined) ?? null);
  const isAdmin = opts.isAdmin ?? (() => false);

  const requireUser = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const userId = getUserId(req);
    if (!userId) { void reply.code(401).send({ error: 'unauthenticated' }); return null; }
    return userId;
  };

  app.get('/api/v1/credits/wallet', async (req, reply) => {
    const userId = requireUser(req, reply); if (!userId) return;
    return reply.send(await service.getWallet(userId));
  });

  app.get('/api/v1/credits/transactions', async (req, reply) => {
    const userId = requireUser(req, reply); if (!userId) return;
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'validation failed' });
    return reply.send(await service.listTransactions(userId, q.data.limit, q.data.offset));
  });

  // Admin-only credit adjust.
  app.post('/api/v1/credits/adjust', async (req, reply) => {
    const userId = requireUser(req, reply); if (!userId) return;
    if (!isAdmin(req)) return reply.code(403).send({ error: 'admin only' });
    const parsed = z.object({
      targetUserId: z.string().min(1),
      amount: z.number().refine((n) => n !== 0, 'amount must be non-zero'),
      idempotencyKey: z.string().min(1),
      description: z.string().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation failed', details: parsed.error.flatten() });
    const tx = await service.adjust(parsed.data.targetUserId, parsed.data.amount, parsed.data.idempotencyKey, parsed.data.description);
    return reply.code(201).send(tx);
  });

  // ---- Budgets ----
  app.get('/api/v1/budgets', async (req, reply) => {
    const userId = requireUser(req, reply); if (!userId) return;
    return reply.send(await service.listBudgets(userId));
  });

  app.post('/api/v1/budgets', async (req, reply) => {
    const userId = requireUser(req, reply); if (!userId) return;
    const parsed = z.object({
      scope: z.enum(['DAILY', 'MONTHLY', 'PER_MODEL', 'PER_PROVIDER', 'PER_KEY']),
      scopeKey: z.string().nullable().optional(),
      limitCredits: z.number().positive(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation failed', details: parsed.error.flatten() });
    const b = await service.setBudget(userId, parsed.data);
    return reply.code(201).send(b);
  });

  app.delete('/api/v1/budgets/:id', async (req, reply) => {
    const userId = requireUser(req, reply); if (!userId) return;
    const ok = await service.deleteBudget((req.params as { id: string }).id, userId);
    if (!ok) return reply.code(404).send({ error: 'budget not found' });
    return reply.code(204).send();
  });

  // Pre-request check helper endpoint (gateway calls checkBudgets directly).
  app.post('/api/v1/budgets/check', async (req, reply) => {
    const userId = requireUser(req, reply); if (!userId) return;
    const parsed = z.object({
      amount: z.number().positive(),
      model: z.string().optional(),
      provider: z.string().optional(),
      apiKeyId: z.string().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation failed', details: parsed.error.flatten() });
    try {
      await service.checkBudgets(userId, parsed.data.amount, parsed.data);
      return reply.send({ ok: true });
    } catch (err) {
      if (err instanceof BudgetExceededError) return reply.code(402).send({ error: err.message });
      throw err;
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof InsufficientBalanceError) return reply.code(402).send({ error: err.message, balance: err.balance, needed: err.needed });
    if (err instanceof BudgetExceededError) return reply.code(402).send({ error: err.message });
    return reply.code(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });
}
