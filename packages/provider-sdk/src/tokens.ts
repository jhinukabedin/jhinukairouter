// Token estimation helpers (shared by adapters and RTK).
// Rough estimate (~4 chars/token) used only when a provider omits usage
// or when RTK needs a cheap pre-flight size check. Never billed on this.

import type { ChatMessage } from '@jhinuk-ai-router/shared';

export function estimateTokens(text: string): number {
  return Math.max(0, Math.ceil(text.length / 4));
}

export function estimateRequestTokens(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => n + estimateTokens(m.content ?? ''), 0);
}
