// api/imports/orchestrator.ts
//
// Orchestrates format detection → parsing → row insertion → status updates.
// Called synchronously by the upload mutation (POC). When we move to async S3
// parsing, this same function runs inside the S3 event handler.

import { and, eq, isNull, isNotNull, ne } from "drizzle-orm";
import { db } from "../db/client";
import {
  listOfValues,
  statementImports,
  statementImportRows,
  statementImportEvents,
  tenantValues,
} from "../../drizzle/schema";
import { detectFormat } from "./format-detect";
import { resolveBankSlug } from "../services/bank-routing";
import {
  resolveAcquirer,
  promoteAcquirerSales,
  runAcquirerMatching,
  type AcquirerSaleInput,
} from "../services/acquirer-sales";
import { runChainForTargets, type MatchOutcome, type MatchTarget } from "./matcher";

type ProcessResult = {
  status: "parsed" | "parse_failed";
  rowsTotal: number;
  rowsError: number;
  errorMessage: string | null;
};

/** Transition the import status and record an event row. */
async function transitionStatus(
  importId: string,
  tenantId: string,
  fromStatus: string | null,
  toStatus: string,
  actorUserId: string | null,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(statementImports)
    .set({ status: toStatus, lastUpdAt: now, lastUpdBy: actorUserId, ...extra })
    .where(eq(statementImports.id, importId));

  await db.insert(statementImportEvents).values({
    tenantId,
    statementImportId: importId,
    fromStatus,
    toStatus,
    actorUserId,
    createdBy: actorUserId,
    lastUpdAt: now,
    lastUpdBy: actorUserId,
  });
}

/**
 * Process an uploaded file: detect format, parse, insert rows, update status.
 * Returns the final status and row counts.
 */
export async function processImport(
  importId: string,
  fileBuffer: Buffer,
  tenantId: string,
  userId: string,
  tenantIndustry: string | null = null,
): Promise<ProcessResult> {
  await transitionStatus(importId, tenantId, "uploaded_pending", "parsing", null);

  const parser = detectFormat(fileBuffer);
  if (!parser) {
    await transitionStatus(importId, tenantId, "parsing", "parse_failed", null, {
      errorMessage: "unsupported_format",
      parsedAt: new Date().toISOString(),
    });
    return {
      status: "parse_failed",
      rowsTotal: 0,
      rowsError: 0,
      errorMessage: "unsupported_format",
    };
  }

  // Resolve <BANKID> routing code → canonical BANK_SLUG via BANK_ROUTING LOV.
  // Unrecognized routing codes land NULL; the user picks during review.
  const header = parser.extractHeader(fileBuffer);
  const bankRouting = await resolveBankSlug(header.bankRoutingCode);
  const resolvedBankSlug = bankRouting?.slug ?? null;
  const acquirer = parser.acquirer !== null ? await resolveAcquirer(parser.acquirer) : null;

  const now = new Date().toISOString();
  await db
    .update(statementImports)
    .set({
      sourceFormat: parser.format,
      sourceKind: parser.kind,
      acquirerId: acquirer?.id ?? null,
      merchantTaxId: header.merchantTaxId,
      bankSlug: resolvedBankSlug,
      accountRef: header.accountRef,
      periodStart: header.periodStart,
      periodEnd: header.periodEnd,
      lastUpdAt: now,
    })
    .where(eq(statementImports.id, importId));

  const { rowsTotal, rowsError, rowsDuplicate, acquirerRows } = await insertParsedRows({
    parser,
    fileBuffer,
    importId,
    tenantId,
    tenantIndustry,
    resolvedBankSlug,
  });

  const allFailed = rowsError === rowsTotal && rowsTotal > 0;
  const noRows = rowsTotal === 0;
  const finalStatus = allFailed || noRows ? "parse_failed" : "parsed";
  const errorMessage = noRows ? "no_transactions_found" : allFailed ? "all_rows_failed" : null;

  await transitionStatus(importId, tenantId, "parsing", finalStatus, null, {
    rowsTotal,
    rowsError,
    rowsDuplicate,
    errorMessage,
    parsedAt: new Date().toISOString(),
  });

  if (finalStatus === "parsed") {
    if (parser.kind === "bank") {
      // New bank rows may settle sales that were waiting for this statement
      // — re-run matching across all acquirers (idempotent).
      await runAcquirerMatching({ tenantId, userId });
    } else {
      await maybePromoteAcquirerSales({ acquirer, acquirerRows, tenantId, importId, userId });
    }
  }

  return { status: finalStatus, rowsTotal, rowsError, errorMessage };
}

// G-02 promotion: acquirer-report rows land in acquirer_sales immediately
// (no review step — D-G3), then the value-first matcher runs.
async function maybePromoteAcquirerSales(args: {
  acquirer: { id: string } | null;
  acquirerRows: AcquirerSaleInput[];
  tenantId: string;
  importId: string;
  userId: string;
}): Promise<void> {
  const { acquirer, acquirerRows, tenantId, importId, userId } = args;
  if (acquirer === null || acquirerRows.length === 0) return;
  await promoteAcquirerSales({
    tenantId,
    importId,
    acquirerId: acquirer.id,
    userId,
    rows: acquirerRows,
  });
  await runAcquirerMatching({ tenantId, userId, acquirerId: acquirer.id });
}

// The source's own per-transaction id is the dedup grain across imports —
// OFX FITID for bank rows, "cielo:<account>:<sale code>" for acquirer rows.
// Exports overlap by design (Cielo pushes "until today" windows) and files
// get renamed, so file-level hashes cannot catch the same row arriving twice.
async function loadExistingExternalIds(tenantId: string, sourceKind: string): Promise<Set<string>> {
  const rows = await db
    .select({ externalId: statementImportRows.externalId })
    .from(statementImportRows)
    .innerJoin(statementImports, eq(statementImports.id, statementImportRows.statementImportId))
    .where(
      and(
        eq(statementImportRows.tenantId, tenantId),
        eq(statementImports.sourceKind, sourceKind),
        ne(statementImports.status, "parse_failed"),
        isNotNull(statementImportRows.externalId),
      ),
    );
  return new Set(rows.map((r) => r.externalId).filter((id): id is string => id !== null));
}

// Insert one statement_import_rows row per parsed line; collect acquirer
// payloads for the G-02 promotion. Card rows skip the classifier chain —
// nothing consumes their FKs. Bank rows already present in another import
// (same external_id) are skipped and counted, never double-inserted.
async function insertParsedRows(args: {
  parser: NonNullable<ReturnType<typeof detectFormat>>;
  fileBuffer: Buffer;
  importId: string;
  tenantId: string;
  tenantIndustry: string | null;
  resolvedBankSlug: string | null;
}): Promise<{
  rowsTotal: number;
  rowsError: number;
  rowsDuplicate: number;
  acquirerRows: AcquirerSaleInput[];
}> {
  const { parser, fileBuffer, importId, tenantId, tenantIndustry, resolvedBankSlug } = args;
  let rowsTotal = 0;
  let rowsError = 0;
  let rowsDuplicate = 0;
  const acquirerRows: AcquirerSaleInput[] = [];
  const seenExternalIds = await loadExistingExternalIds(tenantId, parser.kind);

  for await (const row of parser.parse(fileBuffer)) {
    rowsTotal++;

    if (row.kind === "ok") {
      const externalId = row.normalized.externalId;
      if (externalId !== null && seenExternalIds.has(externalId)) {
        rowsDuplicate++;
        continue;
      }
      if (externalId !== null) seenExternalIds.add(externalId);
      const actualAmount = BigInt(row.normalized.actualAmount);
      if (row.normalized.acquirerSale !== undefined) {
        acquirerRows.push({
          saleDate: row.normalized.actualDate,
          ...row.normalized.acquirerSale,
        });
      }
      const autoFill =
        parser.kind === "card"
          ? EMPTY_AUTO_FILL
          : await autoFillClassifiers({
              candidate: row.normalized.description,
              actualAmount,
              rawPayload: row.raw,
              ctx: { tenantId, tenantIndustry, bankSlug: resolvedBankSlug },
            });

      await db.insert(statementImportRows).values({
        tenantId,
        statementImportId: importId,
        lineNumber: rowsTotal,
        status: "parsed_ok",
        rawPayload: row.raw,
        actualDate: row.normalized.actualDate,
        accrualDate: row.normalized.actualDate,
        actualAmount,
        description: row.normalized.description,
        reference: row.normalized.reference,
        subtypeId: autoFill.subtypeId,
        externalId: row.normalized.externalId,
        categoryId: autoFill.categoryId,
        creditorId: autoFill.creditorId,
        paymentMethodId: autoFill.paymentMethodId,
        matchConfidence: autoFill.matchConfidence,
        sourceStrategy: autoFill.sourceStrategy,
        matchProposalJson: autoFill.proposal,
      });
    } else {
      rowsError++;
      await db.insert(statementImportRows).values({
        tenantId,
        statementImportId: importId,
        lineNumber: rowsTotal,
        status: "parsed_error",
        rawPayload: row.raw,
        errorDetail: row.error,
      });
    }
  }

  return { rowsTotal, rowsError, rowsDuplicate, acquirerRows };
}

export { transitionStatus };

// Run the matcher chain across the four classifier targets per row, then
// disambiguate SUPPLIER vs CUSTOMER by sign of actual_amount. Returns the FK
// values to write on the row, the chain's confidence in the auto-fill, the
// strategy id of the winning auto-pick, and the full proposal blob (always
// stored — picker UI uses it at review time).
//
// The chain runs five targets in parallel (Promise.all under the hood). Even
// when sign rules out CUSTOMER (or SUPPLIER), we still run both — strategies
// stay target-agnostic, and the picker may want the cross-sign suggestions
// at review time anyway.
const TARGETS: ReadonlyArray<MatchTarget> = [
  { kind: "lov-system", type: "PAYMENT_METHOD" },
  { kind: "lov-tenant", type: "CATEGORY" },
  { kind: "tenant-value", tvKind: "SUPPLIER" },
  { kind: "tenant-value", tvKind: "CUSTOMER" },
  { kind: "lov-system", type: "TRANSACTION_SUBTYPE" },
];

type AutoFillResult = {
  categoryId: string | null;
  creditorId: string | null;
  paymentMethodId: string | null;
  subtypeId: string | null;
  matchConfidence: number | null;
  sourceStrategy: string | null;
  proposal: Record<string, MatchOutcome>;
};

const EMPTY_AUTO_FILL: AutoFillResult = {
  categoryId: null,
  creditorId: null,
  paymentMethodId: null,
  subtypeId: null,
  matchConfidence: null,
  sourceStrategy: null,
  proposal: {},
};

async function autoFillClassifiers(args: {
  candidate: string | null;
  actualAmount: bigint;
  rawPayload: Record<string, unknown> | null;
  ctx: { tenantId: string; tenantIndustry: string | null; bankSlug: string | null };
}): Promise<AutoFillResult> {
  const candidate = args.candidate ?? "";
  const proposal = await runChainForTargets(TARGETS, {
    candidate,
    row: {
      id: null,
      description: args.candidate,
      actualAmount: args.actualAmount,
      subtypeId: null,
      rawPayload: args.rawPayload,
    },
    ctx: {
      tenantId: args.ctx.tenantId,
      tenantIndustry: args.ctx.tenantIndustry,
      userId: null,
      bankSlug: args.ctx.bankSlug,
    },
  });

  const paymentOutcome = proposal["lov:PAYMENT_METHOD"];
  const categoryOutcome = proposal["lov:CATEGORY"];
  const subtypeOutcome = proposal["lov:TRANSACTION_SUBTYPE"];
  const creditorOutcome =
    args.actualAmount < 0n ? proposal["tv:SUPPLIER"] : proposal["tv:CUSTOMER"];

  const paymentMethodId = pickAutoTarget(paymentOutcome);
  const subtypeId = pickAutoTarget(subtypeOutcome);
  const creditorId = pickAutoTarget(creditorOutcome);
  // When the chain matches a creditor without a category, propagate the
  // creditor's default category (tenant_values.parent_lov → CATEGORY).
  // Mirrors the manual-pick fallback in ReviewableSection.setClassification.
  let categoryId = pickAutoTarget(categoryOutcome);
  if (categoryId === null && creditorId !== null) {
    categoryId = await resolveCreditorDefaultCategory(args.ctx.tenantId, creditorId);
  }

  const winners = [
    { outcome: paymentOutcome, id: paymentMethodId },
    { outcome: categoryOutcome, id: categoryId },
    { outcome: subtypeOutcome, id: subtypeId },
    { outcome: creditorOutcome, id: creditorId },
  ].filter(
    (w): w is { outcome: MatchOutcome & { status: "matched" }; id: string } =>
      w.id !== null && w.outcome?.status === "matched",
  );

  if (winners.length === 0) {
    return {
      categoryId: null,
      creditorId: null,
      paymentMethodId: null,
      subtypeId: null,
      matchConfidence: null,
      sourceStrategy: null,
      proposal,
    };
  }

  const top = winners.reduce((a, b) =>
    b.outcome.best.confidence > a.outcome.best.confidence ? b : a,
  );

  return {
    categoryId,
    creditorId,
    paymentMethodId,
    subtypeId,
    matchConfidence: Math.round(top.outcome.best.confidence * 100),
    sourceStrategy: top.outcome.best.strategyId,
    proposal,
  };
}

function pickAutoTarget(outcome: MatchOutcome | undefined): string | null {
  if (outcome?.status !== "matched") return null;
  return outcome.best.targetId;
}

/**
 * Look up the supplier/customer's default CATEGORY (tenant_values.parent_lov)
 * for the parse-time auto-fill fallback. Returns null when the creditor row
 * has no parent, the parent isn't an active CATEGORY, or the row is missing.
 */
async function resolveCreditorDefaultCategory(
  tenantId: string,
  creditorId: string,
): Promise<string | null> {
  const [row] = await db
    .select({
      categoryId: listOfValues.id,
      categoryType: listOfValues.type,
      categoryDeletedAt: listOfValues.deletedAt,
    })
    .from(tenantValues)
    .innerJoin(listOfValues, eq(listOfValues.id, tenantValues.parentLov))
    .where(
      and(
        eq(tenantValues.id, creditorId),
        eq(tenantValues.tenantId, tenantId),
        isNull(tenantValues.deletedAt),
        eq(listOfValues.type, "CATEGORY"),
        isNull(listOfValues.deletedAt),
      ),
    )
    .limit(1);
  return row?.categoryId ?? null;
}
