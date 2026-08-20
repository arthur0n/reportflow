// api/trpc/routers/tenant-values.router.ts
//
// Generic tenant_values router. One procedure surface keyed by `kind`,
// dispatching off TENANT_VALUE_KIND_CONFIG. Replaces the per-kind creditors
// and cashBoxes routers; they were thin adapters over the same tenant-values
// CRUD core, differing only in (a) which LOV the parent points at and (b)
// the CASH_BOX RN-7 lock.
//
// Adding a new kind: insert a TENANT_VALUES LOV registry row + a config
// entry. This file is kind-agnostic.

import { z } from "zod/v4";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { router, protectedProcedure } from "../procedures";
import { db } from "../../db/client";
import { listOfValues, tenantValues } from "../../../drizzle/schema";
import {
  CreateTenantValueInput,
  TenantValuesListInput,
  UpdateTenantValueInput,
} from "../../../shared/validation/tenant-value-schemas";
import {
  isTenantValueKind,
  TENANT_VALUE_KIND_CONFIG,
  type TenantValueKind,
} from "../../../shared/constants/tenant-value-kinds";
import {
  tenantValuesById,
  tenantValuesCreate,
  tenantValuesDeactivate,
  tenantValuesListConditions,
  tenantValuesRestore,
  tenantValuesUpdate,
  type DbLike,
  type TenantValuesCrudConfig,
} from "../../services/tenant-values-crud";

function crudCfgFor(kind: TenantValueKind): TenantValuesCrudConfig {
  const k = TENANT_VALUE_KIND_CONFIG[kind];
  return {
    kind,
    requiresParent: k.parent.source !== "none" && k.parent.required,
  };
}

async function findKindOf(tx: DbLike, tenantId: string, id: string): Promise<TenantValueKind> {
  const [row] = await tx
    .select({ kind: tenantValues.kind })
    .from(tenantValues)
    .where(and(eq(tenantValues.id, id), eq(tenantValues.tenantId, tenantId)))
    .limit(1);
  if (!row || !isTenantValueKind(row.kind)) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }
  return row.kind;
}

/**
 * Resolve the caller's intent for `parent_lov` against the kind's config.
 * Returns `wantsChange=true` only when the caller actually expressed a parent
 * value for the relevant input field; the router treats that as authoritative.
 */
async function resolveNewParent(
  tx: DbLike,
  tenantId: string,
  kind: TenantValueKind,
  input: { parentLov?: string | null | undefined; parentLovCode?: string | undefined },
): Promise<{ wantsChange: boolean; newParentLov: string | null }> {
  const cfg = TENANT_VALUE_KIND_CONFIG[kind].parent;

  if (cfg.source === "none") {
    return { wantsChange: false, newParentLov: null };
  }

  if (cfg.source === "lov-tenant") {
    if (input.parentLov === undefined) {
      return { wantsChange: false, newParentLov: null };
    }
    if (input.parentLov === null) {
      return { wantsChange: true, newParentLov: null };
    }
    const [row] = await tx
      .select({ id: listOfValues.id })
      .from(listOfValues)
      .where(
        and(
          eq(listOfValues.id, input.parentLov),
          eq(listOfValues.tenantId, tenantId),
          eq(listOfValues.type, cfg.lovType),
          isNull(listOfValues.deletedAt),
        ),
      )
      .limit(1);
    if (!row) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `Referência ${cfg.lovType} inválida.` });
    }
    return { wantsChange: true, newParentLov: input.parentLov };
  }

  // lov-system
  if (input.parentLovCode === undefined) {
    return { wantsChange: false, newParentLov: null };
  }
  const [row] = await tx
    .select({ id: listOfValues.id })
    .from(listOfValues)
    .where(
      and(
        eq(listOfValues.type, cfg.lovType),
        eq(listOfValues.code, input.parentLovCode),
        isNull(listOfValues.tenantId),
        isNull(listOfValues.deletedAt),
      ),
    )
    .limit(1);
  if (!row) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Tipo inválido." });
  }
  return { wantsChange: true, newParentLov: row.id };
}

/**
 * Enforce the CASH_BOX/'bank' invariant: bank_slug_id is required iff the
 * cash box's parent CASH_BOX_TYPE is 'bank', and forbidden otherwise. Also
 * validates that bank_slug_id, when present, points to a system BANK_SLUG row.
 * Returns the value to persist (always equal to input on success — null or a
 * validated uuid).
 */
async function validateAndResolveBankSlugId(
  tx: DbLike,
  kind: TenantValueKind,
  parentLovId: string | null,
  bankSlugId: string | null | undefined,
): Promise<string | null> {
  const requested = bankSlugId ?? null;

  if (kind !== "CASH_BOX") {
    if (requested !== null) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Banco aplica-se apenas a Caixa.",
      });
    }
    return null;
  }

  let parentCode: string | null = null;
  if (parentLovId !== null) {
    const [parent] = await tx
      .select({ code: listOfValues.code })
      .from(listOfValues)
      .where(
        and(
          eq(listOfValues.id, parentLovId),
          eq(listOfValues.type, "CASH_BOX_TYPE"),
          isNull(listOfValues.tenantId),
          isNull(listOfValues.deletedAt),
        ),
      )
      .limit(1);
    parentCode = parent?.code ?? null;
  }

  if (parentCode !== "bank") {
    if (requested !== null) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Banco aplica-se apenas a Caixas do tipo Banco.",
      });
    }
    return null;
  }

  if (requested === null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Banco é obrigatório para Caixas do tipo Banco.",
    });
  }

  const [bank] = await tx
    .select({ id: listOfValues.id })
    .from(listOfValues)
    .where(
      and(
        eq(listOfValues.id, requested),
        eq(listOfValues.type, "BANK_SLUG"),
        isNull(listOfValues.tenantId),
        isNull(listOfValues.deletedAt),
      ),
    )
    .limit(1);
  if (!bank) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Banco inválido." });
  }

  return requested;
}

export const tenantValuesRouter = router({
  list: protectedProcedure.input(TenantValuesListInput).query(async ({ ctx, input }) => {
    const conds = tenantValuesListConditions(
      ctx.tenantId,
      { kind: input.kind },
      {
        status: input.status,
        ...(input.search !== undefined ? { search: input.search } : {}),
        ...(input.parentLov !== undefined ? { parentLov: input.parentLov } : {}),
        ...(input.hasParent !== undefined ? { hasParent: input.hasParent } : {}),
      },
    );

    const bankSlug = alias(listOfValues, "bank_slug");

    return ctx.db.raw
      .select({
        id: tenantValues.id,
        kind: tenantValues.kind,
        name: tenantValues.value,
        description: tenantValues.description,
        sortOrder: tenantValues.sortOrder,
        deletedAt: tenantValues.deletedAt,
        parent: {
          id: listOfValues.id,
          code: listOfValues.code,
          label: listOfValues.value,
          deletedAt: listOfValues.deletedAt,
        },
        bank: {
          id: bankSlug.id,
          code: bankSlug.code,
          label: bankSlug.value,
        },
      })
      .from(tenantValues)
      .leftJoin(listOfValues, eq(listOfValues.id, tenantValues.parentLov))
      .leftJoin(bankSlug, eq(bankSlug.id, tenantValues.bankSlugId))
      .where(and(...conds))
      .orderBy(asc(tenantValues.value));
  }),

  byId: protectedProcedure.input(z.string().uuid()).query(async ({ ctx, input: id }) => {
    const kind = await findKindOf(db, ctx.tenantId, id);
    const cfg = crudCfgFor(kind);
    const row = await tenantValuesById(db, { tenantId: ctx.tenantId, userId: ctx.userId }, cfg, id);
    if (!row) throw new TRPCError({ code: "NOT_FOUND" });
    return row;
  }),

  create: protectedProcedure.input(CreateTenantValueInput).mutation(async ({ ctx, input }) => {
    return db.transaction(async (tx) => {
      const cfg = crudCfgFor(input.kind);
      const { wantsChange, newParentLov } = await resolveNewParent(
        tx,
        ctx.tenantId,
        input.kind,
        input,
      );
      const resolvedParent = wantsChange ? newParentLov : null;
      const resolvedBankSlug = await validateAndResolveBankSlugId(
        tx,
        input.kind,
        resolvedParent,
        input.bankSlugId ?? null,
      );
      return tenantValuesCreate(tx, { tenantId: ctx.tenantId, userId: ctx.userId }, cfg, {
        name: input.name,
        ...(input.description !== undefined ? { description: input.description } : {}),
        parentLov: resolvedParent,
        bankSlugId: resolvedBankSlug,
        confirmedDespiteSuggestions: input.confirmedDespiteSuggestions ?? false,
      });
    });
  }),

  update: protectedProcedure.input(UpdateTenantValueInput).mutation(async ({ ctx, input }) => {
    return db.transaction(async (tx) => {
      const kind = await findKindOf(tx, ctx.tenantId, input.id);
      const cfg = crudCfgFor(kind);

      const current = await tenantValuesById(
        tx,
        { tenantId: ctx.tenantId, userId: ctx.userId },
        cfg,
        input.id,
      );
      if (!current) throw new TRPCError({ code: "NOT_FOUND" });

      const { wantsChange, newParentLov } = await resolveNewParent(tx, ctx.tenantId, kind, input);

      const finalParent = wantsChange ? newParentLov : current.parentLov;
      const finalBankInput = input.bankSlugId === undefined ? current.bankSlugId : input.bankSlugId;
      const resolvedBankSlug = await validateAndResolveBankSlugId(
        tx,
        kind,
        finalParent,
        finalBankInput,
      );

      return tenantValuesUpdate(tx, { tenantId: ctx.tenantId, userId: ctx.userId }, cfg, {
        id: input.id,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(wantsChange ? { parentLov: newParentLov } : {}),
        bankSlugId: resolvedBankSlug,
      });
    });
  }),

  deactivate: protectedProcedure.input(z.string().uuid()).mutation(async ({ ctx, input: id }) => {
    return db.transaction(async (tx) => {
      const kind = await findKindOf(tx, ctx.tenantId, id);
      const cfg = crudCfgFor(kind);
      return tenantValuesDeactivate(tx, { tenantId: ctx.tenantId, userId: ctx.userId }, cfg, id);
    });
  }),

  restore: protectedProcedure.input(z.string().uuid()).mutation(async ({ ctx, input: id }) => {
    return db.transaction(async (tx) => {
      const kind = await findKindOf(tx, ctx.tenantId, id);
      const cfg = crudCfgFor(kind);
      return tenantValuesRestore(tx, { tenantId: ctx.tenantId, userId: ctx.userId }, cfg, id);
    });
  }),
});
