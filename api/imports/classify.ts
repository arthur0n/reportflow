// api/imports/classify.ts
//
// Map a parsed import row to a coarse TRANSACTION_TYPE code (EXPENSE /
// REVENUE / TRANSFER_INTERNAL). The labels for these codes live in
// list_of_values (type='TRANSACTION_TYPE'); the behavioral flags
// (affects_dre, requires_*) live in shared/constants/transaction-types.ts.
//
// Scope: bank-statement imports. Cash-drawer (CASH_DRAWER_*) and ADJUSTMENT
// types come from manual transaction entry — banks don't emit those events.
//
// Transfer detection keys on PAYMENT_METHOD: PIX / TED / DOC / TRANSFERENCIA.
// (Pre-PR: keyed on subtype_br when subtype was a bank-rail tag; subtype was
// repurposed as a fiscal hint and no longer carries rail names.)

const TRANSFER_PAYMENT_METHOD_CODES = new Set(["PIX", "TED", "DOC", "TRANSFERENCIA"]);

export type CoarseTransactionType = "EXPENSE" | "REVENUE" | "TRANSFER_INTERNAL";

export function classifyTransactionType(args: {
  actualAmount: bigint;
  paymentMethodCode: string | null;
}): CoarseTransactionType {
  if (
    args.paymentMethodCode !== null &&
    TRANSFER_PAYMENT_METHOD_CODES.has(args.paymentMethodCode)
  ) {
    return "TRANSFER_INTERNAL";
  }
  return args.actualAmount < 0n ? "EXPENSE" : "REVENUE";
}
