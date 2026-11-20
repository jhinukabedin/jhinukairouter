// Seed data from CONTRACT.md — defaults only. The API is the source of truth:
// pickers list models returned by GET /api/v1/models first and fall back to
// these seeds only when the API is unreachable or a model is not yet added.
import type { ChainEntry } from './chain';

export interface ProviderPreset {
  type: string; label: string; baseUrl: string; protocol: 'openai' | 'anthropic';
}
export const PROVIDER_PRESETS: ProviderPreset[] = [
  { type: 'tokens', label: 'Tokens.bd', baseUrl: 'https://tokens.bd/v1', protocol: 'openai' },
  { type: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', protocol: 'openai' },
  { type: 'moonshot', label: 'Kimi / Moonshot', baseUrl: 'https://api.moonshot.ai/v1', protocol: 'openai' },
  { type: 'glm', label: 'GLM (Zhipu)', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', protocol: 'openai' },
  { type: 'gemini', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', protocol: 'openai' },
  { type: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', protocol: 'openai' },
  { type: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', protocol: 'anthropic' },
  { type: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', protocol: 'openai' },
  { type: 'ollama', label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', protocol: 'openai' },
  { type: 'custom', label: 'Custom (OpenAI-compatible)', baseUrl: '', protocol: 'openai' },
];

export interface SeedModel { provider: string; model: string; displayName: string }
export const SEED_MODELS: SeedModel[] = [
  { provider: 'tokens', model: 'gpt-6-luna', displayName: 'Luna (Tokens)' },
  { provider: 'deepseek', model: 'deepseek-flash', displayName: 'DeepSeek V4.1 Flash' },
  { provider: 'deepseek', model: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro' },
  { provider: 'moonshot', model: 'kimi-k2.7-code', displayName: 'Kimi K2.7 Code' },
  { provider: 'glm', model: 'glm-5.3', displayName: 'GLM-5.3' },
  { provider: 'gemini', model: 'gemini-flash', displayName: 'Gemini Flash' },
];

export function seedDisplayName(e: ChainEntry): string {
  const found = SEED_MODELS.find((m) => m.provider === e.provider && m.model === e.model);
  return found ? found.displayName : e.model;
}

/** Default task mapping seed from CONTRACT.md, extended to ordered chains. */
export const DEFAULT_CHAINS: Record<string, ChainEntry[]> = {
  GENERAL: [
    { provider: 'tokens', model: 'gpt-6-luna' },
    { provider: 'deepseek', model: 'deepseek-flash' },
    { provider: 'moonshot', model: 'kimi-k2.7-code' },
  ],
  SIMPLE_QUESTION: [
    { provider: 'gemini', model: 'gemini-flash' },
    { provider: 'tokens', model: 'gpt-6-luna' },
    { provider: 'deepseek', model: 'deepseek-flash' },
  ],
  CODE_GENERATION: [
    { provider: 'moonshot', model: 'kimi-k2.7-code' },
    { provider: 'deepseek', model: 'deepseek-v4-pro' },
    { provider: 'tokens', model: 'gpt-6-luna' },
  ],
  SMALL_CODE_FIX: [
    { provider: 'deepseek', model: 'deepseek-flash' },
    { provider: 'tokens', model: 'gpt-6-luna' },
    { provider: 'moonshot', model: 'kimi-k2.7-code' },
  ],
  COMPLEX_DEBUGGING: [
    { provider: 'deepseek', model: 'deepseek-v4-pro' },
    { provider: 'moonshot', model: 'kimi-k2.7-code' },
    { provider: 'glm', model: 'glm-5.3' },
  ],
  ARCHITECTURE: [
    { provider: 'glm', model: 'glm-5.3' },
    { provider: 'moonshot', model: 'kimi-k2.7-code' },
    { provider: 'deepseek', model: 'deepseek-v4-pro' },
  ],
  PLANNING: [
    { provider: 'glm', model: 'glm-5.3' },
    { provider: 'tokens', model: 'gpt-6-luna' },
  ],
  REASONING: [
    { provider: 'deepseek', model: 'deepseek-v4-pro' },
    { provider: 'glm', model: 'glm-5.3' },
    { provider: 'tokens', model: 'gpt-6-luna' },
  ],
  DATA_ANALYSIS: [
    { provider: 'tokens', model: 'gpt-6-luna' },
    { provider: 'deepseek', model: 'deepseek-v4-pro' },
  ],
  LONG_CONTEXT: [
    { provider: 'moonshot', model: 'kimi-k2.7-code' },
    { provider: 'glm', model: 'glm-5.3' },
  ],
  VISION: [
    { provider: 'gemini', model: 'gemini-flash' },
    { provider: 'tokens', model: 'gpt-6-luna' },
  ],
  TOOL_CALLING: [
    { provider: 'moonshot', model: 'kimi-k2.7-code' },
    { provider: 'deepseek', model: 'deepseek-flash' },
  ],
};

export interface AgentDef { id: string; label: string; task: string; description: string }
export const AGENTS: AgentDef[] = [
  { id: 'coordinator', label: 'Coordinator', task: 'GENERAL', description: 'Primary agent — plans, delegates, answers. Default chain: Luna → DeepSeek Flash → Kimi.' },
  { id: 'fast', label: 'Fast', task: 'SIMPLE_QUESTION', description: 'Quick answers and small lookups. Cheapest/fastest first.' },
  { id: 'coder', label: 'Coder', task: 'CODE_GENERATION', description: 'Writes new code. Kimi K2.7 Code first.' },
  { id: 'developer', label: 'Developer', task: 'COMPLEX_DEBUGGING', description: 'Hard debugging and large edits. DeepSeek V4 Pro first.' },
  { id: 'reasoner', label: 'Reasoner', task: 'REASONING', description: 'Deep reasoning, planning, analysis.' },
  { id: 'architect', label: 'Architect', task: 'ARCHITECTURE', description: 'System design and big-picture decisions. GLM-5.3 first.' },
];

export interface TaskDef { category: string; label: string; hint: string }
export const TASKS: TaskDef[] = [
  { category: 'GENERAL', label: 'General', hint: 'Default for anything unclassified' },
  { category: 'SIMPLE_QUESTION', label: 'Simple question', hint: 'Short factual answers' },
  { category: 'CODE_GENERATION', label: 'Code generation', hint: 'Write new code' },
  { category: 'SMALL_CODE_FIX', label: 'Small code fix', hint: 'Tiny edits and fixes' },
  { category: 'COMPLEX_DEBUGGING', label: 'Complex debugging', hint: 'Hard bugs, large context' },
  { category: 'ARCHITECTURE', label: 'Architecture', hint: 'Design and planning' },
  { category: 'PLANNING', label: 'Planning', hint: 'Task breakdown, roadmaps' },
  { category: 'REASONING', label: 'Reasoning', hint: 'Multi-step reasoning' },
  { category: 'DATA_ANALYSIS', label: 'Data analysis', hint: 'Analyse data, sheets, logs' },
  { category: 'LONG_CONTEXT', label: 'Long context', hint: 'Large files / long docs' },
  { category: 'VISION', label: 'Vision', hint: 'Images and screenshots' },
  { category: 'TOOL_CALLING', label: 'Tool calling', hint: 'Function/tool use' },
];

/** Router aliases: each alias IS the multi-model chain for one agent.
 *  Edit the chain once in Routing Profiles; every client using the alias picks it up. */
export const ROUTER_ALIASES = AGENTS.map((a) => ({
  alias: a.id,
  agent: a.label,
  task: a.task,
  chain: DEFAULT_CHAINS[a.task] ?? [],
}));
