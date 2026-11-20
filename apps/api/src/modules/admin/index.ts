// modules/admin — admin-only user management, audit logs, system settings.
// Every mutation writes an AuditLog row. Suspended users cannot log in and
// their sessions are revoked on suspend.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../lib/audit.js';
import type { Db } from '../../lib/db.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { hashPassword } from '../../lib/password.js';
import { parseBody, parseQuery } from '../../lib/validate.js';
import { publicUser } from '../auth/index.js';

const listUsersQuery = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
  search: z.string().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
const createUserSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(120).optional(),
  role: z.string().min(1).max(64).default('USER'),
});
const updateUserSchema = z.object({
  name: z.string().min(1).max(120).nullable().optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
});
const assignRoleSchema = z.object({ role: z.string().min(1).max(64) });
const auditQuery = z.object({
  userId: z.string().optional(),
  action: z.string().optional(),
  resource: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
const patchSettingsSchema = z.object({
  settings: z.record(z.unknown()).refine((v) => Object.keys(v).length > 0, 'At least one setting is required'),
});

export async function adminRoutes(fastify: FastifyInstance, opts: { db: Db }): Promise<void> {
  const { db } = opts;
  const admin = [fastify.authenticate, fastify.requireAdmin];

  fastify.get('/api/v1/admin/users', { preHandler: admin }, async (request) => {
    const q = parseQuery(listUsersQuery, request);
    const where = { status: q.status, emailContains: q.search };
    const [users, total] = await Promise.all([
      db.user.findMany({ where, skip: (q.page - 1) * q.pageSize, take: q.pageSize, orderBy: { createdAt: 'desc' } }),
      db.user.count({ where }),
    ]);
    return { users: users.map(publicUser), total, page: q.page, pageSize: q.pageSize };
  });

  fastify.post('/api/v1/admin/users', { preHandler: admin }, async (request, reply) => {
    const body = parseBody(createUserSchema, request);
    const existing = await db.user.findUnique({ where: { email: body.email } });
    if (existing) throw conflict('An account with this email already exists');
    const role = await db.role.findUnique({ where: { name: body.role } });
    if (!role) throw badRequest(`Unknown role: ${body.role}`);
    const user = await db.user.create({
      data: { email: body.email, passwordHash: await hashPassword(body.password), name: body.name ?? null },
    });
    await db.userRole.create({ data: { userId: user.id, roleId: role.id } });
    await audit(db, { userId: request.user?.id, action: 'admin.users.create', resource: 'user', resourceId: user.id, ip: request.ip });
    return reply.code(201).send(publicUser(user));
  });

  fastify.patch('/api/v1/admin/users/:id', { preHandler: admin }, async (request) => {
    const { id } = request.params as { id: string };
    const body = parseBody(updateUserSchema, request);
    const user = await db.user.findUnique({ where: { id } });
    if (!user) throw notFound('User not found');
    const updated = await db.user.update({ where: { id }, data: body });
    await audit(db, { userId: request.user?.id, action: 'admin.users.update', resource: 'user', resourceId: id, meta: body, ip: request.ip });
    return publicUser(updated);
  });

  fastify.post('/api/v1/admin/users/:id/suspend', { preHandler: admin }, async (request) => {
    const { id } = request.params as { id: string };
    const user = await db.user.findUnique({ where: { id } });
    if (!user) throw notFound('User not found');
    if (user.id === request.user?.id) throw badRequest('You cannot suspend your own account');
    await db.user.update({ where: { id }, data: { status: 'SUSPENDED' } });
    await db.userSession.updateMany({ where: { userId: id }, data: { revokedAt: new Date() } });
    await audit(db, { userId: request.user?.id, action: 'admin.users.suspend', resource: 'user', resourceId: id, ip: request.ip });
    return { ok: true };
  });

  fastify.post('/api/v1/admin/users/:id/activate', { preHandler: admin }, async (request) => {
    const { id } = request.params as { id: string };
    const user = await db.user.findUnique({ where: { id } });
    if (!user) throw notFound('User not found');
    await db.user.update({ where: { id }, data: { status: 'ACTIVE' } });
    await audit(db, { userId: request.user?.id, action: 'admin.users.activate', resource: 'user', resourceId: id, ip: request.ip });
    return { ok: true };
  });

  fastify.post('/api/v1/admin/users/:id/roles', { preHandler: admin }, async (request) => {
    const { id } = request.params as { id: string };
    const body = parseBody(assignRoleSchema, request);
    const user = await db.user.findUnique({ where: { id } });
    if (!user) throw notFound('User not found');
    const role = await db.role.findUnique({ where: { name: body.role } });
    if (!role) throw badRequest(`Unknown role: ${body.role}`);
    await db.userRole.deleteMany({ where: { userId: id } });
    await db.userRole.create({ data: { userId: id, roleId: role.id } });
    await audit(db, { userId: request.user?.id, action: 'admin.users.set-role', resource: 'user', resourceId: id, meta: { role: body.role }, ip: request.ip });
    return { ok: true, role: body.role };
  });

  fastify.get('/api/v1/admin/audit-logs', { preHandler: admin }, async (request) => {
    const q = parseQuery(auditQuery, request);
    const where = { userId: q.userId, action: q.action, resource: q.resource };
    const [logs, total] = await Promise.all([
      db.auditLog.findMany({ where, skip: (q.page - 1) * q.pageSize, take: q.pageSize, orderBy: { createdAt: 'desc' } }),
      db.auditLog.count({ where }),
    ]);
    return { logs, total, page: q.page, pageSize: q.pageSize };
  });

  fastify.get('/api/v1/admin/system-settings', { preHandler: admin }, async () => {
    const settings = await db.systemSetting.findMany();
    return { settings: Object.fromEntries(settings.map((s) => [s.key, s.value])) };
  });

  fastify.patch('/api/v1/admin/system-settings', { preHandler: admin }, async (request) => {
    const body = parseBody(patchSettingsSchema, request);
    const updatedBy = request.user?.id ?? null;
    for (const [key, value] of Object.entries(body.settings)) {
      await db.systemSetting.upsert({
        where: { key },
        update: { value, updatedBy },
        create: { key, value, updatedBy },
      });
    }
    await audit(db, { userId: updatedBy, action: 'admin.settings.update', resource: 'system-setting', meta: { keys: Object.keys(body.settings) }, ip: request.ip });
    return { ok: true, settings: body.settings };
  });
}
