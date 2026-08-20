// shared/constants/transaction-types.ts
//
// TRANSACTION_TYPE catalog flags. Product-fixed invariants — never per-tenant,
// never mutable at runtime. The seven LOV rows (labels + sort_order) live in
// list_of_values (tenant_id IS NULL, type='TRANSACTION_TYPE') and are seeded
// by scripts/seed.ts; the flags below are the source of truth for behavior
// (DRE inclusion, creditor / category requirement) and feed:
//   - M-01 transactions create/update validation (RN-3, RN-7)
//   - M-07 DRE / cash-flow exclusion (RN-2, RN-5)
//
// Flags from BA M-06 RN-1 / RN-3 / RN-7.

export const TRANSACTION_TYPE_ATTRS = {
  EXPENSE: { affectsDre: true, requiresCreditor: true, requiresCategory: true },
  REVENUE: { affectsDre: true, requiresCreditor: true, requiresCategory: true },
  TRANSFER_INTERNAL: { affectsDre: false, requiresCreditor: false, requiresCategory: false },
  CASH_DRAWER_IN: { affectsDre: false, requiresCreditor: false, requiresCategory: false },
  CASH_DRAWER_OUT: { affectsDre: false, requiresCreditor: false, requiresCategory: false },
  CASH_DRAWER_SHORT: { affectsDre: true, requiresCreditor: false, requiresCategory: true },
  ADJUSTMENT: { affectsDre: true, requiresCreditor: false, requiresCategory: true },
} as const satisfies Record<
  string,
  { affectsDre: boolean; requiresCreditor: boolean; requiresCategory: boolean }
>;

export type TransactionTypeCode = keyof typeof TRANSACTION_TYPE_ATTRS;

export const TRANSACTION_TYPE_CODES = Object.keys(
  TRANSACTION_TYPE_ATTRS,
) as readonly TransactionTypeCode[];

export function isTransactionTypeCode(code: string): code is TransactionTypeCode {
  return code in TRANSACTION_TYPE_ATTRS;
}
