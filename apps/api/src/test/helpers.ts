// test/helpers.ts — build a test app with the in-memory fake Db.
import type { Env } from '@jhinuk-ai-router/config';
import { buildApp } from '../app.js';
import { FakeDb } from './fake-db.js';

export const TEST_ENV: Env = {
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  REDIS_URL: undefined,
  PORT: 3001,
  WEB_PORT: 3000,
  SESSION_SECRET: 'a'.repeat(64),
  JWT_SECRET: 'b'.repeat(64),
  ENCRYPTION_MASTER_KEY: 'c'.repeat(64),
  ROUTER_MASTER_KEY: 'test-router-master-key',
  CORS_ORIGIN: 'http://localhost:3000',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  REGISTRATION_ENABLED: true,
  REQUIRE_EMAIL_VERIFICATION: false,
};

export async function makeTestApp(envOverrides: Partial<Env> = {}): Promise<{ app: Awaited<ReturnType<typeof buildApp>>; db: FakeDb }> {
  const db = new FakeDb();
  const app = await buildApp({ env: { ...TEST_ENV, ...envOverrides }, db, disableRateLimit: true });
  return { app, db };
}

/** Register a user via the API and return its session token. */
export async function registerUser(app: Awaited<ReturnType<typeof buildApp>>, email: string, password = 'password123'): Promise<{ id: string; token: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, password, name: 'Test User' } });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  const body = res.json() as { user: { id: string }; token: string };
  return { id: body.user.id, token: body.token };
}

export function authHeader(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}
