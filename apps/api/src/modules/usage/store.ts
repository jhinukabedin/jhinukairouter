// In-memory UsageStore (tests + light local-dev fallback).
import type { UsageFilters, UsageRecord, UsageStore } from './service.js';

export class InMemoryUsageStore implements UsageStore {
  rows: UsageRecord[] = [];

  async create(record: UsageRecord): Promise<UsageRecord> {
    this.rows.push(record);
    return record;
  }

  private applyFilters(filters: UsageFilters): UsageRecord[] {
    return this.rows.filter((r) => {
      if (filters.userId && r.userId !== filters.userId) return false;
      if (filters.provider && r.provider !== filters.provider) return false;
      if (filters.model && r.model !== filters.model) return false;
      if (filters.apiKeyId && r.apiKeyId !== filters.apiKeyId) return false;
      if (filters.status && r.status !== filters.status) return false;
      if (filters.from && r.createdAt < filters.from) return false;
      if (filters.to && r.createdAt > filters.to) return false;
      return true;
    });
  }

  async list(filters: UsageFilters) {
    const all = this.applyFilters(filters);
    const offset = filters.offset ?? 0;
    const limit = filters.limit ?? 50;
    return { rows: all.slice(offset, offset + limit), total: all.length };
  }

  async listAll(filters: UsageFilters) {
    return this.applyFilters(filters);
  }
}
