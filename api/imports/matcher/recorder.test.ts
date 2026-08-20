// api/imports/matcher/recorder.test.ts
//
// recordDecision: classifier-change → import_match_decisions row writes,
// autoMatchPatterns → import_match_rules row writes (with idempotency),
// and the cache-bust on rule promotion.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MatchOutcome } from "./types";

type CapturedInsert = { table: string; values: Record<string, unknown> };

let creditorLookupRows: Array<{ kind: string }> = [];
let existingRuleRows: Array<{ id: string }> = [];
let inserts: CapturedInsert[] = [];
let txCalls = 0;
let _creditorLookupCalls = 0;
let cacheClearCalls: Array<{ kind: string; tenantId?: string }> = [];

vi.mock("../../db/client", () => {
  // Top-level db.select() is the creditor lookup chain in recordDecision.
  const creditorLookupBuilder = {
    from() {
      return this;
    },
    where() {
      return this;
    },
    limit() {
      return Promise.resolve(creditorLookupRows);
    },
  };

  // Inside the transaction: select() (existence check) + insert(table).values(payload).
  const tx = {
    select() {
      const builder = {
        from(_table: { _: { name?: string } } | unknown) {
          return this;
        },
        where() {
          return this;
        },
        limit() {
          return Promise.resolve(existingRuleRows);
        },
      };
      return builder;
    },
    insert(table: { _?: { name?: string } } | unknown) {
      const t = table as { _?: { name?: string } };
      const tableName = t._?.name ?? "unknown";
      return {
        async values(payload: Record<string, unknown>) {
          inserts.push({ table: tableName, values: payload });
        },
      };
    },
  };

  return {
    db: {
      select() {
        _creditorLookupCalls++;
        return creditorLookupBuilder;
      },
      async transaction<T>(callback: (tx: unknown) => Promise<T>): Promise<T> {
        txCalls++;
        return callback(tx);
      },
    },
  };
});

vi.mock("./strategies/rule", () => ({
  clearMatchRulesCache: (scope: { kind: string; tenantId?: string }) => {
    cacheClearCalls.push(scope);
  },
}));

import { recordDecision } from "./recorder";

const ctx = { tenantId: "tenant-1", userId: "user-1" };

function matchedOutcome(targetId: string, strategyId = "trigram"): MatchOutcome {
  return {
    status: "matched",
    best: {
      targetId,
      targetCode: `code-${targetId}`,
      targetValue: `Value ${targetId}`,
      confidence: 0.9,
      strategyId,
      reason: "test",
    },
    alternatives: [],
  };
}

beforeEach(() => {
  creditorLookupRows = [];
  existingRuleRows = [];
  inserts = [];
  txCalls = 0;
  _creditorLookupCalls = 0;
  cacheClearCalls = [];
});

describe("recordDecision — decision rows", () => {
  it("no-ops when nothing changed and no patterns supplied", async () => {
    await recordDecision({
      ctx,
      rowBefore: {
        id: "r1",
        description: "ifood",
        categoryId: "C1",
        creditorId: null,
        paymentMethodId: null,
        subtypeId: null,
        matchProposalJson: null,
      },
      rowAfter: {
        categoryId: "C1",
        creditorId: null,
        paymentMethodId: null,
        subtypeId: null,
      },
    });
    expect(txCalls).toBe(0);
    expect(inserts).toEqual([]);
  });

  it("records 'accepted' when fresh classifier matches the proposal best", async () => {
    await recordDecision({
      ctx,
      rowBefore: {
        id: "r1",
        description: "IFOOD",
        categoryId: null,
        creditorId: null,
        paymentMethodId: null,
        subtypeId: null,
        matchProposalJson: { "lov:CATEGORY": matchedOutcome("C1", "trigram") },
      },
      rowAfter: {
        categoryId: "C1",
        creditorId: null,
        paymentMethodId: null,
        subtypeId: null,
      },
    });
    expect(inserts).toHaveLength(1);
    const row = inserts[0]?.values;
    expect(row?.["decisionKind"]).toBe("accepted");
    expect(row?.["lovTargetId"]).toBe("C1");
    expect(row?.["tvTargetId"]).toBeNull();
    expect(row?.["targetKind"]).toBe("CATEGORY");
    expect(row?.["proposedByStrategy"]).toBe("trigram");
    expect(row?.["overriddenLovTargetId"]).toBeNull();
  });

  it("records 'overridden' when categoryId changes from A to B and proposal said A", async () => {
    await recordDecision({
      ctx,
      rowBefore: {
        id: "r1",
        description: "IFOOD",
        categoryId: "A",
        creditorId: null,
        paymentMethodId: null,
        subtypeId: null,
        matchProposalJson: { "lov:CATEGORY": matchedOutcome("A") },
      },
      rowAfter: {
        categoryId: "B",
        creditorId: null,
        paymentMethodId: null,
        subtypeId: null,
      },
    });
    expect(inserts).toHaveLength(1);
    const row = inserts[0]?.values;
    expect(row?.["decisionKind"]).toBe("overridden");
    expect(row?.["lovTargetId"]).toBe("B");
    expect(row?.["overriddenLovTargetId"]).toBe("A");
  });

  it("records 'manual' when classifier set fresh with no proposal", async () => {
    await recordDecision({
      ctx,
      rowBefore: {
        id: "r1",
        description: "IFOOD",
        categoryId: null,
        creditorId: null,
        paymentMethodId: null,
        subtypeId: null,
        matchProposalJson: null,
      },
      rowAfter: {
        categoryId: "C1",
        creditorId: null,
        paymentMethodId: null,
        subtypeId: null,
      },
    });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.values["decisionKind"]).toBe("manual");
  });
});

describe("recordDecision — creditor lookup", () => {
  it("records SUPPLIER decision with tvTargetId set when creditor resolves to SUPPLIER", async () => {
    creditorLookupRows = [{ kind: "SUPPLIER" }];
    await recordDecision({
      ctx,
      rowBefore: {
        id: "r1",
        description: "IFOOD",
        categoryId: null,
        creditorId: null,
        paymentMethodId: null,
        subtypeId: null,
        matchProposalJson: null,
      },
      rowAfter: {
        categoryId: null,
        creditorId: "S1",
        paymentMethodId: null,
        subtypeId: null,
      },
    });
    expect(inserts).toHaveLength(1);
    const row = inserts[0]?.values;
    expect(row?.["targetKind"]).toBe("SUPPLIER");
    expect(row?.["tvTargetId"]).toBe("S1");
    expect(row?.["lovTargetId"]).toBeNull();
  });

  it("silently skips creditor decision when tenant_values lookup misses", async () => {
    creditorLookupRows = [];
    await recordDecision({
      ctx,
      rowBefore: {
        id: "r1",
        description: "IFOOD",
        categoryId: null,
        creditorId: null,
        paymentMethodId: null,
        subtypeId: null,
        matchProposalJson: null,
      },
      rowAfter: {
        categoryId: null,
        creditorId: "S-MISSING",
        paymentMethodId: null,
        subtypeId: null,
      },
    });
    expect(inserts).toEqual([]);
    expect(txCalls).toBe(0);
  });
});

describe("recordDecision — autoMatchPatterns promotion", () => {
  it("inserts a user_promoted rule and busts cache when autoMatchPatterns supplied", async () => {
    creditorLookupRows = [{ kind: "CUSTOMER" }];
    existingRuleRows = [];
    await recordDecision({
      ctx,
      rowBefore: {
        id: "r1",
        description: "CLAUD B PAGAMENTO",
        categoryId: null,
        creditorId: null,
        paymentMethodId: null,
        subtypeId: null,
        matchProposalJson: null,
      },
      rowAfter: {
        categoryId: null,
        creditorId: "TV-CUST",
        paymentMethodId: null,
        subtypeId: null,
      },
      autoMatchPatterns: [{ targetKind: "CUSTOMER", pattern: "CLAUD B" }],
    });
    const ruleInserts = inserts.filter((i) => i.values["origin"] === "user_promoted");
    expect(ruleInserts).toHaveLength(1);
    const r = ruleInserts[0]?.values;
    expect(r?.["matchKind"]).toBe("contains");
    expect(r?.["pattern"]).toBe("CLAUD B");
    expect(r?.["targetKind"]).toBe("CUSTOMER");
    expect(r?.["tvTargetId"]).toBe("TV-CUST");
    expect(r?.["lovTargetId"]).toBeNull();
    expect(cacheClearCalls).toEqual([{ kind: "tenant", tenantId: "tenant-1" }]);
  });

  it("falls back to rowBefore.description when pattern is undefined", async () => {
    await recordDecision({
      ctx,
      rowBefore: {
        id: "r1",
        description: "FALLBACK TEXT",
        categoryId: null,
        creditorId: null,
        paymentMethodId: "PM1",
        subtypeId: null,
        matchProposalJson: null,
      },
      rowAfter: {
        categoryId: null,
        creditorId: null,
        paymentMethodId: "PM1",
        subtypeId: null,
      },
      autoMatchPatterns: [{ targetKind: "PAYMENT_METHOD", pattern: undefined }],
    });
    const ruleInserts = inserts.filter((i) => i.values["origin"] === "user_promoted");
    expect(ruleInserts).toHaveLength(1);
    expect(ruleInserts[0]?.values["pattern"]).toBe("FALLBACK TEXT");
  });
});

describe("recordDecision — promotion skip cases", () => {
  it("skips rule insert when pattern is shorter than 2 chars after trim", async () => {
    await recordDecision({
      ctx,
      rowBefore: {
        id: "r1",
        description: "x",
        categoryId: null,
        creditorId: null,
        paymentMethodId: "PM1",
        subtypeId: null,
        matchProposalJson: null,
      },
      rowAfter: {
        categoryId: null,
        creditorId: null,
        paymentMethodId: "PM1",
        subtypeId: null,
      },
      autoMatchPatterns: [{ targetKind: "PAYMENT_METHOD", pattern: " a " }],
    });
    const ruleInserts = inserts.filter((i) => i.values["origin"] === "user_promoted");
    expect(ruleInserts).toHaveLength(0);
    expect(cacheClearCalls).toEqual([]);
  });

  it("skips rule insert when the corresponding rowAfter classifier is null", async () => {
    await recordDecision({
      ctx,
      rowBefore: {
        id: "r1",
        description: "IFOOD",
        categoryId: null,
        creditorId: null,
        paymentMethodId: null,
        subtypeId: null,
        matchProposalJson: null,
      },
      rowAfter: {
        categoryId: null,
        creditorId: null,
        paymentMethodId: null,
        subtypeId: null,
      },
      autoMatchPatterns: [{ targetKind: "CATEGORY", pattern: "IFOOD" }],
    });
    expect(inserts).toEqual([]);
    expect(cacheClearCalls).toEqual([]);
  });

  it("skips duplicate rule and does NOT bust cache when existence query hits", async () => {
    existingRuleRows = [{ id: "rule-existing" }];
    await recordDecision({
      ctx,
      rowBefore: {
        id: "r1",
        description: "IFOOD",
        categoryId: "C1",
        creditorId: null,
        paymentMethodId: null,
        subtypeId: null,
        matchProposalJson: null,
      },
      rowAfter: {
        categoryId: "C1",
        creditorId: null,
        paymentMethodId: null,
        subtypeId: null,
      },
      autoMatchPatterns: [{ targetKind: "CATEGORY", pattern: "IFOOD" }],
    });
    const ruleInserts = inserts.filter((i) => i.values["origin"] === "user_promoted");
    expect(ruleInserts).toHaveLength(0);
    expect(cacheClearCalls).toEqual([]);
  });
});
