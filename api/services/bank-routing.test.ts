// api/services/bank-routing.test.ts
//
// Pure coverage for normalizeBankId + a static cross-check that every parent
// slug declared in the BANK_ROUTING seed exists in the BANK_SLUG seed (so a
// FK lookup can never silently dead-end on first-run seeding).

import { describe, it, expect } from "vitest";
import { normalizeBankId } from "./bank-routing";
import { BANK_ROUTING_SEED, LOV_SEED } from "../../scripts/seed";

describe("normalizeBankId", () => {
  it.each([
    ["341", "341"],
    ["0341", "341"],
    ["033", "033"],
    ["33", "033"],
    ["0033", "033"],
    ["001", "001"],
    ["1", "001"],
    ["  260  ", "260"],
  ])("normalizes %j → %j", (input, expected) => {
    expect(normalizeBankId(input)).toBe(expected);
  });

  it("returns empty string for empty/whitespace input", () => {
    expect(normalizeBankId("")).toBe("");
    expect(normalizeBankId("   ")).toBe("");
  });

  it("returns '000' for all-zero input (oddball but well-formed)", () => {
    expect(normalizeBankId("0")).toBe("000");
    expect(normalizeBankId("0000")).toBe("000");
  });
});

describe("BANK_ROUTING seed alignment", () => {
  it("every parent slug exists in the BANK_SLUG seed", () => {
    const bankSlugs = new Set(LOV_SEED["BANK_SLUG"]?.map((r) => r.code));
    const missing = BANK_ROUTING_SEED.filter((r) => !bankSlugs.has(r.parentSlug)).map(
      (r) => r.parentSlug,
    );
    expect(missing).toEqual([]);
  });

  it("every routing code is the normalized 3-digit form", () => {
    const malformed = BANK_ROUTING_SEED.filter((r) => normalizeBankId(r.bankId) !== r.bankId);
    expect(malformed).toEqual([]);
  });

  it("seed entries carry no human-readable label that would denormalize the parent", () => {
    // The bank name lives on the parent BANK_SLUG row; the BANK_ROUTING entry
    // should not mirror it. Enforced by shape: each seed row has only bankId
    // + parentSlug — no `value` field that could drift from the parent.
    for (const row of BANK_ROUTING_SEED) {
      expect(Object.keys(row).sort()).toEqual(["bankId", "parentSlug"]);
    }
  });
});
