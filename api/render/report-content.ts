// api/render/report-content.ts
//
// `reports.content_json` — the SOURCE OF TRUTH for a report (§5.1). Drafts
// render live from this plus the pinned template version; publish freezes the
// rendered HTML and this stops being what anyone reads.
//
// ONE FIELD MATTERS MOST AND IT IS `edited` (§5.2). Regeneration skips a slot
// whose prose a human has touched, and an explicit "regerar mesmo assim"
// overrides it per slot (api/services/analysis-service.ts).
//
// THE OTHER TWO FIELDS ARE FLAGS, AND THEY ARE NOT THE SAME KIND OF FACT
// (#10, §12.12c / §12.13):
//
//   `numeralFlags`  — numeric tokens the §12.12c guard could not source when
//                     the prose ARRIVED. ADVISORY ONLY. Publication recomputes
//                     the guard from the live render context
//                     (api/services/report-publish.ts) and that recomputation
//                     is the gate — a stored verdict is a claim about a
//                     context that can move under it (attach a document and
//                     the allowed set changes), so it is a badge, never an
//                     authority.
//
//   `refuted`       — claims the §12.13 analysis verifier refuted. BLOCKING,
//                     because nothing downstream can recompute it: it is a
//                     second model's reading, not a function of the data. The
//                     verifier NEVER rewrites, so the flag is a request for a
//                     person and publication waits for one.
//
// BOTH ARE CLEARED BY EDITING THE SLOT. A human who rewrites the prose has
// answered every flag that was about the prose that no longer exists — and
// without that rule a refuted claim would wedge a report shut with no way out
// that did not involve a database.
//
// Parsed rather than trusted: `content_json` is jsonb, so its shape is whatever
// was last written to it — including by a version of this code that no longer
// exists. An unreadable blob degrades to "no slots", never to a crash on a
// report someone is trying to open.

import { z } from "zod/v4";

/** One claim the verifier would not confirm (§12.13). `fundamento` is the
 * verifier's own one-sentence reason; it is evidence for a human, never a
 * correction — "the verifier NEVER rewrites a value". */
const RefutedClaimZ = z.object({
  claim: z.string(),
  fundamento: z.string().nullable(),
});

export type RefutedClaim = z.infer<typeof RefutedClaimZ>;

const SlotContentZ = z.object({
  text: z.string(),
  edited: z.boolean(),
  /** §12.12c, advisory. The numeric tokens as PRINTED, so a badge can quote
   * them back the way the reader will see them. */
  numeralFlags: z.array(z.string()).optional(),
  /** §12.13, blocking. */
  refuted: z.array(RefutedClaimZ).optional(),
  /** ISO timestamp of the verify hop that produced `refuted` — including when
   * it refuted nothing, which is the only way a screen can say "verificado"
   * rather than "não verificado". */
  verifiedAt: z.string().optional(),
});

const ReportContentZ = z.object({
  slots: z.record(z.string(), SlotContentZ).default({}),
});

export type SlotContent = z.infer<typeof SlotContentZ>;
export type ReportContent = z.infer<typeof ReportContentZ>;

export const EMPTY_CONTENT: ReportContent = { slots: {} };

export function parseReportContent(raw: unknown): ReportContent {
  const parsed = ReportContentZ.safeParse(raw);
  return parsed.success ? parsed.data : EMPTY_CONTENT;
}

/** Immutable update — a new object, so a caller cannot half-write the stored
 * one and then throw. */
export function withSlot(content: ReportContent, slug: string, slot: SlotContent): ReportContent {
  return { ...content, slots: { ...content.slots, [slug]: slot } };
}

/** The `{ slug: text }` map `renderTemplate` takes. Slots the analysis has not
 * written yet are simply absent — the render decides what an absent slot means
 * (a visible placeholder in a draft, a refusal at publish). */
export function slotTexts(content: ReportContent): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [slug, slot] of Object.entries(content.slots)) {
    out[slug] = slot.text;
  }
  return out;
}

/**
 * The slots publication must refuse (§12.13), with the verifier's reasons.
 *
 * `numeralFlags` is deliberately NOT consulted: report-publish.ts recomputes
 * that guard against the live context and refuses on the recomputation. Two
 * sources for one refusal is two messages that can disagree, and the stale one
 * would be this one.
 */
export function refutedSlots(
  content: ReportContent,
): { readonly slug: string; readonly claims: readonly RefutedClaim[] }[] {
  const out: { slug: string; claims: readonly RefutedClaim[] }[] = [];
  for (const [slug, slot] of Object.entries(content.slots)) {
    if (slot.refuted !== undefined && slot.refuted.length > 0) {
      out.push({ slug, claims: slot.refuted });
    }
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}
