import { describe, expect, it } from 'vitest';
import { addChainEntry, chainLabel, moveChainEntry, normalizeChain, parseModelRef, removeChainEntry } from '../chain';

describe('chain helpers', () => {
  it('parses provider/model refs', () => {
    expect(parseModelRef('tokens/gpt-6-luna')).toEqual({ provider: 'tokens', model: 'gpt-6-luna' });
    expect(parseModelRef('gpt-6-luna')).toEqual({ provider: '', model: 'gpt-6-luna' });
  });
  it('normalises string, array and empty taskMapping values', () => {
    expect(normalizeChain('tokens/gpt-6-luna')).toEqual([{ provider: 'tokens', model: 'gpt-6-luna' }]);
    expect(normalizeChain([{ provider: 'tokens', model: 'gpt-6-luna' }, 'deepseek/deepseek-flash'])).toHaveLength(2);
    expect(normalizeChain(undefined)).toEqual([]);
    expect(normalizeChain(null)).toEqual([]);
  });
  it('moves entries up and down without mutating', () => {
    const chain = [
      { provider: 'tokens', model: 'gpt-6-luna' },
      { provider: 'deepseek', model: 'deepseek-flash' },
      { provider: 'moonshot', model: 'kimi-k2.7-code' },
    ];
    expect(moveChainEntry(chain, 0, 1)[0].model).toBe('deepseek-flash');
    expect(moveChainEntry(chain, 2, -1)[1].model).toBe('kimi-k2.7-code');
    expect(moveChainEntry(chain, 0, -1)).toEqual(chain);
    expect(moveChainEntry(chain, 2, 1)).toEqual(chain);
  });
  it('removes and adds entries, ignoring duplicates and blanks', () => {
    const chain = [{ provider: 'tokens', model: 'gpt-6-luna' }];
    expect(removeChainEntry(chain, 0)).toEqual([]);
    expect(addChainEntry(chain, { provider: 'tokens', model: 'gpt-6-luna' })).toEqual(chain);
    expect(addChainEntry(chain, { provider: '', model: '  ' })).toEqual(chain);
    expect(addChainEntry(chain, { provider: 'deepseek', model: 'deepseek-flash' })).toHaveLength(2);
  });
  it('renders the fallback chain label', () => {
    expect(chainLabel([{ provider: 'tokens', model: 'gpt-6-luna' }, { provider: 'deepseek', model: 'deepseek-flash' }])).toBe(
      'gpt-6-luna → deepseek-flash',
    );
    expect(chainLabel([])).toBe('— no model —');
  });
});
