// Public barrel for the import auto-match engine.

import { defaultChain } from "./registry";
import {
  targetKey,
  type Matcher,
  type MatchTarget,
  type MatchTargetKey,
  type MatchInput,
  type MatchInputRow,
  type MatchInputCtx,
  type MatchCandidate,
  type MatchOutcome,
} from "./types";

export { defaultChain, setTestChain, resetChain } from "./registry";
export {
  MatcherChain,
  AUTO_APPLY_THRESHOLD,
  SUGGEST_THRESHOLD,
  SHORT_CIRCUIT_THRESHOLD,
} from "./chain";
export { normalizeForMatch } from "./normalize";
export { recordDecision, type RecordDecisionArgs } from "./recorder";
export { loadSystemRules, loadTenantRules, type RuleRow } from "./rules";
export { clearExactCodeCache } from "./strategies/exact-code";
export { clearMatchRulesCache } from "./strategies/rule";
export { targetKey };
export type {
  Matcher,
  MatchTarget,
  MatchTargetKey,
  MatchInput,
  MatchInputRow,
  MatchInputCtx,
  MatchCandidate,
  MatchOutcome,
};

/**
 * Run the chain across multiple targets with a shared input. Targets are
 * independent — each chain run is its own dedup/rank pass. Returns a record
 * keyed by `targetKey(target)` so callers can look up by `'lov:CATEGORY'` etc.
 */
export async function runChainForTargets(
  targets: ReadonlyArray<MatchTarget>,
  base: { candidate: string; row: MatchInputRow; ctx: MatchInputCtx },
): Promise<Record<MatchTargetKey, MatchOutcome>> {
  const chain = defaultChain();
  const entries = await Promise.all(
    targets.map(async (target) => {
      const outcome = await chain.run({ ...base, target });
      return [targetKey(target), outcome] as const;
    }),
  );
  return Object.fromEntries(entries);
}
