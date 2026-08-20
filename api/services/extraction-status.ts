// api/services/extraction-status.ts
//
// THE DERIVED STATE of hop 1, split out of extraction-service.ts: the five
// states §4.2 can leave a document in, and the one-row-per-document list the
// documents page renders from them.
//
// Split for the same reason report-publish.ts is split from report-service.ts
// — this half only READS, and it is the half both the repair screen and the
// list need to agree on. `statusOf` in particular is shared by two callers
// holding different shapes (full rows and flat projections), which is why it
// takes primitives.

import { and, desc, eq, isNull } from "drizzle-orm";
import { extractTemplates, extractions, reportJobs } from "../../drizzle/schema";
import type { DbLike } from "../collector/job-state";
import { RECALIBRATED_DURING_EXTRACTION } from "../extraction/extract-job";

/** What the UI shows in the documents list, in the pipeline's own vocabulary.
 * The pt-BR labels are the SCREEN's business (§4.2's five states) — a status
 * column that shipped strings from the server would be a second place to
 * change the wording. */
export type ExtractionStatus = "idle" | "running" | "revisar" | "done" | "failed";

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
export function statusOf(jobStatus: string | null, hasCached: boolean): ExtractionStatus {
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
