// RTK-style token saving INSIDE the gateway (CONTRACT.md refinement 1).
// This is NOT a proxy and NOT a daemon: it is a pure function run on the
// normalized request before it is sent to the provider, plus a small
// in-memory idempotency store for duplicate-request prevention.
//
// IMPORTANT: Jhinuk's local RTK OpenCode plugin on his PC and this router
// must NOT both proxy the same request. The plugin talks to the router as
// its base URL; the router then applies the optimisation below once, on
// the server side. Do not add a proxy layer between OpenCode and Tokens.

import type { ChatMessage, NormalizedChatRequest } from '@jhinuk-ai-router/shared';
import { estimateTokens } from './tokens.js';

export interface RtkOptions {
  /** Master switch; when false the request passes through untouched. */
  enabled?: boolean;
  /** Cap for a single tool-output message (chars). Default 4000. */
  maxToolOutputChars?: number;
  /** Collapse consecutive repeated lines inside tool outputs. Default true. */
  collapseRepeatedLines?: boolean;
  /** Max estimated prompt tokens; oldest non-system history is dropped over this. */
  maxContextTokens?: number;
  /** Max total message chars kept for a single user/assistant message. Default 200_000. */
  maxMessageChars?: number;
}

export interface RtkResult {
  request: NormalizedChatRequest;
  /** Estimated tokens saved vs the original request (>= 0). */
  tokensSaved: number;
  originalTokens: number;
  optimizedTokens: number;
  /** Human-readable list of what was changed (for logs / debugging). */
  details: string[];
}

const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 4000;
const DEFAULT_MAX_MESSAGE_CHARS = 200_000;

function collapseWhitespace(text: string): string {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ +\n/g, '\n')
    .trim();
}

function collapseRepeatedLines(text: string): { text: string; collapsed: number } {
  const lines = text.split('\n');
  const out: string[] = [];
  let collapsed = 0;
  let prev = '';
  let run = 0;
  for (const line of lines) {
    if (line === prev) {
      run += 1;
      collapsed += 1;
      continue;
    }
    if (run > 0) out.push(`[... ${run + 1}x repeated line: ${prev.slice(0, 120)}]`);
    out.push(line);
    prev = line;
    run = 0;
  }
  if (run > 0) out.push(`[... ${run + 1}x repeated line: ${prev.slice(0, 120)}]`);
  return { text: out.join('\n'), collapsed };
}

function isToolOutput(message: ChatMessage): boolean {
  return message.role === 'tool';
}

function trimToolOutput(message: ChatMessage, maxChars: number, collapseLines: boolean): { message: ChatMessage; savedChars: number } {
  let text = message.content ?? '';
  const before = text.length;
  if (collapseLines) {
    text = collapseRepeatedLines(text).text;
  }
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n[... tool output truncated: ${before - maxChars} chars removed by RTK]`;
  }
  return { message: { ...message, content: text }, savedChars: Math.max(0, before - text.length) };
}

/**
 * Optimise a normalized request in place-safe fashion (returns a new request).
 * Steps: trim duplicate whitespace, drop empty messages, trim noisy tool
 * outputs (cap + collapse repeated lines), drop oldest non-system history
 * over the context budget. Never drops system messages or the latest user
 * message. Returns tokensSaved (estimate) — 0 when disabled or nothing saved.
 */
export function optimizeRequest(
  request: NormalizedChatRequest,
  opts: RtkOptions = {},
): RtkResult {
  const enabled = opts.enabled ?? true;
  const originalTokens = request.messages.reduce(
    (n, m) => n + estimateTokens(m.content ?? ''),
    0,
  );
  const details: string[] = [];
  if (!enabled) {
    return { request, tokensSaved: 0, originalTokens, optimizedTokens: originalTokens, details };
  }

  const maxToolChars = opts.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS;
  const maxMessageChars = opts.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS;
  const collapseLines = opts.collapseRepeatedLines ?? true;

  let messages: ChatMessage[] = [];
  let droppedEmpty = 0;
  let trimmedToolChars = 0;

  for (const m of request.messages) {
    let content = collapseWhitespace(m.content ?? '');
    // Drop empty messages (no content, no tool calls).
    if (!content && !(m.toolCalls && m.toolCalls.length > 0)) {
      droppedEmpty += 1;
      continue;
    }
    let msg: ChatMessage = { ...m, content };
    if (isToolOutput(msg)) {
      const r = trimToolOutput(msg, maxToolChars, collapseLines);
      msg = r.message;
      trimmedToolChars += r.savedChars;
    } else if (content.length > maxMessageChars) {
      msg = { ...msg, content: `${content.slice(0, maxMessageChars)}\n[... message truncated by RTK]` };
    }
    messages.push(msg);
  }
  if (droppedEmpty > 0) details.push(`dropped ${droppedEmpty} empty message(s)`);
  if (trimmedToolChars > 0) details.push(`trimmed ${trimmedToolChars} chars of noisy tool output`);

  // Context-budget validation: drop oldest non-system history over budget.
  const maxContextTokens = opts.maxContextTokens;
  if (maxContextTokens !== undefined && maxContextTokens > 0) {
    const total = () => messages.reduce((n, m) => n + estimateTokens(m.content ?? ''), 0);
    let droppedHistory = 0;
    while (messages.length > 1 && total() > maxContextTokens) {
      // Oldest non-system message that is not the last message.
      const idx = messages.findIndex((m, i) => m.role !== 'system' && i < messages.length - 1);
      if (idx === -1) break;
      messages.splice(idx, 1);
      droppedHistory += 1;
    }
    if (droppedHistory > 0) {
      details.push(`dropped ${droppedHistory} oldest history message(s) over ${maxContextTokens}-token budget`);
    }
  }

  const optimizedTokens = messages.reduce((n, m) => n + estimateTokens(m.content ?? ''), 0);
  const tokensSaved = Math.max(0, originalTokens - optimizedTokens);
  return {
    request: { ...request, messages },
    tokensSaved,
    originalTokens,
    optimizedTokens,
    details,
  };
}

export interface ContextBudgetCheck {
  ok: boolean;
  estimatedTokens: number;
  contextWindow: number;
  overflowTokens: number;
}

/** Validate a request against a model's context window (estimate-based). */
export function validateContextBudget(
  request: NormalizedChatRequest,
  contextWindow: number,
): ContextBudgetCheck {
  const estimatedTokens = request.messages.reduce(
    (n, m) => n + estimateTokens(m.content ?? ''),
    0,
  ) + (request.maxTokens ?? 0);
  return {
    ok: estimatedTokens <= contextWindow,
    estimatedTokens,
    contextWindow,
    overflowTokens: Math.max(0, estimatedTokens - contextWindow),
  };
}

/**
 * In-memory idempotency store for duplicate-request prevention.
 * A key is claimed on first sight; when the request completes, the caller
 * stores its (small) response so a retry with the same key replays it
 * instead of calling the provider again (never double-bill). Entries
 * expire after `ttlMs` (default 24h). This is process-local by design —
 * with Redis present, Builder 3 may swap in a shared store with the same
 * interface; the gateway only depends on these three methods.
 */
export interface IdempotencyEntry {
  response: unknown;
  storedAt: number;
}

export class IdempotencyStore {
  private readonly seen = new Map<string, IdempotencyEntry | 'pending'>();
  private readonly ttlMs: number;

  constructor(ttlMs = 24 * 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  /** Claim a key. Returns 'new' (proceed), 'pending' (in-flight duplicate) or 'done' (replay stored response). */
  claim(key: string): { status: 'new' | 'pending' | 'done'; response?: unknown } {
    const entry = this.seen.get(key);
    if (entry === undefined) {
      this.seen.set(key, 'pending');
      return { status: 'new' };
    }
    if (entry === 'pending') return { status: 'pending' };
    if (Date.now() - entry.storedAt > this.ttlMs) {
      this.seen.delete(key);
      this.seen.set(key, 'pending');
      return { status: 'new' };
    }
    return { status: 'done', response: entry.response };
  }

  store(key: string, response: unknown): void {
    this.seen.set(key, { response, storedAt: Date.now() });
  }

  release(key: string): void {
    // Drop a pending claim (e.g. request failed before completing) so a
    // retry is not stuck behind a stale 'pending'.
    if (this.seen.get(key) === 'pending') this.seen.delete(key);
  }

  size(): number {
    return this.seen.size;
  }
}
