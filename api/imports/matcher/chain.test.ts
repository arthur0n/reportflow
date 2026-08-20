// api/imports/matcher/chain.test.ts
//
// MatcherChain orchestration: dedup, ranking, threshold classification,
// short-circuit, priority ordering, alternatives/suggestions caps.

import { describe, it, expect, vi } from "vitest";
import { MatcherChain } from "./chain";
import type { Matcher, MatchCandidate, MatchInput } from "./types";

const input: MatchInput = {
  candidate: "test",
  row: { id: null, description: "test", actualAmount: null, subtypeId: null, rawPayload: null },
  target: { kind: "lov-system", type: "PAYMENT_METHOD" },
  ctx: { tenantId: "t1", tenantIndustry: null, userId: null, bankSlug: null },
};

function mockMatcher(opts: {
  id: string;
  priority: number;
  candidates: MatchCandidate[];
}): Matcher & { matchSpy: ReturnType<typeof vi.fn> } {
  const matchSpy = vi.fn(async () => opts.candidates);
  return {
    id: opts.id,
    priority: opts.priority,
    match: matchSpy,
    matchSpy,
  };
}

function candidate(targetId: string, confidence: number, strategyId = "test"): MatchCandidate {
  return {
    targetId,
    targetCode: `code-${targetId}`,
    targetValue: `Value ${targetId}`,
    confidence,
    strategyId,
    reason: `reason-${targetId}`,
  };
}

describe("MatcherChain — outcome classification", () => {
  it("returns 'none' when no matchers are registered", async () => {
    const chain = new MatcherChain([]);
    const out = await chain.run(input);
    expect(out).toEqual({ status: "none" });
  });

  it("returns 'none' when the only matcher returns []", async () => {
    const chain = new MatcherChain([mockMatcher({ id: "a", priority: 10, candidates: [] })]);
    const out = await chain.run(input);
    expect(out).toEqual({ status: "none" });
  });

  it("returns 'matched' for a single high-confidence vote with empty alternatives", async () => {
    const c = candidate("T1", 1.0);
    const chain = new MatcherChain([mockMatcher({ id: "a", priority: 10, candidates: [c] })]);
    const out = await chain.run(input);
    expect(out).toEqual({ status: "matched", best: c, alternatives: [] });
  });

  it("dedups votes for the same targetId, keeping the higher confidence", async () => {
    const cLow = candidate("T1", 0.55, "rule");
    const cHigh = candidate("T1", 0.92, "learned");
    const chain = new MatcherChain([
      mockMatcher({ id: "a", priority: 10, candidates: [cLow] }),
      mockMatcher({ id: "b", priority: 20, candidates: [cHigh] }),
    ]);
    const out = await chain.run(input);
    expect(out.status).toBe("matched");
    if (out.status !== "matched") return;
    expect(out.best.confidence).toBe(0.92);
    expect(out.best.strategyId).toBe("learned");
    expect(out.alternatives).toEqual([]);
  });

  it("places below-AUTO_APPLY votes into alternatives when best crosses AUTO_APPLY", async () => {
    const cBest = candidate("T1", 0.95);
    const cAlt = candidate("T2", 0.6);
    const chain = new MatcherChain([
      mockMatcher({ id: "a", priority: 10, candidates: [cBest] }),
      mockMatcher({ id: "b", priority: 20, candidates: [cAlt] }),
    ]);
    const out = await chain.run(input);
    expect(out.status).toBe("matched");
    if (out.status !== "matched") return;
    expect(out.best.targetId).toBe("T1");
    expect(out.alternatives).toHaveLength(1);
    expect(out.alternatives[0]?.targetId).toBe("T2");
  });

  it("returns 'suggested' ranked desc when all votes are between SUGGEST and AUTO_APPLY", async () => {
    const c1 = candidate("T1", 0.7);
    const c2 = candidate("T2", 0.5);
    const c3 = candidate("T3", 0.45);
    const chain = new MatcherChain([
      mockMatcher({ id: "a", priority: 10, candidates: [c2, c3] }),
      mockMatcher({ id: "b", priority: 20, candidates: [c1] }),
    ]);
    const out = await chain.run(input);
    expect(out.status).toBe("suggested");
    if (out.status !== "suggested") return;
    expect(out.candidates.map((c) => c.targetId)).toEqual(["T1", "T2", "T3"]);
  });

  it("returns 'none' when all votes are below SUGGEST_THRESHOLD", async () => {
    const chain = new MatcherChain([
      mockMatcher({
        id: "a",
        priority: 10,
        candidates: [candidate("T1", 0.3), candidate("T2", 0.1)],
      }),
    ]);
    const out = await chain.run(input);
    expect(out).toEqual({ status: "none" });
  });
});

describe("MatcherChain — short-circuit and ordering", () => {
  it("short-circuits downstream matchers when a candidate crosses 0.99", async () => {
    const second = mockMatcher({ id: "b", priority: 20, candidates: [candidate("T2", 0.5)] });
    const chain = new MatcherChain([
      mockMatcher({ id: "a", priority: 10, candidates: [candidate("T1", 1.0)] }),
      second,
    ]);
    await chain.run(input);
    expect(second.matchSpy).not.toHaveBeenCalled();
  });

  it("does NOT short-circuit when the highest vote is below 0.99", async () => {
    const second = mockMatcher({ id: "b", priority: 20, candidates: [candidate("T2", 0.5)] });
    const chain = new MatcherChain([
      mockMatcher({ id: "a", priority: 10, candidates: [candidate("T1", 0.98)] }),
      second,
    ]);
    await chain.run(input);
    expect(second.matchSpy).toHaveBeenCalledTimes(1);
  });

  it("runs lower priority first", async () => {
    const calls: string[] = [];
    const m1: Matcher = {
      id: "later",
      priority: 100,
      match: async () => {
        calls.push("later");
        return [];
      },
    };
    const m2: Matcher = {
      id: "earlier",
      priority: 10,
      match: async () => {
        calls.push("earlier");
        return [];
      },
    };
    await new MatcherChain([m1, m2]).run(input);
    expect(calls).toEqual(["earlier", "later"]);
  });

  it("breaks priority ties by id (lexicographic)", async () => {
    const calls: string[] = [];
    const mZ: Matcher = {
      id: "zeta",
      priority: 10,
      match: async () => {
        calls.push("zeta");
        return [];
      },
    };
    const mA: Matcher = {
      id: "alpha",
      priority: 10,
      match: async () => {
        calls.push("alpha");
        return [];
      },
    };
    await new MatcherChain([mZ, mA]).run(input);
    expect(calls).toEqual(["alpha", "zeta"]);
  });
});

describe("MatcherChain — caps", () => {
  it("caps alternatives at 4 when matched", async () => {
    const cBest = candidate("T0", 0.95);
    const alts = Array.from({ length: 8 }, (_, i) => candidate(`T${i + 1}`, 0.7 - i * 0.01));
    const chain = new MatcherChain([
      mockMatcher({ id: "a", priority: 10, candidates: [cBest, ...alts] }),
    ]);
    const out = await chain.run(input);
    expect(out.status).toBe("matched");
    if (out.status !== "matched") return;
    expect(out.alternatives).toHaveLength(4);
  });

  it("caps suggested candidates at 5", async () => {
    const all = Array.from({ length: 8 }, (_, i) => candidate(`T${i + 1}`, 0.8 - i * 0.01));
    const chain = new MatcherChain([mockMatcher({ id: "a", priority: 10, candidates: all })]);
    const out = await chain.run(input);
    expect(out.status).toBe("suggested");
    if (out.status !== "suggested") return;
    expect(out.candidates).toHaveLength(5);
  });
});
