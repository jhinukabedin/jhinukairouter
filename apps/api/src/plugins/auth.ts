// plugins/auth.ts — session authentication + role/permission guards.
// Auth: Authorization: Bearer <opaque session token>. The token is stored
// as SHA-256 in UserSession; sessions expire (30 days) and can be revoked.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { sha256Hex } from '../lib/crypto.js';
import type { Db, UserRow } from '../lib/db.js';
import { forbidden, unauthorized } from '../lib/errors.js';

export interface AuthContext {
  db: Db;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: UserRow;
    sessionId?: string;
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRoles: (...roles: string[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const ADMIN_ROLES = ['SUPER_ADMIN', 'ADMIN'] as const;

export async function authPlugin(fastify: FastifyInstance, opts: AuthContext): Promise<void> {
  const { db } = opts;

  fastify.decorate('authenticate', async (request: FastifyRequest): Promise<void> => {
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) throw unauthorized('Missing session token');
    const token = header.slice('Bearer '.length).trim();
    if (token === '') throw unauthorized('Missing session token');

    // NOTE: tokenHash is only @@index in the Prisma schema, NOT @unique —
    // Prisma's findUnique() throws on a non-unique field, which made every
    // authenticated call 401 in production (login itself worked: it only
    // creates the row). findFirst is the correct lookup here.
    const session = await db.userSession.findFirst({ where: { tokenHash: sha256Hex(token) } });
    if (!session || session.revokedAt !== null || session.expiresAt.getTime() < Date.now()) {
      throw unauthorized('Invalid or expired session');
    }
    const user = await db.user.findUnique({ where: { id: session.userId } });
    if (!user || user.status !== 'ACTIVE') throw unauthorized('Account is not active');
    request.user = user;
    request.sessionId = session.id;
  });

  fastify.decorate('requireRoles', (...roles: string[]) => {
    return async (request: FastifyRequest): Promise<void> => {
      if (!request.user) throw unauthorized();
      const assignments = await db.userRole.findMany({ where: { userId: request.user.id } });
      const roleNames: string[] = [];
      for (const a of assignments) {
        const role = await db.role.findUnique({ where: { id: a.roleId } });
        if (role) roleNames.push(role.name);
      }
      if (!roles.some((r) => roleNames.includes(r))) throw forbidden('Insufficient role');
    };
  });

  fastify.decorate('requireAdmin', async (request: FastifyRequest): Promise<void> => {
    if (!request.user) throw unauthorized();
    const assignments = await db.userRole.findMany({ where: { userId: request.user.id } });
    const roleNames: string[] = [];
    for (const a of assignments) {
      const role = await db.role.findUnique({ where: { id: a.roleId } });
      if (role) roleNames.push(role.name);
    }
    if (!ADMIN_ROLES.some((r) => roleNames.includes(r))) throw forbidden('Admin role required');
  });
}

export default fp(authPlugin, { name: 'auth-plugin' });
