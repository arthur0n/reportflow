// Auto-match chain.
//
// Strategies vote; chain dedups, ranks, classifies the outcome.
// Short-circuits when any vote crosses 0.99 so ExactCode/saturated-Learned
// can skip the rest. Otherwise collects all votes (the picker UI wants
// alternatives, and a Rule + LearnedDecision agreeing on the same target
// merges into one entry rather than priority-order trumping confidence).

import type { Matcher, MatchInput, MatchOutcome, MatchCandidate } from "./types";

export const AUTO_APPLY_THRESHOLD = 0.85;
export const SUGGEST_THRESHOLD = 0.4;
export const SHORT_CIRCUIT_THRESHOLD = 0.99;

const MAX_ALTERNATIVES = 4;
const MAX_SUGGESTIONS = 5;

export class MatcherChain {
  constructor(private readonly matchers: ReadonlyArray<Matcher>) {}

  async run(input: MatchInput): Promise<MatchOutcome> {
    const sorted = [...this.matchers].sort((a, b) =>
      a.priority !== b.priority ? a.priority - b.priority : a.id.localeCompare(b.id),
    );
    const collected: MatchCandidate[] = [];
    for (const m of sorted) {
      const out = await m.match(input);
      collected.push(...out);
      if (out.some((c) => c.confidence >= SHORT_CIRCUIT_THRESHOLD)) break;
    }

    // Dedup: one vote per target, keep the highest confidence.
    const byTarget = new Map<string, MatchCandidate>();
    for (const c of collected) {
      const existing = byTarget.get(c.targetId);
      if (existing === undefined || c.confidence > existing.confidence) {
        byTarget.set(c.targetId, c);
      }
    }

    const ranked = [...byTarget.values()].sort((a, b) => b.confidence - a.confidence);
    if (ranked.length === 0) return { status: "none" };

    const best = ranked[0];
    if (best === undefined) return { status: "none" };

    if (best.confidence >= AUTO_APPLY_THRESHOLD) {
      const alternatives = ranked
        .slice(1)
        .filter((c) => c.confidence >= SUGGEST_THRESHOLD)
        .slice(0, MAX_ALTERNATIVES);
      return { status: "matched", best, alternatives };
    }

    const surfaced = ranked
      .filter((c) => c.confidence >= SUGGEST_THRESHOLD)
      .slice(0, MAX_SUGGESTIONS);
    if (surfaced.length === 0) return { status: "none" };
    return { status: "suggested", candidates: surfaced };
  }
}
