// api/services/tenant-values-crud.ts
//
// Tenant-values CRUD primitive — the shared core every tenant_values feature
// goes through. Mirrors lov-crud.ts: owns slug derivation, dedup, system-fields
// stamping, and audit-log writing. Domain routers (creditors, cashBoxes, …)
// compose these helpers; they never write tenant_values.code directly.
//
// `kind` is an UPPER_SNAKE_CASE discriminator (e.g. 'SUPPLIER', 'CUSTOMER',
// 'CASH_BOX') matching a list_of_values row of type='TENANT_VALUES'. The
// registry is read by the UI to drive the picklist; this lib does not
// validate against it (cheap unprotected reads beat tight coupling).

import { TRPCError } from "@trpc/server";
import { and, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { tenantValues } from "../../drizzle/schema";
import type { db } from "../db/client";
import { withSystemFields } from "../db/scope";
import { writeAuditEntry, type AuditAction } from "./audit";
import { slugify } from "../../shared/validation/slugify";
import {
  findSimilarTenantValues,
  type TenantValuesSimilarityMatch,
} from "./tenant-values-similarity";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DbLike = typeof db | Tx;

export type TenantValuesCtx = { tenantId: string; userId: string };

export type TenantValuesCrudConfig = {
  /** UPPER_SNAKE_CASE kind discriminator (e.g. 'SUPPLIER', 'CUSTOMER', 'CASH_BOX'). */
  kind: string;
  /** Reject create/restore when parent_lov is null. cash_box: true. supplier/customer: false. */
  requiresParent: boolean;
};

export type TenantValuesRow = typeof tenantValues.$inferSelect;

export type TenantValuesCreateInput = {
  name: string;
  description?: string | null;
  /** Resolved list_of_values.id of the parent row, when applicable. */
  parentLov?: string | null;
  /** Resolved list_of_values.id of the BANK_SLUG row. CASH_BOX/'bank' only. */
  bankSlugId?: string | null;
  sortOrder?: number;
  // Skip the similarity preflight. Set when the user has seen suggestions
  // and chose to create a new row anyway.
  confirmedDespiteSuggestions?: boolean;
};

export type TenantValuesCreateOutcome =
  | { kind: "created"; row: TenantValuesRow }
  | { kind: "suggestions"; matches: TenantValuesSimilarityMatch[] };

export type TenantValuesUpdateInput = {
  id: string;
  name?: string;
  description?: string | null;
  /** undefined = leave alone; null = clear; string = set. */
  parentLov?: string | null;
  /** undefined = leave alone; null = clear; string = set. */
  bankSlugId?: string | null;
};

export type TenantValuesListFilters = {
  status?: "active" | "inactive" | "all";
  search?: string;
  parentLov?: string;
  hasParent?: boolean;
};

function entityLabel(kind: string): string {
  return kind.toLowerCase().replace(/_/g, " ");
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
  cfg: TenantValuesCrudConfig,
  tenantId: string,
  code: string,
): Promise<{ id: string; value: string } | null> {
  const [row] = await tx
    .select({ id: tenantValues.id, value: tenantValues.value })
    .from(tenantValues)
    .where(
      and(
        eq(tenantValues.tenantId, tenantId),
        eq(tenantValues.kind, cfg.kind),
        eq(tenantValues.code, code),
        isNull(tenantValues.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Create a tenant-scoped tenant_values row.
 *
 * Order of resolution:
 *   1. Exact-code lookup within (tenant, kind) — same-tenant collision throws.
 *   2. Fuzzy similarity preflight — surfaces near-matches like "IFOOD FEE"
 *      when "IFOOD" exists. Caller passes `confirmedDespiteSuggestions: true`
 *      to bypass.
 *   3. Insert new tenant-scoped row + audit "create".
 */
export async function tenantValuesCreate(
  tx: DbLike,
  ctx: TenantValuesCtx,
  cfg: TenantValuesCrudConfig,
  input: TenantValuesCreateInput,
): Promise<TenantValuesCreateOutcome> {
  if (cfg.requiresParent && (input.parentLov === undefined || input.parentLov === null)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${cfg.kind} requer parent.`,
    });
  }

  const code = deriveCode(input.name);
  const conflict = await findActiveByCode(tx, cfg, ctx.tenantId, code);
  if (conflict) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Já existe ${entityLabel(cfg.kind)} ativo com nome equivalente: "${conflict.value}".`,
    });
  }

  if (input.confirmedDespiteSuggestions !== true) {
    const matches = await findSimilarTenantValues({
      db: tx,
      tenantId: ctx.tenantId,
      kind: cfg.kind,
      candidateValue: input.name,
    });
    if (matches.length > 0) {
      return { kind: "suggestions", matches };
    }
  }

  const payload = withSystemFields({ userId: ctx.userId }, "create", {
    kind: cfg.kind,
    code,
    value: input.name,
    description: input.description ?? null,
    parentLov: input.parentLov ?? null,
    bankSlugId: input.bankSlugId ?? null,
    tenantId: ctx.tenantId,
    sortOrder: input.sortOrder ?? 0,
  });

  const [created] = await tx.insert(tenantValues).values(payload).returning();
  if (!created) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

  await writeAuditEntry({
    ctx: { tenantId: ctx.tenantId, userId: ctx.userId },
    entityType: cfg.kind,
    entityId: created.id,
    action: "create",
    after: {
      name: created.value,
      description: created.description,
      parentLov: created.parentLov,
      bankSlugId: created.bankSlugId,
    },
    tx,
  });

  return { kind: "created", row: created };
}

export async function tenantValuesUpdate(
  tx: DbLike,
  ctx: TenantValuesCtx,
  cfg: TenantValuesCrudConfig,
  input: TenantValuesUpdateInput,
): Promise<TenantValuesRow> {
  const [current] = await tx
    .select()
    .from(tenantValues)
    .where(
      and(
        eq(tenantValues.id, input.id),
        eq(tenantValues.tenantId, ctx.tenantId),
        eq(tenantValues.kind, cfg.kind),
        isNull(tenantValues.deletedAt),
      ),
    )
    .limit(1);
  if (!current) throw new TRPCError({ code: "NOT_FOUND" });

  const nextValue = input.name ?? current.value;
  const nextDescription = input.description === undefined ? current.description : input.description;
  const nextParent = input.parentLov === undefined ? current.parentLov : input.parentLov;
  const nextBankSlug = input.bankSlugId === undefined ? current.bankSlugId : input.bankSlugId;
  const nextCode = input.name !== undefined ? deriveCode(input.name) : current.code;

  if (cfg.requiresParent && nextParent === null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${cfg.kind} requer parent.`,
    });
  }

  if (nextCode !== current.code) {
    const conflict = await findActiveByCode(tx, cfg, ctx.tenantId, nextCode);
    if (conflict && conflict.id !== current.id) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `Já existe ${entityLabel(cfg.kind)} ativo com nome equivalente: "${conflict.value}".`,
      });
    }
  }

  const setPayload = withSystemFields({ userId: ctx.userId }, "update", {
    value: nextValue,
    code: nextCode,
    description: nextDescription,
    parentLov: nextParent,
    bankSlugId: nextBankSlug,
  });

  const [updated] = await tx
    .update(tenantValues)
    .set(setPayload)
    .where(eq(tenantValues.id, input.id))
    .returning();
  if (!updated) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

  await writeAuditEntry({
    ctx: { tenantId: ctx.tenantId, userId: ctx.userId },
    entityType: cfg.kind,
    entityId: updated.id,
    action: "update",
    before: {
      name: current.value,
      description: current.description,
      parentLov: current.parentLov,
      bankSlugId: current.bankSlugId,
    },
    after: {
      name: updated.value,
      description: updated.description,
      parentLov: updated.parentLov,
      bankSlugId: updated.bankSlugId,
    },
    tx,
  });

  return updated;
}

export async function tenantValuesChangeParent(
  tx: DbLike,
  ctx: TenantValuesCtx,
  cfg: TenantValuesCrudConfig,
  args: { id: string; parentLov: string; auditAction: AuditAction },
): Promise<TenantValuesRow> {
  const [current] = await tx
    .select()
    .from(tenantValues)
    .where(
      and(
        eq(tenantValues.id, args.id),
        eq(tenantValues.tenantId, ctx.tenantId),
        eq(tenantValues.kind, cfg.kind),
        isNull(tenantValues.deletedAt),
      ),
    )
    .limit(1);
  if (!current) throw new TRPCError({ code: "NOT_FOUND" });

  if (current.parentLov === args.parentLov) return current;

  const setPayload = withSystemFields({ userId: ctx.userId }, "update", {
    parentLov: args.parentLov,
  });

  const [updated] = await tx
    .update(tenantValues)
    .set(setPayload)
    .where(eq(tenantValues.id, args.id))
    .returning();
  if (!updated) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

  await writeAuditEntry({
    ctx: { tenantId: ctx.tenantId, userId: ctx.userId },
    entityType: cfg.kind,
    entityId: updated.id,
    action: args.auditAction,
    before: { parentLov: current.parentLov },
    after: { parentLov: updated.parentLov },
    tx,
  });

  return updated;
}

export async function tenantValuesDeactivate(
  tx: DbLike,
  ctx: TenantValuesCtx,
  cfg: TenantValuesCrudConfig,
  id: string,
): Promise<{ id: string }> {
  const setPayload = withSystemFields({ userId: ctx.userId }, "delete", {});

  const [row] = await tx
    .update(tenantValues)
    .set(setPayload)
    .where(
      and(
        eq(tenantValues.id, id),
        eq(tenantValues.tenantId, ctx.tenantId),
        eq(tenantValues.kind, cfg.kind),
        isNull(tenantValues.deletedAt),
      ),
    )
    .returning({ id: tenantValues.id });
  if (!row) throw new TRPCError({ code: "NOT_FOUND" });

  await writeAuditEntry({
    ctx: { tenantId: ctx.tenantId, userId: ctx.userId },
    entityType: cfg.kind,
    entityId: row.id,
    action: "delete",
    tx,
  });

  return row;
}

export async function tenantValuesRestore(
  tx: DbLike,
  ctx: TenantValuesCtx,
  cfg: TenantValuesCrudConfig,
  id: string,
): Promise<TenantValuesRow> {
  const [current] = await tx
    .select()
    .from(tenantValues)
    .where(
      and(
        eq(tenantValues.id, id),
        eq(tenantValues.tenantId, ctx.tenantId),
        eq(tenantValues.kind, cfg.kind),
        isNotNull(tenantValues.deletedAt),
      ),
    )
    .limit(1);
  if (!current) throw new TRPCError({ code: "NOT_FOUND" });

  const conflict = await findActiveByCode(tx, cfg, ctx.tenantId, current.code);
  if (conflict && conflict.id !== current.id) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Já existe ${entityLabel(cfg.kind)} ativo com nome equivalente: "${conflict.value}". Renomeie antes de restaurar.`,
    });
  }

  const setPayload = withSystemFields({ userId: ctx.userId }, "restore", {});

  const [restored] = await tx
    .update(tenantValues)
    .set(setPayload)
    .where(eq(tenantValues.id, id))
    .returning();
  if (!restored) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

  await writeAuditEntry({
    ctx: { tenantId: ctx.tenantId, userId: ctx.userId },
    entityType: cfg.kind,
    entityId: restored.id,
    action: "restore",
    tx,
  });

  return restored;
}

export async function tenantValuesById(
  dbHandle: DbLike,
  ctx: TenantValuesCtx,
  cfg: TenantValuesCrudConfig,
  id: string,
): Promise<TenantValuesRow | null> {
  const [row] = await dbHandle
    .select()
    .from(tenantValues)
    .where(
      and(
        eq(tenantValues.id, id),
        eq(tenantValues.tenantId, ctx.tenantId),
        eq(tenantValues.kind, cfg.kind),
      ),
    )
    .limit(1);
  return row ?? null;
}

export function tenantValuesListConditions(
  tenantId: string,
  cfg: { kind: string },
  filters: TenantValuesListFilters,
): SQL[] {
  const conds: SQL[] = [eq(tenantValues.tenantId, tenantId), eq(tenantValues.kind, cfg.kind)];

  const status = filters.status ?? "active";
  if (status === "active") {
    conds.push(isNull(tenantValues.deletedAt));
  } else if (status === "inactive") {
    conds.push(isNotNull(tenantValues.deletedAt));
  }

  if (filters.parentLov !== undefined) {
    conds.push(eq(tenantValues.parentLov, filters.parentLov));
  }
  if (filters.hasParent === true) {
    conds.push(isNotNull(tenantValues.parentLov));
  } else if (filters.hasParent === false) {
    conds.push(isNull(tenantValues.parentLov));
  }
  if (filters.search !== undefined && filters.search.length > 0) {
    conds.push(sql`${tenantValues.value} ILIKE ${`%${filters.search}%`}`);
  }

  return conds;
}
