import { describe, it, expect } from "vitest";
import { parseAmountBR } from "./br";

describe("parseAmountBR", () => {
  describe("plain decimal (OFX / machine exports)", () => {
    it("parses dot as decimal separator", () => {
      expect(parseAmountBR("2526.13")).toBe(252613);
    });

    it("parses a bare integer", () => {
      expect(parseAmountBR("100")).toBe(10000);
    });

    it("parses a negative plain decimal", () => {
      expect(parseAmountBR("-3500.00")).toBe(-350000);
    });

    it("parses a two-digit decimal without thousands", () => {
      expect(parseAmountBR("206.09")).toBe(20609);
    });

    it("honors trailing C (credit) suffix", () => {
      expect(parseAmountBR("1234.56C")).toBe(123456);
    });
  });

  describe("BR format (comma decimal)", () => {
    it("parses BR format with thousands separator", () => {
      expect(parseAmountBR("1.234,56")).toBe(123456);
    });

    it("parses BR format without thousands separator", () => {
      expect(parseAmountBR("2526,13")).toBe(252613);
    });

    it("parses a negative BR amount", () => {
      expect(parseAmountBR("-350,00")).toBe(-35000);
    });

    it("parses a positive BR amount with explicit +", () => {
      expect(parseAmountBR("+1.200,00")).toBe(120000);
    });

    it("honors trailing D (debit) suffix as negative", () => {
      expect(parseAmountBR("1.234,56D")).toBe(-123456);
    });
  });

  describe("edge cases", () => {
    it("throws on empty string", () => {
      expect(() => parseAmountBR("")).toThrow(/empty/);
    });

    it("throws on whitespace-only string", () => {
      expect(() => parseAmountBR("   ")).toThrow(/empty/);
    });

    it("throws on non-numeric content", () => {
      expect(() => parseAmountBR("abc")).toThrow(/cannot parse amount/);
    });
  });
});
