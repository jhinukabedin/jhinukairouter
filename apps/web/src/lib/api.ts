// Typed fetch client for the Jhinuk AI Router API (see CONTRACT.md).
// Base URL: same origin in production (VITE_API_URL unset), Vite proxy to
// http://localhost:3001 in dev. Session token lives in sessionStorage only —
// provider credentials and full router keys are NEVER stored here.
import type { ChainEntry } from './chain';

const API_BASE = import.meta.env.VITE_API_URL ?? '';
export const GATEWAY_PROD_URL = 'https://router.developersbd.top/v1';
export const GATEWAY_LOCAL_URL = 'http://localhost:3001/v1';

const TOKEN_KEY = 'jar_session_token';

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}
export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  // Only claim JSON when a body is actually sent. A body-less POST/DELETE
  // with Content-Type: application/json makes Fastify's JSON parser reject
  // the empty body (0.1.4: that is what broke Test / Sync Models / logout).
  const hasBody = init.body !== undefined && init.body !== null;
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 204) return undefined as T;
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    // The API returns errors as { error: { code, message } }; older shapes
    // used a top-level message. Read both so the real reason shows instead
    // of a bare "Request failed (401)".
    const errObj = body && typeof body === 'object' ? (body as { error?: unknown; message?: unknown }) : null;
    const nested =
      errObj?.error && typeof errObj.error === 'object' && typeof (errObj.error as { message?: unknown }).message === 'string'
        ? (errObj.error as { message: string }).message
        : null;
    const msg =
      (typeof errObj?.message === 'string' ? errObj.message : null) ?? nested ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return body as T;
}

const get = <T,>(p: string) => request<T>(p);
const post = <T,>(p: string, data?: unknown) =>
  request<T>(p, { method: 'POST', body: data === undefined ? undefined : JSON.stringify(data) });
const patch = <T,>(p: string, data: unknown) => request<T>(p, { method: 'PATCH', body: JSON.stringify(data) });
const del = <T,>(p: string) => request<T>(p, { method: 'DELETE' });

// ---------------------------------------------------------------- types
export type TaskCategory =
  | 'GENERAL' | 'SIMPLE_QUESTION' | 'CODE_GENERATION' | 'SMALL_CODE_FIX'
  | 'COMPLEX_DEBUGGING' | 'ARCHITECTURE' | 'PLANNING' | 'REASONING'
  | 'DATA_ANALYSIS' | 'LONG_CONTEXT' | 'VISION' | 'TOOL_CALLING';
export type RoutingMode = 'AUTOMATIC' | 'MANUAL' | 'HYBRID';
export type TaskMapping = Record<string, ChainEntry[] | string | unknown>;

export interface User {
  id: string; email: string; name?: string | null; status: 'ACTIVE' | 'SUSPENDED'; createdAt: string;
}
export interface SessionItem {
  id: string; userAgent?: string | null; ip?: string | null; expiresAt: string; createdAt?: string;
}
export interface Provider {
  id: string; name: string; type: string; baseUrl: string; protocol: 'openai' | 'anthropic';
  enabled: boolean; isGlobal: boolean; ownerId?: string | null; priority: number; timeoutMs: number; createdAt: string;
}
export interface ModelPricing { inputPricePer1M: number; outputPricePer1M: number; currency: string }
export interface AIModel {
  id: string; providerId: string; provider?: Provider | null; modelId: string; displayName: string;
  contextWindow: number; maxOutputTokens: number; supportsStreaming: boolean; supportsTools: boolean;
  supportsVision: boolean; supportsReasoning: boolean; enabled: boolean; pricing?: ModelPricing | null;
}
export interface ApiKeyItem {
  id: string; name: string; keyPrefix: string; expiresAt?: string | null; lastUsedAt?: string | null;
  revokedAt?: string | null; createdAt: string;
  /** Full key — returned ONLY at creation / regeneration. Never stored. */
  key?: string;
}
export interface RoutingProfile {
  id: string; userId: string; name: string; mode: RoutingMode;
  defaultProviderId?: string | null; defaultModelId?: string | null;
  taskMapping: TaskMapping; preferredProviderId?: string | null;
  excludedModelIds?: unknown; fallbackModelIds?: unknown; budgetDailyCredits?: number | null; isDefault: boolean;
}
export interface FallbackRule {
  id: string; userId?: string | null; profileId?: string | null; fromModelId?: string | null;
  toModelId: string; trigger: '429' | '5XX' | 'TIMEOUT' | 'UNAVAILABLE'; order: number;
}
export interface UsageRecord {
  id: string; requestId: string; userId?: string; apiKeyId?: string | null;
  provider: string; model: string; routingMode?: string; taskCategory?: string | null;
  inputTokens: number; outputTokens: number; cachedTokens: number; tokensSaved?: number;
  estimatedCost: number; platformCharge: number; latencyMs: number;
  status: 'SUCCESS' | 'FAILED'; createdAt: string;
}
export interface UsageSummary {
  totalRequests: number; routedRequests: number; inputTokens: number; outputTokens: number;
  cachedTokens: number; tokensSaved: number; estimatedCost: number; platformCharge: number;
  errorRate: number; avgLatencyMs: number;
  byUser?: { userId: string; email?: string; requests: number; cost: number }[];
  byApiKey?: { apiKeyId: string; name?: string; requests: number; cost: number }[];
  byModel?: { model: string; requests: number; inputTokens: number; outputTokens: number; cost: number }[];
  byProvider?: { provider: string; requests: number; cost: number }[];
  daily?: { date: string; requests: number; inputTokens: number; outputTokens: number; cost: number }[];
}
export interface CreditWallet { balance: number; currency: string }
export interface CreditTransaction {
  id: string; amount: number; type: 'PURCHASE' | 'DEBIT' | 'REFUND' | 'ADJUSTMENT';
  idempotencyKey: string; requestId?: string | null; description?: string | null; createdAt: string;
}
export interface AuditLog {
  id: string; userId?: string | null; action: string; resource: string; resourceId?: string | null;
  meta?: unknown; ip?: string | null; createdAt: string;
}
export interface SystemSetting { key: string; value: unknown; updatedBy?: string | null }
export interface HealthStatus {
  status: string; uptimeSec?: number; db?: string; redis?: string; version?: string;
}
export interface ProviderHealthItem {
  providerId: string; providerName?: string; status: 'UP' | 'DEGRADED' | 'DOWN';
  lastLatencyMs?: number | null; lastErrorRate?: number | null; lastCheckedAt?: string | null;
  consecutiveFailures: number; cooldownUntil?: string | null;
}
export interface Paged<T> { data: T[]; total: number; page: number; limit: number }

export function normalizePaged<T>(body: unknown): Paged<T> {
  if (Array.isArray(body)) return { data: body as T[], total: body.length, page: 1, limit: body.length };
  const b = (body ?? {}) as { data?: T[]; items?: T[]; logs?: T[]; rows?: T[]; total?: number; page?: number; limit?: number };
  const data = b.data ?? b.items ?? b.logs ?? b.rows ?? [];
  return { data, total: b.total ?? data.length, page: b.page ?? 1, limit: b.limit ?? data.length };
}

/** Single-object endpoints wrap the value as { data: ... }; pass bare values through. */
export function unwrapData<T>(body: unknown): T {
  const b = (body ?? {}) as { data?: T };
  return (b.data ?? body) as T;
}

/** List endpoints that wrap the array under a named key ({ apiKeys, sessions, users }). */
export function unwrapKey<T>(body: unknown, key: string): T[] {
  if (Array.isArray(body)) return body as T[];
  const v = (body ?? {}) as Record<string, unknown>;
  return Array.isArray(v[key]) ? (v[key] as T[]) : [];
}

// ---------------------------------------------------------------- auth
export const api = {
  register: (data: { email: string; password: string; name?: string }) =>
    post<{ user: User; token: string }>('/api/v1/auth/register', data),
  login: (data: { email: string; password: string; totpCode?: string }) =>
    post<{ user: User; token: string }>('/api/v1/auth/login', data),
  logout: () => post('/api/v1/auth/logout'),
  me: () => get<User>('/api/v1/users/me'),
  sessions: () => get('/api/v1/auth/sessions').then((b) => unwrapKey<SessionItem>(b, 'sessions')),
  revokeSession: (id: string) => del(`/api/v1/auth/sessions/${id}`),
  totpSetup: () => post<{ secret: string; qrUrl?: string }>('/api/v1/auth/totp/setup'),
  totpVerify: (code: string) => post('/api/v1/auth/totp/verify', { code }),
  passwordResetRequest: (email: string) => post('/api/v1/auth/password-reset/request', { email }),
  passwordResetConfirm: (token: string, password: string) =>
    post('/api/v1/auth/password-reset/confirm', { token, password }),

  registrationStatus: () => get<{ registrationEnabled: boolean }>('/api/v1/auth/registration-status'),

  // ------------------------------------------------------------ providers
  // The API wraps these as { data: ... }; unwrap here so pages get arrays/objects.
  listProviders: () => get('/api/v1/providers').then((b) => normalizePaged<Provider>(b).data),
  createProvider: (data: {
    name: string; type: string; baseUrl: string; protocol: 'openai' | 'anthropic';
    apiKey?: string; enabled?: boolean; priority?: number; timeoutMs?: number;
  }) => post('/api/v1/providers', data).then((b) => unwrapData<Provider>(b)),
  updateProvider: (id: string, data: Partial<Provider> & { apiKey?: string }) =>
    patch(`/api/v1/providers/${id}`, data).then((b) => unwrapData<Provider>(b)),
  deleteProvider: (id: string) => del(`/api/v1/providers/${id}`),
  testProvider: (id: string) => post(`/api/v1/providers/${id}/test`).then((b) => unwrapData<{ ok: boolean; latencyMs?: number; error?: string }>(b)),
  syncProviderModels: (id: string) => post(`/api/v1/providers/${id}/sync-models`).then((b) => unwrapData<{ synced: number; models: string[] }>(b)),

  // --------------------------------------------------------------- models
  listModels: () => get('/api/v1/models').then((b) => normalizePaged<AIModel>(b).data),
  updateModel: (id: string, data: Partial<AIModel> & { pricing?: Partial<ModelPricing> }) =>
    patch(`/api/v1/models/${id}`, data).then((b) => unwrapData<AIModel>(b)),
  createModel: (data: {
    providerId: string; modelId: string; displayName?: string; contextWindow?: number;
    maxOutputTokens?: number; supportsStreaming?: boolean; supportsTools?: boolean;
    supportsVision?: boolean; supportsReasoning?: boolean; enabled?: boolean;
    inputPricePer1M?: number; outputPricePer1M?: number; currency?: string;
  }) => post('/api/v1/models', data).then((b) => unwrapData<AIModel>(b)),

  // ------------------------------------------------------------- api keys
  listApiKeys: () => get('/api/v1/api-keys').then((b) => unwrapKey<ApiKeyItem>(b, 'apiKeys')),
  createApiKey: (data: { name: string; expiresAt?: string }) => post<ApiKeyItem>('/api/v1/api-keys', data),
  deleteApiKey: (id: string) => del(`/api/v1/api-keys/${id}`),
  regenerateApiKey: (id: string) => post<ApiKeyItem>(`/api/v1/api-keys/${id}/regenerate`),

  // ------------------------------------------------------- routing profiles
  listProfiles: () => get<RoutingProfile[]>('/api/v1/routing-profiles'),
  createProfile: (data: Partial<RoutingProfile>) => post<RoutingProfile>('/api/v1/routing-profiles', data),
  updateProfile: (id: string, data: Partial<RoutingProfile>) =>
    patch<RoutingProfile>(`/api/v1/routing-profiles/${id}`, data),
  deleteProfile: (id: string) => del(`/api/v1/routing-profiles/${id}`),
  listFallbackRules: () => get<FallbackRule[]>('/api/v1/fallback-rules'),
  createFallbackRule: (data: Partial<FallbackRule>) => post<FallbackRule>('/api/v1/fallback-rules', data),
  deleteFallbackRule: (id: string) => del(`/api/v1/fallback-rules/${id}`),

  // ------------------------------------------------------------ usage/billing
  usageSummary: (params: Record<string, string>) => {
    const q = new URLSearchParams(params).toString();
    return get<UsageSummary>(`/api/v1/usage/summary${q ? `?${q}` : ''}`);
  },
  usageList: (params: Record<string, string>) => {
    const q = new URLSearchParams(params).toString();
    return get<Paged<UsageRecord> | UsageRecord[]>(`/api/v1/usage${q ? `?${q}` : ''}`);
  },
  wallet: () => get<CreditWallet>('/api/v1/credits/wallet'),
  transactions: (params: Record<string, string> = {}) => {
    const q = new URLSearchParams(params).toString();
    return get<Paged<CreditTransaction> | CreditTransaction[]>(`/api/v1/credits/transactions${q ? `?${q}` : ''}`);
  },
  adjustCredits: (data: { userId: string; amount: number; description?: string }) =>
    // The API requires `targetUserId` and an `idempotencyKey`; the page
    // passes the user's id as `userId`, so map it here and mint a key
    // per submission (without it the API 400s on every adjust).
    post('/api/v1/credits/adjust', {
      targetUserId: data.userId,
      amount: data.amount,
      idempotencyKey: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      description: data.description,
    }),

  // ---------------------------------------------------------------- admin
  adminUsers: () => get('/api/v1/admin/users').then((b) => unwrapKey<User & { roles?: string[] }>(b, 'users')),
  adminCreateUser: (data: { email: string; password: string; name?: string; roles?: string[] }) =>
    post<User>('/api/v1/admin/users', data),
  adminUpdateUser: (id: string, data: Partial<User> & { roles?: string[] }) =>
    patch<User>(`/api/v1/admin/users/${id}`, data),
  adminSuspendUser: (id: string) => post(`/api/v1/admin/users/${id}/suspend`),
  adminActivateUser: (id: string) => post(`/api/v1/admin/users/${id}/activate`),
  auditLogs: (params: Record<string, string> = {}) => {
    const q = new URLSearchParams(params).toString();
    return get<Paged<AuditLog> | AuditLog[]>(`/api/v1/admin/audit-logs${q ? `?${q}` : ''}`);
  },
  // The API returns { settings: { key: value } }; the pages want an array.
  systemSettings: async () => {
    const res = await get<{ settings: Record<string, unknown> }>('/api/v1/admin/system-settings');
    return Object.entries(res.settings ?? {}).map(([key, value]) => ({ key, value }));
  },
  // The API expects { settings: { key: value } } (PATCH), not { key, value }.
  updateSystemSetting: (key: string, value: unknown) =>
    patch(`/api/v1/admin/system-settings`, { settings: { [key]: value } }),
  providerHealth: () => get<ProviderHealthItem[]>('/api/v1/admin/provider-health'),
  health: () => get<HealthStatus>('/health'),
  healthReady: () => get<HealthStatus>('/health/ready'),
};

/** Test a gateway base URL + router API key directly (ClientSetup wizard).
 *  Returns the model list the gateway reports, or throws with a plain message. */
export async function testGatewayConnection(baseUrl: string, key: string): Promise<string[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`Gateway replied ${res.status} — check the base URL and API key.`);
  const body = (await res.json()) as { data?: { id: string }[] };
  return (body.data ?? []).map((m) => m.id);
}

/** Minimal gateway chat test through the dashboard session (RoutingProfiles "Test chain").
 *  Sends one tiny prompt; the router picks the chain's first available model. */
export async function testGatewayChat(model: string, prompt = 'Reply with the single word: ok'): Promise<{ model: string; provider: string; content: string }> {
  const res = await fetch(`${API_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
    },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], maxTokens: 16 }),
  });
  if (!res.ok) throw new Error(`Gateway chat test failed (${res.status}).`);
  const body = (await res.json()) as {
    model: string; provider: string;
    choices: { message: { content: string } }[];
  };
  return { model: body.model, provider: body.provider, content: body.choices?.[0]?.message?.content ?? '' };
}
