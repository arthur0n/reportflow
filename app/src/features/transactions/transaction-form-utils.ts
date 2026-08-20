// Shared helpers for transaction-shaped forms (CreateTransactionDialog +
// CreateRecurrenceDialog). Keeps a single source of truth for sign convention,
// amount parsing, and picker-item shaping so the two forms can't diverge.

import type { PickerItem } from "@/components/inline-ref-picker";
import type { TransactionTypeCode } from "@shared/constants/transaction-types";

export type CreditorKind = "SUPPLIER" | "CUSTOMER";

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function creditorKindFor(code: TransactionTypeCode): CreditorKind {
  return code === "REVENUE" ? "CUSTOMER" : "SUPPLIER";
}

// EXPENSE / CASH_DRAWER_OUT → debit (negative); the rest → credit. Forms
// take a positive number from the user; the sign is applied at submit.
export function amountSign(code: TransactionTypeCode): 1 | -1 {
  if (code === "EXPENSE" || code === "CASH_DRAWER_OUT") return -1;
  return 1;
}

export function reaisToCents(value: string): number | null {
  const trimmed = value.trim().replace(",", ".");
  if (trimmed.length === 0) return null;
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100);
}

export function centsToReais(cents: bigint | number | null): string {
  if (cents === null) return "";
  const n = typeof cents === "bigint" ? Number(cents) : cents;
  return (Math.abs(n) / 100).toFixed(2).replace(".", ",");
}

export function pickerItemsFromLov(
  rows: ReadonlyArray<{ id: string; value: string; code: string }>,
): PickerItem[] {
  return rows.map((r) => ({ id: r.id, label: r.value, sublabel: r.code }));
}

export function pickerItemsFromTv(rows: ReadonlyArray<{ id: string; name: string }>): PickerItem[] {
  return rows.map((r) => ({ id: r.id, label: r.name }));
}
