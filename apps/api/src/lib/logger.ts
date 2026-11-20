// lib/logger.ts — logging helpers. Secrets are never logged: use
// redactSecrets() on any free-form string that might contain a key/token.
import type { FastifyBaseLogger } from 'fastify';

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /rk_live_[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._\-]{8,}/gi,
  /"encryptedKey"\s*:\s*"[^"]+"/g,
];

export function redactSecrets(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[REDACTED]');
  return out;
}

export function logSafe(logger: FastifyBaseLogger, level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>): void {
  logger[level]({ ...meta }, redactSecrets(msg));
}
