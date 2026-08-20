// app/src/shared/lib/format.ts
//
// Locale-specific formatting helpers. reportflow is pt-BR / BRL by default.
// Keep formatting logic in one place so screens never reach for raw Intl.

const BRL = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const DATE = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

/** Format a number as BRL currency (e.g. 1234.5 → "R$ 1.234,50"). */
export function formatCurrency(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "";
  return BRL.format(n);
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Format a date/ISO string as dd/MM/yyyy in pt-BR. Date-only strings
 * ("2026-08-03") are calendar facts, not moments — they are reformatted as
 * text and NEVER pass through Date, or the day would shift with the
 * viewer's timezone. Timestamps still render in the viewer's local time.
 */
export function formatDate(value: Date | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "string") {
    const m = DATE_ONLY.exec(value);
    if (m !== null) return `${m[3] ?? ""}/${m[2] ?? ""}/${m[1] ?? ""}`;
  }
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return DATE.format(d);
}
