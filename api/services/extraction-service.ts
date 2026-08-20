// api/services/extraction-service.ts
//
// Hop 1's orchestration (decisions §4, §4.2), behind the `extractions.*`
// mutations. Same split as detection-service.ts and calibration-service.ts:
// every DB and S3 touch lives here so it can be unit-tested against a fake
// handle, and the router stays wiring.
//
// THREE FACTS SHAPE THIS FILE.
//
// 1. EXTRACTION IS CACHED ON THE ARTIFACT, NOT ON THE JOB (§4, §12.8). The key
//    is `unique(s3_key, calibration_rev)`, so "already extracted" is a
//    question about the DOCUMENT and the TEMPLATE'S GENERATION, never about
//    whether some job once ran. `startExtraction` therefore SKIPS — free,
//    idempotent, no second charge — whenever a row already exists at the
//    template's current rev. A recalibration bumps the rev, the skip stops
//    matching, and the document re-extracts exactly as §12.8 intends.
//
// 2. A CORRECTED EXTRACTION IS NEVER RE-RUN (§4.2). It needs no special case:
//    a correction is written at the same `(s3_key, calibration_rev)` key, so
//    the skip in (1) already covers it. "The fix is permanent and free"
//    follows from the cache key rather than from a flag anyone has to
//    remember to check.
//
// 3. `extractions.data` IS ALWAYS VALID. The collector refuses to cache a
//    payload that fails the frozen field list (api/collector/collect.ts), and
//    `correctExtraction` refuses to write one. So the data a `revisar` screen
//    shows does NOT come from this table — there is nothing in it yet. It
//    comes from `report_jobs.result`, where the relay envelope is kept
//    verbatim precisely because "what the model actually said is the evidence
//    for every downstream decision".

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
import {
  loadLatestJobForDocument,
  resolveRevisarJob,
  type DbLike,
  type JobRow,
} from "../collector/job-state";
import { loadTemplateFields } from "../collector/extraction-store";
import { parseModelJson } from "../collector/relay-result";
import { withSystemFields } from "../db/scope";
import { extractDocumentText } from "../detection/page-text";
import {
  buildExtractJob,
  RECALIBRATED_DURING_EXTRACTION,
  resolveExtractionModel,
} from "../extraction/extract-job";
import { jobKeyFor, mintJobId } from "../lib/relay";
import { type FieldSpec, type InputMode } from "../../shared/validation/field-spec";
import {
  validateExtraction,
  type FieldProblem,
} from "../../shared/validation/extraction-validation";
import type { CorrectExtractionInputT } from "../../shared/validation/extraction-schemas";

export interface ExtractionDeps {
  readonly db: DbLike;
  readonly enqueue: (
    tenantId: string,
    jobId: string,
    payload: Record<string, unknown>,
  ) => Promise<void>;
  /** `null` when the object is missing — api/lib/storage.ts's null-on-404
   * convention, mirrored by detection-service.ts and calibration-service.ts. */
  readonly fetchPdf: (s3Key: string) => Promise<Buffer | null>;
}

export interface ExtractionCtx {
  readonly tenantId: string;
  readonly userId: string;
}

/** What the UI shows in the documents list, in the pipeline's own vocabulary.
 * The pt-BR labels are the SCREEN's business (§4.2's five states) — a status
 * column that shipped strings from the server would be a second place to
 * change the wording. */
export type ExtractionStatus = "idle" | "running" | "revisar" | "done" | "failed";

// ---------------------------------------------------------------------------
// Ownership. Every id below arrives from the browser and is a LOOKUP KEY,
// never a permission — the rule documents-crud.ts states and every service
// here repeats.
// ---------------------------------------------------------------------------

type DocumentRow = typeof documents.$inferSelect;

async function loadOwnedDocument(
  dbHandle: DbLike,
  tenantId: string,
  documentId: string,
): Promise<DocumentRow> {
  const rows = await dbHandle
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.tenantId, tenantId),
        isNull(documents.deletedAt),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Documento não encontrado." });
  }
  return row;
}

export interface FrozenTemplate {
  readonly id: string;
  readonly inputMode: InputMode;
  readonly calibrationRev: number;
  readonly providerName: string;
  readonly typeName: string;
}

/**
 * The one LIVE extract template for a document's type
 * (`extract_templates_document_type_idx` — Calibrate replaces, never forks),
 * or `null` when there is nothing frozen to extract against.
 *
 * `null` and not a throw: `getExtractionView` renders that state as "calibre
 * este tipo primeiro", while `startExtraction` refuses. Two different answers
 * to the same fact, so the fact is returned rather than decided here.
 */
async function loadFrozenTemplate(
  dbHandle: DbLike,
  tenantId: string,
  documentTypeId: string,
): Promise<FrozenTemplate | null> {
  const rows = await dbHandle
    .select({
      id: extractTemplates.id,
      inputMode: extractTemplates.inputMode,
      calibrationRev: extractTemplates.calibrationRev,
      providerName: providers.name,
      typeName: documentTypes.name,
    })
    .from(extractTemplates)
    .innerJoin(documentTypes, eq(documentTypes.id, extractTemplates.documentTypeId))
    .innerJoin(providers, eq(providers.id, documentTypes.providerId))
    .where(
      and(
        eq(extractTemplates.documentTypeId, documentTypeId),
        eq(extractTemplates.tenantId, tenantId),
        isNull(extractTemplates.deletedAt),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return { ...row, inputMode: row.inputMode === "vision" ? "vision" : "text" };
}

type ExtractionRow = typeof extractions.$inferSelect;

/** The cached extraction for this exact `(s3_key, calibration_rev)` — §12.8's
 * whole caching contract, read back. */
async function loadCachedExtraction(
  dbHandle: DbLike,
  tenantId: string,
  s3Key: string,
  calibrationRev: number,
): Promise<ExtractionRow | undefined> {
  const rows = await dbHandle
    .select()
    .from(extractions)
    .where(
      and(
        eq(extractions.tenantId, tenantId),
        eq(extractions.s3Key, s3Key),
        eq(extractions.calibrationRev, calibrationRev),
      ),
    )
    .limit(1);
  return rows[0];
}

/** An extract job already in flight for this document.
 *
 * A FAST PATH, NOT THE GUARANTEE (codex review, 2026-08-20). Reading here and
 * inserting later is check-then-act, and two concurrent callers both read
 * "nothing pending" and both buy a hop. The guarantee is the partial unique
 * index `report_jobs_pending_extract_idx` and the ON CONFLICT below; this read
 * survives because in the COMMON case (a double-click) it saves an S3 GET and
 * a full local PDF text extraction before the insert would have refused
 * anyway. */
async function loadPendingExtractJob(
  dbHandle: DbLike,
  tenantId: string,
  documentId: string,
): Promise<{ readonly id: string } | undefined> {
  const rows = await dbHandle
    .select({ id: reportJobs.id })
    .from(reportJobs)
    .where(
      and(
        eq(reportJobs.tenantId, tenantId),
        eq(reportJobs.documentId, documentId),
        eq(reportJobs.kind, "extract"),
        eq(reportJobs.status, "pending"),
      ),
    )
    .limit(1);
  return rows[0];
}

// ---------------------------------------------------------------------------
// start — one relay hop, or nothing at all
// ---------------------------------------------------------------------------

export type StartExtractionOutcome =
  /** Already extracted at this calibration rev (§12.8). FREE — no hop, no
   * charge, and the same answer on every repeat. */
  | { readonly outcome: "cached"; readonly extractionId: string }
  /** Enqueued, or an already-pending job for this document was reused.
   * `jobId` is `report_jobs.id` — poll it with the SAME `jobs.poll` the rest
   * of the pipeline uses. */
  | { readonly outcome: "job"; readonly jobId: string };

/**
 * Enqueues hop 1 for a document, or reports that it did not need to.
 *
 * REFUSALS, both BAD_REQUEST, both about calibration rather than about the
 * document: no document type (§3.3's dropdown has not been used and detection
 * has not run) and no frozen extract template for that type. Neither is
 * repairable by trying again, so neither is allowed to become a paid hop.
 *
 * TEXT MODE READS THE PDF LOCALLY. §3.1: `input_mode` is a COST decision, and
 * `text` means the model is handed the extracted text layer INSTEAD of the
 * PDF. So the whole text is extracted here, for free, in the same Lambda that
 * already does it for detection — and a `text` template pointed at a document
 * with no text layer is REFUSED rather than quietly promoted to a vision hop,
 * because §3.1 has no fallback ladder and a silent 5–20× cost increase is not
 * this function's decision to make.
 *
 * ORDER IS THE SAME AS EVERY OTHER ENQUEUE PATH: the `report_jobs` row is
 * committed BEFORE the S3 PutObject (api/collector/collect.ts's requirement),
 * so a fast relay cannot produce a result for a row nobody can see yet.
 *
 * AND THE ROW IS THE MUTUAL EXCLUSION (codex review, 2026-08-20). Two
 * concurrent calls for the same document used to pass the same read-based
 * preflight and buy two hops; the insert now carries ON CONFLICT DO NOTHING
 * against a partial unique index, so exactly one of them enqueues and the
 * other returns the winner's job id. The §12.8 cache cannot cover this case —
 * at the moment of the race neither extraction exists yet.
 */
export async function startExtraction(
  deps: ExtractionDeps,
  ctx: ExtractionCtx,
  documentId: string,
): Promise<StartExtractionOutcome> {
  const doc = await loadOwnedDocument(deps.db, ctx.tenantId, documentId);
  if (doc.documentTypeId === null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Defina o tipo do documento antes de extrair.",
    });
  }

  const template = await loadFrozenTemplate(deps.db, ctx.tenantId, doc.documentTypeId);
  if (template === null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Este tipo de documento ainda não tem um template de extração congelado.",
    });
  }

  // §12.8 — the cache key is (s3_key, calibration_rev). A hit is the whole of
  // "extraction cached" AND the whole of "a corrected extraction is never
  // re-run": a correction lives at this same key.
  const cached = await loadCachedExtraction(
    deps.db,
    ctx.tenantId,
    doc.s3Key,
    template.calibrationRev,
  );
  if (cached !== undefined) {
    return { outcome: "cached", extractionId: cached.id };
  }

  const pending = await loadPendingExtractJob(deps.db, ctx.tenantId, documentId);
  if (pending !== undefined) {
    return { outcome: "job", jobId: pending.id };
  }

  const fields = await loadTemplateFields(deps.db, ctx.tenantId, template.id);
  if (fields.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "O template de extração deste tipo não tem campos congelados.",
    });
  }

  const documentText = await loadDocumentText(deps, template.inputMode, doc.s3Key);
  const { provider, model } = resolveExtractionModel(ctx.tenantId);
  const payload = buildExtractJob({
    tenantId: ctx.tenantId,
    s3Key: doc.s3Key,
    inputMode: template.inputMode,
    // The job carries the template binding it was built from, so the
    // collector can judge the answer by the list the model actually saw and
    // refuse to cache one the template moved out from under (§12.8, codex
    // review 2026-08-20).
    templateId: template.id,
    calibrationRev: template.calibrationRev,
    fields,
    documentText,
    provider,
    model,
    providerName: template.providerName,
    documentTypeName: template.typeName,
  });

  const jobId = mintJobId();
  const stamped = withSystemFields({ userId: ctx.userId }, "create", {
    tenantId: ctx.tenantId,
    kind: "extract",
    status: "pending",
    s3Key: jobKeyFor(ctx.tenantId, jobId),
    attempt: 1,
    request: payload,
    documentId: doc.id,
  });

  // THE DEDUPE IS THE INSERT (codex review, 2026-08-20). `ON CONFLICT DO
  // NOTHING` against `report_jobs_pending_extract_idx` — unique on
  // (tenant_id, document_id) WHERE status='pending' AND kind='extract' — is
  // what makes two concurrent callers produce ONE paid hop instead of two.
  // Postgres decides the race; the loser inserts nothing and learns it lost
  // from the empty row set, which is the same shape as
  // `insertDocumentIdempotent` and as every compare-and-set in
  // api/collector/job-state.ts.
  //
  // No conflict TARGET is named: the only unique constraint an insert here
  // can plausibly violate is that index (`s3_key` carries a freshly minted
  // uuid), and naming a partial index as a target means restating its
  // predicate in a second place that can drift from the schema.
  const inserted = await deps.db
    .insert(reportJobs)
    .values(stamped)
    .onConflictDoNothing()
    .returning();
  const row = inserted[0];

  if (row === undefined) {
    // Lost the race. The WINNER is enqueuing (or already has), so this call
    // must not write a second job object — it reports the winner's row, and
    // the caller cannot tell which of the two it was.
    const winner = await loadPendingExtractJob(deps.db, ctx.tenantId, documentId);
    if (winner === undefined) {
      // The conflicting row settled between the INSERT and this read — a
      // window a few milliseconds wide. There is nothing pending to point at
      // and nothing was written, so say so rather than inventing an outcome:
      // a refresh resolves it, either into a cached extraction or into a
      // fresh job.
      throw new TRPCError({
        code: "CONFLICT",
        message: "A extração deste documento acabou de mudar de estado. Recarregue a página.",
      });
    }
    return { outcome: "job", jobId: winner.id };
  }

  // Row first, THEN the outbox object (api/collector/collect.ts's requirement
  // on every enqueue path) — unchanged by the dedupe, and now additionally
  // true of the only caller that reaches it.
  await deps.enqueue(ctx.tenantId, jobId, payload);

  return { outcome: "job", jobId: row.id };
}

/** Text mode's local read (§3.1). `vision` never touches S3 here — the relay
 * fetches the PDF itself from the key on the job. */
async function loadDocumentText(
  deps: ExtractionDeps,
  inputMode: InputMode,
  s3Key: string,
): Promise<string | null> {
  if (inputMode === "vision") {
    return null;
  }
  const bytes = await deps.fetchPdf(s3Key);
  const text = bytes === null ? null : await extractDocumentText(bytes);
  if (text === null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Este template extrai a partir do texto do PDF, mas este documento não tem camada de texto. Recalibre o tipo como 'vision'.",
    });
  }
  return text;
}

// ---------------------------------------------------------------------------
// get — the revisar screen's whole payload
// ---------------------------------------------------------------------------

/** The model's own answer, dug out of the relay envelope kept verbatim on the
 * job row. `null` for a job that failed before producing one, or a body that
 * is not the JSON the schema asked for — the screen then starts from the
 * frozen list with empty values, which is still a repair a human can make. */
function rawAnswerOf(job: JobRow | undefined): unknown {
  if (job?.result === null || job?.result === undefined) {
    return null;
  }
  const envelope = job.result;
  if (typeof envelope !== "object" || Array.isArray(envelope)) {
    return null;
  }
  const content = (envelope as Record<string, unknown>)["content"];
  if (typeof content !== "string") {
    return null;
  }
  const parsed = parseModelJson(content);
  return parsed.ok ? parsed.data : null;
}

export interface ExtractionView {
  readonly document: {
    readonly id: string;
    readonly fileName: string | null;
    readonly s3Key: string;
  };
  readonly template: FrozenTemplate | null;
  /** The frozen list, as the tree the editor renders row by row (§3.1). */
  readonly fields: readonly FieldSpec[];
  readonly extraction: {
    readonly id: string;
    readonly corrected: boolean;
    readonly provider: string | null;
    readonly model: string | null;
    readonly createdAt: string;
  } | null;
  readonly job: {
    readonly id: string;
    readonly status: string;
    readonly attempt: number;
    readonly error: string | null;
  } | null;
  readonly status: ExtractionStatus;
  /**
   * This `revisar` is repaired by RE-RUNNING, not by typing: the template was
   * recalibrated while the hop was in flight (§12.8), so the answer was never
   * cached and the values on screen were read against the PREVIOUS field list.
   *
   * A boolean rather than leaving the screen to match on `job.error`: the
   * error column is operator prose, and a UI that forks on its exact wording
   * breaks the day somebody improves the sentence.
   */
  readonly staleTemplate: boolean;
  /** What the screen EDITS: the cached (therefore valid) extraction if there
   * is one, otherwise the model's raw answer from the job that landed in
   * `revisar`. `null` when there is neither. */
  readonly data: unknown;
  /** Re-computed here, never stored: the frozen list is the authority and it
   * can move under a stored verdict (§12.8). The screen re-runs the identical
   * function as the human types. */
  readonly problems: readonly FieldProblem[];
}

/**
 * The five states §4.2 can leave a document in, derived rather than stored.
 *
 * ORDER IS THE MEANING. A job in flight wins over a cached extraction, because
 * that combination is a RE-extraction after a recalibration (§12.8) and
 * "extraindo" is the true answer. A cached extraction then wins over any
 * settled job, because the artifact is the point and a `revisar` a human
 * already repaired must not keep saying `revisar`. Takes primitives, not rows,
 * so both callers can reach it — one holds full rows, the other two projections.
 */
function statusOf(jobStatus: string | null, hasCached: boolean): ExtractionStatus {
  if (jobStatus === "pending") {
    return "running";
  }
  if (hasCached) {
    return "done";
  }
  if (jobStatus === "revisar") {
    return "revisar";
  }
  if (jobStatus === "failed") {
    return "failed";
  }
  return "idle";
}

/**
 * Everything the repair screen needs, in one round trip, with ownership
 * re-proven at every hop.
 *
 * The PROBLEMS are computed here rather than read from a column. §12.8 lets
 * the frozen list move under an extraction (that is what invalidation IS), so
 * a stored verdict is a claim about a field list that may no longer exist —
 * and the one thing a repair screen must not do is flag the wrong fields.
 */
export async function getExtractionView(
  dbHandle: DbLike,
  ctx: ExtractionCtx,
  documentId: string,
): Promise<ExtractionView> {
  const doc = await loadOwnedDocument(dbHandle, ctx.tenantId, documentId);
  const template =
    doc.documentTypeId === null
      ? null
      : await loadFrozenTemplate(dbHandle, ctx.tenantId, doc.documentTypeId);

  const job = await loadLatestJobForDocument(dbHandle, ctx.tenantId, documentId, "extract");
  const document = { id: doc.id, fileName: doc.fileName, s3Key: doc.s3Key };

  if (template === null) {
    return {
      document,
      template: null,
      fields: [],
      extraction: null,
      job: job === undefined ? null : toJobView(job),
      status: statusOf(job?.status ?? null, false),
      staleTemplate: isStaleTemplateJob(job),
      data: null,
      problems: [],
    };
  }

  const fields = await loadTemplateFields(dbHandle, ctx.tenantId, template.id);
  const cached = await loadCachedExtraction(
    dbHandle,
    ctx.tenantId,
    doc.s3Key,
    template.calibrationRev,
  );
  const data = cached !== undefined ? cached.data : rawAnswerOf(job);

  return {
    document,
    template,
    fields,
    extraction:
      cached === undefined
        ? null
        : {
            id: cached.id,
            corrected: cached.corrected,
            provider: cached.provider,
            model: cached.model,
            createdAt: cached.createdAt,
          },
    job: job === undefined ? null : toJobView(job),
    status: statusOf(job?.status ?? null, cached !== undefined),
    staleTemplate: isStaleTemplateJob(job),
    data,
    problems: data === null ? [] : validateExtraction(fields, data).problems,
  };
}

/** Whether this job is the §12.8 in-flight-recalibration case the collector
 * refused to cache. */
function isStaleTemplateJob(job: JobRow | undefined): boolean {
  return job?.status === "revisar" && job.error === RECALIBRATED_DURING_EXTRACTION;
}

/** `request` is withheld for the reason jobs.router.ts withholds it: it is the
 * system prompt, the field list and the model choice, and the browser has no
 * use for any of them. */
function toJobView(job: JobRow): NonNullable<ExtractionView["job"]> {
  return { id: job.id, status: job.status, attempt: job.attempt, error: job.error };
}

// ---------------------------------------------------------------------------
// correct — the human's answer, persisted once, never re-run
// ---------------------------------------------------------------------------

export interface CorrectExtractionOutcome {
  readonly extractionId: string;
  /** How many `revisar` jobs this correction closed. `0` is ordinary, not an
   * error: a document whose extraction merely LOOKED wrong (valid, but a
   * value a human disagreed with) has no `revisar` job to resolve. */
  readonly resolvedJobs: number;
}

/**
 * Writes a human's repaired extraction and closes the `revisar` it came from
 * (§4.2).
 *
 * FULL VALIDITY IS THE GATE. A partially-repaired payload cannot leave
 * `revisar`, because everything downstream — hop 2, the numeral guard
 * (§12.12c), the report — reads `extractions.data` as a payload that already
 * satisfies the frozen list. Letting a half-fixed one through would move the
 * failure from a screen built to show it to a place built to assume it away.
 * The refusal carries the problems back so the screen can point at them.
 *
 * THE WRITE IS AN UPSERT ON THE CACHE KEY, and it is the only place in the
 * system that overwrites an extraction. That is exactly §4.2's "the corrected
 * extraction is persisted and never re-run": it lands at
 * `(s3_key, calibration_rev)`, so `startExtraction`'s skip finds it forever
 * after, at no cost — and a recalibration (a NEW rev, §12.8) correctly does
 * not inherit it.
 *
 * The job CAS runs AFTER the write, the same order the collector uses: if the
 * process dies between them the row is still `revisar`, the human saves again,
 * and the upsert is a no-op. The reverse order would show `done` with nothing
 * behind it.
 */
export async function correctExtraction(
  dbHandle: DbLike,
  ctx: ExtractionCtx,
  input: CorrectExtractionInputT,
): Promise<CorrectExtractionOutcome> {
  const doc = await loadOwnedDocument(dbHandle, ctx.tenantId, input.documentId);
  if (doc.documentTypeId === null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Defina o tipo do documento antes de corrigir a extração.",
    });
  }
  const template = await loadFrozenTemplate(dbHandle, ctx.tenantId, doc.documentTypeId);
  if (template === null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Este tipo de documento ainda não tem um template de extração congelado.",
    });
  }

  const fields = await loadTemplateFields(dbHandle, ctx.tenantId, template.id);
  const validation = validateExtraction(fields, input.data);
  if (!validation.ok) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "A correção ainda tem campos inválidos.",
      cause: validation.problems,
    });
  }

  const now = new Date().toISOString();
  const upserted = await dbHandle
    .insert(extractions)
    .values({
      tenantId: ctx.tenantId,
      documentId: doc.id,
      extractTemplateId: template.id,
      s3Key: doc.s3Key,
      calibrationRev: template.calibrationRev,
      data: input.data,
      corrected: true,
      createdAt: now,
      createdBy: ctx.userId,
      lastUpdAt: now,
      lastUpdBy: ctx.userId,
    })
    .onConflictDoUpdate({
      target: [extractions.s3Key, extractions.calibrationRev],
      set: { data: input.data, corrected: true, lastUpdAt: now, lastUpdBy: ctx.userId },
    })
    .returning({ id: extractions.id });

  const row = upserted[0];
  if (row === undefined) {
    throw new Error("correctExtraction: extractions upsert returned no row");
  }

  const resolvedJobs = await resolveRevisarJob(dbHandle, {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    documentId: doc.id,
    kind: "extract",
  });

  return { extractionId: row.id, resolvedJobs };
}

// ---------------------------------------------------------------------------
// list — the documents-page status column
// ---------------------------------------------------------------------------

export interface ExtractionStatusRow {
  readonly documentId: string;
  readonly status: ExtractionStatus;
  readonly extractionId: string | null;
  readonly corrected: boolean;
  readonly jobId: string | null;
  readonly error: string | null;
  /** See `ExtractionView.staleTemplate` — the list offers "extrair novamente"
   * for this one, not "revisar". */
  readonly staleTemplate: boolean;
}

/**
 * One status per document, for the list.
 *
 * Read as two flat tenant-scoped queries and joined in memory rather than as
 * one SQL join, because the status depends on a fact SQL cannot express
 * cheaply here: an extraction only counts if it sits at the template's CURRENT
 * `calibration_rev` (§12.8). Expressing that as a join means dragging
 * `extract_templates` in through `documents.document_type_id` and comparing
 * revs per row; the tenant's document count is a page, not a corpus.
 */
export async function listExtractionStatus(
  dbHandle: DbLike,
  tenantId: string,
): Promise<ExtractionStatusRow[]> {
  const jobs = await dbHandle
    .select({
      id: reportJobs.id,
      documentId: reportJobs.documentId,
      status: reportJobs.status,
      error: reportJobs.error,
      createdAt: reportJobs.createdAt,
    })
    .from(reportJobs)
    .where(and(eq(reportJobs.tenantId, tenantId), eq(reportJobs.kind, "extract")))
    .orderBy(desc(reportJobs.createdAt));

  const rows = await dbHandle
    .select({
      id: extractions.id,
      documentId: extractions.documentId,
      corrected: extractions.corrected,
      calibrationRev: extractions.calibrationRev,
      templateRev: extractTemplates.calibrationRev,
    })
    .from(extractions)
    .innerJoin(
      extractTemplates,
      and(
        eq(extractTemplates.id, extractions.extractTemplateId),
        // Redundant against the FK — an extraction is only ever written
        // against a template `resolveExtractionTarget` already scoped — and
        // present anyway: "the tenant is in the WHERE clause" is a rule this
        // codebase keeps even where a constraint would have covered it.
        eq(extractTemplates.tenantId, tenantId),
        isNull(extractTemplates.deletedAt),
      ),
    )
    .where(eq(extractions.tenantId, tenantId));

  const current = new Map<string, { id: string; corrected: boolean }>();
  for (const row of rows) {
    if (row.calibrationRev === row.templateRev) {
      current.set(row.documentId, { id: row.id, corrected: row.corrected });
    }
  }

  const latestJob = new Map<string, (typeof jobs)[number]>();
  for (const job of jobs) {
    if (job.documentId !== null && !latestJob.has(job.documentId)) {
      latestJob.set(job.documentId, job);
    }
  }

  const documentIds = new Set([...current.keys(), ...latestJob.keys()]);
  return [...documentIds].map((documentId) => {
    const job = latestJob.get(documentId);
    const cached = current.get(documentId);
    return {
      documentId,
      status: statusOf(job?.status ?? null, cached !== undefined),
      extractionId: cached?.id ?? null,
      corrected: cached?.corrected ?? false,
      jobId: job?.id ?? null,
      error: job?.error ?? null,
      staleTemplate: job?.status === "revisar" && job.error === RECALIBRATED_DURING_EXTRACTION,
    };
  });
}
