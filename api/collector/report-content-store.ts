// api/collector/report-content-store.ts
//
// THE COLLECTOR'S WRITE INTO A DRAFT — the analysis hop's prose (§5.2) and the
// verify hop's verdicts (§12.13). Sibling of extraction-store.ts, and split out
// for the same reason: collect.ts decides a job's FATE, and the SQL that makes
// a decision durable belongs beside the other SQL, where it can be tested
// without a state machine in the way.
//
// ── THE RACE THIS FILE EXISTS TO LOSE SAFELY ────────────────────────────────
//
// Between the moment the button is pressed and the moment the answer lands,
// ~60 seconds pass and A HUMAN IS EDITING THE DRAFT. There are two windows,
// and they need different instruments:
//
//   ENQUEUE → COLLECT (~60s). Handled by re-reading the draft here and
//   re-applying §5.2 against it. The job's own `forced` list says which slots
//   the human explicitly authorised overwriting.
//
//   LOAD → SAVE (~1ms, but real). THIS is what the first cut got wrong. It
//   read `content_json`, merged in memory, and wrote the WHOLE document back —
//   so a `updateSlot` committing in that millisecond was silently overwritten
//   by a snapshot that predated it. Exactly the §5.2 bug ("silently destroying
//   human-written prose on a regen is the kind of bug that loses a client"),
//   just with a smaller window.
//
// ── HOW THE SECOND WINDOW IS CLOSED, AND WHY THIS WAY ───────────────────────
//
// Both writes are now a SINGLE `UPDATE` whose new `content_json` is a nested
// `jsonb_set` chain, with a per-slot `CASE` guard that reads THE ROW'S OWN
// CURRENT VALUE. Postgres evaluates the guard against the row as it is at write
// time, so a concurrent edit's state decides — not the snapshot this function
// loaded. Slots that were not touched are never rewritten at all, so there is
// no whole-document clobber left to lose.
//
// The alternative considered was an optimistic `content_rev` column with a
// bounded retry. Rejected on three counts: it needs a migration and a column
// every future content writer must remember to bump (a rule you can forget is
// not a guarantee); a retry loop has its own terminal case, so sustained
// editing turns a merge into a `failed` job; and it would still write the whole
// document, so the guarantee would rest on the discipline of every writer
// rather than on the statement itself. The `jsonb_set` form needs no schema
// change, no retry, and cannot regress by omission — a slot that is not in the
// statement is a slot that is not touched. `DbLike` is unchanged: both a pool
// and a transaction handle take a `sql` template.
//
// EVERY SLUG REACHING SQL IS A BOUND PARAMETER, never interpolated — and it is
// re-checked against `IDENTIFIER_RE` first anyway, because it arrived on a
// jsonb payload and a value that has been through an untrusted round trip gets
// checked at the boundary it crosses, not at the one it came from.
//
// AND THE OUTCOME IS READ BACK FROM WHAT POSTGRES STORED (`RETURNING`), never
// asserted from what this function intended. If the guard refused a slot, the
// report says `preserved` — it cannot claim to have written prose that is not
// there.

import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { reports } from "../../drizzle/schema";
import { auditSlots, harvestNumerals } from "../render/numeral-guard";
import { parseReportContent, type ReportContent, type SlotContent } from "../render/report-content";
import { loadReportBundle, reportContextOf, type ReportBundle } from "../services/report-service";
import { slotAnswerProblem, type AnalysisContext } from "../analysis/analyse-job";
import { slotTextHash } from "../analysis/verify-job";
import { IDENTIFIER_RE } from "../../shared/validation/outbound-schemas";
import type { ClaimVerdictT } from "../../shared/validation/verify-schemas";
import type { DbLike } from "./job-state";

/**
 * The `report_jobs.error` written when a draft moved to another template
 * version while its prose was in flight (§5.3).
 *
 * A CONSTANT for the same reason `RECALIBRATED_DURING_EXTRACTION` is one: the
 * collector writes it and the report screen reads it back to know that THIS
 * failure is repaired by pressing the button again, not by typing.
 */
export const ANALYSIS_STALE_VERSION = "modelo atualizado durante a análise; gere novamente";

/** Written to `report_jobs.error` when every judged slot had already been
 * rewritten by the time the verdicts landed. */
export const VERDICT_OBSOLETE = "veredicto obsoleto — texto editado";

export type ContentWriteOutcome =
  | {
      readonly ok: true;
      /** Slugs POSTGRES actually stored — read back from `RETURNING`. */
      readonly merged: readonly string[];
      /** Slugs the row's own state refused: a human had edited them and they
       * were not explicitly forced (§5.2). */
      readonly preserved: readonly string[];
      /** Slugs the model answered UNUSABLY — too short, HTML, over budget
       * (api/analysis/analyse-job.ts `slotAnswerProblem`). Reported rather
       * than thrown: four good sections are four good sections. */
      readonly rejected: readonly string[];
      /** §12.13 only: slugs whose text had changed since the verifier saw it,
       * so the verdict was DISCARDED rather than attached to prose nobody
       * judged. */
      readonly obsolete: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

/** Loads the draft, or says why it cannot be written to. `loadReportBundle`
 * throws a TRPCError for a report that is gone or whose version is gone —
 * ordinary facts here, not faults, so they are caught and reported. */
async function loadWritableDraft(
  dbHandle: DbLike,
  tenantId: string,
  reportId: string,
  templateVersionId: string,
): Promise<{ readonly bundle: ReportBundle } | { readonly reason: string }> {
  let bundle: ReportBundle;
  try {
    bundle = await loadReportBundle(dbHandle, tenantId, reportId);
  } catch {
    return { reason: "relatório não encontrado para este resultado" };
  }
  if (bundle.report.frozenAt !== null) {
    return { reason: "relatório publicado durante a etapa; resultado descartado" };
  }
  if (bundle.version.id !== templateVersionId) {
    return { reason: ANALYSIS_STALE_VERSION };
  }
  return { bundle };
}

// ---------------------------------------------------------------------------
// The one write shape both hops use
// ---------------------------------------------------------------------------

/** One slot to store, and the condition under which the ROW may be overwritten
 * for it. `guard: null` means unconditional — the human explicitly asked. */
interface GuardedSlot {
  readonly slug: string;
  readonly slot: SlotContent;
  readonly guard: SQL | null;
}

/** `content_json` with a `slots` object guaranteed to exist, so the per-slot
 * `jsonb_set` calls below have somewhere to write. */
function slotsBase(): SQL {
  return sql`jsonb_set(coalesce(${reports.contentJson}, '{}'::jsonb), array['slots']::text[], coalesce(${reports.contentJson} -> 'slots', '{}'::jsonb), true)`;
}

/**
 * Folds the guarded slots into one nested `jsonb_set` expression.
 *
 * The guard reads `reports.content_json` — the ROW, not the accumulator — on
 * purpose: each slot's decision is about the state this statement STARTED
 * from, and no slot's outcome may depend on another slot in the same batch.
 */
function contentExpression(slots: readonly GuardedSlot[]): SQL {
  let expr = slotsBase();
  for (const { slug, slot, guard } of slots) {
    const next = sql`${JSON.stringify(slot)}::jsonb`;
    // Never NULL: `jsonb_set` with a null new value nulls the WHOLE document.
    const keep = sql`coalesce(${slotAt(slug)}, ${next})`;
    const value = guard === null ? next : sql`case when ${guard} then ${next} else ${keep} end`;
    expr = sql`jsonb_set(${expr}, array['slots', ${slug}::text]::text[], ${value}, true)`;
  }
  return expr;
}

/**
 * `content_json -> 'slots' -> :slug`, with the slug CAST.
 *
 * The cast is load-bearing, not decoration: `jsonb -> ?` has two candidate
 * operators (`-> text` and `-> integer`) and node-postgres sends parameters
 * untyped, so an uncast placeholder is an "operator is not unique" error at
 * runtime — on a statement that only ever runs in the collector, i.e. the one
 * place nobody is watching.
 */
function slotAt(slug: string): SQL {
  return sql`${reports.contentJson} -> 'slots' -> ${slug}::text`;
}

/**
 * Runs the statement and hands back WHAT WAS STORED.
 *
 * `frozen_at IS NULL` is in the WHERE clause, not merely checked upstream: a
 * publish landing between the load and this must win, because its artifact is
 * already in S3 and a client may already have it (§5.1).
 */
async function writeSlots(
  dbHandle: DbLike,
  tenantId: string,
  reportId: string,
  slots: readonly GuardedSlot[],
): Promise<ReportContent | null> {
  const rows = await dbHandle
    .update(reports)
    .set({ contentJson: contentExpression(slots), lastUpdAt: new Date().toISOString() })
    .where(and(eq(reports.id, reportId), eq(reports.tenantId, tenantId), isNull(reports.frozenAt)))
    .returning({ contentJson: reports.contentJson });
  const row = rows[0];
  return row === undefined ? null : parseReportContent(row.contentJson);
}

/** A slug that reached us on a jsonb payload. Bound as a parameter either way;
 * this is the boundary check, not the injection defence. */
function isSlug(slug: string): boolean {
  return IDENTIFIER_RE.test(slug);
}

const NOT_WRITTEN = "relatório publicado durante a etapa; resultado descartado";

// ---------------------------------------------------------------------------
// analyse → prose
// ---------------------------------------------------------------------------

/**
 * Merge one analyse answer into a draft.
 *
 * THE NUMERAL GUARD RUNS ON ARRIVAL AND DOES NOT HARD-FAIL (§12.12c, decided
 * in #10). A slot whose prose contains a numeral with no deterministic source
 * is STORED, with the offending tokens flagged on it. Three reasons, in order
 * of how much they matter:
 *
 *   1. PUBLICATION IS ALREADY THE HARD GATE. report-publish.ts recomputes the
 *      guard against the live render context and refuses — so nothing
 *      unsourced can reach a client document either way, and that recomputation
 *      is the authoritative one because the allowed set MOVES (attach another
 *      invoice and yesterday's violation is today's fact).
 *   2. FAILING THE JOB WOULD HIDE THE EVIDENCE. §4.2 already made this call for
 *      the sibling case: a `failed` analyse throws away four good slots to
 *      punish the fifth, and the human is left with a red badge and nothing to
 *      read. The prose a person has to fix must be on the screen.
 *   3. IT WOULD SPEND §4.2's RETRY ON A NON-TRANSIENT FAULT. A model that
 *      invented a figure will invent one again.
 *
 * §5.2 IS ENFORCED BY THE STATEMENT, NOT BY THE SNAPSHOT. Each non-forced slot
 * carries `... ->> 'edited' IS DISTINCT FROM 'true'`, evaluated by Postgres
 * against the row at write time — so an edit committed one millisecond ago
 * wins, and this function learns it lost from what `RETURNING` gives back.
 */
export async function mergeAnalysisSlots(
  dbHandle: DbLike,
  tenantId: string,
  context: AnalysisContext,
  answers: Readonly<Record<string, string>>,
): Promise<ContentWriteOutcome> {
  const loaded = await loadWritableDraft(
    dbHandle,
    tenantId,
    context.reportId,
    context.templateVersionId,
  );
  if (!("bundle" in loaded)) {
    return { ok: false, reason: loaded.reason };
  }
  const { bundle } = loaded;

  const allowed = harvestNumerals(reportContextOf(bundle).context);
  const forced = new Set(context.forced);
  const declarations = new Map(bundle.slots.map((s) => [s.slug, s]));

  const candidates: GuardedSlot[] = [];
  const rejected: string[] = [];

  for (const slug of context.slugs) {
    // A model that returns a slug nobody asked for does not get to create one,
    // and a slug the CURRENT version no longer declares is not written back.
    const declaration = declarations.get(slug);
    if (declaration === undefined || !isSlug(slug)) {
      continue;
    }
    const text = answers[slug];
    if (typeof text !== "string" || text.trim().length === 0) {
      continue;
    }
    if (slotAnswerProblem(declaration, text) !== null) {
      rejected.push(slug);
      continue;
    }
    const violations = auditSlots({ [slug]: text }, allowed).map((v) => v.token);
    candidates.push({
      slug,
      slot: {
        text,
        edited: false,
        // Absent, not empty: a clean slot should carry no key at all, so a
        // reader cannot mistake `[]` for "checked and found nothing" on a slot
        // written before the guard ran here.
        ...(violations.length > 0 ? { numeralFlags: violations } : {}),
        // Any verdict on file was about prose that no longer exists (§12.13),
        // and rebuilding the slot rather than spreading the old one is what
        // retires it.
      },
      // §5.2, decided by the ROW. A slot the caller explicitly forced
      // ("regerar mesmo assim") carries no guard — that is what forcing means.
      guard: forced.has(slug) ? null : sql`(${slotAt(slug)} ->> 'edited') is distinct from 'true'`,
    });
  }

  if (candidates.length === 0) {
    // Nothing to write — the answer was empty or unusable. Not a failure of the
    // WRITE; collect.ts decides what an all-rejected answer means for the job.
    return { ok: true, merged: [], preserved: [], rejected, obsolete: [] };
  }

  const stored = await writeSlots(dbHandle, tenantId, context.reportId, candidates);
  if (stored === null) {
    return { ok: false, reason: NOT_WRITTEN };
  }

  const merged: string[] = [];
  const preserved: string[] = [];
  for (const candidate of candidates) {
    // WHAT POSTGRES STORED decides the report, so a refused guard cannot be
    // reported as a successful merge.
    if (stored.slots[candidate.slug]?.text === candidate.slot.text) {
      merged.push(candidate.slug);
    } else {
      preserved.push(candidate.slug);
    }
  }
  return { ok: true, merged, preserved, rejected, obsolete: [] };
}

// ---------------------------------------------------------------------------
// verify → verdicts
// ---------------------------------------------------------------------------

export interface AnalysisVerdictTarget {
  readonly reportId: string;
  readonly templateVersionId: string;
  /** `{ slug: sha256hex }` of the prose the verifier was actually shown
   * (api/analysis/verify-job.ts `slotTextHash`). */
  readonly textHashes: Readonly<Record<string, string>>;
}

/**
 * Write the §12.13 verdicts onto the slots they judged.
 *
 * A VERDICT IS BOUND TO THE TEXT IT JUDGED. The job carries a sha256 of each
 * slot's prose as it was sent; a slot whose current text does not hash to it
 * has been rewritten since, so the verdict is DISCARDED — not attached, not
 * even as a clean `verifiedAt`. Attaching it would block a publication over a
 * finding about words that no longer exist, and the reason on screen would
 * match nothing the reader can find. `obsolete` reports which, and re-verifying
 * is the fix.
 *
 * The same text is then the WRITE guard, so the load → save window is closed by
 * the statement rather than by hope: `... ->> 'text' IS NOT DISTINCT FROM $judged`.
 * A human who saves during that millisecond keeps their prose and their slot
 * simply reports as obsolete.
 *
 * ONLY `refutado` IS STORED, and `verifiedAt` is stamped on every slot that
 * still matches — whether or not anything was refuted — because "verified,
 * clean" and "never verified" are different facts and a badge that cannot tell
 * them apart says nothing. `ilegivel` is deliberately not stored: it means the
 * verifier could not decide, which is not a finding against the prose and must
 * not block a publication.
 *
 * THE VERIFIER NEVER REWRITES. Nothing here touches a slot's text.
 */
export async function applyAnalysisVerdicts(
  dbHandle: DbLike,
  tenantId: string,
  target: AnalysisVerdictTarget,
  verdicts: readonly ClaimVerdictT[],
): Promise<ContentWriteOutcome> {
  const loaded = await loadWritableDraft(
    dbHandle,
    tenantId,
    target.reportId,
    target.templateVersionId,
  );
  if (!("bundle" in loaded)) {
    return { ok: false, reason: loaded.reason };
  }
  const { bundle } = loaded;

  const verifiedAt = new Date().toISOString();
  const candidates: GuardedSlot[] = [];
  const obsolete: string[] = [];
  const flagged: string[] = [];

  for (const [slug, judgedHash] of Object.entries(target.textHashes)) {
    const existing = bundle.content.slots[slug];
    if (existing === undefined || !isSlug(slug)) {
      continue;
    }
    if (slotTextHash(existing.text) !== judgedHash) {
      console.warn(`[collector] ${VERDICT_OBSOLETE}`, { reportId: target.reportId, slug });
      obsolete.push(slug);
      continue;
    }
    const refuted = verdicts
      .filter((v) => v.slot === slug && v.verdict === "refutado")
      .map((v) => ({ claim: v.claim, fundamento: v.fundamento }));
    candidates.push({
      slug,
      // REBUILT, not spread over. A second pass that confirms what the first
      // refuted must CLEAR the flag — spreading the stored slot would carry a
      // withdrawn finding through and leave the report blocked on it.
      slot: {
        text: existing.text,
        edited: existing.edited,
        ...(existing.numeralFlags === undefined ? {} : { numeralFlags: existing.numeralFlags }),
        ...(refuted.length > 0 ? { refuted } : {}),
        verifiedAt,
      },
      // The load → save window, closed by the row's own text.
      guard: sql`(${slotAt(slug)} ->> 'text') is not distinct from ${existing.text}::text`,
    });
    if (refuted.length > 0) {
      flagged.push(slug);
    }
  }

  if (candidates.length === 0) {
    return { ok: true, merged: [], preserved: [], rejected: [], obsolete };
  }

  const stored = await writeSlots(dbHandle, tenantId, target.reportId, candidates);
  if (stored === null) {
    return { ok: false, reason: NOT_WRITTEN };
  }

  // A slot the guard refused between load and save is obsolete for the same
  // reason a hash mismatch is: somebody rewrote the prose that was judged.
  const merged: string[] = [];
  const lost: string[] = [];
  for (const candidate of candidates) {
    if (stored.slots[candidate.slug]?.verifiedAt === verifiedAt) {
      if (flagged.includes(candidate.slug)) {
        merged.push(candidate.slug);
      }
    } else {
      lost.push(candidate.slug);
    }
  }
  return { ok: true, merged, preserved: [], rejected: [], obsolete: [...obsolete, ...lost] };
}
