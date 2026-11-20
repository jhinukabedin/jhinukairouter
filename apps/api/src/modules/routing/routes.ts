// Routing HTTP routes: profiles, rules, fallback rules, per-task chains.
// Fastify plugin; auth is injected via options so Builder 1's auth plugin
// can supply it in production. In tests, `getUserId` reads the x-user-id
// header. Every query is scoped to the authenticated user.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RoutingService } from './service.js';
import type { RoutingStore } from './service.js';
import type { ProviderHealthTracker } from './health.js';
import { AGENT_ROLES, TASK_CATEGORIES, type ChainEntry, type TaskCategory } from './types.js';

export interface RoutingRoutesOptions {
  store: RoutingStore;
  health?: ProviderHealthTracker;
  isAdmin?: (req: FastifyRequest) => boolean;
  /** Resolve the authenticated user id. Default: x-user-id header (tests / local dev). */
  getUserId?: (req: FastifyRequest) => string | null;
}

const chainEntrySchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  order: z.number().int().min(0).default(0),
  enabled: z.boolean().optional(),
});

const profileBodySchema = z.object({
  name: z.string().min(1).max(100),
  mode: z.enum(['AUTOMATIC', 'MANUAL', 'HYBRID']).default('AUTOMATIC'),
  defaultProviderId: z.string().nullable().optional(),
  defaultModelId: z.string().nullable().optional(),
  taskMapping: z.record(z.string(), z.array(chainEntrySchema)).optional(),
  agentMapping: z.record(z.string(), z.array(chainEntrySchema)).optional(),
  preferredProviderId: z.string().nullable().optional(),
  excludedModelIds: z.array(z.string()).optional(),
  fallbackModelIds: z.array(z.string()).optional(),
  budgetDailyCredits: z.number().positive().nullable().optional(),
  isDefault: z.boolean().default(false),
});

const ruleBodySchema = z.object({
  taskCategory: z.enum(TASK_CATEGORIES as [TaskCategory, ...TaskCategory[]]),
  providerId: z.string().nullable().optional(),
  modelId: z.string().nullable().optional(),
  chain: z.array(chainEntrySchema).optional(),
  priority: z.number().int().min(0).default(0),
});

const fallbackBodySchema = z.object({
  profileId: z.string().nullable().optional(),
  fromModelId: z.string().nullable().optional(),
  toModelId: z.string().min(1),
  trigger: z.enum(['429', '5XX', 'TIMEOUT', 'UNAVAILABLE']),
  order: z.number().int().min(0).default(0),
});

export async function routingRoutes(app: FastifyInstance, opts: RoutingRoutesOptions): Promise<void> {
  const service = new RoutingService({ store: opts.store, health: opts.health });
  const getUserId = opts.getUserId ?? ((req) => (req.headers['x-user-id'] as string | undefined) ?? null);

  const requireUser = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const userId = getUserId(req);
    if (!userId) { void reply.code(401).send({ error: 'unauthenticated' }); return null; }
    return userId;
  };

  // ---- Profiles ----
  app.post('/api/v1/routing-profiles', async (req, reply) => {
    const userId = requireUser(req, reply); if (!userId) return;
    const parsed = profileBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation failed', details: parsed.error.flatten() });
    const p = await service.createProfile(userId, { ...parsed.data, taskMapping: parsed.data.taskMapping ?? {}, agentMapping: parsed.data.agentMapping ?? {}, excludedModelIds: parsed.data.excludedModelIds ?? [], fallbackModelIds: parsed.data.fallbackModelIds ?? [] });
    return reply.code(201).send(p);
  });

  app.get('/api/v1/routing-profiles', async (req, reply) => {
    const userId = requireUser(req, reply); if (!userId) return;
    return reply.send(await service.listProfiles(userId));
  });

  app.get('/api/v1/routing-profiles/:id', async (req, reply) => {
    const userId = requireUser(req, reply); if (!userId) return;
    const p = await service.getProfile((req.params as { id: string }).id, userId);
    if (!p) return reply.code(404).send({ error: 'profile not found' });
    return reply.send(p);
  });

  app.patch('/api/v1/routing-profiles/:id', async (req, reply) => {
    const userId = requireUser(req, reply); if (!userId) return;
    const parsed = profileBodySchema.partial().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation failed', details: parsed.error.flatten() });
    const p = await service.updateProfile((req.params as { id: string }).id, userId, parsed.data as never);
    if (!p) return reply.code(404).send({ error: 'profile not found' });
    return reply.send(p);
  });

  app.delete('/api/v1/routing-profiles/:id', async (req, reply) => {
    const userId = requireUser(req, reply); if (!userId) return;
    const ok = await service.deleteProfile((req.params as { id: string }).id, userId);
    if (!ok) return reply.code(404).send({ error: 'profile not found' });
    return reply.code(204).send();
  });

  // ---- Per-task chain editor (CORE: add several, reorder, remove, test) ----
  app.post('/api/v1/routing-profiles/:id/chains/:category/entries', async (req, reply) => {
    const userId = requireUser(req, reply); if (!userId) return;
    const { category } = req.params as { category: string };
    if (!TASK_CATEGORIES.includes(category as TaskCategory)) return reply.code(400).send({ error: 'unknown task category' });
    const parsed = chainEntrySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation failed', details: parsed.error.flatten() });
    const p = await service.addChainEntry((req.params as { id: string }).id, userId, category as TaskCategory, parsed.data);
    if (!p) return reply.code(404).send({ error: 'profile not found' });
    return reply.code(201).send(p);
  });

  app.delete('/api/v1/routing-profiles/:id/chains/:category/entries/:index', async (req, reply) => {
    const userId = requireUser(req, reply); if (!userId) return;
    const { category, index } = req.params as { category: string; index: string };
    const p = await service.removeChainEntry((req.params as { id: string }).id, userId, category as TaskCategory, Number(index));
    if (!p) return reply.code(404).send({ error: 'profile not found' });
    return reply.send(p);
  });

  app.post('/api/v1/routing-profiles/:id/chains/:category/move', async (req, reply) => {
    const userId = requireUser(req, reply); if (!userId) return;
    const { category } = req.params as { category: string };
    const parsed = z.object({ index: z.number().int().min(0), direction: z.enum(['up', 'down']) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation failed', details: parsed.error.flatten() });
    const p = await service.moveChainEntry((req.params as { id: string }).id, userId, category as TaskCategory, parsed.data.index, parsed.data.direction);
    if (!p) return reply.code(404).send({ error: 'profile not found' });
    return reply.send(p);
  });

  app.put('/api/v1/routing-profiles/:id/chains/:category', async (req, reply) => {
    const userId = requireUser(req, reply); if (!userId) return;
    const { category } = req.params as { category: string };
    const parsed = z.object({ chain: z.array(chainEntrySchema) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation failed', details: parsed.error.flatten() });
    const p = await service.setTaskChain((req.params as { id: string }).id, userId, category as TaskCategory, parsed.data.chain as ChainEntry[]);
    if (!p) return reply.code(404).send({ error: 'profile not found' });
    return reply.send(p);
  });

  // ---- Per-agent chains (OpenCode aliases: coordinator/fast/coder/...) ----
  app.put('/api/v1/routing-profiles/:id/agents/:role/chain', async (req, reply) => {
    const userId = requireUser(req, reply); if (!userId) return;
    const { role } = req.params as { role: string };
    if (!AGENT_ROLES.includes(role as never)) return reply.code(400).send({ error: 'unknown agent role' });
    const parsed = z.object({ chain: z.array(chainEntrySchema) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation failed', details: parsed.error.flatten() });
    const p = await service.setAgentChain((req.params as { id: string }).id, userId, role as never, parsed.data.chain as ChainEntry[]);
    if (!p) return reply.code(404).send({ error: 'profile not found' });
    return reply.send(p);
  });

  // ---- Rules ----
  app.post('/api/v1/routing-profiles/:id/rules', async (req, reply) => {
    const userId = requireUser(req, reply); if (!userId) return;
    const parsed = ruleBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation failed', details: parsed.error.flatten() });
    const profile = await service.getProfile((req.params as { id: string }).id, userId);
    if (!profile) return reply.code(404).send({ error: 'profile not found' });
    const r = await service.createRule(profile.id, parsed.data as never);
    return reply.code(201).send(r);
  });

  app.get('/api/v1/routing-profiles/:id/rules', async (req, reply) => {
    const userId = requireUser(req, reply); if (!userId) return;
    const profile = await service.getProfile((req.params as { id: string }).id, userId);
    if (!profile) return reply.code(404).send({ error: 'profile not found' });
    return reply.send(await service.listRules(profile.id));
  });

  app.delete('/api/v1/routing-profiles/:id/rules/:ruleId', async (req, reply) => {
    const userId = requireUser(req, reply); if (!userId) return;
    const { id, ruleId } = req.params as { id: string; ruleId: string };
    const profile = await service.getProfile(id, userId);
    if (!profile) return reply.code(404).send({ error: 'profile not found' });
    const ok = await service.deleteRule(ruleId, id);
    if (!ok) return reply.code(404).send({ error: 'rule not found' });
    return reply.code(204).send();
  });

  // ---- Fallback rules ----
  app.post('/api/v1/fallback-rules', async (req, reply) => {
    const userId = requireUser(req, reply); if (!userId) return;
    const parsed = fallbackBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation failed', details: parsed.error.flatten() });
    const r = await service.createFallbackRule(userId, parsed.data);
    return reply.code(201).send(r);
  });

  app.get('/api/v1/fallback-rules', async (req, reply) => {
    const userId = requireUser(req, reply); if (!userId) return;
    return reply.send(await service.listFallbackRules(userId));
  });

  app.delete('/api/v1/fallback-rules/:id', async (req, reply) => {
    const userId = requireUser(req, reply); if (!userId) return;
    const ok = await service.deleteFallbackRule((req.params as { id: string }).id, userId);
    if (!ok) return reply.code(404).send({ error: 'fallback rule not found' });
    return reply.code(204).send();
  });

  // ---- Resolve (dry-run a routing decision; gateway uses RoutingService directly) ----
  app.post('/api/v1/routing-profiles/resolve', async (req, reply) => {
    const userId = requireUser(req, reply); if (!userId) return;
    const parsed = z.object({
      messages: z.array(z.object({ role: z.string(), content: z.string() })).min(1),
      taskCategory: z.enum(TASK_CATEGORIES as [TaskCategory, ...TaskCategory[]]).optional(),
      routingProfileId: z.string().optional(),
      agentRole: z.enum(AGENT_ROLES as never).optional(),
      model: z.string().optional(),
      tools: z.array(z.unknown()).optional(),
      stream: z.boolean().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation failed', details: parsed.error.flatten() });
    try {
      const decision = await service.resolve({ ...parsed.data, userId } as never);
      return reply.send(decision);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'routing failed' });
    }
  });
}
