// modules/users — GET /api/v1/users/me (own profile, no secrets).
import type { FastifyInstance } from 'fastify';
import type { Db } from '../../lib/db.js';
import { unauthorized } from '../../lib/errors.js';
import { publicUser } from '../auth/index.js';

export async function usersRoutes(fastify: FastifyInstance, opts: { db: Db }): Promise<void> {
  fastify.get('/api/v1/users/me', { preHandler: fastify.authenticate }, async (request) => {
    if (!request.user) throw unauthorized();
    const roles = await opts.db.userRole.findMany({ where: { userId: request.user.id } });
    const roleNames: string[] = [];
    for (const a of roles) {
      const role = await opts.db.role.findUnique({ where: { id: a.roleId } });
      if (role) roleNames.push(role.name);
    }
    return { ...publicUser(request.user), roles: roleNames };
  });
}
