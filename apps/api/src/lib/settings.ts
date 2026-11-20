// lib/settings — DB-backed system settings with env fallback.
// A setting stored in the SystemSetting table wins over the matching env
// var; when no row exists, the env value applies. This keeps fresh installs
// working (env defaults) while letting an admin flip a flag from the
// dashboard with no redeploy and no container restart.
import type { Env } from '@jhinuk-ai-router/config';
import type { Db } from './db.js';

/** SystemSetting key that controls whether new accounts may register. */
export const REGISTRATION_SETTING_KEY = 'registration.enabled';

/** Effective registration flag: DB setting first, env REGISTRATION_ENABLED second. */
export async function isRegistrationEnabled(db: Db, env: Env): Promise<boolean> {
  try {
    // Degraded mode (DB down at startup) runs with a ping-only stub Db that
    // has no systemSetting delegate — fall back to the env value then.
    const rows = (await db.systemSetting?.findMany()) ?? [];
    const row = rows.find((r) => r.key === REGISTRATION_SETTING_KEY);
    if (row && typeof row.value === 'boolean') return row.value;
  } catch {
    // A DB error here must not break the status endpoint; env is the default.
  }
  return env.REGISTRATION_ENABLED;
}
