// @jhinuk-ai-router/shared — shared types. Agent 1 owns this file;
// other agents import it, never redefine these types (CONTRACT.md).

export const TASK_CATEGORIES = [
  'GENERAL',
  'SIMPLE_QUESTION',
  'CODE_GENERATION',
  'SMALL_CODE_FIX',
  'COMPLEX_DEBUGGING',
  'ARCHITECTURE',
  'PLANNING',
  'REASONING',
  'DATA_ANALYSIS',
  'LONG_CONTEXT',
  'VISION',
  'TOOL_CALLING',
] as const;

export type TaskCategory = (typeof TASK_CATEGORIES)[number];

export const ROUTING_MODES = ['AUTOMATIC', 'MANUAL', 'HYBRID'] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

/** One step in an ordered per-agent / per-task fallback chain. */
export interface ModelChainEntry {
  provider: string;
  model: string;
}

/**
 * Per-agent / per-task multi-model fallback chains.
 * Each task (or agent alias such as "coordinator", "fast", "coder",
 * "developer", "reasoner", "architect") maps to an ORDERED list of
 * (provider, model) pairs — try #1, on 429/5xx/timeout/unavailable go to
 * #2, then #3. Stored in RoutingProfile.taskMapping (JSON).
 */
export type TaskModelChains = Record<string, ModelChainEntry[]>;

/** Default task mapping — SEED ONLY. Configurable per user via RoutingProfile. */
export const DEFAULT_TASK_MAPPING: TaskModelChains = {
  GENERAL: [{ provider: 'tokens', model: 'gpt-6-luna' }],
  SIMPLE_QUESTION: [{ provider: 'gemini', model: 'gemini-flash' }],
  SMALL_CODE_FIX: [{ provider: 'deepseek', model: 'deepseek-flash' }],
  CODE_GENERATION: [{ provider: 'moonshot', model: 'kimi-k2.7-code' }],
  COMPLEX_DEBUGGING: [{ provider: 'deepseek', model: 'deepseek-v4-pro' }],
  ARCHITECTURE: [{ provider: 'glm', model: 'glm-5.3' }],
  PLANNING: [{ provider: 'tokens', model: 'gpt-6-luna' }],
  REASONING: [{ provider: 'deepseek', model: 'deepseek-v4-pro' }],
  DATA_ANALYSIS: [{ provider: 'tokens', model: 'gpt-6-luna' }],
  LONG_CONTEXT: [{ provider: 'moonshot', model: 'kimi-k2.7-code' }],
  VISION: [{ provider: 'gemini', model: 'gemini-flash' }],
  TOOL_CALLING: [{ provider: 'tokens', model: 'gpt-6-luna' }],
};

/** Default per-agent chains (OpenCode agent aliases -> ordered model lists). */
export const DEFAULT_AGENT_CHAINS: TaskModelChains = {
  coordinator: [
    { provider: 'tokens', model: 'gpt-6-luna' },
    { provider: 'deepseek', model: 'deepseek-flash' },
    { provider: 'moonshot', model: 'kimi-k2.7-code' },
  ],
  fast: [
    { provider: 'deepseek', model: 'deepseek-flash' },
    { provider: 'tokens', model: 'gpt-6-luna' },
  ],
  coder: [
    { provider: 'moonshot', model: 'kimi-k2.7-code' },
    { provider: 'deepseek', model: 'deepseek-v4-pro' },
    { provider: 'tokens', model: 'gpt-6-luna' },
  ],
  developer: [
    { provider: 'moonshot', model: 'kimi-k2.7-code' },
    { provider: 'deepseek', model: 'deepseek-flash' },
  ],
  reasoner: [
    { provider: 'deepseek', model: 'deepseek-v4-pro' },
    { provider: 'glm', model: 'glm-5.3' },
  ],
  architect: [
    { provider: 'glm', model: 'glm-5.3' },
    { provider: 'deepseek', model: 'deepseek-v4-pro' },
  ],
};

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: unknown[];
  toolCallId?: string;
}

export interface NormalizedChatRequest {
  model?: string;
  taskCategory?: TaskCategory;
  routingProfileId?: string;
  messages: ChatMessage[];
  tools?: unknown[];
  toolChoice?: unknown;
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
  userId: string;
  apiKeyId?: string;
  idempotencyKey?: string;
  /** RTK-style in-gateway optimisation toggle; default ON for noisy output. */
  rtk?: boolean;
  optimize?: boolean;
}

export interface NormalizedChatResponse {
  id: string;
  model: string;
  provider: string;
  choices: Array<{
    message: { role: string; content: string; toolCalls?: unknown[] };
    finishReason: string;
  }>;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  latencyMs: number;
  /** Tokens saved by in-gateway RTK optimisation (recorded on UsageRecord). */
  tokensSaved?: number;
  /** Ordered chain that was attempted, and which entry actually served. */
  attemptedChain?: ModelChainEntry[];
}

export type UserStatus = 'ACTIVE' | 'SUSPENDED';
export type RoleName = 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'USER' | 'VIEWER';

export const FALLBACK_TRIGGERS = ['429', '5XX', 'TIMEOUT', 'UNAVAILABLE'] as const;
export type FallbackTrigger = (typeof FALLBACK_TRIGGERS)[number];
