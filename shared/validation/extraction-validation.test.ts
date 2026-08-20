// shared/validation/extraction-validation.test.ts
//
// The §4.2 fork's own suite. What is under test is the VERDICT and WHERE it
// points — the collector forks on `ok`, the repair screen renders `problems`
// by path, and a problem attached to the wrong path is a badge next to the
// wrong field, which is worse than no badge at all.

import { describe, it, expect } from "vitest";
import { MONEY_RE, type FieldSpec } from "./field-spec";
import {
  parseMoneyToCents,
  pathKey,
  problemsAt,
  validateExtraction,
} from "./extraction-validation";

const FIELDS: readonly FieldSpec[] = [
  { name: "numero", type: "string", required: true, description: "nº do documento" },
  { name: "emissao", type: "date", required: true, description: "data de emissão" },
  { name: "iliquido", type: "money", required: true, description: "total ilíquido" },
  { name: "observacao", type: "string", required: false, description: "observações" },
  {
    name: "itens",
    type: "object[]",
    required: true,
    description: "linhas",
    fields: [
      { name: "descricao", type: "string", required: true, description: "descrição" },
      { name: "quantidade", type: "integer", required: true, description: "qtd" },
      { name: "total", type: "money", required: true, description: "total da linha" },
    ],
  },
];

const VALID = {
  numero: "FT C2025/141",
  emissao: "31/07/2025",
  iliquido: "1.234,56 €",
  observacao: null,
  itens: [{ descricao: "Serviço", quantidade: 2, total: "617,28 €" }],
};

describe("validateExtraction — the unattended path", () => {
  it("accepts a payload that satisfies the frozen list", () => {
    expect(validateExtraction(FIELDS, VALID)).toEqual({ ok: true, problems: [] });
  });

  // §4.2's condition is "Zod valid AND all required fields present" — the
  // second half is what this names, with the badge the screen renders.
  it("flags a missing required field as `missing`, at its own path", () => {
    const { ok, problems } = validateExtraction(FIELDS, { ...VALID, numero: null });
    expect(ok).toBe(false);
    expect(problemsAt(problems, ["numero"])[0]?.code).toBe("missing");
  });

  it("flags a badly formatted money value as `invalid`", () => {
    const { ok, problems } = validateExtraction(FIELDS, { ...VALID, iliquido: "1234.56" });
    expect(ok).toBe(false);
    expect(problemsAt(problems, ["iliquido"])[0]?.code).toBe("invalid");
  });

  it("flags a badly formatted date", () => {
    const { problems } = validateExtraction(FIELDS, { ...VALID, emissao: "2025-07-31" });
    expect(problemsAt(problems, ["emissao"])[0]?.code).toBe("invalid");
  });

  // An optional field is nullable, not absent-able: `fieldsToJsonSchema` marks
  // every field required and expresses optionality as a null union, and
  // `strictObject` treats a missing key as a violation.
  it("accepts null for an optional field and refuses an omitted one", () => {
    expect(validateExtraction(FIELDS, { ...VALID, observacao: null }).ok).toBe(true);
    const omitted: Record<string, unknown> = { ...VALID };
    delete omitted["observacao"];
    expect(validateExtraction(FIELDS, omitted).ok).toBe(false);
  });

  // strictObject: a model inventing a field is a SIGNAL, not something to
  // swallow (§4.2 parks it rather than dropping the surprise).
  it("reports an invented field as `unexpected`, keyed on the invented name", () => {
    const { ok, problems } = validateExtraction(FIELDS, { ...VALID, desconto: "10,00 €" });
    expect(ok).toBe(false);
    expect(problemsAt(problems, ["desconto"])[0]?.code).toBe("unexpected");
  });

  // The path carries the ROW INDEX, which is the whole reason a sub-table can
  // put a badge in the right cell.
  it("points a line-item problem at its own row and column", () => {
    const { problems } = validateExtraction(FIELDS, {
      ...VALID,
      itens: [
        { descricao: "Serviço", quantidade: 2, total: "617,28 €" },
        { descricao: "Outro", quantidade: "dois", total: "617,28 €" },
      ],
    });
    expect(problems.map((p) => pathKey(p.path))).toContain("itens.1.quantidade");
  });

  it("refuses a whole payload that is not an object", () => {
    expect(validateExtraction(FIELDS, "não é um objeto").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The money language, stated ONCE and asserted from both ends (codex review,
// 2026-08-20).
//
// The defect this table exists to prevent: MONEY_RE refused the
// separator-free `1234,56` while `parseMoneyToCents` read it as 123456 cents.
// A value the validator sends to `revisar` and the arithmetic silently
// accepts is a bug in whichever of the two you happen to be reading. So there
// is ONE case table, and BOTH must agree on every row of it — a new
// typography is added here once and the two follow, rather than being taught
// to each of them separately.
// ---------------------------------------------------------------------------

/** Accepted, with the integer cents each renders to. */
const MONEY_ACCEPTS: readonly (readonly [string, number])[] = [
  // The invoice typography (dot-grouped).
  ["1.234,56 \u20ac", 123456],
  ["1.234,56", 123456],
  ["1.234.567,89 \u20ac", 123456789],
  ["-1.234,56 \u20ac", -123456],
  // Separator-free — as common on a real document as the grouped form, and
  // the case the two implementations used to disagree about.
  ["1234,56", 123456],
  ["0,00", 0],
  ["12,05", 1205],
  ["-12,05", -1205],
  // The contract typography: spaced grouping, currency spelled out. Widening
  // MONEY_RE to admit this was a REAL calibration fix (field-spec.ts).
  ["1 234,56 euros", 123456],
  ["1\u00a0234,56 \u20ac", 123456],
  ["1\u202f234,56", 123456],
  ["1\u2009234,56 euro", 123456],
];

/** Refused — and refused by BOTH, which is the actual assertion. */
const MONEY_REJECTS: readonly string[] = [
  "", // nothing
  "1234.56", // en-US decimals: the dot is a THOUSANDS separator in this vocabulary
  "1234", // no cents at all
  "1234,5", // one decimal digit
  "1234,567", // three
  "mil euros", // prose
  "R$ 1.234,56", // a currency this vocabulary does not print
  "12.3456,78", // half-grouped — the shape a mis-read produces
  "1.234,56 d\u00f3lares", // wrong currency word
  "--12,05", // two signs
  "12,05-", // trailing sign
];

describe("the money language — MONEY_RE and parseMoneyToCents agree", () => {
  it.each(MONEY_ACCEPTS)("accepts %j as %i cents, in both", (value, cents) => {
    expect(MONEY_RE.test(value)).toBe(true);
    expect(parseMoneyToCents(value)).toBe(cents);
  });

  it.each(MONEY_REJECTS)("refuses %j in both", (value) => {
    expect(MONEY_RE.test(value)).toBe(false);
    expect(parseMoneyToCents(value)).toBeNull();
  });

  // The agreement is STRUCTURAL, not coincidental: the parser gates on the
  // regex before it reads a digit. Stated as its own case so that a refactor
  // replacing the gate with a second pattern fails HERE, with the reason,
  // rather than in whichever row of the tables above happens to catch it.
  it("parses a value if and only if the frozen `money` schema accepts it", () => {
    for (const value of [...MONEY_ACCEPTS.map(([v]) => v), ...MONEY_REJECTS]) {
      expect(parseMoneyToCents(value) !== null).toBe(MONEY_RE.test(value));
    }
  });

  // The same language, reached through the runtime-built schema rather than
  // through the constant — which is how an extraction actually meets it.
  it("is the language a frozen `money` field validates against", () => {
    const fields: readonly FieldSpec[] = [
      { name: "total", type: "money", required: true, description: "total" },
    ];
    expect(validateExtraction(fields, { total: "1234,56" }).ok).toBe(true);
    expect(validateExtraction(fields, { total: "1234.56" }).ok).toBe(false);
  });
});

// §12.12(a)'s deterministic foothold: the SHAPE passing is not the same fact
// as the number being addable — which is why the extraction validator runs the
// parser over every `money` value Zod has already accepted.
describe("parseMoneyToCents — integer cents, never a float", () => {
  it("returns an integer for a value a float would round", () => {
    const cents = parseMoneyToCents("1.234,57 \u20ac");
    expect(cents).toBe(123457);
    expect(Number.isInteger(cents)).toBe(true);
  });

  it("refuses an amount too large to hold exactly", () => {
    expect(parseMoneyToCents(`${String(Number.MAX_SAFE_INTEGER)}0,00`)).toBeNull();
  });
});
