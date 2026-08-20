// api/render/numeral-guard.test.ts
//
// §12.12c's tripwire. The property that matters is NOT "does it find numbers"
// — it is that FORMATTING never causes a false alarm while an INVENTED figure
// always causes a real one. A guard that cries wolf gets switched off.

import { describe, it, expect } from "vitest";
import { auditSlots, harvestNumerals } from "./numeral-guard";

const UNIVERSE = harvestNumerals({
  faturas: [{ numero: "FT C2025/141", data: "28/02/2025", totais: { documento: "4.590,60 €" } }],
  totais: { documento_cents: 459060, n: 1 },
});

describe("harvestNumerals", () => {
  it("normalizes separators away, so one number has one identity", () => {
    const set = harvestNumerals({ a: "4.590,60 €", b: 459060 });
    expect(set.has("459060")).toBe(true);
    expect(set.size).toBe(1);
  });

  it("splits a date on its slashes — each part is its own token", () => {
    const set = harvestNumerals({ d: "28/02/2025" });
    expect([...set].sort()).toEqual(["02", "2025", "28"]);
  });
});

describe("auditSlots", () => {
  it("passes prose that reproduces a figure in a different typography", () => {
    // "4590,60" and "4.590,60 €" are the same number written two ways. This is
    // the case that would make the guard useless if it failed.
    expect(auditSlots({ notas: "O total foi de 4590,60 no período." }, UNIVERSE)).toEqual([]);
  });

  it("passes a code-computed figure the model was handed", () => {
    expect(auditSlots({ notas: "Foram 1 documentos." }, UNIVERSE)).toEqual([]);
  });

  it("blocks an invented figure, naming the slot and the token", () => {
    const violations = auditSlots({ notas: "O total foi de 4.590,70 €." }, UNIVERSE);
    expect(violations).toEqual([{ slot: "notas", token: "4.590,70" }]);
  });

  it("catches a transposition — the failure mode that is undetectable by eye", () => {
    // 4.590,60 -> 4.905,60. Plausible, wrong, and unrecoverable once sent.
    expect(auditSlots({ notas: "4.905,60" }, UNIVERSE)).toHaveLength(1);
  });

  it("reports every offending token, not just the first", () => {
    expect(auditSlots({ a: "99", b: "88 e 77" }, UNIVERSE)).toHaveLength(3);
  });

  it("is silent on prose with no numerals at all", () => {
    expect(auditSlots({ notas: "Nada a assinalar no período." }, UNIVERSE)).toEqual([]);
  });
});
