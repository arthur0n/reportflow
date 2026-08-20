// Strategy registry — composes the chain.
//
// Priority order matters only for short-circuit eligibility (chain runs
// strategies in priority order and stops if any vote ≥ SHORT_CIRCUIT). All
// votes are then deduped+ranked by confidence; priority does not trump it.
//
// AI is only attached when MATCH_AI_ENABLED=true. Provider injection (Bedrock,
// OpenAI, etc.) lands in v2 — the registry only knows the gate.

import { MatcherChain } from "./chain";
import type { Matcher } from "./types";
import { createExactCodeMatcher } from "./strategies/exact-code";
import { createLearnedDecisionMatcher } from "./strategies/learned-decision";
import { createRuleMatcher } from "./strategies/rule";
import { createTrigramFuzzyMatcher } from "./strategies/trigram-fuzzy";
import { createAIMatcher } from "./strategies/ai";

function buildDefaultMatchers(): Matcher[] {
  const matchers: Matcher[] = [
    createExactCodeMatcher({ priority: 10 }),
    createLearnedDecisionMatcher({ priority: 20 }),
    createRuleMatcher({ priority: 30 }),
    createTrigramFuzzyMatcher({ priority: 40 }),
  ];
  if (process.env["MATCH_AI_ENABLED"] === "true") {
    matchers.push(createAIMatcher({ priority: 50 }));
  }
  return matchers;
}

let cachedChain: MatcherChain | null = null;

export function defaultChain(): MatcherChain {
  cachedChain ??= new MatcherChain(buildDefaultMatchers());
  return cachedChain;
}

/** Test-only: rebuild the chain with custom matchers (e.g. injected clock). */
export function setTestChain(matchers: Matcher[]): void {
  cachedChain = new MatcherChain(matchers);
}

/** Test-only: drop the cached chain so the next defaultChain() rebuilds. */
export function resetChain(): void {
  cachedChain = null;
}
