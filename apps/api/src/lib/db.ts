// lib/db.ts — narrow Db interface used by Agent 1 modules.
// Why an interface, not PrismaClient directly: tests run with an in-memory
// fake (no Postgres in this VM) and the real client is wired in app.ts via
// createDb(). The real PrismaClient is structurally compatible; createDb()
// casts it. Every query here is scoped by userId/ownerId (user isolation).
export type UserStatus = 'ACTIVE' | 'SUSPENDED';

export interface UserRow {
  id: string;
  email: string;
  passwordHash: string;
  name: string | null;
  totpSecret: string | null;
  totpEnabled: boolean;
  status: UserStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionRow {
  id: string;
  userId: string;
  tokenHash: string;
  userAgent: string | null;
  ip: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface ApiKeyRow {
  id: string;
  userId: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  restrictions: unknown;
  createdAt: Date;
}

export interface AuditRow {
  id: string;
  userId: string | null;
  action: string;
  resource: string;
  resourceId: string | null;
  meta: unknown;
  ip: string | null;
  createdAt: Date;
}

export interface RoleRow {
  id: string;
  name: string;
  description: string | null;
}

export interface SystemSettingRow {
  id: string;
  key: string;
  value: unknown;
  updatedBy: string | null;
}

export interface ResetTokenRow {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export interface UserListWhere {
  status?: UserStatus;
  emailContains?: string;
}

export interface Db {
  ping(): Promise<boolean>;
  user: {
    findUnique(args: { where: { id?: string; email?: string } }): Promise<UserRow | null>;
    findMany(args?: {
      where?: UserListWhere;
      skip?: number;
      take?: number;
      orderBy?: { createdAt: 'asc' | 'desc' };
    }): Promise<UserRow[]>;
    count(args?: { where?: UserListWhere }): Promise<number>;
    create(args: { data: { email: string; passwordHash: string; name?: string | null } }): Promise<UserRow>;
    update(args: {
      where: { id: string };
      data: Partial<Pick<UserRow, 'name' | 'passwordHash' | 'status' | 'totpSecret' | 'totpEnabled'>>;
    }): Promise<UserRow>;
  };
  userRole: {
    create(args: { data: { userId: string; roleId: string } }): Promise<{ userId: string; roleId: string }>;
    findMany(args: { where: { userId?: string } }): Promise<Array<{ userId: string; roleId: string }>>;
    deleteMany(args: { where: { userId: string; roleId?: string } }): Promise<{ count: number }>;
  };
  role: {
    findUnique(args: { where: { id?: string; name?: string } }): Promise<RoleRow | null>;
    findMany(): Promise<RoleRow[]>;
    create(args: { data: { name: string; description?: string | null } }): Promise<RoleRow>;
    update(args: { where: { id: string }; data: Partial<Pick<RoleRow, 'name' | 'description'>> }): Promise<RoleRow>;
  };
  rolePermission: {
    findMany(args: { where: { roleId: string } }): Promise<Array<{ roleId: string; permissionId: string }>>;
    create(args: { data: { roleId: string; permissionId: string } }): Promise<{ roleId: string; permissionId: string }>;
    deleteMany(args: { where: { roleId: string } }): Promise<{ count: number }>;
  };
  permission: {
    findMany(args?: { where?: { name?: { in: string[] } } }): Promise<Array<{ id: string; name: string }>>;
    findUnique(args: { where: { name: string } }): Promise<{ id: string; name: string } | null>;
  };
  userSession: {
    findUnique(args: { where: { id?: string; tokenHash?: string } }): Promise<SessionRow | null>;
    findFirst(args: { where: { id?: string; tokenHash?: string } }): Promise<SessionRow | null>;
    findMany(args: { where: { userId: string } }): Promise<SessionRow[]>;
    create(args: {
      data: { userId: string; tokenHash: string; userAgent?: string | null; ip?: string | null; expiresAt: Date };
    }): Promise<SessionRow>;
    update(args: { where: { id: string }; data: { revokedAt: Date | null } }): Promise<SessionRow>;
    updateMany(args: { where: { userId: string }; data: { revokedAt: Date } }): Promise<{ count: number }>;
  };
  passwordResetToken: {
    findUnique(args: { where: { tokenHash: string } }): Promise<ResetTokenRow | null>;
    create(args: { data: { userId: string; tokenHash: string; expiresAt: Date } }): Promise<ResetTokenRow>;
    update(args: { where: { id: string }; data: { usedAt: Date } }): Promise<ResetTokenRow>;
  };
  apiKey: {
    findMany(args?: { where?: { userId?: string; keyHash?: string } }): Promise<ApiKeyRow[]>;
    findUnique(args: { where: { id: string } }): Promise<ApiKeyRow | null>;
    create(args: {
      data: { userId: string; name: string; keyHash: string; keyPrefix: string; expiresAt?: Date | null; restrictions?: unknown };
    }): Promise<ApiKeyRow>;
    update(args: { where: { id: string }; data: Partial<Pick<ApiKeyRow, 'revokedAt' | 'lastUsedAt'>> }): Promise<ApiKeyRow>;
  };
  auditLog: {
    create(args: {
      data: { userId?: string | null; action: string; resource: string; resourceId?: string | null; meta?: unknown; ip?: string | null };
    }): Promise<AuditRow>;
    findMany(args?: {
      where?: { userId?: string; action?: string; resource?: string };
      skip?: number;
      take?: number;
      orderBy?: { createdAt: 'asc' | 'desc' };
    }): Promise<AuditRow[]>;
    count(args?: { where?: { userId?: string; action?: string; resource?: string } }): Promise<number>;
  };
  systemSetting: {
    findMany(): Promise<SystemSettingRow[]>;
    upsert(args: { where: { key: string }; update: { value: unknown; updatedBy?: string | null }; create: { key: string; value: unknown; updatedBy?: string | null } }): Promise<SystemSettingRow>;
  };
}

/**
 * Build the real Db from PrismaClient. Dynamic import keeps `tsc` working
 * even before `prisma generate` has run (tests use a fake instead).
 */
export async function createDb(): Promise<Db> {
  const { PrismaClient } = (await import('@prisma/client')) as unknown as {
    PrismaClient: new () => {
      $queryRaw: (strings: TemplateStringsArray) => Promise<unknown>;
    } & Record<string, unknown>;
  };
  const prisma = new PrismaClient();
  const db = prisma as unknown as Db;
  // ping() is not a Prisma method — attach it.
  (db as unknown as Record<string, unknown>).ping = async (): Promise<boolean> => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  };
  return db;
}
