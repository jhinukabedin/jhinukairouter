// Providers + models store interfaces (Builder 2 owns the module).
// The routes below depend ONLY on these interfaces — not on Prisma — so
// they run in tests with the in-memory implementation here and in
// production with a Prisma-backed implementation (Builder 1) that also
// AES-256-GCM-encrypts credentials. Credentials are NEVER returned by any
// read path: only a last-4 hint is exposed.

export type ProviderType =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'deepseek'
  | 'moonshot'
  | 'glm'
  | 'openrouter'
  | 'tokens'
  | 'ollama'
  | 'custom';

export type ProviderProtocol = 'openai' | 'anthropic';

export interface ProviderRecord {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  protocol: ProviderProtocol;
  enabled: boolean;
  isGlobal: boolean;
  ownerId: string | null;
  priority: number;
  timeoutMs: number;
  /** Sync only free models (OpenRouter: ids ending in `:free`). Default false. */
  freeOnly: boolean;
  /** Last 4 chars of the stored key, for display only. */
  keyHint: string | null;
  createdAt: string;
}

export interface ModelRecord {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
  enabled: boolean;
}

export interface ProviderStore {
  list(filter?: { type?: string; enabled?: boolean; ownerId?: string }): Promise<ProviderRecord[]>;
  get(id: string): Promise<ProviderRecord | null>;
  create(data: Omit<ProviderRecord, 'id' | 'createdAt'>): Promise<ProviderRecord>;
  update(id: string, patch: Partial<Omit<ProviderRecord, 'id' | 'createdAt'>>): Promise<ProviderRecord | null>;
  delete(id: string): Promise<boolean>;
  /** Write-only credential storage (encrypted at rest in production). */
  setCredential(providerId: string, credential: string): Promise<void>;
  getCredential(providerId: string): Promise<string | null>;
  deleteCredential(providerId: string): Promise<void>;
}

export interface ModelStore {
  list(filter?: { providerId?: string; enabled?: boolean }): Promise<ModelRecord[]>;
  get(id: string): Promise<ModelRecord | null>;
  getByProviderAndModel(providerId: string, modelId: string): Promise<ModelRecord | null>;
  create(data: Omit<ModelRecord, 'id'>): Promise<ModelRecord>;
  update(id: string, patch: Partial<Omit<ModelRecord, 'id' | 'providerId'>>): Promise<ModelRecord | null>;
  delete(id: string): Promise<boolean>;
  deleteByProvider(providerId: string): Promise<number>;
}

/** In-memory store for tests / local dev without a database. */
export class InMemoryProviderStore implements ProviderStore {
  private readonly providers = new Map<string, ProviderRecord>();
  private readonly credentials = new Map<string, string>();

  async list(filter: { type?: string; enabled?: boolean; ownerId?: string } = {}): Promise<ProviderRecord[]> {
    return [...this.providers.values()].filter(
      (p) =>
        (filter.type === undefined || p.type === filter.type) &&
        (filter.enabled === undefined || p.enabled === filter.enabled) &&
        (filter.ownerId === undefined || p.ownerId === filter.ownerId),
    );
  }

  async get(id: string): Promise<ProviderRecord | null> {
    return this.providers.get(id) ?? null;
  }

  async create(data: Omit<ProviderRecord, 'id' | 'createdAt'>): Promise<ProviderRecord> {
    const record: ProviderRecord = { ...data, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
    this.providers.set(record.id, record);
    return record;
  }

  async update(
    id: string,
    patch: Partial<Omit<ProviderRecord, 'id' | 'createdAt'>>,
  ): Promise<ProviderRecord | null> {
    const existing = this.providers.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch };
    this.providers.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    this.credentials.delete(id);
    return this.providers.delete(id);
  }

  async setCredential(providerId: string, credential: string): Promise<void> {
    this.credentials.set(providerId, credential);
  }

  async getCredential(providerId: string): Promise<string | null> {
    return this.credentials.get(providerId) ?? null;
  }

  async deleteCredential(providerId: string): Promise<void> {
    this.credentials.delete(providerId);
  }
}

/** In-memory model store for tests / local dev without a database. */
export class InMemoryModelStore implements ModelStore {
  private readonly models = new Map<string, ModelRecord>();

  async list(filter: { providerId?: string; enabled?: boolean } = {}): Promise<ModelRecord[]> {
    return [...this.models.values()].filter(
      (m) =>
        (filter.providerId === undefined || m.providerId === filter.providerId) &&
        (filter.enabled === undefined || m.enabled === filter.enabled),
    );
  }

  async get(id: string): Promise<ModelRecord | null> {
    return this.models.get(id) ?? null;
  }

  async getByProviderAndModel(providerId: string, modelId: string): Promise<ModelRecord | null> {
    for (const m of this.models.values()) {
      if (m.providerId === providerId && m.modelId === modelId) return m;
    }
    return null;
  }

  async create(data: Omit<ModelRecord, 'id'>): Promise<ModelRecord> {
    const record: ModelRecord = { ...data, id: crypto.randomUUID() };
    this.models.set(record.id, record);
    return record;
  }

  async update(
    id: string,
    patch: Partial<Omit<ModelRecord, 'id' | 'providerId'>>,
  ): Promise<ModelRecord | null> {
    const existing = this.models.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch };
    this.models.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.models.delete(id);
  }

  async deleteByProvider(providerId: string): Promise<number> {
    let n = 0;
    for (const [id, m] of this.models) {
      if (m.providerId === providerId) {
        this.models.delete(id);
        n += 1;
      }
    }
    return n;
  }
}
