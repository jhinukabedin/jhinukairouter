// lib/settings — DB setting wins over env; env is the fallback.
import { describe, expect, it } from 'vitest';
import { isRegistrationEnabled, REGISTRATION_SETTING_KEY } from './settings.js';
import type { Db } from './db.js';
import type { Env } from '@jhinuk-ai-router/config';

function stubDb(rows: { key: string; value: unknown }[]): Db {
  return {
    systemSetting: {
      findMany: async () => rows.map((r) => ({ id: 'id', key: r.key, value: r.value, updatedBy: null })),
      upsert: async () => { throw new Error('unused in this test'); },
    },
  } as unknown as Db;
}

function stubEnv(registrationEnabled: boolean): Env {
  return { REGISTRATION_ENABLED: registrationEnabled } as Env;
}

describe('isRegistrationEnabled', () => {
  it('returns the env value when no setting is stored', async () => {
    expect(await isRegistrationEnabled(stubDb([]), stubEnv(true))).toBe(true);
    expect(await isRegistrationEnabled(stubDb([]), stubEnv(false))).toBe(false);
  });

  it('DB setting false overrides env true', async () => {
    const db = stubDb([{ key: REGISTRATION_SETTING_KEY, value: false }]);
    expect(await isRegistrationEnabled(db, stubEnv(true))).toBe(false);
  });

  it('DB setting true overrides env false', async () => {
    const db = stubDb([{ key: REGISTRATION_SETTING_KEY, value: true }]);
    expect(await isRegistrationEnabled(db, stubEnv(false))).toBe(true);
  });

  it('ignores a non-boolean stored value and falls back to env', async () => {
    const db = stubDb([{ key: REGISTRATION_SETTING_KEY, value: 'yes' }]);
    expect(await isRegistrationEnabled(db, stubEnv(true))).toBe(true);
    expect(await isRegistrationEnabled(db, stubEnv(false))).toBe(false);
  });

  it('ignores other setting keys', async () => {
    const db = stubDb([{ key: 'allowLocalProviders', value: true }]);
    expect(await isRegistrationEnabled(db, stubEnv(false))).toBe(false);
  });

  it('falls back to env when the DB delegate is missing (degraded mode) or errors', async () => {
    const noDelegate = {} as unknown as Db;
    expect(await isRegistrationEnabled(noDelegate, stubEnv(true))).toBe(true);
    expect(await isRegistrationEnabled(noDelegate, stubEnv(false))).toBe(false);
    const failing = {
      systemSetting: { findMany: async () => { throw new Error('db down'); } },
    } as unknown as Db;
    expect(await isRegistrationEnabled(failing, stubEnv(true))).toBe(true);
    expect(await isRegistrationEnabled(failing, stubEnv(false))).toBe(false);
  });
});
