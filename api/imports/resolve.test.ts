// api/imports/resolve.test.ts
//
// Static cross-checks: every code referenced by the system import-match rules
// seed must exist in the matching LOV catalog. Catches the failure mode where
// a seeded rule points at a code that was renamed or removed without updating
// the rules side.

import { describe, it, expect } from "vitest";
import { IMPORT_MATCH_RULES_SEED, PAYMENT_METHOD_SEED, LOV_SEED } from "../../scripts/seed";

describe("import-match-rules seed ↔ LOV alignment", () => {
  it("every PAYMENT_METHOD code in the rules seed exists in PAYMENT_METHOD_SEED", () => {
    const pmCodes = new Set(PAYMENT_METHOD_SEED.map((r) => r.code));
    const referenced = IMPORT_MATCH_RULES_SEED.filter((r) => r.targetKind === "PAYMENT_METHOD").map(
      (r) => r.code,
    );
    const missing = referenced.filter((c) => !pmCodes.has(c));
    expect(missing).toEqual([]);
  });

  it("every SUBTYPE code in the rules seed exists in LOV_SEED.TRANSACTION_SUBTYPE", () => {
    const subtypeCodes = new Set(LOV_SEED["TRANSACTION_SUBTYPE"]?.map((r) => r.code) ?? []);
    const referenced = IMPORT_MATCH_RULES_SEED.filter((r) => r.targetKind === "SUBTYPE").map(
      (r) => r.code,
    );
    const missing = referenced.filter((c) => !subtypeCodes.has(c));
    expect(missing).toEqual([]);
  });
});
