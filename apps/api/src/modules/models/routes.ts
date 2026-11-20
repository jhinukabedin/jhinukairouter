// Models API routes (Builder 2 owns).
//   GET   /api/v1/models            (list, ?providerId= &enabled=)
//   POST  /api/v1/models            (direct create — dashboard "Add Model")
//   PATCH /api/v1/models/:id        (enable/disable, display name, limits, capabilities)
//
// Adding a model/provider needs no code change: after POST /providers +
// POST /providers/:id/sync-models the model appears here, in routing
// profiles (Builder 3) and in GET /v1/models (gateway) immediately.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ModelRecord, ModelStore } from '../providers/store.js';

export interface ModelModuleDeps {
  models: ModelStore;
  authenticate?: (req: FastifyRequest) => Promise<boolean>;
}

const createModelSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1).max(200),
  displayName: z.string().min(1).max(200).optional(),
  contextWindow: z.number().int().min(0).max(10_000_000).default(0),
  maxOutputTokens: z.number().int().min(0).max(1_000_000).default(0),
  supportsStreaming: z.boolean().default(true),
  supportsTools: z.boolean().default(false),
  supportsVision: z.boolean().default(false),
  supportsReasoning: z.boolean().default(false),
  enabled: z.boolean().default(true),
});

const updateModelSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  contextWindow: z.number().int().min(0).max(10_000_000).optional(),
  maxOutputTokens: z.number().int().min(0).max(1_000_000).optional(),
  supportsStreaming: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  supportsReasoning: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

export function registerModelRoutes(app: FastifyInstance, deps: ModelModuleDeps): void {
  app.addHook('onRequest', async (req, reply) => {
    if (deps.authenticate && !(await deps.authenticate(req))) {
      return reply.code(401).send({ error: { message: 'unauthorized', code: 'unauthorized' } });
    }
  });

  app.get('/models', async (req) => {
    const q = req.query as { providerId?: string; enabled?: string };
    const list = await deps.models.list({
      providerId: q.providerId,
      enabled: q.enabled === undefined ? undefined : q.enabled === 'true',
    });
    return { data: list };
  });

  // Direct create (dashboard "Add Model" form). Sync-models is the other
  // path; both land in the same store and appear in GET /v1/models.
  app.post('/models', async (req, reply) => {
    const result = createModelSchema.safeParse(req.body);
    if (!result.success) {
      return reply.code(400).send({
        error: {
          message: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          code: 'invalid_request',
        },
      });
    }
    const data = result.data;
    const existing = await deps.models.getByProviderAndModel(data.providerId, data.modelId);
    if (existing) {
      return reply.code(409).send({ error: { message: 'model already exists for this provider', code: 'conflict' } });
    }
    const created = await deps.models.create({
      providerId: data.providerId,
      modelId: data.modelId,
      displayName: data.displayName ?? data.modelId,
      contextWindow: data.contextWindow,
      maxOutputTokens: data.maxOutputTokens,
      supportsStreaming: data.supportsStreaming,
      supportsTools: data.supportsTools,
      supportsVision: data.supportsVision,
      supportsReasoning: data.supportsReasoning,
      enabled: data.enabled,
    });
    return reply.code(201).send({ data: created });
  });

  app.patch('/models/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const existing = await deps.models.get(id);
    if (!existing) return reply.code(404).send({ error: { message: 'model not found', code: 'not_found' } });
    const result = updateModelSchema.safeParse(req.body);
    if (!result.success) {
      return reply.code(400).send({
        error: {
          message: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          code: 'invalid_request',
        },
      });
    }
    const patch: Partial<ModelRecord> = {};
    for (const [k, v] of Object.entries(result.data)) {
      if (v !== undefined) (patch as Record<string, unknown>)[k] = v;
    }
    const updated = await deps.models.update(id, patch);
    return { data: updated };
  });
}
