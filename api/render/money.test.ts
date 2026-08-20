// api/render/money.test.ts
//
// The claim: a number rendered in the report is byte-identical to the number
// on the invoice, and every derived total is a sum of integers a human can
// re-add by hand. Ported from what poc/render.ts asserted at runtime.

import { describe, it, expect } from "vitest";
import {
  formatCents,
  isParsableMoney,
  parseEuroToCents,
  sumCents,
  formatDate,
  monthLabel,
} from "./money";

describe("parseEuroToCents", () => {
  it("reads the invoices' typography and the contract's as the same amount", () => {
    expect(parseEuroToCents("1.234,56 €")).toBe(123456);
    expect(parseEuroToCents("1 234,56 euros")).toBe(123456);
    expect(parseEuroToCents("1 234,56 €")).toBe(123456);
  });

  it("round-trips verbatim — the whole point of integer cents", () => {
    for (const verbatim of ["4.590,60 €", "0,01 €", "12,00 €", "1.000.000,00 €"]) {
      expect(formatCents(parseEuroToCents(verbatim))).toBe(verbatim);
    }
  });

  it("throws rather than returning a silent zero", () => {
    expect(() => parseEuroToCents("abc")).toThrow();
    // No cents at all is not this locale's money, and guessing ",00" would be
    // this module inventing a figure.
    expect(() => parseEuroToCents("1234 €")).toThrow();
  });

  it("handles negatives", () => {
    expect(parseEuroToCents("-1.234,56 €")).toBe(-123456);
    expect(formatCents(-123456)).toBe("-1.234,56 €");
  });
});

describe("isParsableMoney", () => {
  it("answers instead of throwing, so 'this role has no totals' is ordinary", () => {
    expect(isParsableMoney("1,00 €")).toBe(true);
    expect(isParsableMoney("n/d")).toBe(false);
    expect(isParsableMoney(1234)).toBe(false);
    expect(isParsableMoney(null)).toBe(false);
  });
});

describe("sumCents", () => {
  it("is an integer sum — base + IVA reconciles to the cent", () => {
    const bases = [459060, 12000, 3300];
    const iva = [105584, 2760, 759];
    expect(sumCents(bases) + sumCents(iva)).toBe(sumCents(bases.map((b, i) => b + (iva[i] ?? 0))));
  });
});

describe("dates", () => {
  it("validates rather than reformats", () => {
    expect(formatDate("28/02/2025")).toBe("28/02/2025");
    expect(() => formatDate("2025-02-28")).toThrow();
  });

  it("names the month in pt-BR", () => {
    expect(monthLabel("28/02/2025")).toBe("fevereiro de 2025");
  });
});
