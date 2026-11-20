// Shared test helpers: build a Fastify app with Agent 3 routes wired to
// in-memory stores. Auth is the test header `x-user-id` (and
// `x-admin: true` where an isAdmin hook is needed).
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { routingRoutes } from '../apps/api/src/modules/routing/routes.js';
import { InMemoryRoutingStore } from '../apps/api/src/modules/routing/store.js';
import { usageRoutes } from '../apps/api/src/modules/usage/routes.js';
import { InMemoryUsageStore } from '../apps/api/src/modules/usage/store.js';
import { billingRoutes } from '../apps/api/src/modules/billing/routes.js';
import { InMemoryBillingStore } from '../apps/api/src/modules/billing/store.js';

export function buildApp() {
  const app: FastifyInstance = Fastify();
  const routingStore = new InMemoryRoutingStore();
  const usageStore = new InMemoryUsageStore();
  const billingStore = new InMemoryBillingStore();
  const isAdmin = (req: FastifyRequest) => req.headers['x-admin'] === 'true';
  void app.register(routingRoutes, { store: routingStore });
  void app.register(usageRoutes, { store: usageStore, isAdmin });
  void app.register(billingRoutes, { store: billingStore, isAdmin });
  return { app, routingStore, usageStore, billingStore };
}

export const userA = 'user-a';
export const userB = 'user-b';
export const asUser = (id: string) => ({ 'x-user-id': id });
export const asAdmin = (id: string) => ({ 'x-user-id': id, 'x-admin': 'true' });
