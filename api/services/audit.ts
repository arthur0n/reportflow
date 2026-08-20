// api/services/audit.ts
//
// Generic audit-log writer. Every mutating procedure that changes
// tenant-visible data calls writeAuditEntry inside its DB transaction.
//
// - For 'update': diff `before` and `after`; emit one row per changed field.
// - For other actions: emit a single row with field_name=null.
//
// entity_type aligns with list_of_values.type vocabulary (UPPER_SNAKE_CASE).

import { auditLogs } from "../../drizzle/schema";
import { db as defaultDb } from "../db/client";

export type AuditAction =
  | "create"
  | "update"
  | "delete"
  | "restore"
  | "reclassify"
  // Tenant LOV row → system row. Triggered by admin manual promote OR by an
  // auto-promote when a second tenant tries to create the same code.
  | "promote_to_system"
  // Multi-tenancy lifecycle events (UPPER_SNAKE matches entity_type vocabulary).
  | "TENANT_SWITCH"
  | "MEMBERSHIP_INVITE"
  | "MEMBERSHIP_ACCEPT"
  | "MEMBERSHIP_REVOKE"
  | "MEMBERSHIP_ROLE_CHANGE";

type Tx = Parameters<Parameters<typeof defaultDb.transaction>[0]>[0];
type DbLike = typeof defaultDb | Tx;

type AuditCtx = {
  tenantId: string;
  userId: string;
};

type AuditArgs = {
  ctx: AuditCtx;
  entityType: string;
  entityId: string;
  action: AuditAction;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  /** Provide an active drizzle tx to keep the audit write atomic with the mutation. */
  tx?: DbLike;
};

function stringify(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value);
}

function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Array<{ fieldName: string; oldValue: string | null; newValue: string | null }> {
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes: Array<{ fieldName: string; oldValue: string | null; newValue: string | null }> =
    [];
  for (const field of fields) {
    const oldValue = stringify(before[field]);
    const newValue = stringify(after[field]);
    if (oldValue !== newValue) {
      changes.push({ fieldName: field, oldValue, newValue });
    }
  }
  return changes;
}

export async function writeAuditEntry(args: AuditArgs): Promise<void> {
  const dbHandle = args.tx ?? defaultDb;
  const { ctx, entityType, entityId, action, before, after } = args;

  const baseRow = {
    tenantId: ctx.tenantId,
    entityType,
    entityId,
    action,
    createdBy: ctx.userId,
    lastUpdBy: ctx.userId,
  };

  if (action === "update" && before && after) {
    const changes = diffFields(before, after);
    if (changes.length === 0) return;
    await dbHandle.insert(auditLogs).values(
      changes.map((change) => ({
        ...baseRow,
        fieldName: change.fieldName,
        oldValue: change.oldValue,
        newValue: change.newValue,
      })),
    );
    return;
  }

  await dbHandle.insert(auditLogs).values({
    ...baseRow,
    fieldName: null,
    oldValue: action === "create" ? null : (stringify(before) ?? null),
    newValue: action === "delete" ? null : (stringify(after) ?? null),
  });
}
