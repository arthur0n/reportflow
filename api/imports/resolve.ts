// Smart resolver — adapter over the matcher chain.
//
// Public API (ResolveTarget / ResolveResult) is preserved for back-compat
// with the existing tRPC shape; internally every call now goes through
// defaultChain().run(...). The system LOV cache moved into ExactCodeMatcher;
// clearResolverCache is a re-alias of clearExactCodeCache so existing call
// sites in LOV-mutation procedures keep working.

import { defaultChain, clearExactCodeCache, type MatchOutcome } from "./matcher";

export type ResolveTarget =
  { kind: "lov-system"; type: string } | { kind: "tenant-value"; tvKind: string };

export type ResolveCandidate = {
  id: string;
  code: string;
  value: string;
  score: number;
};

export type ResolveResult =
  | { status: "matched"; id: string; code: string; value: string }
  | { status: "suggested"; candidates: ResolveCandidate[] }
  | { status: "none" };

export type ResolveCtx = {
  tenantId: string;
  tenantIndustry?: string | null;
};

/** Bust the system LOV cache. Call from any procedure that mutates system LOV rows. */
export const clearResolverCache = clearExactCodeCache;

export async function resolve(
  target: ResolveTarget,
  candidate: string | null | undefined,
  ctx: ResolveCtx,
): Promise<ResolveResult> {
  if (candidate === null || candidate === undefined) return { status: "none" };
  const trimmed = candidate.trim();
  if (trimmed.length === 0) return { status: "none" };

  const outcome = await defaultChain().run({
    candidate: trimmed,
    row: {
      id: null,
      description: trimmed,
      actualAmount: null,
      subtypeId: null,
      rawPayload: null,
    },
    target,
    ctx: {
      tenantId: ctx.tenantId,
      tenantIndustry: ctx.tenantIndustry ?? null,
      userId: null,
      bankSlug: null,
    },
  });

  return adaptOutcome(outcome);
}

function adaptOutcome(outcome: MatchOutcome): ResolveResult {
  if (outcome.status === "none") return { status: "none" };
  if (outcome.status === "matched") {
    return {
      status: "matched",
      id: outcome.best.targetId,
      code: outcome.best.targetCode,
      value: outcome.best.targetValue,
    };
  }
  return {
    status: "suggested",
    candidates: outcome.candidates.map((c) => ({
      id: c.targetId,
      code: c.targetCode,
      value: c.targetValue,
      score: c.confidence,
    })),
  };
}
