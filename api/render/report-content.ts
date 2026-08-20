// api/render/report-content.ts
//
// `reports.content_json` — the SOURCE OF TRUTH for a report (§5.1). Drafts
// render live from this plus the pinned template version; publish freezes the
// rendered HTML and this stops being what anyone reads.
//
// ONE FIELD MATTERS AND IT IS `edited` (§5.2). Regeneration skips a slot whose
// prose a human has touched, and an explicit "regerar mesmo assim" overrides
// it per slot. That wiring arrives with the analysis hop (#10); the FLAG has
// to exist now, because a slot written before the flag existed is a slot the
// first regeneration silently destroys — which is the exact bug §5.2 exists to
// prevent, and it cannot be retrofitted onto prose that is already gone.
//
// Parsed rather than trusted: `content_json` is jsonb, so its shape is whatever
// was last written to it — including by a version of this code that no longer
// exists. An unreadable blob degrades to "no slots", never to a crash on a
// report someone is trying to open.

import { z } from "zod/v4";

const SlotContentZ = z.object({
  text: z.string(),
  edited: z.boolean(),
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
