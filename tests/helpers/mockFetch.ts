// Minimal fetch mock for provider HTTP fixtures (no live keys, no network).
// Replaces globalThis.fetch; routes match on method + exact URL (or RegExp).
// Records every call so tests can assert call counts (e.g. fallback, no double-bill).

export interface MockCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface MockRoute {
  method: string;
  url: string | RegExp;
  status?: number;
  /** JSON body (object) or raw string body. */
  body?: unknown;
  headers?: Record<string, string>;
}

export class FetchMock {
  readonly calls: MockCall[] = [];
  private routes: MockRoute[] = [];
  private originalFetch: typeof fetch | null = null;

  on(route: MockRoute): this {
    this.routes.push(route);
    return this;
  }

  onJson(method: string, url: string, status: number, body: unknown): this {
    return this.on({ method, url, status, body, headers: { 'Content-Type': 'application/json' } });
  }

  callsTo(url: string, method = 'POST'): MockCall[] {
    return this.calls.filter((c) => c.url === url && c.method === method);
  }

  install(): void {
    this.originalFetch = globalThis.fetch;
    const self = this;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers: Record<string, string> = {};
      const h = init?.headers;
      if (h) {
        if (h instanceof Headers) h.forEach((v, k) => { headers[k] = v; });
        else if (Array.isArray(h)) for (const [k, v] of h) headers[k] = v;
        else Object.assign(headers, h);
      }
      const body = typeof init?.body === 'string' ? init.body : init?.body ? String(init.body) : null;
      self.calls.push({ url, method, headers, body });
      const route = self.routes.find(
        (r) => r.method === method && (typeof r.url === 'string' ? r.url === url : r.url.test(url)),
      );
      if (!route) {
        return new Response(JSON.stringify({ error: { message: `no mock route for ${method} ${url}` } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const status = route.status ?? 200;
      const responseBody =
        typeof route.body === 'string' ? route.body : JSON.stringify(route.body ?? {});
      return new Response(responseBody, { status, headers: route.headers ?? { 'Content-Type': 'application/json' } });
    };
  }

  restore(): void {
    if (this.originalFetch) globalThis.fetch = this.originalFetch;
    this.originalFetch = null;
  }

  reset(): void {
    this.routes = [];
    this.calls.length = 0;
  }
}

/** OpenAI chat/completions success body. */
export function openAIChatSuccess(model: string, content: string, usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }): Record<string, unknown> {
  return {
    id: `chatcmpl-test-${model}`,
    object: 'chat.completion',
    created: 1_700_000_000,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage,
  };
}

/** OpenAI SSE stream body for one assistant reply split into two deltas. */
export function openAISseStream(model: string, parts: string[], usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }): string {
  const chunks = parts.map(
    (text) =>
      `data: ${JSON.stringify({ id: 'chatcmpl-stream', object: 'chat.completion.chunk', created: 1_700_000_000, model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`,
  );
  chunks.push(
    `data: ${JSON.stringify({ id: 'chatcmpl-stream', object: 'chat.completion.chunk', created: 1_700_000_000, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n`,
  );
  chunks.push('data: [DONE]\n\n');
  return chunks.join('');
}

/** Anthropic messages success body. */
export function anthropicMessagesSuccess(model: string, text: string): Record<string, unknown> {
  return {
    id: 'msg-test',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}
