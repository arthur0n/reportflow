// shared/validation/verify-schemas.ts
//
// The adversarial verify hop's wire shapes (decisions §12.13).
//
// Shared because BOTH sides read a verdict: the collector parses the model's
// answer against these, and the screen renders "verificado" / "contestado: N"
// badges off the same vocabulary. A second copy of the enum in the frontend is
// a second copy that drifts the day a fourth verdict exists.
//
// PORTED FROM poc/verify.ts, which proved these shapes over a real corpus —
// including the two things the POC had to learn the hard way and that are
// therefore load-bearing rather than decorative:
//
//   * `valor_documento` / `fundamento` record what the verifier SAW. The
//     verifier NEVER rewrites a value (§12.13, and §3's principle in reverse);
//     a `refutado` is a flag for a human, not a correction.
//   * `ilegivel` is a THIRD verdict, not a soft refutation. "The document does
//     not permit confirming or refuting" is a real answer, and folding it into
//     `refutado` would send clean documents to review over a smudge.
//
// THE ROOT IS AN OBJECT, NOT AN ARRAY, and that is a deliberate change from
// the POC. api/collector/relay-result.ts `parseModelJson` refuses a bare array
// — every consumer of a model answer addresses it by field name — so the
// verdicts ride under one key.

import { z } from "zod/v4";

export const VERDICTS = ["confirmado", "refutado", "ilegivel"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const VerdictZ = z.enum(VERDICTS);

/** One field of one extraction, judged against the PDF (§12.13, hop A). */
export const FieldVerdictZ = z.object({
  /** Path as it appears in the extraction JSON: `totais.iliquido`,
   * `itens[0].total`. Free text — the verifier walks a tree we do not pin. */
  field: z.string().min(1).max(200),
  verdict: VerdictZ,
  /** Only meaningful when `verdict === "refutado"`. */
  valor_documento: z.string().max(2000).nullable().default(null),
});
export type FieldVerdictT = z.infer<typeof FieldVerdictZ>;

/** One factual claim in one prose slot, judged against extraction data plus
 * the code-computed context (§12.13's POC amendment). */
export const ClaimVerdictZ = z.object({
  slot: z.string().min(1).max(60),
  claim: z.string().min(1).max(2000),
  verdict: VerdictZ,
  /** Only meaningful when `verdict !== "confirmado"`. */
  fundamento: z.string().max(2000).nullable().default(null),
});
export type ClaimVerdictT = z.infer<typeof ClaimVerdictZ>;

/** Bounded so a runaway verifier cannot write an unbounded jsonb column. A
 * frozen field list caps at 120 fields (§3.1) and a template at 24 slots, so
 * these are both an order of magnitude above any real answer. */
export const ExtractionVerdictsZ = z.object({
  verdicts: z.array(FieldVerdictZ).min(1).max(2000),
});
export type ExtractionVerdictsT = z.infer<typeof ExtractionVerdictsZ>;

export const AnalysisVerdictsZ = z.object({
  verdicts: z.array(ClaimVerdictZ).min(1).max(2000),
});
export type AnalysisVerdictsT = z.infer<typeof AnalysisVerdictsZ>;

/** Counts a badge can render without the caller re-walking the list. */
export interface VerdictTally {
  readonly total: number;
  readonly confirmado: number;
  readonly refutado: number;
  readonly ilegivel: number;
}

export function tallyVerdicts(verdicts: readonly { verdict: Verdict }[]): VerdictTally {
  let refutado = 0;
  let ilegivel = 0;
  for (const v of verdicts) {
    if (v.verdict === "refutado") refutado += 1;
    else if (v.verdict === "ilegivel") ilegivel += 1;
  }
  return {
    total: verdicts.length,
    confirmado: verdicts.length - refutado - ilegivel,
    refutado,
    ilegivel,
  };
}
