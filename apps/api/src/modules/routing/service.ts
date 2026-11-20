// Routing service: profile CRUD + chain management + routing decision.
// Storage is injected via a store interface so tests run with an in-memory
// store and production uses Prisma (Builder 1) without changing this code.
import { randomUUID } from 'node:crypto';
import { classifyRequest } from './classifier.js';
import { moveChainEntry, sortChain } from './chain.js';
import type { ProviderHealthTracker } from './health.js';
import {
  DEFAULT_TASK_MAPPING, type AgentRole, type ChainEntry, type FallbackRule,
  type FallbackTrigger, type NormalizedChatRequestLike, type RoutingDecision,
  type RoutingProfile, type RoutingRule, type TaskCategory,
} from './types.js';

export interface RoutingStore {
  createProfile(p: RoutingProfile): Promise<RoutingProfile>;
  getProfile(id: string, userId: string): Promise<RoutingProfile | null>;
  listProfiles(userId: string): Promise<RoutingProfile[]>;
  updateProfile(id: string, userId: string, patch: Partial<RoutingProfile>): Promise<RoutingProfile | null>;
  deleteProfile(id: string, userId: string): Promise<boolean>;
  createRule(r: RoutingRule): Promise<RoutingRule>;
  listRules(profileId: string): Promise<RoutingRule[]>;
  deleteRule(id: string, profileId: string): Promise<boolean>;
  createFallbackRule(r: FallbackRule): Promise<FallbackRule>;
  listFallbackRules(userId: string): Promise<FallbackRule[]>;
  deleteFallbackRule(id: string, userId: string): Promise<boolean>;
}

export interface RoutingServiceOptions {
  store: RoutingStore;
  health?: ProviderHealthTracker;
  /** Returns true when a (provider, model) is enabled + exists. Default: true. */
  isModelAvailable?: (provider: string, model: string) => Promise<boolean> | boolean;
  /** Pre-request budget/access gate. Throw to block; default: allow. */
  checkAccess?: (req: NormalizedChatRequestLike, decision: RoutingDecision) => Promise<void> | void;
}

const nowIso = () => new Date().toISOString();

/** A chain's array position IS its priority — re-index so stale `order`
 *  fields can never undo an explicit ordering supplied by a client. */
function normalizeChain(chain: ChainEntry[]): ChainEntry[] {
  return chain.map((e, i) => ({ ...e, order: i }));
}
function normalizeMapping<T extends Record<string, ChainEntry[] | undefined>>(mapping: T | undefined): T | undefined {
  if (!mapping) return mapping;
  const out = { ...mapping } as Record<string, ChainEntry[]>;
  for (const k of Object.keys(out)) if (Array.isArray(out[k])) out[k] = normalizeChain(out[k]);
  return out as T;
}

export class RoutingService {
  constructor(private opts: RoutingServiceOptions) {}

  // ---- Profiles ----
  async createProfile(userId: string, input: Omit<RoutingProfile, 'id' | 'userId' | 'createdAt' | 'updatedAt'>): Promise<RoutingProfile> {
    const profile: RoutingProfile = {
      ...input,
      taskMapping: normalizeMapping(input.taskMapping) ?? {},
      agentMapping: normalizeMapping(input.agentMapping),
      id: randomUUID(), userId, createdAt: nowIso(), updatedAt: nowIso(),
    };
    return this.opts.store.createProfile(profile);
  }
  getProfile(id: string, userId: string) { return this.opts.store.getProfile(id, userId); }
  listProfiles(userId: string) { return this.opts.store.listProfiles(userId); }
  async updateProfile(id: string, userId: string, patch: Partial<RoutingProfile>) {
    const normalized: Partial<RoutingProfile> = { ...patch, updatedAt: nowIso() };
    if (patch.taskMapping) normalized.taskMapping = normalizeMapping(patch.taskMapping);
    if (patch.agentMapping) normalized.agentMapping = normalizeMapping(patch.agentMapping);
    return this.opts.store.updateProfile(id, userId, normalized);
  }
  deleteProfile(id: string, userId: string) { return this.opts.store.deleteProfile(id, userId); }

  // ---- Rules ----
  async createRule(profileId: string, input: Omit<RoutingRule, 'id' | 'profileId' | 'createdAt'>): Promise<RoutingRule> {
    return this.opts.store.createRule({ ...input, id: randomUUID(), profileId, createdAt: nowIso() });
  }
  listRules(profileId: string) { return this.opts.store.listRules(profileId); }
  deleteRule(id: string, profileId: string) { return this.opts.store.deleteRule(id, profileId); }

  // ---- Fallback rules ----
  async createFallbackRule(userId: string, input: Omit<FallbackRule, 'id' | 'userId' | 'createdAt'>): Promise<FallbackRule> {
    return this.opts.store.createFallbackRule({ ...input, id: randomUUID(), userId, createdAt: nowIso() });
  }
  listFallbackRules(userId: string) { return this.opts.store.listFallbackRules(userId); }
  deleteFallbackRule(id: string, userId: string) { return this.opts.store.deleteFallbackRule(id, userId); }

  // ---- Per-agent / per-task chain management ----
  async setTaskChain(profileId: string, userId: string, category: TaskCategory, chain: ChainEntry[]): Promise<RoutingProfile | null> {
    const profile = await this.opts.store.getProfile(profileId, userId);
    if (!profile) return null;
    const taskMapping = { ...profile.taskMapping, [category]: chain.map((e, i) => ({ ...e, order: i })) };
    return this.opts.store.updateProfile(profileId, userId, { taskMapping, updatedAt: nowIso() });
  }

  async addChainEntry(profileId: string, userId: string, category: TaskCategory, entry: Omit<ChainEntry, 'order'> & { order?: number }): Promise<RoutingProfile | null> {
    const profile = await this.opts.store.getProfile(profileId, userId);
    if (!profile) return null;
    const chain = [...(profile.taskMapping[category] ?? [])];
    chain.push({ ...entry, order: entry.order ?? chain.length });
    return this.setTaskChain(profileId, userId, category, chain);
  }

  async removeChainEntry(profileId: string, userId: string, category: TaskCategory, index: number): Promise<RoutingProfile | null> {
    const profile = await this.opts.store.getProfile(profileId, userId);
    if (!profile) return null;
    const chain = (profile.taskMapping[category] ?? []).filter((_, i) => i !== index);
    return this.setTaskChain(profileId, userId, category, chain);
  }

  async moveChainEntry(profileId: string, userId: string, category: TaskCategory, index: number, direction: 'up' | 'down'): Promise<RoutingProfile | null> {
    const profile = await this.opts.store.getProfile(profileId, userId);
    if (!profile) return null;
    return this.setTaskChain(profileId, userId, category, moveChainEntry(profile.taskMapping[category] ?? [], index, direction));
  }

  async setAgentChain(profileId: string, userId: string, role: AgentRole, chain: ChainEntry[]): Promise<RoutingProfile | null> {
    const profile = await this.opts.store.getProfile(profileId, userId);
    if (!profile) return null;
    const agentMapping = { ...(profile.agentMapping ?? {}), [role]: chain.map((e, i) => ({ ...e, order: i })) };
    return this.opts.store.updateProfile(profileId, userId, { agentMapping, updatedAt: nowIso() });
  }

  // ---- Routing decision ----
  async resolve(req: NormalizedChatRequestLike): Promise<RoutingDecision> {
    const profile = req.routingProfileId
      ? await this.opts.store.getProfile(req.routingProfileId, req.userId)
      : (await this.opts.store.listProfiles(req.userId)).find((p) => p.isDefault) ?? null;
    const mode = profile?.mode ?? 'AUTOMATIC';

    // MANUAL: explicit model bypasses classification, still respects budgets/access.
    if (mode === 'MANUAL') {
      const model = req.model ?? profile?.defaultModelId ?? DEFAULT_TASK_MAPPING.GENERAL.model;
      const provider = profile?.defaultProviderId ?? DEFAULT_TASK_MAPPING.GENERAL.provider;
      const decision: RoutingDecision = {
        mode, taskCategory: req.taskCategory ?? 'GENERAL',
        chain: [{ provider, model, order: 0 }],
        reason: 'manual-override', profileId: profile?.id,
      };
      await this.opts.checkAccess?.(req, decision);
      return decision;
    }

    const classification = await classifyRequest(req);
    const category = classification.category;

    // Agent-role chain wins in HYBRID/AUTOMATIC when the request names a role.
    let chain: ChainEntry[] = [];
    let reason = `classified:${classification.matchedRule}`;
    if (req.agentRole && profile?.agentMapping?.[req.agentRole]?.length) {
      chain = [...profile.agentMapping[req.agentRole]!];
      reason = `agent-chain:${req.agentRole}`;
    } else if (profile?.taskMapping[category]?.length) {
      chain = [...profile.taskMapping[category]!];
      reason = `profile-task:${category}`;
    } else {
      // Rule rows (RoutingRule.chain) as a secondary source.
      const rules = profile ? await this.opts.store.listRules(profile.id) : [];
      const rule = rules.filter((r) => r.taskCategory === category).sort((a, b) => a.priority - b.priority)[0];
      if (rule?.chain?.length) { chain = [...rule.chain]; reason = `rule:${rule.id}`; }
      else if (rule?.modelId) { chain = [{ provider: rule.providerId ?? 'tokens', model: rule.modelId, order: 0 }]; reason = `rule:${rule.id}`; }
      else { chain = [DEFAULT_TASK_MAPPING[category]]; reason = `default-mapping:${category}`; }
    }

    if (mode === 'HYBRID' && profile) {
      // Preferred provider first, exclusions removed, profile fallback appended.
      const preferred = profile.preferredProviderId;
      if (preferred) {
        const rank = (e: ChainEntry) => (e.provider === preferred ? 0 : 1);
        chain = [...chain].sort((a, b) => rank(a) - rank(b));
      }
      if (profile.excludedModelIds?.length) {
        chain = chain.filter((e) => !profile.excludedModelIds!.includes(e.model));
      }
      for (const fb of profile.fallbackModelIds ?? []) {
        if (!chain.some((e) => e.model === fb)) chain.push({ provider: profile.defaultProviderId ?? 'tokens', model: fb, order: chain.length });
      }
      reason += '+hybrid';
    }

    // Skip unavailable / disabled / unhealthy entries, PRESERVING the
    // chain's current order; never assume a model exists.
    const filtered: ChainEntry[] = [];
    for (const entry of chain) {
      if (entry.enabled === false) continue;
      if (this.opts.health && !this.opts.health.isAvailable(entry.provider)) continue;
      if (this.opts.isModelAvailable && !(await this.opts.isModelAvailable(entry.provider, entry.model))) continue;
      filtered.push(entry);
    }
    const finalChain = filtered.length ? filtered : chain.slice(0, 1);
    if (!finalChain.length) throw new Error('no routable model available for this request');
    const decision: RoutingDecision = { mode, taskCategory: category, chain: finalChain, reason, profileId: profile?.id };
    await this.opts.checkAccess?.(req, decision);
    return decision;
  }
}

export type { FallbackTrigger };
