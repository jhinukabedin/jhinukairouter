// Routing module types — LOCAL definitions.
// NOTE (contract deviation to flag): packages/shared does not exist yet
// (Builder 1 has not delivered it), so TaskCategory / RoutingMode /
// NormalizedChatRequest are defined here per CONTRACT.md and must be
// replaced with imports from packages/shared once it lands.
export type TaskCategory =
  | 'GENERAL' | 'SIMPLE_QUESTION' | 'CODE_GENERATION' | 'SMALL_CODE_FIX'
  | 'COMPLEX_DEBUGGING' | 'ARCHITECTURE' | 'PLANNING' | 'REASONING'
  | 'DATA_ANALYSIS' | 'LONG_CONTEXT' | 'VISION' | 'TOOL_CALLING';

export type RoutingMode = 'AUTOMATIC' | 'MANUAL' | 'HYBRID';

export type AgentRole = 'coordinator' | 'fast' | 'coder' | 'developer' | 'reasoner' | 'architect';

/** One step in an ordered per-agent / per-task fallback chain. */
export interface ChainEntry {
  provider: string;
  model: string;
  /** 0-based priority; lower runs first. */
  order: number;
  enabled?: boolean;
}

export interface RoutingProfile {
  id: string;
  userId: string;
  name: string;
  mode: RoutingMode;
  defaultProviderId?: string | null;
  defaultModelId?: string | null;
  /** taskCategory -> ordered chain of (provider, model). */
  taskMapping: Partial<Record<TaskCategory, ChainEntry[]>>;
  /** agentRole -> ordered chain (OpenCode agent aliases). */
  agentMapping?: Partial<Record<AgentRole, ChainEntry[]>>;
  preferredProviderId?: string | null;
  excludedModelIds?: string[];
  fallbackModelIds?: string[];
  budgetDailyCredits?: number | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RoutingRule {
  id: string;
  profileId: string;
  taskCategory: TaskCategory;
  providerId?: string | null;
  modelId?: string | null;
  /** Ordered chain for this rule (per-agent multi-model fallback). */
  chain?: ChainEntry[];
  priority: number;
  createdAt: string;
}

export type FallbackTrigger = '429' | '5XX' | 'TIMEOUT' | 'UNAVAILABLE';

export interface FallbackRule {
  id: string;
  userId?: string | null;
  profileId?: string | null;
  fromModelId?: string | null;
  toModelId: string;
  trigger: FallbackTrigger;
  order: number;
  createdAt: string;
}

export interface NormalizedChatRequestLike {
  model?: string;
  taskCategory?: TaskCategory;
  routingProfileId?: string;
  agentRole?: AgentRole;
  messages: { role: string; content: string; toolCalls?: unknown[] }[];
  tools?: unknown[];
  stream?: boolean;
  userId: string;
  apiKeyId?: string;
  idempotencyKey?: string;
  /** RTK-style optimisation toggle; default true. */
  rtk?: boolean;
}

export interface RoutingDecision {
  mode: RoutingMode;
  taskCategory: TaskCategory;
  chain: ChainEntry[];
  /** Why this chain was chosen (audit-friendly). */
  reason: string;
  profileId?: string;
}

/** Default task mapping from CONTRACT.md (seed only; configurable per profile). */
export const DEFAULT_TASK_MAPPING: Record<TaskCategory, ChainEntry> = {
  GENERAL: { provider: 'tokens', model: 'gpt-6-luna', order: 0 },
  SIMPLE_QUESTION: { provider: 'gemini', model: 'gemini-flash', order: 0 },
  SMALL_CODE_FIX: { provider: 'deepseek', model: 'deepseek-flash', order: 0 },
  CODE_GENERATION: { provider: 'moonshot', model: 'kimi-k2.7-code', order: 0 },
  COMPLEX_DEBUGGING: { provider: 'deepseek', model: 'deepseek-v4-pro', order: 0 },
  ARCHITECTURE: { provider: 'glm', model: 'glm-5.3', order: 0 },
  PLANNING: { provider: 'tokens', model: 'gpt-6-luna', order: 0 },
  REASONING: { provider: 'deepseek', model: 'deepseek-v4-pro', order: 0 },
  DATA_ANALYSIS: { provider: 'tokens', model: 'gpt-6-luna', order: 0 },
  LONG_CONTEXT: { provider: 'moonshot', model: 'kimi-k2.7-code', order: 0 },
  VISION: { provider: 'gemini', model: 'gemini-flash', order: 0 },
  TOOL_CALLING: { provider: 'tokens', model: 'gpt-6-luna', order: 0 },
};

export const TASK_CATEGORIES: TaskCategory[] = Object.keys(DEFAULT_TASK_MAPPING) as TaskCategory[];
export const AGENT_ROLES: AgentRole[] = ['coordinator', 'fast', 'coder', 'developer', 'reasoner', 'architect'];
