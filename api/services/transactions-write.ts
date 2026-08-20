// api/services/transactions-write.ts
//
// Pure write-boundary checks for transactions inserts. Shared by the imports
// recorder (commitApprovedRows) and the transactions CRUD router (manual entry)
// so both apply the same classifier-completeness and status-defaulting rules.

import {
  TRANSACTION_TYPE_ATTRS,
  type TransactionTypeCode,
} from "../../shared/constants/transaction-types";

export type ClassifiersInput = {
  transactionType: TransactionTypeCode;
  creditorId: string | null;
  categoryId: string | null;
  paymentMethodId: string | null;
};

export type MissingClassifier = "creditor" | "category" | "paymentMethod";

export function assertClassifiersComplete(input: ClassifiersInput): MissingClassifier[] {
  const attrs = TRANSACTION_TYPE_ATTRS[input.transactionType];
  const missing: MissingClassifier[] = [];
  if (attrs.requiresCreditor && input.creditorId === null) missing.push("creditor");
  if (attrs.requiresCategory && input.categoryId === null) missing.push("category");
  // No TRANSACTION_TYPE_ATTRS entry currently carries `requiresPaymentMethod`;
  // when one does, mirror the pattern above.
  return missing;
}

export type DefaultStatusCode = "CERTO" | "REVISAR" | "ESTIMADO";

/**
 * Decide the TRANSACTION_STATUS code for a row that doesn't ship its own.
 * - Required classifiers missing → REVISAR (must be reconciled by a human).
 * - Realized leg present (actualDate + actualAmount) → CERTO.
 * - Otherwise → ESTIMADO (forecast-only).
 *
 * Same rule fires for import-record commits and manual entry — keep both
 * callers on this helper so a tweak lands in one place.
 */
export function defaultTransactionStatus(args: {
  actualDate: string | null;
  actualAmount: bigint | number | null;
  missingClassifiers: ReadonlyArray<MissingClassifier>;
}): DefaultStatusCode {
  if (args.missingClassifiers.length > 0) return "REVISAR";
  if (args.actualDate !== null && args.actualAmount !== null) return "CERTO";
  return "ESTIMADO";
}
