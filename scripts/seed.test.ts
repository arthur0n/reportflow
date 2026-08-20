import { describe, it, expect } from "vitest";
import { DRE_GROUPS_SEED, PAYMENT_METHOD_SEED, TRANSACTION_TYPES_SEED } from "./seed";
import {
  TRANSACTION_TYPE_ATTRS,
  TRANSACTION_TYPE_CODES,
} from "../shared/constants/transaction-types";

const EXPECTED_DRE_GROUP_CODES = ["F", "RV", "CMV", "CVI", "CF", "INV", "RO", "SI", "TC"] as const;

describe("DRE_GROUPS_SEED (M-12 catalog)", () => {
  it("ships exactly 9 codes in M-12 D2 order", () => {
    expect(DRE_GROUPS_SEED.map((g) => g.code)).toEqual(EXPECTED_DRE_GROUP_CODES);
  });

  it("uses strictly increasing sortOrder", () => {
    let prev = -Infinity;
    for (const g of DRE_GROUPS_SEED) {
      expect(g.sortOrder).toBeGreaterThan(prev);
      prev = g.sortOrder;
    }
  });

  it("has a non-empty pt-BR label per row", () => {
    for (const g of DRE_GROUPS_SEED) {
      expect(g.value.length).toBeGreaterThan(0);
    }
  });

  it("does not include DNO", () => {
    expect(DRE_GROUPS_SEED.map((g) => g.code)).not.toContain("DNO");
  });
});

const EXPECTED_CODES = [
  "EXPENSE",
  "REVENUE",
  "TRANSFER_INTERNAL",
  "CASH_DRAWER_IN",
  "CASH_DRAWER_OUT",
  "CASH_DRAWER_SHORT",
  "ADJUSTMENT",
] as const;

describe("TRANSACTION_TYPES_SEED (LOV rows)", () => {
  it("ships exactly 7 codes in BA RN-1 order", () => {
    expect(TRANSACTION_TYPES_SEED.map((t) => t.code)).toEqual(EXPECTED_CODES);
  });

  it("uses strictly increasing sortOrder", () => {
    let prev = -Infinity;
    for (const t of TRANSACTION_TYPES_SEED) {
      expect(t.sortOrder).toBeGreaterThan(prev);
      prev = t.sortOrder;
    }
  });

  it("has a non-empty pt-BR label per row", () => {
    for (const t of TRANSACTION_TYPES_SEED) {
      expect(t.label.length).toBeGreaterThan(0);
    }
  });
});

const EXPECTED_PAYMENT_METHOD_CODES = [
  "BOLETO",
  "CHEQUE",
  "CREDIARIO",
  "DEBITO_CONTA",
  "CARTAO_CREDITO",
  "CARTAO_DEBITO",
  "DINHEIRO",
  "PIX",
  "TED",
  "DOC",
  "TRANSFERENCIA",
] as const;

describe("PAYMENT_METHOD_SEED (system LOV)", () => {
  it("ships PIX/TED/DOC as distinct codes (different fees and accounting in BR)", () => {
    expect(PAYMENT_METHOD_SEED.map((p) => p.code)).toEqual(EXPECTED_PAYMENT_METHOD_CODES);
  });

  it("uses strictly increasing sortOrder", () => {
    let prev = -Infinity;
    for (const p of PAYMENT_METHOD_SEED) {
      expect(p.sortOrder).toBeGreaterThan(prev);
      prev = p.sortOrder;
    }
  });

  it("has a non-empty pt-BR label per row", () => {
    for (const p of PAYMENT_METHOD_SEED) {
      expect(p.value.length).toBeGreaterThan(0);
    }
  });
});

describe("TRANSACTION_TYPE_ATTRS (behavior flags)", () => {
  it("matches the BA RN-3 / RN-7 flag matrix", () => {
    expect(TRANSACTION_TYPE_ATTRS).toEqual({
      EXPENSE: { affectsDre: true, requiresCreditor: true, requiresCategory: true },
      REVENUE: { affectsDre: true, requiresCreditor: true, requiresCategory: true },
      TRANSFER_INTERNAL: { affectsDre: false, requiresCreditor: false, requiresCategory: false },
      CASH_DRAWER_IN: { affectsDre: false, requiresCreditor: false, requiresCategory: false },
      CASH_DRAWER_OUT: { affectsDre: false, requiresCreditor: false, requiresCategory: false },
      CASH_DRAWER_SHORT: { affectsDre: true, requiresCreditor: false, requiresCategory: true },
      ADJUSTMENT: { affectsDre: true, requiresCreditor: false, requiresCategory: true },
    });
  });

  it("exposes the same code set as the seed array", () => {
    const seedCodes = new Set(TRANSACTION_TYPES_SEED.map((t) => t.code));
    const attrCodes = new Set(TRANSACTION_TYPE_CODES);
    expect(attrCodes).toEqual(seedCodes);
  });
});
