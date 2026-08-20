// api/services/lov-crud.ts
//
// LOV-CRUD primitive — the shared core every list_of_values-typed feature
// goes through. Owns slug derivation, dedup, parent resolution, system-fields
// stamping, and audit-log writing. Domain routers (categoriesRouter,
// paymentMethodsRouter) compose these helpers; they never write
// list_of_values.code directly. Tenant-scoped lookups live in tenant_values
// and go through api/services/tenant-values-crud.ts instead.

import { TRPCError } from "@trpc/server";
import { and, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { listOfValues } from "../../drizzle/schema";
import type { db } from "../db/client";
import { withSystemFields } from "../db/scope";
import { writeAuditEntry, type AuditAction } from "./audit";
import { slugify } from "../../shared/validation/slugify";
import { findSimilarLovRows, type LovSimilarityMatch } from "./lov-similarity";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DbLike = typeof db | Tx;

export type LovCtx = { tenantId: string; userId: string };

export type LovCrudConfig = {
  /** UPPER_SNAKE_CASE LOV type discriminator (e.g. 'CATEGORY', 'SUPPLIER'). */
  type: string;
  /** Type of the parent LOV row, when this entity is hierarchical. */
  parentType?: string;
  /** Reject create/restore when parent_lov is null. Categories: true. */
  requiresParent: boolean;
};

export type LovRow = typeof listOfValues.$inferSelect;

export type LovCreateInput = {
  name: string;
  description?: string | null;
  /** Resolved LOV id of the parent row, when applicable. */
  parentLov?: string | null;
  sortOrder?: number;
  // Skip the similarity preflight. Set when the user has seen suggestions
  // and chose to create a new row anyway.
  confirmedDespiteSuggestions?: boolean;
  // Required for the similarity preflight (combined-mode audience filter).
  // Omit only when confirmedDespiteSuggestions is true.
  tenantIndustry?: string;
};

export type LovCreateOutcome =
  { kind: "created"; row: LovRow } | { kind: "suggestions"; matches: LovSimilarityMatch[] };

export type LovUpdateInput = {
  id: string;
  name?: string;
  description?: string | null;
  /** undefined = leave alone; null = clear; string = set. */
  parentLov?: string | null;
};

export type LovListFilters = {
  status?: "active" | "inactive" | "all";
  search?: string;
  /** Filter by exact parent id. */
  parentLov?: string;
  /** true: parent_lov IS NOT NULL; false: parent_lov IS NULL. */
  hasParent?: boolean;
};

function entityLabel(type: string): string {
  return type.toLowerCase().replace(/_/g, " ");
}

function deriveCode(name: string): string {
  const code = slugify(name);
  if (code.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Nome inválido — não foi possível gerar um código.",
    });
  }
  return code;
}

async function findActiveByCode(
  tx: DbLike,
  cfg: LovCrudConfig,
  tenantId: string,
  code: string,
): Promise<{ id: string; value: string } | null> {
  const [row] = await tx
    .select({ id: listOfValues.id, value: listOfValues.value })
    .from(listOfValues)
    .where(
      and(
        eq(listOfValues.tenantId, tenantId),
        eq(listOfValues.type, cfg.type),
        eq(listOfValues.code, code),
        isNull(listOfValues.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Resolve an exact-code collision across all tenants before inserting a new
 * row. Drives the auto-promote rule: when a second tenant tries to create a
 * value another tenant already has, we promote that row to system rather
 * than letting two tenant-scoped rows exist for the same concept.
 *
 * Returns:
 *   { row, conflict: true }  — caller's own tenant already has this code
 *   { row, conflict: false } — system row exists OR another tenant's row was
 *                              auto-promoted in place; caller uses this row
 *   null                     — no collision; caller proceeds with insert
 */
async function lovResolveAcrossTenants(
  tx: DbLike,
  ctx: LovCtx,
  cfg: LovCrudConfig,
  code: string,
): Promise<{ row: LovRow; conflict: boolean } | null> {
  const [existing] = await tx
    .select()
    .from(listOfValues)
    .where(
      and(
        eq(listOfValues.type, cfg.type),
        eq(listOfValues.code, code),
        isNull(listOfValues.deletedAt),
      ),
    )
    .limit(1);

  if (!existing) return null;
  if (existing.tenantId === ctx.tenantId) return { row: existing, conflict: true };
  if (existing.tenantId === null) return { row: existing, conflict: false };

  const setPayload = withSystemFields({ userId: ctx.userId }, "update", {
    tenantId: null,
    category: null,
  });
  const [promoted] = await tx
    .update(listOfValues)
    .set(setPayload)
    .where(eq(listOfValues.id, existing.id))
    .returning();
  if (!promoted) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

  await writeAuditEntry({
    ctx: { tenantId: existing.tenantId, userId: ctx.userId },
    entityType: existing.type,
    entityId: promoted.id,
    action: "promote_to_system",
    before: { tenantId: existing.tenantId, category: existing.category },
    after: { tenantId: null, category: null },
    tx,
  });

  return { row: promoted, conflict: false };
}

/**
 * Create a tenant-scoped LOV row.
 *
 * Order of resolution:
 *   1. Exact-code lookup across all tenants — same-tenant collision throws,
 *      another tenant's row auto-promotes to system, system row is returned
 *      as-is. In all three cases no new row is inserted.
 *   2. Fuzzy similarity preflight (within tenant audience) — surfaces
 *      near-matches like "IFOOD FEE" when "IFOOD" exists. Caller passes
 *      `confirmedDespiteSuggestions: true` to bypass.
 *   3. Insert new tenant-scoped row + audit "create".
 */
export async function lovCreate(
  tx: DbLike,
  ctx: LovCtx,
  cfg: LovCrudConfig,
  input: LovCreateInput,
): Promise<LovCreateOutcome> {
  if (cfg.requiresParent && (input.parentLov === undefined || input.parentLov === null)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `LOV ${cfg.type} requer parent.`,
    });
  }

  const code = deriveCode(input.name);

  const resolved = await lovResolveAcrossTenants(tx, ctx, cfg, code);
  if (resolved) {
    if (resolved.conflict) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `Já existe ${entityLabel(cfg.type)} ativo com nome equivalente: "${resolved.row.value}".`,
      });
    }
    return { kind: "created", row: resolved.row };
  }

  if (input.confirmedDespiteSuggestions !== true) {
    if (input.tenantIndustry === undefined || input.tenantIndustry.length === 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "tenantIndustry is required for the similarity preflight.",
      });
    }
    const matches = await findSimilarLovRows({
      db: tx,
      type: cfg.type,
      candidateValue: input.name,
      scope: { kind: "tenant", tenantId: ctx.tenantId, tenantIndustry: input.tenantIndustry },
    });
    if (matches.length > 0) {
      return { kind: "suggestions", matches };
    }
  }

  const payload = withSystemFields({ userId: ctx.userId }, "create", {
    type: cfg.type,
    code,
    value: input.name,
    description: input.description ?? null,
    parentLov: input.parentLov ?? null,
    tenantId: ctx.tenantId,
    sortOrder: input.sortOrder ?? 0,
  });

  const [created] = await tx.insert(listOfValues).values(payload).returning();
  if (!created) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

  await writeAuditEntry({
    ctx: { tenantId: ctx.tenantId, userId: ctx.userId },
    entityType: cfg.type,
    entityId: created.id,
    action: "create",
    after: {
      name: created.value,
      description: created.description,
      parentLov: created.parentLov,
    },
    tx,
  });

  return { kind: "created", row: created };
}

export async function lovUpdate(
  tx: DbLike,
  ctx: LovCtx,
  cfg: LovCrudConfig,
  input: LovUpdateInput,
): Promise<LovRow> {
  const [current] = await tx
    .select()
    .from(listOfValues)
    .where(
      and(
        eq(listOfValues.id, input.id),
        eq(listOfValues.tenantId, ctx.tenantId),
        eq(listOfValues.type, cfg.type),
        isNull(listOfValues.deletedAt),
      ),
    )
    .limit(1);
  if (!current) throw new TRPCError({ code: "NOT_FOUND" });

  const nextValue = input.name ?? current.value;
  const nextDescription = input.description === undefined ? current.description : input.description;
  const nextParent = input.parentLov === undefined ? current.parentLov : input.parentLov;
  const nextCode = input.name !== undefined ? deriveCode(input.name) : current.code;

  if (cfg.requiresParent && nextParent === null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `LOV ${cfg.type} requer parent.`,
    });
  }

  if (nextCode !== current.code) {
    const conflict = await findActiveByCode(tx, cfg, ctx.tenantId, nextCode);
    if (conflict && conflict.id !== current.id) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `Já existe ${entityLabel(cfg.type)} ativo com nome equivalente: "${conflict.value}".`,
      });
    }
  }

  const setPayload = withSystemFields({ userId: ctx.userId }, "update", {
    value: nextValue,
    code: nextCode,
    description: nextDescription,
    parentLov: nextParent,
  });

  const [updated] = await tx
    .update(listOfValues)
    .set(setPayload)
    .where(eq(listOfValues.id, input.id))
    .returning();
  if (!updated) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

  await writeAuditEntry({
    ctx: { tenantId: ctx.tenantId, userId: ctx.userId },
    entityType: cfg.type,
    entityId: updated.id,
    action: "update",
    before: {
      name: current.value,
      description: current.description,
      parentLov: current.parentLov,
    },
    after: {
      name: updated.value,
      description: updated.description,
      parentLov: updated.parentLov,
    },
    tx,
  });

  return updated;
}

/**
 * Swap a row's `parent_lov` and emit an audit row with a configurable action
 * (e.g. 'reclassify' for categories). No name/description/code changes.
 */
export async function lovChangeParent(
  tx: DbLike,
  ctx: LovCtx,
  cfg: LovCrudConfig,
  args: { id: string; parentLov: string; auditAction: AuditAction },
): Promise<LovRow> {
  const [current] = await tx
    .select()
    .from(listOfValues)
    .where(
      and(
        eq(listOfValues.id, args.id),
        eq(listOfValues.tenantId, ctx.tenantId),
        eq(listOfValues.type, cfg.type),
        isNull(listOfValues.deletedAt),
      ),
    )
    .limit(1);
  if (!current) throw new TRPCError({ code: "NOT_FOUND" });

  if (current.parentLov === args.parentLov) return current;

  const setPayload = withSystemFields({ userId: ctx.userId }, "update", {
    parentLov: args.parentLov,
  });

  const [updated] = await tx
    .update(listOfValues)
    .set(setPayload)
    .where(eq(listOfValues.id, args.id))
    .returning();
  if (!updated) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

  await writeAuditEntry({
    ctx: { tenantId: ctx.tenantId, userId: ctx.userId },
    entityType: cfg.type,
    entityId: updated.id,
    action: args.auditAction,
    before: { parentLov: current.parentLov },
    after: { parentLov: updated.parentLov },
    tx,
  });

  return updated;
}

export async function lovDeactivate(
  tx: DbLike,
  ctx: LovCtx,
  cfg: LovCrudConfig,
  id: string,
): Promise<{ id: string }> {
  const setPayload = withSystemFields({ userId: ctx.userId }, "delete", {});

  const [row] = await tx
    .update(listOfValues)
    .set(setPayload)
    .where(
      and(
        eq(listOfValues.id, id),
        eq(listOfValues.tenantId, ctx.tenantId),
        eq(listOfValues.type, cfg.type),
        isNull(listOfValues.deletedAt),
      ),
    )
    .returning({ id: listOfValues.id });
  if (!row) throw new TRPCError({ code: "NOT_FOUND" });

  await writeAuditEntry({
    ctx: { tenantId: ctx.tenantId, userId: ctx.userId },
    entityType: cfg.type,
    entityId: row.id,
    action: "delete",
    tx,
  });

  return row;
}

export async function lovRestore(
  tx: DbLike,
  ctx: LovCtx,
  cfg: LovCrudConfig,
  id: string,
): Promise<LovRow> {
  const [current] = await tx
    .select()
    .from(listOfValues)
    .where(
      and(
        eq(listOfValues.id, id),
        eq(listOfValues.tenantId, ctx.tenantId),
        eq(listOfValues.type, cfg.type),
        isNotNull(listOfValues.deletedAt),
      ),
    )
    .limit(1);
  if (!current) throw new TRPCError({ code: "NOT_FOUND" });

  const conflict = await findActiveByCode(tx, cfg, ctx.tenantId, current.code);
  if (conflict && conflict.id !== current.id) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Já existe ${entityLabel(cfg.type)} ativo com nome equivalente: "${conflict.value}". Renomeie antes de restaurar.`,
    });
  }

  const setPayload = withSystemFields({ userId: ctx.userId }, "restore", {});

  const [restored] = await tx
    .update(listOfValues)
    .set(setPayload)
    .where(eq(listOfValues.id, id))
    .returning();
  if (!restored) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

  await writeAuditEntry({
    ctx: { tenantId: ctx.tenantId, userId: ctx.userId },
    entityType: cfg.type,
    entityId: restored.id,
    action: "restore",
    tx,
  });

  return restored;
}

export async function lovById(
  dbHandle: DbLike,
  ctx: LovCtx,
  cfg: LovCrudConfig,
  id: string,
): Promise<LovRow | null> {
  const [row] = await dbHandle
    .select()
    .from(listOfValues)
    .where(
      and(
        eq(listOfValues.id, id),
        eq(listOfValues.tenantId, ctx.tenantId),
        eq(listOfValues.type, cfg.type),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Promote a tenant-created LOV row to a system row. Atomic UPDATE flipping
 * tenant_id to NULL and optionally setting `category` (the audience scope,
 * e.g. 'restaurant'). The row id stays stable so existing FKs (transactions.*)
 * keep resolving — no copy, no link, no relink.
 *
 * Admin-only callsite. Throws if the row is already system-scoped, deleted,
 * or not found. Audits as "promote_to_system" under the originating tenant.
 */
export async function lovPromoteToSystem(
  tx: DbLike,
  args: { actorUserId: string; rowId: string; category: string | null },
): Promise<LovRow> {
  const [current] = await tx
    .select()
    .from(listOfValues)
    .where(and(eq(listOfValues.id, args.rowId), isNull(listOfValues.deletedAt)))
    .limit(1);
  if (!current) throw new TRPCError({ code: "NOT_FOUND" });
  if (current.tenantId === null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Row is already system-scoped.",
    });
  }

  const setPayload = withSystemFields({ userId: args.actorUserId }, "update", {
    tenantId: null,
    category: args.category,
  });

  const [updated] = await tx
    .update(listOfValues)
    .set(setPayload)
    .where(eq(listOfValues.id, args.rowId))
    .returning();
  if (!updated) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

  await writeAuditEntry({
    ctx: { tenantId: current.tenantId, userId: args.actorUserId },
    entityType: current.type,
    entityId: updated.id,
    action: "promote_to_system",
    before: { tenantId: current.tenantId, category: current.category },
    after: { tenantId: null, category: args.category },
    tx,
  });

  return updated;
}

/**
 * Build the WHERE conditions a domain router uses when composing its own
 * SELECT (typically with type-specific JOINs). Single-type queries; for
 * multi-type lists (e.g. SUPPLIER + CUSTOMER) the router builds a separate
 * predicate or runs two queries.
 */
export function lovListConditions(
  tenantId: string,
  cfg: { type: string },
  filters: LovListFilters,
): SQL[] {
  const conds: SQL[] = [eq(listOfValues.tenantId, tenantId), eq(listOfValues.type, cfg.type)];

  const status = filters.status ?? "active";
  if (status === "active") {
    conds.push(isNull(listOfValues.deletedAt));
  } else if (status === "inactive") {
    conds.push(isNotNull(listOfValues.deletedAt));
  }

  if (filters.parentLov !== undefined) {
    conds.push(eq(listOfValues.parentLov, filters.parentLov));
  }
  if (filters.hasParent === true) {
    conds.push(isNotNull(listOfValues.parentLov));
  } else if (filters.hasParent === false) {
    conds.push(isNull(listOfValues.parentLov));
  }
  if (filters.search !== undefined && filters.search.length > 0) {
    conds.push(sql`${listOfValues.value} ILIKE ${`%${filters.search}%`}`);
  }

  return conds;
}
