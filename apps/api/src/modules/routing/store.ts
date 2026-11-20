// In-memory RoutingStore — used by tests and as the light local-dev fallback.
// Production wires the Prisma-backed store (Builder 1) behind the same interface.
import type { FallbackRule, RoutingProfile, RoutingRule } from './types.js';
import type { RoutingStore } from './service.js';

export class InMemoryRoutingStore implements RoutingStore {
  profiles = new Map<string, RoutingProfile>();
  rules = new Map<string, RoutingRule>();
  fallbackRules = new Map<string, FallbackRule>();

  async createProfile(p: RoutingProfile) { this.profiles.set(p.id, p); return p; }
  async getProfile(id: string, userId: string) {
    const p = this.profiles.get(id);
    return p && p.userId === userId ? p : null;
  }
  async listProfiles(userId: string) { return [...this.profiles.values()].filter((p) => p.userId === userId); }
  async updateProfile(id: string, userId: string, patch: Partial<RoutingProfile>) {
    const p = await this.getProfile(id, userId);
    if (!p) return null;
    const next = { ...p, ...patch };
    this.profiles.set(id, next);
    return next;
  }
  async deleteProfile(id: string, userId: string) {
    const p = await this.getProfile(id, userId);
    if (!p) return false;
    this.profiles.delete(id);
    return true;
  }
  async createRule(r: RoutingRule) { this.rules.set(r.id, r); return r; }
  async listRules(profileId: string) { return [...this.rules.values()].filter((r) => r.profileId === profileId); }
  async deleteRule(id: string, profileId: string) {
    const r = this.rules.get(id);
    if (!r || r.profileId !== profileId) return false;
    this.rules.delete(id);
    return true;
  }
  async createFallbackRule(r: FallbackRule) { this.fallbackRules.set(r.id, r); return r; }
  async listFallbackRules(userId: string) {
    return [...this.fallbackRules.values()].filter((r) => !r.userId || r.userId === userId);
  }
  async deleteFallbackRule(id: string, userId: string) {
    const r = this.fallbackRules.get(id);
    if (!r || (r.userId && r.userId !== userId)) return false;
    this.fallbackRules.delete(id);
    return true;
  }
}
