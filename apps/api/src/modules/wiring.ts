// modules/wiring.ts — compose the dashboard + gateway modules into the live
// server (buildApp). This is the piece the builders left unwired: every
// module was tested in isolation, but buildApp never registered the
// providers/models/routing/usage/billing dashboard routes or the /v1
// gateway, so the deployed API answered only /health and /api/v1/auth/*.
//
// Stores are the in-memory implementations behind the modules' interfaces
// (the project's standing design; Prisma-backed stores are a later step).
// Consequence to know: providers, models, routing profiles, usage rows and
// billing data live only in this process and reset on container restart.
// Users, sessions and router API keys live in Postgres and survive restarts.
//
// Encapsulation matters here: the providers, models and gateway modules
// register global-looking onRequest hooks and relative paths, so each is
// registered inside its own encapsulated context with the right prefix —
// otherwise their auth hooks would 401 every route in the app (dashboard,
// /health included).
import { sha256Hex } from '../lib/crypto.js';
import type { Db } from '../lib/db.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { IdempotencyStore } from '@jhinuk-ai-router/provider-sdk';
import { registerGatewayRoutes } from './gateway/routes.js';
import type { GatewayDeps } from './gateway/types.js';
import {
  createStoreChainResolver,
  createStoreProviderSource,
} from './gateway/storeResolver.js';
import { registerModelRoutes } from './models/routes.js';
import {
  InMemoryModelStore,
  InMemoryProviderStore,
} from './providers/store.js';
import { registerProviderRoutes } from './providers/routes.js';
import { RoutingService } from './routing/service.js';
import { InMemoryRoutingStore } from './routing/store.js';
import { routingRoutes } from './routing/routes.js';
import { UsageService } from './usage/service.js';
import { InMemoryUsageStore } from './usage/store.js';
import { usageRoutes } from './usage/routes.js';
import { InMemoryBillingStore } from './billing/store.js';
import { billingRoutes } from './billing/routes.js';

/** Session guard in the boolean shape the models/providers modules expect. */
async function sessionGuard(
  fastify: FastifyInstance,
  req: FastifyRequest,
): Promise<boolean> {
  try {
    // The authenticate decorator is typed (request, reply); the
    // implementation only reads the request, and this guard has no reply.
    await (fastify.authenticate as (req: FastifyRequest) => Promise<void>)(req);
    return true;
  } catch {
    return false;
  }
}

export async function registerAllModules(
  fastify: FastifyInstance,
  opts: { db: Db },
): Promise<void> {
  const { db } = opts;

  // One set of stores per app instance (one process = one set in production;
  // each test app gets its own isolated set).
  const providers = new InMemoryProviderStore();
  const models = new InMemoryModelStore();
  const routingStore = new InMemoryRoutingStore();
  const usageStore = new InMemoryUsageStore();
  const billingStore = new InMemoryBillingStore();
  const usageService = new UsageService(usageStore);
  const routingService = new RoutingService({
    store: routingStore,
    isModelAvailable: async (_provider, model) => {
      const list = await models.list({});
      return list.some((m) => m.modelId === model && m.enabled);
    },
  });

  // -- Dashboard: providers + models (relative paths, own auth hook) -------
  // Encapsulated under /api/v1 so their onRequest session guard applies
  // only to these routes. Local providers (Ollama on localhost) are allowed:
  // this is a private gateway and local models are a supported use case.
  await fastify.register(
    async (instance) => {
      const authenticate = (req: FastifyRequest) => sessionGuard(fastify, req);
      registerProviderRoutes(instance, {
        providers,
        models,
        authenticate,
        allowLocalProviders: true,
      });
      registerModelRoutes(instance, { models, authenticate });
    },
    { prefix: '/api/v1' },
  );

  // -- Dashboard: routing, usage, billing (absolute /api/v1/* paths) -------
  // Their handlers resolve the user via getUserId, so the session is
  // enforced by a preHandler here (they never call authenticate themselves).
  // The same hook records whether the user is an admin for isAdmin.
  await fastify.register(async (instance) => {
    instance.addHook('preHandler', async (req, reply) => {
      await fastify.authenticate(req, reply);
      const userId = req.user!.id;
      const assignments = await db.userRole.findMany({ where: { userId } });
      const roles = await db.role.findMany();
      const names = new Set(
        assignments.map((a) => roles.find((r) => r.id === a.roleId)?.name),
      );
      (req as unknown as { __isAdmin?: boolean }).__isAdmin =
        names.has('SUPER_ADMIN') || names.has('ADMIN');
    });
    const getUserId = (req: FastifyRequest): string | null =>
      req.user?.id ?? null;
    const isAdmin = (req: FastifyRequest): boolean =>
      Boolean((req as unknown as { __isAdmin?: boolean }).__isAdmin);
    await instance.register(routingRoutes, { store: routingStore, getUserId, isAdmin });
    await instance.register(usageRoutes, { store: usageStore, getUserId, isAdmin });
    await instance.register(billingRoutes, { store: billingStore, getUserId, isAdmin });
  });

  // -- Gateway (/v1) --------------------------------------------------------
  const storeChainResolver = createStoreChainResolver({ providers, models });
  const gatewayDeps: GatewayDeps = {
    keyLookup: async (plainKey) => {
      const rows = await db.apiKey.findMany({
        where: { keyHash: sha256Hex(plainKey) },
      });
      const row = rows[0];
      if (!row || row.revokedAt) return null;
      if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;
      return { userId: row.userId, apiKeyId: row.id };
    },
    providerSource: createStoreProviderSource({ providers, models }),
    chainResolver: async (req, auth) => {
      // An explicitly requested model wins: resolve it directly.
      if (req.model) {
        const direct = await storeChainResolver(req, auth);
        if (direct) return direct;
      }
      // Otherwise task routing (profile / default mapping) decides.
      try {
        const decision = await routingService.resolve({
          ...req,
          userId: auth.userId,
        });
        return decision.chain.map((e) => ({ provider: e.provider, model: e.model }));
      } catch {
        return null;
      }
    },
    recordUsage: async (rec) => {
      await usageService.record({
        userId: rec.userId,
        apiKeyId: rec.apiKeyId ?? null,
        requestId: rec.requestId,
        provider: rec.provider,
        model: rec.model,
        routingMode: 'AUTOMATIC',
        taskCategory: rec.taskCategory ?? null,
        inputTokens: rec.inputTokens,
        outputTokens: rec.outputTokens,
        cachedTokens: rec.cachedTokens ?? 0,
        tokensSaved: rec.tokensSaved ?? 0,
        // Provider cost is not computed yet (no pricing wired): record 0
        // and mark it as an estimate so the dashboard never shows a
        // made-up cost.
        estimatedCost: 0,
        costIsEstimate: true,
        latencyMs: rec.latencyMs,
        status: rec.status,
        attemptedChain: rec.attemptedChain.map((e) => `${e.provider}/${e.model}`),
      });
    },
    idempotency: new IdempotencyStore(),
    modelsList: async () => {
      const list = await models.list({ enabled: true });
      return Promise.all(
        list.map(async (m) => {
          const provider = await providers.get(m.providerId);
          return {
            id: m.modelId,
            object: 'model' as const,
            owned_by: provider?.type ?? m.providerId,
          };
        }),
      );
    },
  };
  await fastify.register(
    async (instance) => {
      registerGatewayRoutes(instance, gatewayDeps);
    },
    { prefix: '/v1' },
  );
}
