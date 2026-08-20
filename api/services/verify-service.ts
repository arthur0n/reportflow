// api/services/verify-service.ts
//
// Hop 3's orchestration — the ADVERSARIAL VERIFY (decisions §12.13), behind
// `extractions.verify` and `reports.verify`. Same split as
// analysis-service.ts: this file reads rows and enqueues, the PAYLOAD is built
// in api/analysis/verify-job.ts, and the verdicts are persisted by
// api/collector/collect.ts.
//
// THE POLICY, and it is the whole hop: THE VERIFIER NEVER REWRITES. A
// `refutado` verdict is a flag for a human, not a correction — §3's principle
// in reverse, and the reason no code path here or in the collector ever
// touches `extractions.data` or a slot's text on the strength of a verdict. A
// human resolves disagreements.
//
// WHAT IS STORED AND WHERE, kept as small as the design allows:
//
//   extraction verify → `report_jobs.result`, verbatim. NOTHING is written to
//                       the `extractions` row. There is no verdict column and
//                       there deliberately is not one: a verdict is a claim
//                       about the payload as it stood, `correctExtraction`
//                       replaces that payload, and a stale verdict on a
//                       repaired extraction is worse than no verdict at all.
//                       The screen reads the latest verify job for the
//                       document and renders a badge.
//   analysis verify   → the same verbatim result, PLUS the refuted claims
//                       written into `content_json` per slot, because that is
//                       the one verdict publication has to be able to refuse
//                       on (api/services/report-publish.ts) and re-deriving it
//                       from a job row at publish time would be a second
//                       reader of an untrusted blob.
//
// THE VERIFIER IS A DIFFERENT MODEL BY CONSTRUCTION, resolved through
// `resolveModel(…, "verify")`. Today that is a heavier tier of the same family
// (only a Google key exists); the day a second provider key is configured it
// is a one-line change in PLATFORM_DEFAULTS. See
// api/services/credentials-service.ts on why an account-level model override
// deliberately does not reach this hop.

import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  documentTypes,
  documents,
  extractTemplates,
  extractions,
  providers,
  reportJobs,
} from "../../drizzle/schema";
import { buildAnalysisVerifyJob, buildExtractionVerifyJob } from "../analysis/verify-job";
import { loadTemplateFields } from "../collector/extraction-store";
import type { DbLike, JobRow } from "../collector/job-state";
import { withSystemFields } from "../db/scope";
import { jobKeyFor, mintJobId } from "../lib/relay";
import { parseModelJson } from "../collector/relay-result";
import { slotTexts } from "../render/report-content";
import { keyBinding, resolveModel } from "./credentials-service";
import { extractionIdsOf, loadReportBundle, reportContextOf } from "./report-service";
import {
  AnalysisVerdictsZ,
  ExtractionVerdictsZ,
  tallyVerdicts,
  type ClaimVerdictT,
  type FieldVerdictT,
  type VerdictTally,
} from "../../shared/validation/verify-schemas";
import type { StartVerifyInputT } from "../../shared/validation/report-schemas";

export interface VerifyDeps {
  readonly db: DbLike;
  readonly enqueue: (
    tenantId: string,
    jobId: string,
    payload: Record<string, unknown>,
  ) => Promise<void>;
}

export interface VerifyCtx {
  readonly tenantId: string;
  readonly userId: string;
}

export interface StartVerifyOutcome {
  readonly jobId: string;
  readonly target: "extraction" | "analysis";
}

/** An in-flight verify job for the same subject. A fast path, and — as with
 * `analyse` — the actual double-charge guard is §12.6's ref_id, which both
 * racers compute identically. */
async function loadPendingVerifyJob(
  dbHandle: DbLike,
  tenantId: string,
  column: "documentId" | "reportId",
  id: string,
): Promise<{ readonly id: string } | undefined> {
  const rows = await dbHandle
    .select({ id: reportJobs.id })
    .from(reportJobs)
    .where(
      and(
        eq(reportJobs.tenantId, tenantId),
        eq(column === "documentId" ? reportJobs.documentId : reportJobs.reportId, id),
        eq(reportJobs.kind, "verify"),
        eq(reportJobs.status, "pending"),
      ),
    )
    .limit(1);
  return rows[0];
}

async function insertVerifyJob(
  deps: VerifyDeps,
  ctx: VerifyCtx,
  payload: Record<string, unknown>,
  back: { documentId?: string; reportId?: string },
): Promise<string> {
  const jobId = mintJobId();
  const inserted = await deps.db
    .insert(reportJobs)
    .values(
      withSystemFields({ userId: ctx.userId }, "create", {
        tenantId: ctx.tenantId,
        kind: "verify",
        status: "pending",
        s3Key: jobKeyFor(ctx.tenantId, jobId),
        attempt: 1,
        request: payload,
        documentId: back.documentId ?? null,
        reportId: back.reportId ?? null,
      }),
    )
    .returning({ id: reportJobs.id });
  const row = inserted[0];
  if (row === undefined) {
    throw new Error("startVerify: report_jobs insert returned no row");
  }
  // Row first, THEN the outbox object — api/collector/collect.ts's requirement
  // on every enqueue path.
  await deps.enqueue(ctx.tenantId, jobId, payload);
  return row.id;
}

// ---------------------------------------------------------------------------
// Extraction verify — PDF + extraction JSON + the frozen field list
// ---------------------------------------------------------------------------

async function startExtractionVerify(
  deps: VerifyDeps,
  ctx: VerifyCtx,
  extractionId: string,
): Promise<StartVerifyOutcome> {
  const rows = await deps.db
    .select({
      extractionId: extractions.id,
      data: extractions.data,
      s3Key: extractions.s3Key,
      calibrationRev: extractions.calibrationRev,
      extractTemplateId: extractions.extractTemplateId,
      documentId: documents.id,
      providerName: providers.name,
      typeName: documentTypes.name,
    })
    .from(extractions)
    .innerJoin(documents, eq(documents.id, extractions.documentId))
    .leftJoin(extractTemplates, eq(extractTemplates.id, extractions.extractTemplateId))
    .leftJoin(documentTypes, eq(documentTypes.id, extractTemplates.documentTypeId))
    .leftJoin(providers, eq(providers.id, documentTypes.providerId))
    .where(
      and(
        eq(extractions.id, extractionId),
        eq(extractions.tenantId, ctx.tenantId),
        isNull(documents.deletedAt),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Extração não encontrada." });
  }

  const pending = await loadPendingVerifyJob(deps.db, ctx.tenantId, "documentId", row.documentId);
  if (pending !== undefined) {
    return { jobId: pending.id, target: "extraction" };
  }

  // §12.13: the verifier is handed the SAME frozen list the extractor was
  // calibrated against. Not a leash on the adversary — several fields are
  // MANDATED to be normalised or paraphrased, and a verifier that has not seen
  // the spec reports every one of them as a discrepancy.
  const fields = await loadTemplateFields(deps.db, ctx.tenantId, row.extractTemplateId);
  if (fields.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "O template desta extração não tem campos congelados para verificar.",
    });
  }

  const resolved = await resolveModel(deps.db, ctx.tenantId, "verify");
  const payload = buildExtractionVerifyJob({
    tenantId: ctx.tenantId,
    extractionId: row.extractionId,
    documentId: row.documentId,
    s3Key: row.s3Key,
    calibrationRev: row.calibrationRev,
    fields,
    data: row.data,
    providerName: row.providerName ?? undefined,
    documentTypeName: row.typeName ?? undefined,
    provider: resolved.provider,
    model: resolved.model,
    ...keyBinding(resolved),
  });

  const jobId = await insertVerifyJob(deps, ctx, payload, { documentId: row.documentId });
  return { jobId, target: "extraction" };
}

// ---------------------------------------------------------------------------
// Analysis verify — slot texts + extraction data + the COMPUTED context
// ---------------------------------------------------------------------------

async function startAnalysisVerify(
  deps: VerifyDeps,
  ctx: VerifyCtx,
  reportId: string,
): Promise<StartVerifyOutcome> {
  const bundle = await loadReportBundle(deps.db, ctx.tenantId, reportId);

  const texts = slotTexts(bundle.content);
  const auditable: Record<string, string> = {};
  for (const slot of bundle.slots) {
    const text = texts[slot.slug] ?? "";
    if (text.trim().length > 0) {
      auditable[slot.slug] = text;
    }
  }
  if (Object.keys(auditable).length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Não há prosa para verificar. Gere a análise primeiro.",
    });
  }

  const pending = await loadPendingVerifyJob(deps.db, ctx.tenantId, "reportId", reportId);
  if (pending !== undefined) {
    return { jobId: pending.id, target: "analysis" };
  }

  // §12.13's own amendment, learned from the POC run: the verifier gets the
  // extraction data AND the code-computed context, because the writer wrote
  // from both. Withholding the second makes it refute accurate claims it was
  // simply never shown.
  const built = reportContextOf(bundle);
  const extractionData: Record<string, unknown> = {};
  for (const role of bundle.roles) {
    extractionData[role.key] = (bundle.attached.get(role.key) ?? []).map((a) => a.data);
  }

  const resolved = await resolveModel(deps.db, ctx.tenantId, "verify");
  const payload = buildAnalysisVerifyJob({
    tenantId: ctx.tenantId,
    reportId,
    templateVersionId: bundle.version.id,
    extractionIds: extractionIdsOf(bundle),
    slots: bundle.slots,
    texts: auditable,
    extractionData,
    computedContext: built.context,
    provider: resolved.provider,
    model: resolved.model,
    ...keyBinding(resolved),
  });

  const jobId = await insertVerifyJob(deps, ctx, payload, { reportId });
  return { jobId, target: "analysis" };
}

/** One entry point, two hops (§12.13). */
export async function startVerify(
  deps: VerifyDeps,
  ctx: VerifyCtx,
  input: StartVerifyInputT,
): Promise<StartVerifyOutcome> {
  return input.target === "extraction"
    ? startExtractionVerify(deps, ctx, input.extractionId)
    : startAnalysisVerify(deps, ctx, input.reportId);
}

// ---------------------------------------------------------------------------
// Reading verdicts back — the badges, and nothing more (§12.13, "UI minimal")
// ---------------------------------------------------------------------------

/** The relay envelope's `content`, dug out of a stored job result. */
function contentOf(result: unknown): string | null {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return null;
  }
  const content = (result as Record<string, unknown>)["content"];
  return typeof content === "string" ? content : null;
}

export type VerifyState =
  /** No verify hop has ever run for this subject. */
  | { readonly state: "nenhum" }
  | { readonly state: "executando" }
  | { readonly state: "falhou"; readonly error: string }
  /** Ran, but the answer was not a verdict list. The money is spent either
   * way; only this one is worth re-running. */
  | { readonly state: "ilegivel" }
  | { readonly state: "pronto"; readonly tally: VerdictTally; readonly verifiedAt: string };

export interface ExtractionVerifyView extends Record<string, unknown> {
  readonly verdicts: readonly FieldVerdictT[];
}

/**
 * Parse a settled verify job into a badge state.
 *
 * `verdicts` is returned alongside the tally for the extraction screen, which
 * shows the refuted fields inline. Neither is stored anywhere: the job row IS
 * the record, and a denormalised copy would be a second one that goes stale
 * the moment somebody repairs the extraction.
 */
export function readExtractionVerify(job: JobRow | undefined): {
  readonly view: VerifyState;
  readonly verdicts: readonly FieldVerdictT[];
} {
  if (job === undefined) {
    return { view: { state: "nenhum" }, verdicts: [] };
  }
  if (job.status === "pending") {
    return { view: { state: "executando" }, verdicts: [] };
  }
  if (job.status !== "done") {
    return { view: { state: "falhou", error: job.error ?? "A verificação falhou." }, verdicts: [] };
  }
  const content = contentOf(job.result);
  const parsed = content === null ? null : parseModelJson(content);
  const shaped =
    parsed?.ok === true ? ExtractionVerdictsZ.safeParse(parsed.data) : { success: false as const };
  if (!shaped.success) {
    return { view: { state: "ilegivel" }, verdicts: [] };
  }
  return {
    view: {
      state: "pronto",
      tally: tallyVerdicts(shaped.data.verdicts),
      verifiedAt: job.lastUpdAt,
    },
    verdicts: shaped.data.verdicts,
  };
}

/** The analysis half. The REFUTED claims are also written into `content_json`
 * by the collector — this reader is for the "N afirmações verificadas" badge,
 * which needs the confirmed ones too. */
export function readAnalysisVerify(job: JobRow | undefined): {
  readonly view: VerifyState;
  readonly verdicts: readonly ClaimVerdictT[];
} {
  if (job === undefined) {
    return { view: { state: "nenhum" }, verdicts: [] };
  }
  if (job.status === "pending") {
    return { view: { state: "executando" }, verdicts: [] };
  }
  if (job.status !== "done") {
    return { view: { state: "falhou", error: job.error ?? "A verificação falhou." }, verdicts: [] };
  }
  const content = contentOf(job.result);
  const parsed = content === null ? null : parseModelJson(content);
  const shaped =
    parsed?.ok === true ? AnalysisVerdictsZ.safeParse(parsed.data) : { success: false as const };
  if (!shaped.success) {
    return { view: { state: "ilegivel" }, verdicts: [] };
  }
  return {
    view: {
      state: "pronto",
      tally: tallyVerdicts(shaped.data.verdicts),
      verifiedAt: job.lastUpdAt,
    },
    verdicts: shaped.data.verdicts,
  };
}

/** The newest verify job for a document (extraction hop). */
export async function loadLatestVerifyJobForDocument(
  dbHandle: DbLike,
  tenantId: string,
  documentId: string,
): Promise<JobRow | undefined> {
  const rows = await dbHandle
    .select()
    .from(reportJobs)
    .where(
      and(
        eq(reportJobs.tenantId, tenantId),
        eq(reportJobs.documentId, documentId),
        eq(reportJobs.kind, "verify"),
      ),
    )
    .orderBy(desc(reportJobs.createdAt))
    .limit(1);
  return rows[0];
}

/** The newest verify job for a report (analysis hop). */
export async function loadLatestVerifyJobForReport(
  dbHandle: DbLike,
  tenantId: string,
  reportId: string,
): Promise<JobRow | undefined> {
  const rows = await dbHandle
    .select()
    .from(reportJobs)
    .where(
      and(
        eq(reportJobs.tenantId, tenantId),
        eq(reportJobs.reportId, reportId),
        eq(reportJobs.kind, "verify"),
      ),
    )
    .orderBy(desc(reportJobs.createdAt))
    .limit(1);
  return rows[0];
}
