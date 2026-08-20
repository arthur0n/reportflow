// api/services/recurrence-generate.ts
//
// Cadence is fully delegated to the rrule library (RFC 5545 RRULE strings).
// The pattern's iCalendar string lives on the RECURRENCE_PATTERN LOV row's
// `description` column; the engine reads it once per generate, parses it,
// and asks rrule for the next N or all-within-horizon occurrences.
//
// We do NOT bake COUNT/UNTIL into the stored rrule — `repeat_count` and the
// 24-month horizon for `mode='always'` are orchestration concerns kept on
// transaction_recurrences so a single pattern row is reusable across many
// recurrences with different counts.

// Named import from "rrule" breaks under `tsx watch`'s Node ESM loader (the
// CJS build only exposes a `default` object, no static `RRule` named export —
// direct `tsx` execution papers over this via cjs-module-lexer, watch mode
// does not). Import the default and destructure to work under both.
import rrulePkg from "rrule";
const { RRule } = rrulePkg;

const ALWAYS_HORIZON_MONTHS = 24;
const MAX_OCCURRENCES = 1000;

/**
 * Compute the occurrence dates AFTER the start date, in chronological order.
 * The start date itself is the source transaction's accrual date and is NOT
 * included — siblings begin at the next rrule occurrence past start.
 *
 * Returns ISO YYYY-MM-DD strings.
 */
export function occurrenceDates(args: {
  start: string; // ISO YYYY-MM-DD (source's accrualDate)
  rrule: string; // pattern row's description (e.g. 'FREQ=MONTHLY;INTERVAL=1')
  mode: "finite" | "always";
  repeatCount?: number; // required when mode='finite'
}): string[] {
  const startUtc = parseIsoDate(args.start);
  const rule = RRule.fromString(
    `DTSTART:${formatRruleStamp(startUtc)}\n${normalizeRrule(args.rrule)}`,
  );

  if (args.mode === "finite") {
    const count = args.repeatCount ?? 0;
    if (count <= 0) return [];
    // .all() is unbounded for FREQ=… without COUNT/UNTIL — bound via predicate.
    // We need count + 1 occurrences (the start itself counts as #0) then drop it.
    const dates = rule.all((_, i) => i < Math.min(count + 1, MAX_OCCURRENCES + 1));
    return dropStart(dates, startUtc).slice(0, count);
  }

  const horizon = addMonthsUtc(startUtc, ALWAYS_HORIZON_MONTHS);
  const dates = rule.between(startUtc, horizon, true, (_, i) => i < MAX_OCCURRENCES + 1);
  return dropStart(dates, startUtc);
}

/**
 * rrule parses dates as UTC; we serialize back to plain YYYY-MM-DD that
 * Postgres `date` columns accept.
 */
function dropStart(dates: ReadonlyArray<Date>, start: Date): string[] {
  const startMs = start.getTime();
  const out: string[] = [];
  for (const d of dates) {
    if (d.getTime() === startMs) continue;
    out.push(formatIsoDate(d));
  }
  return out;
}

function parseIsoDate(iso: string): Date {
  const [yStr, mStr, dStr] = iso.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    throw new Error(`recurrence-generate: invalid ISO date "${iso}"`);
  }
  return new Date(Date.UTC(y, m - 1, d));
}

function formatIsoDate(dt: Date): string {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${String(y)}-${m}-${d}`;
}

function formatRruleStamp(dt: Date): string {
  // RRULE DTSTART format: 20260131T000000Z
  return `${formatIsoDate(dt).replace(/-/g, "")}T000000Z`;
}

function addMonthsUtc(dt: Date, months: number): Date {
  return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + months, dt.getUTCDate()));
}

/**
 * Strip an `RRULE:` prefix if a pattern was authored with one (the library
 * accepts both forms, but DTSTART + RRULE: + bare-rule mixes are easier to
 * reason about with a single canonical shape).
 */
function normalizeRrule(rrule: string): string {
  const trimmed = rrule.trim();
  return trimmed.startsWith("RRULE:") ? trimmed : `RRULE:${trimmed}`;
}
