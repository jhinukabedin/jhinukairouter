// Providers API routes (Builder 2 owns).
//   GET    /api/v1/providers
//   POST   /api/v1/providers
//   GET    /api/v1/providers/:id
//   PATCH  /api/v1/providers/:id
//   DELETE /api/v1/providers/:id
//   POST   /api/v1/providers/:id/test
//   POST   /api/v1/providers/:id/sync-models
//
// Auth: pass `authenticate` in deps to plug Builder 1's session/role guard.
// When absent the routes are open — local-dev/test only; production MUST
// pass a guard. Credentials are write-only: responses carry only keyHint.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  createAdapter,
  validateBaseUrl,
  DEFAULT_BASE_URLS,
  type ProviderType,
} from '@jhinuk-ai-router/provider-sdk';
import type { ModelStore, ProviderRecord, ProviderStore } from './store.js';

export interface ProviderModuleDeps {
  providers: ProviderStore;
  models: ModelStore;
  /** When true, localhost/private base URLs are allowed (SystemSetting allowLocalProviders). */
  allowLocalProviders?: boolean | (() => boolean);
  /** Optional auth guard; return true to allow. Defaults to open (dev/test). */
  authenticate?: (req: FastifyRequest) => Promise<boolean>;
  /** Default timeout (ms) for test/sync calls. */
  defaultTimeoutMs?: number;
}

const providerTypeEnum = z.enum([
  'openai',
  'anthropic',
  'gemini',
  'deepseek',
  'moonshot',
  'glm',
  'openrouter',
  'tokens',
  'ollama',
  'custom',
]);

const createProviderSchema = z.object({
  name: z.string().min(1).max(120),
  type: providerTypeEnum,
  baseUrl: z.string().min(1).max(500).optional(),
  protocol: z.enum(['openai', 'anthropic']).optional(),
  enabled: z.boolean().default(true),
  isGlobal: z.boolean().default(true),
  ownerId: z.string().nullable().optional(),
  priority: z.number().int().min(0).max(1000).default(0),
  timeoutMs: z.number().int().min(1000).max(300_000).default(30_000),
  /** Sync only free models (OpenRouter: ids ending in `:free`). */
  freeOnly: z.boolean().default(false),
  /** Write-only API key for the provider. Never returned by any route.
   *  `apiKey` is accepted as an alias (dashboard docs use that name). */
  credential: z.string().min(1).max(2000).optional(),
  apiKey: z.string().min(1).max(2000).optional(),
});

const updateProviderSchema = createProviderSchema
  .omit({ type: true })
  .partial()
  .extend({ type: providerTypeEnum.optional() });

const syncModelSchema = z.object({}).passthrough();

function allowLocal(deps: ProviderModuleDeps): boolean {
  return typeof deps.allowLocalProviders === 'function'
    ? deps.allowLocalProviders()
    : (deps.allowLocalProviders ?? false);
}

function resolveBaseUrl(type: ProviderType, baseUrl?: string): string {
  if (baseUrl) return baseUrl.replace(/\/+$/, '');
  if (type === 'custom') throw new Error('custom provider requires baseUrl');
  return DEFAULT_BASE_URLS[type];
}

function toPublic(record: ProviderRecord): Record<string, unknown> {
  const { ...pub } = record;
  return pub;
}

function parseBody<S extends z.ZodTypeAny>(
  schema: S,
  body: unknown,
): { ok: true; data: z.infer<S> } | { ok: false; error: string } {
  const result = schema.safeParse(body);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  return { ok: true, data: result.data };
}

export function registerProviderRoutes(app: FastifyInstance, deps: ProviderModuleDeps): void {
  app.addHook('onRequest', async (req, reply) => {
    if (deps.authenticate && !(await deps.authenticate(req))) {
      return reply.code(401).send({ error: { message: 'unauthorized', code: 'unauthorized' } });
    }
  });

  app.get('/providers', async (req) => {
    const q = req.query as { type?: string; enabled?: string; ownerId?: string };
    const list = await deps.providers.list({
      type: q.type,
      enabled: q.enabled === undefined ? undefined : q.enabled === 'true',
      ownerId: q.ownerId,
    });
    return { data: list.map(toPublic) };
  });

  app.post('/providers', async (req, reply) => {
    const parsed = parseBody(createProviderSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: { message: parsed.error, code: 'invalid_request' } });
    const data = parsed.data;

    let baseUrl: string;
    try {
      baseUrl = resolveBaseUrl(data.type, data.baseUrl);
    } catch (err) {
      return reply.code(400).send({ error: { message: err instanceof Error ? err.message : 'bad baseUrl', code: 'invalid_request' } });
    }
    // Ollama is local-only: it needs the explicit admin allow-local setting.
    if (data.type === 'ollama' && !allowLocal(deps)) {
      return reply.code(400).send({
        error: {
          message: 'ollama is local-only; enable allowLocalProviders to add it',
          code: 'local_provider_not_allowed',
        },
      });
    }
    const check = validateBaseUrl(baseUrl, allowLocal(deps));
    if (!check.ok) {
      return reply.code(400).send({ error: { message: check.reason ?? 'invalid baseUrl', code: 'invalid_base_url' } });
    }

    const protocol = data.protocol ?? (data.type === 'anthropic' ? 'anthropic' : 'openai');
    const credential = data.credential ?? data.apiKey;
    const keyHint = credential ? credential.slice(-4) : null;
    const record = await deps.providers.create({
      name: data.name,
      type: data.type,
      baseUrl,
      protocol,
      enabled: data.enabled,
      isGlobal: data.isGlobal,
      ownerId: data.ownerId ?? null,
      priority: data.priority,
      timeoutMs: data.timeoutMs,
      freeOnly: data.freeOnly,
      keyHint,
    });
    if (credential) await deps.providers.setCredential(record.id, credential);
    return reply.code(201).send({ data: toPublic(record) });
  });

  app.get('/providers/:id', async (req, reply) => {
    const record = await deps.providers.get((req.params as { id: string }).id);
    if (!record) return reply.code(404).send({ error: { message: 'provider not found', code: 'not_found' } });
    return { data: toPublic(record) };
  });

  app.patch('/providers/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const existing = await deps.providers.get(id);
    if (!existing) return reply.code(404).send({ error: { message: 'provider not found', code: 'not_found' } });
    const parsed = parseBody(updateProviderSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: { message: parsed.error, code: 'invalid_request' } });
    const data = parsed.data;

    const patch: Partial<ProviderRecord> = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.type !== undefined) patch.type = data.type;
    if (data.protocol !== undefined) patch.protocol = data.protocol;
    if (data.enabled !== undefined) patch.enabled = data.enabled;
    if (data.isGlobal !== undefined) patch.isGlobal = data.isGlobal;
    if (data.ownerId !== undefined) patch.ownerId = data.ownerId;
    if (data.priority !== undefined) patch.priority = data.priority;
    if (data.timeoutMs !== undefined) patch.timeoutMs = data.timeoutMs;
    if (data.freeOnly !== undefined) patch.freeOnly = data.freeOnly;

    const nextType = patch.type ?? existing.type;
    if (data.baseUrl !== undefined || patch.type !== undefined) {
      let baseUrl: string;
      try {
        baseUrl = resolveBaseUrl(nextType, data.baseUrl ?? existing.baseUrl);
      } catch (err) {
        return reply.code(400).send({ error: { message: err instanceof Error ? err.message : 'bad baseUrl', code: 'invalid_request' } });
      }
      const check = validateBaseUrl(baseUrl, allowLocal(deps));
      if (!check.ok) {
        return reply.code(400).send({ error: { message: check.reason ?? 'invalid baseUrl', code: 'invalid_base_url' } });
      }
      patch.baseUrl = baseUrl;
    }
    const newCredential = data.credential ?? data.apiKey;
    if (newCredential) {
      await deps.providers.setCredential(id, newCredential);
      patch.keyHint = newCredential.slice(-4);
    }
    const updated = await deps.providers.update(id, patch);
    return { data: toPublic(updated as ProviderRecord) };
  });

  app.delete('/providers/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ok = await deps.providers.delete(id);
    if (!ok) return reply.code(404).send({ error: { message: 'provider not found', code: 'not_found' } });
    await deps.models.deleteByProvider(id);
    return reply.code(204).send();
  });

  app.post('/providers/:id/test', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const record = await deps.providers.get(id);
    if (!record) return reply.code(404).send({ error: { message: 'provider not found', code: 'not_found' } });
    const credential = await deps.providers.getCredential(id);
    if (!credential) {
      return reply.code(400).send({ error: { message: 'no credential stored for this provider', code: 'missing_credential' } });
    }
    const started = Date.now();
    let adapter;
    try {
      adapter = createAdapter(record.type, {
        baseUrl: record.baseUrl,
        protocol: record.protocol,
        timeoutMs: record.timeoutMs,
      });
    } catch (err) {
      return reply.code(400).send({ error: { message: err instanceof Error ? err.message : 'bad provider config', code: 'invalid_request' } });
    }
    const ok = await adapter.testConnection(credential);
    const latencyMs = Date.now() - started;
    if (!ok) {
      return { data: { ok: false, latencyMs, error: 'connection or auth failed (check key and base URL)' } };
    }
    return { data: { ok: true, latencyMs } };
  });

  app.post('/providers/:id/sync-models', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const parsed = parseBody(syncModelSchema, req.body ?? {});
    if (!parsed.ok) return reply.code(400).send({ error: { message: parsed.error, code: 'invalid_request' } });
    const record = await deps.providers.get(id);
    if (!record) return reply.code(404).send({ error: { message: 'provider not found', code: 'not_found' } });
    const credential = await deps.providers.getCredential(id);
    if (!credential) {
      return reply.code(400).send({ error: { message: 'no credential stored for this provider', code: 'missing_credential' } });
    }
    let adapter;
    try {
      adapter = createAdapter(record.type, {
        baseUrl: record.baseUrl,
        protocol: record.protocol,
        timeoutMs: record.timeoutMs,
      });
    } catch (err) {
      return reply.code(400).send({ error: { message: err instanceof Error ? err.message : 'bad provider config', code: 'invalid_request' } });
    }
    let modelIds: string[];
    try {
      modelIds = await adapter.listModels(credential);
    } catch (err) {
      return reply.code(502).send({
        error: {
          message: `sync failed: ${err instanceof Error ? err.message : String(err)}`,
          code: 'provider_error',
        },
      });
    }
    // Free-only providers (OpenRouter: ids ending in `:free`) keep just the
    // free models. OpenRouter's catalog is hundreds of paid models; syncing
    // all of them drowns the pickers and invites paid usage by accident.
    const isOpenRouter = record.type === 'openrouter' || record.baseUrl.includes('openrouter.ai');
    if (record.freeOnly && isOpenRouter) {
      modelIds = modelIds.filter((m) => m.endsWith(':free'));
    }
    const synced: Array<Record<string, unknown>> = [];
    for (const modelId of modelIds) {
      const existing = await deps.models.getByProviderAndModel(id, modelId);
      if (existing) {
        synced.push({ ...existing });
        continue;
      }
      const created = await deps.models.create({
        providerId: id,
        modelId,
        displayName: modelId,
        contextWindow: 0, // unknown until admin sets it or a known-defaults map is added
        maxOutputTokens: 0,
        supportsStreaming: true,
        supportsTools: false,
        supportsVision: false,
        supportsReasoning: false,
        enabled: true,
      });
      synced.push({ ...created });
    }
    // Prune models the filter excludes (e.g. paid ones synced before the
    // flag was turned on). Only when the filtered sync actually returned
    // models — an empty provider answer must never wipe the list.
    let pruned = 0;
    if (record.freeOnly && isOpenRouter && synced.length > 0) {
      for (const m of await deps.models.list({ providerId: id })) {
        if (!m.modelId.endsWith(':free')) {
          if (await deps.models.delete(m.id)) pruned += 1;
        }
      }
    }
    return { data: { synced: synced.length, models: synced, pruned } };
  });
}
