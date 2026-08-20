import { type PickerItem } from "@/components/inline-ref-picker";
import { type TrpcOutput } from "@/shared/lib/trpc";

export type SuggestProposal = TrpcOutput["transactions"]["suggest"];
export type MatchOutcome = SuggestProposal[keyof SuggestProposal];

/**
 * Picker `suggestions` projection of one matcher outcome. Filters to ids the
 * picker actually knows about — the matcher chain may surface a row that
 * exists in a different tenant scope than the picker's current LOV / TV
 * snapshot, and showing an unselectable suggestion is worse than showing none.
 */
export function suggestionsFromOutcome(
  outcome: MatchOutcome | undefined,
  knownIds: ReadonlySet<string>,
): PickerItem[] {
  if (outcome === undefined || outcome.status === "none") return [];
  const candidates =
    outcome.status === "matched" ? [outcome.best, ...outcome.alternatives] : outcome.candidates;
  return candidates
    .filter((c) => knownIds.has(c.targetId))
    .map((c) => ({
      id: c.targetId,
      label: c.targetValue,
      sublabel: `${Math.round(c.confidence * 100)}%`,
    }));
}

/** Auto-apply id when the matcher chain crossed AUTO_APPLY_THRESHOLD. */
export function autoFillIdFor(outcome: MatchOutcome | undefined): string | null {
  return outcome?.status === "matched" ? outcome.best.targetId : null;
}
