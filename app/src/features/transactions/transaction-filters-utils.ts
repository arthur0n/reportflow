import type { TrpcOutput } from "@/shared/lib/trpc";

type TxRow = TrpcOutput["transactions"]["list"][number];

export type Filters = {
  periodFrom: string;
  periodTo: string;
  transactionType: string;
  status: string;
  category: string;
  paymentMethod: string;
  creditor: string;
  cashBox: string;
  businessUnit: string;
  subtype: string;
  descriptionContains: string;
  referenceContains: string;
};

export type SavedFilter = {
  id: string;
  name: string;
  filters: Filters;
};

export const DEFAULT_FILTERS: Filters = {
  periodFrom: "",
  periodTo: "",
  transactionType: "",
  status: "",
  category: "",
  paymentMethod: "",
  creditor: "",
  cashBox: "",
  businessUnit: "",
  subtype: "",
  descriptionContains: "",
  referenceContains: "",
};

export function deriveSelectOptions(
  rows: TxRow[],
  accessor: (row: TxRow) => string | null,
): string[] {
  const seen = new Set<string>();
  rows.forEach((row) => {
    const val = accessor(row);
    if (val !== null && val.trim() !== "") seen.add(val);
  });
  return Array.from(seen).sort();
}

function matchDateRange(date: string, periodFrom: string, periodTo: string): boolean {
  if (periodFrom !== "" && date < periodFrom) return false;
  if (periodTo !== "" && date > periodTo) return false;
  return true;
}

function matchSelectField(rowValue: string | null, filterValue: string): boolean {
  return filterValue === "" || rowValue === filterValue;
}

function matchTextContains(rowText: string | null, filterText: string): boolean {
  if (filterText === "") return true;
  return (rowText?.toLowerCase() ?? "").includes(filterText.toLowerCase());
}

function matchesFilter(row: TxRow, filters: Filters): boolean {
  if (!matchDateRange(row.accrualDate, filters.periodFrom, filters.periodTo)) return false;
  if (!matchSelectField(row.transactionTypeCode, filters.transactionType)) return false;
  if (!matchSelectField(row.statusCode, filters.status)) return false;
  if (!matchSelectField(row.categoryLabel, filters.category)) return false;
  if (!matchSelectField(row.paymentMethodLabel, filters.paymentMethod)) return false;
  if (!matchSelectField(row.creditorLabel, filters.creditor)) return false;
  if (!matchSelectField(row.cashBoxLabel, filters.cashBox)) return false;
  if (!matchSelectField(row.businessUnitLabel, filters.businessUnit)) return false;
  if (!matchSelectField(row.subtypeLabel, filters.subtype)) return false;
  if (!matchTextContains(row.description, filters.descriptionContains)) return false;
  if (!matchTextContains(row.reference, filters.referenceContains)) return false;
  return true;
}

export function applyFilters(rows: TxRow[], filters: Filters): TxRow[] {
  return rows.filter((row) => matchesFilter(row, filters));
}
