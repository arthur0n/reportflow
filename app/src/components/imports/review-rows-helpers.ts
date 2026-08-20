// Pure helpers shared by ReviewRows.tsx and ReviewableRow.tsx. Kept in a
// separate file so the React-only modules can comply with the
// react-refresh/only-export-components lint rule.

import { formatCurrency } from "@/shared/lib/format";
import type { ImportRowData, ReviewAction } from "./ReviewableRow";

export function centsToReais(cents: bigint | number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  return formatCurrency(Number(cents) / 100);
}

export function signedAmountClass(cents: bigint | number | null | undefined): string {
  if (cents === null || cents === undefined) return "text-[color:var(--ink-mute)]";
  const n = Number(cents);
  if (n > 0) return "text-[color:var(--positive)]";
  if (n < 0) return "text-[color:var(--negative)]";
  return "text-[color:var(--ink)]";
}

/** Map current row.status → the action verb the review mutation expects, so
 *  setting a classification preserves the existing decision (defaulting to
 *  "new" for not-yet-reviewed rows). */
export function actionForRow(row: ImportRowData): ReviewAction {
  if (row.status === "reviewed_matched") return "match";
  if (row.status === "reviewed_skip") return "skip";
  return "new";
}
