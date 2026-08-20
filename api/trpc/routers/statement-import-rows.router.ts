// api/trpc/routers/statement-import-rows.router.ts
//
// Row-level import operations: list, match candidates, edit, review, delete.

import { z } from "zod/v4";
import { TRPCError } from "@trpc/server";
import { eq, and, sql, isNull, asc, inArray } from "drizzle-orm";
import { router, protectedProcedure } from "../procedures";
import { withSystemFields } from "../../db/scope";
import {
  statementImportRows,
  statementImports,
  transactions,
  listOfValues,
} from "../../../drizzle/schema";
import {
  ListImportRowsInput,
  UpdateErrorRowInput,
  ReviewRowInput,
  ReviewBulkInput,
  ResolveRowInput,
  SetClassificationInput,
  SetAccrualDateInput,
  SetReferenceInput,
} from "../../../shared/validation/statement-import-schemas";
import { resolve } from "../../imports/resolve";
import { classifyTransactionType } from "../../imports/classify";
import { recordDecision, type MatchOutcome, type MatchTargetKey } from "../../imports/matcher";

/**
 * Extract the FK + reference column patches from a review/setClassification
 * input. `undefined` fields are skipped so callers can spread the result into
 * a status update without clobbering untouched columns. Reference empty-string
 * collapses to NULL — we never store the empty string.
 */
function collectRowFieldUpdates(input: {
  categoryId?: string | null | undefined;
  creditorId?: string | null | undefined;
  paymentMethodId?: string | null | undefined;
  subtypeId?: string | null | undefined;
  businessUnitId?: string | null | undefined;
  reference?: string | null | undefined;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input.categoryId !== undefined) out["categoryId"] = input.categoryId;
  if (input.creditorId !== undefined) out["creditorId"] = input.creditorId;
  if (input.paymentMethodId !== undefined) out["paymentMethodId"] = input.paymentMethodId;
  if (input.subtypeId !== undefined) out["subtypeId"] = input.subtypeId;
  if (input.businessUnitId !== undefined) out["businessUnitId"] = input.businessUnitId;
  if (input.reference !== undefined) {
    out["reference"] =
      input.reference !== null && input.reference.length > 0 ? input.reference : null;
  }
  return out;
}

const REVIEWABLE_STATUSES = [
  "parsed_ok",
  "edited",
  "reviewed_new",
  "reviewed_matched",
  "reviewed_skip",
];
const EDITABLE_STATUSES = ["parsed_error", "edited"];

export const statementImportRowsRouter = router({
  /** Rows for an import, optionally filtered by status. */
  list: protectedProcedure.input(ListImportRowsInput).query(async ({ ctx, input }) => {
    const imp = await ctx.db.byId(statementImports, input.importId);

    if (!imp) throw new TRPCError({ code: "NOT_FOUND" });

    const conditions = [eq(statementImportRows.statementImportId, input.importId)];
    if (input.status !== undefined) {
      conditions.push(eq(statementImportRows.status, input.status));
    }

    return ctx.db.raw
      .select()
      .from(statementImportRows)
      .where(and(...conditions))
      .orderBy(asc(statementImportRows.lineNumber));
  }),

  /**
   * Match candidates for a single row.
   * Finds existing transactions that could match the imported row.
   */
  candidates: protectedProcedure
    .input(z.object({ rowId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const row = await ctx.db.byId(statementImportRows, input.rowId);

      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      if (row.actualDate === null || row.actualAmount === null) return [];

      const [imp] = await ctx.db.raw
        .select({ cashBoxId: statementImports.cashBoxId })
        .from(statementImports)
        .where(eq(statementImports.id, row.statementImportId))
        .limit(1);

      const amount = row.actualAmount;
      const absAmount = amount < 0n ? -amount : amount;
      const onePercent = absAmount / 100n;
      const tolerance = onePercent < 100n ? 100n : onePercent;

      // Resolve status & type codes ↔ ids once for this query.
      const systemLov = await ctx.db.raw
        .select({ id: listOfValues.id, code: listOfValues.code, type: listOfValues.type })
        .from(listOfValues)
        .where(
          and(
            inArray(listOfValues.type, ["TRANSACTION_STATUS", "TRANSACTION_TYPE"]),
            isNull(listOfValues.tenantId),
            isNull(listOfValues.deletedAt),
          ),
        );
      const statusIdByCode = new Map(
        systemLov.filter((r) => r.type === "TRANSACTION_STATUS").map((r) => [r.code, r.id]),
      );
      const typeCodeById = new Map(
        systemLov.filter((r) => r.type === "TRANSACTION_TYPE").map((r) => [r.id, r.code]),
      );
      const statusCodeById = new Map(
        systemLov.filter((r) => r.type === "TRANSACTION_STATUS").map((r) => [r.id, r.code]),
      );

      const candidateStatusIds = ["CERTO", "ESTIMADO"]
        .map((c) => statusIdByCode.get(c))
        .filter((id): id is string => id !== undefined);

      const conditions = [
        ctx.db.scope(transactions),
        isNull(transactions.actualDate),
        inArray(transactions.statusId, candidateStatusIds),
      ];

      if (imp?.cashBoxId !== null && imp?.cashBoxId !== undefined) {
        conditions.push(eq(transactions.cashBoxId, imp.cashBoxId));
      }

      conditions.push(
        sql`(
          ${transactions.dueDate} BETWEEN (${row.actualDate}::date - 3) AND (${row.actualDate}::date + 3)
          OR ${transactions.accrualDate} BETWEEN (${row.actualDate}::date - 3) AND (${row.actualDate}::date + 3)
        )`,
      );

      conditions.push(sql`ABS(${transactions.forecastAmount} - ${amount}) <= ${tolerance}`);

      const candidates = await ctx.db.raw
        .select()
        .from(transactions)
        .where(and(...conditions))
        .limit(10);

      const amountNum = Number(amount);
      const rowDateMs = new Date(row.actualDate).getTime();

      // PAYMENT_METHOD code drives transfer detection. One small lookup; null
      // when the row has no payment method (chain didn't auto-fill, user hasn't
      // picked yet) — coarse type then collapses to sign-based EXPENSE/REVENUE.
      let paymentMethodCode: string | null = null;
      if (row.paymentMethodId !== null) {
        const [pm] = await ctx.db.raw
          .select({ code: listOfValues.code })
          .from(listOfValues)
          .where(eq(listOfValues.id, row.paymentMethodId))
          .limit(1);
        paymentMethodCode = pm?.code ?? null;
      }
      const rowCoarseType = classifyTransactionType({
        actualAmount: amount,
        paymentMethodCode,
      });

      return candidates
        .map((c) => {
          let score = 0;

          const diff = Math.abs(Number(c.forecastAmount) - amountNum);
          if (diff === 0) score += 50;
          else if (diff <= 100) score += 30;
          else score += 10;

          const dueDiffMs = Math.abs(new Date(c.dueDate).getTime() - rowDateMs);
          const accrualDiffMs = Math.abs(new Date(c.accrualDate).getTime() - rowDateMs);
          const dateDiffDays = Math.min(dueDiffMs, accrualDiffMs) / 86400000;

          if (dateDiffDays === 0) score += 30;
          else if (dateDiffDays <= 1) score += 15;
          else score += 5;

          if (typeCodeById.get(c.transactionTypeId) === rowCoarseType) {
            score += 10;
          }

          if (statusCodeById.get(c.statusId) === "ESTIMADO") score += 15;

          return { transaction: c, score };
        })
        .sort((a, b) => b.score - a.score);
    }),

  /** Patch a parsed_error row → edited. */
  update: protectedProcedure.input(UpdateErrorRowInput).mutation(async ({ ctx, input }) => {
    const { id, ...fields } = input;

    const row = await ctx.db.byId(statementImportRows, id);

    if (!row) throw new TRPCError({ code: "NOT_FOUND" });
    if (!EDITABLE_STATUSES.includes(row.status)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `row status is '${row.status}', must be 'parsed_error' or 'edited'`,
      });
    }

    const setValues: Record<string, unknown> = {
      status: "edited",
      editedAt: new Date().toISOString(),
      editedBy: ctx.userId,
    };
    if (fields.actualDate !== undefined) setValues["actualDate"] = fields.actualDate;
    if (fields.actualAmount !== undefined) setValues["actualAmount"] = BigInt(fields.actualAmount);
    if (fields.description !== undefined) setValues["description"] = fields.description;
    if (fields.subtypeId !== undefined) setValues["subtypeId"] = fields.subtypeId;

    const updated = await ctx.db.update(statementImportRows, id, setValues);

    return updated;
  }),

  /** Set a row's review decision. */
  review: protectedProcedure.input(ReviewRowInput).mutation(async ({ ctx, input }) => {
    const row = await ctx.db.byId(statementImportRows, input.id);

    if (!row) throw new TRPCError({ code: "NOT_FOUND" });

    if (!REVIEWABLE_STATUSES.includes(row.status)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `row status '${row.status}' cannot be reviewed`,
      });
    }

    if (input.action === "match") {
      if (input.matchedTransactionId === undefined) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "matchedTransactionId required for 'match' action",
        });
      }

      const [txn] = await ctx.db.raw
        .select({ id: transactions.id })
        .from(transactions)
        .where(and(eq(transactions.id, input.matchedTransactionId), ctx.db.scope(transactions)))
        .limit(1);

      if (!txn) {
        throw new TRPCError({ code: "NOT_FOUND", message: "matched transaction not found" });
      }
    }

    const statusMap = {
      new: "reviewed_new",
      match: "reviewed_matched",
      skip: "reviewed_skip",
    } as const;

    const setValues: Record<string, unknown> = {
      status: statusMap[input.action],
      matchedTransactionId: input.action === "match" ? (input.matchedTransactionId ?? null) : null,
      reviewedAt: new Date().toISOString(),
      reviewedBy: ctx.userId,
      ...collectRowFieldUpdates(input),
    };

    const updated = await ctx.db.update(statementImportRows, input.id, setValues);

    // Best-effort: record the classifier decision and any user-promoted rules.
    // Failure here must NOT roll back the user's review — log and move on.
    if (updated !== undefined) {
      try {
        await recordDecision({
          ctx: { tenantId: ctx.tenantId, userId: ctx.userId },
          rowBefore: {
            id: row.id,
            description: row.description,
            categoryId: row.categoryId,
            creditorId: row.creditorId,
            paymentMethodId: row.paymentMethodId,
            subtypeId: row.subtypeId,
            matchProposalJson: (row.matchProposalJson ?? null) as Record<
              MatchTargetKey,
              MatchOutcome
            > | null,
          },
          rowAfter: {
            categoryId: updated.categoryId,
            creditorId: updated.creditorId,
            paymentMethodId: updated.paymentMethodId,
            subtypeId: updated.subtypeId,
          },
          autoMatchPatterns: input.autoMatchPatterns,
        });
      } catch (err) {
        console.warn("recordDecision failed for row", input.id, err);
      }
    }

    return updated;
  }),

  /**
   * Patch a row's classification fields without touching the review status.
   * Used for fields that are metadata rather than a classification decision
   * (e.g. payment_method) — the row stays in its current bucket, the field
   * is just updated.
   */
  setClassification: protectedProcedure
    .input(SetClassificationInput)
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db.byId(statementImportRows, input.id);

      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      if (!REVIEWABLE_STATUSES.includes(row.status)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `row status '${row.status}' cannot be classified`,
        });
      }

      const setValues = collectRowFieldUpdates(input);

      if (Object.keys(setValues).length === 0) return row;

      const updated = await ctx.db.update(statementImportRows, input.id, setValues);

      return updated;
    }),

  /**
   * Patch a row's free-text reference (NF/boleto/competência string) without
   * touching review status. Empty string clears.
   */
  setReference: protectedProcedure.input(SetReferenceInput).mutation(async ({ ctx, input }) => {
    const row = await ctx.db.byId(statementImportRows, input.id);

    if (!row) throw new TRPCError({ code: "NOT_FOUND" });
    if (!REVIEWABLE_STATUSES.includes(row.status)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `row status '${row.status}' cannot be edited`,
      });
    }

    const next = input.reference !== null && input.reference.length > 0 ? input.reference : null;
    const updated = await ctx.db.update(statementImportRows, input.id, { reference: next });

    return updated;
  }),

  /**
   * Patch a row's accrual date ("competência") without touching review status.
   * Defaults to actual_date at parse; the user can override during review.
   */
  setAccrualDate: protectedProcedure.input(SetAccrualDateInput).mutation(async ({ ctx, input }) => {
    const row = await ctx.db.byId(statementImportRows, input.id);

    if (!row) throw new TRPCError({ code: "NOT_FOUND" });
    if (!REVIEWABLE_STATUSES.includes(row.status)) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `row status '${row.status}' cannot be edited`,
      });
    }

    const updated = await ctx.db.update(statementImportRows, input.id, {
      accrualDate: input.accrualDate,
    });

    return updated;
  }),

  /**
   * Look up the canonical row matching a free-text candidate against the
   * given LOV/tenant_values target. Used by the per-row classification
   * pickers in the review UI on open and on type-ahead. Tenant-scoped row
   * ownership is verified before any query runs.
   */
  resolve: protectedProcedure.input(ResolveRowInput).query(async ({ ctx, input }) => {
    const row = await ctx.db.byId(statementImportRows, input.importRowId);
    if (!row) throw new TRPCError({ code: "NOT_FOUND" });

    return resolve(input.target, input.candidate, {
      tenantId: ctx.tenantId,
      tenantIndustry: ctx.tenantIndustry,
    });
  }),

  /** Apply the same review decision to many rows in one roundtrip. */
  reviewBulk: protectedProcedure.input(ReviewBulkInput).mutation(async ({ ctx, input }) => {
    const targetStatus = input.action === "new" ? "reviewed_new" : "reviewed_skip";

    const updated = await ctx.db.raw
      .update(statementImportRows)
      .set(
        withSystemFields({ userId: ctx.userId }, "update", {
          status: targetStatus,
          matchedTransactionId: null,
          reviewedAt: new Date().toISOString(),
          reviewedBy: ctx.userId,
        }),
      )
      .where(
        and(
          ctx.db.scope(statementImportRows),
          inArray(statementImportRows.id, input.rowIds),
          inArray(statementImportRows.status, REVIEWABLE_STATUSES),
        ),
      )
      .returning({ id: statementImportRows.id });

    return { count: updated.length };
  }),

  /** Mark a row as deleted (treated as skip on approval). */
  delete: protectedProcedure.input(z.string().uuid()).mutation(async ({ ctx, input: id }) => {
    const row = await ctx.db.update(statementImportRows, id, { status: "deleted" });

    if (!row) throw new TRPCError({ code: "NOT_FOUND" });
    return { id: row.id };
  }),
});
