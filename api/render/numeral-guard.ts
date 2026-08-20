// api/render/numeral-guard.ts
//
// PORTED VERBATIM from poc/lib/numeral-guard.ts. Proven there; the only change
// is this header.
//
// Numeral guard — the hallucination tripwire for {{ai}} prose (§12.12c).
//
// The model writes prose AROUND figures; it must never be the SOURCE of one.
// Every numeric token in an AI slot must therefore already exist somewhere in
// the deterministic universe: the extraction JSONs or the code-computed report
// context (aggregates, percentages, counts, dates). A numeral with no source
// is treated as invented and BLOCKS PUBLICATION — the slot goes back to
// review, it does not reach a client document.
//
// Both sides run through the SAME tokenizer, so formatting never causes a
// false alarm: "4.590,60 €" and "4590,60" both normalize to "459060".
//
// WHAT IS HARVESTED IS A POLICY DECISION MADE BY THE CALLER, not here. §12.12c
// says "extraction DATA fields + computed context (never metadata)": harvesting
// row ids, token usage counts or ISO timestamps would smuggle unrelated digits
// into the allowed set and blunt the guard until it catches nothing.
// api/services/report-publish.ts is the one caller and states its harvest set
// explicitly.

/** Digit runs with optional internal . , separators: money, pct, dates split on "/". */
const TOKEN_RE = /\d(?:[\d.,]*\d)?/gu;

/** "4.590,60" -> "459060"; "16" -> "16". Separator-free digit identity. */
function normalize(token: string): string {
  return token.replace(/[.,]/gu, "");
}

/** Harvest every numeric token from an arbitrary JSON-serializable value. */
export function harvestNumerals(source: unknown): Set<string> {
  const out = new Set<string>();
  for (const m of JSON.stringify(source).matchAll(TOKEN_RE)) {
    out.add(normalize(m[0]));
  }
  return out;
}

export interface NumeralViolation {
  readonly slot: string;
  readonly token: string;
}

/**
 * Audit AI slot texts against the allowed numeral set.
 *
 * Returns violations instead of throwing so the caller decides the policy —
 * publish REFUSES (api/services/report-publish.ts), while a draft preview
 * shows the prose with its violations listed beside it, because a draft that
 * refused to render would hide the very text a human has to fix.
 */
export function auditSlots(
  slots: Readonly<Record<string, string>>,
  allowed: ReadonlySet<string>,
): NumeralViolation[] {
  const violations: NumeralViolation[] = [];
  for (const [slot, text] of Object.entries(slots)) {
    for (const m of text.matchAll(TOKEN_RE)) {
      const norm = normalize(m[0]);
      if (!allowed.has(norm)) {
        violations.push({ slot, token: m[0] });
      }
    }
  }
  return violations;
}
