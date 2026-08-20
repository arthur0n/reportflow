// api/db/scope.ts
//
// Scoped DB helper — every tenant-bearing query MUST go through this.
// It enforces:
//   1. tenant isolation  (tenant_id = ctx.tenantId)
//   2. soft-delete filter (deleted_at IS NULL) on opt-in tables
//
// Ported from mizplace. Add a new TABLE_SCOPE entry every time a table is
// added to drizzle/schema.ts — that's the lever that keeps the safety rail
// in place as the schema grows.

import { eq, and, isNull, or, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { listOfValues } from "../../drizzle/schema";

type ScopeType =
  | { type: "tenant"; softDelete: boolean }
  | { type: "global"; softDelete: boolean }
  | { type: "none" }
  | { type: "lov" };

const TABLE_SCOPE: Record<string, ScopeType> = {
  // Identity (tenant-independent)
  users: { type: "global", softDelete: false },
  list_of_values: { type: "lov" },

  // Tenants and per-tenant grants
  tenants: { type: "global", softDelete: true },
  memberships: { type: "tenant", softDelete: true },

  // Tenant-scoped domain tables
  tenant_values: { type: "tenant", softDelete: true },
  transactions: { type: "tenant", softDelete: true },
  transaction_recurrences: { type: "tenant", softDelete: true },

  // Audit trail (tenant-scoped, append-only — no soft-delete)
  audit_logs: { type: "tenant", softDelete: false },

  // Import tables (status-machine lifecycle, no soft-delete)
  statement_imports: { type: "tenant", softDelete: false },
  statement_import_rows: { type: "tenant", softDelete: false },
  statement_import_events: { type: "tenant", softDelete: false },

  // G-02 conciliation ledger — soft-delete = user ignored the row
  acquirer_sales: { type: "tenant", softDelete: true },
  // G-02 match links — hard-deleted on unmatch, audit_logs keeps history
  acquirer_sale_settlements: { type: "tenant", softDelete: false },

  // Import auto-match engine
  // Decisions: append-only learning log, tenant-scoped.
  import_match_decisions: { type: "tenant", softDelete: false },
  // Rules: dual-scope (system + tenant) like list_of_values, so the RuleMatcher
  // composes its own (tenant_id IS NULL OR tenant_id = ?) filter rather than
  // having scope.conditions() apply a single-tenant rule.
  import_match_rules: { type: "lov" },

  // Dev tooling (shared across all users — temporary, remove post-MVP)
  questions_and_feedback: { type: "global", softDelete: true },
};

type ScopeOptions = {
  tenantId?: string; // Optional for system-only LOV queries
  includeDeleted?: boolean; // Override soft-delete filter
};

type LovScopeMode = "system" | "tenant" | "combined";

type LovQuery = {
  type: string;
  mode?: LovScopeMode;
  // Required for combined-mode reads — filters system rows by audience
  // (category IS NULL OR category = tenantIndustry). Ignored otherwise.
  tenantIndustry?: string;
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
     * ALWAYS returns valid SQL (`sql\`true\`` if no conditions apply).
     */
    conditions<T extends PgTable>(table: T): SQL {
      const tableRecord = table as Record<string | symbol, unknown>;
      const tableInternal = tableRecord["_"] as { name: string } | undefined;
      const tableName =
        (tableRecord[Symbol.for("drizzle:Name")] as string | undefined) ??
        tableInternal?.name ??
        "";
      const config = TABLE_SCOPE[tableName];

      if (config === undefined || config.type === "none" || config.type === "lov") {
        return sql`true`;
      }

      const columns = table as unknown as Record<string, unknown>;
      const conditions: SQL[] = [];

      // Tenant filter
      if (config.type === "tenant" && hasTenant(tenantId)) {
        conditions.push(eq(columns["tenantId"] as SQL, tenantId));
      }

      // Soft-delete filter
      if ("softDelete" in config && config.softDelete && !includeDeleted && "deletedAt" in table) {
        conditions.push(isNull(columns["deletedAt"] as SQL));
      }

      // `and(...)` may return undefined if every arg is undefined, which
      // we've ruled out above. The `?? sql\`true\`` keeps types clean and
      // serves as an unreachable safety net.
      return and(...conditions) ?? sql`true`;
    },

    /**
     * LOV-specific conditions. type is REQUIRED; type-less queries are a foot-gun.
     * - 'system'   → only system values (tenant_id IS NULL); audience filter NOT applied
     *               (admin tooling needs unrestricted system reads).
     * - 'tenant'   → only this tenant's custom values.
     * - 'combined' → tenant rows OR system rows visible to this tenant's industry
     *               (default, for UI dropdowns). Combined mode requires `tenantIndustry`
     *               on the query — throws if missing.
     * Soft-delete (deleted_at IS NULL) is applied unless includeDeleted is set.
     */
    lovConditions(query: LovQuery): SQL {
      const { type, mode = "combined", tenantIndustry, includeDeleted: includeDel = false } = query;

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

      if (tenantIndustry === undefined || tenantIndustry.length === 0) {
        throw new Error("tenantIndustry required for combined LOV queries");
      }

      return requireSql(
        and(
          ...baseConditions,
          or(
            eq(listOfValues.tenantId, tenantId),
            and(
              isNull(listOfValues.tenantId),
              or(isNull(listOfValues.category), eq(listOfValues.category, tenantIndustry)),
            ),
          ),
        ),
      );
    },

    /**
     * Insert with tenantId auto-injection.
     * Only use with tenant-scoped tables.
     */
    withTenant<T extends Record<string, unknown>>(data: T): T & { tenantId: string } {
      if (!hasTenant(tenantId)) {
        throw new Error("tenantId required for withTenant");
      }
      return { ...data, tenantId };
    },
  };
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
