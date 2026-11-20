// test/fake-db.ts — in-memory Db implementation for Vitest.
// Seeds the same roles/permissions as prisma/migrations/0001_init.
import { randomUUID } from 'node:crypto';
import type {
  ApiKeyRow, AuditRow, Db, ResetTokenRow, RoleRow, SessionRow, SystemSettingRow, UserRow,
} from '../lib/db.js';

const ROLE_SEED: Array<[string, string]> = [
  ['SUPER_ADMIN', 'Full control'],
  ['ADMIN', 'Admin'],
  ['MANAGER', 'Manage users and providers'],
  ['USER', 'Standard user'],
  ['VIEWER', 'Read-only'],
];

const PERMISSION_SEED = [
  'providers:create', 'providers:read', 'providers:update', 'providers:delete',
  'models:read', 'models:update',
  'users:read', 'users:create', 'users:update', 'users:suspend',
  'credits:adjust', 'settings:read', 'settings:update', 'audit:read',
  'api-keys:create', 'api-keys:read', 'api-keys:revoke',
  'routing:read', 'routing:update', 'usage:read', 'billing:read',
];

export class FakeDb implements Db {
  users: UserRow[] = [];
  userRoles: Array<{ userId: string; roleId: string }> = [];
  roles: RoleRow[] = ROLE_SEED.map(([name, description]) => ({ id: randomUUID(), name, description }));
  permissions: Array<{ id: string; name: string }> = PERMISSION_SEED.map((name) => ({ id: randomUUID(), name }));
  rolePermissions: Array<{ roleId: string; permissionId: string }> = [];
  sessions: SessionRow[] = [];
  resetTokens: ResetTokenRow[] = [];
  apiKeys: ApiKeyRow[] = [];
  auditLogs: AuditRow[] = [];
  settings: SystemSettingRow[] = [];
  dbUp = true;

  async ping(): Promise<boolean> {
    return this.dbUp;
  }

  user = {
    findUnique: async ({ where }: { where: { id?: string; email?: string } }): Promise<UserRow | null> =>
      this.users.find((u) => (where.id ? u.id === where.id : true) && (where.email ? u.email === where.email : true)) ?? null,
    findMany: async (args?: { where?: { status?: string; emailContains?: string }; skip?: number; take?: number }): Promise<UserRow[]> => {
      let out = [...this.users];
      if (args?.where?.status) out = out.filter((u) => u.status === args.where?.status);
      if (args?.where?.emailContains) out = out.filter((u) => u.email.includes(args.where?.emailContains as string));
      out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      if (args?.skip) out = out.slice(args.skip);
      if (args?.take !== undefined) out = out.slice(0, args.take);
      return out;
    },
    count: async (args?: { where?: { status?: string; emailContains?: string } }): Promise<number> => {
      let out = [...this.users];
      if (args?.where?.status) out = out.filter((u) => u.status === args.where?.status);
      if (args?.where?.emailContains) out = out.filter((u) => u.email.includes(args.where?.emailContains as string));
      return out.length;
    },
    create: async ({ data }: { data: { email: string; passwordHash: string; name?: string | null } }): Promise<UserRow> => {
      const now = new Date();
      const row: UserRow = { id: randomUUID(), email: data.email, passwordHash: data.passwordHash, name: data.name ?? null, totpSecret: null, totpEnabled: false, status: 'ACTIVE', createdAt: now, updatedAt: now };
      this.users.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<UserRow> }): Promise<UserRow> => {
      const row = this.users.find((u) => u.id === where.id);
      if (!row) throw new Error('User not found');
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    },
  };

  userRole = {
    create: async ({ data }: { data: { userId: string; roleId: string } }) => {
      this.userRoles.push(data);
      return data;
    },
    findMany: async ({ where }: { where: { userId?: string } }) =>
      this.userRoles.filter((r) => (where.userId ? r.userId === where.userId : true)),
    deleteMany: async ({ where }: { where: { userId: string; roleId?: string } }) => {
      const before = this.userRoles.length;
      this.userRoles = this.userRoles.filter((r) => !(r.userId === where.userId && (!where.roleId || r.roleId === where.roleId)));
      return { count: before - this.userRoles.length };
    },
  };

  role = {
    findUnique: async ({ where }: { where: { id?: string; name?: string } }): Promise<RoleRow | null> =>
      this.roles.find((r) => (where.id ? r.id === where.id : true) && (where.name ? r.name === where.name : true)) ?? null,
    findMany: async (): Promise<RoleRow[]> => [...this.roles],
    create: async ({ data }: { data: { name: string; description?: string | null } }): Promise<RoleRow> => {
      const row: RoleRow = { id: randomUUID(), name: data.name, description: data.description ?? null };
      this.roles.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<RoleRow> }): Promise<RoleRow> => {
      const row = this.roles.find((r) => r.id === where.id);
      if (!row) throw new Error('Role not found');
      Object.assign(row, data);
      return row;
    },
  };

  rolePermission = {
    findMany: async ({ where }: { where: { roleId: string } }) => this.rolePermissions.filter((r) => r.roleId === where.roleId),
    create: async ({ data }: { data: { roleId: string; permissionId: string } }) => {
      this.rolePermissions.push(data);
      return data;
    },
    deleteMany: async ({ where }: { where: { roleId: string } }) => {
      const before = this.rolePermissions.length;
      this.rolePermissions = this.rolePermissions.filter((r) => r.roleId !== where.roleId);
      return { count: before - this.rolePermissions.length };
    },
  };

  permission = {
    findMany: async (args?: { where?: { name?: { in: string[] } } }) => {
      if (args?.where?.name?.in) return this.permissions.filter((p) => (args.where?.name?.in as string[]).includes(p.name));
      return [...this.permissions];
    },
    findUnique: async ({ where }: { where: { name: string } }) => this.permissions.find((p) => p.name === where.name) ?? null,
  };

  userSession = {
    findUnique: async ({ where }: { where: { id?: string; tokenHash?: string } }): Promise<SessionRow | null> =>
      this.sessions.find((s) => (where.id ? s.id === where.id : true) && (where.tokenHash ? s.tokenHash === where.tokenHash : true)) ?? null,
    findMany: async ({ where }: { where: { userId: string } }) => this.sessions.filter((s) => s.userId === where.userId),
    create: async ({ data }: { data: { userId: string; tokenHash: string; userAgent?: string | null; ip?: string | null; expiresAt: Date } }): Promise<SessionRow> => {
      const row: SessionRow = { id: randomUUID(), userId: data.userId, tokenHash: data.tokenHash, userAgent: data.userAgent ?? null, ip: data.ip ?? null, expiresAt: data.expiresAt, revokedAt: null };
      this.sessions.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: { revokedAt: Date | null } }): Promise<SessionRow> => {
      const row = this.sessions.find((s) => s.id === where.id);
      if (!row) throw new Error('Session not found');
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }: { where: { userId: string }; data: { revokedAt: Date } }) => {
      let count = 0;
      for (const s of this.sessions.filter((s) => s.userId === where.userId)) {
        s.revokedAt = data.revokedAt;
        count += 1;
      }
      return { count };
    },
  };

  passwordResetToken = {
    findUnique: async ({ where }: { where: { tokenHash: string } }): Promise<ResetTokenRow | null> =>
      this.resetTokens.find((t) => t.tokenHash === where.tokenHash) ?? null,
    create: async ({ data }: { data: { userId: string; tokenHash: string; expiresAt: Date } }): Promise<ResetTokenRow> => {
      const row: ResetTokenRow = { id: randomUUID(), userId: data.userId, tokenHash: data.tokenHash, expiresAt: data.expiresAt, usedAt: null, createdAt: new Date() };
      this.resetTokens.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: { usedAt: Date } }): Promise<ResetTokenRow> => {
      const row = this.resetTokens.find((t) => t.id === where.id);
      if (!row) throw new Error('Reset token not found');
      Object.assign(row, data);
      return row;
    },
  };

  apiKey = {
    findMany: async ({ where }: { where: { userId: string } }) => this.apiKeys.filter((k) => k.userId === where.userId),
    findUnique: async ({ where }: { where: { id: string } }): Promise<ApiKeyRow | null> => this.apiKeys.find((k) => k.id === where.id) ?? null,
    create: async ({ data }: { data: { userId: string; name: string; keyHash: string; keyPrefix: string; expiresAt?: Date | null; restrictions?: unknown } }): Promise<ApiKeyRow> => {
      const row: ApiKeyRow = { id: randomUUID(), userId: data.userId, name: data.name, keyHash: data.keyHash, keyPrefix: data.keyPrefix, expiresAt: data.expiresAt ?? null, lastUsedAt: null, revokedAt: null, restrictions: data.restrictions ?? null, createdAt: new Date() };
      this.apiKeys.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<ApiKeyRow> }): Promise<ApiKeyRow> => {
      const row = this.apiKeys.find((k) => k.id === where.id);
      if (!row) throw new Error('API key not found');
      Object.assign(row, data);
      return row;
    },
  };

  auditLog = {
    create: async ({ data }: { data: { userId?: string | null; action: string; resource: string; resourceId?: string | null; meta?: unknown; ip?: string | null } }): Promise<AuditRow> => {
      const row: AuditRow = { id: randomUUID(), userId: data.userId ?? null, action: data.action, resource: data.resource, resourceId: data.resourceId ?? null, meta: data.meta ?? null, ip: data.ip ?? null, createdAt: new Date() };
      this.auditLogs.push(row);
      return row;
    },
    findMany: async (args?: { where?: { userId?: string; action?: string; resource?: string }; skip?: number; take?: number }): Promise<AuditRow[]> => {
      let out = [...this.auditLogs];
      if (args?.where?.userId) out = out.filter((l) => l.userId === args.where?.userId);
      if (args?.where?.action) out = out.filter((l) => l.action === args.where?.action);
      if (args?.where?.resource) out = out.filter((l) => l.resource === args.where?.resource);
      out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      if (args?.skip) out = out.slice(args.skip);
      if (args?.take !== undefined) out = out.slice(0, args.take);
      return out;
    },
    count: async (args?: { where?: { userId?: string; action?: string; resource?: string } }): Promise<number> => {
      let out = [...this.auditLogs];
      if (args?.where?.userId) out = out.filter((l) => l.userId === args.where?.userId);
      if (args?.where?.action) out = out.filter((l) => l.action === args.where?.action);
      if (args?.where?.resource) out = out.filter((l) => l.resource === args.where?.resource);
      return out.length;
    },
  };

  systemSetting = {
    findMany: async (): Promise<SystemSettingRow[]> => [...this.settings],
    upsert: async ({ where, update, create }: { where: { key: string }; update: { value: unknown; updatedBy?: string | null }; create: { key: string; value: unknown; updatedBy?: string | null } }): Promise<SystemSettingRow> => {
      const existing = this.settings.find((s) => s.key === where.key);
      if (existing) {
        existing.value = update.value;
        existing.updatedBy = update.updatedBy ?? null;
        return existing;
      }
      const row: SystemSettingRow = { id: randomUUID(), key: create.key, value: create.value, updatedBy: create.updatedBy ?? null };
      this.settings.push(row);
      return row;
    },
  };
}
