// api/imports/matcher/strategies/learned-decision.test.ts
//
// Confidence formula + emit gating for LearnedDecisionMatcher. The DB layer
// is mocked: select() chains return canned decision rows, then canned target
// catalog rows. Clock injected via factory `now` for deterministic age math.

import { describe, it, expect, vi, beforeEach } from "vitest";

type DecisionRow = {
  lovTargetId: string | null;
  tvTargetId: string | null;
  decisionKind: string;
  createdAt: string;
};

type CatalogRow = { id: string; code: string; value: string };

let decisionRows: DecisionRow[] = [];
let lovCatalogRows: CatalogRow[] = [];
let tvCatalogRows: CatalogRow[] = [];
let selectCallIndex = 0;

vi.mock("../../../db/client", () => {
  const decisionsBuilder = {
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
      return Promise.resolve(decisionRows);
    },
  };
  const lovCatalogBuilder = {
    from() {
      return this;
    },
    where() {
      return Promise.resolve(lovCatalogRows);
    },
  };
  const tvCatalogBuilder = {
    from() {
      return this;
    },
    where() {
      return Promise.resolve(tvCatalogRows);
    },
  };
  return {
    db: {
      select() {
        const idx = selectCallIndex++;
        if (idx === 0) return decisionsBuilder;
        // Subsequent select() calls are catalog lookups; learned-decision
        // issues at most one lov and one tv catalog query per match() call.
        if (idx === 1) {
          // Heuristic: if there are tv survivors, the catalog code may issue
          // tv first; we differentiate by whether lovCatalogRows has matches.
          return lovCatalogRows.length > 0 ? lovCatalogBuilder : tvCatalogBuilder;
        }
        return tvCatalogBuilder;
      },
    },
  };
});

import { createLearnedDecisionMatcher } from "./learned-decision";
import type { MatchInput } from "../types";

const NOW = new Date("2026-04-29T00:00:00Z");
const fixedNow = (): Date => NOW;

function ageDaysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

function baseInput(overrides: Partial<MatchInput> = {}): MatchInput {
  return {
    candidate: "ifood",
    row: { id: null, description: "ifood", actualAmount: null, subtypeId: null, rawPayload: null },
    target: { kind: "lov-system", type: "CATEGORY" },
    ctx: { tenantId: "t1", tenantIndustry: null, userId: null, bankSlug: null },
    ...overrides,
  };
}

beforeEach(() => {
  decisionRows = [];
  lovCatalogRows = [];
  tvCatalogRows = [];
  selectCallIndex = 0;
});

describe("LearnedDecisionMatcher — confidence formula", () => {
  it("returns [] when no decisions exist", async () => {
    decisionRows = [];
    const matcher = createLearnedDecisionMatcher({ priority: 50, now: fixedNow });
    const out = await matcher.match(baseInput());
    expect(out).toEqual([]);
  });

  it("1 fresh accepted decision → confidence ~0.66", async () => {
    decisionRows = [
      {
        lovTargetId: "L1",
        tvTargetId: null,
        decisionKind: "accepted",
        createdAt: ageDaysAgo(0),
      },
    ];
    lovCatalogRows = [{ id: "L1", code: "food", value: "Food" }];
    const matcher = createLearnedDecisionMatcher({ priority: 50, now: fixedNow });
    const out = await matcher.match(baseInput());
    expect(out).toHaveLength(1);
    expect(out[0]?.confidence).toBeGreaterThan(0.64);
    expect(out[0]?.confidence).toBeLessThan(0.68);
    expect(out[0]?.targetId).toBe("L1");
    expect(out[0]?.strategyId).toBe("learned");
  });

  it("3 fresh accepted decisions → confidence ~0.88", async () => {
    decisionRows = [
      { lovTargetId: "L1", tvTargetId: null, decisionKind: "accepted", createdAt: ageDaysAgo(0) },
      { lovTargetId: "L1", tvTargetId: null, decisionKind: "accepted", createdAt: ageDaysAgo(0) },
      { lovTargetId: "L1", tvTargetId: null, decisionKind: "accepted", createdAt: ageDaysAgo(0) },
    ];
    lovCatalogRows = [{ id: "L1", code: "food", value: "Food" }];
    const matcher = createLearnedDecisionMatcher({ priority: 50, now: fixedNow });
    const out = await matcher.match(baseInput());
    expect(out).toHaveLength(1);
    expect(out[0]?.confidence).toBeGreaterThan(0.86);
    expect(out[0]?.confidence).toBeLessThan(0.9);
  });

  it("10 fresh accepted decisions → confidence saturates at 0.98 cap", async () => {
    decisionRows = Array.from({ length: 10 }, () => ({
      lovTargetId: "L1",
      tvTargetId: null,
      decisionKind: "accepted",
      createdAt: ageDaysAgo(0),
    }));
    lovCatalogRows = [{ id: "L1", code: "food", value: "Food" }];
    const matcher = createLearnedDecisionMatcher({ priority: 50, now: fixedNow });
    const out = await matcher.match(baseInput());
    expect(out).toHaveLength(1);
    expect(out[0]?.confidence).toBeCloseTo(0.98, 2);
  });
});

describe("LearnedDecisionMatcher — edge cases", () => {
  it("only overridden decisions → no candidates emitted (weight 0)", async () => {
    decisionRows = [
      {
        lovTargetId: "L1",
        tvTargetId: null,
        decisionKind: "overridden",
        createdAt: ageDaysAgo(0),
      },
    ];
    lovCatalogRows = [{ id: "L1", code: "food", value: "Food" }];
    const matcher = createLearnedDecisionMatcher({ priority: 50, now: fixedNow });
    const out = await matcher.match(baseInput());
    expect(out).toEqual([]);
  });

  it("decision target soft-deleted (catalog miss) → skipped", async () => {
    decisionRows = [
      { lovTargetId: "L1", tvTargetId: null, decisionKind: "accepted", createdAt: ageDaysAgo(0) },
    ];
    lovCatalogRows = []; // catalog lookup returns nothing → target deleted since
    const matcher = createLearnedDecisionMatcher({ priority: 50, now: fixedNow });
    const out = await matcher.match(baseInput());
    expect(out).toEqual([]);
  });

  it("returns [] for unsupported target kinds (BANK_SLUG)", async () => {
    decisionRows = [
      { lovTargetId: "L1", tvTargetId: null, decisionKind: "accepted", createdAt: ageDaysAgo(0) },
    ];
    const matcher = createLearnedDecisionMatcher({ priority: 50, now: fixedNow });
    const out = await matcher.match(
      baseInput({ target: { kind: "lov-system", type: "BANK_SLUG" } }),
    );
    expect(out).toEqual([]);
  });

  it("returns [] for empty/whitespace candidate after normalization", async () => {
    decisionRows = [
      { lovTargetId: "L1", tvTargetId: null, decisionKind: "accepted", createdAt: ageDaysAgo(0) },
    ];
    const matcher = createLearnedDecisionMatcher({ priority: 50, now: fixedNow });
    const out = await matcher.match(baseInput({ candidate: "   " }));
    expect(out).toEqual([]);
  });

  it("decay over age — 60-day-old decision has lower confidence than fresh", async () => {
    decisionRows = [
      { lovTargetId: "L1", tvTargetId: null, decisionKind: "accepted", createdAt: ageDaysAgo(60) },
    ];
    lovCatalogRows = [{ id: "L1", code: "food", value: "Food" }];
    const matcher = createLearnedDecisionMatcher({ priority: 50, now: fixedNow });
    const out = await matcher.match(baseInput());
    // exp(-1) ≈ 0.368, score ≈ 0.368, confidence = 0.5 + 0.5 * tanh(0.368/3) ≈ 0.561.
    expect(out).toHaveLength(1);
    expect(out[0]?.confidence).toBeGreaterThan(0.55);
    expect(out[0]?.confidence).toBeLessThan(0.58);
  });

  it("manual decisions have weight 1.0 (same as accepted)", async () => {
    decisionRows = [
      { lovTargetId: "L1", tvTargetId: null, decisionKind: "manual", createdAt: ageDaysAgo(0) },
    ];
    lovCatalogRows = [{ id: "L1", code: "food", value: "Food" }];
    const matcher = createLearnedDecisionMatcher({ priority: 50, now: fixedNow });
    const out = await matcher.match(baseInput());
    expect(out).toHaveLength(1);
    expect(out[0]?.confidence).toBeGreaterThan(0.64);
    expect(out[0]?.confidence).toBeLessThan(0.68);
  });
});
