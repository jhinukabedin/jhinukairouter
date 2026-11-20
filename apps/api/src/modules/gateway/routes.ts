// Gateway routes (Builder 2 owns).
//   POST /v1/chat/completions   (OpenAI chat, stream + non-stream)
//   GET  /v1/models             (OpenAI models list)
//   POST /v1/embeddings         (OpenAI embeddings passthrough)
//   POST /v1/responses          (OpenAI responses API)
//   POST /v1/messages           (Anthropic messages API)
//
// Auth: `Authorization: Bearer <router-api-key>` (SHA-256 lookup, injected).
// Fallback: ONLY on 429/5xx/timeout/unavailable, respecting Retry-After.
// NEVER retry 401/400, NEVER switch model after the first streamed chunk,
// NEVER double-bill (usage recorded exactly once per request, on the final
// outcome). RTK optimisation runs inside the gateway (see provider-sdk/rtk).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  ModelChainEntry,
  NormalizedChatRequest,
  NormalizedChatResponse,
} from '@jhinuk-ai-router/shared';
import {
  IdempotencyStore,
  ProviderHttpError,
  estimateRequestTokens,
  estimateTokens,
  optimizeRequest,
} from '@jhinuk-ai-router/provider-sdk';
import {
  SSE_DONE,
  SSE_PING,
  anthropicMessagesToNormalized,
  formatSSE,
  normalizedToAnthropicResponse,
  normalizedToOpenAIResponse,
  normalizedToOpenAIResponsesObject,
  normalizedToOpenAIStreamChunk,
  openAIChatToNormalized,
  openAIResponsesToNormalized,
  parseSSEText,
  validateEmbeddingsBody,
} from '@jhinuk-ai-router/protocols';
import type {
  ApiKeyIdentity,
  GatewayDeps,
  ResolvedProvider,
  UsageRecordInput,
} from './types.js';

export { createSha256KeyLookup } from './types.js';

type AuthedRequest = FastifyRequest & { gatewayAuth?: ApiKeyIdentity };

class GatewayError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isRetryable(err: unknown): boolean {
  if (err instanceof ProviderHttpError) return err.retryable;
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return true;
  return false;
}

function retryAfterMs(err: unknown, capMs: number): number {
  if (err instanceof ProviderHttpError && err.retryAfterMs !== undefined) {
    return Math.min(err.retryAfterMs, capMs);
  }
  return 0;
}

function mapProviderError(err: unknown): GatewayError {
  if (err instanceof GatewayError) return err;
  if (err instanceof ProviderHttpError) {
    if (err.status === 401 || err.status === 403) {
      return new GatewayError(401, 'provider_auth_failed', `provider rejected the credential: ${err.message}`);
    }
    if (err.status === 400) {
      return new GatewayError(400, 'provider_bad_request', err.message);
    }
    if (err.status === 429) {
      return new GatewayError(429, 'rate_limited', err.message);
    }
    if (err.status === 408) {
      return new GatewayError(408, 'timeout', err.message);
    }
    if (err.status >= 500) {
      return new GatewayError(502, 'provider_error', err.message);
    }
    return new GatewayError(502, 'provider_error', err.message);
  }
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return new GatewayError(408, 'timeout', 'provider request timed out');
  }
  return new GatewayError(502, 'provider_error', err instanceof Error ? err.message : String(err));
}

function errorReply(reply: FastifyReply, err: unknown): FastifyReply {
  const mapped = mapProviderError(err);
  const body = { error: { message: mapped.message, type: 'gateway_error', code: mapped.code } };
  if (mapped.status === 429) reply.header('Retry-After', '1');
  return reply.code(mapped.status).send(body);
}

// ---------------------------------------------------------------------------
// Validation schemas (Zod v3)
// ---------------------------------------------------------------------------

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough())]).optional(),
  tool_calls: z.array(z.unknown()).optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
});

const chatBodySchema = z.object({
  model: z.string().min(1).optional(),
  messages: z.array(messageSchema).min(1),
  tools: z.array(z.unknown()).optional(),
  tool_choice: z.unknown().optional(),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  idempotencyKey: z.string().max(200).optional(),
  rtk: z.boolean().optional(),
  optimize: z.boolean().optional(),
  taskCategory: z.string().optional(),
  routingProfileId: z.string().optional(),
});

const responsesBodySchema = z.object({
  model: z.string().min(1).optional(),
  input: z.union([z.string(), z.array(z.object({ role: z.string().optional(), content: z.unknown() }).passthrough())]).optional(),
  instructions: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_output_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
  idempotencyKey: z.string().max(200).optional(),
  rtk: z.boolean().optional(),
  optimize: z.boolean().optional(),
});

const messagesBodySchema = z.object({
  model: z.string().min(1).optional(),
  system: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough())]).optional(),
  messages: z.array(z.object({ role: z.string(), content: z.unknown() }).passthrough()).min(1),
  tools: z.array(z.unknown()).optional(),
  tool_choice: z.unknown().optional(),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  stream: z.boolean().optional(),
  idempotencyKey: z.string().max(200).optional(),
  rtk: z.boolean().optional(),
  optimize: z.boolean().optional(),
});

const embeddingsBodySchema = z.object({
  model: z.string().min(1),
  input: z.union([z.string(), z.array(z.string())]),
});

// ---------------------------------------------------------------------------
// Chat execution core (shared by chat/responses/messages)
// ---------------------------------------------------------------------------

interface PreparedRequest {
  chain: ModelChainEntry[];
  request: NormalizedChatRequest;
  tokensSaved: number;
}

async function prepareRequest(
  deps: GatewayDeps,
  auth: ApiKeyIdentity,
  req: NormalizedChatRequest,
  resolveCache: Map<string, ResolvedProvider | null>,
): Promise<PreparedRequest> {
  const chain = deps.chainResolver
    ? await deps.chainResolver(req, auth)
    : null;
  if (!chain || chain.length === 0) {
    throw new GatewayError(404, 'model_not_found', `model '${req.model ?? ''}' is not available (unknown or disabled)`);
  }
  // RTK optimisation (default ON). Budget comes from the first chain entry's
  // model context window when known.
  const rtkEnabled = req.rtk !== false && req.optimize !== false;
  let tokensSaved = 0;
  let request = req;
  if (rtkEnabled) {
    let maxContextTokens: number | undefined;
    const first = chain[0];
    if (first) {
      const resolved = await resolveEntry(deps, auth, first, resolveCache);
      if (resolved?.contextWindow && resolved.contextWindow > 0) {
        maxContextTokens = resolved.contextWindow;
      }
    }
    const optimized = optimizeRequest(req, { maxContextTokens });
    request = optimized.request;
    tokensSaved = optimized.tokensSaved;
  }
  return { chain, request, tokensSaved };
}

async function resolveEntry(
  deps: GatewayDeps,
  auth: ApiKeyIdentity,
  entry: ModelChainEntry,
  cache: Map<string, ResolvedProvider | null>,
): Promise<ResolvedProvider | null> {
  const key = `${entry.provider}/${entry.model}`;
  if (!cache.has(key)) {
    cache.set(key, await deps.providerSource(entry, auth));
  }
  return cache.get(key) ?? null;
}

interface ChatOutcome {
  response: NormalizedChatResponse;
  servedEntry: ModelChainEntry;
  attemptedChain: ModelChainEntry[];
  tokensSaved: number;
  latencyMs: number;
}

/** Non-streaming execution with per-agent multi-model fallback. */
async function executeChat(
  deps: GatewayDeps,
  auth: ApiKeyIdentity,
  req: NormalizedChatRequest,
  requestId: string,
): Promise<ChatOutcome> {
  const started = Date.now();
  const cache = new Map<string, ResolvedProvider | null>();
  const { chain, request, tokensSaved } = await prepareRequest(deps, auth, req, cache);
  const attemptedChain: ModelChainEntry[] = [];
  let lastError: unknown = null;
  for (const entry of chain) {
    attemptedChain.push(entry);
    const resolved = await resolveEntry(deps, auth, entry, cache);
    if (!resolved) continue; // provider/model unavailable: try next in chain
    try {
      const signal = AbortSignal.timeout(resolved.timeoutMs);
      const response = await resolved.adapter.chat(request, resolved.credential, signal);
      response.tokensSaved = tokensSaved;
      response.attemptedChain = [...attemptedChain];
      return {
        response,
        servedEntry: entry,
        attemptedChain: [...attemptedChain],
        tokensSaved,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      lastError = err;
      const more = attemptedChain.length < chain.length;
      if (isRetryable(err) && more) {
        await sleep(retryAfterMs(err, deps.maxRetryAfterMs ?? 5_000));
        continue;
      }
      (err as { attemptedChain?: ModelChainEntry[] }).attemptedChain = [...attemptedChain];
      throw err;
    }
  }
  void requestId;
  throw lastError ?? new GatewayError(503, 'unavailable', 'no provider in the chain could serve this request');
}

async function recordUsageOnce(
  deps: GatewayDeps,
  rec: UsageRecordInput,
): Promise<void> {
  if (!deps.recordUsage) return;
  try {
    await deps.recordUsage(rec);
  } catch {
    // Usage recording must never fail the request itself.
  }
}

/** Record a FAILED usage entry once, keeping the attempted chain if known. */
async function recordFailedUsage(
  deps: GatewayDeps,
  auth: ApiKeyIdentity,
  requestId: string,
  normalized: NormalizedChatRequest,
  tokensSaved: number,
  err: unknown,
): Promise<void> {
  const mapped = mapProviderError(err);
  const attemptedChain =
    (err as { attemptedChain?: ModelChainEntry[] }).attemptedChain ?? [];
  await recordUsageOnce(deps, {
    userId: auth.userId,
    apiKeyId: auth.apiKeyId,
    requestId,
    provider: normalized.model ?? '',
    model: normalized.model ?? '',
    attemptedChain,
    inputTokens: 0,
    outputTokens: 0,
    tokensSaved,
    latencyMs: 0,
    status: 'FAILED',
    taskCategory: normalized.taskCategory,
    error: mapped.message,
  });
}

// ---------------------------------------------------------------------------
// Streaming helpers
// ---------------------------------------------------------------------------

interface StreamUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Pull usage + content out of OpenAI-format SSE chunks as they pass through. */
function inspectSseChunk(chunk: string, acc: { text: string; usage?: StreamUsage }): void {
  for (const payload of parseSSEText(chunk)) {
    if (payload === '[DONE]') continue;
    let data: { choices?: Array<{ delta?: { content?: string } }>; usage?: StreamUsage };
    try {
      data = JSON.parse(payload) as typeof data;
    } catch {
      continue;
    }
    const delta = data.choices?.[0]?.delta?.content;
    if (typeof delta === 'string') acc.text += delta;
    if (data.usage) acc.usage = data.usage;
  }
}

export function registerGatewayRoutes(app: FastifyInstance, deps: GatewayDeps): void {
  const idempotency = deps.idempotency ?? new IdempotencyStore();
  const rateLimit = deps.rateLimit === undefined ? { requests: 120, windowMs: 60_000 } : deps.rateLimit;
  const rateBuckets = new Map<string, { count: number; resetAt: number }>();

  // -- auth + rate limit for every /v1 route -------------------------------
  app.addHook('onRequest', async (req, reply) => {
    const authHeader = req.headers.authorization ?? '';
    const match = /^Bearer\s+(.+)$/.exec(authHeader);
    if (!match) {
      return reply.code(401).send({ error: { message: 'missing bearer router API key', type: 'auth_error', code: 'unauthorized' } });
    }
    const token = match[1];
    if (!token) {
      return reply.code(401).send({ error: { message: 'missing bearer router API key', type: 'auth_error', code: 'unauthorized' } });
    }
    const identity = await deps.keyLookup(token);
    if (!identity) {
      return reply.code(401).send({ error: { message: 'invalid or revoked router API key', type: 'auth_error', code: 'unauthorized' } });
    }
    (req as AuthedRequest).gatewayAuth = identity;

    if (rateLimit) {
      const now = Date.now();
      const bucket = rateBuckets.get(identity.apiKeyId);
      if (!bucket || now >= bucket.resetAt) {
        rateBuckets.set(identity.apiKeyId, { count: 1, resetAt: now + rateLimit.windowMs });
      } else if (bucket.count >= rateLimit.requests) {
        const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
        reply.header('Retry-After', String(retryAfter));
        return reply.code(429).send({ error: { message: 'gateway rate limit exceeded for this key', type: 'rate_limit_error', code: 'rate_limited' } });
      } else {
        bucket.count += 1;
      }
    }
  });

  const getAuth = (req: FastifyRequest): ApiKeyIdentity => {
    const auth = (req as AuthedRequest).gatewayAuth;
    if (!auth) throw new GatewayError(401, 'unauthorized', 'missing auth');
    return auth;
  };

  const idempotencyKeyOf = (req: FastifyRequest, body: { idempotencyKey?: string }): string | null => {
    const header = req.headers['idempotency-key'];
    if (typeof header === 'string' && header) return header;
    return body.idempotencyKey ?? null;
  };

  // -- GET /v1/models -------------------------------------------------------
  app.get('/models', async () => {
    const data = deps.modelsList ? await deps.modelsList() : [];
    return { object: 'list', data };
  });

  // -- POST /v1/chat/completions -------------------------------------------
  app.post('/chat/completions', async (req, reply) => {
    const auth = getAuth(req);
    const parsed = chatBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          type: 'invalid_request_error',
          code: 'invalid_request',
        },
      });
    }
    const body = parsed.data;
    const requestId = crypto.randomUUID();
    const normalized = openAIChatToNormalized(
      { ...body, messages: body.messages as never },
      auth.userId,
      auth.apiKeyId,
    );

    if (!body.stream) {
      const key = idempotencyKeyOf(req, body);
      if (key) {
        const claim = idempotency.claim(key);
        if (claim.status === 'done') {
          reply.header('Idempotency-Replayed', 'true');
          return reply.send(claim.response);
        }
        if (claim.status === 'pending') {
          return reply.code(409).send({ error: { message: 'a request with this idempotency key is already in flight', type: 'conflict_error', code: 'duplicate_request' } });
        }
      }
      try {
        const outcome = await executeChat(deps, auth, normalized, requestId);
        const payload = normalizedToOpenAIResponse(outcome.response);
        await recordUsageOnce(deps, {
          userId: auth.userId,
          apiKeyId: auth.apiKeyId,
          requestId,
          provider: outcome.servedEntry.provider,
          model: outcome.response.model,
          attemptedChain: outcome.attemptedChain,
          inputTokens: outcome.response.usage.promptTokens,
          outputTokens: outcome.response.usage.completionTokens,
          tokensSaved: outcome.tokensSaved,
          latencyMs: outcome.latencyMs,
          status: 'SUCCESS',
          taskCategory: normalized.taskCategory,
        });
        if (key) idempotency.store(key, payload);
        return reply.send(payload);
      } catch (err) {
        if (key) idempotency.release(key);
        await recordFailedUsage(deps, auth, requestId, normalized, 0, err);
        return errorReply(reply, err);
      }
    }

    // --- streaming path ---
    reply.hijack();
    const raw = reply.raw;
    const started = Date.now();
    let usageRecorded = false;
    const recordOnce = async (rec: UsageRecordInput): Promise<void> => {
      if (usageRecorded) return;
      usageRecorded = true;
      await recordUsageOnce(deps, rec);
    };
    const disconnect = new AbortController();
    raw.on('close', () => disconnect.abort());
    const keepAliveMs = deps.keepAliveMs ?? 15_000;
    const keepAlive = setInterval(() => {
      if (!raw.destroyed) raw.write(SSE_PING);
    }, keepAliveMs);
    const finish = async (): Promise<void> => {
      clearInterval(keepAlive);
      if (!raw.destroyed) raw.end();
    };

    try {
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const cache = new Map<string, ResolvedProvider | null>();
      const { chain, request, tokensSaved } = await prepareRequest(deps, auth, normalized, cache);
      const attemptedChain: ModelChainEntry[] = [];
      const acc: { text: string; usage?: StreamUsage } = { text: '' };
      let streamedAny = false;
      let servedEntry: ModelChainEntry | null = null;
      let lastError: unknown = null;

      for (const entry of chain) {
        attemptedChain.push(entry);
        const resolved = await resolveEntry(deps, auth, entry, cache);
        if (!resolved) continue;
        try {
          const signal = AbortSignal.any([
            disconnect.signal,
            AbortSignal.timeout(resolved.timeoutMs),
          ]);
          for await (const chunk of resolved.adapter.chatStream(request, resolved.credential, signal)) {
            if (raw.destroyed) break;
            // Inject tokens_saved usage before the adapter's [DONE].
            if (chunk.includes('[DONE]')) {
              const usage: StreamUsage = acc.usage ?? {
                promptTokens: estimateRequestTokens(request.messages),
                completionTokens: estimateTokens(acc.text),
                totalTokens: estimateRequestTokens(request.messages) + estimateTokens(acc.text),
              };
              const usageResp: NormalizedChatResponse = {
                id: requestId,
                model: entry.model,
                provider: entry.provider,
                choices: [{ message: { role: 'assistant', content: acc.text }, finishReason: 'stop' }],
                usage: { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, totalTokens: usage.totalTokens },
                latencyMs: Date.now() - started,
                tokensSaved,
              };
              raw.write(formatSSE(normalizedToOpenAIStreamChunk(usageResp, { includeUsage: true })));
              raw.write(SSE_DONE);
              streamedAny = true;
              servedEntry = entry;
              break;
            }
            inspectSseChunk(chunk, acc);
            raw.write(chunk);
            streamedAny = true;
            servedEntry = entry;
          }
          if (streamedAny) break; // never switch model after first chunk
          if (raw.destroyed) break;
        } catch (err) {
          lastError = err;
          if (disconnect.signal.aborted) break;
          const more = attemptedChain.length < chain.length;
          if (!streamedAny && isRetryable(err) && more) {
            await sleep(retryAfterMs(err, deps.maxRetryAfterMs ?? 5_000));
            continue;
          }
          throw err;
        }
      }

      if (!streamedAny) {
        // Nothing was streamed: report the failure as an SSE error event.
        const mapped = mapProviderError(lastError ?? new GatewayError(503, 'unavailable', 'no provider could serve this request'));
        raw.write(formatSSE({ error: { message: mapped.message, type: 'gateway_error', code: mapped.code } }));
        raw.write(SSE_DONE);
        await recordOnce({
          userId: auth.userId,
          apiKeyId: auth.apiKeyId,
          requestId,
          provider: normalized.model ?? '',
          model: normalized.model ?? '',
          attemptedChain,
          inputTokens: 0,
          outputTokens: 0,
          tokensSaved,
          latencyMs: Date.now() - started,
          status: 'FAILED',
          taskCategory: normalized.taskCategory,
          error: mapped.message,
        });
      } else if (servedEntry) {
        const usage: StreamUsage = acc.usage ?? {
          promptTokens: estimateRequestTokens(request.messages),
          completionTokens: estimateTokens(acc.text),
          totalTokens: estimateRequestTokens(request.messages) + estimateTokens(acc.text),
        };
        await recordOnce({
          userId: auth.userId,
          apiKeyId: auth.apiKeyId,
          requestId,
          provider: servedEntry.provider,
          model: servedEntry.model,
          attemptedChain,
          inputTokens: usage.promptTokens,
          outputTokens: usage.completionTokens,
          tokensSaved,
          latencyMs: Date.now() - started,
          status: 'SUCCESS',
          taskCategory: normalized.taskCategory,
        });
      }
    } catch (err) {
      // Mid-stream failure after output started: just end the stream.
      if (!raw.destroyed) {
        try {
          raw.write(formatSSE({ error: { message: mapProviderError(err).message, type: 'gateway_error', code: mapProviderError(err).code } }));
          raw.write(SSE_DONE);
        } catch {
          // client already gone
        }
      }
      await recordOnce({
        userId: auth.userId,
        apiKeyId: auth.apiKeyId,
        requestId,
        provider: normalized.model ?? '',
        model: normalized.model ?? '',
        attemptedChain: [],
        inputTokens: 0,
        outputTokens: 0,
        tokensSaved: 0,
        latencyMs: Date.now() - started,
        status: 'FAILED',
        taskCategory: normalized.taskCategory,
        error: mapProviderError(err).message,
      });
    } finally {
      await finish();
    }
  });

  // -- POST /v1/embeddings --------------------------------------------------
  app.post('/embeddings', async (req, reply) => {
    const auth = getAuth(req);
    const parsed = embeddingsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          type: 'invalid_request_error',
          code: 'invalid_request',
        },
      });
    }
    const validationError = validateEmbeddingsBody(parsed.data);
    if (validationError) {
      return reply.code(400).send({ error: { message: validationError, type: 'invalid_request_error', code: 'invalid_request' } });
    }
    const normalized: NormalizedChatRequest = {
      model: parsed.data.model,
      messages: [],
      userId: auth.userId,
      apiKeyId: auth.apiKeyId,
    };
    try {
      const chain = deps.chainResolver ? await deps.chainResolver(normalized, auth) : null;
      if (!chain?.length) {
        throw new GatewayError(404, 'model_not_found', `model '${parsed.data.model}' is not available`);
      }
      const entry = chain[0];
      if (!entry) {
        throw new GatewayError(404, 'model_not_found', `model '${parsed.data.model}' is not available`);
      }
      const resolved = await deps.providerSource(entry, auth);
      if (!resolved) {
        throw new GatewayError(503, 'unavailable', 'no provider could serve this embedding model');
      }
      if (resolved.adapter.embeddings) {
        const result = await resolved.adapter.embeddings(
          parsed.data.input,
          entry.model,
          resolved.credential,
          AbortSignal.timeout(resolved.timeoutMs),
        );
        return reply.send(result);
      }
      // Generic OpenAI-compatible passthrough.
      const res = await fetch(`${resolved.baseUrl.replace(/\/+$/, '')}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resolved.credential}` },
        body: JSON.stringify({ model: entry.model, input: parsed.data.input }),
        signal: AbortSignal.timeout(resolved.timeoutMs),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new ProviderHttpError(res.status, text.slice(0, 500) || `provider returned HTTP ${res.status}`);
      }
      return reply.send(await res.json());
    } catch (err) {
      return errorReply(reply, err);
    }
  });

  // -- POST /v1/responses ----------------------------------------------------
  app.post('/responses', async (req, reply) => {
    const auth = getAuth(req);
    const parsed = responsesBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          type: 'invalid_request_error',
          code: 'invalid_request',
        },
      });
    }
    const body = parsed.data;
    const requestId = crypto.randomUUID();
    const normalized = openAIResponsesToNormalized(
      { ...body, input: body.input as never },
      auth.userId,
      auth.apiKeyId,
    );

    if (!body.stream) {
      const key = idempotencyKeyOf(req, body);
      if (key) {
        const claim = idempotency.claim(key);
        if (claim.status === 'done') {
          reply.header('Idempotency-Replayed', 'true');
          return reply.send(claim.response);
        }
        if (claim.status === 'pending') {
          return reply.code(409).send({ error: { message: 'a request with this idempotency key is already in flight', type: 'conflict_error', code: 'duplicate_request' } });
        }
      }
      try {
        const outcome = await executeChat(deps, auth, normalized, requestId);
        const payload = normalizedToOpenAIResponsesObject(outcome.response);
        await recordUsageOnce(deps, {
          userId: auth.userId,
          apiKeyId: auth.apiKeyId,
          requestId,
          provider: outcome.servedEntry.provider,
          model: outcome.response.model,
          attemptedChain: outcome.attemptedChain,
          inputTokens: outcome.response.usage.promptTokens,
          outputTokens: outcome.response.usage.completionTokens,
          tokensSaved: outcome.tokensSaved,
          latencyMs: outcome.latencyMs,
          status: 'SUCCESS',
          taskCategory: normalized.taskCategory,
        });
        if (key) idempotency.store(key, payload);
        return reply.send(payload);
      } catch (err) {
        if (key) idempotency.release(key);
        await recordFailedUsage(deps, auth, requestId, normalized, 0, err);
        return errorReply(reply, err);
      }
    }

    // Streaming responses: translate OpenAI chunks to Responses events.
    reply.hijack();
    const raw = reply.raw;
    const started = Date.now();
    const disconnect = new AbortController();
    raw.on('close', () => disconnect.abort());
    const keepAlive = setInterval(() => {
      if (!raw.destroyed) raw.write(SSE_PING);
    }, deps.keepAliveMs ?? 15_000);
    try {
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const cache = new Map<string, ResolvedProvider | null>();
      const { chain, request, tokensSaved } = await prepareRequest(deps, auth, normalized, cache);
      const attemptedChain: ModelChainEntry[] = [];
      const acc: { text: string; usage?: StreamUsage } = { text: '' };
      let streamedAny = false;
      let servedEntry: ModelChainEntry | null = null;
      let itemId = `msg-${crypto.randomUUID()}`;
      let createdSent = false;
      for (const entry of chain) {
        attemptedChain.push(entry);
        const resolved = await resolveEntry(deps, auth, entry, cache);
        if (!resolved) continue;
        try {
          const signal = AbortSignal.any([disconnect.signal, AbortSignal.timeout(resolved.timeoutMs)]);
          for await (const chunk of resolved.adapter.chatStream(request, resolved.credential, signal)) {
            if (raw.destroyed) break;
            if (chunk.includes('[DONE]')) {
              const resp: NormalizedChatResponse = {
                id: `resp-${crypto.randomUUID()}`,
                model: entry.model,
                provider: entry.provider,
                choices: [{ message: { role: 'assistant', content: acc.text }, finishReason: 'stop' }],
                usage: {
                  promptTokens: acc.usage?.promptTokens ?? estimateRequestTokens(request.messages),
                  completionTokens: acc.usage?.completionTokens ?? estimateTokens(acc.text),
                  totalTokens:
                    (acc.usage?.totalTokens ?? estimateRequestTokens(request.messages) + estimateTokens(acc.text)),
                },
                latencyMs: Date.now() - started,
                tokensSaved,
              };
              raw.write(formatSSE({ type: 'response.completed', response: normalizedToOpenAIResponsesObject(resp) }));
              raw.write(SSE_DONE);
              streamedAny = true;
              servedEntry = entry;
              break;
            }
            for (const payload of parseSSEText(chunk)) {
              if (payload === '[DONE]') continue;
              let data: { choices?: Array<{ delta?: { content?: string } }>; usage?: StreamUsage };
              try {
                data = JSON.parse(payload) as typeof data;
              } catch {
                continue;
              }
              const delta = data.choices?.[0]?.delta?.content;
              if (data.usage) acc.usage = data.usage;
              if (typeof delta === 'string' && delta) {
                acc.text += delta;
                if (!createdSent) {
                  raw.write(formatSSE({ type: 'response.created', response: { id: `resp-${requestId}`, object: 'response', status: 'in_progress', model: entry.model } }));
                  raw.write(formatSSE({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: itemId, role: 'assistant', content: [] } }));
                  createdSent = true;
                }
                raw.write(formatSSE({ type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta }));
              }
            }
            streamedAny = true;
            servedEntry = entry;
          }
          if (streamedAny) break;
          if (raw.destroyed) break;
        } catch (err) {
          if (disconnect.signal.aborted) break;
          const more = attemptedChain.length < chain.length;
          if (!streamedAny && isRetryable(err) && more) {
            await sleep(retryAfterMs(err, deps.maxRetryAfterMs ?? 5_000));
            continue;
          }
          throw err;
        }
      }
      if (!streamedAny) {
        const mapped = mapProviderError(new GatewayError(503, 'unavailable', 'no provider could serve this request'));
        raw.write(formatSSE({ type: 'response.failed', response: { id: `resp-${requestId}`, object: 'response', status: 'failed', error: { message: mapped.message, code: mapped.code } } }));
        raw.write(SSE_DONE);
      } else if (servedEntry) {
        await recordUsageOnce(deps, {
          userId: auth.userId,
          apiKeyId: auth.apiKeyId,
          requestId,
          provider: servedEntry.provider,
          model: servedEntry.model,
          attemptedChain,
          inputTokens: acc.usage?.promptTokens ?? estimateRequestTokens(request.messages),
          outputTokens: acc.usage?.completionTokens ?? estimateTokens(acc.text),
          tokensSaved,
          latencyMs: Date.now() - started,
          status: 'SUCCESS',
          taskCategory: normalized.taskCategory,
        });
      }
    } catch (err) {
      if (!raw.destroyed) {
        try {
          raw.write(formatSSE({ type: 'response.failed', response: { id: `resp-${requestId}`, object: 'response', status: 'failed', error: { message: mapProviderError(err).message } } }));
          raw.write(SSE_DONE);
        } catch {
          // client gone
        }
      }
    } finally {
      clearInterval(keepAlive);
      if (!raw.destroyed) raw.end();
    }
  });

  // -- POST /v1/messages (Anthropic) ----------------------------------------
  app.post('/messages', async (req, reply) => {
    const auth = getAuth(req);
    const parsed = messagesBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          type: 'invalid_request_error',
          message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        },
      });
    }
    const body = parsed.data;
    const requestId = crypto.randomUUID();
    const normalized = anthropicMessagesToNormalized(
      { ...body, messages: body.messages as never, system: body.system as never },
      auth.userId,
      auth.apiKeyId,
    );

    if (!body.stream) {
      const key = idempotencyKeyOf(req, body);
      if (key) {
        const claim = idempotency.claim(key);
        if (claim.status === 'done') {
          reply.header('Idempotency-Replayed', 'true');
          return reply.send(claim.response);
        }
        if (claim.status === 'pending') {
          return reply.code(409).send({ error: { type: 'conflict_error', message: 'a request with this idempotency key is already in flight' } });
        }
      }
      try {
        const outcome = await executeChat(deps, auth, normalized, requestId);
        const payload = normalizedToAnthropicResponse(outcome.response);
        await recordUsageOnce(deps, {
          userId: auth.userId,
          apiKeyId: auth.apiKeyId,
          requestId,
          provider: outcome.servedEntry.provider,
          model: outcome.response.model,
          attemptedChain: outcome.attemptedChain,
          inputTokens: outcome.response.usage.promptTokens,
          outputTokens: outcome.response.usage.completionTokens,
          tokensSaved: outcome.tokensSaved,
          latencyMs: outcome.latencyMs,
          status: 'SUCCESS',
          taskCategory: normalized.taskCategory,
        });
        if (key) idempotency.store(key, payload);
        return reply.send(payload);
      } catch (err) {
        if (key) idempotency.release(key);
        await recordFailedUsage(deps, auth, requestId, normalized, 0, err);
        return errorReply(reply, err);
      }
    }

    // Streaming Anthropic events, translated from OpenAI-format chunks.
    reply.hijack();
    const raw = reply.raw;
    const started = Date.now();
    const disconnect = new AbortController();
    raw.on('close', () => disconnect.abort());
    const keepAlive = setInterval(() => {
      if (!raw.destroyed) raw.write(SSE_PING);
    }, deps.keepAliveMs ?? 15_000);
    try {
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const cache = new Map<string, ResolvedProvider | null>();
      const { chain, request, tokensSaved } = await prepareRequest(deps, auth, normalized, cache);
      const attemptedChain: ModelChainEntry[] = [];
      const acc: { text: string; usage?: StreamUsage } = { text: '' };
      const inputTokens = estimateRequestTokens(request.messages);
      const messageId = `msg-${crypto.randomUUID()}`;
      let streamedAny = false;
      let servedEntry: ModelChainEntry | null = null;
      let startedSent = false;
      for (const entry of chain) {
        attemptedChain.push(entry);
        const resolved = await resolveEntry(deps, auth, entry, cache);
        if (!resolved) continue;
        try {
          const signal = AbortSignal.any([disconnect.signal, AbortSignal.timeout(resolved.timeoutMs)]);
          for await (const chunk of resolved.adapter.chatStream(request, resolved.credential, signal)) {
            if (raw.destroyed) break;
            if (chunk.includes('[DONE]')) {
              const outputTokens = acc.usage?.completionTokens ?? estimateTokens(acc.text);
              raw.write(formatSSE({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: outputTokens } }));
              raw.write(formatSSE({ type: 'message_stop' }));
              raw.write(SSE_DONE);
              streamedAny = true;
              servedEntry = entry;
              break;
            }
            for (const payload of parseSSEText(chunk)) {
              if (payload === '[DONE]') continue;
              let data: { choices?: Array<{ delta?: { content?: string } }>; usage?: StreamUsage };
              try {
                data = JSON.parse(payload) as typeof data;
              } catch {
                continue;
              }
              const delta = data.choices?.[0]?.delta?.content;
              if (data.usage) acc.usage = data.usage;
              if (typeof delta === 'string' && delta) {
                acc.text += delta;
                if (!startedSent) {
                  raw.write(formatSSE({ type: 'message_start', message: { id: messageId, type: 'message', role: 'assistant', content: [], model: entry.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 } } }));
                  raw.write(formatSSE({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
                  startedSent = true;
                }
                raw.write(formatSSE({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } }));
              }
            }
            streamedAny = true;
            servedEntry = entry;
          }
          if (streamedAny) break;
          if (raw.destroyed) break;
        } catch (err) {
          if (disconnect.signal.aborted) break;
          const more = attemptedChain.length < chain.length;
          if (!streamedAny && isRetryable(err) && more) {
            await sleep(retryAfterMs(err, deps.maxRetryAfterMs ?? 5_000));
            continue;
          }
          throw err;
        }
      }
      if (!streamedAny) {
        const mapped = mapProviderError(new GatewayError(503, 'unavailable', 'no provider could serve this request'));
        raw.write(formatSSE({ type: 'error', error: { type: 'overloaded_error', message: mapped.message } }));
        raw.write(SSE_DONE);
      } else if (servedEntry) {
        await recordUsageOnce(deps, {
          userId: auth.userId,
          apiKeyId: auth.apiKeyId,
          requestId,
          provider: servedEntry.provider,
          model: servedEntry.model,
          attemptedChain,
          inputTokens: acc.usage?.promptTokens ?? inputTokens,
          outputTokens: acc.usage?.completionTokens ?? estimateTokens(acc.text),
          tokensSaved,
          latencyMs: Date.now() - started,
          status: 'SUCCESS',
          taskCategory: normalized.taskCategory,
        });
      }
    } catch (err) {
      if (!raw.destroyed) {
        try {
          raw.write(formatSSE({ type: 'error', error: { type: 'api_error', message: mapProviderError(err).message } }));
          raw.write(SSE_DONE);
        } catch {
          // client gone
        }
      }
    } finally {
      clearInterval(keepAlive);
      if (!raw.destroyed) raw.end();
    }
  });
}
