/**
 * Numeral guard — the hallucination tripwire for {{ai}} prose (§12.12).
 *
 * The model writes prose AROUND figures; it must never be the SOURCE of one.
 * Every numeric token in an AI slot must therefore already exist somewhere in
 * the deterministic universe: the extraction JSONs or the code-computed report
 * context (aggregates, percentages, counts, dates). A numeral with no source
 * is treated as invented and blocks the render — the slot goes back to review,
 * it does not reach a client document.
 *
 * Both sides run through the SAME tokenizer, so formatting never causes a
 * false alarm: "4.590,60 €" and "4590,60" both normalize to "459060".
 */

/** Digit runs with optional internal . , separators: money, pct, dates split on "/". */
const TOKEN_RE = /\d(?:[\d.,]*\d)?/g;

/** "4.590,60" -> "459060"; "16" -> "16". Separator-free digit identity. */
function normalize(token: string): string {
  return token.replace(/[.,]/g, "");
}

/** Harvest every numeric token from an arbitrary JSON-serializable value. */
export function harvestNumerals(source: unknown): Set<string> {
  const out = new Set<string>();
  for (const m of JSON.stringify(source).matchAll(TOKEN_RE)) out.add(normalize(m[0]));
  return out;
}

export interface NumeralViolation {
  slot: string;
  token: string;
}

/**
 * Audit AI slot texts against the allowed numeral set.
 * Returns violations instead of throwing so the caller decides the policy
 * (POC: fail the render; pipeline: flag the slot "não publicável").
 */
export function auditSlots(
  slots: Record<string, string>,
  allowed: Set<string>,
): NumeralViolation[] {
  const violations: NumeralViolation[] = [];
  for (const [slot, text] of Object.entries(slots)) {
    for (const m of text.matchAll(TOKEN_RE)) {
      const norm = normalize(m[0]);
      if (!allowed.has(norm)) violations.push({ slot, token: m[0] });
    }
  }
  return violations;
}
