// @jhinuk-ai-router/provider-sdk — provider adapters (Builder 2 owns).
// Interface per CONTRACT.md. All adapters translate to/from the normalized
// chat request/response in @jhinuk-ai-router/shared. No adapter executes
// client tools — tool calls are returned to the caller, never run here.
// Credentials are passed in per call and never logged or stored.

import type {
  NormalizedChatRequest,
  NormalizedChatResponse,
} from '../../shared/src/index.js';

export { validateBaseUrl } from './ssrf.js';
export type { BaseUrlCheck } from './ssrf.js';
export { estimateTokens, estimateRequestTokens } from './tokens.js';
export * from './rtk.js';

export type ProviderProtocol = 'openai' | 'anthropic';

export type ProviderType =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'deepseek'
  | 'moonshot'
  | 'glm'
  | 'openrouter'
  | 'tokens'
  | 'ollama'
  | 'custom';

export interface ProviderAdapter {
  id: string;
  protocol: ProviderProtocol;
  chat(
    request: NormalizedChatRequest,
    credential: string,
    signal: AbortSignal,
  ): Promise<NormalizedChatResponse>;
  /** Yields SSE-ready chunks (`data: {...}\n\n`) in OpenAI chunk format. */
  chatStream(
    request: NormalizedChatRequest,
    credential: string,
    signal: AbortSignal,
  ): AsyncIterable<string>;
  listModels(credential: string): Promise<string[]>;
  testConnection(credential: string): Promise<boolean>;
  /** Optional: native embeddings passthrough (OpenAI-compatible only). */
  embeddings?(
    input: string | string[],
    model: string,
    credential: string,
    signal: AbortSignal,
  ): Promise<unknown>;
}

/** HTTP error from a provider. `retryable` is true only for 429/408/5xx. */
export class ProviderHttpError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'ProviderHttpError';
    this.status = status;
    this.retryable = status === 429 || status === 408 || status >= 500;
    this.retryAfterMs = retryAfterMs;
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 120) * 1000;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 120_000));
  return undefined;
}

import { estimateTokens, estimateRequestTokens } from './tokens.js';

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

function toOpenAIToolCalls(toolCalls: unknown[] | undefined): ToolCall[] | undefined {
  if (!toolCalls) return undefined;
  const out: ToolCall[] = [];
  for (const tc of toolCalls) {
    if (typeof tc !== 'object' || tc === null) continue;
    const t = tc as Record<string, unknown>;
    const fn = (t.function ?? {}) as Record<string, unknown>;
    out.push({
      id: String(t.id ?? ''),
      type: 'function',
      function: {
        name: String(fn.name ?? ''),
        arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
      },
    });
  }
  return out.length ? out : undefined;
}

async function readError(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return `provider returned HTTP ${res.status}`;
    try {
      const json = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
      if (typeof json.error === 'string') return json.error;
      if (json.error?.message) return json.error.message;
      if (json.message) return json.message;
    } catch {
      // not JSON — fall through to raw text
    }
    return text.slice(0, 500);
  } catch {
    return `provider returned HTTP ${res.status}`;
  }
}

async function fetchOrThrow(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new ProviderHttpError(408, `provider request timed out after ${timeoutMs}ms`);
    }
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ProviderHttpError(408, 'provider request aborted/timed out');
    }
    throw new ProviderHttpError(502, `provider unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    const message = await readError(res);
    throw new ProviderHttpError(res.status, message, parseRetryAfter(res.headers.get('retry-after')));
  }
  return res;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function normalizeChatResponse(
  provider: string,
  model: string,
  message: { role?: string; content?: string | null; tool_calls?: unknown[] },
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined,
  finishReason: string,
  latencyMs: number,
  request: NormalizedChatRequest,
): NormalizedChatResponse {
  const content = typeof message.content === 'string' ? message.content : '';
  const promptTokens = usage?.prompt_tokens ?? estimateRequestTokens(request.messages);
  const completionTokens = usage?.completion_tokens ?? estimateTokens(content);
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    model,
    provider,
    choices: [
      {
        message: {
          role: 'assistant',
          content,
          toolCalls: toOpenAIToolCalls(message.tool_calls as unknown[] | undefined),
        },
        finishReason,
      },
    ],
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: usage?.total_tokens ?? promptTokens + completionTokens,
    },
    latencyMs,
  };
}

/** Split an SSE byte stream into `data:` payload strings. */
async function* ssePayloads(res: Response): AsyncGenerator<string> {
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of event.split('\n')) {
          if (line.startsWith('data:')) yield line.slice(5).trim();
        }
      }
    }
    buffer += decoder.decode();
    for (const line of buffer.split('\n')) {
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  } finally {
    reader.releaseLock();
  }
}

export interface OpenAICompatibleAdapterOptions {
  id: string;
  baseUrl: string;
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
}

/** Generic OpenAI-compatible chat/completions adapter. Used for: openai,
 *  deepseek, moonshot (Kimi), glm, openrouter, tokens.bd, gemini (via its
 *  OpenAI-compatible endpoint), ollama, and custom OpenAI-compatible
 *  endpoints. */
export function createOpenAICompatibleAdapter(
  opts: OpenAICompatibleAdapterOptions,
): ProviderAdapter {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');

  const headers = (credential: string): Record<string, string> => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${credential}`,
    ...(opts.extraHeaders ?? {}),
  });

  function chatBody(request: NormalizedChatRequest, stream: boolean): Record<string, unknown> {
    const model = request.model ?? '';
    const body: Record<string, unknown> = {
      model,
      messages: request.messages.map((m) => {
        const msg: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.toolCalls) msg.tool_calls = m.toolCalls;
        if (m.toolCallId) msg.tool_call_id = m.toolCallId;
        return msg;
      }),
      stream,
    };
    if (request.tools?.length) body.tools = request.tools;
    if (request.toolChoice !== undefined) body.tool_choice = request.toolChoice;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    if (stream) body.stream_options = { include_usage: true };
    return body;
  }

  return {
    id: opts.id,
    protocol: 'openai',

    async chat(request, credential, signal) {
      const started = Date.now();
      const res = await fetchOrThrow(
        joinUrl(baseUrl, '/chat/completions'),
        {
          method: 'POST',
          headers: headers(credential),
          body: JSON.stringify(chatBody(request, false)),
          signal,
        },
        timeoutMs,
      );
      const data = (await res.json()) as {
        choices?: Array<{
          message?: { role?: string; content?: string | null; tool_calls?: unknown[] };
          finish_reason?: string;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        model?: string;
      };
      const choice = data.choices?.[0];
      return normalizeChatResponse(
        opts.id,
        data.model ?? request.model ?? '',
        choice?.message ?? {},
        data.usage,
        choice?.finish_reason ?? 'stop',
        Date.now() - started,
        request,
      );
    },

    async *chatStream(request, credential, signal) {
      const started = Date.now();
      const res = await fetchOrThrow(
        joinUrl(baseUrl, '/chat/completions'),
        {
          method: 'POST',
          headers: headers(credential),
          body: JSON.stringify(chatBody(request, true)),
          signal,
        },
        timeoutMs,
      );
      const model = request.model ?? '';
      let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
      let streamedAny = false;
      for await (const payload of ssePayloads(res)) {
        if (payload === '[DONE]') break;
        let chunk: {
          choices?: Array<{ delta?: { content?: string; tool_calls?: unknown[] }; finish_reason?: string | null }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          model?: string;
        };
        try {
          chunk = JSON.parse(payload) as typeof chunk;
        } catch {
          continue; // skip malformed chunk, keep streaming
        }
        if (chunk.usage) usage = chunk.usage;
        // Re-emit as a clean OpenAI-format SSE chunk (same shape, normalised).
        yield `data: ${JSON.stringify({
          id: `chatcmpl-${crypto.randomUUID()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: chunk.model ?? model,
          choices: (chunk.choices ?? []).map((c) => ({
            index: 0,
            delta: c.delta ?? {},
            finish_reason: c.finish_reason ?? null,
          })),
        })}\n\n`;
        streamedAny = true;
      }
      void streamedAny;
      void started;
      // Final usage chunk (OpenAI stream_options include_usage style).
      if (usage) {
        yield `data: ${JSON.stringify({
          id: `chatcmpl-${crypto.randomUUID()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [],
          usage: {
            prompt_tokens: usage.prompt_tokens ?? 0,
            completion_tokens: usage.completion_tokens ?? 0,
            total_tokens: usage.total_tokens ?? 0,
          },
        })}\n\n`;
      }
      yield 'data: [DONE]\n\n';
    },

    async listModels(credential) {
      const res = await fetchOrThrow(
        joinUrl(baseUrl, '/models'),
        { method: 'GET', headers: headers(credential) },
        timeoutMs,
      );
      const data = (await res.json()) as { data?: Array<{ id?: string }> };
      return (data.data ?? []).map((m) => m.id ?? '').filter(Boolean);
    },

    async testConnection(credential) {
      try {
        await this.listModels(credential);
        return true;
      } catch {
        return false;
      }
    },

    async embeddings(input, model, credential, signal) {
      const res = await fetchOrThrow(
        joinUrl(baseUrl, '/embeddings'),
        {
          method: 'POST',
          headers: headers(credential),
          body: JSON.stringify({ model, input }),
          signal,
        },
        timeoutMs,
      );
      return res.json() as Promise<unknown>;
    },
  };
}

export interface AnthropicAdapterOptions {
  id: string;
  baseUrl: string;
  timeoutMs?: number;
}

/** Native Anthropic Messages API adapter (api.anthropic.com and
 *  Anthropic-compatible custom endpoints). Translates to/from the
 *  normalized form; tool_use blocks become OpenAI-style tool_calls. */
export function createAnthropicAdapter(opts: AnthropicAdapterOptions): ProviderAdapter {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');

  const headers = (credential: string): Record<string, string> => ({
    'Content-Type': 'application/json',
    'x-api-key': credential,
    'anthropic-version': '2023-06-01',
  });

  function toAnthropicMessages(request: NormalizedChatRequest): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const m of request.messages) {
      if (m.role === 'system') continue;
      if (m.role === 'tool') {
        out.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content }],
        });
        continue;
      }
      const content: unknown[] = [{ type: 'text', text: m.content }];
      const toolCalls = toOpenAIToolCalls(m.toolCalls as unknown[] | undefined);
      if (toolCalls) {
        for (const tc of toolCalls) {
          let args: unknown = {};
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            args = {};
          }
          content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: args });
        }
      }
      out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content });
    }
    return out;
  }

  function anthropicBody(request: NormalizedChatRequest, stream: boolean): Record<string, unknown> {
    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const body: Record<string, unknown> = {
      model: request.model ?? '',
      messages: toAnthropicMessages(request),
      stream,
    };
    if (system) body.system = system;
    if (request.tools?.length) {
      body.tools = (request.tools as Array<Record<string, unknown>>).map((t) => {
        const fn = ((t.function ?? t) as Record<string, unknown>) ?? {};
        return {
          name: fn.name ?? t.name,
          description: fn.description ?? t.description ?? '',
          input_schema: fn.parameters ?? t.input_schema ?? { type: 'object', properties: {} },
        };
      });
    }
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    else body.max_tokens = 4096;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    return body;
  }

  return {
    id: opts.id,
    protocol: 'anthropic',

    async chat(request, credential, signal) {
      const started = Date.now();
      const res = await fetchOrThrow(
        joinUrl(baseUrl, '/v1/messages'),
        {
          method: 'POST',
          headers: headers(credential),
          body: JSON.stringify(anthropicBody(request, false)),
          signal,
        },
        timeoutMs,
      );
      const data = (await res.json()) as {
        content?: Array<{
          type?: string;
          text?: string;
          id?: string;
          name?: string;
          input?: unknown;
        }>;
        usage?: { input_tokens?: number; output_tokens?: number };
        model?: string;
        stop_reason?: string;
      };
      let text = '';
      const toolCalls: ToolCall[] = [];
      for (const block of data.content ?? []) {
        if (block.type === 'text') text += block.text ?? '';
        if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id ?? '',
            type: 'function',
            function: {
              name: block.name ?? '',
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        }
      }
      const promptTokens = data.usage?.input_tokens ?? estimateRequestTokens(request.messages);
      const completionTokens = data.usage?.output_tokens ?? estimateTokens(text);
      return {
        id: `msg-${crypto.randomUUID()}`,
        model: data.model ?? request.model ?? '',
        provider: opts.id,
        choices: [
          {
            message: {
              role: 'assistant',
              content: text,
              toolCalls: toolCalls.length ? toolCalls : undefined,
            },
            finishReason: data.stop_reason === 'tool_use' ? 'tool_calls' : (data.stop_reason ?? 'stop'),
          },
        ],
        usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
        latencyMs: Date.now() - started,
      };
    },

    async *chatStream(request, credential, signal) {
      const res = await fetchOrThrow(
        joinUrl(baseUrl, '/v1/messages'),
        {
          method: 'POST',
          headers: headers(credential),
          body: JSON.stringify(anthropicBody(request, true)),
          signal,
        },
        timeoutMs,
      );
      const model = request.model ?? '';
      let text = '';
      for await (const payload of ssePayloads(res)) {
        let event: { type?: string; delta?: { type?: string; text?: string }; usage?: { input_tokens?: number; output_tokens?: number } };
        try {
          event = JSON.parse(payload) as typeof event;
        } catch {
          continue;
        }
        if (event.type === 'content_block_delta' && event.delta?.text) {
          text += event.delta.text;
          yield `data: ${JSON.stringify({
            id: `chatcmpl-${crypto.randomUUID()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { content: event.delta.text }, finish_reason: null }],
          })}\n\n`;
        }
        if (event.type === 'message_stop') {
          yield `data: ${JSON.stringify({
            id: `chatcmpl-${crypto.randomUUID()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: event.usage?.input_tokens ?? estimateRequestTokens(request.messages),
              completion_tokens: event.usage?.output_tokens ?? estimateTokens(text),
              total_tokens:
                (event.usage?.input_tokens ?? 0) + (event.usage?.output_tokens ?? 0) ||
                estimateRequestTokens(request.messages) + estimateTokens(text),
            },
          })}\n\n`;
        }
      }
      yield 'data: [DONE]\n\n';
    },

    async listModels(credential) {
      const res = await fetchOrThrow(
        joinUrl(baseUrl, '/v1/models'),
        { method: 'GET', headers: headers(credential) },
        timeoutMs,
      );
      const data = (await res.json()) as { data?: Array<{ id?: string }> };
      return (data.data ?? []).map((m) => m.id ?? '').filter(Boolean);
    },

    async testConnection(credential) {
      try {
        await this.listModels(credential);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Default base URLs for built-in providers (CONTRACT.md). */
export const DEFAULT_BASE_URLS: Record<Exclude<ProviderType, 'custom'>, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  deepseek: 'https://api.deepseek.com/v1',
  moonshot: 'https://api.moonshot.ai/v1',
  glm: 'https://open.bigmodel.cn/api/paas/v4',
  openrouter: 'https://openrouter.ai/api/v1',
  tokens: 'https://tokens.bd/v1',
  ollama: 'http://localhost:11434/v1',
};

export interface CreateAdapterOptions {
  /** Required for type=custom; ignored for built-ins unless overriding. */
  baseUrl?: string;
  /** 'openai' | 'anthropic' — required for type=custom. */
  protocol?: ProviderProtocol;
  timeoutMs?: number;
}

/**
 * Build the adapter for a provider type. Ollama defaults to
 * http://localhost:11434/v1 and is local-only: it must only be enabled
 * via explicit admin config (see providers module / allowLocalProviders).
 */
export function createAdapter(
  type: ProviderType,
  opts: CreateAdapterOptions = {},
): ProviderAdapter {
  if (type === 'anthropic') {
    return createAnthropicAdapter({ id: type, baseUrl: opts.baseUrl ?? DEFAULT_BASE_URLS.anthropic, timeoutMs: opts.timeoutMs });
  }
  if (type === 'custom') {
    if (!opts.baseUrl) throw new Error('custom provider requires baseUrl');
    if (opts.protocol === 'anthropic') {
      return createAnthropicAdapter({ id: 'custom', baseUrl: opts.baseUrl, timeoutMs: opts.timeoutMs });
    }
    return createOpenAICompatibleAdapter({ id: 'custom', baseUrl: opts.baseUrl, timeoutMs: opts.timeoutMs });
  }
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URLS[type];
  const extraHeaders =
    type === 'openrouter'
      ? { 'HTTP-Referer': 'https://router.developersbd.top', 'X-Title': 'Jhinuk AI Router' }
      : undefined;
  return createOpenAICompatibleAdapter({ id: type, baseUrl, extraHeaders, timeoutMs: opts.timeoutMs });
}
