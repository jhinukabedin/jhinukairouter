// server.ts — entry point. Starts the API on PORT (default 3001).
// /health answers even if the database is unreachable (see health module);
// a failed DB connection is logged but does not stop the process from
// starting — readiness is reported by /health/ready instead. In production
// the DB should be up; set DATABASE_URL correctly (see .env.example).
import { loadEnv } from '@jhinuk-ai-router/config';
import { buildApp } from './app.js';
import { createDb } from './lib/db.js';

async function main(): Promise<void> {
  const env = loadEnv();
  let db;
  try {
    db = await createDb();
    const ok = await db.ping();
    if (!ok) console.warn('[router] warning: database ping failed at startup — /health/ready will report degraded');
  } catch (err) {
    console.warn('[router] warning: could not connect to database at startup:', (err as Error).message);
    // Start anyway with a failing-ping stub so /health still answers.
    db = { ping: async () => false } as never;
  }
  const app = await buildApp({ env, db });
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  console.log(`[router] listening on http://0.0.0.0:${env.PORT} (env=${env.NODE_ENV}, redis=${env.REDIS_URL ? 'configured' : 'not configured — in-memory fallback'})`);
}

main().catch((err) => {
  console.error('[router] fatal startup error', err);
  process.exit(1);
});
