// modules/auth — POST /api/v1/auth/*
// Sessions are opaque random tokens, stored as SHA-256 hashes in UserSession
// (30-day expiry, revocable). Passwords: Argon2id. TOTP: RFC 6238 (SHA-1).
// Password-reset tokens are hashed too and single-use (1h expiry).
// NOTE: reset emails are not sent yet — no mail transport is configured in
// Phase 1 (see docs/IMPLEMENTATION_STATUS.md). The endpoint still creates
// the token and returns a neutral response (no user enumeration).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomToken, sha256Hex } from '../../lib/crypto.js';
import type { Db, UserRow } from '../../lib/db.js';
import { badRequest, conflict, notFound, unauthorized } from '../../lib/errors.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import { generateTotpCode, generateTotpSecret, totpAuthUrl, verifyTotpCode } from '../../lib/totp.js';
import { parseBody } from '../../lib/validate.js';
import { audit } from '../../lib/audit.js';
import type { Env } from '@jhinuk-ai-router/config';

export interface AuthModuleOptions {
  db: Db;
  env: Env;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

const emailSchema = z.string().email().max(255);
const passwordSchema = z.string().min(8).max(128);

const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().min(1).max(120).optional(),
});
const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
  totpCode: z.string().regex(/^\d{6}$/).optional(),
});
const resetRequestSchema = z.object({ email: emailSchema });
const resetConfirmSchema = z.object({
  token: z.string().min(10),
  newPassword: passwordSchema,
});
const totpVerifySchema = z.object({ code: z.string().regex(/^\d{6}$/) });

export function publicUser(user: UserRow): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    totpEnabled: user.totpEnabled,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

async function assignRole(db: Db, userId: string, roleName: string): Promise<void> {
  const role = await db.role.findUnique({ where: { name: roleName } });
  if (role) await db.userRole.create({ data: { userId, roleId: role.id } });
}

async function createSession(
  db: Db,
  userId: string,
  request: { headers: Record<string, unknown>; ip?: string },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.userSession.create({
    data: {
      userId,
      tokenHash: sha256Hex(token),
      userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
      ip: request.ip ?? null,
      expiresAt,
    },
  });
  return { token, expiresAt };
}

export async function authRoutes(fastify: FastifyInstance, opts: AuthModuleOptions): Promise<void> {
  const { db, env } = opts;
  const prefix = '/api/v1/auth';

  fastify.post(`${prefix}/register`, async (request, reply) => {
    if (!env.REGISTRATION_ENABLED) throw badRequest('Registration is disabled', 'REGISTRATION_DISABLED');
    const body = parseBody(registerSchema, request);
    const existing = await db.user.findUnique({ where: { email: body.email } });
    if (existing) throw conflict('An account with this email already exists');
    const passwordHash = await hashPassword(body.password);
    const user = await db.user.create({ data: { email: body.email, passwordHash, name: body.name ?? null } });
    // Bootstrap: the very first account becomes SUPER_ADMIN; everyone else USER.
    const userCount = await db.user.count();
    await assignRole(db, user.id, userCount <= 1 ? 'SUPER_ADMIN' : 'USER');
    const { token, expiresAt } = await createSession(db, user.id, request);
    await audit(db, { userId: user.id, action: 'auth.register', resource: 'user', resourceId: user.id, ip: request.ip });
    return reply.code(201).send({ user: publicUser(user), token, expiresAt: expiresAt.toISOString() });
  });

  fastify.post(`${prefix}/login`, async (request, reply) => {
    const body = parseBody(loginSchema, request);
    const user = await db.user.findUnique({ where: { email: body.email } });
    if (!user || !(await verifyPassword(user.passwordHash, body.password))) {
      throw unauthorized('Invalid email or password');
    }
    if (user.status !== 'ACTIVE') throw unauthorized('Account is suspended');
    if (user.totpEnabled) {
      if (!body.totpCode) throw unauthorized('Two-factor code required', 'TOTP_REQUIRED');
      if (!user.totpSecret || !verifyTotpCode(user.totpSecret, body.totpCode)) {
        throw unauthorized('Invalid two-factor code', 'TOTP_INVALID');
      }
    }
    const { token, expiresAt } = await createSession(db, user.id, request);
    await audit(db, { userId: user.id, action: 'auth.login', resource: 'user', resourceId: user.id, ip: request.ip });
    return reply.send({ user: publicUser(user), token, expiresAt: expiresAt.toISOString() });
  });

  fastify.post(`${prefix}/logout`, { preHandler: fastify.authenticate }, async (request) => {
    if (request.sessionId) {
      await db.userSession.update({ where: { id: request.sessionId }, data: { revokedAt: new Date() } });
    }
    return { ok: true };
  });

  fastify.post(`${prefix}/refresh`, { preHandler: fastify.authenticate }, async (request, reply) => {
    if (!request.user) throw unauthorized();
    if (request.sessionId) {
      await db.userSession.update({ where: { id: request.sessionId }, data: { revokedAt: new Date() } });
    }
    const { token, expiresAt } = await createSession(db, request.user.id, request);
    return reply.send({ token, expiresAt: expiresAt.toISOString() });
  });

  fastify.post(`${prefix}/password-reset/request`, async (request) => {
    const body = parseBody(resetRequestSchema, request);
    // Neutral response either way — never reveal whether the email exists.
    const user = await db.user.findUnique({ where: { email: body.email } });
    if (user) {
      const token = randomToken(32);
      await db.passwordResetToken.create({
        data: { userId: user.id, tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) },
      });
      // TODO (Phase 2): send the reset link by email once SMTP is configured.
      // The raw token is never returned in the response.
      request.log.info({ userId: user.id }, 'password reset requested (email not yet configured)');
    }
    return { ok: true, message: 'If an account exists for that email, a reset link has been sent.' };
  });

  fastify.post(`${prefix}/password-reset/confirm`, async (request) => {
    const body = parseBody(resetConfirmSchema, request);
    const record = await db.passwordResetToken.findUnique({ where: { tokenHash: sha256Hex(body.token) } });
    if (!record || record.usedAt !== null || record.expiresAt.getTime() < Date.now()) {
      throw badRequest('Invalid or expired reset token', 'RESET_TOKEN_INVALID');
    }
    const passwordHash = await hashPassword(body.newPassword);
    await db.user.update({ where: { id: record.userId }, data: { passwordHash } });
    await db.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
    // Invalidate all sessions after a password reset.
    await db.userSession.updateMany({ where: { userId: record.userId }, data: { revokedAt: new Date() } });
    await audit(db, { userId: record.userId, action: 'auth.password-reset', resource: 'user', resourceId: record.userId, ip: request.ip });
    return { ok: true };
  });

  fastify.get(`${prefix}/sessions`, { preHandler: fastify.authenticate }, async (request) => {
    if (!request.user) throw unauthorized();
    const sessions = await db.userSession.findMany({ where: { userId: request.user.id } });
    return {
      sessions: sessions.map((s) => ({
        id: s.id,
        userAgent: s.userAgent,
        ip: s.ip,
        expiresAt: s.expiresAt.toISOString(),
        revokedAt: s.revokedAt?.toISOString() ?? null,
        current: s.id === request.sessionId,
      })),
    };
  });

  fastify.delete(`${prefix}/sessions/:id`, { preHandler: fastify.authenticate }, async (request) => {
    if (!request.user) throw unauthorized();
    const { id } = request.params as { id: string };
    const session = await db.userSession.findUnique({ where: { id } });
    if (!session || session.userId !== request.user.id) throw notFound('Session not found');
    await db.userSession.update({ where: { id }, data: { revokedAt: new Date() } });
    return { ok: true };
  });

  fastify.post(`${prefix}/totp/setup`, { preHandler: fastify.authenticate }, async (request) => {
    if (!request.user) throw unauthorized();
    const secret = generateTotpSecret();
    await db.user.update({ where: { id: request.user.id }, data: { totpSecret: secret, totpEnabled: false } });
    return { secret, otpauthUrl: totpAuthUrl(secret, request.user.email) };
  });

  fastify.post(`${prefix}/totp/verify`, { preHandler: fastify.authenticate }, async (request) => {
    if (!request.user) throw unauthorized();
    const body = parseBody(totpVerifySchema, request);
    const user = await db.user.findUnique({ where: { id: request.user.id } });
    if (!user?.totpSecret) throw badRequest('TOTP is not set up — call /totp/setup first', 'TOTP_NOT_SETUP');
    if (!verifyTotpCode(user.totpSecret, body.code)) throw badRequest('Invalid code', 'TOTP_INVALID');
    await db.user.update({ where: { id: user.id }, data: { totpEnabled: true } });
    await audit(db, { userId: user.id, action: 'auth.totp.enable', resource: 'user', resourceId: user.id, ip: request.ip });
    return { ok: true, totpEnabled: true };
  });

  // Test-only helper (used by Vitest): generate a code for the current secret.
  // Exposed only when NODE_ENV=test; never in production.
  if (env.NODE_ENV === 'test') {
    fastify.get(`${prefix}/totp/debug-code`, { preHandler: fastify.authenticate }, async (request) => {
      const user = await db.user.findUnique({ where: { id: request.user?.id ?? '' } });
      if (!user?.totpSecret) throw notFound('No TOTP secret');
      return { code: generateTotpCode(user.totpSecret) };
    });
  }
}
