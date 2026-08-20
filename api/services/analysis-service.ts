// api/services/analysis-service.ts
//
// Hop 2's orchestration (decisions §4, §5.2, §12.12b), behind
// `reports.startAnalysis`. Same split as extraction-service.ts: every DB and
// S3 touch lives here so it can be unit-tested against a fake handle, the job
// PAYLOAD is built next door in api/analysis/analyse-job.ts, and the ANSWER is
// merged by api/collector/collect.ts — because that is where the one
// idempotency lives (§4.1).
//
// FOUR RULES.
//
// 1. EVERY REQUIRED ROLE MUST BE FILLED (§3.2). "aguardando: contrato" is a
//    showable waiting state, not an error, everywhere else in this codebase —
//    but a REQUEST to spend money on prose about documents that are not there
//    is a refusal, because the model would happily write it.
//
// 2. AN EDITED SLOT IS NOT REGENERATED (§5.2). "Silently destroying
//    human-written prose on a regen is the kind of bug that loses a client."
//    The default set is therefore every declared slot that is NOT `edited`;
//    naming slugs explicitly is the "regerar mesmo assim" override, and it is
//    per slot because that is what §5.2 says.
//
// 3. THE MODEL IS HANDED THE FIGURES, NEVER ASKED FOR THEM (§12.12b). The
//    context comes from `reportContextOf` — the same object publish renders
//    from and the same object the §12.13 verifier is shown.
//
// 4. ONE JOB FILLS EVERY PENDING SLOT. §9 puts per-section fan-out explicitly
//    out of v1, and N calls would let two sections disagree about the
//    documents they are both describing.
//
// ON DOUBLE-CLICKS AND DOUBLE CHARGES. There is no partial unique index for
// pending `analyse` jobs the way there is for `extract`
// (`report_jobs_pending_extract_idx`), so the in-flight check below is a fast
// path and not a guarantee — two concurrent calls can both enqueue. What makes
// that not a billing bug is §12.6 itself: both jobs carry the SAME
// `report_analysis:{provider}:{model}:{templateVersionId}:{extractionIds}`
// ref_id, `ai_charges.ref_id` is UNIQUE, and the second charge is a no-op. The
// platform eats one duplicate provider call; the customer is billed once. An
// index would be the stronger fix and it needs a migration.

import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { reportJobs } from "../../drizzle/schema";
import {
  buildAnalysisJob,
  REPORT_ANALYSIS_PURPOSE,
  type AnalysisContext,
} from "../analysis/analyse-job";
import type { DbLike } from "../collector/job-state";
import { withSystemFields } from "../db/scope";
import { jobKeyFor, mintJobId } from "../lib/relay";
import { keyBinding, resolveModel } from "./credentials-service";
import {
  extractionIdsOf,
  loadReportBundle,
  reportContextOf,
  type ReportBundle,
} from "./report-service";
import type { SlotDeclarationT } from "../../shared/validation/outbound-schemas";
import type { StartAnalysisInputT } from "../../shared/validation/report-schemas";

export interface AnalysisDeps {
  readonly db: DbLike;
  readonly enqueue: (
    tenantId: string,
    jobId: string,
    payload: Record<string, unknown>,
  ) => Promise<void>;
}

export interface AnalysisCtx {
  readonly tenantId: string;
  readonly userId: string;
}

/**
 * §5.2's selection, made explicit rather than implied.
 *
 * `slugs` empty/absent  → every declared slot that is not `edited`.
 * `slugs` named         → exactly those, edited or not. THAT IS THE OVERRIDE:
 *                         naming a slot IS "regerar mesmo assim", which is why
 *                         there is no separate boolean for it. A flag that can
 *                         be set independently of the slug list is a flag that
 *                         can be set for slots the caller did not look at.
 *
 * Returns the declarations (not just the slugs) because the job needs the
 * guideline and the word budget, and `forced` separately because the collector
 * has to re-apply the same decision when the answer lands ~30s later, against
 * a draft a human may have edited in between.
 */
export function selectSlots(
  bundle: ReportBundle,
  requested: readonly string[] | undefined,
): { readonly slots: readonly SlotDeclarationT[]; readonly forced: readonly string[] } {
  if (requested === undefined || requested.length === 0) {
    const slots = bundle.slots.filter((slot) => bundle.content.slots[slot.slug]?.edited !== true);
    return { slots, forced: [] };
  }
  const wanted = new Set(requested);
  const slots = bundle.slots.filter((slot) => wanted.has(slot.slug));
  const forced = slots
    .filter((slot) => bundle.content.slots[slot.slug]?.edited === true)
    .map((slot) => slot.slug);
  return { slots, forced };
}

/** An analyse job already in flight for this report. A FAST PATH — see the
 * header on why it is not the guarantee, and why that is affordable here. */
async function loadPendingAnalyseJob(
  dbHandle: DbLike,
  tenantId: string,
  reportId: string,
): Promise<{ readonly id: string } | undefined> {
  const rows = await dbHandle
    .select({ id: reportJobs.id })
    .from(reportJobs)
    .where(
      and(
        eq(reportJobs.tenantId, tenantId),
        eq(reportJobs.reportId, reportId),
        eq(reportJobs.kind, "analyse"),
        eq(reportJobs.status, "pending"),
      ),
    )
    .limit(1);
  return rows[0];
}

export interface StartAnalysisOutcome {
  /** `report_jobs.id` — poll it with the same `jobs.poll` every other hop
   * uses. */
  readonly jobId: string;
  /** The slugs this job was asked to fill, so the screen can say so. */
  readonly slugs: readonly string[];
  /** The subset that overrode §5.2's edited guard. */
  readonly forced: readonly string[];
}

/**
 * Enqueues hop 2 for one report.
 *
 * ORDER IS THE SAME AS EVERY OTHER ENQUEUE PATH: the `report_jobs` row is
 * committed BEFORE the S3 PutObject (api/collector/collect.ts's requirement),
 * so a fast relay cannot produce a result for a row nobody can see yet.
 */
export async function startAnalysis(
  deps: AnalysisDeps,
  ctx: AnalysisCtx,
  input: StartAnalysisInputT,
): Promise<StartAnalysisOutcome> {
  const bundle = await loadReportBundle(deps.db, ctx.tenantId, input.reportId);
  if (bundle.report.frozenAt !== null) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "Este relatório já foi publicado e não pode mais ser alterado.",
    });
  }

  // §3.2's gate. The context is built FIRST because it is also the answer to
  // "which roles are missing" — one computation, not a second opinion.
  const built = reportContextOf(bundle);
  if (built.missingRequiredRoles.length > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Aguardando documento para: ${built.missingRequiredRoles.join(", ")}.`,
    });
  }

  if (bundle.slots.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Este modelo não declara nenhum slot de prosa.",
    });
  }

  const requested = input.slugs;
  if (requested !== undefined && requested.length > 0) {
    const declared = new Set(bundle.slots.map((s) => s.slug));
    const unknown = requested.filter((slug) => !declared.has(slug));
    if (unknown.length > 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Slot inexistente nesta versão do modelo: ${unknown.join(", ")}.`,
      });
    }
  }

  const { slots, forced } = selectSlots(bundle, requested);
  if (slots.length === 0) {
    // Every slot is edited and none was named. Refusing is the honest answer:
    // the alternative is a paid hop whose entire result the §5.2 guard would
    // then discard.
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Todos os slots foram editados por uma pessoa. Escolha explicitamente quais regerar " +
        '("regerar mesmo assim").',
    });
  }

  const pending = await loadPendingAnalyseJob(deps.db, ctx.tenantId, input.reportId);
  if (pending !== undefined) {
    return { jobId: pending.id, slugs: slots.map((s) => s.slug), forced };
  }

  // Refuses BEFORE the money is spent when the resolved model has no price
  // (§7, §10.5) — see api/services/credentials-service.ts.
  const resolved = await resolveModel(deps.db, ctx.tenantId, "analyse");

  const payload = buildAnalysisJob({
    tenantId: ctx.tenantId,
    reportId: input.reportId,
    templateVersionId: bundle.version.id,
    slots,
    forced,
    context: built.context,
    extractionIds: extractionIdsOf(bundle),
    provider: resolved.provider,
    model: resolved.model,
    ...keyBinding(resolved),
  });

  const jobId = mintJobId();
  const inserted = await deps.db
    .insert(reportJobs)
    .values(
      withSystemFields({ userId: ctx.userId }, "create", {
        tenantId: ctx.tenantId,
        kind: "analyse",
        status: "pending",
        s3Key: jobKeyFor(ctx.tenantId, jobId),
        attempt: 1,
        request: payload,
        reportId: input.reportId,
      }),
    )
    .returning({ id: reportJobs.id });
  const row = inserted[0];
  if (row === undefined) {
    throw new Error("startAnalysis: report_jobs insert returned no row");
  }

  await deps.enqueue(ctx.tenantId, jobId, payload);

  return { jobId: row.id, slugs: slots.map((s) => s.slug), forced };
}

/** Re-export so the collector and the tests import the context shape from one
 * place rather than reaching past this service into the job builder. */
export type { AnalysisContext };
export { REPORT_ANALYSIS_PURPOSE };
