// lib/audit.ts — write an AuditLog row; never throws (audit must not break
// the request it records).
import type { Db } from './db.js';

export async function audit(
  db: Db,
  entry: { userId?: string | null; action: string; resource: string; resourceId?: string | null; meta?: unknown; ip?: string | null },
): Promise<void> {
  try {
    await db.auditLog.create({ data: entry });
  } catch {
    // Audit failure is logged by the caller if needed; never fail the request.
  }
}
