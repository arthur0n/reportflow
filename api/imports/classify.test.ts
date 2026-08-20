import { describe, it, expect } from "vitest";
import { classifyTransactionType } from "./classify";

describe("classifyTransactionType", () => {
  it("maps PIX paymentMethodCode to TRANSFER_INTERNAL (negative)", () => {
    expect(classifyTransactionType({ actualAmount: -100n, paymentMethodCode: "PIX" })).toBe(
      "TRANSFER_INTERNAL",
    );
  });

  it("maps PIX paymentMethodCode to TRANSFER_INTERNAL (positive)", () => {
    expect(classifyTransactionType({ actualAmount: 100n, paymentMethodCode: "PIX" })).toBe(
      "TRANSFER_INTERNAL",
    );
  });

  it("maps TED to TRANSFER_INTERNAL", () => {
    expect(classifyTransactionType({ actualAmount: -500n, paymentMethodCode: "TED" })).toBe(
      "TRANSFER_INTERNAL",
    );
  });

  it("maps DOC to TRANSFER_INTERNAL", () => {
    expect(classifyTransactionType({ actualAmount: 200n, paymentMethodCode: "DOC" })).toBe(
      "TRANSFER_INTERNAL",
    );
  });

  it("maps generic TRANSFERENCIA to TRANSFER_INTERNAL", () => {
    expect(
      classifyTransactionType({ actualAmount: -50n, paymentMethodCode: "TRANSFERENCIA" }),
    ).toBe("TRANSFER_INTERNAL");
  });

  it("maps negative non-transfer payment method to EXPENSE", () => {
    expect(classifyTransactionType({ actualAmount: -350n, paymentMethodCode: "BOLETO" })).toBe(
      "EXPENSE",
    );
  });

  it("maps positive non-transfer payment method to REVENUE", () => {
    expect(classifyTransactionType({ actualAmount: 1000n, paymentMethodCode: "DINHEIRO" })).toBe(
      "REVENUE",
    );
  });

  it("maps null paymentMethodCode by sign (negative → EXPENSE)", () => {
    expect(classifyTransactionType({ actualAmount: -1n, paymentMethodCode: null })).toBe("EXPENSE");
  });

  it("maps null paymentMethodCode by sign (positive → REVENUE)", () => {
    expect(classifyTransactionType({ actualAmount: 1n, paymentMethodCode: null })).toBe("REVENUE");
  });

  it("unrecognized paymentMethodCode falls through to sign-based", () => {
    expect(classifyTransactionType({ actualAmount: -42n, paymentMethodCode: "UNKNOWN" })).toBe(
      "EXPENSE",
    );
  });
});
