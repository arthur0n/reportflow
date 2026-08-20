// api/services/acquirer-sales.ts
//
// G-02 persistence + matching orchestration. Promotion inserts an acquirer
// report's rows into acquirer_sales at parse time (dedup by the grain index,
// conflicts skipped); matching loads the tenant's unmatched sales and the
// candidate deposit rows from imported bank statements, runs the pure rule
// chain and writes acquirer_sale_settlements links + audit. Conciliation
// works on imported values — it never waits for review/approval into
// transactions.

import { and, eq, isNull, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/client";
import {
  acquirerSales,
  acquirerSaleSettlements,
  listOfValues,
  statementImports,
  statementImportRows,
} from "../../drizzle/schema";
import { withSystemFields } from "../db/scope";
import { writeAuditEntry } from "./audit";
import { runMatchRules, type SaleForMatch, type DepositForMatch } from "./conciliation-match";

export type AcquirerSaleInput = {
  saleDate: string;
  merchantAccount: string;
  saleTime: string | null;
  method: string;
  brand: string | null;
  grossAmount: number;
  feeAmount: number;
  netAmount: number;
  expectedPaymentDate: string;
  nsu: string | null;
  saleCode: string;
  txId: string | null;
};

/** Resolve a parser's acquirer code to its system ACQUIRER LOV row. */
export async function resolveAcquirer(
  code: string,
): Promise<{ id: string; depositPattern: string | null } | null> {
  const [row] = await db
    .select({ id: listOfValues.id, depositPattern: listOfValues.description })
    .from(listOfValues)
    .where(
      and(
        eq(listOfValues.type, "ACQUIRER"),
        eq(listOfValues.code, code),
        isNull(listOfValues.tenantId),
        isNull(listOfValues.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function promoteAcquirerSales(args: {
  tenantId: string;
  importId: string;
  acquirerId: string;
  userId: string;
  rows: AcquirerSaleInput[];
}): Promise<{ inserted: number; skipped: number }> {
  const { tenantId, importId, acquirerId, userId, rows } = args;
  if (rows.length === 0) return { inserted: 0, skipped: 0 };

  const inserted = await db
    .insert(acquirerSales)
    .values(
      rows.map((r) =>
        withSystemFields({ userId }, "create", {
          tenantId,
          acquirerId,
          statementImportId: importId,
          saleDate: r.saleDate,
          merchantAccount: r.merchantAccount,
          saleTime: r.saleTime,
          method: r.method,
          brand: r.brand,
          grossAmount: BigInt(r.grossAmount),
          feeAmount: BigInt(r.feeAmount),
          netAmount: BigInt(r.netAmount),
          expectedPaymentDate: r.expectedPaymentDate,
          nsu: r.nsu,
          saleCode: r.saleCode,
          txId: r.txId,
        }),
      ),
    )
    .onConflictDoNothing()
    .returning({ id: acquirerSales.id });

  return { inserted: inserted.length, skipped: rows.length - inserted.length };
}

/** System ACQUIRER registry rows (optionally narrowed to one id). */
export async function loadAcquirers(
  acquirerId?: string,
): Promise<{ id: string; value: string; depositPattern: string | null }[]> {
  const conditions = [
    eq(listOfValues.type, "ACQUIRER"),
    isNull(listOfValues.tenantId),
    isNull(listOfValues.deletedAt),
  ];
  if (acquirerId !== undefined) conditions.push(eq(listOfValues.id, acquirerId));
  return db
    .select({
      id: listOfValues.id,
      value: listOfValues.value,
      depositPattern: listOfValues.description,
    })
    .from(listOfValues)
    .where(and(...conditions));
}

/** Merchant CPF/CNPJs seen on the tenant's reports for one acquirer. */
export async function loadMerchantTaxIds(tenantId: string, acquirerId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ taxId: statementImports.merchantTaxId })
    .from(statementImports)
    .where(
      and(
        eq(statementImports.tenantId, tenantId),
        eq(statementImports.acquirerId, acquirerId),
        isNotNull(statementImports.merchantTaxId),
      ),
    );
  return rows.map((r) => r.taxId).filter((t): t is string => t !== null);
}

export type UnmatchedDeposit = {
  id: string;
  actualDate: string | null;
  description: string | null;
  actualAmount: bigint;
};

/**
 * Deposit candidates: positive rows of live bank-statement imports matching
 * the description condition and not claimed by any settlement link.
 */
export async function loadUnmatchedDeposits(
  tenantId: string,
  opts: { pattern?: string; containsAny?: string[] },
): Promise<UnmatchedDeposit[]> {
  const descriptionConditions = [];
  if (opts.pattern !== undefined) {
    descriptionConditions.push(sql`${statementImportRows.description} ~* ${opts.pattern}`);
  }
  for (const ref of opts.containsAny ?? []) {
    descriptionConditions.push(sql`${statementImportRows.description} ILIKE ${`%${ref}%`}`);
  }
  if (descriptionConditions.length === 0) return [];

  const rows = await db
    .select({
      id: statementImportRows.id,
      actualDate: statementImportRows.actualDate,
      description: statementImportRows.description,
      actualAmount: statementImportRows.actualAmount,
    })
    .from(statementImportRows)
    .innerJoin(statementImports, eq(statementImports.id, statementImportRows.statementImportId))
    .where(
      and(
        eq(statementImportRows.tenantId, tenantId),
        eq(statementImports.sourceKind, "bank"),
        sql`${statementImports.status} IN ('parsed', 'approved')`,
        sql`${statementImportRows.status} NOT IN ('parsed_error', 'deleted')`,
        sql`${statementImportRows.actualAmount} > 0`,
        sql`(${sql.join(descriptionConditions, sql` OR `)})`,
        sql`NOT EXISTS (
          SELECT 1 FROM acquirer_sale_settlements l
          WHERE l.statement_row_id = ${statementImportRows.id}
            AND l.tenant_id = ${tenantId}
        )`,
      ),
    );
  return rows.filter((d): d is UnmatchedDeposit => d.actualAmount !== null);
}

/**
 * Run the value-first rule chain for one tenant (optionally one acquirer).
 * Idempotent — only unmatched sales and unclaimed deposits are considered.
 */
export async function runAcquirerMatching(args: {
  tenantId: string;
  userId: string;
  acquirerId?: string;
}): Promise<{ matched: number; remaining: number }> {
  const { tenantId, userId, acquirerId } = args;
  const acquirers = await loadAcquirers(acquirerId);

  let matched = 0;
  let remaining = 0;

  for (const acquirer of acquirers) {
    if (acquirer.depositPattern === null || acquirer.depositPattern.length === 0) continue;

    const unmatchedSales: SaleForMatch[] = await db
      .select({
        id: acquirerSales.id,
        saleDate: acquirerSales.saleDate,
        method: acquirerSales.method,
        brand: acquirerSales.brand,
        netAmount: acquirerSales.netAmount,
        expectedPaymentDate: acquirerSales.expectedPaymentDate,
      })
      .from(acquirerSales)
      .where(
        and(
          eq(acquirerSales.tenantId, tenantId),
          eq(acquirerSales.acquirerId, acquirer.id),
          isNull(acquirerSales.deletedAt),
          sql`NOT EXISTS (
            SELECT 1 FROM acquirer_sale_settlements l
            WHERE l.sale_id = ${acquirerSales.id} AND l.tenant_id = ${tenantId}
          )`,
        ),
      );

    if (unmatchedSales.length === 0) continue;

    const selfReferences = await loadMerchantTaxIds(tenantId, acquirer.id);
    const deposits: DepositForMatch[] = await loadUnmatchedDeposits(tenantId, {
      pattern: acquirer.depositPattern,
      containsAny: selfReferences,
    });

    const pairs = runMatchRules(unmatchedSales, deposits, {
      acquirerPattern: acquirer.depositPattern,
      selfReferences,
    });

    if (pairs.length > 0) {
      await db
        .insert(acquirerSaleSettlements)
        .values(
          pairs.map((pair) =>
            withSystemFields({ userId }, "create", {
              tenantId,
              saleId: pair.saleId,
              statementRowId: pair.depositId,
              rule: pair.rule,
            }),
          ),
        )
        .onConflictDoNothing();

      const bySale = new Map<string, { rule: string; count: number }>();
      for (const pair of pairs) {
        const entry = bySale.get(pair.saleId) ?? { rule: pair.rule, count: 0 };
        entry.count += 1;
        bySale.set(pair.saleId, entry);
      }
      for (const [saleId, info] of bySale) {
        await writeAuditEntry({
          ctx: { tenantId, userId },
          entityType: "ACQUIRER_SALE",
          entityId: saleId,
          action: "match",
          after: { rule: info.rule, links: info.count },
        });
      }
      matched += bySale.size;
      remaining += unmatchedSales.length - bySale.size;
    } else {
      remaining += unmatchedSales.length;
    }
  }

  return { matched, remaining };
}

/** Remove all settlement links of one sale (unmatch). */
export async function removeSaleLinks(tenantId: string, saleId: string): Promise<number> {
  const removed = await db
    .delete(acquirerSaleSettlements)
    .where(
      and(
        eq(acquirerSaleSettlements.tenantId, tenantId),
        eq(acquirerSaleSettlements.saleId, saleId),
      ),
    )
    .returning({ id: acquirerSaleSettlements.id });
  return removed.length;
}
