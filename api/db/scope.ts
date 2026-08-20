// api/db/scope.ts
//
// Scoped DB helper — every tenant-bearing query MUST go through this.
// It enforces:
//   1. tenant isolation  (tenant_id = ctx.tenantId, a Clerk org_id)
//   2. soft-delete filter (deleted_at IS NULL) on opt-in tables
//
// TABLE_SCOPE registry (project_conventions §6): every table in
// drizzle/schema.ts MUST have an entry, added in the same commit as the table.
//
// DEVIATION from the sharpmoney scaffold, decided in decisions §12.9:
// `conditions()` on an unregistered table THROWS instead of returning
// sql`true`. A forgotten registry entry is a dev-time crash, not a silent
// cross-tenant leak. `lov` tables throw too — they are reachable only through
// lovConditions(), which is the whole point of the separate scope type.

import { eq, and, isNull, or, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { listOfValues } from "../../drizzle/schema";

type ScopeType =
  | { type: "tenant"; softDelete: boolean }
  | { type: "global"; softDelete: boolean }
  | { type: "none" }
  | { type: "lov" };

export const TABLE_SCOPE: Record<string, ScopeType> = {
  // Identity + authorization. Rows carry tenant_id, but the context lookup
  // resolves them BEFORE a tenant is known — filtering here would be circular.
  users: { type: "none" },

  // Shared dictionary — system rows (tenant_id IS NULL) + tenant rows.
  // Reachable only via lovConditions().
  list_of_values: { type: "lov" },

  // Tenant-scoped tables
  tenant_values: { type: "tenant", softDelete: true },

  // Audit trail (tenant-scoped, append-only — no soft-delete)
  audit_logs: { type: "tenant", softDelete: false },
};

type ScopeOptions = {
  tenantId?: string; // Optional for system-only LOV queries
  includeDeleted?: boolean; // Override soft-delete filter
};

type LovScopeMode = "system" | "tenant" | "combined";

type LovQuery = {
  type: string;
  mode?: LovScopeMode;
  includeDeleted?: boolean;
};

/** Internal: narrow `SQL | undefined` to `SQL`. Throws on undefined. */
function requireSql(result: SQL | undefined): SQL {
  if (result === undefined) {
    throw new Error("drizzle-orm and()/or() returned undefined unexpectedly");
  }
  return result;
}

/** Internal: does this tenantId qualify as "present and non-empty"? */
function hasTenant(tenantId: string | undefined): tenantId is string {
  return tenantId !== undefined && tenantId.length > 0;
}

/** Internal: read the physical table name off a drizzle table object. */
function tableNameOf(table: PgTable): string {
  const tableRecord = table as unknown as Record<string | symbol, unknown>;
  const tableInternal = tableRecord["_"] as { name: string } | undefined;
  return (
    (tableRecord[Symbol.for("drizzle:Name")] as string | undefined) ?? tableInternal?.name ?? ""
  );
}

export type ScopedDb = {
  readonly tenantId: string | undefined;
  conditions<T extends PgTable>(table: T): SQL;
  lovConditions(query: LovQuery): SQL;
  withTenant<T extends Record<string, unknown>>(data: T): T & { tenantId: string };
};

export function createScopedDb(options: ScopeOptions = {}): ScopedDb {
  const { tenantId, includeDeleted = false } = options;

  return {
    tenantId,

    /**
     * Get base conditions for a table.
     *
     * Throws when the table has no TABLE_SCOPE entry, or when it is registered
     * as `lov` (LOV rows are read through lovConditions). `none` tables — the
     * pre-tenant lookup tables — return sql`true` by design.
     */
    conditions<T extends PgTable>(table: T): SQL {
      const tableName = tableNameOf(table);
      const config = TABLE_SCOPE[tableName];

      if (config === undefined) {
        throw new Error(
          `TABLE_SCOPE: no entry for table "${tableName.length > 0 ? tableName : "<unknown>"}". ` +
            `Register it in api/db/scope.ts before querying it (decisions §12.9).`,
        );
      }

      if (config.type === "lov") {
        throw new Error(
          `TABLE_SCOPE: "${tableName}" is registered as 'lov' — use lovConditions(), not conditions().`,
        );
      }

      if (config.type === "none") {
        return sql`true`;
      }

      const columns = table as unknown as Record<string, unknown>;
      const conditions: SQL[] = [];

      // Tenant filter. A tenant-scoped table with no (or empty) tenantId
      // must never silently degrade to an unscoped/weaker read — that is a
      // cross-tenant leak. Throw instead (decisions §2 / §12.9).
      if (config.type === "tenant") {
        if (!hasTenant(tenantId)) {
          throw new Error(
            `TABLE_SCOPE: tenantId is required to query "${tableName}" (a tenant-scoped table). ` +
              `Refusing to build a weaker filter — pass a non-empty tenantId.`,
          );
        }
        conditions.push(eq(columns["tenantId"] as SQL, tenantId));
      }

      // Soft-delete filter
      if (config.softDelete && !includeDeleted && "deletedAt" in table) {
        conditions.push(isNull(columns["deletedAt"] as SQL));
      }

      // `and(...)` returns undefined when every arg is undefined — reachable
      // only for a `global` table with softDelete:false, which has no filter.
      return and(...conditions) ?? sql`true`;
    },

    /**
     * LOV-specific conditions. type is REQUIRED; type-less queries are a foot-gun.
     * - 'system'   → only system values (tenant_id IS NULL).
     * - 'tenant'   → only this org's custom values.
     * - 'combined' → both (default, for UI dropdowns).
     * Soft-delete (deleted_at IS NULL) is applied unless includeDeleted is set.
     */
    lovConditions(query: LovQuery): SQL {
      const { type, mode = "combined", includeDeleted: includeDel = false } = query;

      const baseConditions: SQL[] = [eq(listOfValues.type, type)];
      if (!includeDel) {
        baseConditions.push(isNull(listOfValues.deletedAt));
      }

      if (mode === "system") {
        return requireSql(and(...baseConditions, isNull(listOfValues.tenantId)));
      }

      if (!hasTenant(tenantId)) {
        throw new Error("tenantId required for tenant/combined LOV queries");
      }

      if (mode === "tenant") {
        return requireSql(and(...baseConditions, eq(listOfValues.tenantId, tenantId)));
      }

      return requireSql(
        and(
          ...baseConditions,
          or(eq(listOfValues.tenantId, tenantId), isNull(listOfValues.tenantId)),
        ),
      );
    },

    /**
     * Insert with tenantId auto-injection. Throws when the table is not
     * registered as tenant-scoped — the write-side twin of `conditions()`.
     */
    withTenant<T extends Record<string, unknown>>(data: T): T & { tenantId: string } {
      if (!hasTenant(tenantId)) {
        throw new Error("tenantId required for withTenant");
      }
      return { ...data, tenantId };
    },
  };
}

/**
 * Write-side registry guard. Call before any scoped INSERT/UPDATE/DELETE so a
 * table missing from TABLE_SCOPE fails loudly instead of writing unscoped.
 */
export function assertTenantScoped(table: PgTable, verb: string): void {
  const tableName = tableNameOf(table);
  const config = TABLE_SCOPE[tableName];
  if (config === undefined) {
    throw new Error(
      `TABLE_SCOPE: no entry for table "${tableName.length > 0 ? tableName : "<unknown>"}" (${verb}). ` +
        `Register it in api/db/scope.ts before writing to it (decisions §12.9).`,
    );
  }
  if (config.type === "lov") {
    throw new Error(
      `TABLE_SCOPE: "${tableName}" is registered as 'lov' — ${verb} must go through the LOV-CRUD core.`,
    );
  }
  if (config.type === "none") {
    throw new Error(
      `TABLE_SCOPE: "${tableName}" is registered as 'none' — ${verb} must go through an explicit, ` +
        `dedicated query, not the scoped write helpers. (e.g. users: provisioned manually, never via ` +
        `ctx.db.create/update/softDelete/restore.)`,
    );
  }
}

/** Static helper for system-only LOV queries (no tenantId needed). type is required. */
export function lovSystemConditions(type: string): SQL {
  return requireSql(
    and(eq(listOfValues.type, type), isNull(listOfValues.tenantId), isNull(listOfValues.deletedAt)),
  );
}

/**
 * System-fields helper. Stamps the four system audit columns onto a payload
 * based on the action kind. Use from every protectedProcedure mutation.
 *
 * - 'create' → stamps created_*, last_upd_* with the actor.
 * - 'update' → stamps last_upd_* only.
 * - 'delete' → stamps deleted_*, last_upd_*. Caller passes through deletedAt.
 */
type SystemFieldsCtx = { userId: string };
type SystemFieldsKind = "create" | "update" | "delete" | "restore";

export function withSystemFields<T extends Record<string, unknown>>(
  ctx: SystemFieldsCtx,
  kind: SystemFieldsKind,
  payload: T,
): T & Record<string, unknown> {
  const now = new Date().toISOString();
  if (kind === "create") {
    return {
      ...payload,
      createdAt: now,
      createdBy: ctx.userId,
      lastUpdAt: now,
      lastUpdBy: ctx.userId,
    };
  }
  if (kind === "delete") {
    return {
      ...payload,
      deletedAt: now,
      deletedBy: ctx.userId,
      lastUpdAt: now,
      lastUpdBy: ctx.userId,
    };
  }
  if (kind === "restore") {
    return {
      ...payload,
      deletedAt: null,
      deletedBy: null,
      lastUpdAt: now,
      lastUpdBy: ctx.userId,
    };
  }
  // update
  return {
    ...payload,
    lastUpdAt: now,
    lastUpdBy: ctx.userId,
  };
}
