// api/db/scoped-client.ts
//
// The ctx.db handle protectedProcedure builds. CRUD verbs auto-apply tenant
// scoping and system-field stamping; complex queries opt into named escape
// hatches (raw, scope, lov) that are greppable in code review.
//
// createScopedDb is private to this file — every router consumes ctx.db,
// never the factory directly.
//
// Transaction-aware: every verb runs against a single `dbHandle` that
// defaults to the outer pool but can be re-bound onto a tx via
// `ctx.db.withTx(tx)` or `ctx.db.transaction((txDb, tx) => ...)`. Without
// this, calling ctx.db.* inside `db.transaction(...)` deadlocks on
// Lambda's max=1 pool because the verb reaches for the outer pool while
// the tx already holds the only connection.

import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { db } from "./client";
import {
  listOfValues,
  type memberships,
  type tenants,
  type tenantValues,
} from "../../drizzle/schema";
import { createScopedDb as createLegacyScope, withSystemFields } from "./scope";

// ---------------------------------------------------------------------------
// Type-level guards
// ---------------------------------------------------------------------------

type SystemFieldKey =
  | "id"
  | "tenantId"
  | "createdAt"
  | "createdBy"
  | "lastUpdAt"
  | "lastUpdBy"
  | "deletedAt"
  | "deletedBy";

/** Strips id, tenantId, and the six system-field columns from $inferInsert. */
export type CreateInput<T extends PgTable> = Omit<T["$inferInsert"], SystemFieldKey>;

/** Same key set as CreateInput, but partial — patches don't set every field. */
export type UpdateInput<T extends PgTable> = Partial<Omit<T["$inferInsert"], SystemFieldKey>>;

// Tagged subset of soft-deletable tables. Mirrors TABLE_SCOPE entries with
// softDelete:true — keeping this set alongside scope.ts buys type-level proof
// that ctx.db.softDelete(...) is only callable on tables that actually have
// deleted_at. A forgotten match is a compile error at the call site.
export type SoftDeletableTable =
  typeof tenants | typeof memberships | typeof tenantValues | typeof listOfValues;

/** A drizzle transaction handle (the arg passed into db.transaction's callback). */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Anything that exposes select / insert / update — either the pool or a tx. */
type DbOrTx = typeof db | Tx;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

type LovListQuery = {
  type: string;
  mode?: "system" | "tenant" | "combined";
};

export type ScopedDb = {
  list<T extends PgTable>(
    table: T,
    options?: { orderBy?: SQL | SQL[] },
  ): Promise<T["$inferSelect"][]>;
  byId<T extends PgTable>(table: T, id: string): Promise<T["$inferSelect"] | undefined>;
  create<T extends PgTable>(table: T, input: CreateInput<T>): Promise<T["$inferSelect"]>;
  update<T extends PgTable>(
    table: T,
    id: string,
    fields: UpdateInput<T>,
  ): Promise<T["$inferSelect"] | undefined>;
  softDelete<T extends SoftDeletableTable>(
    table: T,
    id: string,
  ): Promise<{ id: string } | undefined>;
  restore<T extends SoftDeletableTable>(
    table: T,
    id: string,
  ): Promise<T["$inferSelect"] | undefined>;
  /** LOV namespace — three modes, audience filter via tenantIndustry from closure. */
  lov: {
    list(query: LovListQuery): Promise<(typeof listOfValues.$inferSelect)[]>;
  };
  /**
   * Scoped WHERE clause for a table. Use with raw for joins / custom queries.
   * `includeDeleted: true` drops the soft-delete predicate but keeps the tenant
   * predicate — needed for aggregates that count active vs inactive rows.
   */
  scope<T extends PgTable>(table: T, options?: { includeDeleted?: boolean }): SQL;
  /**
   * Unscoped drizzle handle. Greppable escape hatch. Becomes the tx handle
   * inside `withTx` / `transaction`, so raw queries written in a tx body
   * stay on the same connection.
   */
  raw: DbOrTx;
  /**
   * Bind this scope onto a drizzle tx. Verbs on the returned ScopedDb
   * route through tx instead of the outer pool — required when calling
   * ctx.db.* inside `db.transaction(...)`.
   */
  withTx(tx: Tx): ScopedDb;
  /**
   * Open a transaction and run fn with a tx-bound ScopedDb. If already
   * inside a tx (i.e. this scope was built via withTx), the callback runs
   * on the existing tx — no nested SAVEPOINT.
   */
  transaction<T>(fn: (txDb: ScopedDb, tx: Tx) => Promise<T>): Promise<T>;
};

// Internal helper: read the `id` / `tenantId` columns off a generic table
// without giving up type safety at the call site.
function tableColumns(table: PgTable): Record<string, SQL> {
  return table as unknown as Record<string, SQL>;
}

// Cast helper for drizzle builder calls. `T extends PgTable` doesn't flow
// cleanly through drizzle's deeply-mapped insert/update types, so we widen
// to the bare PgTable inside the verb body and re-narrow on return.
function asTable(table: PgTable): PgTable {
  return table;
}

function buildLovNamespace(
  dbHandle: DbOrTx,
  scope: ReturnType<typeof createLegacyScope>,
  tenantIndustry: string,
): ScopedDb["lov"] {
  return {
    async list(query) {
      const mode = query.mode ?? "combined";
      const conditions =
        mode === "system"
          ? scope.lovConditions({ type: query.type, mode: "system" })
          : mode === "tenant"
            ? scope.lovConditions({ type: query.type, mode: "tenant" })
            : scope.lovConditions({ type: query.type, mode: "combined", tenantIndustry });
      const rows = await dbHandle.select().from(listOfValues).where(conditions);
      return rows;
    },
  };
}

type FactoryArgs = {
  userId: string;
  tenantId: string;
  tenantIndustry: string;
  dbHandle: DbOrTx;
};

type CrudVerbs = Pick<ScopedDb, "list" | "byId" | "create" | "update" | "softDelete" | "restore">;

function requireIdCol(table: PgTable, verb: string): SQL {
  const idCol = tableColumns(table)["id"];
  if (idCol === undefined) {
    throw new Error(`${verb}: table has no 'id' column`);
  }
  return idCol;
}

function buildCrudVerbs(args: {
  dbHandle: DbOrTx;
  userId: string;
  tenantId: string;
  scope: ReturnType<typeof createLegacyScope>;
  scopeWithDeleted: ReturnType<typeof createLegacyScope>;
}): CrudVerbs {
  const { dbHandle, userId, tenantId, scope, scopeWithDeleted } = args;
  return {
    async list(table, options) {
      const orderBy = options?.orderBy;
      let query = dbHandle.select().from(asTable(table)).where(scope.conditions(table)).$dynamic();
      if (Array.isArray(orderBy)) {
        query = query.orderBy(...orderBy);
      } else if (orderBy !== undefined) {
        query = query.orderBy(orderBy);
      }
      return await query;
    },

    async byId(table, id) {
      const idCol = requireIdCol(table, "byId");
      const rows = await dbHandle
        .select()
        .from(asTable(table))
        .where(and(eq(idCol, id), scope.conditions(table)))
        .limit(1);
      return rows[0];
    },

    async create(table, input) {
      const cols = tableColumns(table);
      const hasTenantCol = "tenantId" in cols;
      const payload = withSystemFields({ userId }, "create", input as Record<string, unknown>);
      const finalPayload = hasTenantCol ? { ...payload, tenantId } : payload;
      const rows = await dbHandle.insert(asTable(table)).values(finalPayload).returning();
      const row = rows[0];
      if (row === undefined) {
        throw new Error("create: insert returned no row");
      }
      return row;
    },

    async update(table, id, fields) {
      const idCol = requireIdCol(table, "update");
      const stamped = withSystemFields({ userId }, "update", fields as Record<string, unknown>);
      const rows = await dbHandle
        .update(asTable(table))
        .set(stamped)
        .where(and(eq(idCol, id), scope.conditions(table)))
        .returning();
      return rows[0];
    },

    async softDelete(table, id) {
      const idCol = requireIdCol(table, "softDelete");
      const stamped = withSystemFields({ userId }, "delete", {});
      const rows = await dbHandle
        .update(asTable(table))
        .set(stamped)
        .where(and(eq(idCol, id), scope.conditions(table)))
        .returning({ id: idCol });
      return rows[0] as { id: string } | undefined;
    },

    async restore(table, id) {
      const idCol = requireIdCol(table, "restore");
      const stamped = withSystemFields({ userId }, "restore", {});
      // Restore must reach soft-deleted rows; bypass the deleted_at IS NULL filter.
      const rows = await dbHandle
        .update(asTable(table))
        .set(stamped)
        .where(and(eq(idCol, id), scopeWithDeleted.conditions(table)))
        .returning();
      return rows[0] as typeof table.$inferSelect | undefined;
    },
  };
}

function createScopedDbInternal(args: FactoryArgs): ScopedDb {
  const { userId, tenantId, tenantIndustry, dbHandle } = args;
  const scope = createLegacyScope({ tenantId });
  const scopeWithDeleted = createLegacyScope({ tenantId, includeDeleted: true });
  const inTx = dbHandle !== db;
  const verbs = buildCrudVerbs({ dbHandle, userId, tenantId, scope, scopeWithDeleted });

  const self: ScopedDb = {
    ...verbs,
    lov: buildLovNamespace(dbHandle, scope, tenantIndustry),
    scope(table, options) {
      return options?.includeDeleted === true
        ? scopeWithDeleted.conditions(table)
        : scope.conditions(table);
    },
    raw: dbHandle,
    withTx(tx) {
      return createScopedDbInternal({ userId, tenantId, tenantIndustry, dbHandle: tx });
    },
    async transaction(fn) {
      // Already in a tx — flatten instead of opening a SAVEPOINT. Our
      // service helpers all accept db|tx interchangeably.
      if (inTx) {
        return fn(self, dbHandle as Tx);
      }
      return db.transaction(async (tx) => fn(self.withTx(tx), tx));
    },
  };

  return self;
}

export function createScopedDb(args: {
  userId: string;
  tenantId: string;
  tenantIndustry: string;
}): ScopedDb {
  return createScopedDbInternal({ ...args, dbHandle: db });
}

// Re-export the well-known soft-delete sentinel WHERE clause builder so callers
// that already have a table reference don't need to import legacy scope.ts.
export function notDeleted<T extends PgTable>(table: T): SQL {
  const cols = tableColumns(table);
  const col = cols["deletedAt"];
  if (col === undefined) {
    return sql`true`;
  }
  return isNull(col);
}
