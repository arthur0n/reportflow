// shared/validation/extraction-validation.ts
//
// §4.2's fork, in one function: "extract → Zod valid AND all required fields
// present? ✓ unattended / ✗ retry once → revisar".
//
// WHY IT LIVES IN shared/ AND IS CALLED FROM BOTH SIDES. There is exactly one
// definition of "this extraction is usable", and three consumers need it:
//
//   * the collector, deciding whether a paid hop lands in `done` or goes round
//     for its one retry (api/collector/collect.ts);
//   * `extractions.correct`, refusing to let a human leave `revisar` with a
//     payload that is still broken (api/services/extraction-service.ts);
//   * the revisar screen itself, which flags problems field by field WHILE the
//     human types (app/src/features/extraction/).
//
// A second implementation in the browser would be a second opinion about what
// `revisar` means, and the server's would win at save time — after the human
// had already been told it was fine. Everything here is pure Zod over the
// frozen field list, so it bundles into the browser unchanged.
//
// WHAT §12.12(a) ASKS FOR, AND WHAT IS HERE. §12.12(a) names three arithmetic
// validators — `sum(itens.total) == iliquido`, `iliquido + iva == documento`,
// `iva ≈ iliquido × pct`. Those are INVOICE facts, not facts about an
// arbitrary document type: nothing in a frozen field list says which field is
// a line-item total and which is a net subtotal, and inferring it from names
// would silently mis-fire on the first document type that spells them
// differently — the §3.3 failure mode ("a fully-populated, entirely plausible,
// completely wrong" answer) reappearing in the validator itself. They belong
// to a template-DECLARED validation list, which is a schema change and is
// deferred to #10/#12.
//
// What IS here is every deterministic check the frozen list alone can justify:
//
//   1. Zod, built at runtime from the frozen field list (§3.1) — types, the
//      money/date shapes, and `strictObject`'s refusal of invented fields.
//   2. Required-present: a required field that is absent or null fails (1)
//      already; this module is what turns that into a per-field verdict a
//      screen can render, rather than a flat list of Zod issues.
//   3. Numbers parseable per type: a `money` string that satisfies MONEY_RE
//      but does not resolve to a finite cent amount is refused here rather
//      than by whatever tries to add it up later. This is the deterministic
//      foothold the §12.12(a) arithmetic will stand on once the field list can
//      declare its own relationships.

import type { z } from "zod/v4";
import { buildZodSchema, MONEY_RE, type FieldSpec } from "./field-spec";

/** The three things that can be wrong with one value, and nothing more: the
 * badge vocabulary on the revisar screen is exactly this long. */
export type ProblemCode = "missing" | "invalid" | "unexpected";

/** pt-BR, because these are rendered verbatim as badges (§4.2's screen). */
export const PROBLEM_LABEL: Record<ProblemCode, string> = {
  missing: "obrigatório ausente",
  invalid: "formato inválido",
  unexpected: "campo inesperado",
};

export interface FieldProblem {
  /** Field path from the root: `["itens", 2, "total"]`. Array indices are
   * numbers so a sub-table row can find its own problems without parsing. */
  readonly path: readonly (string | number)[];
  readonly code: ProblemCode;
  /** Operator/user-facing detail. The BADGE comes from `PROBLEM_LABEL`; this
   * is the sentence next to it. */
  readonly message: string;
}

export interface ExtractionValidation {
  /** `true` is §4.2's unattended path. Nothing else is. */
  readonly ok: boolean;
  readonly problems: readonly FieldProblem[];
}

/** `["itens", 0, "total"]` → `"itens.0.total"`. The key a UI keeps problems
 * under; never parsed back, only compared. */
export function pathKey(path: readonly (string | number)[]): string {
  return path.map((p) => String(p)).join(".");
}

/** Every problem recorded exactly at `path` (not its children). */
export function problemsAt(
  problems: readonly FieldProblem[],
  path: readonly (string | number)[],
): FieldProblem[] {
  const key = pathKey(path);
  return problems.filter((p) => pathKey(p.path) === key);
}

/** The value a path points at, or `undefined` when the path does not resolve.
 * Deliberately tolerant: it is called with paths Zod produced against data
 * that failed to parse, so half of them lead nowhere. */
export function valueAtPath(data: unknown, path: readonly (string | number)[]): unknown {
  let cursor: unknown = data;
  for (const segment of path) {
    if (typeof cursor !== "object" || cursor === null) {
      return undefined;
    }
    cursor = (cursor as Record<string | number, unknown>)[segment];
  }
  return cursor;
}

/**
 * The `FieldSpec` a path names, or `null`.
 *
 * Numeric segments are array indices and are skipped — `itens[2].total` and
 * `itens[0].total` are the same FIELD, and the field list has one entry for
 * it. Used to decide whether an absent value is "obrigatório ausente" or
 * merely a malformed optional.
 */
export function findFieldSpec(
  fields: readonly FieldSpec[],
  path: readonly (string | number)[],
): FieldSpec | null {
  let level: readonly FieldSpec[] = fields;
  let found: FieldSpec | null = null;
  for (const segment of path) {
    if (typeof segment === "number") {
      continue;
    }
    const match = level.find((f) => f.name === segment);
    if (match === undefined) {
      return null;
    }
    found = match;
    level = match.fields ?? [];
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* Money — the one "is this number actually a number" check the frozen  */
/* list alone justifies (§12.12(a)'s deterministic foothold).           */
/* ------------------------------------------------------------------ */

/**
 * `"1.234,56 €"` → `123456` cents, or `null` when the string is not a money
 * value this system will ever be able to add up.
 *
 * MONEY_RE IS THE GATE, NOT A SECOND OPINION (codex review, 2026-08-20). The
 * first line of this function is the same predicate `buildZodSchema` applies
 * to a `money` field, so "the validator accepts it" and "the arithmetic can
 * read it" are the SAME statement by construction rather than by two
 * hand-written patterns that agree until someone edits one. They had already
 * diverged: the parser read the separator-free `1234,56` that MONEY_RE
 * refused, so a perfectly good amount went to `revisar` while the code that
 * would eventually add it up was happy.
 *
 * INTEGER CENTS, never a float: §3.1 keeps money VERBATIM precisely so that
 * nothing between the page and the arithmetic can lose a cent, and parsing to
 * a float here would give it back the chance.
 */
export function parseMoneyToCents(value: string): number | null {
  // `MONEY_RE` carries no `g` flag, so `.test` holds no lastIndex state and is
  // safe to call on every value.
  if (!MONEY_RE.test(value)) {
    return null;
  }
  const cleaned = value
    .replace(/€|euros?/giu, "")
    .replace(/[.\u00a0\u202f\u2009\s]/gu, "")
    .trim();
  const match = /^(-?)(\d+),(\d{2})$/u.exec(cleaned);
  if (match === null) {
    return null;
  }
  const [, sign = "", whole = "", cents = ""] = match;
  const magnitude = Number.parseInt(whole, 10) * 100 + Number.parseInt(cents, 10);
  if (!Number.isSafeInteger(magnitude)) {
    return null;
  }
  return sign === "-" ? -magnitude : magnitude;
}

/** Walks the frozen tree against the payload and reports any `money` value
 * that passed MONEY_RE but cannot be resolved to cents. Runs only after Zod
 * succeeded, so every value it sees is already the right TYPE. */
function moneyProblems(
  fields: readonly FieldSpec[],
  data: unknown,
  prefix: readonly (string | number)[],
): FieldProblem[] {
  const out: FieldProblem[] = [];
  for (const field of fields) {
    const path = [...prefix, field.name];
    const value = valueAtPath(data, [field.name]);
    if (value === null || value === undefined) {
      continue;
    }
    if (field.type === "money" && typeof value === "string" && parseMoneyToCents(value) === null) {
      out.push({
        path,
        code: "invalid",
        message: `${field.name}: valor monetário não interpretável (${value}).`,
      });
      continue;
    }
    if (field.type === "object") {
      out.push(...moneyProblems(field.fields ?? [], value, path));
      continue;
    }
    if (field.type === "object[]" && Array.isArray(value)) {
      value.forEach((row, index) => {
        out.push(...moneyProblems(field.fields ?? [], row, [...path, index]));
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The verdict                                                         */
/* ------------------------------------------------------------------ */

/** Zod paths are `PropertyKey[]`; a symbol cannot occur here (every key in a
 * runtime-built schema is a field NAME) but the type allows one, so it is
 * stringified rather than asserted away. */
function normalizePath(path: readonly PropertyKey[]): (string | number)[] {
  return path.map((segment) => (typeof segment === "symbol" ? String(segment) : segment));
}

function issueProblems(
  fields: readonly FieldSpec[],
  data: unknown,
  issue: z.core.$ZodIssue,
): FieldProblem[] {
  const path = normalizePath(issue.path);

  if (issue.code === "unrecognized_keys") {
    // `strictObject` (field-spec.ts): a model inventing a field is a SIGNAL,
    // not something to swallow. One problem per invented key, hung off the
    // key itself so the screen can show it in place.
    return issue.keys.map((key) => ({
      path: [...path, key],
      code: "unexpected" as const,
      message: `${key}: campo fora da lista congelada.`,
    }));
  }

  const value = valueAtPath(data, path);
  const spec = findFieldSpec(fields, path);
  const absent = value === undefined || value === null || value === "";
  const code: ProblemCode = absent && (spec === null || spec.required) ? "missing" : "invalid";
  return [{ path, code, message: issue.message }];
}

/**
 * The single verdict on an extraction payload against its frozen field list.
 *
 * `ok` is what §4.2 forks on, and it is deliberately all-or-nothing: a payload
 * with one bad field does not go to `analyse` with nineteen good ones — but it
 * is also not thrown away, which is the other half of the same decision. The
 * problems come back attached to paths so the repair screen can put each one
 * next to the value it is about.
 */
export function validateExtraction(
  fields: readonly FieldSpec[],
  data: unknown,
): ExtractionValidation {
  const parsed = buildZodSchema(fields).safeParse(data);
  if (!parsed.success) {
    const problems = parsed.error.issues.flatMap((issue) => issueProblems(fields, data, issue));
    return { ok: false, problems };
  }
  const money = moneyProblems(fields, data, []);
  return { ok: money.length === 0, problems: money };
}
