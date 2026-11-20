// Default store-backed resolvers for the gateway (Builder 2 owns).
// These are the "no Builder 3 yet" defaults: resolve a chain entry to a
// provider record + credential, and resolve a bare model id to a chain.
// Builder 3 replaces `chainResolver` with task-category routing; the
// provider source stays the same.

import type { ModelChainEntry, NormalizedChatRequest } from '@jhinuk-ai-router/shared';
import { createAdapter } from '@jhinuk-ai-router/provider-sdk';
import type { ModelStore, ProviderStore } from '../providers/store.js';
import type { ApiKeyIdentity, ChainResolver, ProviderSource, ResolvedProvider } from './types.js';

export interface StoreResolverDeps {
  providers: ProviderStore;
  models: ModelStore;
}

/**
 * Pick the best enabled provider record for a chain entry. `entry.provider`
 * may be a provider id OR a provider type ('tokens', 'openai', ...).
 * Preference: enabled, then global providers, then higher priority.
 * A model that exists in the store but is disabled is skipped (returns null
 * so the chain moves on); an unknown model id is still attempted — the
 * provider itself is the authority for models not synced yet.
 */
export function createStoreProviderSource(deps: StoreResolverDeps): ProviderSource {
  return async (entry: ModelChainEntry, _auth: ApiKeyIdentity): Promise<ResolvedProvider | null> => {
    const all = await deps.providers.list({ enabled: true });
    const byId = all.find((p) => p.id === entry.provider);
    const candidates = byId ? [byId] : all.filter((p) => p.type === entry.provider);
    candidates.sort((a, b) => Number(b.isGlobal) - Number(a.isGlobal) || b.priority - a.priority);
    for (const provider of candidates) {
      const model = await deps.models.getByProviderAndModel(provider.id, entry.model);
      if (model && !model.enabled) continue; // disabled model: skip to next provider
      const credential = await deps.providers.getCredential(provider.id);
      if (!credential) continue;
      const adapter = createAdapter(provider.type, {
        baseUrl: provider.baseUrl,
        protocol: provider.protocol,
        timeoutMs: provider.timeoutMs,
      });
      return {
        adapter,
        credential,
        baseUrl: provider.baseUrl,
        timeoutMs: provider.timeoutMs,
        contextWindow: model?.contextWindow ?? 0,
      };
    }
    return null;
  };
}

/** Default chain resolver: a bare model id (or "provider/model") -> 1-entry chain. */
export function createStoreChainResolver(deps: StoreResolverDeps): ChainResolver {
  return async (req: NormalizedChatRequest): Promise<ModelChainEntry[] | null> => {
    const model = req.model;
    if (!model) return null;
    // "provider/model" form (e.g. "tokens/gpt-6-luna").
    const slash = model.indexOf('/');
    if (slash > 0) {
      return [{ provider: model.slice(0, slash), model: model.slice(slash + 1) }];
    }
    // Find the model in the store (enabled) and use its provider.
    const models = await deps.models.list({ enabled: true });
    const found = models.find((m) => m.modelId === model);
    if (!found) return null;
    const provider = await deps.providers.get(found.providerId);
    if (!provider || !provider.enabled) return null;
    return [{ provider: provider.type, model }];
  };
}
