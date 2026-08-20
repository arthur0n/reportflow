// api/trpc/routers/conciliation.router.ts
//
// G-02 issues workspace. Lists follow the transactions.list convention:
// server returns the full scoped set with labels joined, client paginates.
// Buckets: pending (unmatched), matched, ignored (soft-deleted). All writes
// audited; matching itself lives in api/services/acquirer-sales.ts.

import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { router, protectedProcedure } from "../procedures";
import {
  acquirerSales,
  acquirerSaleSettlements,
  listOfValues,
  statementImports,
  statementImportRows,
} from "../../../drizzle/schema";
import {
  ListSalesInput,
  ListUnmatchedDepositsInput,
  ListStatementRowsInput,
  RunMatchingInput,
  MatchManuallyInput,
  SaleIdInput,
} from "../../../shared/validation/conciliation-schemas";
import {
  loadAcquirers,
  loadUnmatchedDeposits,
  removeSaleLinks,
  runAcquirerMatching,
} from "../../services/acquirer-sales";
import { writeAuditEntry } from "../../services/audit";
import { withSystemFields } from "../../db/scope";

const SALE_ENTITY = "ACQUIRER_SALE";

function searchCondition(search: string | undefined) {
  if (search === undefined || search.length === 0) return undefined;
  const like = `%${search}%`;
  // Amount search: digits in the query match against the cents value.
  const digits = search.replace(/\D/g, "");
  if (digits.length > 0) {
    return sql`(${acquirerSales.method} ILIKE ${like} OR ${acquirerSales.netAmount}::text LIKE ${`%${digits}%`})`;
  }
  return sql`${acquirerSales.method} ILIKE ${like}`;
}

export const conciliationRouter = router({
  /** Bucket counts + pending total for the page header. */
  overview: protectedProcedure.query(async ({ ctx }) => {
    const linked = sql`EXISTS (
      SELECT 1 FROM acquirer_sale_settlements l
      WHERE l.sale_id = ${acquirerSales.id} AND l.tenant_id = ${ctx.tenantId}
    )`;
    const [buckets] = await ctx.db.raw
      .select({
        pendingSales: sql<number>`count(*) FILTER (WHERE NOT ${linked} AND ${acquirerSales.deletedAt} IS NULL)::int`,
        pendingTotal: sql<string>`coalesce(sum(${acquirerSales.netAmount}) FILTER (WHERE NOT ${linked} AND ${acquirerSales.deletedAt} IS NULL), 0)`,
        matchedCount: sql<number>`count(*) FILTER (WHERE ${linked} AND ${acquirerSales.deletedAt} IS NULL)::int`,
        ignoredCount: sql<number>`count(*) FILTER (WHERE ${acquirerSales.deletedAt} IS NOT NULL)::int`,
      })
      .from(acquirerSales)
      .where(eq(acquirerSales.tenantId, ctx.tenantId));

    let unmatchedDeposits = 0;
    for (const acquirer of await loadAcquirers()) {
      if (acquirer.depositPattern === null || acquirer.depositPattern.length === 0) continue;
      unmatchedDeposits += (
        await loadUnmatchedDeposits(ctx.tenantId, { pattern: acquirer.depositPattern })
      ).length;
    }

    return {
      pendingSales: buckets?.pendingSales ?? 0,
      pendingTotal: BigInt(buckets?.pendingTotal ?? "0"),
      matchedCount: buckets?.matchedCount ?? 0,
      ignoredCount: buckets?.ignoredCount ?? 0,
      unmatchedDeposits,
    };
  }),

  /** Acquirer registry for filters/labels. */
  listAcquirers: protectedProcedure.query(async () => {
    return (await loadAcquirers()).map((a) => ({ id: a.id, value: a.value }));
  }),

  /** Sales rows for one bucket (or all), settlement links joined. */
  listSales: protectedProcedure.input(ListSalesInput).query(async ({ ctx, input }) => {
    const linked = sql`EXISTS (
      SELECT 1 FROM acquirer_sale_settlements l
      WHERE l.sale_id = ${acquirerSales.id} AND l.tenant_id = ${ctx.tenantId}
    )`;
    const bucketCondition =
      input.bucket === "all"
        ? undefined
        : input.bucket === "pending"
          ? and(sql`NOT ${linked}`, isNull(acquirerSales.deletedAt))
          : input.bucket === "matched"
            ? and(sql`${linked}`, isNull(acquirerSales.deletedAt))
            : isNotNull(acquirerSales.deletedAt);

    const conditions = [
      ctx.db.scope(acquirerSales, { includeDeleted: true }),
      bucketCondition,
      searchCondition(input.search),
    ].filter((c) => c !== undefined);
    if (input.acquirerId !== undefined) {
      conditions.push(eq(acquirerSales.acquirerId, input.acquirerId));
    }
    if (input.from !== undefined) {
      conditions.push(sql`${acquirerSales.saleDate} >= ${input.from}`);
    }
    if (input.to !== undefined) {
      conditions.push(sql`${acquirerSales.saleDate} <= ${input.to}`);
    }

    const saleRows = await ctx.db.raw
      .select({
        id: acquirerSales.id,
        saleDate: acquirerSales.saleDate,
        saleTime: acquirerSales.saleTime,
        method: acquirerSales.method,
        brand: acquirerSales.brand,
        grossAmount: acquirerSales.grossAmount,
        feeAmount: acquirerSales.feeAmount,
        netAmount: acquirerSales.netAmount,
        expectedPaymentDate: acquirerSales.expectedPaymentDate,
        saleCode: acquirerSales.saleCode,
        acquirerId: acquirerSales.acquirerId,
        acquirerLabel: listOfValues.value,
      })
      .from(acquirerSales)
      .leftJoin(listOfValues, eq(listOfValues.id, acquirerSales.acquirerId))
      .where(and(...conditions))
      .orderBy(desc(acquirerSales.saleDate), acquirerSales.method);

    if (saleRows.length === 0) return [];

    const links = await ctx.db.raw
      .select({
        saleId: acquirerSaleSettlements.saleId,
        rule: acquirerSaleSettlements.rule,
        rowId: statementImportRows.id,
        depositDate: statementImportRows.actualDate,
        depositDescription: statementImportRows.description,
        depositAmount: statementImportRows.actualAmount,
      })
      .from(acquirerSaleSettlements)
      .innerJoin(
        statementImportRows,
        eq(statementImportRows.id, acquirerSaleSettlements.statementRowId),
      )
      .where(
        and(
          eq(acquirerSaleSettlements.tenantId, ctx.tenantId),
          inArray(
            acquirerSaleSettlements.saleId,
            saleRows.map((r) => r.id),
          ),
        ),
      );

    const bySale = new Map<string, typeof links>();
    for (const link of links) {
      const list = bySale.get(link.saleId) ?? [];
      list.push(link);
      bySale.set(link.saleId, list);
    }

    return saleRows.map((r) => ({
      ...r,
      deposits: (bySale.get(r.id) ?? []).map((l) => ({
        rowId: l.rowId,
        rule: l.rule,
        date: l.depositDate,
        description: l.depositDescription,
        amount: l.depositAmount ?? 0n,
      })),
    }));
  }),

  /** Acquirer-labeled deposits no sale row claims. */
  listUnmatchedDeposits: protectedProcedure
    .input(ListUnmatchedDepositsInput)
    .query(async ({ ctx, input }) => {
      const rows = [];
      for (const acquirer of await loadAcquirers()) {
        if (acquirer.depositPattern === null || acquirer.depositPattern.length === 0) continue;
        const deposits = await loadUnmatchedDeposits(ctx.tenantId, {
          pattern: acquirer.depositPattern,
        });
        rows.push(...deposits.map((d) => ({ ...d, acquirerLabel: acquirer.value })));
      }
      const search = input.search?.toLowerCase();
      const filtered = rows.filter((r) => {
        if (input.from !== undefined && (r.actualDate ?? "") < input.from) return false;
        if (input.to !== undefined && (r.actualDate ?? "") > input.to) return false;
        if (search === undefined || search.length === 0) return true;
        return (
          (r.description ?? "").toLowerCase().includes(search) ||
          r.actualAmount.toString().includes(search.replace(/\D/g, ""))
        );
      });
      return filtered.sort((a, b) => (b.actualDate ?? "").localeCompare(a.actualDate ?? ""));
    }),

  /**
   * Bank-statement rows of live imports inside a date window — the monthly
   * Extrato view. Read-only values, independent of review/approval.
   */
  listStatementRows: protectedProcedure
    .input(ListStatementRowsInput)
    .query(async ({ ctx, input }) => {
      return ctx.db.raw
        .select({
          id: statementImportRows.id,
          lineNumber: statementImportRows.lineNumber,
          actualDate: statementImportRows.actualDate,
          description: statementImportRows.description,
          actualAmount: statementImportRows.actualAmount,
        })
        .from(statementImportRows)
        .innerJoin(statementImports, eq(statementImports.id, statementImportRows.statementImportId))
        .where(
          and(
            ctx.db.scope(statementImportRows),
            eq(statementImports.sourceKind, "bank"),
            sql`${statementImports.status} IN ('parsed', 'approved')`,
            sql`${statementImportRows.status} NOT IN ('parsed_error', 'deleted')`,
            sql`${statementImportRows.actualDate} >= ${input.from}`,
            sql`${statementImportRows.actualDate} <= ${input.to}`,
          ),
        )
        .orderBy(statementImportRows.actualDate, statementImportRows.lineNumber);
    }),

  /** Run the value-first rule chain now. */
  runMatching: protectedProcedure.input(RunMatchingInput).mutation(async ({ ctx, input }) => {
    return runAcquirerMatching({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      ...(input.acquirerId !== undefined ? { acquirerId: input.acquirerId } : {}),
    });
  }),

  /** Manually link sales to a statement deposit row. */
  matchManually: protectedProcedure.input(MatchManuallyInput).mutation(async ({ ctx, input }) => {
    const [deposit] = await ctx.db.raw
      .select({ id: statementImportRows.id })
      .from(statementImportRows)
      .where(
        and(
          ctx.db.scope(statementImportRows),
          eq(statementImportRows.id, input.depositRowId),
          sql`${statementImportRows.actualAmount} > 0`,
        ),
      )
      .limit(1);
    if (!deposit) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Depósito não encontrado" });
    }

    for (const saleId of input.saleIds) {
      const sale = await ctx.db.byId(acquirerSales, saleId);
      if (!sale) throw new TRPCError({ code: "NOT_FOUND" });
      await ctx.db.raw
        .insert(acquirerSaleSettlements)
        .values(
          withSystemFields({ userId: ctx.userId }, "create", {
            tenantId: ctx.tenantId,
            saleId,
            statementRowId: input.depositRowId,
            rule: "manual",
          }),
        )
        .onConflictDoNothing();
      await writeAuditEntry({
        ctx: { tenantId: ctx.tenantId, userId: ctx.userId },
        entityType: SALE_ENTITY,
        entityId: saleId,
        action: "match",
        after: { statementRowId: input.depositRowId, rule: "manual" },
      });
    }
    return { matched: input.saleIds.length };
  }),

  /** Undo a match (auto or manual) — removes all of the sale's links. */
  unmatch: protectedProcedure.input(SaleIdInput).mutation(async ({ ctx, input }) => {
    const before = await ctx.db.byId(acquirerSales, input.id);
    if (!before) throw new TRPCError({ code: "NOT_FOUND" });
    const removed = await removeSaleLinks(ctx.tenantId, input.id);
    await writeAuditEntry({
      ctx: { tenantId: ctx.tenantId, userId: ctx.userId },
      entityType: SALE_ENTITY,
      entityId: input.id,
      action: "unmatch",
      before: { links: removed },
      after: { links: 0 },
    });
    return { success: true };
  }),

  /** Ignore a sale row (soft-delete); it leaves the pending bucket. */
  ignoreSale: protectedProcedure.input(SaleIdInput).mutation(async ({ ctx, input }) => {
    const row = await ctx.db.softDelete(acquirerSales, input.id);
    if (!row) throw new TRPCError({ code: "NOT_FOUND" });
    await writeAuditEntry({
      ctx: { tenantId: ctx.tenantId, userId: ctx.userId },
      entityType: SALE_ENTITY,
      entityId: input.id,
      action: "delete",
    });
    return { success: true };
  }),

  restoreSale: protectedProcedure.input(SaleIdInput).mutation(async ({ ctx, input }) => {
    const row = await ctx.db.restore(acquirerSales, input.id);
    if (!row) throw new TRPCError({ code: "NOT_FOUND" });
    await writeAuditEntry({
      ctx: { tenantId: ctx.tenantId, userId: ctx.userId },
      entityType: SALE_ENTITY,
      entityId: input.id,
      action: "restore",
    });
    return { success: true };
  }),
});

export type ConciliationRouter = typeof conciliationRouter;
