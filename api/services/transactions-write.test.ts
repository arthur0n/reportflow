// api/services/transactions-write.test.ts
//
// Table-driven coverage: each transaction type's required-classifier set
// per TRANSACTION_TYPE_ATTRS, plus a guard that paymentMethod is never
// flagged (no type requires it today).

import { describe, it, expect } from "vitest";
import { assertClassifiersComplete, defaultTransactionStatus } from "./transactions-write";

const FILLED = { creditorId: "u1", categoryId: "u2", paymentMethodId: "u3" } as const;

describe("assertClassifiersComplete", () => {
  describe("EXPENSE / REVENUE — both creditor and category required", () => {
    it.each(["EXPENSE", "REVENUE"] as const)("%s passes when both set", (type) => {
      expect(assertClassifiersComplete({ transactionType: type, ...FILLED })).toEqual([]);
    });
    it.each(["EXPENSE", "REVENUE"] as const)("%s flags creditor", (type) => {
      expect(
        assertClassifiersComplete({ transactionType: type, ...FILLED, creditorId: null }),
      ).toEqual(["creditor"]);
    });
    it.each(["EXPENSE", "REVENUE"] as const)("%s flags category", (type) => {
      expect(
        assertClassifiersComplete({ transactionType: type, ...FILLED, categoryId: null }),
      ).toEqual(["category"]);
    });
    it.each(["EXPENSE", "REVENUE"] as const)("%s flags both when both missing", (type) => {
      expect(
        assertClassifiersComplete({
          transactionType: type,
          ...FILLED,
          creditorId: null,
          categoryId: null,
        }),
      ).toEqual(["creditor", "category"]);
    });
  });

  describe("TRANSFER_INTERNAL / CASH_DRAWER_IN / CASH_DRAWER_OUT — no requirements", () => {
    it.each(["TRANSFER_INTERNAL", "CASH_DRAWER_IN", "CASH_DRAWER_OUT"] as const)(
      "%s passes with all FKs null",
      (type) => {
        expect(
          assertClassifiersComplete({
            transactionType: type,
            creditorId: null,
            categoryId: null,
            paymentMethodId: null,
          }),
        ).toEqual([]);
      },
    );
  });

  describe("CASH_DRAWER_SHORT / ADJUSTMENT — category required, creditor not", () => {
    it.each(["CASH_DRAWER_SHORT", "ADJUSTMENT"] as const)("%s passes when category set", (type) => {
      expect(
        assertClassifiersComplete({
          transactionType: type,
          creditorId: null,
          categoryId: "u1",
          paymentMethodId: null,
        }),
      ).toEqual([]);
    });
    it.each(["CASH_DRAWER_SHORT", "ADJUSTMENT"] as const)("%s flags missing category", (type) => {
      expect(
        assertClassifiersComplete({
          transactionType: type,
          creditorId: null,
          categoryId: null,
          paymentMethodId: null,
        }),
      ).toEqual(["category"]);
    });
  });

  it("paymentMethod is never flagged today (no type requires it)", () => {
    const types = [
      "EXPENSE",
      "REVENUE",
      "TRANSFER_INTERNAL",
      "CASH_DRAWER_IN",
      "CASH_DRAWER_OUT",
      "CASH_DRAWER_SHORT",
      "ADJUSTMENT",
    ] as const;
    for (const t of types) {
      const missing = assertClassifiersComplete({
        transactionType: t,
        creditorId: "u1",
        categoryId: "u2",
        paymentMethodId: null,
      });
      expect(missing).not.toContain("paymentMethod");
    }
  });
});

describe("defaultTransactionStatus", () => {
  it("returns REVISAR when classifiers are missing", () => {
    expect(
      defaultTransactionStatus({
        actualDate: "2026-05-01",
        actualAmount: -1000n,
        missingClassifiers: ["creditor"],
      }),
    ).toBe("REVISAR");
  });

  it("returns CERTO when realized leg is present and classifiers complete", () => {
    expect(
      defaultTransactionStatus({
        actualDate: "2026-05-01",
        actualAmount: -1000n,
        missingClassifiers: [],
      }),
    ).toBe("CERTO");
  });

  it("returns ESTIMADO when realized leg is absent (forecast only)", () => {
    expect(
      defaultTransactionStatus({
        actualDate: null,
        actualAmount: null,
        missingClassifiers: [],
      }),
    ).toBe("ESTIMADO");
    expect(
      defaultTransactionStatus({
        actualDate: "2026-05-01",
        actualAmount: null,
        missingClassifiers: [],
      }),
    ).toBe("ESTIMADO");
  });

  it("REVISAR wins over CERTO when both apply", () => {
    expect(
      defaultTransactionStatus({
        actualDate: "2026-05-01",
        actualAmount: -1000n,
        missingClassifiers: ["category"],
      }),
    ).toBe("REVISAR");
  });
});
