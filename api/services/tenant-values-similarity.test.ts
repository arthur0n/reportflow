// api/services/tenant-values-similarity.test.ts
//
// Pure unit coverage for findSimilarTenantValues. The pg_trgm SQL is exercised
// via integration smoke; this test verifies the JS-side contract: empty input
// short-circuits, the SQL pipeline is composed (select → where → orderBy →
// limit), and rows returned by the driver are mapped 1:1 with similarity
// coerced to Number.

import { describe, it, expect } from "vitest";
import { findSimilarTenantValues } from "./tenant-values-similarity";
import type { DbLike } from "./tenant-values-crud";

type CannedRow = { id: string; code: string; value: string; sim: string | number };

function stubDb(rows: CannedRow[]): { db: DbLike; calls: { select: number; limit: number } } {
  const calls = { select: 0, limit: 0 };
  const builder = {
    from() {
      return this;
    },
    where() {
      return this;
    },
    orderBy() {
      return this;
    },
    limit() {
      calls.limit++;
      return Promise.resolve(rows);
    },
  };
  const db = {
    select() {
      calls.select++;
      return builder;
    },
  } as unknown as DbLike;
  return { db, calls };
}

describe("findSimilarTenantValues", () => {
  it("returns [] for empty candidate without touching the db", async () => {
    const { db, calls } = stubDb([]);
    const result = await findSimilarTenantValues({
      db,
      tenantId: "t1",
      kind: "SUPPLIER",
      candidateValue: "",
    });
    expect(result).toEqual([]);
    expect(calls.select).toBe(0);
  });

  it("returns [] when slug is empty (only punctuation)", async () => {
    const { db, calls } = stubDb([]);
    const result = await findSimilarTenantValues({
      db,
      tenantId: "t1",
      kind: "SUPPLIER",
      candidateValue: "---",
    });
    expect(result).toEqual([]);
    expect(calls.select).toBe(0);
  });

  it("returns exact-slug match with similarity 1.0", async () => {
    const { db } = stubDb([{ id: "row-1", code: "ifood", value: "Ifood", sim: "1.0" }]);
    const result = await findSimilarTenantValues({
      db,
      tenantId: "t1",
      kind: "SUPPLIER",
      candidateValue: "Ifood",
    });
    expect(result).toEqual([{ id: "row-1", code: "ifood", value: "Ifood", similarity: 1 }]);
  });

  it("maps fuzzy matches preserving order and similarity number", async () => {
    const { db } = stubDb([
      { id: "row-1", code: "ifood", value: "IFOOD", sim: "0.83" },
      { id: "row-2", code: "ifood-pay", value: "iFood Pay", sim: "0.55" },
    ]);
    const result = await findSimilarTenantValues({
      db,
      tenantId: "t1",
      kind: "SUPPLIER",
      candidateValue: "IFOOD FEE",
    });
    expect(result).toEqual([
      { id: "row-1", code: "ifood", value: "IFOOD", similarity: 0.83 },
      { id: "row-2", code: "ifood-pay", value: "iFood Pay", similarity: 0.55 },
    ]);
  });

  it("issues exactly one query when the candidate is non-empty", async () => {
    const { db, calls } = stubDb([]);
    await findSimilarTenantValues({
      db,
      tenantId: "t1",
      kind: "CUSTOMER",
      candidateValue: "anything",
    });
    expect(calls.select).toBe(1);
    expect(calls.limit).toBe(1);
  });
});
