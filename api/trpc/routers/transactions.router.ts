// api/trpc/routers/transactions.router.ts
//
// list: LEFT-JOINs every FK target so the table renders without a second
// round-trip. mutations: create / update / delete / restore stamp system
// fields, write audit rows, and default statusId via the same helper the
// imports recorder uses (api/services/transactions-write.ts).
// suggest: thin pass-through to the imports matcher chain so manual entry
// reuses the same auto-fill engine — zero new strategy code.

import { TRPCError } from "@trpc/server";
import { z } from "zod/v4";
import { and, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { router, protectedProcedure } from "../procedures";
import { transactions, listOfValues, tenantValues } from "../../../drizzle/schema";
import {
  CreateTransactionInput,
  UpdateTransactionInput,
} from "../../../shared/validation/transaction-schemas";
import { writeAuditEntry } from "../../services/audit";
import { runChainForTargets, type MatchTarget } from "../../imports/matcher";
import {
  TRANSACTION_ENTITY,
  insertTransactionInTx,
  loadLovIdMaps,
  requireTypeCode,
  resolveStatusId,
  toBigIntOrNull,
  transactionAuditProjection,
  type LovIdMaps,
} from "../../services/transactions-create";

// Same five targets the import orchestrator runs (api/imports/orchestrator.ts).
// Both SUPPLIER and CUSTOMER are queried — the form picks based on
// transactionTypeCode (EXPENSE → SUPPLIER, REVENUE → CUSTOMER).
const SUGGEST_TARGETS: ReadonlyArray<MatchTarget> = [
  { kind: "lov-system", type: "PAYMENT_METHOD" },
  { kind: "lov-tenant", type: "CATEGORY" },
  { kind: "tenant-value", tvKind: "SUPPLIER" },
  { kind: "tenant-value", tvKind: "CUSTOMER" },
  { kind: "lov-system", type: "TRANSACTION_SUBTYPE" },
];

type UpdatePatch = z.infer<typeof UpdateTransactionInput>;

// Fields whose change re-runs status defaulting on update.
const STATUS_AFFECTING_FIELDS: ReadonlyArray<keyof UpdatePatch> = [
  "transactionTypeId",
  "creditorId",
  "categoryId",
  "paymentMethodId",
  "actualDate",
  "actualAmount",
];

function patchTouchesStatusInputs(patch: UpdatePatch): boolean {
  return STATUS_AFFECTING_FIELDS.some((k) => patch[k] !== undefined);
}

type ColumnPatch = Partial<typeof transactions.$inferInsert>;

function copyFkAndDateFields(input: UpdatePatch, patch: ColumnPatch): void {
  if (input.transactionTypeId !== undefined) patch.transactionTypeId = input.transactionTypeId;
  if (input.businessUnitId !== undefined) patch.businessUnitId = input.businessUnitId;
  if (input.creditorId !== undefined) patch.creditorId = input.creditorId;
  if (input.categoryId !== undefined) patch.categoryId = input.categoryId;
  if (input.paymentMethodId !== undefined) patch.paymentMethodId = input.paymentMethodId;
  if (input.subtypeId !== undefined) patch.subtypeId = input.subtypeId;
  if (input.cashBoxId !== undefined) patch.cashBoxId = input.cashBoxId;
  if (input.accrualDate !== undefined) patch.accrualDate = input.accrualDate;
  if (input.dueDate !== undefined) patch.dueDate = input.dueDate;
  if (input.actualDate !== undefined) patch.actualDate = input.actualDate;
}

function copyAmountAndTextFields(input: UpdatePatch, patch: ColumnPatch): void {
  if (input.forecastAmount !== undefined) patch.forecastAmount = BigInt(input.forecastAmount);
  if (input.actualAmount !== undefined) patch.actualAmount = toBigIntOrNull(input.actualAmount);
  if (input.description !== undefined) patch.description = input.description;
  if (input.reference !== undefined) patch.reference = input.reference;
  if (input.externalId !== undefined) patch.externalId = input.externalId;
}

/**
 * Translate the wire-shape patch into the column-shape patch drizzle expects.
 * Drops undefined fields (so `update` doesn't overwrite untouched columns) and
 * coerces numeric amounts to bigint to match the schema's bigint mode.
 */
function buildUpdatePatch(input: UpdatePatch): ColumnPatch {
  const patch: ColumnPatch = {};
  copyFkAndDateFields(input, patch);
  copyAmountAndTextFields(input, patch);
  return patch;
}

/**
 * Compute the next statusId on update. Honors an explicit caller value;
 * otherwise re-runs the default-status helper if any of the
 * STATUS_AFFECTING_FIELDS changed in this patch. Returns undefined when the
 * caller passed neither — in that case the existing statusId is preserved.
 */
function nextUpdateStatusId(args: {
  input: UpdatePatch;
  before: typeof transactions.$inferSelect;
  maps: LovIdMaps;
}): string | undefined {
  const { input, before, maps } = args;
  if (input.statusId !== undefined) return input.statusId;
  if (!patchTouchesStatusInputs(input)) return undefined;

  const nextTypeId = input.transactionTypeId ?? before.transactionTypeId;
  return resolveStatusId({
    explicitStatusId: undefined,
    maps,
    typeCode: requireTypeCode(maps, nextTypeId),
    creditorId: input.creditorId !== undefined ? input.creditorId : before.creditorId,
    categoryId: input.categoryId !== undefined ? input.categoryId : before.categoryId,
    paymentMethodId:
      input.paymentMethodId !== undefined ? input.paymentMethodId : before.paymentMethodId,
    actualDate: input.actualDate !== undefined ? input.actualDate : before.actualDate,
    actualAmount:
      input.actualAmount !== undefined ? toBigIntOrNull(input.actualAmount) : before.actualAmount,
  });
}

export const transactionsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const statusLov = alias(listOfValues, "status_lov");
    const typeLov = alias(listOfValues, "type_lov");
    const subtypeLov = alias(listOfValues, "subtype_lov");
    const categoryLov = alias(listOfValues, "category_lov");
    const paymentMethodLov = alias(listOfValues, "payment_method_lov");
    const creditorTv = alias(tenantValues, "creditor_tv");
    const businessUnitTv = alias(tenantValues, "business_unit_tv");
    const cashBoxTv = alias(tenantValues, "cash_box_tv");

    const rows = await ctx.db.raw
      .select({
        id: transactions.id,
        businessUnitId: transactions.businessUnitId,
        businessUnitLabel: businessUnitTv.value,
        transactionTypeId: transactions.transactionTypeId,
        transactionTypeCode: typeLov.code,
        transactionTypeLabel: typeLov.value,
        creditorId: transactions.creditorId,
        creditorLabel: creditorTv.value,
        creditorKind: creditorTv.kind,
        categoryId: transactions.categoryId,
        categoryLabel: categoryLov.value,
        paymentMethodId: transactions.paymentMethodId,
        paymentMethodCode: paymentMethodLov.code,
        paymentMethodLabel: paymentMethodLov.value,
        subtypeId: transactions.subtypeId,
        subtypeCode: subtypeLov.code,
        subtypeLabel: subtypeLov.value,
        cashBoxId: transactions.cashBoxId,
        cashBoxLabel: cashBoxTv.value,
        statementImportId: transactions.statementImportId,
        accrualDate: transactions.accrualDate,
        dueDate: transactions.dueDate,
        actualDate: transactions.actualDate,
        forecastAmount: transactions.forecastAmount,
        actualAmount: transactions.actualAmount,
        interestAmount: transactions.interestAmount,
        statusId: transactions.statusId,
        statusCode: statusLov.code,
        statusLabel: statusLov.value,
        description: transactions.description,
        reference: transactions.reference,
        externalId: transactions.externalId,
        createdAt: transactions.createdAt,
        createdBy: transactions.createdBy,
        lastUpdAt: transactions.lastUpdAt,
        lastUpdBy: transactions.lastUpdBy,
      })
      .from(transactions)
      .leftJoin(statusLov, eq(statusLov.id, transactions.statusId))
      .leftJoin(typeLov, eq(typeLov.id, transactions.transactionTypeId))
      .leftJoin(subtypeLov, eq(subtypeLov.id, transactions.subtypeId))
      .leftJoin(categoryLov, eq(categoryLov.id, transactions.categoryId))
      .leftJoin(paymentMethodLov, eq(paymentMethodLov.id, transactions.paymentMethodId))
      .leftJoin(creditorTv, eq(creditorTv.id, transactions.creditorId))
      .leftJoin(businessUnitTv, eq(businessUnitTv.id, transactions.businessUnitId))
      .leftJoin(cashBoxTv, eq(cashBoxTv.id, transactions.cashBoxId))
      .where(and(ctx.db.scope(transactions)))
      .orderBy(desc(transactions.accrualDate));

    return rows;
  }),

  byId: protectedProcedure.input(z.string().uuid()).query(async ({ ctx, input: id }) => {
    const row = await ctx.db.byId(transactions, id);
    if (!row) throw new TRPCError({ code: "NOT_FOUND" });
    return row;
  }),

  create: protectedProcedure.input(CreateTransactionInput).mutation(async ({ ctx, input }) => {
    return ctx.db.transaction(async (txDb, tx) => {
      const maps = await loadLovIdMaps(tx);
      return insertTransactionInTx({ txDb, tx, ctx, maps, input });
    });
  }),

  update: protectedProcedure.input(UpdateTransactionInput).mutation(async ({ ctx, input }) => {
    return ctx.db.transaction(async (txDb, tx) => {
      const before = await txDb.byId(transactions, input.id);
      if (!before) throw new TRPCError({ code: "NOT_FOUND" });

      const maps = await loadLovIdMaps(tx);
      const patch = buildUpdatePatch(input);
      const nextStatus = nextUpdateStatusId({ input, before, maps });
      if (nextStatus !== undefined) patch.statusId = nextStatus;

      const updated = await txDb.update(transactions, input.id, patch);
      if (!updated) throw new TRPCError({ code: "NOT_FOUND" });

      await writeAuditEntry({
        ctx: { tenantId: ctx.tenantId, userId: ctx.userId },
        entityType: TRANSACTION_ENTITY,
        entityId: updated.id,
        action: "update",
        before: transactionAuditProjection(before),
        after: transactionAuditProjection(updated),
        tx,
      });

      return updated;
    });
  }),

  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (txDb, tx) => {
        const deleted = await txDb.softDelete(transactions, input.id);
        if (!deleted) throw new TRPCError({ code: "NOT_FOUND" });
        await writeAuditEntry({
          ctx: { tenantId: ctx.tenantId, userId: ctx.userId },
          entityType: TRANSACTION_ENTITY,
          entityId: deleted.id,
          action: "delete",
          tx,
        });
        return deleted;
      });
    }),

  restore: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (txDb, tx) => {
        const restored = await txDb.restore(transactions, input.id);
        if (!restored) throw new TRPCError({ code: "NOT_FOUND" });
        await writeAuditEntry({
          ctx: { tenantId: ctx.tenantId, userId: ctx.userId },
          entityType: TRANSACTION_ENTITY,
          entityId: restored.id,
          action: "restore",
          tx,
        });
        return restored;
      });
    }),

  // Manual-entry auto-fill. Mirrors the import orchestrator's classifier
  // chain — same five targets, same engine. Frontend picks SUPPLIER vs
  // CUSTOMER based on the form's transactionTypeCode.
  suggest: protectedProcedure
    .input(
      z.object({
        description: z.string().trim().min(1).max(1000),
        actualAmount: z.number().int().nullable().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const proposal = await runChainForTargets(SUGGEST_TARGETS, {
        candidate: input.description,
        row: {
          id: null,
          description: input.description,
          actualAmount: toBigIntOrNull(input.actualAmount ?? null),
          subtypeId: null,
          rawPayload: null,
        },
        ctx: {
          tenantId: ctx.tenantId,
          tenantIndustry: ctx.tenantIndustry,
          userId: ctx.userId,
          bankSlug: null,
        },
      });
      return proposal;
    }),
});
