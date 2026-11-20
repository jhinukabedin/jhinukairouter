// @jhinuk-ai-router/protocols — request/response conversion between the
// wire protocols the gateway speaks (OpenAI chat/completions + responses,
// Anthropic messages) and the normalized form in @jhinuk-ai-router/shared.
// Also SSE chunk formatting and tool-call translation. No I/O here: pure
// functions, so they are trivially unit-testable.

import type {
  ChatMessage,
  NormalizedChatRequest,
  NormalizedChatResponse,
} from '../../shared/src/index.js';

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

/** Format one SSE event. `data` may be an object (JSON-encoded) or a string. */
export function formatSSE(data: unknown): string {
  if (typeof data === 'string') return `data: ${data}\n\n`;
  return `data: ${JSON.stringify(data)}\n\n`;
}

export const SSE_DONE = 'data: [DONE]\n\n';
export const SSE_PING = ': ping\n\n';

/** Extract `data:` payloads from a raw SSE text body. */
export function parseSSEText(text: string): string[] {
  const out: string[] = [];
  for (const event of text.split(/\n\n/)) {
    for (const line of event.split('\n')) {
      if (line.startsWith('data:')) out.push(line.slice(5).trim());
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tool-call translation: OpenAI tool_calls <-> Anthropic tool_use blocks
// ---------------------------------------------------------------------------

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export function toOpenAIToolCalls(toolCalls: unknown[] | undefined): OpenAIToolCall[] | undefined {
  if (!toolCalls?.length) return undefined;
  const out: OpenAIToolCall[] = [];
  for (const tc of toolCalls) {
    if (typeof tc !== 'object' || tc === null) continue;
    const t = tc as Record<string, unknown>;
    const fn = (t.function ?? {}) as Record<string, unknown>;
    out.push({
      id: String(t.id ?? ''),
      type: 'function',
      function: {
        name: String(fn.name ?? ''),
        arguments:
          typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
      },
    });
  }
  return out.length ? out : undefined;
}

/** Normalized tool calls -> Anthropic `tool_use` content blocks. */
export function toAnthropicToolUseBlocks(toolCalls: unknown[] | undefined): Array<Record<string, unknown>> {
  const calls = toOpenAIToolCalls(toolCalls) ?? [];
  return calls.map((tc) => {
    let input: unknown = {};
    try {
      input = JSON.parse(tc.function.arguments);
    } catch {
      input = {};
    }
    return { type: 'tool_use', id: tc.id, name: tc.function.name, input };
  });
}

/** Anthropic `tool_use` blocks -> normalized (OpenAI-style) tool calls. */
export function fromAnthropicToolUseBlocks(blocks: unknown[] | undefined): OpenAIToolCall[] | undefined {
  if (!blocks?.length) return undefined;
  const out: OpenAIToolCall[] = [];
  for (const b of blocks) {
    if (typeof b !== 'object' || b === null) continue;
    const block = b as Record<string, unknown>;
    if (block.type !== 'tool_use') continue;
    out.push({
      id: String(block.id ?? ''),
      type: 'function',
      function: { name: String(block.name ?? ''), arguments: JSON.stringify(block.input ?? {}) },
    });
  }
  return out.length ? out : undefined;
}

// ---------------------------------------------------------------------------
// OpenAI chat/completions <-> normalized
// ---------------------------------------------------------------------------

export interface OpenAIChatRequestBody {
  model?: string;
  messages?: Array<{
    role?: string;
    content?: string | Array<{ type?: string; text?: string }>;
    tool_calls?: unknown[];
    tool_call_id?: string;
    name?: string;
  }>;
  tools?: unknown[];
  tool_choice?: unknown;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  idempotencyKey?: string;
  rtk?: boolean;
  optimize?: boolean;
  taskCategory?: string;
  routingProfileId?: string;
}

function openAIMessageContent(
  content: string | Array<{ type?: string; text?: string }> | undefined,
): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p.type === 'text')
      .map((p) => p.text ?? '')
      .join('');
  }
  return '';
}

/** POST /v1/chat/completions body -> normalized request. */
export function openAIChatToNormalized(
  body: OpenAIChatRequestBody,
  userId: string,
  apiKeyId?: string,
): NormalizedChatRequest {
  const messages: ChatMessage[] = (body.messages ?? []).map((m) => ({
    role: (m.role ?? 'user') as ChatMessage['role'],
    content: openAIMessageContent(m.content),
    toolCalls: m.tool_calls as unknown[] | undefined,
    toolCallId: m.tool_call_id,
  }));
  return {
    model: body.model,
    taskCategory: body.taskCategory as NormalizedChatRequest['taskCategory'],
    routingProfileId: body.routingProfileId,
    messages,
    tools: body.tools,
    toolChoice: body.tool_choice,
    stream: body.stream,
    temperature: body.temperature,
    maxTokens: body.max_tokens,
    userId,
    apiKeyId,
    idempotencyKey: body.idempotencyKey,
    rtk: body.rtk,
    optimize: body.optimize,
  };
}

/** Normalized request -> OpenAI chat/completions request body. */
export function normalizedToOpenAIChat(request: NormalizedChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model ?? '',
    messages: request.messages.map((m) => {
      const msg: Record<string, unknown> = { role: m.role, content: m.content };
      if (m.toolCalls) msg.tool_calls = m.toolCalls;
      if (m.toolCallId) msg.tool_call_id = m.toolCallId;
      return msg;
    }),
  };
  if (request.tools?.length) body.tools = request.tools;
  if (request.toolChoice !== undefined) body.tool_choice = request.toolChoice;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
  return body;
}

/** Normalized response -> OpenAI chat.completion object (non-streaming). */
export function normalizedToOpenAIResponse(
  resp: NormalizedChatResponse,
  opts: { includeTokensSaved?: boolean } = {},
): Record<string, unknown> {
  const choice = resp.choices[0];
  const usage: Record<string, unknown> = {
    prompt_tokens: resp.usage.promptTokens,
    completion_tokens: resp.usage.completionTokens,
    total_tokens: resp.usage.totalTokens,
  };
  if (opts.includeTokensSaved !== false && resp.tokensSaved !== undefined) {
    usage.tokens_saved = resp.tokensSaved;
  }
  const message: Record<string, unknown> = { role: 'assistant', content: choice?.message.content ?? '' };
  if (choice?.message.toolCalls) message.tool_calls = choice.message.toolCalls;
  return {
    id: resp.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: resp.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: choice?.finishReason ?? 'stop',
      },
    ],
    usage,
  };
}

/** One OpenAI chat.completion.chunk object for a streamed response. */
export function normalizedToOpenAIStreamChunk(
  resp: NormalizedChatResponse,
  opts: { content?: string; finishReason?: string | null; includeUsage?: boolean } = {},
): Record<string, unknown> {
  const chunk: Record<string, unknown> = {
    id: resp.id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: resp.model,
    choices: [
      {
        index: 0,
        delta: opts.content !== undefined ? { content: opts.content } : {},
        finish_reason: opts.finishReason ?? null,
      },
    ],
  };
  if (opts.includeUsage) {
    chunk.usage = {
      prompt_tokens: resp.usage.promptTokens,
      completion_tokens: resp.usage.completionTokens,
      total_tokens: resp.usage.totalTokens,
      ...(resp.tokensSaved !== undefined ? { tokens_saved: resp.tokensSaved } : {}),
    };
  }
  return chunk;
}

// ---------------------------------------------------------------------------
// OpenAI responses API (/v1/responses) <-> normalized
// ---------------------------------------------------------------------------

export interface OpenAIResponsesRequestBody {
  model?: string;
  input?: string | Array<{ role?: string; content?: string | Array<{ type?: string; text?: string }> }>;
  instructions?: string;
  temperature?: number;
  max_output_tokens?: number;
  stream?: boolean;
  idempotencyKey?: string;
  rtk?: boolean;
  optimize?: boolean;
}

/** POST /v1/responses body -> normalized request. */
export function openAIResponsesToNormalized(
  body: OpenAIResponsesRequestBody,
  userId: string,
  apiKeyId?: string,
): NormalizedChatRequest {
  const messages: ChatMessage[] = [];
  if (body.instructions) messages.push({ role: 'system', content: body.instructions });
  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      messages.push({
        role: (item.role ?? 'user') as ChatMessage['role'],
        content: openAIMessageContent(item.content),
      });
    }
  }
  return {
    model: body.model,
    messages,
    stream: body.stream,
    temperature: body.temperature,
    maxTokens: body.max_output_tokens,
    userId,
    apiKeyId,
    idempotencyKey: body.idempotencyKey,
    rtk: body.rtk,
    optimize: body.optimize,
  };
}

/** Normalized response -> OpenAI responses object. */
export function normalizedToOpenAIResponsesObject(
  resp: NormalizedChatResponse,
): Record<string, unknown> {
  const choice = resp.choices[0];
  const text = choice?.message.content ?? '';
  return {
    id: resp.id.replace(/^chatcmpl-/, 'resp-'),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: resp.model,
    status: 'completed',
    output: [
      {
        type: 'message',
        id: `msg-${crypto.randomUUID()}`,
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: resp.usage.promptTokens,
      output_tokens: resp.usage.completionTokens,
      total_tokens: resp.usage.totalTokens,
      ...(resp.tokensSaved !== undefined ? { tokens_saved: resp.tokensSaved } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Anthropic messages <-> normalized
// ---------------------------------------------------------------------------

export interface AnthropicMessagesRequestBody {
  model?: string;
  system?: string | Array<{ type?: string; text?: string }>;
  messages?: Array<{
    role?: string;
    content?: string | Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown }>;
  }>;
  tools?: unknown[];
  tool_choice?: unknown;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  idempotencyKey?: string;
  rtk?: boolean;
  optimize?: boolean;
}

function anthropicSystemText(
  system: string | Array<{ type?: string; text?: string }> | undefined,
): string {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map((p) => p.text ?? '').join('\n');
  return '';
}

/** POST /v1/messages body -> normalized request. */
export function anthropicMessagesToNormalized(
  body: AnthropicMessagesRequestBody,
  userId: string,
  apiKeyId?: string,
): NormalizedChatRequest {
  const messages: ChatMessage[] = [];
  const system = anthropicSystemText(body.system);
  if (system) messages.push({ role: 'system', content: system });

  for (const m of body.messages ?? []) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (typeof m.content === 'string') {
      messages.push({ role, content: m.content });
      continue;
    }
    let text = '';
    const toolUseBlocks: unknown[] = [];
    const toolResults: Array<{ toolCallId: string; content: string }> = [];
    for (const block of m.content ?? []) {
      if (block.type === 'text') text += block.text ?? '';
      else if (block.type === 'tool_use') toolUseBlocks.push(block);
      else if (block.type === 'tool_result') {
        toolResults.push({
          toolCallId: String(block.tool_use_id ?? ''),
          content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
        });
      }
    }
    if (toolResults.length > 0) {
      // Tool results arrive as a user turn; keep each as its own tool message.
      for (const r of toolResults) {
        messages.push({ role: 'tool', content: r.content, toolCallId: r.toolCallId });
      }
      if (text) messages.push({ role, content: text });
      continue;
    }
    messages.push({
      role,
      content: text,
      toolCalls: fromAnthropicToolUseBlocks(toolUseBlocks),
    });
  }

  // Anthropic tools arrive as {name, description, input_schema}; convert to
  // OpenAI function tools so adapters see one shape.
  const tools = (body.tools as Array<Record<string, unknown>> | undefined)?.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.input_schema ?? { type: 'object', properties: {} },
    },
  }));

  return {
    model: body.model,
    messages,
    tools,
    toolChoice: body.tool_choice,
    stream: body.stream,
    temperature: body.temperature,
    maxTokens: body.max_tokens,
    userId,
    apiKeyId,
    idempotencyKey: body.idempotencyKey,
    rtk: body.rtk,
    optimize: body.optimize,
  };
}

/** Normalized response -> Anthropic messages response object. */
export function normalizedToAnthropicResponse(
  resp: NormalizedChatResponse,
): Record<string, unknown> {
  const choice = resp.choices[0];
  const content: Array<Record<string, unknown>> = [];
  const text = choice?.message.content ?? '';
  if (text) content.push({ type: 'text', text });
  for (const block of toAnthropicToolUseBlocks(choice?.message.toolCalls as unknown[] | undefined)) {
    content.push(block);
  }
  const stopReason = choice?.finishReason === 'tool_calls' ? 'tool_use' : 'end_turn';
  return {
    id: resp.id.replace(/^chatcmpl-/, 'msg-'),
    type: 'message',
    role: 'assistant',
    model: resp.model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage.promptTokens,
      output_tokens: resp.usage.completionTokens,
      ...(resp.tokensSaved !== undefined ? { tokens_saved: resp.tokensSaved } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// OpenAI embeddings (passthrough validation only — gateway forwards the body)
// ---------------------------------------------------------------------------

export interface OpenAIEmbeddingsRequestBody {
  model?: string;
  input?: string | string[];
}

export function validateEmbeddingsBody(body: OpenAIEmbeddingsRequestBody): string | null {
  if (!body.model) return 'model is required';
  if (body.input === undefined || body.input === '') return 'input is required';
  return null;
}
