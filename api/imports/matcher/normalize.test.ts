// api/imports/matcher/normalize.test.ts
//
// Pure unit coverage for normalizeForMatch. Verifies the BR-noise stripping,
// NFKD diacritic removal, whitespace collapse, and determinism.

import { describe, it, expect } from "vitest";
import { normalizeForMatch } from "./normalize";

describe("normalizeForMatch", () => {
  it("returns empty string for null", () => {
    expect(normalizeForMatch(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(normalizeForMatch(undefined)).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeForMatch("")).toBe("");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(normalizeForMatch("   \t \n  ")).toBe("");
  });

  it("strips diacritics and lowercases", () => {
    const out = normalizeForMatch("Açaí");
    expect(out).toContain("acai");
    expect(out).not.toMatch(/[ÁÉÍÓÚáéíóúÇç]/);
  });

  it("collapses repeated whitespace and trims", () => {
    const out = normalizeForMatch("  hello   world  ");
    expect(out).toBe("hello world");
  });

  it("strips BR transaction prefixes (PIX RECEBIDO)", () => {
    const out = normalizeForMatch("PIX RECEBIDO IFOOD");
    expect(out).not.toMatch(/pix/);
    expect(out).not.toMatch(/recebido/);
    expect(out).toContain("ifood");
  });

  it("strips BR transaction prefixes (PIX OUT)", () => {
    const out = normalizeForMatch("PIX OUT IFOOD");
    expect(out).not.toMatch(/pix/);
    expect(out).toContain("ifood");
  });

  it("strips TED with agency/account markers", () => {
    const out = normalizeForMatch("TED AG 0001 CC 12345-6 IFOOD");
    expect(out).toContain("ifood");
    expect(out).not.toMatch(/ted/);
    expect(out).not.toMatch(/\bag\b/);
    expect(out).not.toMatch(/\bcc\b/);
  });

  it("strips long digit runs (>= 6 digits)", () => {
    const out = normalizeForMatch("IFOOD 12345678 BRL");
    expect(out).toContain("ifood");
    expect(out).not.toMatch(/\d/);
  });

  it("preserves short digit runs (< 6 digits)", () => {
    const out = normalizeForMatch("STORE 123");
    expect(out).toMatch(/123/);
  });

  it("strips BR-format dates (DD/MM/YYYY)", () => {
    const out = normalizeForMatch("PAGAMENTO 12/03/2026 IFOOD");
    expect(out).not.toMatch(/12\/03\/2026/);
    expect(out).toContain("pagamento");
    expect(out).toContain("ifood");
  });

  it("strips BR-format dates with dashes (DD-MM-YYYY)", () => {
    const out = normalizeForMatch("PAGAMENTO 12-03-2026 IFOOD");
    expect(out).not.toMatch(/12-03-2026/);
  });

  it("strips ISO dates (YYYY-MM-DD)", () => {
    const out = normalizeForMatch("PAGAMENTO 2026-03-12 IFOOD");
    expect(out).not.toMatch(/2026-03-12/);
  });

  it("is deterministic — same input always produces same output", () => {
    const inputs = [
      "PIX RECEBIDO IFOOD",
      "Açaí da Esquina LTDA",
      "TED AG 0001 CC 12345-6 IFOOD",
      "  multiple   spaces   ",
    ];
    for (const input of inputs) {
      expect(normalizeForMatch(input)).toBe(normalizeForMatch(input));
    }
  });
});
