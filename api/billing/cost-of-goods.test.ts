// api/billing/cost-of-goods.test.ts
//
// PORTED from smartstocke/api/billing/cost-of-goods.test.ts. The cases are the
// sibling project's; the additions are the two things this port changed —
// §12.6's PROVIDER in the lookup, and the §10.5 fail-closed guard that the
// whole billing path turns on.

import { describe, expect, it } from "vitest";
import { COST_OF_GOODS, costFor, isPricedModel } from "./cost-of-goods";
import { PLATFORM_DEFAULTS } from "../services/credentials-service";

describe("costFor", () => {
  it("separa taxas de input e output", () => {
    expect(
      costFor("gemini", "gemini-2.5-flash", { input_tokens: 1_000_000, output_tokens: 0 }),
    ).toBe(30);
    expect(
      costFor("gemini", "gemini-2.5-flash", { input_tokens: 0, output_tokens: 1_000_000 }),
    ).toBe(250);
    expect(
      costFor("gemini", "gemini-2.5-flash", { input_tokens: 1_000_000, output_tokens: 1_000_000 }),
    ).toBe(280);
  });

  it("escala linearmente e mantém fração de centavo", () => {
    const cents = costFor("gemini", "gemini-2.5-flash", {
      input_tokens: 2_000,
      output_tokens: 1_000,
    });
    expect(cents).toBeCloseTo(0.06 + 0.25, 10);
  });

  it("modelo desconhecido custa 0 (fail-open deliberado NESTA função)", () => {
    expect(
      costFor("gemini", "modelo-inexistente", {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      }),
    ).toBe(0);
  });

  it("tokens inválidos (negativo, NaN, Infinity) contam como 0", () => {
    expect(
      costFor("openai", "gpt-4o-mini", { input_tokens: -100, output_tokens: Number.NaN }),
    ).toBe(0);
    expect(
      costFor("openai", "gpt-4o-mini", {
        input_tokens: Number.POSITIVE_INFINITY,
        output_tokens: 0,
      }),
    ).toBe(0);
  });

  it("toda linha da tabela tem taxas positivas e finitas", () => {
    for (const [model, rate] of Object.entries(COST_OF_GOODS)) {
      expect(rate.input_cents_per_1m, model).toBeGreaterThan(0);
      expect(rate.output_cents_per_1m, model).toBeGreaterThan(0);
      expect(Number.isFinite(rate.input_cents_per_1m), model).toBe(true);
      expect(Number.isFinite(rate.output_cents_per_1m), model).toBe(true);
    }
  });
});

// §7/§10.5 — "unpriced is not free". `costFor` fails OPEN so a missing rate row
// never breaks a hop that already ran; `isPricedModel` is the question the
// platform-key path asks FIRST, and it fails CLOSED.
describe("isPricedModel — the fail-closed guard", () => {
  it("accepts a model the table prices", () => {
    expect(isPricedModel("gemini", "gemini-3.5-flash")).toBe(true);
  });

  it("refuses a model nobody has priced, however plausible it looks", () => {
    expect(isPricedModel("gemini", "gemini-4-ultra")).toBe(false);
    expect(isPricedModel("anthropic", "claude-opus-5")).toBe(false);
  });

  // decisions §10.5: "COST_OF_GOODS needs Anthropic rows added … isPricedModel()
  // will refuse to bill until they exist, which is the intended fail-closed
  // behaviour." Pinned so adding a GUESSED row is a deliberate edit here.
  it("has no Anthropic rows, deliberately", () => {
    expect(Object.keys(COST_OF_GOODS).some((k) => k.includes("claude"))).toBe(false);
  });

  // The §12.13 verifier's platform default. poc/lib/ai.ts carries an ESTIMATE
  // for it and says so; an estimate is not a rate card, and this file is what
  // a customer is invoiced from. Until a real rate lands, a platform-key
  // verify hop is REFUSED before any money is spent
  // (api/services/credentials-service.ts). BYOK verifies today.
  it("does not yet price the verifier's platform default", () => {
    const verify = PLATFORM_DEFAULTS.verify;
    expect(isPricedModel(verify.provider, verify.model)).toBe(false);
  });

  it("prices every OTHER hop's platform default", () => {
    for (const hop of ["detect", "extract", "analyse", "calibrate"] as const) {
      const d = PLATFORM_DEFAULTS[hop];
      expect(isPricedModel(d.provider, d.model), hop).toBe(true);
    }
  });
});
