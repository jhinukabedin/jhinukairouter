// Pure helpers for per-agent / per-task ordered model chains.
// A chain is an ordered list of { provider, model } entries.
// Fallback tries entry #1, then #2, then #3 ... on 429 / 5xx / timeout / unavailable.
export interface ChainEntry {
  provider: string;
  model: string;
}

export function parseModelRef(ref: string): ChainEntry {
  const i = ref.indexOf('/');
  if (i <= 0) return { provider: '', model: ref.trim() };
  return { provider: ref.slice(0, i).trim(), model: ref.slice(i + 1).trim() };
}

export function chainRef(e: ChainEntry): string {
  return e.provider ? `${e.provider}/${e.model}` : e.model;
}

/** Normalise whatever the API stored in taskMapping (string, single entry, or array) into a chain. */
export function normalizeChain(value: unknown): ChainEntry[] {
  if (Array.isArray(value)) {
    return value
      .map((v) =>
        typeof v === 'string' ? parseModelRef(v) : v && typeof v === 'object'
          ? { provider: String((v as ChainEntry).provider ?? ''), model: String((v as ChainEntry).model ?? '') }
          : null,
      )
      .filter((v): v is ChainEntry => !!v && v.model.length > 0);
  }
  if (typeof value === 'string' && value.trim()) return [parseModelRef(value)];
  return [];
}

export function moveChainEntry(chain: ChainEntry[], index: number, dir: -1 | 1): ChainEntry[] {
  const next = [...chain];
  const j = index + dir;
  if (index < 0 || index >= next.length || j < 0 || j >= next.length) return next;
  [next[index], next[j]] = [next[j], next[index]];
  return next;
}

export function removeChainEntry(chain: ChainEntry[], index: number): ChainEntry[] {
  return chain.filter((_, i) => i !== index);
}

export function addChainEntry(chain: ChainEntry[], entry: ChainEntry): ChainEntry[] {
  if (!entry.model.trim()) return chain;
  if (chain.some((e) => chainRef(e) === chainRef(entry))) return chain;
  return [...chain, entry];
}

/** Human-readable fallback chain, e.g. "Luna → DeepSeek Flash → Kimi". */
export function chainLabel(chain: ChainEntry[], displayName?: (e: ChainEntry) => string): string {
  if (chain.length === 0) return '— no model —';
  return chain.map((e) => (displayName ? displayName(e) : e.model)).join(' → ');
}
