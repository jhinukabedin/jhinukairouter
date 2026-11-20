// modules/roles — admin role + permission management.
// Seeded roles: SUPER_ADMIN | ADMIN | MANAGER | USER | VIEWER (see migration).
// Permissions are the contract strings, e.g. providers:create.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../lib/audit.js';
import type { Db } from '../../lib/db.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { parseBody } from '../../lib/validate.js';

const createRoleSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(255).optional(),
});
const updateRoleSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  description: z.string().max(255).nullable().optional(),
});
const setPermissionsSchema = z.object({
  permissions: z.array(z.string().min(1)).max(200),
});

export async function rolesRoutes(fastify: FastifyInstance, opts: { db: Db }): Promise<void> {
  const { db } = opts;
  const admin = [fastify.authenticate, fastify.requireAdmin];

  fastify.get('/api/v1/roles', { preHandler: admin }, async () => {
    const roles = await db.role.findMany();
    const out: Array<Record<string, unknown>> = [];
    for (const role of roles) {
      const links = await db.rolePermission.findMany({ where: { roleId: role.id } });
      const perms = await db.permission.findMany();
      const names = links
        .map((l) => perms.find((p) => p.id === l.permissionId)?.name)
        .filter((n): n is string => Boolean(n));
      out.push({ id: role.id, name: role.name, description: role.description, permissions: names });
    }
    return { roles: out };
  });

  fastify.post('/api/v1/roles', { preHandler: admin }, async (request, reply) => {
    const body = parseBody(createRoleSchema, request);
    const existing = await db.role.findUnique({ where: { name: body.name } });
    if (existing) throw badRequest(`Role ${body.name} already exists`);
    const role = await db.role.create({ data: { name: body.name, description: body.description ?? null } });
    await audit(db, { userId: request.user?.id, action: 'roles.create', resource: 'role', resourceId: role.id, ip: request.ip });
    return reply.code(201).send(role);
  });

  fastify.patch('/api/v1/roles/:id', { preHandler: admin }, async (request) => {
    const { id } = request.params as { id: string };
    const body = parseBody(updateRoleSchema, request);
    const role = await db.role.findUnique({ where: { id } });
    if (!role) throw notFound('Role not found');
    return db.role.update({ where: { id }, data: body });
  });

  fastify.post('/api/v1/roles/:id/permissions', { preHandler: admin }, async (request) => {
    const { id } = request.params as { id: string };
    const body = parseBody(setPermissionsSchema, request);
    const role = await db.role.findUnique({ where: { id } });
    if (!role) throw notFound('Role not found');
    const known = await db.permission.findMany({ where: { name: { in: body.permissions } } });
    const unknownNames = body.permissions.filter((p) => !known.some((k) => k.name === p));
    if (unknownNames.length > 0) throw badRequest(`Unknown permissions: ${unknownNames.join(', ')}`);
    await db.rolePermission.deleteMany({ where: { roleId: id } });
    for (const perm of known) {
      await db.rolePermission.create({ data: { roleId: id, permissionId: perm.id } });
    }
    await audit(db, { userId: request.user?.id, action: 'roles.set-permissions', resource: 'role', resourceId: id, meta: { permissions: body.permissions }, ip: request.ip });
    return { ok: true, permissions: body.permissions };
  });
}
