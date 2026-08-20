// api/render/report-context.ts
//
// THE DETERMINISTIC HALF (decisions §12.12b): extractions in, render context
// out. No model involved, no arithmetic that is not an integer sum of cents.
//
// Everything the client reads as a NUMBER is produced here. Everything they
// read as PROSE comes from `{{ai}}`. The line between the two is this file —
// which is the same line poc/lib/report-model.ts drew, generalised.
//
// GENERALISED, NOT COPIED, AND DELIBERATELY THIN. The POC's builder knew the
// House Living field list by name: it knew that `itens[].ref === "FHS"` meant
// the contractual honorarium, that the contract's periodicity drove a
// semiannual calendar, that IVA was 23%. None of that generalises — a second
// tenant's nota fiscal has none of those fields. What DOES generalise is the
// §3.2 role model and one convention that Calibrate already produces for every
// money-bearing document type: a `totais` object with `iliquido` / `iva` /
// `documento`. So this file exposes:
//
//   meta          — title, client, issue date, document count
//   <role_key>    — the extraction data, by ROLE, never by index (§3.2)
//   totais.<role> — the code-computed aggregate, ONLY for roles whose every
//                   bound extraction actually carries those three fields
//
// Anything richer belongs in the TEMPLATE, which is the thing that knows what
// its own documents mean. Inventing a per-tenant aggregate vocabulary here
// would put the report's semantics in code that no author can see.
//
// EVERY DECLARED ROLE IS A KEY, filled or not. Handlebars runs in strict mode,
// so `{{#if contrato}}` on an absent key THROWS rather than rendering the
// empty branch. An unfilled `one` role is therefore `null` and an unfilled
// `many` role is `[]` — present, falsy, and branchable.

import { isParsableMoney, parseEuroToCents, sumCents } from "./money";
import type { RoleDeclarationT } from "../../shared/validation/outbound-schemas";

export interface BoundExtraction {
  readonly id: string;
  readonly data: unknown;
}

export interface RoleBinding {
  readonly roleKey: string;
  readonly extractions: readonly BoundExtraction[];
}

export interface ReportMeta {
  readonly titulo: string;
  /** The end-customer the report is ABOUT (§2's vocabulary), or null. */
  readonly cliente: string | null;
  /** dd/mm/aaaa — the `date` helper's only accepted shape. */
  readonly emissao: string;
  readonly n_documentos: number;
}

/** The code-computed money block. Cents, integers, no floats anywhere. */
export interface RoleTotals {
  readonly n: number;
  readonly base_cents: number;
  readonly iva_cents: number;
  readonly documento_cents: number;
  /** base + IVA == documento, to the cent. Shown to the reader rather than
   * asserted behind their back — a divergence is a fact about the documents,
   * not a crash. */
  readonly confere: boolean;
}

export interface BuiltContext {
  readonly context: Record<string, unknown>;
  /** Required roles with no document bound. §3.2's "aguardando: contrato". */
  readonly missingRequiredRoles: readonly string[];
  /** Roles that got a `totais.<role>` block. Useful to the authoring screen,
   * which otherwise cannot tell why `{{money totais.x.base_cents}}` threw. */
  readonly aggregatedRoles: readonly string[];
}

/** dd/mm/aaaa in America/Sao_Paulo (conventions §1). Not `toISOString`: that
 * is UTC, and between 21:00 and 24:00 local it names tomorrow. */
export function todayInSaoPaulo(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(now);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The one convention this file relies on: `data.totais.{iliquido,iva,documento}`
 * as parsable money. Returns null — not a throw — when a document does not
 * carry it, because "this role has no aggregate" is an ordinary answer for a
 * contract or a letter.
 */
function conventionalTotals(
  data: unknown,
): { base: number; iva: number; documento: number } | null {
  const record = asRecord(data);
  const totais = record === null ? null : asRecord(record["totais"]);
  if (totais === null) {
    return null;
  }
  const { iliquido, iva, documento } = totais;
  if (!isParsableMoney(iliquido) || !isParsableMoney(iva) || !isParsableMoney(documento)) {
    return null;
  }
  return {
    base: parseEuroToCents(iliquido),
    iva: parseEuroToCents(iva),
    documento: parseEuroToCents(documento),
  };
}

/** ALL-OR-NOTHING per role. A partial sum over the subset of documents that
 * happened to carry totals is a number that looks like the period's total and
 * is not one — the worst kind of wrong figure, because nothing surfaces it. */
function aggregateRole(extractions: readonly BoundExtraction[]): RoleTotals | null {
  if (extractions.length === 0) {
    return null;
  }
  const parsed: { base: number; iva: number; documento: number }[] = [];
  for (const item of extractions) {
    const totals = conventionalTotals(item.data);
    if (totals === null) {
      return null;
    }
    parsed.push(totals);
  }
  const base_cents = sumCents(parsed.map((p) => p.base));
  const iva_cents = sumCents(parsed.map((p) => p.iva));
  const documento_cents = sumCents(parsed.map((p) => p.documento));
  return {
    n: parsed.length,
    base_cents,
    iva_cents,
    documento_cents,
    confere: base_cents + iva_cents === documento_cents,
  };
}

export interface BuildContextArgs {
  readonly roles: readonly RoleDeclarationT[];
  readonly bindings: readonly RoleBinding[];
  readonly meta: ReportMeta;
}

export function buildReportContext(args: BuildContextArgs): BuiltContext {
  const byRole = new Map<string, readonly BoundExtraction[]>();
  for (const binding of args.bindings) {
    byRole.set(binding.roleKey, binding.extractions);
  }

  const context: Record<string, unknown> = { meta: args.meta };
  const totais: Record<string, RoleTotals> = {};
  const missingRequiredRoles: string[] = [];
  const aggregatedRoles: string[] = [];

  for (const role of args.roles) {
    const bound = byRole.get(role.key) ?? [];
    if (role.required && bound.length === 0) {
      missingRequiredRoles.push(role.key);
    }
    context[role.key] =
      role.cardinality === "one" ? (bound[0]?.data ?? null) : bound.map((b) => b.data);

    const aggregate = aggregateRole(bound);
    if (aggregate !== null) {
      totais[role.key] = aggregate;
      aggregatedRoles.push(role.key);
    }
  }

  context["totais"] = totais;
  return { context, missingRequiredRoles, aggregatedRoles };
}
