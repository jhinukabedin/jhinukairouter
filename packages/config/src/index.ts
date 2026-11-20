// @jhinuk-ai-router/config — Zod env validation (Agent 1).
// REDIS_URL is OPTIONAL: empty/missing means "run without Redis" and the
// app falls back to in-memory rate limiting / queue stubs.
import { z } from 'zod';

const hex64 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex chars (32 bytes)');

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // Optional: empty string counts as "not set".
  REDIS_URL: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v : undefined)),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  WEB_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  SESSION_SECRET: z.string().min(32),
  JWT_SECRET: z.string().min(32),
  ENCRYPTION_MASTER_KEY: hex64,
  ROUTER_MASTER_KEY: z.string().min(16),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  REGISTRATION_ENABLED: z
    .string()
    .optional()
    .default('true')
    .transform((v) => v !== 'false'),
  REQUIRE_EMAIL_VERIFICATION: z
    .string()
    .optional()
    .default('false')
    .transform((v) => v === 'true'),
});

export type Env = z.infer<typeof envSchema>;

/** Parse + validate process.env. Throws a readable error listing bad vars. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return parsed.data;
}

/** True when Redis is configured (otherwise in-memory fallbacks are used). */
export function hasRedis(env: Env): boolean {
  return env.REDIS_URL !== undefined;
}
