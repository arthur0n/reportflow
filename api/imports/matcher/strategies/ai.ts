// AIMatcher — interface defined; no provider in v1.
//
// Returns [] when no provider is supplied. When wired up, provider proposals
// are accepted as-is but capped at 0.9 — corroboration from another strategy
// is required to clear the 0.99 short-circuit. Activation gating
// (MATCH_AI_ENABLED env) lives at the registry level, not here.

import type { Matcher, MatchCandidate, MatchInput, MatchTarget } from "../types";

const CONFIDENCE_CAP = 0.9;

export interface AIMatchProvider {
  proposeMatches(input: {
    candidate: string;
    target: MatchTarget;
    catalog: Array<{ id: string; code: string; value: string }>;
    recentDecisions: Array<{ inputNormalized: string; targetId: string; targetCode: string }>;
  }): Promise<Array<{ targetId: string; confidence: number; reason: string }>>;
}

export function createAIMatcher(opts: { priority: number; provider?: AIMatchProvider }): Matcher {
  return {
    id: "ai",
    priority: opts.priority,
    async match(input: MatchInput): Promise<MatchCandidate[]> {
      if (opts.provider === undefined) return [];

      const proposals = await opts.provider.proposeMatches({
        candidate: input.candidate,
        target: input.target,
        catalog: [],
        recentDecisions: [],
      });

      return proposals.map((p) => ({
        targetId: p.targetId,
        // Provider does not return code/value; downstream chain only needs them
        // for display, so we pass empty placeholders here. Wiring layer that
        // actually activates AI must hydrate these from the catalog.
        targetCode: "",
        targetValue: "",
        confidence: Math.min(CONFIDENCE_CAP, p.confidence),
        strategyId: "ai",
        reason: p.reason,
      }));
    },
  };
}
