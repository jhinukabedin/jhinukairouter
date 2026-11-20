import { describe, expect, it } from 'vitest';
import { loadEnv } from '@jhinuk-ai-router/config';
import { DEFAULT_AGENT_CHAINS, DEFAULT_TASK_MAPPING } from '@jhinuk-ai-router/shared';

describe('packages/config env validation', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    SESSION_SECRET: 's'.repeat(32),
    JWT_SECRET: 'j'.repeat(32),
    ENCRYPTION_MASTER_KEY: 'a'.repeat(64),
    ROUTER_MASTER_KEY: 'master-key-long-enough',
  };

  it('accepts a valid env and defaults PORT/REDIS handling', () => {
    const env = loadEnv({ ...base });
    expect(env.PORT).toBe(3001);
    expect(env.REDIS_URL).toBeUndefined();
    expect(env.REGISTRATION_ENABLED).toBe(true);
  });

  it('treats empty REDIS_URL as unset (optional Redis)', () => {
    const env = loadEnv({ ...base, REDIS_URL: '' });
    expect(env.REDIS_URL).toBeUndefined();
  });

  it('rejects a non-hex ENCRYPTION_MASTER_KEY', () => {
    expect(() => loadEnv({ ...base, ENCRYPTION_MASTER_KEY: 'not-hex' })).toThrow(/ENCRYPTION_MASTER_KEY/);
  });

  it('rejects a missing DATABASE_URL', () => {
    const { DATABASE_URL: _omit, ...rest } = base;
    expect(() => loadEnv(rest)).toThrow(/DATABASE_URL/);
  });
});

describe('packages/shared default task mapping', () => {
  it('maps GENERAL to tokens/gpt-6-luna (seed only)', () => {
    expect(DEFAULT_TASK_MAPPING.GENERAL).toEqual([{ provider: 'tokens', model: 'gpt-6-luna' }]);
  });

  it('gives the coordinator an ordered multi-model chain', () => {
    const chain = DEFAULT_AGENT_CHAINS.coordinator ?? [];
    expect(chain.length).toBeGreaterThanOrEqual(3);
    expect(chain[0]).toEqual({ provider: 'tokens', model: 'gpt-6-luna' });
  });

  it('covers every task category', () => {
    for (const category of ['GENERAL', 'SIMPLE_QUESTION', 'CODE_GENERATION', 'SMALL_CODE_FIX', 'COMPLEX_DEBUGGING', 'ARCHITECTURE', 'PLANNING', 'REASONING', 'DATA_ANALYSIS', 'LONG_CONTEXT', 'VISION', 'TOOL_CALLING']) {
      expect(DEFAULT_TASK_MAPPING[category]).toBeDefined();
      expect((DEFAULT_TASK_MAPPING[category] ?? []).length).toBeGreaterThan(0);
    }
  });
});
