// api/trpc/routers/statement-imports.router.ts
//
// File-level import operations: upload, list, get, resolve bank account,
// approve, reject.

import { z } from "zod/v4";
import { TRPCError } from "@trpc/server";
import { eq, and, desc, inArray, isNull, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { router, protectedProcedure } from "../procedures";
import { db } from "../../db/client";
import { withSystemFields } from "../../db/scope";
import {
  statementImports,
  statementImportRows,
  transactions,
  listOfValues,
} from "../../../drizzle/schema";
import {
  UploadStatementInput,
  ResolveCashBoxInput,
} from "../../../shared/validation/statement-import-schemas";
import { processImport, transitionStatus } from "../../imports/orchestrator";
import { isLambdaRuntime, storeUploadFile } from "../../imports/async-dispatch";
import { classifyTransactionType } from "../../imports/classify";
import type { TransactionTypeCode } from "../../../shared/constants/transaction-types";
import {
  assertClassifiersComplete,
  defaultTransactionStatus,
} from "../../services/transactions-write";

const TERMINAL_STATUSES = ["reviewed_new", "reviewed_matched", "reviewed_skip", "deleted"];

type ImportRow = typeof statementImportRows.$inferSelect;

/**
 * Build an id → code lookup for the PAYMENT_METHOD LOV rows referenced by the
 * given rows' payment_method_id. Single query; returns an empty map if no
 * row carries a payment method.
 */
async function loadPaymentMethodCodes(rows: ImportRow[]): Promise<Map<string, string>> {
  const ids = [
    ...new Set(rows.map((r) => r.paymentMethodId).filter((id): id is string => id !== null)),
  ];
  if (ids.length === 0) return new Map();
  const fetched = await db
    .select({ id: listOfValues.id, code: listOfValues.code })
    .from(listOfValues)
    .where(inArray(listOfValues.id, ids));
  return new Map(fetched.map((r) => [r.id, r.code]));
}

/**
 * Build a code → id map for a system LOV type (tenant_id IS NULL). Used by
 * the import approve flow to resolve TRANSACTION_TYPE and TRANSACTION_STATUS
 * codes to their FK ids before inserting rows into transactions.
 */
async function loadSystemLovCodeMap(type: string): Promise<Map<string, string>> {
  const fetched = await db
    .select({ id: listOfValues.id, code: listOfValues.code })
    .from(listOfValues)
    .where(
      and(
        eq(listOfValues.type, type),
        isNull(listOfValues.tenantId),
        isNull(listOfValues.deletedAt),
      ),
    );
  return new Map(fetched.map((r) => [r.code, r.id]));
}

function requireLovId(map: Map<string, string>, code: string, type: string): string {
  const id = map.get(code);
  if (id === undefined) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `LOV row not found: type=${type}, code=${code}`,
    });
  }
  return id;
}

function paymentMethodCodeFor(
  paymentMethodId: string | null,
  byId: Map<string, string>,
): string | null {
  if (paymentMethodId === null) return null;
  return byId.get(paymentMethodId) ?? null;
}

/**
 * Pre-flight invariants before approve commits anything: every row terminal,
 * reviewed_new rows have date+amount, reviewed_matched rows have a target.
 * Missing classifiers are NOT a blocker — they downgrade the inserted
 * transaction to status='REVISAR' in commitApprovedRows.
 */
function validateApprovableRows(rows: ImportRow[]): void {
  const unreviewed = rows.filter((r) => !TERMINAL_STATUSES.includes(r.status));
  if (unreviewed.length > 0) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `${String(unreviewed.length)} linha(s) ainda não revisadas`,
    });
  }

  const invalidNew = rows.filter(
    (r) =>
      r.status === "reviewed_new" &&
      (r.actualDate === null || r.actualAmount === null || r.actualAmount === 0n),
  );
  if (invalidNew.length > 0) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `linha(s) ${invalidNew.map((r) => r.lineNumber).join(", ")} sem data/valor válido`,
    });
  }

  const invalidMatched = rows.filter(
    (r) =>
      r.status === "reviewed_matched" &&
      (r.matchedTransactionId === null || r.actualDate === null || r.actualAmount === null),
  );
  if (invalidMatched.length > 0) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `linha(s) ${invalidMatched.map((r) => r.lineNumber).join(", ")} marcadas como conciliadas sem transação vinculada`,
    });
  }
}

/**
 * Commit all reviewed rows inside a single DB transaction: insert `reviewed_new`
 * rows, update `reviewed_matched` targets, skip the rest, and flip the import
 * to `approved`.
 *
 * ctx.db verbs do not apply inside drizzle tx closure; use raw + manual stamping.
 */
/** Status code to stamp on a row being committed as a new transaction. */
function statusCodeFor(row: ImportRow, transactionTypeCode: TransactionTypeCode): string {
  return defaultTransactionStatus({
    actualDate: row.actualDate,
    actualAmount: row.actualAmount,
    missingClassifiers: assertClassifiersComplete({
      transactionType: transactionTypeCode,
      creditorId: row.creditorId,
      categoryId: row.categoryId,
      paymentMethodId: row.paymentMethodId,
    }),
  });
}

async function commitApprovedRows(args: {
  rawDb: typeof db;
  rows: ImportRow[];
  importId: string;
  tenantId: string;
  userId: string;
  cashBoxId: string | null;
  pmCodeById: Map<string, string>;
  typeIdByCode: Map<string, string>;
  statusIdByCode: Map<string, string>;
}): Promise<{ created: number; matched: number; skipped: number }> {
  const {
    rawDb,
    rows,
    importId,
    tenantId,
    userId,
    cashBoxId,
    pmCodeById,
    typeIdByCode,
    statusIdByCode,
  } = args;
  const ctx = { userId };
  let created = 0;
  let matched = 0;
  let skipped = 0;

  await rawDb.transaction(async (tx) => {
    for (const row of rows) {
      if (row.status === "reviewed_new" && row.actualDate !== null && row.actualAmount !== null) {
        const transactionTypeCode = classifyTransactionType({
          actualAmount: row.actualAmount,
          paymentMethodCode: paymentMethodCodeFor(row.paymentMethodId, pmCodeById),
        });
        const statusCode = statusCodeFor(row, transactionTypeCode);
        await tx.insert(transactions).values(
          withSystemFields(ctx, "create", {
            tenantId,
            businessUnitId: row.businessUnitId,
            transactionTypeId: requireLovId(typeIdByCode, transactionTypeCode, "TRANSACTION_TYPE"),
            cashBoxId,
            categoryId: row.categoryId,
            creditorId: row.creditorId,
            paymentMethodId: row.paymentMethodId,
            statementImportId: importId,
            accrualDate: row.accrualDate ?? row.actualDate,
            dueDate: row.actualDate,
            actualDate: row.actualDate,
            forecastAmount: row.actualAmount,
            actualAmount: row.actualAmount,
            statusId: requireLovId(statusIdByCode, statusCode, "TRANSACTION_STATUS"),
            description: row.description,
            reference: row.reference,
            externalId: row.externalId,
          }),
        );
        created++;
      } else if (
        row.status === "reviewed_matched" &&
        row.matchedTransactionId !== null &&
        row.actualDate !== null &&
        row.actualAmount !== null
      ) {
        await tx
          .update(transactions)
          .set(
            withSystemFields(ctx, "update", {
              actualDate: row.actualDate,
              actualAmount: row.actualAmount,
              cashBoxId,
              statementImportId: importId,
              externalId: row.externalId,
              statusId: requireLovId(statusIdByCode, "CERTO", "TRANSACTION_STATUS"),
            }),
          )
          .where(eq(transactions.id, row.matchedTransactionId));
        matched++;
      } else {
        skipped++;
      }
    }

    await tx
      .update(statementImports)
      .set(
        withSystemFields(ctx, "update", {
          status: "approved",
          approvedAt: new Date().toISOString(),
        }),
      )
      .where(eq(statementImports.id, importId));
  });

  return { created, matched, skipped };
}

export const statementImportsRouter = router({
  /**
   * Upload a single file (base64). Parses synchronously.
   * On file-hash collision with a still-active import, returns a
   * `duplicate_warning` shape instead of throwing — the UI prompts the user
   * to confirm, then retries with `confirmDuplicate: true` which supersedes
   * the existing import (marked rejected) and proceeds.
   */
  upload: protectedProcedure.input(UploadStatementInput).mutation(async ({ ctx, input }) => {
    const fileBuffer = Buffer.from(input.fileContent, "base64");
    const fileHash = createHash("sha256").update(fileBuffer).digest("hex");
    const fileSize = fileBuffer.length;

    const [existing] = await ctx.db.raw
      .select()
      .from(statementImports)
      .where(
        and(
          ctx.db.scope(statementImports),
          eq(statementImports.fileHash, fileHash),
          sql`${statementImports.status} NOT IN ('approved', 'rejected', 'upload_timeout')`,
        ),
      )
      .limit(1);

    if (existing && !input.confirmDuplicate) {
      return {
        status: "duplicate_warning" as const,
        existing: {
          id: existing.id,
          fileName: existing.fileName,
          status: existing.status,
          uploadedAt: existing.uploadedAt,
          bankSlug: existing.bankSlug,
          periodStart: existing.periodStart,
          periodEnd: existing.periodEnd,
        },
      };
    }

    if (existing) {
      await transitionStatus(existing.id, ctx.tenantId, existing.status, "rejected", ctx.userId);
    }

    const importRow = await ctx.db.create(statementImports, {
      userId: ctx.userId,
      fileName: input.fileName,
      fileSize,
      fileHash,
      status: "uploaded_pending",
    });

    // In Lambda the parse must not ride the HTTP request (API Gateway cuts
    // off around 30s and a full statement takes longer): store the file in
    // S3 — the bucket's ObjectCreated notification triggers the parse in a
    // separate invocation (see api/handler.ts) and the UI polls status. The
    // dev server has no gateway cap and parses inline.
    if (isLambdaRuntime()) {
      const s3Key = `uploads/${ctx.tenantId}/${importRow.id}/${input.fileName}`;
      await ctx.db.update(statementImports, importRow.id, { s3Key });
      await storeUploadFile(s3Key, fileBuffer);
    } else {
      await processImport(importRow.id, fileBuffer, ctx.tenantId, ctx.userId, ctx.tenantIndustry);
    }

    const updated = await ctx.db.byId(statementImports, importRow.id);

    if (!updated) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    }

    return { status: "ok" as const, import: updated };
  }),

  /**
   * Paginated list of imports for current tenant. Sweeps imports stuck in a
   * busy status first (async processing died — Lambda kill, deploy window):
   * anything busy for over 10 minutes flips to upload_timeout so pollers and
   * the guided flow stop treating it as in-flight.
   */
  list: protectedProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(100).default(20),
          cursor: z.string().datetime().optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 20;

      const stale = await ctx.db.raw
        .select({ id: statementImports.id, status: statementImports.status })
        .from(statementImports)
        .where(
          and(
            ctx.db.scope(statementImports),
            sql`${statementImports.status} IN ('uploaded_pending', 'parsing')`,
            sql`${statementImports.lastUpdAt} < now() - interval '10 minutes'`,
          ),
        );
      for (const row of stale) {
        await transitionStatus(row.id, ctx.tenantId, row.status, "upload_timeout", null, {
          errorMessage: "processing_timeout",
        });
      }

      const conditions = [ctx.db.scope(statementImports)];
      if (input?.cursor !== undefined) {
        conditions.push(sql`${statementImports.lastUpdAt} < ${input.cursor}`);
      }

      const rows = await ctx.db.raw
        .select()
        .from(statementImports)
        .where(and(...conditions))
        .orderBy(desc(statementImports.lastUpdAt))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? items[items.length - 1]?.lastUpdAt : undefined;

      return { items, nextCursor };
    }),

  /** Single import with row count breakdown by status. */
  get: protectedProcedure.input(z.string().uuid()).query(async ({ ctx, input: id }) => {
    const row = await ctx.db.byId(statementImports, id);

    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND" });
    }

    // Parent FK already restricts to this tenant; no scope predicate needed.
    const statusCounts = await ctx.db.raw
      .select({
        status: statementImportRows.status,
        count: sql<number>`count(*)::int`,
      })
      .from(statementImportRows)
      .where(eq(statementImportRows.statementImportId, id))
      .groupBy(statementImportRows.status);

    const counts: Record<string, number> = {};
    for (const sc of statusCounts) {
      counts[sc.status] = sc.count;
    }

    return { ...row, statusCounts: counts };
  }),

  /** User picks or creates a cash box for this import. */
  resolveCashBox: protectedProcedure.input(ResolveCashBoxInput).mutation(async ({ ctx, input }) => {
    const row = await ctx.db.update(statementImports, input.importId, {
      cashBoxId: input.cashBoxId,
    });

    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND" });
    }
    return row;
  }),

  /** Approve: commit reviewed rows to transactions. */
  approve: protectedProcedure
    .input(z.string().uuid())
    .mutation(async ({ ctx, input: importId }) => {
      const imp = await ctx.db.byId(statementImports, importId);

      if (!imp) throw new TRPCError({ code: "NOT_FOUND" });
      if (imp.sourceKind === "card") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Importações de cartão não geram lançamentos — use a conferência",
        });
      }
      if (imp.status !== "parsed") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `import status is '${imp.status}', expected 'parsed'`,
        });
      }

      const rows = await ctx.db.raw
        .select()
        .from(statementImportRows)
        .where(eq(statementImportRows.statementImportId, importId))
        .orderBy(statementImportRows.lineNumber);

      validateApprovableRows(rows);
      const [pmCodeById, typeIdByCode, statusIdByCode] = await Promise.all([
        loadPaymentMethodCodes(rows),
        loadSystemLovCodeMap("TRANSACTION_TYPE"),
        loadSystemLovCodeMap("TRANSACTION_STATUS"),
      ]);

      const counts = await commitApprovedRows({
        rawDb: db,
        rows,
        importId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        cashBoxId: imp.cashBoxId,
        pmCodeById,
        typeIdByCode,
        statusIdByCode,
      });

      await transitionStatus(importId, ctx.tenantId, "parsed", "approved", ctx.userId);

      return counts;
    }),

  /** Reject: discard the import without touching transactions. */
  reject: protectedProcedure.input(z.string().uuid()).mutation(async ({ ctx, input: importId }) => {
    const imp = await ctx.db.byId(statementImports, importId);

    if (!imp) throw new TRPCError({ code: "NOT_FOUND" });
    if (imp.status === "approved" || imp.status === "rejected") {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `import already ${imp.status}`,
      });
    }

    await transitionStatus(importId, ctx.tenantId, imp.status, "rejected", ctx.userId);

    return { success: true };
  }),
});
